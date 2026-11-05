import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gutterBarSvg } from './core/gutter';
import { hashLine } from './core/hash';
import { averageColors, formatColor, interpolateStops, parseColor, quantizeColor, RGBA, withMinAlpha } from './core/color';
import { blockStats, FoldedGap, foldedGaps, formatSummary, lastUnclosedBracket, summaryValues } from './core/foldSummary';
import { FileMarks, LineMark, LineSource, READ } from './core/marks';
import { ResolvedSet } from './core/palettes';
import { formatLineNote, formatNoteOnly } from './core/lineNote';
import { categoryCountLabel, FALLBACK_COLOR, markLabel, PatinaConfig } from './config';
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
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private pending = new Set<vscode.TextEditor>();
  /** Folded blocks each editor's highlights were last drawn for. */
  private renderedGaps = new WeakMap<vscode.TextEditor, string>();
  /** Function/method name lines per document, for recognising folded parameter lists. */
  private symbols = new Map<string, { version: number; lines?: Set<number>; pending: boolean }>();
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
      vscode.workspace.onDidCloseTextDocument((doc) => this.symbols.delete(doc.uri.toString())),
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

  /**
   * Folded blocks currently hidden in an editor. Minor ones (smaller than the minimum, or parameter lists unless
   * those are summarized in full) show their summary only on the cursor line.
   */
  private gapsOf(editor: vscode.TextEditor): (FoldedGap & { minor: boolean })[] {
    const doc = editor.document;
    const min = this.cfg.foldSummaryMinLines;
    return foldedGaps(editor.visibleRanges.map((r) => ({ start: r.start.line, end: r.end.line })))
      .filter((g) => g.header < doc.lineCount)
      .map((g) => ({
        ...g,
        minor: g.end - g.start + 1 < min || (!this.cfg.foldSummaryParameterLists && this.isParameterListFold(doc, g.header)),
      }));
  }

  /**
   * Whether a fold starting at `header` is a function or method definition's parameter list: the line ends
   * inside an open `(` and the language's symbol provider has a function, method or constructor named there.
   */
  private isParameterListFold(doc: vscode.TextDocument, header: number): boolean {
    if (lastUnclosedBracket(doc.lineAt(header).text) !== '(') return false;
    return this.definitionLines(doc)?.has(header) ?? false;
  }

  /**
   * Lines where functions, methods and constructors are named, from the language's symbol provider. Fetched in
   * the background and cached per document version; until a fetch finishes the previous result (if any) is used.
   */
  private definitionLines(doc: vscode.TextDocument): Set<number> | undefined {
    const key = doc.uri.toString();
    const cached = this.symbols.get(key);
    if (cached && (cached.version === doc.version || cached.pending)) return cached.lines;
    const version = doc.version;
    this.symbols.set(key, { version: cached?.version ?? -1, lines: cached?.lines, pending: true });
    const done = (lines: Set<number>) => {
      this.symbols.set(key, { version, lines, pending: false });
      const changed = !cached?.lines || cached.lines.size !== lines.size || [...lines].some((l) => !cached.lines!.has(l));
      if (changed) for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.toString() === key) this.schedule(ed);
    };
    vscode.commands
      .executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri)
      .then((syms) => done(definitionNameLines(syms ?? [])), () => done(new Set()));
    return cached?.lines;
  }

  private onVisibleRangesChanged(editor: vscode.TextEditor): void {
    // Scrolling only moves the annotations; folding or unfolding can change highlights too.
    if (this.cfg.foldHighlight && gapSignature(this.gapsOf(editor)) !== this.renderedGaps.get(editor)) this.schedule(editor);
    else this.renderAnnotation(editor);
  }

  /**
   * Style key for a folded block's first line: the average of the colors of the block's non-blank lines
   * (first line included), unmarked lines counting as transparent and stale lines counting extra.
   * Undefined if nothing in the block is marked.
   */
  private foldKey(marks: FileMarks, doc: vscode.TextDocument, start: number, end: number, now: number): string | undefined {
    const bg: (RGBA | undefined)[] = [];
    const gutter: (RGBA | undefined)[] = [];
    const weights: number[] = [];
    for (let i = start; i <= Math.min(end, doc.lineCount - 1); i++) {
      if (i !== start && doc.lineAt(i).isEmptyOrWhitespace) continue;
      const m = marks.get(i);
      bg.push(m && this.lineColor(m, now, this.cfg.colors.background, this.bgStops));
      gutter.push(m && this.lineColor(m, now, this.cfg.colors.gutter, this.gutterStops));
      weights.push(m?.stale !== undefined ? this.cfg.foldStaleWeight : 1);
    }
    const b = averageColors(bg, weights);
    const g = averageColors(gutter, weights);
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

  /**
   * End-of-line notes by line: the cursor line's mark, stale lines (if enabled), the user's notes, and summaries
   * of folded blocks on their first lines. A folded block's summary replaces its first line's own text, and
   * lists that line's note with the notes inside the block.
   */
  annotations(editor: vscode.TextEditor): Map<number, string> {
    const notes = new Map<number, string>();
    const doc = editor.document;
    const marks = this.store.get(doc.uri);
    const now = Date.now();
    const active = editor === vscode.window.activeTextEditor;
    const cursor = editor.selection.active.line;
    const full = (m: LineMark) =>
      formatLineNote(this.cfg.lineNoteFormats, m, markLabel(this.cfg, m), now, this.cfg.fadeMs, this.cfg.staleLabel, this.cfg.noteDisplay);
    if (this.cfg.showCursorLineAnnotation && active && cursor < doc.lineCount) {
      const m = marks?.get(cursor);
      if (m) {
        const text = full(m);
        if (text) notes.set(cursor, text);
      }
    }
    if (marks) {
      for (const [line, m] of marks.entries()) {
        if (line >= doc.lineCount) break;
        if (notes.has(line)) continue;
        let text = '';
        if (this.cfg.showStaleAnnotations && m.stale !== undefined) text = full(m);
        else if (m.note !== undefined && (this.cfg.showNotesOnAllLines || (active && line === cursor))) {
          text = formatNoteOnly(m, this.cfg.noteDisplay);
        }
        if (text) notes.set(line, text);
      }
    }
    // Only files Patina tracks (those with marks); others would just say "0% read" everywhere.
    if (this.cfg.foldSummary === 'off' || !marks) return notes;
    const src: LineSource = { lineCount: doc.lineCount, lineAt: (i) => doc.lineAt(i).text };
    const order = [...this.cfg.categories.keys()];
    for (const gap of this.gapsOf(editor)) {
      if ((gap.minor || this.cfg.foldSummary === 'cursorLine') && !(active && gap.header === cursor)) continue;
      const stats = blockStats(marks, src, gap.start, gap.end, now);
      const headerNote = marks.get(gap.header)?.note;
      if (headerNote !== undefined) stats.notes.unshift(headerNote);
      const values = summaryValues(stats, (c, n) => categoryCountLabel(this.cfg, c, n), order, this.cfg.noteDisplay.maxLength);
      const text = formatSummary(this.cfg.foldSummaryFormat, values);
      if (text) notes.set(gap.header, text);
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

const DEFINITION_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

/** Name lines of every function, method and constructor in a symbol provider's result (tree or flat). */
function definitionNameLines(syms: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Set<number> {
  const lines = new Set<number>();
  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation) => {
    if ('selectionRange' in s) {
      if (DEFINITION_KINDS.has(s.kind)) lines.add(s.selectionRange.start.line);
      s.children?.forEach(visit);
    } else if (DEFINITION_KINDS.has(s.kind)) {
      lines.add(s.location.range.start.line);
    }
  };
  syms.forEach(visit);
  return lines;
}
