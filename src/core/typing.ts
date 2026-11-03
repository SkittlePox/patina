import { hashLineInt } from './hash';
import { EditChange, LineSource } from './marks';

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

/**
 * Fingerprints of every line of one document, kept in sync with its edits, so a typed edit can tell which
 * lines' content actually changed (as opposed to shifting, or merging back unchanged when a line break or a
 * block of lines is deleted). Stored as 32-bit integers in a packed array: 4 bytes per line.
 */
export class DocShadow {
  private h: Uint32Array;
  private n: number;

  constructor(src: LineSource) {
    this.n = src.lineCount;
    this.h = new Uint32Array(Math.max(64, Math.ceil(this.n * 1.25)));
    for (let i = 0; i < this.n; i++) this.h[i] = hashLineInt(src.lineAt(i));
  }

  get lineCount(): number {
    return this.n;
  }

  /**
   * Apply an event's changes (`src` is the document afterwards). Returns the post-change lines whose content
   * is new or different. Single changes are compared line by line; for multi-change events every line in the
   * changed spans is returned.
   */
  apply(changes: readonly EditChange[], src: LineSource): number[] {
    if (changes.length === 1) {
      const c = changes[0];
      const old = Array.from(this.h.subarray(c.startLine, Math.min(c.endLine + 1, this.n)));
      const fresh: number[] = [];
      for (let j = 0; j <= c.insertedLineBreaks; j++) fresh.push(lineHash(src, c.startLine + j));
      this.splice(c.startLine, c.endLine, fresh);
      if (this.n !== src.lineCount) return this.resync(changes, src);
      let p = 0;
      while (p < old.length && p < fresh.length && old[p] === fresh[p]) p++;
      let s = 0;
      while (s < old.length - p && s < fresh.length - p && old[old.length - 1 - s] === fresh[fresh.length - 1 - s]) s++;
      const out: number[] = [];
      for (let j = p; j < fresh.length - s; j++) out.push(c.startLine + j);
      return out;
    }
    for (const c of changes) this.splice(c.startLine, c.endLine, new Array<number>(c.insertedLineBreaks + 1).fill(0));
    if (this.n !== src.lineCount) return this.resync(changes, src);
    const out: number[] = [];
    for (const span of changedSpans(changes)) {
      for (let i = span.start; i <= span.end && i < src.lineCount; i++) {
        this.h[i] = lineHash(src, i);
        out.push(i);
      }
    }
    return out;
  }

  /** Out of sync (shouldn't happen): rebuild, and treat the changed spans as changed. */
  private resync(changes: readonly EditChange[], src: LineSource): number[] {
    const fresh = new DocShadow(src);
    this.h = fresh.h;
    this.n = fresh.n;
    const out: number[] = [];
    for (const span of changedSpans(changes)) for (let i = span.start; i <= span.end && i < src.lineCount; i++) out.push(i);
    return out;
  }

  /** Replace lines [start, end] with `items`, shifting the rest in place. */
  private splice(start: number, end: number, items: number[]): void {
    end = Math.min(end, this.n - 1);
    const newN = this.n + items.length - (end - start + 1);
    if (newN > this.h.length) {
      const grown = new Uint32Array(Math.max(newN, this.h.length * 2));
      grown.set(this.h.subarray(0, this.n));
      this.h = grown;
    }
    this.h.copyWithin(start + items.length, end + 1, this.n);
    this.h.set(items, start);
    this.n = newN;
  }
}

function lineHash(src: LineSource, i: number): number {
  return i < src.lineCount ? hashLineInt(src.lineAt(i)) : 0;
}
