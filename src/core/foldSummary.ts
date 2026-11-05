import { FileMarks, LineSource, READ } from './marks';
import { shortAge } from './time';

/** Marks found inside a block of lines (typically a folded region). */
export interface BlockStats {
  /** Non-blank lines in the block. */
  lines: number;
  /** Non-blank lines with a fresh (non-stale) read mark, including lines read by typing. */
  read: number;
  readAgeSum: number;
  readNewest?: number;
  readOldest?: number;
  /** Fresh read marks created by typing. */
  edited: number;
  editedAgeSum: number;
  editedNewest?: number;
  /** Lines changed outside the editor. */
  stale: number;
  staleNewest?: number;
  /** Fresh marks per static category id. */
  categories: Map<string, number>;
}

/** Collects mark statistics for lines [start, end]. Ages are measured from `now`. */
export function blockStats(marks: FileMarks | undefined, src: LineSource, start: number, end: number, now: number): BlockStats {
  const s: BlockStats = { lines: 0, read: 0, readAgeSum: 0, edited: 0, editedAgeSum: 0, stale: 0, categories: new Map() };
  const newest = (cur: number | undefined, age: number) => (cur === undefined ? age : Math.min(cur, age));
  end = Math.min(end, src.lineCount - 1);
  for (let i = Math.max(0, start); i <= end; i++) {
    const blank = src.lineAt(i).trim() === '';
    if (!blank) s.lines++;
    const m = marks?.get(i);
    if (!m) continue;
    if (m.stale !== undefined) {
      s.stale++;
      s.staleNewest = newest(s.staleNewest, Math.max(0, now - m.stale));
      continue;
    }
    const age = Math.max(0, now - m.t);
    if (m.cat !== READ) {
      s.categories.set(m.cat, (s.categories.get(m.cat) ?? 0) + 1);
      continue;
    }
    if (blank) continue;
    s.read++;
    s.readAgeSum += age;
    s.readNewest = newest(s.readNewest, age);
    s.readOldest = s.readOldest === undefined ? age : Math.max(s.readOldest, age);
    if (m.edited) {
      s.edited++;
      s.editedAgeSum += age;
      s.editedNewest = newest(s.editedNewest, age);
    }
  }
  return s;
}

/** A placeholder value: numbers are counts (0 means nothing to report), strings are shown as-is. */
export type SummaryValue = number | string | undefined;

/**
 * Placeholder values for a block. Counts are numbers; ages are short strings like `3h`.
 * `labelFor` gives a category's display label for a count (so it can pluralise); `categoryOrder` lists ids in settings order.
 */
export function summaryValues(
  s: BlockStats,
  labelFor: (cat: string, count: number) => string,
  categoryOrder: readonly string[],
): Map<string, SummaryValue> {
  const age = (ms: number | undefined) => (ms === undefined ? undefined : shortAge(ms));
  const v = new Map<string, SummaryValue>();
  v.set('lines', s.lines);
  v.set('read', s.read);
  v.set('readPercent', s.lines > 0 ? String(Math.round((s.read / s.lines) * 100)) : undefined);
  v.set('readAge', age(s.read > 0 ? s.readAgeSum / s.read : undefined));
  v.set('readNewest', age(s.readNewest));
  v.set('readOldest', age(s.readOldest));
  v.set('unread', Math.max(0, s.lines - s.read));
  v.set('edited', s.edited);
  v.set('editedAge', age(s.edited > 0 ? s.editedAgeSum / s.edited : undefined));
  v.set('editedNewest', age(s.editedNewest));
  v.set('stale', s.stale);
  v.set('staleNewest', age(s.staleNewest));
  const ids = [...categoryOrder.filter((id) => s.categories.has(id)), ...[...s.categories.keys()].filter((id) => !categoryOrder.includes(id))];
  for (const id of ids) v.set(`cat.${id}`, s.categories.get(id)!);
  v.set('categories', ids.map((id) => `${s.categories.get(id)} ${labelFor(id, s.categories.get(id)!)}`).join(', ') || undefined);
  return v;
}

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)(?::([^{}|]+))?((?:\|[A-Za-z]+)*)\}/g;

const FILTERS: Record<string, (s: string) => string> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1),
};

/**
 * Fills each segment's `{name}` placeholders and joins the segments with ` · `.
 * A segment is left out when any of its placeholders has nothing to report (unknown, empty or a zero count).
 * `{name:word}` on a count also writes the word, pluralised: `{edited:line}` → `1 line`, `14 lines`.
 * `|lower`, `|upper` and `|capitalize` change the case: `{label|lower}` → `read`. Unknown filters are ignored.
 */
export function formatSummary(segments: readonly string[], values: ReadonlyMap<string, SummaryValue>): string {
  const out: string[] = [];
  for (const seg of segments) {
    let missing = false;
    const text = seg.replace(PLACEHOLDER, (_, name: string, word: string | undefined, filters: string) => {
      const val = values.get(name);
      if (val === undefined || val === '' || val === 0) {
        missing = true;
        return '';
      }
      let out = String(val);
      if (word !== undefined) out = typeof val === 'number' ? `${val} ${word}${val === 1 ? '' : 's'}` : `${val} ${word}`;
      for (const f of filters.split('|').slice(1)) out = FILTERS[f.toLowerCase()]?.(out) ?? out;
      return out;
    });
    if (!missing && text.trim() !== '') out.push(text.trim());
  }
  return out.join(' · ');
}

/** A folded block: `header` is its visible first line, `start`..`end` the hidden lines. */
export interface FoldedGap {
  header: number;
  start: number;
  end: number;
}

/** Folded (hidden) line ranges, inferred from the gaps between an editor's visible ranges. */
export function foldedGaps(visible: readonly { start: number; end: number }[]): FoldedGap[] {
  const sorted = [...visible].sort((a, b) => a.start - b.start);
  const gaps: FoldedGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].end;
    const nextStart = sorted[i].start;
    if (nextStart > prevEnd + 1) gaps.push({ header: prevEnd, start: prevEnd + 1, end: nextStart - 1 });
  }
  return gaps;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));

/**
 * The innermost bracket still open at the end of a line, if any: for `def f(` or `function f(a,` it's `(`,
 * for `f(a) {` it's `{`. Skips quoted strings and stops at `//` or `#` comments (roughly).
 */
export function lastUnclosedBracket(line: string): string | undefined {
  const stack: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '#' || (ch === '/' && line[i + 1] === '/')) break;
    else if (ch in OPENERS) stack.push(ch);
    else if (CLOSERS.has(ch) && stack.length > 0 && OPENERS[stack[stack.length - 1]] === ch) stack.pop();
  }
  return stack[stack.length - 1];
}
