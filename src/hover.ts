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
    md.isTrusted = { enabledCommands: ['patina.editNote', 'patina.removeNote'] };
    md.appendMarkdown('**Patina** · ');
    md.appendText(markLabel(cfg, m));
    if (m.cat === READ && m.stale === undefined) {
      const pct = Math.min(100, Math.round(((now - m.t) / cfg.fadeMs) * 100));
      md.appendMarkdown(` · ${pct}% faded`);
    }
    md.appendMarkdown(`\n\nMarked ${formatTimestamp(m.t)} (${relativeAge(now - m.t)})`);
    if (m.note !== undefined) {
      md.appendMarkdown('\n\n$(note) ');
      md.appendText(m.note);
    }
    if (m.stale !== undefined) {
      const when = `${formatTimestamp(m.stale)} (${relativeAge(now - m.stale)})`;
      if (m.removed) {
        const n = m.removed;
        md.appendMarkdown(
          `\n\n$(warning) **${escapeMd(cfg.staleLabel)}**: ${n} marked line${n === 1 ? ' was' : 's were'} deleted next to this one outside the editor. Detected ${when}.`,
        );
      } else {
        md.appendMarkdown(`\n\n$(warning) **${escapeMd(cfg.staleLabel)}**: this line changed outside the editor. Detected ${when}.`);
      }
      md.appendMarkdown('\n\n_Mark it again to clear._');
    }
    const target = encodeURIComponent(JSON.stringify([{ uri: doc.uri.toString(), line: pos.line }]));
    md.appendMarkdown(
      m.note !== undefined
        ? `\n\n[Edit note](command:patina.editNote?${target}) · [Remove note](command:patina.removeNote?${target})`
        : `\n\n[Add note](command:patina.editNote?${target})`,
    );
    return new vscode.Hover(md, doc.lineAt(pos.line).range);
  }
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
