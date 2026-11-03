import { FileMarks, LineMark } from './marks';

/** A run of consecutive lines sharing category, timestamp and stale state. */
interface StoredRun {
  /** First line (0-based). */
  l: number;
  cat: string;
  t: number;
  /** Space-separated line fingerprints, one per line. */
  h: string;
  /** Space-separated context fingerprints, one per line. */
  x: string;
  st?: number;
  rm?: number;
  /** Read by the user's own typing. */
  ed?: 1;
}

export interface StoredFile {
  version: 1;
  files: Record<string, StoredRun[]>;
}

export function serialize(files: Map<string, FileMarks>): string {
  const paths = [...files.keys()].filter((p) => !files.get(p)!.isEmpty).sort();
  const out: string[] = ['{', '  "version": 1,', '  "files": {'];
  paths.forEach((path, pi) => {
    const runs = toRuns(files.get(path)!);
    out.push(`    ${JSON.stringify(path)}: [`);
    runs.forEach((r, ri) => out.push(`      ${JSON.stringify(r)}${ri < runs.length - 1 ? ',' : ''}`));
    out.push(`    ]${pi < paths.length - 1 ? ',' : ''}`);
  });
  out.push('  }', '}', '');
  return out.join('\n');
}

export function deserialize(text: string): Map<string, FileMarks> {
  const data = JSON.parse(text) as StoredFile;
  if (!data || typeof data !== 'object' || data.version !== 1 || typeof data.files !== 'object') {
    throw new Error('unrecognised Patina storage format');
  }
  const result = new Map<string, FileMarks>();
  for (const [path, runs] of Object.entries(data.files)) {
    const fm = new FileMarks();
    for (const r of runs) {
      const hs = r.h.split(' ');
      const xs = r.x.split(' ');
      hs.forEach((h, i) => {
        const m: LineMark = { cat: r.cat, t: r.t, h, c: xs[i] ?? '' };
        if (r.st !== undefined) m.stale = r.st;
        if (r.rm !== undefined) m.removed = r.rm;
        if (r.ed) m.edited = true;
        fm.lines[r.l + i] = m;
      });
    }
    if (!fm.isEmpty) result.set(path, fm);
  }
  return result;
}

function toRuns(fm: FileMarks): StoredRun[] {
  const runs: StoredRun[] = [];
  let cur: { run: StoredRun; hs: string[]; xs: string[]; next: number } | undefined;
  const flush = () => {
    if (!cur) return;
    cur.run.h = cur.hs.join(' ');
    cur.run.x = cur.xs.join(' ');
    runs.push(cur.run);
    cur = undefined;
  };
  for (const [line, m] of fm.entries()) {
    const continues =
      cur &&
      cur.next === line &&
      cur.run.cat === m.cat &&
      cur.run.t === m.t &&
      cur.run.st === m.stale &&
      !!cur.run.ed === !!m.edited &&
      cur.run.rm === undefined &&
      m.removed === undefined;
    if (!continues) {
      flush();
      const run: StoredRun = { l: line, cat: m.cat, t: m.t, h: '', x: '' };
      if (m.stale !== undefined) run.st = m.stale;
      if (m.removed !== undefined) run.rm = m.removed;
      if (m.edited) run.ed = 1;
      cur = { run, hs: [], xs: [], next: line };
    }
    cur!.hs.push(m.h);
    cur!.xs.push(m.c);
    cur!.next = line + 1;
  }
  flush();
  return runs;
}
