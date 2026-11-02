import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditChange, FileMarks, LineSource, READ } from '../core/marks';
import { deserialize, serialize } from '../core/serialize';
import { interpolateStops, parseColor } from '../core/color';

const T0 = 1_700_000_000_000;
const T1 = T0 + 86_400_000;

function src(lines: string[]): LineSource {
  return { lineCount: lines.length, lineAt: (i) => lines[i] };
}

function file(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
}

/** Apply a user edit (replace [startLine:startCh, endLine:endCh] with text) and return the change + new lines. */
function edit(lines: string[], sL: number, sC: number, eL: number, eC: number, text: string): { lines: string[]; change: EditChange } {
  const before = lines.slice(0, sL);
  const after = lines.slice(eL + 1);
  const joined = lines[sL].slice(0, sC) + text + lines[eL].slice(eC);
  const mid = joined.split('\n');
  return {
    lines: [...before, ...mid, ...after],
    change: { startLine: sL, endLine: eL, insertedLineBreaks: (text.match(/\n/g) ?? []).length },
  };
}

function markedLines(fm: FileMarks): number[] {
  return [...fm.entries()].map(([l]) => l);
}

function staleLines(fm: FileMarks): number[] {
  return [...fm.entries()].filter(([, m]) => m.stale !== undefined).map(([l]) => l);
}

test('marking and clearing', () => {
  const lines = file(10);
  const fm = new FileMarks();
  fm.mark(2, 4, READ, T0, src(lines));
  assert.deepEqual(markedLines(fm), [2, 3, 4]);
  fm.clear(3, 3);
  assert.deepEqual(markedLines(fm), [2, 4]);
  fm.clear(0, 9);
  assert.ok(fm.isEmpty);
});

test('validate: unchanged content is a no-op', () => {
  const lines = file(10);
  const fm = new FileMarks();
  fm.mark(2, 4, READ, T0, src(lines));
  const r = fm.validate(src(lines), T1);
  assert.equal(r.changed, false);
  assert.deepEqual(staleLines(fm), []);
});

test('validate: lines inserted above move the marks (foreign)', () => {
  const lines = file(20);
  const fm = new FileMarks();
  fm.mark(10, 12, READ, T0, src(lines));
  const next = [...lines.slice(0, 3), 'new a', 'new b', 'new c', ...lines.slice(3)];
  fm.validate(src(next), T1);
  assert.deepEqual(markedLines(fm), [13, 14, 15]);
  assert.deepEqual(staleLines(fm), []);
});

test('validate: lines deleted above move the marks', () => {
  const lines = file(20);
  const fm = new FileMarks();
  fm.mark(10, 12, READ, T0, src(lines));
  const next = [...lines.slice(0, 2), ...lines.slice(6)];
  fm.validate(src(next), T1);
  assert.deepEqual(markedLines(fm), [6, 7, 8]);
  assert.deepEqual(staleLines(fm), []);
});

test('validate: changed line inside a marked block goes stale, rest stays fresh', () => {
  const lines = file(20);
  const fm = new FileMarks();
  fm.mark(5, 9, READ, T0, src(lines));
  const next = [...lines];
  next[7] = 'changed by claude';
  const r = fm.validate(src(next), T1);
  assert.equal(r.newlyStale, 1);
  assert.deepEqual(markedLines(fm), [5, 6, 7, 8, 9]);
  assert.deepEqual(staleLines(fm), [7]);
  assert.equal(fm.get(7)!.stale, T1);
  // Re-validating is idempotent and keeps the original detection time.
  fm.validate(src(next), T1 + 5000);
  assert.deepEqual(staleLines(fm), [7]);
  assert.equal(fm.get(7)!.stale, T1);
});

test('validate: block rewritten with more lines marks the whole new block stale', () => {
  const lines = file(20);
  const fm = new FileMarks();
  fm.mark(5, 9, READ, T0, src(lines));
  const next = [...lines.slice(0, 7), 'x1', 'x2', 'x3', 'x4', ...lines.slice(8)];
  fm.validate(src(next), T1);
  assert.deepEqual(markedLines(fm), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(staleLines(fm), [7, 8, 9, 10]);
});

test('validate: deleted marked lines flag a neighbour as stale with a removed count', () => {
  const lines = file(20);
  const fm = new FileMarks();
  fm.mark(5, 9, READ, T0, src(lines));
  const next = [...lines.slice(0, 6), ...lines.slice(8)]; // drop lines 6, 7
  fm.validate(src(next), T1);
  assert.deepEqual(markedLines(fm), [5, 6, 7]);
  assert.deepEqual(staleLines(fm), [6]);
  assert.equal(fm.get(6)!.removed, 2);
});

test('validate: repetitive lines (braces, blanks) re-anchor using context', () => {
  const lines = ['function a() {', '  x();', '}', '', 'function b() {', '  y();', '}', '', 'function c() {', '  z();', '}'];
  const fm = new FileMarks();
  fm.mark(4, 7, READ, T0, src(lines)); // function b, its brace and the blank after
  const next = ['// header', '', ...lines];
  fm.validate(src(next), T1);
  assert.deepEqual(markedLines(fm), [6, 7, 8, 9]);
  assert.deepEqual(staleLines(fm), []);
  assert.equal(next[8], '}');
});

test('validate: file truncated externally', () => {
  const lines = file(10);
  const fm = new FileMarks();
  fm.mark(0, 9, READ, T0, src(lines));
  fm.validate(src(lines.slice(0, 4)), T1);
  assert.deepEqual(markedLines(fm), [0, 1, 2, 3]);
  assert.deepEqual(staleLines(fm), [3]);
  assert.equal(fm.get(3)!.removed, 6);
});

test('validate: never reports a foreign-changed line as fresh', () => {
  // Randomised: mark everything, apply random foreign mutations, check every fresh mark matches its original line text.
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let iter = 0; iter < 200; iter++) {
    const pool = ['{', '}', '', 'return x;', 'foo();', 'bar();'];
    const lines = Array.from({ length: 30 }, (_, i) => (rnd(3) === 0 ? pool[rnd(pool.length)] : `unique ${iter} ${i}`));
    const fm = new FileMarks();
    fm.mark(0, lines.length - 1, READ, T0, src(lines));
    const next = [...lines];
    for (let k = 0; k < 4; k++) {
      const op = rnd(3);
      const at = rnd(next.length);
      if (op === 0) next.splice(at, 0, `inserted ${k}`);
      else if (op === 1 && next.length > 1) next.splice(at, 1);
      else next[at] = `mutated ${k}`;
    }
    fm.validate(src(next), T1);
    for (const [line, m] of fm.entries()) {
      if (m.stale !== undefined) continue;
      assert.ok(line < next.length);
      assert.ok(!next[line].startsWith('mutated') && !next[line].startsWith('inserted'), `iter ${iter}: line ${line} "${next[line]}" shown fresh`);
    }
  }
});

test('user edit: typing inside a marked line keeps it fresh and re-fingerprints', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 5, READ, T0, src(lines));
  const e = edit(lines, 4, 2, 4, 2, 'XYZ');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [3, 4, 5]);
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
  assert.deepEqual(staleLines(fm), []);
});

test('user edit: Enter at end of a line inside a block extends the block; at block end does not', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 5, READ, T0, src(lines));
  let e = edit(lines, 3, lines[3].length, 3, lines[3].length, '\n');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [3, 4, 5, 6]);
  e = edit(lines, 6, lines[6].length, 6, lines[6].length, '\nnew code');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [3, 4, 5, 6]);
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
});

test('user edit: Enter at start of a marked line moves the mark down', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 3, READ, T0, src(lines));
  const e = edit(lines, 3, 0, 3, 0, '\n');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [4]);
  assert.equal(lines[4], 'line 3');
});

test('user edit: inserting lines above shifts marks', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(5, 6, 'question', T0, src(lines));
  const e = edit(lines, 1, 0, 1, 0, 'a\nb\nc\n');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [8, 9]);
  assert.equal(fm.get(8)!.cat, 'question');
});

test('user edit: deleting lines including marks removes them', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 6, READ, T0, src(lines));
  const e = edit(lines, 2, 0, 5, 0, '');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [2, 3]);
  assert.equal(lines[2], 'line 5');
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
});

test('user edit: joining lines with backspace', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 5, READ, T0, src(lines));
  const e = edit(lines, 3, lines[3].length, 4, 0, '');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(markedLines(fm), [3, 4]);
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
});

test('user edit: multi-cursor edits (sequential changes)', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(2, 8, READ, T0, src(lines));
  // VS Code delivers multi-cursor changes so they apply sequentially; bottom-up here.
  const e1 = edit(lines, 7, 0, 7, 0, '// ');
  const e2 = edit(e1.lines, 3, 0, 3, 0, '// ');
  lines = e2.lines;
  fm.applyUserEdits([e1.change, e2.change], src(lines));
  assert.deepEqual(markedLines(fm), [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
});

test('user edit: typing on a stale line keeps it stale', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(3, 3, READ, T0, src(lines));
  lines[3] = 'external';
  fm.validate(src(lines), T1);
  assert.deepEqual(staleLines(fm), [3]);
  const e = edit(lines, 3, 0, 3, 0, 'x');
  lines = e.lines;
  fm.applyUserEdits([e.change], src(lines));
  assert.deepEqual(staleLines(fm), [3]);
  fm.mark(3, 3, READ, T1, src(lines));
  assert.deepEqual(staleLines(fm), []);
});

test('serialize round-trip', () => {
  const lines = file(30);
  const fm = new FileMarks();
  fm.mark(0, 9, READ, T0, src(lines));
  fm.mark(12, 14, 'next', T1, src(lines));
  lines[5] = 'changed';
  fm.validate(src(lines), T1);
  const text = serialize(new Map([['src/a.ts', fm], ['empty.ts', new FileMarks()]]));
  const back = deserialize(text).get('src/a.ts')!;
  assert.deepEqual(back.lines, fm.lines);
  assert.ok(!text.includes('empty.ts'));
  assert.equal(deserialize(text).size, 1);
});

test('stats', () => {
  const lines = ['a', '', 'b', 'c'];
  const fm = new FileMarks();
  fm.mark(0, 1, READ, T0, src(lines));
  fm.mark(3, 3, 'next', T0, src(lines));
  const s = fm.stats(src(lines), T0 + 1000);
  assert.deepEqual(s, { lines: 3, read: 1, marked: 3, stale: 0, meanReadAge: 1000 });
});

test('colors', () => {
  assert.deepEqual(parseColor('#ff0000'), [255, 0, 0, 1]);
  assert.deepEqual(parseColor('#f008'), [255, 0, 0, 0x88 / 255]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5]);
  assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.equal(parseColor('red'), undefined);
  const stops: [number, number, number, number][] = [[0, 0, 0, 0], [100, 100, 100, 1], [200, 200, 200, 0]];
  assert.deepEqual(interpolateStops(stops, 0.25), [50, 50, 50, 0.5]);
  assert.deepEqual(interpolateStops(stops, 1), [200, 200, 200, 0]);
  assert.deepEqual(interpolateStops(stops, 2), [200, 200, 200, 0]);
});
