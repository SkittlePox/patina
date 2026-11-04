import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { PatinaConfig, readConfig } from './config';
import { DecorationRenderer } from './decorations';
import { ExplorerDecorations } from './explorer';
import { MarkHoverProvider } from './hover';
import { MarkStore } from './store';
import { ChangeTracker } from './tracker';

let store: MarkStore | undefined;

/** Exposed for integration tests. */
export interface PatinaApi {
  store: MarkStore;
  tracker: ChangeTracker;
}

export async function activate(context: vscode.ExtensionContext): Promise<PatinaApi> {
  let cfg = readConfig();
  const getConfig = (): PatinaConfig => cfg;
  const log = vscode.window.createOutputChannel('Patina');

  store = new MarkStore(getConfig, log, context.workspaceState);
  await store.loadAll();

  const tracker = new ChangeTracker(store, log);
  tracker.start();
  const renderer = new DecorationRenderer(store, cfg, vscode.Uri.joinPath(context.globalStorageUri, 'gutter').fsPath);
  const explorer = new ExplorerDecorations(store, getConfig);

  context.subscriptions.push(
    log,
    store,
    tracker,
    renderer,
    explorer,
    vscode.window.registerFileDecorationProvider(explorer),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new MarkHoverProvider(store, getConfig)),
    ...registerCommands(store, tracker, getConfig),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('patina')) return;
      const storageChanged = e.affectsConfiguration('patina.storageFile');
      const excludeChanged = e.affectsConfiguration('patina.exclude');
      cfg = readConfig();
      renderer.applyConfig(cfg);
      explorer.refreshAll();
      // Files that just stopped being excluded may have changed while hidden.
      if (excludeChanged) void tracker.validateAll('exclusions changed').then(() => renderer.renderAll());
      if (storageChanged) {
        void vscode.window.showInformationMessage('Patina: reload the window to use the new storage file location.');
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      e.removed.forEach((f) => store!.unloadFolder(f));
      for (const f of e.added) await store!.loadFolder(f);
      await tracker.validateAll('workspace folder added');
      renderer.renderAll();
    }),
  );

  // Anything that changed while the editor wasn't watching is foreign: validate everything now.
  const r = await tracker.validateAll('changed while editor was closed');
  log.appendLine(`Validated ${r.files} file(s); ${r.stale} line(s) newly stale.`);
  renderer.renderAll();
  return { store, tracker };
}

export async function deactivate(): Promise<void> {
  await store?.flush();
}
