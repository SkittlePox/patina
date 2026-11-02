import * as vscode from 'vscode';
import { FileMarks, FileStats } from './core/marks';
import { deserialize, serialize } from './core/serialize';
import { PatinaConfig } from './config';

interface Entry {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  rel: string;
  marks: FileMarks;
  stats?: FileStats;
}

interface FolderState {
  folder: vscode.WorkspaceFolder;
  storage: vscode.Uri;
  /** The storage file exists but couldn't be parsed: never overwrite it. */
  broken: boolean;
  existed: boolean;
}

const SAVE_DELAY_MS = 1500;

/** All marks for all workspace folders, persisted per folder as JSON. */
export class MarkStore implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly folders = new Map<string, FolderState>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChangeMarks = new vscode.EventEmitter<vscode.Uri[]>();
  private readonly _onDidChangeStats = new vscode.EventEmitter<vscode.Uri[]>();
  /** Fired when marks for the given files changed (positions, categories, staleness). */
  readonly onDidChangeMarks = this._onDidChangeMarks.event;
  /** Fired when per-file statistics (explorer decorations) changed. */
  readonly onDidChangeStats = this._onDidChangeStats.event;

  constructor(
    private readonly getConfig: () => PatinaConfig,
    private readonly log: vscode.OutputChannel,
    private readonly memento: vscode.Memento,
  ) {}

  dispose(): void {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this._onDidChangeMarks.dispose();
    this._onDidChangeStats.dispose();
  }

  async loadAll(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.loadFolder(folder);
  }

  async loadFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const storage = vscode.Uri.joinPath(folder.uri, this.getConfig().storageFile);
    const state: FolderState = { folder, storage, broken: false, existed: false };
    this.folders.set(folder.uri.toString(), state);
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(storage));
    } catch {
      return; // no marks yet
    }
    state.existed = true;
    try {
      for (const [rel, marks] of deserialize(text)) {
        const uri = vscode.Uri.joinPath(folder.uri, rel);
        this.entries.set(uri.toString(), { uri, folder, rel, marks });
      }
      this.log.appendLine(`Loaded marks for ${this.filesIn(folder).length} file(s) from ${storage.fsPath}`);
    } catch (err) {
      state.broken = true;
      const msg = `Patina: couldn't read ${storage.fsPath} (${err instanceof Error ? err.message : err}). Marks for this folder won't be saved until it's fixed.`;
      this.log.appendLine(msg);
      void vscode.window.showErrorMessage(msg);
    }
  }

  unloadFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    this.flushFolder(key);
    this.folders.delete(key);
    for (const [k, e] of this.entries) if (e.folder.uri.toString() === key) this.entries.delete(k);
  }

  isStorageFile(uri: vscode.Uri): boolean {
    const s = uri.toString();
    for (const f of this.folders.values()) if (f.storage.toString() === s) return true;
    return false;
  }

  get(uri: vscode.Uri): FileMarks | undefined {
    return this.entries.get(uri.toString())?.marks;
  }

  /** Marks for a file, created on demand. Undefined if the file isn't inside a workspace folder. */
  getOrCreate(uri: vscode.Uri): FileMarks | undefined {
    const existing = this.entries.get(uri.toString());
    if (existing) return existing.marks;
    if (uri.scheme !== 'file') return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || !this.folders.has(folder.uri.toString())) return undefined;
    const rel = relativePath(folder.uri, uri);
    if (!rel || this.isStorageFile(uri)) return undefined;
    const entry: Entry = { uri, folder, rel, marks: new FileMarks() };
    this.entries.set(uri.toString(), entry);
    return entry.marks;
  }

  files(): vscode.Uri[] {
    return [...this.entries.values()].map((e) => e.uri);
  }

  stats(uri: vscode.Uri): FileStats | undefined {
    return this.entries.get(uri.toString())?.stats;
  }

  setStats(uri: vscode.Uri, stats: FileStats | undefined, fire = true): void {
    const e = this.entries.get(uri.toString());
    if (!e) return;
    e.stats = stats;
    if (fire) this._onDidChangeStats.fire([uri]);
  }

  fireStats(uris: vscode.Uri[]): void {
    if (uris.length) this._onDidChangeStats.fire(uris);
  }

  /** Record that marks for these files changed: re-render and schedule a save. */
  changed(uris: vscode.Uri[]): void {
    if (!uris.length) return;
    const touchedFolders = new Set<string>();
    const removed: vscode.Uri[] = [];
    for (const uri of uris) {
      const e = this.entries.get(uri.toString());
      if (!e) continue;
      touchedFolders.add(e.folder.uri.toString());
      if (e.marks.isEmpty) {
        this.entries.delete(uri.toString());
        removed.push(uri);
      }
    }
    for (const f of touchedFolders) this.scheduleSave(f);
    this._onDidChangeMarks.fire(uris);
    if (removed.length) this._onDidChangeStats.fire(removed);
  }

  /** Remove all marks for the given files and/or everything under the given folders. Returns affected files. */
  removeUnder(targets: vscode.Uri[]): vscode.Uri[] {
    const affected: vscode.Uri[] = [];
    for (const [k, e] of this.entries) {
      if (targets.some((t) => k === t.toString() || k.startsWith(t.toString() + '/'))) {
        e.marks.lines = [];
        affected.push(e.uri);
      }
    }
    this.changed(affected);
    return affected;
  }

  countUnder(target: vscode.Uri): number {
    const t = target.toString();
    let n = 0;
    for (const k of this.entries.keys()) if (k === t || k.startsWith(t + '/')) n++;
    return n;
  }

  /** Follow a file or folder rename done inside the editor. */
  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const o = oldUri.toString();
    const moved: vscode.Uri[] = [];
    for (const [k, e] of [...this.entries]) {
      if (k !== o && !k.startsWith(o + '/')) continue;
      const target = vscode.Uri.parse(newUri.toString() + k.slice(o.length));
      this.entries.delete(k);
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder || !this.folders.has(folder.uri.toString())) {
        moved.push(e.uri); // moved out of the workspace: drop
        this.scheduleSave(e.folder.uri.toString());
        continue;
      }
      this.scheduleSave(e.folder.uri.toString());
      const entry: Entry = { uri: target, folder, rel: relativePath(folder.uri, target)!, marks: e.marks, stats: e.stats };
      this.entries.set(target.toString(), entry);
      this.scheduleSave(folder.uri.toString());
      moved.push(e.uri, target);
    }
    if (moved.length) {
      this._onDidChangeMarks.fire(moved);
      this._onDidChangeStats.fire(moved);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.saveTimers.keys()].map((k) => this.flushFolder(k)));
  }

  private scheduleSave(folderKey: string): void {
    const existing = this.saveTimers.get(folderKey);
    if (existing) clearTimeout(existing);
    this.saveTimers.set(
      folderKey,
      setTimeout(() => void this.flushFolder(folderKey), SAVE_DELAY_MS),
    );
  }

  private async flushFolder(folderKey: string): Promise<void> {
    const timer = this.saveTimers.get(folderKey);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(folderKey);
    const state = this.folders.get(folderKey);
    if (!state || state.broken) return;
    const files = new Map<string, FileMarks>();
    for (const e of this.filesIn(state.folder)) files.set(e.rel, e.marks);
    if (files.size === 0 && !state.existed) return;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(state.storage, '..'));
      await vscode.workspace.fs.writeFile(state.storage, new TextEncoder().encode(serialize(files)));
      if (!state.existed) {
        state.existed = true;
        void this.suggestIgnore(state);
      }
    } catch (err) {
      this.log.appendLine(`Failed to save ${state.storage.fsPath}: ${err}`);
    }
  }

  private filesIn(folder: vscode.WorkspaceFolder): Entry[] {
    const key = folder.uri.toString();
    return [...this.entries.values()].filter((e) => e.folder.uri.toString() === key);
  }

  /** First time a storage file is created in a git repo, offer to keep it out of version control. */
  private async suggestIgnore(state: FolderState): Promise<void> {
    const memKey = `patina.ignorePrompted:${state.folder.uri.toString()}`;
    if (this.memento.get(memKey)) return;
    const root = state.folder.uri;
    const gitDir = vscode.Uri.joinPath(root, '.git');
    try {
      const stat = await vscode.workspace.fs.stat(gitDir);
      if (!(stat.type & vscode.FileType.Directory)) return;
    } catch {
      return;
    }
    const rel = relativePath(root, state.storage);
    if (!rel) return;
    const read = async (u: vscode.Uri) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
      } catch {
        return '';
      }
    };
    const exclude = vscode.Uri.joinPath(gitDir, 'info', 'exclude');
    const gitignore = vscode.Uri.joinPath(root, '.gitignore');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const covers = (text: string) =>
      text.split(/\r?\n/).some((l) => {
        const p = l.trim().replace(/^\//, '').replace(/\/$/, '');
        return p === rel || p === rel.split('/').pop() || (dir !== '' && p === dir);
      });
    if (covers(await read(exclude)) || covers(await read(gitignore))) return;

    const privateOpt = 'Add to .git/info/exclude (private)';
    const sharedOpt = 'Add to .gitignore';
    const never = "Don't ask again";
    const choice = await vscode.window.showInformationMessage(
      `Patina saves your reading marks in ${rel}. Keep it out of git?`,
      privateOpt,
      sharedOpt,
      never,
    );
    if (!choice) return;
    await this.memento.update(memKey, true);
    if (choice === never) return;
    const target = choice === privateOpt ? exclude : gitignore;
    const existing = await read(target);
    const line = '/' + rel;
    const text = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n';
    try {
      if (choice === privateOpt) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(gitDir, 'info'));
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    } catch (err) {
      void vscode.window.showErrorMessage(`Patina: couldn't update ${target.fsPath}: ${err}`);
    }
  }
}

export function relativePath(base: vscode.Uri, uri: vscode.Uri): string | undefined {
  const b = base.path.endsWith('/') ? base.path : base.path + '/';
  return uri.path.startsWith(b) ? uri.path.slice(b.length) : undefined;
}
