import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Runs the integration suite in a real extension host. Set VSCODE_PATH to choose the editor binary. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const workspace = path.join(root, '.test-workspace', 'ws');
  const userData = path.join(root, '.test-workspace', 'user-data');
  fs.rmSync(path.join(root, '.test-workspace'), { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const defaultPath = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH ?? (fs.existsSync(defaultPath) ? defaultPath : undefined),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [workspace, '--disable-extensions', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
