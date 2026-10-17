/**
 * Transcript-driven cleanup: remove filler words and shrink dead air.
 * Pure functions only (no I/O) so they are trivially unit-testable.
 */

export type Word = { w: string; start: number; end: number; conf?: number };
export type KeepRange = { start: number; end: number };

export type CleanupOptions = {
  removeSilences?: boolean;
  removeFillers?: boolean;
  /** Interior gaps longer than this are shrunk (default 0.6s). */
  maxGapSec?: number;
  /** Gap length that remains after shrinking (default 0.3s). */
  keepGapSec?: number;
  language?: string;
  /** Inset applied to filler cuts so neighbouring syllables are not clipped (default 0.06s). */
  edgePadSec?: number;
  /** Hard stop for the final keep range (source media duration), if known. */
  durationSec?: number;
  /**
   * Stitch keep ranges separated by less than this (default 0.05s).
   * Keep small — larger values would undo short filler cuts.
   */
  mergeGapSec?: number;
  /**
   * Absorb true micro keep-ranges shorter than this into a neighbour (default 0.25s).
   * Must stay below typical filler duration so filler cuts are not undone.
   */
  minPieceSec?: number;
};

export type CleanupResult = {
  keepRanges: KeepRange[];
  fillersRemoved: number;
  silenceRemovedSec: number;
  report: string;
};

type Interval = { start: number; end: number };

/** Hesitation sounds — always removed when removeFillers is on. */
const HESITATION_RE = /^(u+m+|u+h+|e+r+m*|h+m+|a+h+|e+h+)$/;
/** Discourse fillers — only removed when isolated by pauses. */
const DISCOURSE_SINGLE = new Set(['like', 'basically', 'literally']);
const DISCOURSE_PAUSE_SEC = 0.25;

export function normalizeWordToken(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, '');
}

function isEnglish(language?: string): boolean {
  if (!language) return true;
  const l = language.toLowerCase();
  return l === 'auto' || l.startsWith('en');
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + 1e-6) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Length of union(a) that is not covered by union(b). */
function lengthMinus(a: Interval[], b: Interval[]): number {
  const ma = mergeIntervals(a);
  const mb = mergeIntervals(b);
  let total = 0;
  for (const seg of ma) {
    let cursor = seg.start;
    for (const cut of mb) {
      if (cut.end <= cursor) continue;
      if (cut.start >= seg.end) break;
      if (cut.start > cursor) total += cut.start - cursor;
      cursor = Math.max(cursor, cut.end);
      if (cursor >= seg.end) break;
    }
    if (cursor < seg.end) total += seg.end - cursor;
  }
  return total;
}

/** Return indexes of words that should be cut as fillers. */
export function detectFillerIndexes(
  words: Word[],
  opts?: { language?: string; discoursePauseSec?: number },
): Set<number> {
  const out = new Set<number>();
  const pause = opts?.discoursePauseSec ?? DISCOURSE_PAUSE_SEC;
  const english = isEnglish(opts?.language);
  const tokens = words.map((w) => normalizeWordToken(w.w));

  const gapBefore = (i: number) => (i <= 0 ? Infinity : words[i].start - words[i - 1].end);
  const gapAfter = (i: number) => (i >= words.length - 1 ? Infinity : words[i + 1].start - words[i].end);

  for (let i = 0; i < words.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (HESITATION_RE.test(t)) {
      out.add(i);
      continue;
    }
    if (!english) continue;
    if (DISCOURSE_SINGLE.has(t) && gapBefore(i) >= pause && gapAfter(i) >= pause) {
      out.add(i);
      continue;
    }
    if (t === 'you' && tokens[i + 1] === 'know') {
      // "you know" — must be isolated as a pair, and the words themselves tight
      const inner = words[i + 1].start - words[i].end;
      if (inner < 0.2 && gapBefore(i) >= pause && gapAfter(i + 1) >= pause) {
        out.add(i);
        out.add(i + 1);
        i += 1;
      }
    }
  }
  return out;
}

export function buildCleanupKeepRanges(words: Word[], opts?: CleanupOptions): CleanupResult {
  const removeSilences = opts?.removeSilences ?? true;
  const removeFillers = opts?.removeFillers ?? true;
  const maxGap = opts?.maxGapSec ?? 0.6;
  const keepGap = Math.min(opts?.keepGapSec ?? 0.3, maxGap);
  const edgePad = opts?.edgePadSec ?? 0.06;
  const mergeGap = opts?.mergeGapSec ?? 0.05;
  const minPiece = opts?.minPieceSec ?? 0.25;

  const clean = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && String(w.w || '').trim())
    .map((w) => ({ ...w, end: w.end > w.start ? w.end : w.start + 0.05 }))
    .sort((a, b) => a.start - b.start);

  if (!clean.length) {
    return {
      keepRanges: [],
      fillersRemoved: 0,
      silenceRemovedSec: 0,
      report: 'No word timestamps — cleanup skipped.',
    };
  }

  const fillerIdx = removeFillers
    ? detectFillerIndexes(clean, { language: opts?.language })
    : new Set<number>();
  const kept = clean.map((w, i) => ({ w, i })).filter((x) => !fillerIdx.has(x.i));

  const lastEnd = clean[clean.length - 1].end;
  const hardEnd = opts?.durationSec && opts.durationSec > 0 ? Math.max(lastEnd, opts.durationSec) : lastEnd;

  // Everything was a filler — nothing meaningful to keep; return the whole span untouched
  if (!kept.length) {
    return {
      keepRanges: [{ start: Math.max(0, clean[0].start), end: lastEnd }],
      fillersRemoved: 0,
      silenceRemovedSec: 0,
      report: 'Only filler words detected — left untouched.',
    };
  }

  const fillerCuts: Interval[] = [];
  for (const i of fillerIdx) {
    const w = clean[i];
    const s = w.start + edgePad;
    const e = w.end - edgePad;
    if (e > s) fillerCuts.push({ start: s, end: e });
  }

  const gapCuts: Interval[] = [];
  if (removeSilences) {
    // Leading dead air
    const first = kept[0].w;
    const headEnd = first.start - keepGap;
    if (headEnd > 0.05) gapCuts.push({ start: 0, end: headEnd });

    // Interior gaps (a gap may contain removed fillers — the whole region is treated as dead air)
    for (let k = 0; k < kept.length - 1; k++) {
      const a = kept[k].w;
      const b = kept[k + 1].w;
      const gap = b.start - a.end;
      if (gap > maxGap) {
        const half = keepGap / 2;
        const s = a.end + half;
        const e = b.start - half;
        if (e > s) gapCuts.push({ start: s, end: e });
      }
    }
  }

  // Trailing: cut after the last kept word (+ tiny tail) when trailing fillers or known trailing silence exist
  const lastKept = kept[kept.length - 1].w;
  const tailEnd = Math.min(hardEnd, lastKept.end + keepGap);
  const trailingFiller = clean[clean.length - 1] !== lastKept;
  if (hardEnd > tailEnd + 0.05 && (removeSilences || trailingFiller)) {
    gapCuts.push({ start: tailEnd, end: hardEnd });
  }

  const allCuts = mergeIntervals([...fillerCuts, ...gapCuts]);
  const silenceRemovedSec = removeSilences ? lengthMinus(gapCuts, fillerCuts) : 0;

  // Keep = [0, hardEnd] minus cuts
  const keepRanges: KeepRange[] = [];
  let cursor = 0;
  for (const cut of allCuts) {
    if (cut.start > cursor + 0.04) keepRanges.push({ start: round3(cursor), end: round3(cut.start) });
    cursor = Math.max(cursor, cut.end);
  }
  if (hardEnd > cursor + 0.04) keepRanges.push({ start: round3(cursor), end: round3(hardEnd) });

  // Drop slivers and stitch ranges that ended up contiguous or nearly so
  const stitched: KeepRange[] = [];
  for (const r of keepRanges) {
    if (r.end - r.start < 0.05) continue;
    const last = stitched[stitched.length - 1];
    if (last && r.start - last.end < Math.max(0.005, mergeGap)) {
      // Absorb the tiny cut between them so short gaps don't become hard joins
      last.end = r.end;
    } else {
      stitched.push({ ...r });
    }
  }

  // Drop true micro-ranges (< minPiece) rather than extending through cuts (extending
  // would undo filler holes). Keep at least one range if everything was short.
  let coalesced = stitched.filter((r) => r.end - r.start >= minPiece);
  if (!coalesced.length && stitched.length) {
    coalesced = [{ ...stitched.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)) }];
  }

  const fillersRemoved = fillerIdx.size;
  const silRounded = Math.round(silenceRemovedSec * 10) / 10;
  const report =
    fillersRemoved || silRounded
      ? `Removed ${fillersRemoved} filler${fillersRemoved === 1 ? '' : 's'} and ${silRounded.toFixed(1)}s of dead air.`
      : 'Nothing to clean — take was already tight.';

  return {
    keepRanges: coalesced,
    fillersRemoved,
    silenceRemovedSec: Math.round(silenceRemovedSec * 1000) / 1000,
    report,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* ───────────── timeline remapping helpers (source time ↔ cleaned time) ───────────── */

/** Sum of keep-range durations. */
export function keepRangesDuration(ranges: KeepRange[]): number {
  return ranges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0);
}

/**
 * Map a source-time instant onto the cleaned timeline.
 * Returns null if the instant falls inside a cut (unless snap is set — then it snaps to the next kept instant).
 */
export function sourceToCleanTime(t: number, ranges: KeepRange[], opts?: { snap?: boolean }): number | null {
  let acc = 0;
  for (const r of ranges) {
    if (t >= r.start - 1e-6 && t <= r.end + 1e-6) return acc + Math.max(0, t - r.start);
    if (t < r.start) return opts?.snap ? acc : null;
    acc += r.end - r.start;
  }
  return opts?.snap ? acc : null;
}

/** Remap words onto the cleaned timeline; words fully inside a cut are dropped. */
export function remapWordsToCleanTimeline(words: Word[], ranges: KeepRange[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (sourceToCleanTime(mid, ranges) == null) continue;
    const s = sourceToCleanTime(w.start, ranges, { snap: true }) ?? 0;
    const e = sourceToCleanTime(w.end, ranges, { snap: true }) ?? s;
    out.push({ ...w, start: round3(s), end: round3(Math.max(e, s + 0.04)) });
  }
  return out;
}
