import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { PatinaApi } from '../extension';

/** Spec testing scenarios, run inside a real extension host. */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<PatinaApi>('local.patina');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const ws = vscode.workspace.workspaceFolders![0].uri;
  const file = vscode.Uri.joinPath(ws, 'a.txt');
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  fs.writeFileSync(file.fsPath, lines.join('\n') + '\n');

  const marked = () => [...(api.store.get(file)?.entries() ?? [])].map(([l]) => l);
  const stale = () => [...(api.store.get(file)?.entries() ?? [])].filter(([, m]) => m.stale !== undefined).map(([l]) => l);
  const results: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push(`  ✓ ${name}`);
    } catch (err) {
      results.push(`  ✗ ${name}: ${err instanceof Error ? err.message : err}`);
      throw new Error(results.join('\n'));
    } finally {
      console.log(results[results.length - 1]);
    }
  };

  let doc = await vscode.workspace.openTextDocument(file);
  let editor = await vscode.window.showTextDocument(doc);

  await step('mark selection as read', async () => {
    editor.selection = new vscode.Selection(5, 0, 9, 0);
    await vscode.commands.executeCommand('patina.markRead');
    assert.deepEqual(marked(), [5, 6, 7, 8]);
  });

  await step('typing inside a marked range stays fresh', async () => {
    await editor.edit((eb) => eb.insert(new vscode.Position(6, 2), 'XYZ'));
    assert.ok(doc.isDirty);
    await doc.save();
    await sleep(800); // let the watcher see our own save
    assert.deepEqual(marked(), [5, 6, 7, 8]);
    assert.deepEqual(stale(), []);
  });

  await step('typed edit marks the line read now; tool edit keeps the date', async () => {
    const markedAt = (l: number) => api.store.get(file)?.get(l)?.t;
    const before = markedAt(8)!;
    await sleep(20);
    editor.selection = new vscode.Selection(8, 0, 8, 0);
    await editor.edit((eb) => eb.insert(new vscode.Position(8, 0), 'T'));
    assert.ok(markedAt(8)! > before, 'typed line should be re-dated');
    const toolBefore = markedAt(5)!;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const we = new vscode.WorkspaceEdit();
    we.replace(file, new vscode.Range(5, 0, 5, 4), 'LINE');
    await vscode.workspace.applyEdit(we);
    assert.equal(markedAt(5), toolBefore, 'tool edit should keep the date');
    await doc.save();
    await sleep(800);
    assert.deepEqual(stale(), []);
  });

  await step('first keystroke after a save stays fresh', async () => {
    assert.ok(!doc.isDirty);
    await editor.edit((eb) => eb.insert(new vscode.Position(7, 0), '#'));
    await sleep(1500); // past the ambiguity window
    assert.deepEqual(stale(), []);
    await doc.save();
    await sleep(800);
    assert.deepEqual(stale(), []);
  });

  await step('inserting lines above in the editor moves the mark', async () => {
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), 'a\nb\n'));
    await doc.save();
    await sleep(800);
    assert.deepEqual(marked(), [7, 8, 9, 10]);
    assert.deepEqual(stale(), []);
  });

  await step('undo back to the saved state counts as mine', async () => {
    await editor.edit((eb) => eb.insert(new vscode.Position(8, 0), 'Q'));
    await vscode.commands.executeCommand('undo');
    assert.ok(!doc.isDirty);
    assert.deepEqual(stale(), []);
  });

  await step('external edit to an open file (like sed -i) goes stale', async () => {
    const text = fs.readFileSync(file.fsPath, 'utf8').split('\n');
    text[8] = 'changed by another process';
    fs.writeFileSync(file.fsPath, text.join('\n'));
    await waitFor(() => stale().length > 0, 'stale lines');
    await waitFor(() => doc.lineAt(8).text === 'changed by another process', 'document reload');
    await sleep(500);
    assert.deepEqual(stale(), [8]);
    assert.deepEqual(marked(), [7, 8, 9, 10]);
  });

  await step('external insertion above (like git checkout) relocates marks', async () => {
    const text = fs.readFileSync(file.fsPath, 'utf8').split('\n');
    fs.writeFileSync(file.fsPath, ['x', 'y', 'z', ...text].join('\n'));
    await waitFor(() => marked()[0] === 10, 'marks moved');
    await sleep(500);
    assert.deepEqual(marked(), [10, 11, 12, 13]);
    assert.deepEqual(stale(), [11]);
  });

  await step('close editor, change file externally, reopen → stale', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const text = fs.readFileSync(file.fsPath, 'utf8').split('\n');
    text[13] = 'changed while closed';
    fs.writeFileSync(file.fsPath, text.join('\n'));
    await sleep(1500);
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await waitFor(() => stale().includes(13), 'stale after reopen');
    assert.deepEqual(stale(), [11, 13]);
  });

  await step('re-marking clears stale', async () => {
    editor.selection = new vscode.Selection(10, 0, 13, 3);
    await vscode.commands.executeCommand('patina.markRead');
    assert.deepEqual(stale(), []);
  });

  await step('marks persist to storage', async () => {
    await sleep(2500);
    const stored = JSON.parse(fs.readFileSync(vscode.Uri.joinPath(ws, '.vscode', 'patina.json').fsPath, 'utf8'));
    assert.equal(stored.files['a.txt'].length, 1);
    assert.equal(stored.files['a.txt'][0].l, 10);
  });

  await step('mark whole folder and clear', async () => {
    fs.mkdirSync(vscode.Uri.joinPath(ws, 'sub').fsPath, { recursive: true });
    fs.writeFileSync(vscode.Uri.joinPath(ws, 'sub', 'b.txt').fsPath, 'one\ntwo\n');
    await vscode.commands.executeCommand('patina.markFileRead', vscode.Uri.joinPath(ws, 'sub'));
    const b = api.store.get(vscode.Uri.joinPath(ws, 'sub', 'b.txt'));
    assert.deepEqual([...(b?.entries() ?? [])].map(([l]) => l), [0, 1, 2]);
    assert.equal(api.store.stats(vscode.Uri.joinPath(ws, 'sub', 'b.txt'))?.read, 2);
  });

  await step('folded block shows a summary of its contents', async () => {
    const f = vscode.Uri.joinPath(ws, 'fold.txt');
    fs.writeFileSync(f.fsPath, ['block:', '  one', '  two', '  three', '  four', '  five', 'after'].join('\n') + '\n');
    const d = await vscode.workspace.openTextDocument(f);
    const ed = await vscode.window.showTextDocument(d);
    ed.selection = new vscode.Selection(1, 0, 3, 5);
    await vscode.commands.executeCommand('patina.markRead');
    ed.selection = new vscode.Selection(4, 0, 4, 0);
    await vscode.commands.executeCommand('patina.markQuestion');
    ed.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('editor.fold', { selectionLines: [0] });
    await waitFor(() => ed.visibleRanges.length > 1, 'fold to split visible ranges');
    const note = api.renderer.annotations(ed).get(0);
    assert.equal(note, 'Contents 60% read · avg 1m ago · 1 Question');
    await vscode.commands.executeCommand('editor.unfold', { selectionLines: [0] });
    await waitFor(() => ed.visibleRanges.length === 1, 'unfold');
    assert.equal(api.renderer.annotations(ed).get(0), undefined);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
