import { contextHash, hashLine } from './hash';

export const READ = 'read';

export interface LineMark {
  /** Category id (`read` or a user-defined static category). */
  cat: string;
  /** When the line was marked (epoch ms). */
  t: number;
  /** Fingerprint of the line's text, kept in sync with the user's own edits. */
  h: string;
  /** Fingerprint of the neighbouring lines' text, used to disambiguate re-anchoring. */
  c: string;
  /** Set when the line's content was changed by something other than the user typing (epoch ms of detection). */
  stale?: number;
  /** Number of marked lines next to this one that were deleted by a foreign change. */
  removed?: number;
  /** A read mark created by the user's own typing rather than by marking the line explicitly. */
  edited?: boolean;
}

/** Read access to a document's lines. */
export interface LineSource {
  readonly lineCount: number;
  lineAt(line: number): string;
}

export function linesFromText(text: string): LineSource {
  const lines = text.split(/\r\n|\r|\n/);
  return { lineCount: lines.length, lineAt: (i) => lines[i] };
}

/** One replaced range, in document coordinates at the time it was applied (VS Code's sequential semantics). */
export interface EditChange {
  startLine: number;
  endLine: number;
  /** Number of line breaks in the inserted text. */
  insertedLineBreaks: number;
}

export interface FileStats {
  /** Non-blank lines in the file. */
  lines: number;
  /** Non-blank lines carrying a fresh (non-stale) read mark. */
  read: number;
  /** Lines with any mark, blank lines only if stale. */
  marked: number;
  /** Stale lines. */
  stale: number;
  /** Mean age (ms) of fresh read marks, or undefined if none. */
  meanReadAge?: number;
}

export interface ValidateResult {
  changed: boolean;
  /** Lines that became stale (or gained a removed-lines note) during this validation. */
  newlyStale: number;
}

function clone(m: LineMark): LineMark {
  return { ...m };
}

function ctxAt(src: LineSource, i: number): string {
  return contextHash(i > 0 ? src.lineAt(i - 1) : undefined, i + 1 < src.lineCount ? src.lineAt(i + 1) : undefined);
}

/** Marks for one file, indexed by line. */
export class FileMarks {
  /** Sparse: `lines[i]` is the mark on line i, if any. May be shorter or (transiently) longer than the document. */
  lines: (LineMark | undefined)[] = [];

  get(line: number): LineMark | undefined {
    return line >= 0 ? this.lines[line] : undefined;
  }

  get isEmpty(): boolean {
    return !this.lines.some((m) => m !== undefined);
  }

  *entries(): IterableIterator<[number, LineMark]> {
    for (let i = 0; i < this.lines.length; i++) {
      const m = this.lines[i];
      if (m) yield [i, m];
    }
  }

  /** Mark lines [start, end] with a category. Replaces existing marks and clears stale state. */
  mark(start: number, end: number, cat: string, now: number, src: LineSource): void {
    end = Math.min(end, src.lineCount - 1);
    for (let i = Math.max(0, start); i <= end; i++) {
      this.lines[i] = { cat, t: now, h: hashLine(src.lineAt(i)), c: ctxAt(src, i) };
    }
  }

  /** Lines the user typed on become read, timestamped now, whatever they were before (unmarked, any category, stale). */
  markTyped(start: number, end: number, now: number, src: LineSource): void {
    end = Math.min(end, src.lineCount - 1);
    for (let i = Math.max(0, start); i <= end; i++) {
      this.lines[i] = { cat: READ, t: now, h: hashLine(src.lineAt(i)), c: ctxAt(src, i), edited: true };
    }
  }

  clear(start: number, end: number): void {
    for (let i = Math.max(0, start); i <= end && i < this.lines.length; i++) this.lines[i] = undefined;
    this.trim();
  }

  private trim(): void {
    let n = this.lines.length;
    while (n > 0 && this.lines[n - 1] === undefined) n--;
    this.lines.length = n;
  }

  private replaceRegion(start: number, end: number, region: (LineMark | undefined)[]): void {
    if (this.lines.length <= end) this.lines.length = end + 1;
    const tail = this.lines.slice(end + 1);
    this.lines.length = start;
    for (const m of region) this.lines.push(m);
    for (const m of tail) this.lines.push(m);
    this.trim();
  }

  /** Re-fingerprint marks on lines [start, end] against the current text. */
  private rehash(start: number, end: number, src: LineSource): void {
    if (this.lines.length > src.lineCount) this.lines.length = src.lineCount;
    const last = Math.min(end, this.lines.length - 1);
    for (let i = Math.max(0, start); i <= last; i++) {
      const m = this.lines[i];
      if (!m) continue;
      m.h = hashLine(src.lineAt(i));
      m.c = ctxAt(src, i);
    }
    this.trim();
  }

  /**
   * Apply edits made inside the editor (typed or by a tool). Marks follow their lines and are silently
   * re-fingerprinted, keeping their category and date. `src` is the document after all changes were applied.
   */
  applyUserEdits(changes: readonly EditChange[], src: LineSource): void {
    if (this.lines.length === 0) return;
    if (changes.length === 1) {
      this.applySingleEdit(changes[0], src);
      return;
    }
    // Multiple changes (multi-cursor etc.): positional mapping, then re-fingerprint everything.
    for (const ch of changes) {
      if (ch.startLine >= this.lines.length) continue;
      const old = this.lines.slice(ch.startLine, ch.endLine + 1);
      const region: (LineMark | undefined)[] = [];
      for (let j = 0; j <= ch.insertedLineBreaks; j++) {
        const o = j < old.length ? old[j] : old[old.length - 1];
        region.push(o && j >= old.length ? clone(o) : o);
      }
      this.replaceRegion(ch.startLine, ch.endLine, region);
    }
    this.rehash(0, this.lines.length - 1, src);
  }

  private applySingleEdit(ch: EditChange, src: LineSource): void {
    const sL = ch.startLine;
    const eL = ch.endLine;
    if (sL >= this.lines.length) return; // no marks at or below the edit
    const oldLen = eL - sL + 1;
    const newLen = ch.insertedLineBreaks + 1;
    const old = this.lines.slice(sL, eL + 1);
    while (old.length < oldLen) old.push(undefined);
    const newHash = (j: number) => hashLine(src.lineAt(sL + j));
    const region: (LineMark | undefined)[] = new Array(newLen).fill(undefined);

    // Lines at the start/end of the region whose content is unchanged keep their marks.
    let p = 0;
    while (p < oldLen && p < newLen && old[p] && old[p]!.h === newHash(p)) {
      region[p] = old[p];
      p++;
    }
    let s = 0;
    while (s < oldLen - p && s < newLen - p && old[oldLen - 1 - s] && old[oldLen - 1 - s]!.h === newHash(newLen - 1 - s)) {
      region[newLen - 1 - s] = old[oldLen - 1 - s];
      s++;
    }

    const oldMid = old.slice(p, oldLen - s);
    const newMidLen = newLen - p - s;
    if (oldMid.length > 0) {
      // Modified lines: map positionally; extra new lines inherit the last old line's mark.
      for (let j = 0; j < newMidLen; j++) {
        if (j < oldMid.length) region[p + j] = oldMid[j];
        else {
          const o = oldMid[oldMid.length - 1];
          region[p + j] = o ? clone(o) : undefined;
        }
      }
    } else if (newMidLen > 0) {
      // Pure insertion of whole lines: only extend a mark if the insertion is inside a marked block.
      const above = p > 0 ? region[p - 1] : this.get(sL - 1);
      const below = s > 0 ? region[newLen - s] : this.get(eL + 1);
      if (above && below) {
        for (let j = 0; j < newMidLen; j++) region[p + j] = clone(above);
      }
    }

    this.replaceRegion(sL, eL, region);
    this.rehash(sL - 1, sL + newLen, src);
  }

  /**
   * Validate marks against the current content. Lines that moved are re-anchored by fingerprint;
   * marks whose content changed (or vanished) are flagged stale. Call this whenever content may have
   * changed without the user typing it (disk reload, file opened, extension activated).
   */
  validate(src: LineSource, now: number): ValidateResult {
    const marks: { line: number; m: LineMark }[] = [];
    for (const [line, m] of this.entries()) marks.push({ line, m });
    const N = src.lineCount;
    if (marks.length === 0) return { changed: false, newlyStale: 0 };

    // Fast path: everything still where it was.
    const H: (string | undefined)[] = new Array(N);
    const hashAt = (i: number) => (H[i] ??= hashLine(src.lineAt(i)));
    if (marks.every(({ line, m }) => line < N && hashAt(line) === m.h)) {
      let changed = false;
      for (const { line, m } of marks) {
        const c = ctxAt(src, line);
        if (c !== m.c) {
          m.c = c;
          changed = true;
        }
      }
      return { changed, newlyStale: 0 };
    }

    for (let i = 0; i < N; i++) hashAt(i);
    const positions = new Map<string, number[]>();
    for (let i = 0; i < N; i++) {
      const list = positions.get(H[i]!);
      if (list) list.push(i);
      else positions.set(H[i]!, [i]);
    }

    const K = marks.length;
    const matched: (number | undefined)[] = new Array(K).fill(undefined);

    // Phase 1: anchors = marks whose hash is unique among marks and in the new text, kept in order (LIS).
    const markHashCount = new Map<string, number>();
    for (const { m } of marks) markHashCount.set(m.h, (markHashCount.get(m.h) ?? 0) + 1);
    const uniq: { k: number; p: number }[] = [];
    for (let k = 0; k < K; k++) {
      const list = positions.get(marks[k].m.h);
      if (markHashCount.get(marks[k].m.h) === 1 && list && list.length === 1) uniq.push({ k, p: list[0] });
    }
    for (const a of longestIncreasing(uniq)) matched[a.k] = a.p;

    // Phase 2: between anchors, match remaining marks greedily, preferring the expected position and context.
    let prevP = -1;
    let prevLine = -1;
    for (let k = 0; k < K; k++) {
      if (matched[k] !== undefined) {
        prevP = matched[k]!;
        prevLine = marks[k].line;
        continue;
      }
      let nk = k + 1;
      while (nk < K && matched[nk] === undefined) nk++;
      const limit = nk < K ? matched[nk]! : N;
      const { line, m } = marks[k];
      const expected = prevP + (line - prevLine);
      const expectedFromNext = nk < K ? matched[nk]! - (marks[nk].line - line) : undefined;
      const p = pickCandidate(positions.get(m.h), prevP, limit, expected, expectedFromNext, m.c, (i) => ctxAt(src, i));
      if (p !== undefined) {
        matched[k] = p;
        prevP = p;
        prevLine = line;
      }
    }

    // Phase 3: place unmatched marks as stale in the gaps between matched neighbours.
    const placed = new Map<number, LineMark>();
    for (let k = 0; k < K; k++) if (matched[k] !== undefined) placed.set(matched[k]!, marks[k].m);
    let newlyStale = 0;
    const flagStale = (m: LineMark) => {
      if (m.stale === undefined) {
        m.stale = now;
        newlyStale++;
      }
    };

    for (let i = 0; i < K; ) {
      if (matched[i] !== undefined) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < K && matched[j + 1] === undefined) j++;
      const run = marks.slice(i, j + 1);
      const pp = i > 0 ? matched[i - 1]! : -1;
      const pl = i > 0 ? marks[i - 1].line : -1;
      const np = j + 1 < K ? matched[j + 1]! : N;
      const nl = j + 1 < K ? marks[j + 1].line : Infinity;
      const available = np - pp - 1;
      const runContiguous = run.every((r, idx) => idx === 0 || r.line === run[idx - 1].line + 1);
      const blockContiguous = runContiguous && run[0].line === pl + 1 && run[run.length - 1].line === nl - 1;

      const noteRemoved = (target: LineMark | undefined, count: number) => {
        if (!target || count <= 0) return;
        target.removed = (target.removed ?? 0) + count;
        if (target.stale === undefined) newlyStale++;
        target.stale ??= now;
      };

      if (available <= 0) {
        // The marked lines were deleted outright: flag a neighbour so the change stays visible.
        noteRemoved(placed.get(j + 1 < K ? np : pp), run.length);
      } else if (blockContiguous) {
        // A fully-marked block was rewritten: everything now between the neighbours is stale.
        for (let q = pp + 1; q < np; q++) {
          const idx = q - pp - 1;
          const m = idx < run.length ? run[idx].m : clone(run[run.length - 1].m);
          flagStale(m);
          placed.set(q, m);
        }
        if (run.length > available) noteRemoved(placed.get(np - 1), run.length - available);
      } else {
        let last = pp;
        let overflow = 0;
        for (const r of run) {
          const want = pp + (r.line - pl);
          const q = Math.max(last + 1, Math.min(want, np - 1));
          if (q > np - 1) {
            overflow++;
            continue;
          }
          flagStale(r.m);
          placed.set(q, r.m);
          last = q;
        }
        noteRemoved(placed.get(last), overflow);
      }
      i = j + 1;
    }

    // Rebuild, re-fingerprinting every mark against the current content (stale marks track their new text).
    this.lines = [];
    for (const [q, m] of placed) {
      m.h = H[q]!;
      m.c = ctxAt(src, q);
      this.lines[q] = m;
    }
    this.trim();
    return { changed: true, newlyStale };
  }

  stats(src: LineSource, now: number): FileStats {
    let lines = 0;
    let read = 0;
    let marked = 0;
    let stale = 0;
    let ageSum = 0;
    for (let i = 0; i < src.lineCount; i++) {
      const blank = src.lineAt(i).trim() === '';
      if (!blank) lines++;
      const m = this.lines[i];
      // Blank lines only count once stale: a read mark on one is incidental, not an "other" mark.
      if (!m || (blank && m.stale === undefined)) continue;
      marked++;
      if (m.stale !== undefined) stale++;
      else if (m.cat === READ) {
        read++;
        ageSum += Math.max(0, now - m.t);
      }
    }
    return { lines, read, marked, stale, meanReadAge: read > 0 ? ageSum / read : undefined };
  }
}

function pickCandidate(
  list: number[] | undefined,
  after: number,
  before: number,
  expected: number,
  expectedFromNext: number | undefined,
  ctx: string,
  ctxAt: (i: number) => string,
): number | undefined {
  if (!list) return undefined;
  const inRange = (p: number) => p > after && p < before;
  if (inRange(expected) && list[lowerBound(list, expected)] === expected) return expected;
  if (expectedFromNext !== undefined && inRange(expectedFromNext) && list[lowerBound(list, expectedFromNext)] === expectedFromNext) {
    return expectedFromNext;
  }
  // Walk outward from the expected position, nearest first.
  const MAX_PROBES = 256;
  const NEAR = 2;
  let hi = lowerBound(list, Math.max(expected, after + 1));
  let lo = hi - 1;
  let nearest: number | undefined;
  for (let probes = 0; probes < MAX_PROBES; probes++) {
    const hiOk = hi < list.length && inRange(list[hi]);
    const loOk = lo >= 0 && inRange(list[lo]);
    if (!hiOk && !loOk) break;
    let p: number;
    if (hiOk && (!loOk || list[hi] - expected <= expected - list[lo])) p = list[hi++];
    else p = list[lo--];
    if (ctxAt(p) === ctx) return p;
    if (nearest === undefined && Math.abs(p - expected) <= NEAR) nearest = p;
  }
  return nearest;
}

function lowerBound(list: number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Longest subsequence with strictly increasing `p` (input is already ordered by `k`). */
function longestIncreasing<T extends { p: number }>(items: T[]): T[] {
  const tails: number[] = [];
  const prev: number[] = new Array(items.length).fill(-1);
  for (let i = 0; i < items.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[tails[mid]].p < items[i].p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: T[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(items[i]);
  return out.reverse();
}
