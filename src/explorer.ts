import * as vscode from 'vscode';
import { relativeAge } from './core/time';
import { explorerColor, PatinaConfig } from './config';
import { MarkStore } from './store';

/** Explorer badge/color per file: read coverage, freshness, stale flag (stale propagates to folders). */
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
    const cfg = this.getConfig();
    if (!cfg.explorerEnabled) return undefined;
    const s = this.store.stats(uri);
    if (!s || s.marked === 0) return undefined;

    const coverage = s.lines > 0 ? s.read / s.lines : 0;
    const pct = Math.floor(coverage * 100);
    const parts = [`Patina: ${s.lines > 0 ? pct : 0}% read`];
    if (s.meanReadAge !== undefined) parts.push(`read on average ${relativeAge(s.meanReadAge)}`);
    const other = s.marked - s.read - s.stale;
    if (other > 0) parts.push(`${other} other marked line${other === 1 ? '' : 's'}`);

    if (s.stale > 0) {
      parts.push(`${s.stale} stale line${s.stale === 1 ? '' : 's'}`);
      return new vscode.FileDecoration('!', parts.join(' · '), explorerColor(cfg, 'Stale'));
    }

    const badge = s.read === 0 ? '•' : coverage >= 0.995 ? '✓' : String(Math.max(1, pct));
    let color: vscode.ThemeColor | undefined;
    if (s.meanReadAge !== undefined) {
      const f = s.meanReadAge / cfg.fadeMs;
      color = explorerColor(cfg, f < 1 / 3 ? 'Fresh' : f < 2 / 3 ? 'Aging' : 'Old');
    }
    const deco = new vscode.FileDecoration(badge, parts.join(' · '), color);
    deco.propagate = false;
    return deco;
  }
}

/** Separate provider so the stale color propagates up to parent folders without propagating badges. */
export class StaleFolderDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
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
    const cfg = this.getConfig();
    if (!cfg.explorerEnabled) return undefined;
    const s = this.store.stats(uri);
    if (!s || s.stale === 0) return undefined;
    const deco = new vscode.FileDecoration(undefined, undefined, explorerColor(cfg, 'Stale'));
    deco.propagate = true;
    return deco;
  }
}
