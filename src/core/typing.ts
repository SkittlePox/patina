import { EditChange } from './marks';

/** An inclusive range of lines. */
export interface LineSpan {
  start: number;
  end: number;
}

/**
 * Whether an edit looks typed: every change touches a line holding a cursor or selection. Typing, paste,
 * delete, autocomplete and multi-cursor edits all happen at the cursors; rename, formatting, quick fixes
 * and similar tool edits change lines elsewhere.
 *
 * A change counts as touching the lines it replaced and the lines its inserted text occupies, so this holds
 * whether `cursors` reflect selections from just before or just after the edit.
 */
export function isAtCursors(changes: readonly EditChange[], cursors: readonly LineSpan[]): boolean {
  return (
    changes.length > 0 &&
    changes.every((c) => {
      const lo = c.startLine;
      const hi = Math.max(c.endLine, c.startLine + c.insertedLineBreaks);
      return cursors.some((s) => s.start <= hi && s.end >= lo);
    })
  );
}

/**
 * Lines occupied by the inserted text of each change once the whole event has been applied.
 * Changes are applied sequentially, each in the coordinates left by the previous ones.
 */
export function changedSpans(changes: readonly EditChange[]): LineSpan[] {
  let spans: LineSpan[] = [];
  for (const c of changes) {
    const lo = c.startLine;
    const hi = c.endLine;
    const delta = c.insertedLineBreaks - (hi - lo);
    const added: LineSpan = { start: lo, end: lo + c.insertedLineBreaks };
    const next: LineSpan[] = [];
    for (const s of spans) {
      if (s.start > hi) next.push({ start: s.start + delta, end: s.end + delta });
      else if (s.end < lo) next.push(s);
      else {
        // Overlaps this change: fold into it, keeping any tail that sat below the replaced range.
        added.start = Math.min(added.start, s.start);
        if (s.end > hi) added.end = Math.max(added.end, s.end + delta);
      }
    }
    next.push(added);
    spans = next;
  }
  return spans.sort((a, b) => a.start - b.start);
}
