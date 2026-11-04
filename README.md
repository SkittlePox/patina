# Patina

Patina is an extension for VS Code and Cursor. It highlights the code you've read and shows you what has changed since.

> **Media to make: `docs/media/reading.gif`** (GIF, about 8 s)
> Open a real source file in a project you know. Turn on `patina.showCursorLineAnnotation`.
> 1. Select a function and press `ctrl+alt+r`. It turns green.
> 2. Select the next block and mark it too.
> 3. Hover a marked line to show the "Read · Marked … (just now)" tooltip.
> 4. Scroll down slowly so the green marks are visible in the scrollbar.
>
> Keep the cursor movements slow and deliberate.

Select some lines and press `ctrl+alt+r`. They turn green and fade to gray over the following weeks. Hover a line to see when you read it.

If a line you've read changes outside your editor, it turns red until you read it again. That covers an agent's edit, a `git pull` or a script. Lines you write yourself are marked as you type.

## Working alongside an agent

> **Media to make: `docs/media/agent-edit.gif`** (GIF, about 12 s)
> Split the screen: the editor on the left with a fully read (green) function, and Claude Code in a terminal on the right.
> 1. Ask Claude to change something small inside that function, and accept the edit.
> 2. About a second later, only the changed lines turn red.
> 3. Hover a red line to show "Stale: this line changed outside the editor."
> 4. Read it, select it and press `ctrl+alt+r`. It's green again.
>
> Optional ending: rename a symbol with `F2` inside a green block. The block stays green.

Claude Code or any other tool can work in the files you're reading. Whatever it changes shows up in red, line by line. Renames and formatting don't.

You can exclude logs, build output and other generated files so they're never tracked.

## At a glance

> **Media to make: `docs/media/explorer.png`** (screenshot)
> The file explorer, plus a sliver of the editor. Include:
> - a few files marked `✓` (fully read)
> - one file marked `!` (changed since you read it)
> - ideally a git-modified file nearby, to show the two don't clash
>
> Use a project with a recognizable folder structure.

In the explorer, `✓` marks files you've read in full and `!` marks files that changed since.

> **Media to make: `docs/media/fade.png`** (screenshot)
> One file with blocks read at different times: fresh green, then yellow, then gray.
> To stage it, temporarily set `"patina.read.fadeDays": 0.005` (about 7 minutes), mark a block every couple of minutes, take the screenshot, then remove the setting.

## Other marks

Press `ctrl+alt+n` to mark lines to come back to, and `ctrl+alt+q` for a question. You can add your own categories, each with a color and a key.

## Colors

> **Media to make: `docs/media/palettes.png`** (screenshot, grid of five)
> The same 15–20 line snippet under each palette: `default`, `muted`, `supermuted`, `vivid`, `colorblind`. Each copy should have read lines of a few ages, one red (stale) line, and one `next` and one `question` line. Label each quadrant.

There are five built-in palettes, from barely-there to vivid, including a colorblind-safe one, and you can set your own color for any mark. Patina can tint the whole line or draw a bar beside the line numbers.

> **Media to make: `docs/media/gutter.png`** (screenshot)
> The same snippet side by side: `"patina.highlightStyle": "background"` on the left and `"gutter"` on the right.

## Install

```sh
git clone https://github.com/SkittlePox/patina && cd patina
npm install && npm run package
cursor --install-extension patina-*.vsix    # or: code --install-extension …
```

## Keys

| | |
| --- | --- |
| `ctrl+alt+r` | Mark as read |
| `ctrl+alt+n` | Mark to come back to |
| `ctrl+alt+q` | Mark as a question |
| `ctrl+alt+u` | Clear marks |

To mark a whole file or folder, right-click it in the explorer and choose **Patina**.

Marks are saved in your project's `.vscode/patina.json`. They don't leave your machine unless you commit that file.

## Recommended settings

```jsonc
// The editor's own folding highlight tints folded lines and hides Patina's color for the folded block.
"editor.foldingHighlight": false
```

Settings, commands and how change detection works are covered in [docs/REFERENCE.md](docs/REFERENCE.md).
