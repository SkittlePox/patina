import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gutterBarSvg } from './core/gutter';
import { hashLine } from './core/hash';
import { formatColor, interpolateStops, parseColor, RGBA, withMinAlpha } from './core/color';
import { blockStats, foldedGaps, formatSummary, summaryValues } from './core/foldSummary';
import { LineMark, LineSource, READ } from './core/marks';
import { ResolvedSet } from './core/palettes';
import { shortAge } from './core/time';
import { categoryLabel, FALLBACK_COLOR, markLabel, PatinaConfig } from './config';
import { MarkStore } from './store';


/** Read marks are quantised into this many fade steps (each step is one decoration type). */
const FADE_STEPS = 24;
const REFRESH_MS = 10 * 60 * 1000;

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
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private pending = new Set<vscode.TextEditor>();
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
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.renderAnnotation(e.textEditor)),
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
    const marks = this.store.get(editor.document.uri);
    const groups = new Map<string, vscode.Range[]>();
    if (marks) {
      const now = Date.now();
      const lineCount = editor.document.lineCount;
      let runKey: string | undefined;
      let runStart = 0;
      let runEnd = -1;
      const flush = () => {
        if (runKey === undefined) return;
        let list = groups.get(runKey);
        if (!list) groups.set(runKey, (list = []));
        list.push(new vscode.Range(runStart, 0, runEnd, 0));
      };
      for (const [line, m] of marks.entries()) {
        if (line >= lineCount) break;
        const key = this.styleKey(m, now);
        if (key !== runKey || line !== runEnd + 1) {
          flush();
          runKey = key;
          runStart = line;
        }
        runEnd = line;
      }
      flush();
    }
    for (const key of groups.keys()) this.typeFor(key);
    for (const [key, type] of this.types) editor.setDecorations(type, groups.get(key) ?? []);
    this.renderAnnotation(editor);
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
    if (this.cfg.showCursorLineAnnotation && active && cursor < doc.lineCount) {
      const m = marks?.get(cursor);
      if (m) {
        let text = `${markLabel(this.cfg, m)} · ${shortAge(now - m.t)} ago`;
        if (m.stale !== undefined) text = `⚠ changed outside editor ${shortAge(now - m.stale)} ago · was ${text}`;
        notes.set(cursor, text);
      }
    }
    // Only files Patina tracks (those with marks); others would just say "0% read" everywhere.
    if (this.cfg.foldSummary === 'off' || !marks) return notes;
    const visible = editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line }));
    const src: LineSource = { lineCount: doc.lineCount, lineAt: (i) => doc.lineAt(i).text };
    const order = [...this.cfg.categories.keys()];
    for (const gap of foldedGaps(visible)) {
      if (gap.header >= doc.lineCount) continue;
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
    const color = this.colorFor(key, this.cfg.colors.background, this.bgStops);
    const gutterColor = this.colorFor(key, this.cfg.colors.gutter, this.gutterStops);
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
