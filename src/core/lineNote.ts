import { formatSummary, SummaryValue, truncate } from './foldSummary';
import { LineMark, READ } from './marks';
import { formatTimestamp, shortAge } from './time';

/** A note template: one segment, or several joined with ` · `. */
export type NoteFormat = string | string[];

/** Templates for the cursor-line note, by kind of mark. Category ids may also be used as keys. */
export type LineNoteFormats = Record<string, NoteFormat>;

export const DEFAULT_LINE_NOTE_FORMATS: LineNoteFormats = {
  read: '{label} · {age} ago',
  edited: '{label} · {age} ago',
  stale: '⚠ changed outside editor {staleAge} ago · was last {label|lower} {age} ago',
  category: '{label} · {age} ago',
};

/** How a line's own note is shown at the end of the line. */
export interface NoteDisplay {
  /** Template with a `{note}` placeholder. */
  format: NoteFormat;
  /** Longer notes are cut short with `…` (the hover shows them in full). */
  maxLength: number;
}

export const DEFAULT_NOTE_DISPLAY: NoteDisplay = { format: '✎ {note}', maxLength: 80 };

const USES_NOTE = /\{note[:|}]/;

/** Which template a mark uses: `stale`, `edited`, `read`, its category id if one is set, else `category`. */
export function lineNoteFormat(formats: LineNoteFormats, m: LineMark): NoteFormat {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (formats[k] !== undefined) return formats[k];
    return '';
  };
  if (m.stale !== undefined) return pick('stale');
  if (m.cat === READ) return m.edited ? pick('edited', 'read') : pick('read');
  return pick(m.cat, 'category');
}

/** Placeholder values for one mark. */
export function lineNoteValues(m: LineMark, label: string, now: number, fadeMs: number, staleLabel = 'Stale'): Map<string, SummaryValue> {
  const v = new Map<string, SummaryValue>();
  v.set('label', label);
  v.set('age', shortAge(Math.max(0, now - m.t)));
  v.set('date', formatTimestamp(m.t));
  v.set('note', m.note);
  if (m.cat === READ) v.set('faded', String(Math.min(100, Math.round((Math.max(0, now - m.t) / fadeMs) * 100))));
  if (m.stale !== undefined) {
    v.set('staleLabel', staleLabel);
    v.set('staleAge', shortAge(Math.max(0, now - m.stale)));
    v.set('staleDate', formatTimestamp(m.stale));
    v.set('removed', m.removed ?? 0);
  }
  return v;
}

const segments = (f: NoteFormat) => (typeof f === 'string' ? [f] : f);

/**
 * The end-of-line text for a mark. A note on the line follows the mark's own text (formatted with
 * `display.format`), unless the mark's template places `{note}` itself.
 */
export function formatLineNote(
  formats: LineNoteFormats,
  m: LineMark,
  label: string,
  now: number,
  fadeMs: number,
  staleLabel?: string,
  display: NoteDisplay = DEFAULT_NOTE_DISPLAY,
): string {
  const f = segments(lineNoteFormat(formats, m));
  const values = lineNoteValues(m, label, now, fadeMs, staleLabel);
  if (m.note !== undefined) values.set('note', truncate(m.note, display.maxLength));
  const text = formatSummary(f, values);
  if (f.some((seg) => USES_NOTE.test(seg))) return text;
  return [text, formatNoteOnly(m, display)].filter((t) => t !== '').join(' · ');
}

/** Just the line's note, formatted with `display.format`; empty if it has none. */
export function formatNoteOnly(m: LineMark, display: NoteDisplay = DEFAULT_NOTE_DISPLAY): string {
  if (m.note === undefined) return '';
  return formatSummary(segments(display.format), new Map([['note', truncate(m.note, display.maxLength)]]));
}
