# Patina — Cursor/VS Code extension spec (v1)

Extension name: **Patina** (id `patina`, commands prefixed `patina.`, settings under `patina.*`).

Handoff brief for Claude Code. Build a VS Code extension (runs in Cursor) that helps me thoroughly read a whole codebase by tracking which lines I've read, when, and whether they've changed since.

## Core concepts

- **Mark**: a record attached to a range of lines: category, timestamp, and a content fingerprint (hash of each line's text plus a little surrounding context) so it can be re-anchored and validated.
- **Categories**: `read` (special: its color fades with age) plus user-defined static categories (default: `next` = "attend to next", `question`). Each category has a configurable color and its own keybinding.
- **Stale**: a mark whose underlying text was changed by something other than me typing in the editor. Stale marks render red.

## Features (v1)

1. **Mark lines**: select lines, press a shortcut → whole-line background highlight (`isWholeLine` decorations). Separate shortcuts per category, plus a shortcut to clear marks in the selection.
2. **Fading read highlight**: `read` marks interpolate green → yellow → dull gray as they age. Full fade duration is a setting (default 30 days). **Red is reserved for stale marks** (I may still change this; keep colors fully configurable).
3. **Hover info**: hovering anywhere on a marked line shows category, exact date/time marked, relative age, and if stale, that it changed and roughly when it was detected. (Gutter/line-number hover isn't supported by the API.) Optionally a faint end-of-line annotation on the cursor line.
4. **Mark whole files**: command + explorer context menu marks every line in the file (so per-line staleness still works). Also works on folders.
5. **Explorer decorations**: `FileDecorationProvider` badge/color per file showing read coverage and freshness, and flagging files with stale marks.
6. **Change detection / attribution**:
   - Edits typed in the editor by me → silently re-fingerprint the affected marks; they stay fresh.
   - Changes arriving from disk (Claude Code writing files, git checkout/pull/rebase, any external process) → affected marks become stale.
   - On file open / extension activation, validate every mark against current content via fingerprints; any mismatch made while the editor wasn't watching is treated as foreign → stale.
   - Re-anchoring is content-based: if lines moved (insertions above, etc.), relocate marks by fingerprint rather than invalidating them. Invariant: never show a line as freshly read if its content changed via a foreign edit.
   - Known fuzzy cases: format-on-save counts as "mine" (fine); edits applied through the Claude Code VS Code extension's diff view may look like mine — acceptable for v1.
7. **Settings**: category colors, fade duration, fade endpoint colors, stale color, whether to show end-of-line annotations, keybindings.
8. **Storage**: JSON in `.vscode/patina.json` (or similar), private by default; suggest adding to `.gitignore`.

## Out of scope for v1

- Claude Code PostToolUse hook that logs exact edited files/lines for precise attribution (planned v2).
- Coverage reports / dashboards.

## Testing

Use the Extension Development Host (F5) in Cursor. Scenarios to verify: mark → reload window → marks persist; type edits inside a marked range → stays fresh; `git checkout` a different version of a file → marks go stale; edit file from terminal (`sed -i`) → stale; insert lines above a mark → mark moves with its line; close editor, change file externally, reopen → stale.

## Decisions

- Target editor: Cursor (VS Code extension API).
- Claude Code is used both in terminal and via the VS Code extension.
