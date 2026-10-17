/**
 * Run: npx tsx scripts/testCleanup.ts
 */
import assert from 'node:assert/strict';
import {
  buildCleanupKeepRanges,
  keepRangesDuration,
  remapWordsToCleanTimeline,
  sourceToCleanTime,
  type Word,
} from '../server/cut/cleanup';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    console.error(`FAIL  ${name}\n      ${err?.message || err}`);
    process.exitCode = 1;
  }
}

/** Build words from [text, start, end] tuples. */
const W = (...t: Array<[string, number, number]>): Word[] => t.map(([w, start, end]) => ({ w, start, end }));

/** True when source instant t survives in the keep ranges. */
const kept = (ranges: Array<{ start: number; end: number }>, t: number) =>
  ranges.some((r) => t >= r.start && t <= r.end);

test('fillers um/uh are removed (case + punctuation insensitive)', () => {
  const words = W(
    ['Hello', 0.0, 0.4],
    ['Um,', 0.45, 0.7],
    ['this', 0.75, 1.0],
    ['is', 1.02, 1.2],
    ['UH', 1.25, 1.5],
    ['great.', 1.55, 2.0],
  );
  const res = buildCleanupKeepRanges(words, { removeSilences: false, removeFillers: true });
  assert.equal(res.fillersRemoved, 2);
  assert.ok(!kept(res.keepRanges, 0.575), 'um midpoint should be cut');
  assert.ok(!kept(res.keepRanges, 1.375), 'uh midpoint should be cut');
  assert.ok(kept(res.keepRanges, 0.2), 'Hello kept');
  assert.ok(kept(res.keepRanges, 0.875), 'this kept');
  assert.ok(kept(res.keepRanges, 1.8), 'great kept');
  assert.match(res.report, /Removed 2 fillers/);
});

test('removeFillers=false keeps fillers', () => {
  const words = W(['so', 0, 0.2], ['um', 0.25, 0.5], ['yes', 0.55, 0.9]);
  const res = buildCleanupKeepRanges(words, { removeSilences: false, removeFillers: false });
  assert.equal(res.fillersRemoved, 0);
  assert.ok(kept(res.keepRanges, 0.375));
});

test('long gaps are shrunk to keepGap', () => {
  const words = W(['first', 0.0, 0.5], ['second', 2.0, 2.5]);
  const res = buildCleanupKeepRanges(words, { removeFillers: false, maxGapSec: 0.35, keepGapSec: 0.12 });
  assert.equal(res.keepRanges.length, 2);
  const gap = res.keepRanges[1].start - res.keepRanges[0].end;
  assert.ok(gap > 1.3, `cut should leave a hole in source time, gap=${gap}`);
  // 1.5s gap → 0.12 stays → ≈1.38s removed
  assert.ok(Math.abs(res.silenceRemovedSec - 1.38) < 0.02, `silenceRemovedSec=${res.silenceRemovedSec}`);
  // Output duration ≈ 0.5 + 0.12 + 0.5
  assert.ok(Math.abs(keepRangesDuration(res.keepRanges) - 1.12) < 0.03);
});

test('short gaps are untouched', () => {
  const words = W(['a', 0, 0.3], ['b', 0.5, 0.8]);
  const res = buildCleanupKeepRanges(words, { removeFillers: false });
  assert.equal(res.keepRanges.length, 1);
  assert.equal(res.silenceRemovedSec, 0);
});

test('micro pieces under 0.25s are dropped', () => {
  const words = W(
    ['x', 0.0, 0.15],
    ['longgg', 2.0, 3.2],
  );
  const res = buildCleanupKeepRanges(words, {
    removeFillers: false,
    maxGapSec: 0.3,
    keepGapSec: 0.1,
    mergeGapSec: 0.05,
    minPieceSec: 0.25,
  });
  assert.equal(res.keepRanges.length, 1, `expected only the long range, got ${JSON.stringify(res.keepRanges)}`);
  assert.ok(res.keepRanges[0].start >= 1.5, 'micro leading island dropped');
  assert.ok(res.keepRanges[0].end - res.keepRanges[0].start >= 0.25);
});

test('leading dead air is trimmed and trailing filler removed', () => {
  const words = W(['hi', 1.0, 1.3], ['there', 1.35, 1.8], ['um', 1.85, 2.1]);
  const res = buildCleanupKeepRanges(words, {});
  assert.ok(res.keepRanges[0].start > 0.6, `start=${res.keepRanges[0].start}`);
  const last = res.keepRanges[res.keepRanges.length - 1];
  assert.ok(last.end < 2.0, `end=${last.end}`);
});

test('discourse "like" is removed only when surrounded by pauses', () => {
  // Tight "like" — preserved
  const tight = W(['I', 0, 0.1], ['like', 0.12, 0.35], ['pizza', 0.37, 0.8]);
  const rTight = buildCleanupKeepRanges(tight, { removeSilences: false });
  assert.equal(rTight.fillersRemoved, 0);
  assert.ok(kept(rTight.keepRanges, 0.23));

  // Pause before only — preserved
  const half = W(['well', 0, 0.3], ['like', 0.7, 0.95], ['pizza', 0.97, 1.4]);
  assert.equal(buildCleanupKeepRanges(half, { removeSilences: false }).fillersRemoved, 0);

  // Pauses both sides — removed
  const isolated = W(['well', 0, 0.3], ['like', 0.7, 0.95], ['pizza', 1.35, 1.8]);
  const rIso = buildCleanupKeepRanges(isolated, { removeSilences: false });
  assert.equal(rIso.fillersRemoved, 1);
  assert.ok(!kept(rIso.keepRanges, 0.825));
});

test('"you know" removed as a pair only when isolated', () => {
  const isolated = W(['so', 0, 0.2], ['you', 0.6, 0.75], ['know', 0.77, 0.95], ['it', 1.4, 1.6]);
  const r = buildCleanupKeepRanges(isolated, { removeSilences: false });
  assert.equal(r.fillersRemoved, 2);
  const tight = W(['do', 0, 0.2], ['you', 0.22, 0.35], ['know', 0.37, 0.55], ['it', 0.57, 0.8]);
  assert.equal(buildCleanupKeepRanges(tight, { removeSilences: false }).fillersRemoved, 0);
});

test('empty words are handled', () => {
  const res = buildCleanupKeepRanges([]);
  assert.deepEqual(res.keepRanges, []);
  assert.equal(res.fillersRemoved, 0);
  assert.equal(res.silenceRemovedSec, 0);
  assert.match(res.report, /No word timestamps/);
  assert.doesNotThrow(() => buildCleanupKeepRanges(undefined as any));
});

test('timeline remap maps kept words and drops cut ones', () => {
  const words = W(['a', 0, 0.5], ['um', 0.55, 0.8], ['b', 0.85, 1.3]);
  const res = buildCleanupKeepRanges(words, { removeSilences: false });
  const remapped = remapWordsToCleanTimeline(words, res.keepRanges);
  assert.deepEqual(
    remapped.map((w) => w.w),
    ['a', 'b'],
  );
  assert.ok(remapped[1].start < words[2].start, 'b moved earlier on cleaned timeline');
  assert.equal(sourceToCleanTime(0.675, res.keepRanges), null);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ' — with failures' : ''}`);
