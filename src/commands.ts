import * as vscode from 'vscode';
import { linesFromText, LineSource, normalizeNote, READ } from './core/marks';
import { categoryLabel, PatinaConfig } from './config';
import { MarkStore } from './store';
import { ChangeTracker, decodeText, docSource } from './tracker';

const CONFIRM_FILE_COUNT = 300;
const MAX_FOLDER_FILES = 50_000;

type CategoryArg = string | { category?: string } | undefined;
/** Target of a note command run from a hover link: a document and a 0-based line. */
type NoteArg = { uri?: string; line?: number } | undefined;

export function registerCommands(
  store: MarkStore,
  tracker: ChangeTracker,
  getConfig: () => PatinaConfig,
): vscode.Disposable[] {
  const reg = vscode.commands.registerCommand;
  return [
    reg('patina.markRead', () => markSelection(store, tracker, getConfig, READ)),
    reg('patina.markNext', () => markSelection(store, tracker, getConfig, 'next')),
    reg('patina.markQuestion', () => markSelection(store, tracker, getConfig, 'question')),
    reg('patina.mark', async (arg: CategoryArg) => {
      const cat = categoryFromArg(arg) ?? (await pickCategory(getConfig()));
      if (cat) await markSelection(store, tracker, getConfig, cat);
    }),
    reg('patina.clearMarks', () => clearSelection(store, tracker)),
    reg('patina.editNote', (arg: NoteArg) => editNote(store, tracker, getConfig, arg)),
    reg('patina.removeNote', (arg: NoteArg) => removeNote(store, tracker, arg)),
    reg('patina.markFileRead', (uri?: vscode.Uri, uris?: vscode.Uri[]) => markFiles(store, getConfig, READ, uri, uris)),
    reg('patina.markFileAs', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const cat = await pickCategory(getConfig());
      if (cat) await markFiles(store, getConfig, cat, uri, uris);
    }),
    reg('patina.clearFileMarks', (uri?: vscode.Uri, uris?: vscode.Uri[]) => clearFiles(store, uri, uris)),
    reg('patina.revalidateAll', async () => {
      const r = await tracker.validateAll('manual re-check');
      void vscode.window.showInformationMessage(
        `Patina: checked ${r.files} file${r.files === 1 ? '' : 's'}; ${r.stale} line${r.stale === 1 ? '' : 's'} newly stale.`,
      );
    }),
  ];
}

function categoryFromArg(arg: CategoryArg): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof (arg as { category?: unknown }).category === 'string') return (arg as { category: string }).category;
  return undefined;
}

async function pickCategory(cfg: PatinaConfig, placeHolder = 'Mark as…'): Promise<string | undefined> {
  const items: (vscode.QuickPickItem & { id: string })[] = [
    { id: READ, label: cfg.readLabel, description: 'fades with age' },
    ...[...cfg.categories.values()].map((c) => ({ id: c.id, label: c.label, description: c.id })),
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  return pick?.id;
}

function checkCategory(cfg: PatinaConfig, cat: string): boolean {
  if (cat === READ || cfg.categories.has(cat)) return true;
  void vscode.window.showErrorMessage(`Patina: unknown category "${cat}". Define it in the "patina.categories" setting.`);
  return false;
}

function selectedLineRanges(editor: vscode.TextEditor): [number, number][] {
  return editor.selections.map((sel) => {
    let end = sel.end.line;
    if (end > sel.start.line && sel.end.character === 0) end--;
    return [sel.start.line, end];
  });
}

function editorMarks(store: MarkStore, editor: vscode.TextEditor | undefined, create: boolean) {
  if (!editor) return undefined;
  const uri = editor.document.uri;
  const marks = create ? store.getOrCreate(uri) : store.get(uri);
  if (!marks && create) {
    void vscode.window.showWarningMessage(
      store.isExcluded(uri)
        ? 'Patina: this file is excluded by the "patina.exclude" setting.'
        : 'Patina only tracks files saved inside an open workspace folder.',
    );
  }
  return marks;
}

async function markSelection(store: MarkStore, tracker: ChangeTracker, getConfig: () => PatinaConfig, cat: string): Promise<void> {
  const cfg = getConfig();
  if (!checkCategory(cfg, cat)) return;
  const editor = vscode.window.activeTextEditor;
  const marks = editorMarks(store, editor, true);
  if (!editor || !marks) return;
  const src = docSource(editor.document);
  const now = Date.now();
  for (const [s, e] of selectedLineRanges(editor)) marks.mark(s, e, cat, now, src);
  store.changed([editor.document.uri]);
  tracker.scheduleStats(editor.document);
  vscode.window.setStatusBarMessage(`Patina: marked as ${categoryLabel(cfg, cat)}`, 1500);
}

/** The document and line a note command applies to: the hover link's target, else the selection's first line. */
function noteTarget(arg: NoteArg): { doc: vscode.TextDocument; line: number; editor?: vscode.TextEditor } | undefined {
  if (arg && typeof arg.uri === 'string' && typeof arg.line === 'number') {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === arg.uri);
    return doc && arg.line < doc.lineCount ? { doc, line: arg.line } : undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const line = Math.min(...editor.selections.map((sel) => sel.start.line));
  return { doc: editor.document, line, editor };
}

async function editNote(store: MarkStore, tracker: ChangeTracker, getConfig: () => PatinaConfig, arg: NoteArg): Promise<void> {
  const target = noteTarget(arg);
  if (!target) return;
  const { doc, line, editor } = target;
  const existing = store.get(doc.uri)?.get(line);
  const note = await vscode.window.showInputBox({
    title: existing?.note === undefined ? 'Patina: Add Note' : 'Patina: Edit Note',
    prompt: `Note for line ${line + 1}${existing?.note === undefined ? '' : '. Leave empty to remove it'}.`,
    value: existing?.note ?? '',
    placeHolder: 'e.g. why does this retry twice?',
  });
  if (note === undefined) return;
  // Looked up again: the marks may have changed while the input box was open.
  const current = store.get(doc.uri);
  if (!current?.get(line)) {
    // Notes live on marks: an unmarked line gets marked first, along with the rest of the selection.
    if (normalizeNote(note) === undefined || !editor) return;
    const cfg = getConfig();
    const cat = await pickCategory(cfg, 'Mark the line as… (a note needs a mark)');
    if (!cat || !checkCategory(cfg, cat)) return;
    const marks = editorMarks(store, editor, true);
    if (!marks) return;
    const src = docSource(doc);
    const now = Date.now();
    for (const [s, e] of selectedLineRanges(editor)) marks.mark(s, e, cat, now, src);
    marks.setNote(line, note);
  } else {
    current.setNote(line, note);
  }
  store.changed([doc.uri]);
  tracker.scheduleStats(doc);
}

function removeNote(store: MarkStore, tracker: ChangeTracker, arg: NoteArg): void {
  const target = noteTarget(arg);
  if (!target) return;
  const marks = store.get(target.doc.uri);
  if (marks?.get(target.line)?.note === undefined) {
    vscode.window.setStatusBarMessage('Patina: no note on this line.', 2000);
    return;
  }
  marks.setNote(target.line, undefined);
  store.changed([target.doc.uri]);
  tracker.scheduleStats(target.doc);
}

function clearSelection(store: MarkStore, tracker: ChangeTracker): void {
  const editor = vscode.window.activeTextEditor;
  const marks = editorMarks(store, editor, false);
  if (!editor || !marks) return;
  for (const [s, e] of selectedLineRanges(editor)) marks.clear(s, e);
  store.changed([editor.document.uri]);
  tracker.scheduleStats(editor.document);
}

function targetsFrom(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): vscode.Uri[] {
  if (Array.isArray(uris) && uris.length) return uris;
  if (uri instanceof vscode.Uri) return [uri];
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

function excludeGlob(): string {
  const keys = new Set<string>(['**/.git/**']);
  for (const section of ['files.exclude', 'search.exclude']) {
    const obj = vscode.workspace.getConfiguration().get<Record<string, unknown>>(section) ?? {};
    for (const [k, v] of Object.entries(obj)) if (v === true) keys.add(k);
  }
  const storageFile = vscode.workspace.getConfiguration('patina').get<string>('storageFile');
  if (storageFile) keys.add(`**/${storageFile}`);
  return `{${[...keys].join(',')}}`;
}

/** Expand folders into files (respecting files.exclude and search.exclude). */
async function expandTargets(store: MarkStore, targets: vscode.Uri[]): Promise<vscode.Uri[]> {
  const out = new Map<string, vscode.Uri>();
  for (const t of targets) {
    if (await isDirectory(t)) {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(t, '**/*'), excludeGlob(), MAX_FOLDER_FILES);
      for (const f of found) out.set(f.toString(), f);
    } else {
      out.set(t.toString(), t);
    }
  }
  return [...out.values()].filter((u) => !store.isStorageFile(u) && !store.isExcluded(u));
}

async function readSource(uri: vscode.Uri): Promise<LineSource | undefined> {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (doc) return docSource(doc);
  try {
    const text = decodeText(await vscode.workspace.fs.readFile(uri));
    return text === undefined ? undefined : linesFromText(text);
  } catch {
    return undefined;
  }
}

async function markFiles(
  store: MarkStore,
  getConfig: () => PatinaConfig,
  cat: string,
  uri: vscode.Uri | undefined,
  uris: vscode.Uri[] | undefined,
): Promise<void> {
  const cfg = getConfig();
  if (!checkCategory(cfg, cat)) return;
  const targets = targetsFrom(uri, uris);
  if (!targets.length) return;
  const files = await expandTargets(store, targets);
  if (!files.length) {
    void vscode.window.showInformationMessage('Patina: no files to mark.');
    return;
  }
  const label = categoryLabel(cfg, cat);
  if (files.length > CONFIRM_FILE_COUNT) {
    const ok = await vscode.window.showWarningMessage(
      `Mark every line of ${files.length.toLocaleString()} files as "${label}"?`,
      { modal: true },
      'Mark Files',
    );
    if (ok !== 'Mark Files') return;
  }
  let marked = 0;
  let skipped = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Patina: marking as ${label}`, cancellable: true },
    async (progress, token) => {
      const now = Date.now();
      const changed: vscode.Uri[] = [];
      for (let i = 0; i < files.length && !token.isCancellationRequested; i++) {
        const f = files[i];
        const src = await readSource(f);
        const marks = src && store.getOrCreate(f);
        if (!src || !marks) {
          skipped++;
          continue;
        }
        // Every line is re-marked (keeping notes); marks past the end of the file go.
        if (marks.lines.length > src.lineCount) marks.lines.length = src.lineCount;
        marks.mark(0, src.lineCount - 1, cat, now, src);
        store.setStats(f, marks.stats(src, now), false);
        changed.push(f);
        marked++;
        if (i % 50 === 0) progress.report({ message: `${i + 1}/${files.length}`, increment: (50 / files.length) * 100 });
      }
      store.changed(changed);
      store.fireStats(changed);
    },
  );
  const where = files.length === 1 ? vscode.workspace.asRelativePath(files[0]) : `${marked} file${marked === 1 ? '' : 's'}`;
  let msg = `Patina: marked ${where} as ${label}.`;
  if (skipped) msg += ` Skipped ${skipped} (binary, too large, or outside the workspace).`;
  vscode.window.setStatusBarMessage(msg, 4000);
  if (skipped) void vscode.window.showInformationMessage(msg);
}

async function clearFiles(store: MarkStore, uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): Promise<void> {
  const targets = targetsFrom(uri, uris);
  if (!targets.length) return;
  const count = targets.reduce((n, t) => n + store.countUnder(t), 0);
  if (count === 0) {
    vscode.window.setStatusBarMessage('Patina: no marks there.', 2000);
    return;
  }
  const multi = count > 1 || (await Promise.all(targets.map(isDirectory))).some(Boolean);
  if (multi) {
    const ok = await vscode.window.showWarningMessage(
      `Clear all Patina marks in ${count} file${count === 1 ? '' : 's'}? This can't be undone.`,
      { modal: true },
      'Clear Marks',
    );
    if (ok !== 'Clear Marks') return;
  }
  store.removeUnder(targets);
  const where = targets.length === 1 ? ` in ${vscode.workspace.asRelativePath(targets[0])}` : '';
  vscode.window.setStatusBarMessage(`Patina: cleared marks${where}.`, 3000);
}
