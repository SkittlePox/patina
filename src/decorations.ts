import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gutterBarSvg } from './core/gutter';
import { hashLine } from './core/hash';
import { averageColors, formatColor, interpolateStops, parseColor, quantizeColor, RGBA, withMinAlpha } from './core/color';
import { blockStats, FoldedGap, foldedGaps, formatSummary, summaryValues } from './core/foldSummary';
import { FileMarks, LineMark, LineSource, READ } from './core/marks';
import { ResolvedSet } from './core/palettes';
import { shortAge } from './core/time';
import { categoryLabel, FALLBACK_COLOR, markLabel, PatinaConfig } from './config';
import { MarkStore } from './store';


/** Read marks are quantised into this many fade steps (each step is one decoration type). */
const FADE_STEPS = 24;
const REFRESH_MS = 10 * 60 * 1000;
/** Folded-block highlight colors kept as decoration types before unused ones are dropped. */
const MAX_FOLD_TYPES = 100;

const gapSignature = (gaps: FoldedGap[]) => gaps.map((g) => `${g.header}-${g.end}`).join(',');

/** Renders line highlights (background tint and/or gutter bar), overview ruler marks and the optional cursor-line annotation. */
export class DecorationRenderer implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private bgStops: RGBA[] = [];
  private gutterStops: RGBA[] = [];
  private readonly annotationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('patina.annotationForeground'),
      margin: '0 0 0 3em',
      fontStyle: 'italic',
      // Take the note out of the line's layout (decoration CSS is passed through as-is). The editor then treats a
      // click on it as a click after the end of the line instead of on the last character, so clicking the note
      // on a folded block's first line doesn't unfold it (unless `editor.unfoldOnClickAfterEndOfLine` is on).
      textDecoration: 'none; position: absolute; pointer-events: none',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private pending = new Set<vscode.TextEditor>();
  /** Folded blocks each editor's highlights were last drawn for. */
  private renderedGaps = new WeakMap<vscode.TextEditor, string>();
  private flushScheduled = false;
  private readonly timer: NodeJS.Timeout;

  /**
   * @param iconDir Directory for generated gutter icons. Must be a location the editor may load images from
   *   (the extension's global storage is allowed).
   */
  constructor(
    private readonly store: MarkStore,
    private cfg: PatinaConfig,
    private readonly iconDir: string,
  ) {
    this.applyConfig(cfg);
    this.disposables.push(
      store.onDidChangeMarks((uris) => {
        const keys = new Set(uris.map((u) => u.toString()));
        for (const ed of vscode.window.visibleTextEditors) if (keys.has(ed.document.uri.toString())) this.schedule(ed);
      }),
      vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((ed) => this.schedule(ed))),
      vscode.window.onDidChangeTextEditorSelection((e) => this.renderAnnotation(e.textEditor)),
      // Folding and unfolding change the visible ranges too.
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onVisibleRangesChanged(e.textEditor)),
    );
    this.timer = setInterval(() => this.renderAll(), REFRESH_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this.types.forEach((t) => t.dispose());
    this.annotationType.dispose();
  }

  applyConfig(cfg: PatinaConfig): void {
    this.cfg = cfg;
    this.types.forEach((t) => t.dispose());
    this.types.clear();
    const stops = (list: string[]) => list.map((c) => parseColor(c) ?? ([128, 128, 128, 0.15] as RGBA));
    this.bgStops = stops(cfg.colors.background.readFade);
    this.gutterStops = stops(cfg.colors.gutter.readFade);
    this.renderAll();
  }

  renderAll(): void {
    vscode.window.visibleTextEditors.forEach((ed) => this.schedule(ed));
  }

  private schedule(editor: vscode.TextEditor): void {
    this.pending.add(editor);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const eds = [...this.pending];
      this.pending.clear();
      eds.forEach((ed) => this.render(ed));
    }, 0);
  }

  private render(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const marks = this.store.get(doc.uri);
    const gaps = this.gapsOf(editor);
    this.renderedGaps.set(editor, gapSignature(gaps));
    const groups = new Map<string, vscode.Range[]>();
    if (marks) {
      const now = Date.now();
      const lineCount = doc.lineCount;
      // Lines to style, in order: every marked line, with folded blocks' first lines restyled for their contents.
      const keyed = new Map<number, string>();
      for (const [line, m] of marks.entries()) {
        if (line >= lineCount) break;
        keyed.set(line, this.styleKey(m, now));
      }
      if (this.cfg.foldHighlight) {
        for (const gap of gaps) {
          if (gap.header >= lineCount) continue;
          const key = this.foldKey(marks, doc, gap.header, gap.end, now);
          if (key) keyed.set(gap.header, key);
          else keyed.delete(gap.header);
        }
      }
      let runKey: string | undefined;
      let runStart = 0;
      let runEnd = -1;
      const flush = () => {
        if (runKey === undefined) return;
        let list = groups.get(runKey);
        if (!list) groups.set(runKey, (list = []));
        list.push(new vscode.Range(runStart, 0, runEnd, 0));
      };
      for (const line of [...keyed.keys()].sort((a, b) => a - b)) {
        const key = keyed.get(line)!;
        if (key !== runKey || line !== runEnd + 1) {
          flush();
          runKey = key;
          runStart = line;
        }
        runEnd = line;
      }
      flush();
    }
    this.pruneFoldTypes(groups, editor);
    for (const key of groups.keys()) this.typeFor(key);
    for (const [key, type] of this.types) editor.setDecorations(type, groups.get(key) ?? []);
    this.renderAnnotation(editor);
  }

  /** Folded blocks currently hidden in an editor. */
  private gapsOf(editor: vscode.TextEditor): FoldedGap[] {
    return foldedGaps(editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line })));
  }

  private onVisibleRangesChanged(editor: vscode.TextEditor): void {
    // Scrolling only moves the annotations; folding or unfolding can change highlights too.
    if (this.cfg.foldHighlight && gapSignature(this.gapsOf(editor)) !== this.renderedGaps.get(editor)) this.schedule(editor);
    else this.renderAnnotation(editor);
  }

  /**
   * Style key for a folded block's first line: the average of the colors of the block's non-blank lines
   * (first line included), unmarked lines counting as transparent. Undefined if nothing in the block is marked.
   */
  private foldKey(marks: FileMarks, doc: vscode.TextDocument, start: number, end: number, now: number): string | undefined {
    const bg: (RGBA | undefined)[] = [];
    const gutter: (RGBA | undefined)[] = [];
    for (let i = start; i <= Math.min(end, doc.lineCount - 1); i++) {
      if (i !== start && doc.lineAt(i).isEmptyOrWhitespace) continue;
      const m = marks.get(i);
      bg.push(m && this.lineColor(m, now, this.cfg.colors.background, this.bgStops));
      gutter.push(m && this.lineColor(m, now, this.cfg.colors.gutter, this.gutterStops));
    }
    const b = averageColors(bg);
    const g = averageColors(gutter);
    if (!b || !g) return undefined;
    return `fold:${formatColor(quantizeColor(b))}|${formatColor(quantizeColor(g))}`;
  }

  private lineColor(m: LineMark, now: number, set: ResolvedSet, stops: RGBA[]): RGBA | undefined {
    if (m.stale !== undefined) return parseColor(set.stale);
    if (m.cat === READ) return interpolateStops(stops, (now - m.t) / this.cfg.fadeMs);
    return parseColor(set.categories.get(m.cat) ?? FALLBACK_COLOR);
  }

  /** Fold colors are open-ended, so drop the ones no longer used once there are many of them. */
  private pruneFoldTypes(inUse: Map<string, vscode.Range[]>, editor: vscode.TextEditor): void {
    const fold = [...this.types.keys()].filter((k) => k.startsWith('fold:'));
    if (fold.length <= MAX_FOLD_TYPES) return;
    for (const k of fold) {
      if (inUse.has(k)) continue;
      this.types.get(k)!.dispose();
      this.types.delete(k);
    }
    // Disposing a type clears it everywhere: redraw the other editors, which recreate what they need.
    for (const ed of vscode.window.visibleTextEditors) if (ed !== editor) this.schedule(ed);
  }

  private renderAnnotation(editor: vscode.TextEditor): void {
    const notes = this.annotations(editor);
    editor.setDecorations(
      this.annotationType,
      [...notes].map(([line, text]) => {
        const end = editor.document.lineAt(line).range.end;
        return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } };
      }),
    );
  }

  /** End-of-line notes by line: the cursor line's mark, and summaries of folded blocks on their first lines. */
  annotations(editor: vscode.TextEditor): Map<number, string> {
    const notes = new Map<number, string>();
    const doc = editor.document;
    const marks = this.store.get(doc.uri);
    const now = Date.now();
    const active = editor === vscode.window.activeTextEditor;
    const cursor = editor.selection.active.line;
    const gaps = this.gapsOf(editor).filter((g) => g.header < doc.lineCount);
    if (this.cfg.showCursorLineAnnotation && active && cursor < doc.lineCount) {
      const m = marks?.get(cursor);
      if (m) {
        let label = markLabel(this.cfg, m);
        // On a folded block's first line, say the mark is the line's own and not the block's.
        if (gaps.some((g) => g.header === cursor)) label = this.cfg.foldLineLabel.replace(/\{label\}/g, label) || label;
        let text = `${label} · ${shortAge(now - m.t)} ago`;
        if (m.stale !== undefined) text = `⚠ changed outside editor ${shortAge(now - m.stale)} ago · was ${text}`;
        notes.set(cursor, text);
      }
    }
    // Only files Patina tracks (those with marks); others would just say "0% read" everywhere.
    if (this.cfg.foldSummary === 'off' || !marks) return notes;
    const src: LineSource = { lineCount: doc.lineCount, lineAt: (i) => doc.lineAt(i).text };
    const order = [...this.cfg.categories.keys()];
    for (const gap of gaps) {
      if (this.cfg.foldSummary === 'cursorLine' && !(active && gap.header === cursor)) continue;
      const stats = blockStats(marks, src, gap.start, gap.end, now);
      const text = formatSummary(this.cfg.foldSummaryFormat, summaryValues(stats, (c) => categoryLabel(this.cfg, c), order));
      if (!text) continue;
      const own = notes.get(gap.header);
      notes.set(gap.header, own ? `${own} · ${text}` : text);
    }
    return notes;
  }

  private styleKey(m: LineMark, now: number): string {
    if (m.stale !== undefined) return 'stale';
    if (m.cat === READ) {
      const f = Math.min(1, Math.max(0, (now - m.t) / this.cfg.fadeMs));
      return `read:${Math.round(f * FADE_STEPS)}`;
    }
    return this.cfg.categories.has(m.cat) ? `cat:${m.cat}` : 'unknown';
  }

  private typeFor(key: string): vscode.TextEditorDecorationType {
    let type = this.types.get(key);
    if (type) return type;
    const [color, gutterColor] = key.startsWith('fold:')
      ? key.slice(5).split('|')
      : [this.colorFor(key, this.cfg.colors.background, this.bgStops), this.colorFor(key, this.cfg.colors.gutter, this.gutterStops)];
    const style = this.cfg.highlightStyle;
    const options: vscode.DecorationRenderOptions = {
      isWholeLine: true,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    };
    if (style === 'background' || style === 'gutterAndBackground') options.backgroundColor = color;
    if (style === 'gutter' || style === 'gutterAndBackground') {
      const icon = this.gutterIcon(gutterColor);
      if (icon) {
        options.gutterIconPath = icon;
        options.gutterIconSize = '100% 100%';
      } else {
        options.backgroundColor = color; // couldn't write the icon: fall back to something visible
      }
    }
    if (this.cfg.showInOverviewRuler) {
      const parsed = parseColor(gutterColor);
      options.overviewRulerColor = parsed ? formatColor(withMinAlpha(parsed, 0.7)) : gutterColor;
      options.overviewRulerLane = vscode.OverviewRulerLane.Left;
    }
    type = vscode.window.createTextEditorDecorationType(options);
    this.types.set(key, type);
    return type;
  }

  private colorFor(key: string, set: ResolvedSet, stops: RGBA[]): string {
    if (key === 'stale') return set.stale;
    if (key.startsWith('read:')) return formatColor(interpolateStops(stops, Number(key.slice(5)) / FADE_STEPS));
    if (key.startsWith('cat:')) return set.categories.get(key.slice(4)) ?? FALLBACK_COLOR;
    return FALLBACK_COLOR;
  }

  /** Writes (once) and returns an SVG gutter bar in the given color. File names are content-addressed. */
  private gutterIcon(color: string): vscode.Uri | undefined {
    const svg = gutterBarSvg(color);
    const file = path.join(this.iconDir, `bar-${hashLine(svg)}.svg`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(this.iconDir, { recursive: true });
        fs.writeFileSync(file, svg);
      }
      return vscode.Uri.file(file);
    } catch {
      return undefined;
    }
  }
}
