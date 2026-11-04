import { formatSummary, SummaryValue } from './foldSummary';
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
  if (m.cat === READ) v.set('faded', String(Math.min(100, Math.round((Math.max(0, now - m.t) / fadeMs) * 100))));
  if (m.stale !== undefined) {
    v.set('staleLabel', staleLabel);
    v.set('staleAge', shortAge(Math.max(0, now - m.stale)));
    v.set('staleDate', formatTimestamp(m.stale));
    v.set('removed', m.removed ?? 0);
  }
  return v;
}

export function formatLineNote(
  formats: LineNoteFormats,
  m: LineMark,
  label: string,
  now: number,
  fadeMs: number,
  staleLabel?: string,
): string {
  const f = lineNoteFormat(formats, m);
  return formatSummary(typeof f === 'string' ? [f] : f, lineNoteValues(m, label, now, fadeMs, staleLabel));
}
