# Patina

A VS Code / Cursor extension for reading a whole codebase thoroughly. It tracks which lines you've read and when, and whether they've changed since.

- **Mark lines** with a category: `read`, `next` ("attend to next"), `question`, or your own. Each mark is a whole-line background.
- **Read marks fade** from green to yellow to gray over `patina.read.fadeDays` (default 30).
- **Stale marks turn red.** A mark goes stale when its line changes through something other than you typing in the editor: Claude Code in a terminal, `git checkout`, `sed -i`, or any other process.
- **Hover** a marked line to see its category, when it was marked, and its age. If it's stale, the hover also says when the change was detected.
- **Explorer badges** show read coverage (`42` means 42%, `✓` means fully read). The badge color shows freshness, and `!` flags stale lines. Stale files also tint their parent folders.

## Using it

| Action | Default key | Command |
| --- | --- | --- |
| Mark selected lines as read | `ctrl+alt+r` | `Patina: Mark Lines as Read` |
| Mark as attend-to-next | `ctrl+alt+n` | `Patina: Mark Lines as Attend To Next` |
| Mark as question | `ctrl+alt+q` | `Patina: Mark Lines as Question` |
| Mark as any category (picker) | — | `Patina: Mark Lines As…` |
| Clear marks on selected lines | `ctrl+alt+u` | `Patina: Clear Marks on Lines` |
| Mark whole file(s)/folder(s) | explorer menu → Patina | `Patina: Mark Whole File(s) as Read` / `…As…` |
| Clear file(s)/folder(s) | explorer menu → Patina | `Patina: Clear All Marks in File(s)` |
| Re-check everything | — | `Patina: Re-check All Marks Against Current File Contents` |

Each line holds one mark, so marking a line again replaces its mark. Re-marking also clears stale state; that's how you acknowledge a change once you've reread it.

When you mark a folder, Patina skips anything excluded by `files.exclude` or `search.exclude`, as well as binary files and files over 5 MB.

### Custom categories and keybindings

```jsonc
// settings.json
"patina.categories": {
  "next":     { "label": "Attend to next", "color": "rgba(64, 140, 255, 0.22)" },
  "question": { "label": "Question",       "color": "rgba(180, 90, 255, 0.22)" },
  "todo":     { "label": "Todo",           "color": "rgba(255, 150, 0, 0.22)" }
}
```

```jsonc
// keybindings.json
{ "key": "ctrl+alt+t", "command": "patina.mark", "args": { "category": "todo" }, "when": "editorTextFocus" }
```

## Settings

| Setting | Default | |
| --- | --- | --- |
| `patina.categories` | `next`, `question` | Static categories: color and label |
| `patina.read.label` | `Read` | |
| `patina.read.fadeColors` | green → yellow → gray | Fade stops, evenly spaced over the fade duration |
| `patina.read.fadeDays` | `30` | |
| `patina.stale.color` | red | |
| `patina.showCursorLineAnnotation` | `false` | Faint end-of-line note on the cursor line |
| `patina.showInOverviewRuler` | `true` | Show marks in the scrollbar |
| `patina.explorer.enabled` | `true` | |
| `patina.storageFile` | `.vscode/patina.json` | Relative to each workspace folder |

Explorer colors are theme colors. You can override `patina.explorerFresh`, `patina.explorerAging`, `patina.explorerOld`, `patina.explorerStale` and `patina.annotationForeground` in `workbench.colorCustomizations`.

## How change detection works

Each marked line stores a fingerprint of its own text and a fingerprint of the lines around it.

- **Your edits.** If a change event leaves the document dirty, or it is an undo/redo, the edit is yours. Marks follow their lines and are silently re-fingerprinted, so they stay fresh. Pressing Enter inside a marked block extends the block; pressing it at the block's edge doesn't.
- **Foreign changes.** These are detected in two ways. A clean open document that VS Code reloads from disk fires a change event and stays clean. A file that isn't open (or is open and clean) gets a file-watcher event, and Patina validates it against the disk content.
- **Validation** re-anchors marks by content. It first anchors lines whose content is unique, then matches repeated lines (`}`, blank lines) by position and context, in order. Marks that can't be found go stale at their old position. If a fully marked block is rewritten, the whole new block goes stale. If marked lines are deleted outright, the neighbouring mark goes stale and its hover says how many lines were removed.
- **On activation and on file open**, every mark is validated, so changes made while the editor wasn't watching count as foreign.

The invariant: a line changed by a foreign edit is never shown as freshly read.

**Known fuzzy cases (v1):**
- Format-on-save counts as yours.
- Edits applied through the Claude Code or Cursor in-editor diff views probably count as yours too, because they modify the buffer.
- If you edit a file and then close it **without saving**, your typed changes look foreign on the next open, so those lines go stale.
- Files that are closed are checked by decoding their bytes as UTF-8. A file in another encoding with non-ASCII characters may show false stale lines.
- `git mv` or renames made outside the editor lose the marks for the old path. Renames inside the editor are followed.

## Storage

Marks are saved as JSON in `.vscode/patina.json`, with one line per run of marks. The first time the file is created in a git repo, Patina offers to add it to `.git/info/exclude` (private) or to `.gitignore`.

## Development

```sh
npm install
npm test                  # unit tests for fingerprinting, re-anchoring, edit tracking, storage
npm run test:integration  # spec scenarios in a real VS Code extension host (opens a window; uses VS Code.app, or set VSCODE_PATH)
npm run package           # builds patina-<version>.vsix
```

To run Patina, open this folder in Cursor and press **F5** to launch an Extension Development Host. To install it permanently, run `cursor --install-extension patina-0.1.0.vsix`.

Manual scenarios from the spec, to check in the dev host:

1. Mark some lines, reload the window: the marks persist.
2. Type inside a marked range: it stays fresh.
3. `git checkout` a different version of the file: changed lines go stale.
4. `sed -i '' 's/foo/bar/' file` from the terminal: the changed lines go stale.
5. Insert lines above a mark: the mark moves with its line, whether you insert them in the editor or externally.
6. Close the editor, change the file externally, reopen it: stale.

The Patina output channel logs every stale detection and its cause.
