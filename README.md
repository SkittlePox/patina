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
  "next":     { "label": "Attend to next" },
  "question": { "label": "Question" },
  "todo":     { "label": "Todo" }
}
```

```jsonc
// keybindings.json
{ "key": "ctrl+alt+t", "command": "patina.mark", "args": { "category": "todo" }, "when": "editorTextFocus" }
```

Categories without colors take them from the palette. Custom categories get the palette's extra colors in order.

## Colors

Pick a built-in palette with `patina.palette`:

| Palette | |
| --- | --- |
| `default` | Green → yellow → gray for read, red for stale, blue/purple categories |
| `muted` | Soft, low-contrast tones |
| `vivid` | Saturated, high-contrast colors |
| `colorblind` | Okabe–Ito colors: blue → sky → gray for read, vermillion for stale, no red/green distinctions |

Each palette has two sets of colors: translucent ones for line backgrounds and stronger ones for gutter bars. To use your own colors, set any of the settings below; each one you set overrides the palette, and the rest still come from it. Colors can be any CSS color, such as `rgba(r, g, b, a)` or `#rrggbbaa`.

```jsonc
// settings.json
"patina.palette": "muted",
"patina.read.fadeColors": ["rgba(46, 160, 67, 0.22)", "rgba(210, 180, 40, 0.18)", "rgba(128, 128, 128, 0.12)"],
"patina.read.gutterFadeColors": ["rgba(46, 160, 67, 1)", "rgba(210, 180, 40, 0.8)", "rgba(128, 128, 128, 0.5)"],
"patina.stale.color": "rgba(230, 60, 60, 0.28)",
"patina.stale.gutterColor": "#e63c3c",
"patina.categories": {
  "next": { "label": "Attend to next", "color": "rgba(64, 140, 255, 0.22)", "gutterColor": "rgba(64, 140, 255, 0.9)" }
}
```

If you set a background color but not its gutter version, the gutter uses a more opaque version of the background color.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `patina.palette` | `default` | Built-in palette; see [Colors](#colors) |
| `patina.highlightStyle` | `background` | `background`: tint the line. `gutter`: colored bar just left of the line numbers. `gutterAndBackground`: both |
| `patina.categories` | `next`, `question` | Static categories: label, optional `color` and `gutterColor` |
| `patina.read.label` | `Read` | |
| `patina.read.fadeDays` | `30` | How long a read mark takes to fully fade |
| `patina.read.fadeColors` | from palette | Background fade stops, evenly spaced over the fade duration |
| `patina.read.gutterFadeColors` | from palette | Gutter fade stops |
| `patina.stale.color` | from palette | Background for stale lines |
| `patina.stale.gutterColor` | from palette | Gutter bar for stale lines |
| `patina.showCursorLineAnnotation` | `false` | Faint end-of-line note on the cursor line |
| `patina.showInOverviewRuler` | `true` | Show marks in the scrollbar |
| `patina.explorer.enabled` | `true` | |
| `patina.storageFile` | `.vscode/patina.json` | Relative to each workspace folder |

The gutter bar shares its column with breakpoints and other extensions' gutter icons, and needs `editor.glyphMargin` turned on (it is by default). There's no left-edge stripe option: extensions can only draw on the code layer, so a stripe would cover the first character of each line.

Explorer colors are theme colors. You can override `patina.explorerFresh`, `patina.explorerAging`, `patina.explorerOld`, `patina.explorerStale` and `patina.annotationForeground` in `workbench.colorCustomizations`.

## How change detection works

Each marked line stores a fingerprint of its own text and a fingerprint of the lines around it.

- **Edits inside the editor** are split into two kinds:
  - **Typed by you.** These are in the active editor, and every change is on a line with a cursor or selection: typing, paste, delete, autocomplete, multi-cursor. Every line whose text you change, or that you add, becomes **read, dated now**, whatever it was before: unmarked, next, question, or stale. Lines whose text stays the same keep their marks. For example, deleting a block or a line break doesn't re-date the line above it. To tell which lines changed, Patina keeps a 4-byte fingerprint per line of the active file only.
  - **Tool edits.** These are rename symbol, formatting (including format-on-save), quick fixes, Replace All, edits in files other than the active one, and undo/redo. Marks follow their lines and are re-fingerprinted, so they don't go stale. They keep their category and date.
- **The first edit after you open or save a file** reaches the extension before the editor reports the file as dirty. Patina applies it as an in-editor edit and confirms it once the dirty notice arrives. If the file is still clean after a second, the change was a reload from disk, and Patina treats it as foreign.
- **Foreign changes.** These are detected in two ways. A clean open document that VS Code reloads from disk fires a change event and stays clean. A file that isn't open (or is open and clean) gets a file-watcher event, and Patina validates it against the disk content.
- **Validation** re-anchors marks by content. It first anchors lines whose content is unique, then matches repeated lines (`}`, blank lines) by position and context, in order. Marks that can't be found go stale at their old position. If a fully marked block is rewritten, the whole new block goes stale. If marked lines are deleted outright, the neighbouring mark goes stale and its hover says how many lines were removed.
- **On activation and on file open**, every mark is validated, so changes made while the editor wasn't watching count as foreign.

The invariant: a line changed by a foreign edit is never shown as freshly read.

**Known fuzzy cases (v1):**
- Typed vs tool is decided by where the edit lands. A tool edit that only touches the cursor's line, such as a formatter fixing just that line, counts as typed. Claude Code edits go stale, whether Claude runs in a terminal or through the Claude Code extension. In both cases Claude Code writes the file to disk, which counts as a change from outside the editor. (In the extension, the proposed change sits in a temporary diff document until you accept it.) Edits that are applied directly to the editor's in-memory copy of the file, as Cursor's own AI features may do, count as tool edits: dates kept, not stale.
- If Claude writes a file while you have unsaved edits to it, the editor keeps your version and doesn't reload. Patina sees Claude's change only if you then take the version on disk.
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
