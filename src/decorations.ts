import * as vscode from 'vscode';
import { formatColor, interpolateStops, parseColor, RGBA, withMinAlpha } from './core/color';
import { LineMark, READ } from './core/marks';
import { shortAge } from './core/time';
import { categoryLabel, FALLBACK_COLOR, PatinaConfig } from './config';
import { MarkStore } from './store';

/** Read marks are quantised into this many fade steps (each step is one decoration type). */
const FADE_STEPS = 24;
const REFRESH_MS = 10 * 60 * 1000;

/** Renders whole-line backgrounds, overview ruler marks and the optional cursor-line annotation. */
export class DecorationRenderer implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private fadeStops: RGBA[] = [];
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

  constructor(
    private readonly store: MarkStore,
    private cfg: PatinaConfig,
  ) {
    this.applyConfig(cfg);
    this.disposables.push(
      store.onDidChangeMarks((uris) => {
        const keys = new Set(uris.map((u) => u.toString()));
        for (const ed of vscode.window.visibleTextEditors) if (keys.has(ed.document.uri.toString())) this.schedule(ed);
      }),
      vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((ed) => this.schedule(ed))),
      vscode.window.onDidChangeTextEditorSelection((e) => this.renderAnnotation(e.textEditor)),
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
    this.fadeStops = cfg.fadeColors.map((c) => parseColor(c) ?? [128, 128, 128, 0.15]);
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
    if (!this.cfg.showCursorLineAnnotation || editor !== vscode.window.activeTextEditor) {
      editor.setDecorations(this.annotationType, []);
      return;
    }
    const line = editor.selection.active.line;
    const m = this.store.get(editor.document.uri)?.get(line);
    if (!m || line >= editor.document.lineCount) {
      editor.setDecorations(this.annotationType, []);
      return;
    }
    const now = Date.now();
    let text = `${categoryLabel(this.cfg, m.cat)} · ${shortAge(now - m.t)} ago`;
    if (m.stale !== undefined) text = `⚠ changed outside editor ${shortAge(now - m.stale)} ago · was ${text}`;
    const end = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.annotationType, [
      { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } },
    ]);
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
    let color: string;
    if (key === 'stale') color = this.cfg.staleColor;
    else if (key.startsWith('read:')) color = formatColor(interpolateStops(this.fadeStops, Number(key.slice(5)) / FADE_STEPS));
    else if (key.startsWith('cat:')) color = this.cfg.categories.get(key.slice(4))?.color ?? FALLBACK_COLOR;
    else color = FALLBACK_COLOR;
    const parsed = parseColor(color);
    const options: vscode.DecorationRenderOptions = {
      isWholeLine: true,
      backgroundColor: color,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    };
    if (this.cfg.showInOverviewRuler) {
      options.overviewRulerColor = parsed ? formatColor(withMinAlpha(parsed, 0.7)) : color;
      options.overviewRulerLane = vscode.OverviewRulerLane.Left;
    }
    type = vscode.window.createTextEditorDecorationType(options);
    this.types.set(key, type);
    return type;
  }
}
