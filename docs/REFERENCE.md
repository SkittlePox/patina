# Patina reference

- [Commands](#commands)
- [Marks](#marks)
- [Categories and keybindings](#categories-and-keybindings)
- [Colors](#colors)
- [Settings](#settings)
- [What gets tracked](#what-gets-tracked)
- [How change detection works](#how-change-detection-works)
- [Known limitations](#known-limitations)
- [Storage](#storage)
- [Development](#development)

## Commands

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

The editor's right-click menu has a **Patina** submenu with the same actions.

## Marks

- Each line holds one mark, so marking a line again replaces its mark.
- Re-marking also clears stale state. That's how you acknowledge a change once you've reread it.
- **Read** marks fade over `patina.read.fadeDays`. Other categories keep a fixed color.
- Lines you type on become read, dated now. Their hover and end-of-line note say **Edited** instead of **Read**. Marking such a line explicitly turns it back into Read.
- **Hover** a marked line to see its category, when it was marked and how far it has faded. If it's stale, the hover also says when the change was detected.
- **Explorer badges:**
  - `✓` means the whole file is read.
  - `!` means it has stale lines.

  Badges use the normal text color, and file names aren't recolored, so git's colors stay unambiguous. Hover a file to see its read percentage and how long ago it was read on average.
- **Marking a folder** skips files excluded by `files.exclude`, `search.exclude` or `patina.exclude`. It also skips binary files and files over 5 MB.

## Categories and keybindings

```jsonc
// settings.json
"patina.categories": {
  "next":     { "label": "Attend to next" },
  "question": { "label": "Question" },
  "todo":     { "label": "Todo", "color": "rgba(255, 150, 0, 0.22)" }
}
```

```jsonc
// keybindings.json
{ "key": "ctrl+alt+t", "command": "patina.mark", "args": { "category": "todo" }, "when": "editorTextFocus" }
```

Categories without colors take them from the palette. Custom categories get the palette's extra colors in order.

## Colors

| `patina.palette` | |
| --- | --- |
| `default` | Green → yellow → gray for read, red for stale, blue/purple categories |
| `muted` | Soft, low-contrast tones |
| `supermuted` | Barely-there tints, close to gray |
| `vivid` | Saturated, high-contrast colors |
| `colorblind` | Okabe–Ito colors: blue → sky → gray for read, vermillion for stale, no red/green distinctions |

**Two sets per palette:** translucent colors for line backgrounds, and stronger ones for gutter bars.

**Your own colors:** any color setting you set overrides the palette, and the rest still come from it. Colors can be any CSS color, such as `rgba(r, g, b, a)` or `#rrggbbaa`.

```jsonc
"patina.palette": "muted",
"patina.read.fadeColors": ["rgba(46, 160, 67, 0.22)", "rgba(210, 180, 40, 0.18)", "rgba(128, 128, 128, 0.12)"],
"patina.read.gutterFadeColors": ["rgba(46, 160, 67, 1)", "rgba(210, 180, 40, 0.8)", "rgba(128, 128, 128, 0.5)"],
"patina.stale.color": "rgba(230, 60, 60, 0.28)",
"patina.stale.gutterColor": "#e63c3c",
"patina.categories": {
  "next": { "label": "Attend to next", "color": "rgba(64, 140, 255, 0.22)", "gutterColor": "rgba(64, 140, 255, 0.9)" }
}
```

**Gutter fallback:** if you set a background color but not its gutter version, the gutter uses a more opaque version of the background color.

**Gutter bar placement:** the bar shares its column with breakpoints and other extensions' gutter icons, and needs `editor.glyphMargin` turned on (it is by default). There's no left-edge stripe option: extensions can only draw on the code layer, so a stripe would cover the first character of each line.

## Folded blocks

When you fold a block, the end of its first line shows a summary of the marks inside it, for example:

```
Contents: 60% read · avg 3h ago · 14 lines edited, most recently 1h ago · 2 Question
```

The summary replaces the first line's own cursor-line note. Blocks that hide fewer than `patina.foldSummary.minLines` lines (default 5), such as a folded argument list, get no summary and no blended highlight.

Folded parameter lists of function and method definitions are skipped too, whatever their size. Turn on `patina.foldSummary.parameterLists` to summarize them. A fold counts as a parameter list when its first line ends inside an open `(` and the language reports a function, method or constructor named on that line. That excludes folded call arguments, but it needs the language's extension to provide document symbols (Python, TypeScript and most others do). Set `patina.foldSummary.show` to `cursorLine` to show summaries only on the cursor line, or `off` to hide them. Summaries appear only in files Patina tracks.

The text comes from `patina.foldSummary.format`, a list of segments joined with ` · `. A segment is left out when any placeholder in it has nothing to report (a count of zero, or an age with no lines to measure):

```jsonc
"patina.foldSummary.format": [
  "Contents: {readPercent}% read",
  "avg {readAge} ago",
  "{edited:line} edited, most recently {editedNewest} ago",
  "{categories}",
  "⚠ {stale} changed outside editor"
]
```

| Placeholder | |
| --- | --- |
| `{lines}`, `{read}`, `{unread}`, `{readPercent}` | Non-blank lines, read lines (including lines you typed on), unread lines, read percentage |
| `{readAge}`, `{readNewest}`, `{readOldest}` | Average, most recent and oldest read age (`5m`, `3h`, `2d`) |
| `{edited}`, `{editedAge}`, `{editedNewest}` | Lines you typed on, their average and most recent age |
| `{stale}`, `{staleNewest}` | Lines changed outside the editor, most recent detection age |
| `{categories}` | Per-category counts, such as `2 Question, 1 Attend to next` |
| `{cat.<id>}` | Count for one category, such as `{cat.question}` |

`{name:word}` on a count adds a pluralised word: `{edited:line}` gives `1 line` or `14 lines`.

**Highlight:** while a block is folded, its first line takes the average color of all non-blank lines in the block, the first line included. Read lines add their fade color, stale lines the stale color, category lines their category color, and unmarked lines nothing. So a mostly unread block gets a faint tint. Each stale line counts as `patina.foldSummary.staleWeight` lines (default 10), so even a few stale lines make the folded line stand out. Turn this off with `patina.foldSummary.highlight`. Set `"editor.foldingHighlight": false` too, or the editor's own tint on folded lines covers this color.

Clicking the summary unfolds the block, just like clicking the editor's `⋯`.

Patina detects folds from the editor's visible lines, so it updates as you fold, unfold and scroll. A block folded right at the bottom edge of the window gets its summary once the line after it scrolls into view.

## Cursor-line note

With `patina.showCursorLineAnnotation` on, the cursor line shows a faint note about its mark. Turn on `patina.showStaleAnnotations` to show the note on every stale line, wherever the cursor is. `patina.cursorLineAnnotation.format` sets the text for each kind of mark. Missing keys keep their defaults, and an empty string hides the note for that kind:

```jsonc
"patina.cursorLineAnnotation.format": {
  "read": "{label} · {age} ago",
  "edited": "{label} · {age} ago",
  "stale": "⚠ changed outside editor {staleAge} ago · was {label} · {age} ago",
  "category": "{label} · {age} ago",
  "question": "❓ {date}"   // a category id gives that category its own text
}
```

Each value is a string, or a list of segments joined with ` · `, using the same rules as the folded-block summary. A segment is left out when any placeholder in it has nothing to report. For example, `["⚠ changed {staleAge} ago", "{removed:line} deleted nearby"]` mentions deleted lines only when there are some.

| Placeholder | |
| --- | --- |
| `{label}` | The mark's label, such as `Read`, `Edited` or `Question` |
| `{age}`, `{date}` | When the line was marked (`5h`, `2026-11-04 14:30`) |
| `{faded}` | How far a read mark has faded, in percent |
| `{staleAge}`, `{staleDate}` | When the change outside the editor was detected (stale only) |
| `{removed}` | Marked lines deleted next to this one outside the editor (stale only) |

The end-of-line note uses the theme color `patina.annotationForeground`, which you can override in `workbench.colorCustomizations`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `patina.palette` | `default` | Built-in palette |
| `patina.highlightStyle` | `background` | `background`: tint the line. `gutter`: bar left of the line numbers. `gutterAndBackground`: both |
| `patina.categories` | `next`, `question` | Static categories: label, optional `color` and `gutterColor` |
| `patina.read.label` | `Read` | |
| `patina.read.fadeDays` | `30` | How long a read mark takes to fully fade |
| `patina.read.fadeColors` | from palette | Background fade stops, evenly spaced over the fade duration |
| `patina.read.gutterFadeColors` | from palette | Gutter fade stops |
| `patina.stale.color` | from palette | Background for stale lines |
| `patina.stale.gutterColor` | from palette | Gutter bar for stale lines |
| `patina.showCursorLineAnnotation` | `false` | Faint end-of-line note on the cursor line |
| `patina.showStaleAnnotations` | `false` | Show the note on every stale line, not just the cursor line |
| `patina.cursorLineAnnotation.format` | see [Cursor-line note](#cursor-line-note) | Text of that note for each kind of mark |
| `patina.foldSummary.show` | `always` | Summary of a folded block's marks on its first line: `always`, `cursorLine` or `off` |
| `patina.foldSummary.format` | see [Folded blocks](#folded-blocks) | Segments of that summary, with placeholders |
| `patina.foldSummary.highlight` | `true` | Tint a folded block's first line with the average color of its lines |
| `patina.foldSummary.minLines` | `5` | Smaller folded blocks get no summary or blended highlight |
| `patina.foldSummary.parameterLists` | `false` | Also summarize folded parameter lists of function definitions |
| `patina.foldSummary.staleWeight` | `10` | How many lines each stale line counts as in the blended highlight |
| `patina.showInOverviewRuler` | `true` | Show marks in the scrollbar |
| `patina.explorer.enabled` | `true` | |
| `patina.exclude` | `[]` | Glob patterns for files and folders never to track |
| `patina.storageFile` | `.vscode/patina.json` | Relative to each workspace folder |

## What gets tracked

Patina tracks a file only once it has marks. A file gets marks when:
- you mark lines or the whole file
- you type in it
- you mark a folder that contains it

Opening and reading a file never creates marks. Neither does an agent or any other process creating or rewriting a file; those changes only affect marks that already exist.

To keep generated files out entirely, list them in `patina.exclude`, ideally in the workspace's `.vscode/settings.json`:

```jsonc
"patina.exclude": ["logs", "**/*.log", "tmp/debug", "**/__pycache__"]
```

**Pattern syntax:**
- Patterns are relative to the workspace folder.
- `*` matches within one path segment, and `**` matches across segments.
- `{a,b}` and `[0-9]` also work.
- A pattern that matches a folder excludes everything inside it.
- A bare name like `logs` matches only at the top level. Use `**/logs` for any depth.

**Effect:** excluded files never get marks from typing, mark commands or folder marking. Marks they already have are hidden but kept, so they come back if you remove the pattern.

## How change detection works

Each marked line stores a fingerprint of its own text and a fingerprint of the lines around it. Every change is classified as one of three kinds.

**Typed by you.** The edit is in the active editor, and every change is on a line with a cursor or selection. That covers typing, paste, delete, autocomplete and multi-cursor edits.
- Every line whose text you change, or that you add, becomes read, dated now, and is labeled Edited.
- Lines whose text stays the same keep their marks. For example, deleting a block or a line break doesn't re-date the line above it.
- To tell which lines changed, Patina keeps a 4-byte fingerprint per line of the active file only, rebuilt when you switch files.

**Tool edits.** These are:
- rename symbol
- formatting, including format-on-save
- quick fixes
- Replace All
- edits in files other than the active one
- undo and redo

Marks follow their lines and are re-fingerprinted. They keep their category and date and don't go stale.

**Foreign changes.** These come from outside the editor: agents, `git`, scripts. Patina detects them in two ways:
- A clean open document that the editor reloads from disk fires a change event and stays clean.
- A file that isn't open, or is open and clean, gets a file-watcher event, and Patina validates it against its content.

**Lines that can't be found** in the new content go stale.

**Validation** re-anchors marks by content:
1. It anchors lines whose content is unique.
2. It matches repeated lines, like `}` and blank lines, by position and context, in order.
3. Marks that still can't be found go stale at their old position.
4. If a fully marked block is rewritten, the whole new block goes stale.
5. If marked lines are deleted outright, the neighboring mark goes stale, and its hover says how many lines were removed.

Every mark is validated on activation and when a file is opened, so changes made while the editor wasn't watching count as foreign.

**The first edit after you open or save a file** reaches the extension before the editor reports the file as dirty. Patina applies it as an in-editor edit and confirms it once the dirty notice arrives. If the file is still clean after a second, the change was a reload from disk, and Patina treats it as foreign.

The invariant: a line changed by a foreign edit is never shown as freshly read.

## Known limitations

- **Typed vs tool depends on where the edit lands.** A tool edit that only touches the cursor's line, such as a formatter fixing just that line, counts as typed.
- **Claude Code edits are foreign changes,** whether Claude runs in a terminal or through the Claude Code extension. In both cases Claude Code writes the file to disk. In the extension, the proposed change sits in a temporary diff document until you accept it.
- **Some AI edits count as tool edits.** Edits applied directly to the editor's in-memory copy of a file, as Cursor's own AI features may do, keep their dates and don't go stale.
- **Unsaved edits block disk changes.** If an agent writes a file while you have unsaved edits to it, the editor keeps your version and doesn't reload. Patina sees the agent's change only if you then take the version on disk.
- **Closing without saving.** If you edit a file and close it without saving, your typed changes look foreign on the next open, so those lines go stale.
- **Encodings.** Closed files are checked by decoding their bytes as UTF-8. A file in another encoding with non-ASCII characters may show false stale lines.
- **Renames outside the editor.** `git mv` or renames made outside the editor lose the marks for the old path. Renames inside the editor are followed.
- **Multi-cursor edits** mark every line they touch as read. The changed-content check only applies to single edits.

## Storage

Marks are saved as JSON in `.vscode/patina.json`, with one line per run of marks. The first time the file is created in a git repo, Patina offers to add it to `.git/info/exclude` (private) or to `.gitignore`.

## Development

```sh
npm install
npm test                  # unit tests: fingerprinting, re-anchoring, edit tracking, storage, palettes, globs
npm run test:integration  # scenarios in a real VS Code extension host (opens a window; uses VS Code.app, or set VSCODE_PATH)
npm run package           # builds patina-<version>.vsix
```

To try changes, open this folder in Cursor or VS Code and press **F5** to launch an Extension Development Host. The Patina output channel logs every stale detection and its cause.

Manual scenarios:

1. Mark some lines and reload the window. The marks persist.
2. Type inside a read block. The lines you change become Edited, dated now. The rest keep their dates.
3. `git checkout` a different version of a file. The changed lines go stale.
4. Run `sed -i '' 's/foo/bar/' file` from the terminal. The changed lines go stale.
5. Insert lines above a mark, in the editor or externally. The mark moves with its line.
6. Close the editor, change the file externally and reopen it. The changed lines are stale.
7. Rename a symbol with `F2`. Marks keep their dates and don't go stale.
