const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeAge(ms: number): string {
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return plural(Math.floor(ms / MIN), 'minute') + ' ago';
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour') + ' ago';
  if (ms < 60 * DAY) return plural(Math.floor(ms / DAY), 'day') + ' ago';
  if (ms < 730 * DAY) return plural(Math.floor(ms / (30 * DAY)), 'month') + ' ago';
  return plural(Math.floor(ms / (365 * DAY)), 'year') + ' ago';
}

export function shortAge(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function formatTimestamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export const DAY_MS = DAY;
