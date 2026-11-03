import * as vscode from 'vscode';
import { READ } from './core/marks';
import { formatTimestamp, relativeAge } from './core/time';
import { markLabel, PatinaConfig } from './config';
import { MarkStore } from './store';

export class MarkHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly store: MarkStore,
    private readonly getConfig: () => PatinaConfig,
  ) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const m = this.store.get(doc.uri)?.get(pos.line);
    if (!m) return undefined;
    const cfg = this.getConfig();
    const now = Date.now();
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown('**Patina** · ');
    md.appendText(markLabel(cfg, m));
    if (m.cat === READ && m.stale === undefined) {
      const pct = Math.min(100, Math.round(((now - m.t) / cfg.fadeMs) * 100));
      md.appendMarkdown(` · ${pct}% faded`);
    }
    md.appendMarkdown(`\n\nMarked ${formatTimestamp(m.t)} (${relativeAge(now - m.t)})`);
    if (m.stale !== undefined) {
      const when = `${formatTimestamp(m.stale)} (${relativeAge(now - m.stale)})`;
      if (m.removed) {
        const n = m.removed;
        md.appendMarkdown(
          `\n\n$(warning) **Stale**: ${n} marked line${n === 1 ? ' was' : 's were'} deleted next to this one outside the editor. Detected ${when}.`,
        );
      } else {
        md.appendMarkdown(`\n\n$(warning) **Stale**: this line changed outside the editor. Detected ${when}.`);
      }
      md.appendMarkdown('\n\n_Mark it again to clear._');
    }
    return new vscode.Hover(md, doc.lineAt(pos.line).range);
  }
}
