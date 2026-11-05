import * as vscode from 'vscode';
import { relativeAge } from './core/time';
import { PatinaConfig } from './config';
import { MarkStore } from './store';

/**
 * Explorer badges: `!` for files with stale lines, `✓` for fully read files. No colors: a decoration's color
 * would tint the file name too, which is easy to confuse with git's colors. Partially read files get no badge,
 * only a tooltip with their coverage.
 */
export class ExplorerDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly store: MarkStore,
    private readonly getConfig: () => PatinaConfig,
  ) {
    this.sub = store.onDidChangeStats((uris) => this._onDidChange.fire(uris));
  }

  refreshAll(): void {
    this._onDidChange.fire(undefined);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.getConfig().explorerEnabled) return undefined;
    const s = this.store.stats(uri);
    if (!s || s.marked === 0) return undefined;

    const coverage = s.lines > 0 ? s.read / s.lines : 0;
    const parts = [`Patina: ${Math.floor(coverage * 100)}% read`];
    if (s.meanReadAge !== undefined) parts.push(`read on average ${relativeAge(s.meanReadAge)}`);
    const other = s.marked - s.read - s.stale;
    if (other > 0) parts.push(`${other} other marked line${other === 1 ? '' : 's'}`);
    if (s.stale > 0) parts.push(`${this.getConfig().staleLabel}: ${s.stale} line${s.stale === 1 ? '' : 's'}`);
    if (s.notes > 0) parts.push(`${s.notes} note${s.notes === 1 ? '' : 's'}`);

    const badge = s.stale > 0 ? '!' : s.read > 0 && coverage >= 0.995 ? '✓' : undefined;
    return new vscode.FileDecoration(badge, parts.join(' · '));
  }
}
