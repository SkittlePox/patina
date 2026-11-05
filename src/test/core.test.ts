import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditChange, FileMarks, LineSource, READ } from '../core/marks';
import { deserialize, serialize } from '../core/serialize';
import { averageColors, interpolateStops, parseColor, quantizeColor } from '../core/color';
import { gutterBarSvg } from '../core/gutter';
import { PALETTES, resolveColors } from '../core/palettes';
import { changedSpans, DocShadow, isAtCursors } from '../core/typing';
import { compileExcludes, globToRegExp } from '../core/glob';
import { blockStats, foldedGaps, formatSummary, lastUnclosedBracket, summaryValues } from '../core/foldSummary';
import { DEFAULT_LINE_NOTE_FORMATS, formatLineNote } from '../core/lineNote';

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
  fm.markTyped(16, 17, T1, src(lines));
  fm.markTyped(18, 18, T1 + 1, src(lines));
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

test('gutter bar svg', () => {
  const svg = gutterBarSvg('rgba(230, 60, 60, 0.85)');
  assert.match(svg, /fill="#e63c3c" fill-opacity="0.85"/);
  assert.match(svg, /preserveAspectRatio="none"/);
  assert.match(gutterBarSvg('red"><script>'), /fill="redscript"/);
});

test('palettes: every palette is complete and parseable', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const set of [p.background, p.gutter]) {
      const all = [...set.readFade, set.stale, ...Object.values(set.categories), ...set.extra];
      for (const c of all) assert.ok(parseColor(c), `${id}: ${c}`);
      assert.ok(set.readFade.length >= 2 && set.categories.next && set.categories.question, id);
    }
    // Gutter bars are stronger than backgrounds.
    assert.ok(parseColor(p.gutter.stale)![3] > parseColor(p.background.stale)![3], id);
  }
});

test('palettes: resolution and overrides', () => {
  const cats = [{ id: 'next' }, { id: 'question' }, { id: 'todo' }, { id: 'idea' }];
  const plain = resolveColors('vivid', { categories: cats });
  assert.deepEqual(plain.background.readFade, PALETTES.vivid.background.readFade);
  assert.equal(plain.gutter.stale, PALETTES.vivid.gutter.stale);
  assert.equal(plain.background.categories.get('todo'), PALETTES.vivid.background.extra[0]);
  assert.equal(plain.gutter.categories.get('idea'), PALETTES.vivid.gutter.extra[1]);
  assert.deepEqual(resolveColors('nope', { categories: [] }).background.readFade, PALETTES.supermuted.background.readFade);

  const o = resolveColors('muted', {
    readFade: ['rgba(1, 2, 3, 0.2)', 'rgba(4, 5, 6, 0.1)'],
    stale: 'rgba(200, 0, 0, 0.3)',
    staleGutter: '#00ff00',
    categories: [{ id: 'next', color: 'rgba(9, 9, 9, 0.2)' }, { id: 'todo', color: 'rgba(7, 7, 7, 0.2)', gutterColor: '#123456' }, { id: 'idea' }],
  });
  assert.deepEqual(o.background.readFade, ['rgba(1, 2, 3, 0.2)', 'rgba(4, 5, 6, 0.1)']);
  assert.deepEqual(o.gutter.readFade, ['rgba(1, 2, 3, 0.85)', 'rgba(4, 5, 6, 0.85)']); // derived from background override
  assert.equal(o.background.stale, 'rgba(200, 0, 0, 0.3)');
  assert.equal(o.gutter.stale, '#00ff00');
  assert.equal(o.gutter.categories.get('next'), 'rgba(9, 9, 9, 0.85)');
  assert.equal(o.gutter.categories.get('todo'), '#123456');
  assert.equal(o.background.categories.get('idea'), PALETTES.muted.background.extra[0]); // todo was fully custom
  assert.deepEqual(resolveColors('default', { readFade: [], stale: '  ', categories: [] }).background.stale, PALETTES.default.background.stale);
});

test('typing: edits at the cursors count as typed, edits elsewhere do not', () => {
  const ch = (startLine: number, endLine = startLine, insertedLineBreaks = 0): EditChange => ({ startLine, endLine, insertedLineBreaks });
  const cursor = (l: number, e = l) => ({ start: l, end: e });
  assert.ok(isAtCursors([ch(5)], [cursor(5)])); // typing a character
  assert.ok(isAtCursors([ch(5, 5, 1)], [cursor(6)])); // Enter, cursor already moved down
  assert.ok(isAtCursors([ch(5, 5, 20)], [cursor(25)])); // multi-line paste, post-change cursor
  assert.ok(isAtCursors([ch(4, 5)], [cursor(5)])); // backspace joining lines
  assert.ok(isAtCursors([ch(9), ch(3)], [cursor(3), cursor(9)])); // multi-cursor
  assert.ok(isAtCursors([ch(2, 8)], [cursor(2, 8)])); // replace a selection
  assert.ok(!isAtCursors([ch(40), ch(12), ch(5)], [cursor(5)])); // rename: occurrences elsewhere
  assert.ok(!isAtCursors([ch(0)], [cursor(30)])); // auto-import / formatter at the top
  assert.ok(!isAtCursors([], [cursor(0)]));
});

test('typing: changed spans after sequential changes', () => {
  const ch = (startLine: number, endLine: number, insertedLineBreaks: number): EditChange => ({ startLine, endLine, insertedLineBreaks });
  assert.deepEqual(changedSpans([ch(5, 5, 0)]), [{ start: 5, end: 5 }]);
  assert.deepEqual(changedSpans([ch(5, 5, 2)]), [{ start: 5, end: 7 }]);
  // Bottom-up multi-cursor Enter: the earlier (lower) span shifts down when a later change inserts above it.
  assert.deepEqual(changedSpans([ch(9, 9, 1), ch(3, 3, 1)]), [{ start: 3, end: 4 }, { start: 10, end: 11 }]);
  // A later change overlapping an earlier span merges with it.
  assert.deepEqual(changedSpans([ch(5, 5, 2), ch(6, 6, 0)]), [{ start: 5, end: 7 }]);
  // Deleting lines below an earlier span leaves it in place.
  assert.deepEqual(changedSpans([ch(2, 2, 0), ch(5, 8, 0)]), [{ start: 2, end: 2 }, { start: 5, end: 5 }]);
});

test('typing: typed lines become read now (any category); tool edits keep dates', () => {
  let lines = file(10);
  const fm = new FileMarks();
  fm.mark(2, 4, READ, T0, src(lines));
  fm.mark(6, 6, 'question', T0, src(lines));
  // Typed edit on line 3 and on the question line, plus a newly typed line after line 8 (unmarked).
  const e1 = edit(lines, 3, 0, 3, 0, 'x');
  lines = e1.lines;
  fm.applyUserEdits([e1.change], src(lines));
  for (const s of changedSpans([e1.change])) fm.markTyped(s.start, s.end, T1, src(lines));
  assert.equal(fm.get(2)!.t, T0);
  assert.equal(fm.get(3)!.t, T1);
  assert.equal(fm.get(4)!.t, T0);
  const e2 = edit(lines, 8, lines[8].length, 8, lines[8].length, '\nnew line');
  lines = e2.lines;
  fm.applyUserEdits([e2.change], src(lines));
  for (const s of changedSpans([e2.change])) fm.markTyped(s.start, s.end, T1, src(lines));
  assert.deepEqual([fm.get(8)?.cat, fm.get(8)?.t, fm.get(9)?.cat], [READ, T1, READ]);
  fm.markTyped(6, 6, T1, src(lines));
  assert.deepEqual([fm.get(6)!.cat, fm.get(6)!.t, fm.get(6)!.edited], [READ, T1, true]);
  assert.equal(fm.get(2)!.edited, undefined); // marked explicitly, untouched by typing
  fm.mark(6, 6, READ, T1, src(lines));
  assert.equal(fm.get(6)!.edited, undefined); // marking explicitly makes it plain "read" again
  // A tool edit (e.g. rename) on line 2: content follows, date stays, not stale.
  const e3 = edit(lines, 2, 0, 2, 4, 'renamed');
  lines = e3.lines;
  fm.applyUserEdits([e3.change], src(lines));
  assert.equal(fm.get(2)!.t, T0);
  assert.equal(fm.validate(src(lines), T1).newlyStale, 0);
  // Typing on a stale read line refreshes it.
  lines[4] = 'external change';
  fm.validate(src(lines), T1);
  assert.ok(fm.get(4)!.stale);
  fm.markTyped(4, 4, T1 + 1, src(lines));
  assert.deepEqual([fm.get(4)!.stale, fm.get(4)!.t], [undefined, T1 + 1]);
});

test('shadow: only lines whose content changed count as typed', () => {
  const run = (lines: string[], sL: number, sC: number, eL: number, eC: number, text: string) => {
    const shadow = new DocShadow(src(lines));
    const e = edit(lines, sL, sC, eL, eC, text);
    return shadow.apply([e.change], src(e.lines));
  };
  const lines = ['a', 'block 1', 'block 2', 'block 3', 'z', '', 'q'];
  assert.deepEqual(run(lines, 0, 1, 3, 7, ''), []); // delete a block from the end of the line above
  assert.deepEqual(run(lines, 1, 0, 4, 0, ''), []); // delete whole lines
  assert.deepEqual(run(lines, 4, 1, 5, 0, ''), []); // backspace away an empty line
  assert.deepEqual(run(lines, 3, 7, 4, 0, ''), [3]); // join two non-empty lines
  assert.deepEqual(run(lines, 1, 2, 1, 2, 'x'), [1]); // type a character
  assert.deepEqual(run(lines, 0, 1, 0, 1, '\n'), [1]); // Enter at end of line: the new line
  assert.deepEqual(run(lines, 1, 3, 1, 3, 'p\nq\nr'), [1, 2, 3]); // multi-line paste mid-line
  assert.deepEqual(run(lines, 0, 0, 0, 0, 'new\n'), [0]); // insert a line above
});

test('shadow: stays in sync over many random edits', () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let lines = Array.from({ length: 50 }, (_, i) => (i % 4 === 0 ? '' : `l${i}`));
  const shadow = new DocShadow(src(lines));
  for (let k = 0; k < 2000; k++) {
    const sL = rnd(lines.length);
    const eL = Math.min(lines.length - 1, sL + rnd(3));
    const sC = rnd(lines[sL].length + 1);
    const eC = eL === sL ? sC + rnd(lines[sL].length - sC + 1) : rnd(lines[eL].length + 1);
    const text = ['', 'x', '\n', 'y\nz', '\n\n', `k${k}`][rnd(6)];
    const e = edit(lines, sL, sC, eL, eC, text);
    const got = shadow.apply([e.change], src(e.lines));
    // Brute force: prefix/suffix comparison of the real old and new text of the region.
    const old = lines.slice(sL, eL + 1);
    const fresh = e.lines.slice(sL, sL + e.change.insertedLineBreaks + 1);
    let p = 0;
    while (p < old.length && p < fresh.length && old[p] === fresh[p]) p++;
    let s = 0;
    while (s < old.length - p && s < fresh.length - p && old[old.length - 1 - s] === fresh[fresh.length - 1 - s]) s++;
    const want: number[] = [];
    for (let j = p; j < fresh.length - s; j++) want.push(sL + j);
    assert.deepEqual(got, want, `edit ${k}`);
    lines = e.lines;
    assert.equal(shadow.lineCount, lines.length);
  }
});

test('exclude globs', () => {
  const ex = compileExcludes(['logs', '**/*.log', 'tmp/debug/', 'out/**', '**/__pycache__', 'gen/{a,b}', 'data/run[0-9]*', '  ', '']);
  assert.ok(ex('logs'));
  assert.ok(ex('logs/today/run.txt')); // inside an excluded folder
  assert.ok(!ex('src/logs/x.txt')); // bare names are relative to the workspace root (use **/logs for any depth)
  assert.ok(ex('trace.log') && ex('a/b/trace.log'));
  assert.ok(!ex('trace.log.txt'));
  assert.ok(ex('tmp/debug/x.py') && !ex('tmp/debugger/x.py'));
  assert.ok(ex('out/a/b.js') && !ex('outer/a.js'));
  assert.ok(ex('pkg/__pycache__/m.pyc'));
  assert.ok(ex('gen/a/x') && ex('gen/b') && !ex('gen/c/x'));
  assert.ok(ex('data/run3.csv') && !ex('data/runx.csv'));
  assert.ok(!ex('src/main.ts'));
  assert.ok(!compileExcludes([])('anything'));
  assert.ok(globToRegExp('./a.b/*.ts').test('a.b/x.ts') && !globToRegExp('a.b/*.ts').test('axb/x.ts'));
});

test('fold summary: block stats and default-style formatting', () => {
  const H = 3_600_000;
  const lines = ['f() {', 'a', 'b', '', 'c', 'd', 'e', '}'];
  const fm = new FileMarks();
  const s = src(lines);
  fm.mark(1, 3, READ, T1 - 5 * H, s); // a, b, blank (blank doesn't count)
  fm.markTyped(4, 4, T1 - 1 * H, s); // c: edited
  fm.mark(5, 5, 'question', T1, s); // d
  const stats = blockStats(fm, s, 1, 6, T1);
  assert.equal(stats.lines, 5);
  assert.equal(stats.read, 3);
  assert.equal(stats.edited, 1);
  assert.equal(stats.categories.get('question'), 1);
  const values = summaryValues(stats, (c) => (c === 'question' ? 'Question' : c), ['next', 'question']);
  assert.equal(values.get('readPercent'), '60');
  assert.equal(values.get('readAge'), '3h'); // (5 + 5 + 1) / 3 = 3.67h
  assert.equal(values.get('editedNewest'), '1h');
  assert.equal(
    formatSummary(
      ['Contents: {readPercent}% read', 'read on average {readAge} ago', '{edited:line} edited, most recently {editedNewest} ago', '{categories}', '⚠ {stale} stale'],
      values,
    ),
    'Contents: 60% read · read on average 3h ago · 1 line edited, most recently 1h ago · 1 Question',
  );
});

test('fold summary: segments with nothing to report are dropped; 0% still shows', () => {
  const s = src(['x', 'y']);
  const values = summaryValues(blockStats(undefined, s, 0, 1, T0), (c) => c, []);
  assert.equal(formatSummary(['{readPercent}% read', 'avg {readAge}', '{edited:line} edited', '{cat.question} Q', '{categories}'], values), '0% read');
  assert.equal(formatSummary(['{unread:line} unread', '{nope}'], values), '2 lines unread');
});

test('fold summary: stale marks count as stale, not read', () => {
  const lines = ['a', 'b', 'c'];
  const fm = new FileMarks();
  fm.mark(0, 2, READ, T0, src(lines));
  fm.validate(src(['a', 'B', 'c']), T1);
  const stats = blockStats(fm, src(['a', 'B', 'c']), 0, 2, T1);
  assert.equal(stats.stale, 1);
  assert.equal(stats.read, 2);
});

test('fold summary: folded gaps from visible ranges', () => {
  assert.deepEqual(foldedGaps([{ start: 0, end: 10 }]), []);
  assert.deepEqual(
    foldedGaps([
      { start: 20, end: 30 },
      { start: 0, end: 4 },
      { start: 9, end: 15 },
    ]),
    [
      { header: 4, start: 5, end: 8 },
      { header: 15, start: 16, end: 19 },
    ],
  );
  assert.deepEqual(foldedGaps([{ start: 0, end: 4 }, { start: 5, end: 9 }]), []);
});

test('fold highlight: average color counts unmarked lines as transparent', () => {
  const green: [number, number, number, number] = [0, 200, 0, 0.2];
  const red: [number, number, number, number] = [200, 0, 0, 0.2];
  assert.equal(averageColors([undefined, undefined]), undefined);
  assert.deepEqual(averageColors([green, green]), [0, 200, 0, 0.2]);
  // Half read: same hue, half the opacity.
  assert.deepEqual(averageColors([green, undefined]), [0, 200, 0, 0.1]);
  // Read and stale mix by share.
  const mix = averageColors([green, green, green, red])!;
  assert.deepEqual(mix.map((v) => Math.round(v * 1000) / 1000), [50, 150, 0, 0.2]);
  assert.deepEqual(quantizeColor([51, 149, 3, 0.1234]), [48, 152, 0, 0.12]);
});

test('fold highlight: weights let a few stale lines dominate', () => {
  const green: [number, number, number, number] = [0, 200, 0, 0.2];
  const red: [number, number, number, number] = [200, 0, 0, 0.2];
  const colors = [green, green, green, green, green, green, green, green, green, red];
  const plain = averageColors(colors)!;
  const weighted = averageColors(colors, [1, 1, 1, 1, 1, 1, 1, 1, 1, 10])!;
  assert.equal(Math.round(plain[0]), 20); // 1 in 10 red
  assert.equal(Math.round(weighted[0]), Math.round((200 * 10) / 19)); // 10 in 19 red
  // An unmarked block with one stale line: the stale weight also raises the opacity.
  const sparse = averageColors([undefined, undefined, undefined, red], [1, 1, 1, 10])!;
  assert.equal(Math.round(sparse[3] * 1000) / 1000, Math.round((0.2 * 10 / 13) * 1000) / 1000);
});

test('line note: default text per kind of mark', () => {
  const H = 3_600_000;
  const lines = ['a', 'b', 'c'];
  const fm = new FileMarks();
  fm.mark(0, 1, READ, T1 - 24 * H, src(lines));
  fm.markTyped(2, 2, T1 - 2 * H, src(lines));
  const read = fm.get(0)!;
  assert.equal(formatLineNote(DEFAULT_LINE_NOTE_FORMATS, read, 'Read', T1, 30 * 24 * H), 'Read · 1d ago');
  assert.equal(formatLineNote(DEFAULT_LINE_NOTE_FORMATS, fm.get(2)!, 'Edited', T1, 30 * 24 * H), 'Edited · 2h ago');
  fm.validate(src(['a', 'B', 'c']), T1 - 5 * H);
  assert.equal(
    formatLineNote(DEFAULT_LINE_NOTE_FORMATS, fm.get(1)!, 'Read', T1, 30 * 24 * H),
    '⚠ changed outside editor 5h ago · was last read 1d ago',
  );
});

test('line note: custom templates, category overrides, dropped segments, hiding', () => {
  const lines = ['a', 'b'];
  const fm = new FileMarks();
  fm.mark(0, 0, 'question', T0, src(lines));
  fm.mark(1, 1, 'next', T0, src(lines));
  const formats = { ...DEFAULT_LINE_NOTE_FORMATS, category: 'cat {label}', question: ['❓ {age}', '{removed:line} gone'], read: '' };
  assert.equal(formatLineNote(formats, fm.get(0)!, 'Question', T1, 1), '❓ 1d');
  assert.equal(formatLineNote(formats, fm.get(1)!, 'Next', T1, 1), 'cat Next');
  const r = new FileMarks();
  r.mark(0, 0, READ, T0, src(lines));
  assert.equal(formatLineNote(formats, r.get(0)!, 'Read', T1, 1), '');
});

test('fold: innermost bracket left open at the end of a line', () => {
  assert.equal(lastUnclosedBracket('def foo('), '(');
  assert.equal(lastUnclosedBracket('    def method(self, a,'), '(');
  assert.equal(lastUnclosedBracket('function foo<T>(a: T,'), '(');
  assert.equal(lastUnclosedBracket('def foo(a, b):'), undefined);
  assert.equal(lastUnclosedBracket('function foo(a) {'), '{');
  assert.equal(lastUnclosedBracket('foo(a, [b, {'), '{');
  assert.equal(lastUnclosedBracket('x = ")(" + f('), '(');
  assert.equal(lastUnclosedBracket('x = 1  # call('), undefined);
  assert.equal(lastUnclosedBracket('const s = `(`; // (('), undefined);
});

test('line note: stale label placeholder', () => {
  const fm = new FileMarks();
  fm.mark(0, 0, READ, T0, src(['a']));
  fm.validate(src(['A']), T1);
  const formats = { ...DEFAULT_LINE_NOTE_FORMATS, stale: '{staleLabel} {staleAge} ago' };
  assert.equal(formatLineNote(formats, fm.get(0)!, 'Read', T1, 1, 'Changed'), 'Changed 1m ago');
});

test('placeholders: case filters', () => {
  const v = new Map<string, number | string | undefined>([['label', 'Read'], ['n', 2], ['cat', 'attend to next']]);
  assert.equal(formatSummary(['was last {label|lower} 5h ago'], v), 'was last read 5h ago');
  assert.equal(formatSummary(['{label|upper}', '{cat|capitalize}', '{n:line|upper}', '{label|bogus}'], v), 'READ · Attend to next · 2 LINES · Read');
  assert.equal(formatSummary(['{missing|lower} x', 'kept'], v), 'kept');
});

test('fold summary: category counts use a plural label when given', () => {
  const lines = ['a', 'b', 'c', 'd'];
  const fm = new FileMarks();
  fm.mark(0, 1, 'question', T0, src(lines));
  fm.mark(2, 2, 'next', T0, src(lines));
  const plural: Record<string, string> = { question: 'Questions' };
  const label: Record<string, string> = { question: 'Question', next: 'Attend to next' };
  const labelFor = (c: string, n: number) => (n !== 1 && plural[c] ? plural[c] : label[c]);
  const v = summaryValues(blockStats(fm, src(lines), 0, 3, T1), labelFor, ['next', 'question']);
  assert.equal(v.get('categories'), '1 Attend to next, 2 Questions');
  fm.clear(1, 1);
  assert.equal(summaryValues(blockStats(fm, src(lines), 0, 3, T1), labelFor, ['next', 'question']).get('categories'), '1 Attend to next, 1 Question');
});
