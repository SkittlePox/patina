import * as vscode from 'vscode';
import { EditChange, LineSource, linesFromText } from './core/marks';
import { MarkStore } from './store';

const DISK_DEBOUNCE_MS = 300;
const STATS_DEBOUNCE_MS = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function docSource(doc: vscode.TextDocument): LineSource {
  return { lineCount: doc.lineCount, lineAt: (i) => doc.lineAt(i).text };
}

/** Decodes file bytes as text, or returns undefined for binary / oversized files. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_FILE_BYTES) return undefined;
  const probe = bytes.subarray(0, 8000);
  if (probe.includes(0)) return undefined;
  return new TextDecoder().decode(bytes);
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}

/**
 * Decides whether a change was made by the user (marks follow silently) or arrived from elsewhere
 * (marks are validated against fingerprints and changed lines go stale).
 *
 * - Change event on a document that is dirty afterwards, or an undo/redo: the user's own edit.
 * - Change event that leaves the document clean (not undo/redo): VS Code reloaded it from disk → foreign.
 * - File watcher event for a file that isn't open (or is open and clean): validate against disk → foreign.
 * - Document opened / extension activated: validate, so anything changed while unobserved is foreign.
 */
export class ChangeTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly diskTimers = new Map<string, NodeJS.Timeout>();
  private readonly statsTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: MarkStore,
    private readonly log: vscode.OutputChannel,
  ) {}

  start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidChange((u) => this.onDiskEvent(u)),
      watcher.onDidCreate((u) => this.onDiskEvent(u)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.workspace.onDidOpenTextDocument((d) => this.validateDocument(d, 'opened')),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.store.rename(f.oldUri, f.newUri))),
      vscode.workspace.onDidDeleteFiles((e) => this.store.removeUnder([...e.files])),
    );
  }

  dispose(): void {
    for (const t of [...this.diskTimers.values(), ...this.statsTimers.values()]) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (doc.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
    const marks = this.store.get(doc.uri);
    if (!marks) return;
    const mine =
      doc.isDirty || e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
    if (!mine) {
      this.validateDocument(doc, 'reloaded from disk');
      return;
    }
    const changes: EditChange[] = e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      endLine: c.range.end.line,
      insertedLineBreaks: countLineBreaks(c.text),
    }));
    marks.applyUserEdits(changes, docSource(doc));
    this.store.changed([doc.uri]);
    this.scheduleStats(doc);
  }

  private onDiskEvent(uri: vscode.Uri): void {
    if (!this.store.get(uri) || this.store.isStorageFile(uri)) return;
    const key = uri.toString();
    const existing = this.diskTimers.get(key);
    if (existing) clearTimeout(existing);
    this.diskTimers.set(
      key,
      setTimeout(() => {
        this.diskTimers.delete(key);
        void this.validateUri(uri, 'changed on disk');
      }, DISK_DEBOUNCE_MS),
    );
  }

  /** Validate marks for an open document against its current text. */
  validateDocument(doc: vscode.TextDocument, why: string, fireStats = true): number {
    if (doc.uri.scheme !== 'file') return 0;
    const marks = this.store.get(doc.uri);
    if (!marks) return 0;
    const src = docSource(doc);
    const now = Date.now();
    const r = marks.validate(src, now);
    if (r.newlyStale) this.log.appendLine(`${vscode.workspace.asRelativePath(doc.uri)}: ${r.newlyStale} line(s) went stale (${why})`);
    if (r.changed) this.store.changed([doc.uri]);
    this.store.setStats(doc.uri, marks.stats(src, now), fireStats);
    return r.newlyStale;
  }

  /** Validate a file using its open (clean) document, or its content on disk. Returns lines newly stale. */
  async validateUri(uri: vscode.Uri, why: string, fireStats = true): Promise<number> {
    const marks = this.store.get(uri);
    if (!marks) return 0;
    const doc = openDocument(uri);
    if (doc) {
      // Dirty: the user has unsaved edits and marks track the buffer; a conflicting disk change surfaces on save.
      // Clean: VS Code reloads it from disk and the resulting change event validates it. Checking the buffer here
      // (rather than our own decode of the bytes) keeps non-UTF-8 files from looking changed.
      return doc.isDirty ? 0 : this.validateDocument(doc, why, fireStats);
    }
    let src: LineSource;
    try {
      const text = decodeText(await vscode.workspace.fs.readFile(uri));
      if (text === undefined) return 0;
      src = linesFromText(text);
    } catch {
      this.store.setStats(uri, undefined, fireStats); // missing: keep marks in case it comes back
      return 0;
    }
    const now = Date.now();
    const r = marks.validate(src, now);
    if (r.newlyStale) this.log.appendLine(`${vscode.workspace.asRelativePath(uri)}: ${r.newlyStale} line(s) went stale (${why})`);
    if (r.changed) this.store.changed([uri]);
    this.store.setStats(uri, marks.stats(src, now), fireStats);
    return r.newlyStale;
  }

  /** Validate every file with marks. Open documents are checked against their buffer, others against disk. */
  async validateAll(why: string): Promise<{ files: number; stale: number }> {
    const uris = this.store.files();
    let stale = 0;
    const queue = [...uris];
    const worker = async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) {
        const doc = openDocument(uri);
        stale += doc ? this.validateDocument(doc, why, false) : await this.validateUri(uri, why, false);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    this.store.fireStats(uris);
    return { files: uris.length, stale };
  }

  scheduleStats(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const existing = this.statsTimers.get(key);
    if (existing) clearTimeout(existing);
    this.statsTimers.set(
      key,
      setTimeout(() => {
        this.statsTimers.delete(key);
        const marks = this.store.get(doc.uri);
        if (marks && !doc.isClosed) this.store.setStats(doc.uri, marks.stats(docSource(doc), Date.now()));
      }, STATS_DEBOUNCE_MS),
    );
  }
}

function countLineBreaks(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) n++;
    else if (ch === 13 && text.charCodeAt(i + 1) !== 10) n++;
  }
  return n;
}
