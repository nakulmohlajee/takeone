/**
 * Deterministic EDL hole materialization for single-take / UGC polish.
 * DROP ranges become real holes in KEEP ranges. Speech/CTA protected.
 * No Gemini involvement.
 */
import type {
  FootageIntelligence,
  FootageSegment,
  ObservedMoment,
  PlannedClip,
} from '../../src/types/editorial';

export type TimeRange = {
  sourceId: string;
  start: number;
  end: number;
  reason?: string;
  action?: string;
  zoom?: number;
};

export type SafeBoundaryKind = 'word' | 'phrase' | 'pause' | 'sentence';

/** Keep in sync with editPolicy.MIN_USABLE_CLIP_SECONDS */
export const HOLE_MIN_CLIP_SECONDS = 0.8;
const PAUSE_GAP_SECONDS = 1.6;
const TRAILING_CHATTER_PAD = 0.15;

function fmt(r: TimeRange): string {
  return `${r.sourceId} ${r.start.toFixed(1)}–${r.end.toFixed(1)}`;
}

function overlaps(a: TimeRange, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isTinyOuttake(transcript: string | undefined, dur: number): boolean {
  const words = (transcript || '').trim().split(/\s+/).filter(Boolean);
  // Only true single-word vocal filler like "um" or stray click under 0.8s is an outtake
  return dur <= 0.8 && words.length === 1 && /^(um+|uh+|mm+|ah+|hey)$/i.test(words[0]);
}

function looksLikeCtaText(text: string): boolean {
  return /\b(link|bio|follow|subscribe|shop|buy|try|download|comment|dm|check\s*out|today|now|join|get\s*yours?|visit|order|tap|click|share|next\s*time|see\s*you)\b/i.test(
    text
  );
}

/** Moments/segments that are creator speech (not silence-only / filler-only / tiny outtakes). */
export function primarySpeechIntervals(f: FootageIntelligence): Array<{ start: number; end: number; transcript?: string }> {
  const moments = f.observation?.moments || [];
  const fromMoments = moments
    .filter((m, idx, arr) => {
      const t = String(m.momentType || '').toLowerCase();
      if (t === 'silence' || t === 'filler') return false;
      if (m.containsSilence && !(m.transcript || '').trim()) return false;
      const text = (m.transcript || '').trim();
      if (!text && (m.containsSilence || t === 'natural_cut_point')) return false;
      // Never drop the final spoken thought in a take (frequently the CTA)
      const isFinalMoment = idx >= arr.length - 2;
      if (!isFinalMoment && isTinyOuttake(text, m.end - m.start) && !looksLikeCtaText(text)) return false;
      return true;
    })
    .map((m) => ({ start: m.start, end: m.end, transcript: m.transcript }));

  if (fromMoments.length) return mergeAdjacent(fromMoments, 0.35);

  const segs = (f.segments || []).filter((s, idx, arr) => {
    if (s.containsSilence && !(s.transcript || '').trim()) return false;
    const t = String(s.momentType || '').toLowerCase();
    if (t === 'silence' || t === 'filler') return false;
    const text = (s.transcript || '').trim();
    const isFinalSeg = idx >= arr.length - 2;
    if (!isFinalSeg && isTinyOuttake(text, s.end - s.start) && !looksLikeCtaText(text)) return false;
    return Boolean(text) || !s.containsSilence;
  });
  return mergeAdjacent(
    segs.map((s) => ({ start: s.start, end: s.end, transcript: s.transcript })),
    0.35
  );
}

function mergeAdjacent(
  ranges: Array<{ start: number; end: number; transcript?: string }>,
  gap: number
): Array<{ start: number; end: number; transcript?: string }> {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number; transcript?: string }> = [
    { ...sorted[0] },
  ];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end + gap) {
      prev.end = Math.max(prev.end, cur.end);
      if (cur.transcript) {
        prev.transcript = [prev.transcript, cur.transcript].filter(Boolean).join(' ');
      }
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * Last end of primary creator speech, including CTA / final sentence.
 * Prefer ffmpeg audioEnvelope.speechEnd when present (authoritative).
 * Always adds 0.45s safety padding so trailing syllables and room decay are preserved.
 */
export function lastPrimarySpeechEnd(f: FootageIntelligence): number | null {
  const envEnd = f.audioEnvelope?.speechEnd;
  const speech = primarySpeechIntervals(f);
  const momentEnd = speech.length ? speech[speech.length - 1].end : null;
  const raw =
    envEnd != null && envEnd > 0
      ? Math.max(envEnd, momentEnd ?? 0)
      : momentEnd;
  if (raw == null) return null;
  const padded = Math.min(f.sourceDuration, raw + 0.45);
  return padded;
}

/** First start of primary speech (skip pre-roll silence / "3, 2, 1"). */
export function firstPrimarySpeechStart(f: FootageIntelligence): number | null {
  if (f.audioEnvelope?.speechStart != null && f.audioEnvelope.speechStart >= 0) {
    return f.audioEnvelope.speechStart;
  }
  const speech = primarySpeechIntervals(f);
  if (!speech.length) return null;
  return speech[0].start;
}

/**
 * Spoken CTA interval: last completed_thought / last speech cluster with CTA-ish text,
 * or the final primary speech cluster under directed UGC.
 */
export function resolveCtaInterval(
  f: FootageIntelligence,
  opts?: { role?: string; editIntent?: string }
): TimeRange | null {
  const moments = f.observation?.moments || [];
  const speechEnd =
    f.audioEnvelope?.speechEnd != null
      ? Math.min(f.sourceDuration, f.audioEnvelope.speechEnd + 0.45)
      : null;

  const completed = moments.filter((m) => {
    const t = String(m.momentType || '').toLowerCase();
    return t === 'completed_thought' || t === 'speech_beat';
  });

  // Prefer last completed thought that looks like a CTA — extend to envelope speechEnd
  for (let i = completed.length - 1; i >= 0; i--) {
    const m = completed[i];
    const text = m.transcript || '';
    if (looksLikeCtaText(text)) {
      return {
        sourceId: f.sourceId,
        start: m.start,
        end: speechEnd != null ? Math.max(m.end, speechEnd) : m.end,
        reason: 'spoken CTA',
      };
    }
  }
  if (opts?.role === 'cta' || opts?.editIntent === 'cta') {
    for (let i = completed.length - 1; i >= 0; i--) {
      const m = completed[i];
      if ((m.transcript || '').trim()) {
        return {
          sourceId: f.sourceId,
          start: m.start,
          end: speechEnd != null ? Math.max(m.end, speechEnd) : m.end,
          reason: 'spoken CTA (role)',
        };
      }
    }
  }

  const speech = primarySpeechIntervals(f);
  if (!speech.length) {
    if (speechEnd != null && f.audioEnvelope) {
      return {
        sourceId: f.sourceId,
        start: f.audioEnvelope.speechStart,
        end: speechEnd,
        reason: 'spoken CTA (audio envelope)',
      };
    }
    return null;
  }
  // Last substantial speech cluster (≥2s or ≥6 words)
  for (let i = speech.length - 1; i >= 0; i--) {
    const s = speech[i];
    const words = (s.transcript || '').trim().split(/\s+/).filter(Boolean);
    if (s.end - s.start >= 2 || words.length >= 6 || looksLikeCtaText(s.transcript || '')) {
      return {
        sourceId: f.sourceId,
        start: s.start,
        end: speechEnd != null ? Math.max(s.end, speechEnd) : s.end,
        reason: 'spoken CTA (last primary cluster)',
      };
    }
  }
  const last = speech[speech.length - 1];
  return {
    sourceId: f.sourceId,
    start: last.start,
    end: speechEnd != null ? Math.max(last.end, speechEnd) : last.end,
    reason: 'spoken CTA (fallback last speech)',
  };
}

function silenceAndPausePoints(f: FootageIntelligence): number[] {
  const pts: number[] = [];
  const audio = f.observation?.audio;
  for (const r of audio?.silenceRanges || []) {
    pts.push(r.start, r.end);
  }
  for (const m of f.observation?.moments || []) {
    const t = String(m.momentType || '').toLowerCase();
    if (t === 'silence' || m.containsSilence) {
      pts.push(m.start, m.end);
    }
    if (Array.isArray(m.naturalCutPoints)) pts.push(...m.naturalCutPoints);
  }
  for (const s of f.segments || []) {
    if (s.containsSilence) pts.push(s.start, s.end);
    if (Array.isArray(s.naturalCutPoints)) pts.push(...s.naturalCutPoints);
    if (Array.isArray(s.silenceRanges)) {
      for (const r of s.silenceRanges) pts.push(r.start, r.end);
    }
  }
  return pts.filter((n) => Number.isFinite(n));
}

function sentenceBoundaries(f: FootageIntelligence): number[] {
  const pts: number[] = [];
  for (const m of f.observation?.moments || []) {
    const t = String(m.momentType || '').toLowerCase();
    if (t === 'completed_thought' || t === 'natural_cut_point') {
      pts.push(m.start, m.end);
    }
    const text = (m.transcript || '').trim();
    if (/[.!?…]["']?\s*$/.test(text)) pts.push(m.end);
  }
  for (const s of f.segments || []) {
    const text = (s.transcript || '').trim();
    if (/[.!?…]["']?\s*$/.test(text)) pts.push(s.end);
    const t = String(s.momentType || '').toLowerCase();
    if (t === 'completed_thought') pts.push(s.start, s.end);
  }
  return pts;
}

function wordPhraseBoundaries(f: FootageIntelligence): { word: number[]; phrase: number[] } {
  const word: number[] = [];
  const phrase: number[] = [];
  const moments: Array<ObservedMoment | FootageSegment> = [
    ...(f.observation?.moments || []),
    ...(f.segments || []),
  ];
  for (const m of moments) {
    word.push(m.start, m.end);
    const t = String((m as ObservedMoment).momentType || (m as FootageSegment).momentType || '');
    if (t === 'speech_beat' || t === 'completed_thought' || (m.transcript || '').trim().length > 12) {
      phrase.push(m.start, m.end);
    }
  }
  return { word, phrase };
}

/**
 * Nearest safe cut point. Preference: word → phrase → pause → sentence.
 * Never lands inside a primary speech interval when avoidable.
 */
export function nearestSafeBoundary(
  t: number,
  f: FootageIntelligence,
  edge: 'in' | 'out',
  window = 1.25
): number {
  const speech = primarySpeechIntervals(f);
  const inside = speech.find((s) => t > s.start + 0.04 && t < s.end - 0.04);
  if (inside) {
    // Prefer not splitting a spoken thought mid-way
    return edge === 'in' ? inside.start : inside.end;
  }

  const { word, phrase } = wordPhraseBoundaries(f);
  const pauses = silenceAndPausePoints(f);
  const sentences = sentenceBoundaries(f);

  const tiers: Array<{ kind: SafeBoundaryKind; pts: number[] }> = [
    { kind: 'word', pts: word },
    { kind: 'phrase', pts: phrase },
    { kind: 'pause', pts: pauses },
    { kind: 'sentence', pts: sentences },
  ];

  for (const tier of tiers) {
    let best: number | null = null;
    let bestDist = window;
    for (const b of tier.pts) {
      if (!Number.isFinite(b)) continue;
      const d = Math.abs(b - t);
      if (d <= bestDist) {
        // Prefer boundaries on the correct side of the cut when tied
        if (
          best == null ||
          d < bestDist - 1e-6 ||
          (edge === 'in' && b <= t && best > t) ||
          (edge === 'out' && b >= t && best < t)
        ) {
          best = b;
          bestDist = d;
        }
      }
    }
    if (best != null) return clamp(best, 0, f.sourceDuration);
  }
  return clamp(t, 0, f.sourceDuration);
}

/** Subtract range B from range A → 0–2 pieces. */
function subtractOne(
  keep: TimeRange,
  drop: { start: number; end: number }
): TimeRange[] {
  if (!overlaps(keep, drop)) return [keep];
  const out: TimeRange[] = [];
  if (drop.start > keep.start) {
    out.push({ ...keep, end: Math.min(keep.end, drop.start) });
  }
  if (drop.end < keep.end) {
    out.push({
      ...keep,
      start: Math.max(keep.start, drop.end),
      reason: keep.reason,
    });
  }
  return out.filter((r) => r.end - r.start >= 0.01);
}

/**
 * Deterministic: KEEP minus overlapping DROP → keep pieces.
 * Example: KEEP 0.5–41.5, DROP 10–14 → KEEP 0.5–10 + KEEP 14–41.5
 */
export function subtractDropsFromKeeps(
  keeps: TimeRange[],
  drops: TimeRange[],
  minDuration = HOLE_MIN_CLIP_SECONDS
): TimeRange[] {
  let pieces = keeps
    .filter((k) => k.end > k.start)
    .map((k) => ({ ...k }));

  for (const drop of drops) {
    if (drop.end <= drop.start) continue;
    const next: TimeRange[] = [];
    for (const keep of pieces) {
      if (keep.sourceId !== drop.sourceId) {
        next.push(keep);
        continue;
      }
      next.push(...subtractOne(keep, drop));
    }
    pieces = next;
  }

  return pieces
    .filter((p) => p.end - p.start >= minDuration)
    .sort((a, b) => {
      if (a.sourceId !== b.sourceId) return a.sourceId.localeCompare(b.sourceId);
      return a.start - b.start;
    });
}

/**
 * Shrink a drop so it never removes spoken words or the CTA thought.
 * Returns null if nothing safe remains to drop.
 */
export function protectDropRange(
  drop: TimeRange,
  f: FootageIntelligence,
  cta: TimeRange | null
): TimeRange[] {
  if (drop.sourceId !== f.sourceId) return [drop];
  if (drop.end <= drop.start) return [];

  // Start from the drop, carve out protected speech + CTA
  let pieces: TimeRange[] = [{ ...drop }];
  const protectedRanges: Array<{ start: number; end: number }> = [];

  for (const s of primarySpeechIntervals(f)) {
    // Allow dropping pure silence gaps; speech intervals are protected
    protectedRanges.push(s);
  }
  if (cta && cta.sourceId === f.sourceId) {
    protectedRanges.push({ start: cta.start, end: cta.end });
  }
  // Envelope speech window is always protected — Director "dead air" after CTA is wrong if Gemini times are compressed
  if (f.audioEnvelope?.speechEnd != null && f.audioEnvelope.speechEnd > 0) {
    const envStart = f.audioEnvelope.speechStart ?? 0;
    const envEnd = Math.min(f.sourceDuration, f.audioEnvelope.speechEnd + 0.45);
    protectedRanges.push({ start: envStart, end: envEnd });
    // Clip any drop that starts before speechEnd+pad so trailing silence only
    pieces = pieces
      .map((p) => {
        if (p.start < envEnd && p.end > envEnd) {
          return { ...p, start: envEnd };
        }
        if (p.end <= envEnd) return null;
        return p;
      })
      .filter(Boolean) as TimeRange[];
  }

  for (const prot of protectedRanges) {
    const next: TimeRange[] = [];
    for (const p of pieces) {
      next.push(
        ...subtractOne(p, prot).map((r) => ({
          ...r,
          reason: drop.reason,
          action: 'drop' as const,
        }))
      );
    }
    pieces = next;
  }

  // Snap remaining drop edges to safe boundaries (prefer pause/word, not blind sentence)
  const firstSpeech = firstPrimarySpeechStart(f) ?? 0;
  const lastSpeech = lastPrimarySpeechEnd(f) ?? f.sourceDuration;

  const snapped: TimeRange[] = [];
  for (const p of pieces) {
    let start = nearestSafeBoundary(p.start, f, 'in', 0.8);
    let end = nearestSafeBoundary(p.end, f, 'out', 0.8);
    // Ensure we don't expand the drop into speech
    if (start < p.start) start = p.start;
    if (end > p.end) end = p.end;
    // If snap moved inward past each other, skip
    if (end - start < 0.35) continue;

    // Interior check: If this drop is between spoken sentences inside the take (not pre-roll or post-roll),
    // do NOT drop pauses under PAUSE_GAP_SECONDS (1.6–1.8s). Pauses of 0.8s–1.5s are natural breathing cadence;
    // dropping them creates jarring, unnatural face jumps on the creator.
    const isPreRoll = start <= firstSpeech + 0.15;
    const isPostRoll = end >= lastSpeech - 0.15;
    if (!isPreRoll && !isPostRoll && end - start < PAUSE_GAP_SECONDS) {
      console.log(
        `[EDL HOLES] preserved interior pause ${start.toFixed(1)}–${end.toFixed(1)} (${(end - start).toFixed(1)}s < ${PAUSE_GAP_SECONDS}s) to maintain continuous speech flow`
      );
      continue;
    }

    // Re-check CTA
    if (cta && start < cta.end && end > cta.start) {
      if (start < cta.start && cta.start - start >= 0.35) {
        snapped.push({ ...p, start, end: cta.start });
      }
      if (end > cta.end && end - cta.end >= 0.35) {
        snapped.push({ ...p, start: cta.end, end });
      }
      continue;
    }
    snapped.push({ ...p, start, end, action: 'drop' });
  }
  return snapped;
}

/**
 * Interior dead air / non-speech gaps between primary speech clusters → candidate DROPs.
 * Also trims trailing material after lastPrimarySpeechEnd (chatter/"Hey").
 */
export function deriveUgcDeadAirDrops(f: FootageIntelligence): TimeRange[] {
  const drops: TimeRange[] = [];
  const speech = primarySpeechIntervals(f);
  const lastEnd = lastPrimarySpeechEnd(f);
  const firstStart = firstPrimarySpeechStart(f);

  if (firstStart != null && firstStart > 0.35) {
    drops.push({
      sourceId: f.sourceId,
      start: 0,
      end: firstStart,
      action: 'drop',
      reason: 'pre-roll / leading non-speech',
    });
  }

  for (let i = 0; i < speech.length - 1; i++) {
    const gapStart = speech[i].end;
    const gapEnd = speech[i + 1].start;
    const gap = gapEnd - gapStart;
    if (gap < PAUSE_GAP_SECONDS) continue;
    // Skip if the next cluster is a tiny outtake — that whole tail is handled below
    const nextWords = (speech[i + 1].transcript || '').trim().split(/\s+/).filter(Boolean);
    if (
      lastEnd != null &&
      speech[i].end >= lastEnd - 0.05 &&
      nextWords.length <= 3 &&
      speech[i + 1].end - speech[i + 1].start <= 1.5
    ) {
      continue;
    }
    drops.push({
      sourceId: f.sourceId,
      start: gapStart,
      end: gapEnd,
      action: 'drop',
      reason: `interior dead air ${gap.toFixed(1)}s`,
    });
  }

  if (lastEnd != null && lastEnd < f.sourceDuration - 0.35) {
    drops.push({
      sourceId: f.sourceId,
      start: lastEnd,
      end: f.sourceDuration,
      action: 'drop',
      reason: 'trailing non-speech / outtake after primary speech',
    });
  }

  return drops;
}

export type MaterializeResult = {
  keepsBefore: TimeRange[];
  drops: TimeRange[];
  keepsAfter: TimeRange[];
};

/**
 * Resolve overlapping KEEP ranges on the same source without unioning to a full take.
 * Earlier keep is clamped to the later keep's start when nested/partial overlap.
 */
export function resolveOverlappingKeepRanges(
  keeps: TimeRange[],
  minDuration = HOLE_MIN_CLIP_SECONDS
): TimeRange[] {
  const bySource = new Map<string, TimeRange[]>();
  for (const k of keeps) {
    if (k.end <= k.start) continue;
    const list = bySource.get(k.sourceId) || [];
    list.push({ ...k });
    bySource.set(k.sourceId, list);
  }
  const out: TimeRange[] = [];
  for (const [, list] of bySource) {
    const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
    const resolved: TimeRange[] = [];
    for (const k of sorted) {
      let cur = { ...k };
      // Against all already accepted keeps
      for (let i = 0; i < resolved.length; i++) {
        const prev = resolved[i];
        if (cur.start >= prev.end - 0.05) continue;
        // cur starts inside prev → clamp prev.end
        if (cur.start > prev.start && cur.start < prev.end) {
          if (cur.start - prev.start >= minDuration) {
            resolved[i] = { ...prev, end: cur.start };
          } else {
            resolved.splice(i, 1);
            i--;
          }
          continue;
        }
        // cur fully nested in prev → keep cur, split/trim prev
        if (cur.start >= prev.start - 0.05 && cur.end <= prev.end + 0.05) {
          const left = { ...prev, end: cur.start };
          const right = { ...prev, start: cur.end, reason: prev.reason };
          resolved.splice(i, 1);
          i--;
          if (left.end - left.start >= minDuration) resolved.push(left);
          if (right.end - right.start >= minDuration) resolved.push(right);
          resolved.sort((a, b) => a.start - b.start);
          continue;
        }
        // prev nested in cur → keep prev, trim cur
        if (prev.start >= cur.start - 0.05 && prev.end <= cur.end + 0.05) {
          const leftDur = prev.start - cur.start;
          const rightDur = cur.end - prev.end;
          if (leftDur >= minDuration) {
            resolved.push({ ...cur, end: prev.start });
          }
          if (rightDur >= minDuration) {
            cur = { ...cur, start: prev.end };
          } else {
            cur = { ...cur, end: cur.start }; // mark invalid
          }
        }
      }
      if (cur.end - cur.start >= minDuration) {
        // Dedupe identical
        const dup = resolved.some(
          (r) =>
            Math.abs(r.start - cur.start) < 0.05 && Math.abs(r.end - cur.end) < 0.05
        );
        if (!dup) resolved.push(cur);
      }
      resolved.sort((a, b) => a.start - b.start);
    }
    out.push(...resolved.filter((r) => r.end - r.start >= minDuration));
  }
  return out.sort((a, b) => {
    if (a.sourceId !== b.sourceId) return a.sourceId.localeCompare(b.sourceId);
    return a.start - b.start;
  });
}

/**
 * Full materialization pipeline for one or more sources:
 * collect keeps + drops → protect drops → subtract → log.
 */
export function materializeKeepHoles(opts: {
  keeps: TimeRange[];
  drops: TimeRange[];
  intel: FootageIntelligence[];
  /** When true, also derive dead-air / trailing-chatter drops */
  ugcSingleTake?: boolean;
  minDuration?: number;
}): MaterializeResult {
  const minDuration = opts.minDuration ?? HOLE_MIN_CLIP_SECONDS;
  const intelById = new Map(opts.intel.map((f) => [f.sourceId, f]));

  let keepsBefore = opts.keeps
    .filter((k) => k.end > k.start)
    .map((k) => ({ ...k }));

  // Collapse nested/overlapping director keeps before DROP subtraction
  keepsBefore = resolveOverlappingKeepRanges(keepsBefore, minDuration);

  // UGC: if spoken CTA is not covered by any keep, add it (director often
  // emits body KEEP + pause DROP and forgets a second KEEP after the hole).
  if (opts.ugcSingleTake) {
    for (const f of opts.intel) {
      const cta = resolveCtaInterval(f, { role: 'cta', editIntent: 'cta' });
      if (!cta) continue;
      const covered = keepsBefore.some(
        (k) =>
          k.sourceId === f.sourceId &&
          Math.min(k.end, cta.end) - Math.max(k.start, cta.start) >=
            Math.min(minDuration, (cta.end - cta.start) * 0.7)
      );
      if (!covered) {
        keepsBefore.push({
          sourceId: f.sourceId,
          start: cta.start,
          end: cta.end,
          action: 'keep',
          reason: 'spoken CTA (ensured)',
        });
        console.log(
          `[EDL HOLES] ensured CTA keep ${f.sourceId} ${cta.start.toFixed(1)}–${cta.end.toFixed(1)}`
        );
      }
    }
  }

  let rawDrops = opts.drops.filter((d) => d.end > d.start).map((d) => ({ ...d }));

  if (opts.ugcSingleTake) {
    for (const f of opts.intel) {
      rawDrops.push(...deriveUgcDeadAirDrops(f));
    }
  }

  // Protect each drop against speech + CTA
  const protectedDrops: TimeRange[] = [];
  for (const d of rawDrops) {
    const f = intelById.get(d.sourceId);
    if (!f) {
      protectedDrops.push(d);
      continue;
    }
    const cta = resolveCtaInterval(f, { role: 'cta', editIntent: 'cta' });
    const pieces = protectDropRange(d, f, cta);
    protectedDrops.push(...pieces);
  }

  // Deduplicate / merge overlapping drops per source
  const mergedDrops = mergeDropRanges(protectedDrops);

  const keepsAfter = subtractDropsFromKeeps(keepsBefore, mergedDrops, minDuration);

  // For UGC: snap keep edges to safe boundaries and trim trailing nonspeech
  const finalKeeps = opts.ugcSingleTake
    ? keepsAfter.map((k) => snapKeepEdges(k, intelById.get(k.sourceId)))
    : keepsAfter;

  console.log(
    `[EDL HOLES] before: keeps=[${keepsBefore.map(fmt).join('; ')}] drops=[${mergedDrops.map(fmt).join('; ')}]`
  );
  console.log(
    `[EDL HOLES] after: keeps=[${finalKeeps.map(fmt).join('; ')}]`
  );

  return { keepsBefore, drops: mergedDrops, keepsAfter: finalKeeps };
}

function mergeDropRanges(drops: TimeRange[]): TimeRange[] {
  const bySource = new Map<string, TimeRange[]>();
  for (const d of drops) {
    const list = bySource.get(d.sourceId) || [];
    list.push(d);
    bySource.set(d.sourceId, list);
  }
  const out: TimeRange[] = [];
  for (const [sourceId, list] of bySource) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let cur: TimeRange | null = null;
    for (const d of sorted) {
      if (!cur) {
        cur = { ...d };
        continue;
      }
      if (d.start <= cur.end + 0.05) {
        cur.end = Math.max(cur.end, d.end);
        cur.reason = cur.reason || d.reason;
      } else {
        out.push(cur);
        cur = { ...d };
      }
    }
    if (cur) out.push(cur);
    void sourceId;
  }
  return out;
}

function snapKeepEdges(keep: TimeRange, f: FootageIntelligence | undefined): TimeRange {
  if (!f) return keep;
  let start = nearestSafeBoundary(keep.start, f, 'in', 0.6);
  let end = nearestSafeBoundary(keep.end, f, 'out', 0.6);
  // Never expand beyond the materialized keep (would re-include DROP holes)
  if (start < keep.start) start = keep.start;
  if (end > keep.end) end = keep.end;
  if (end - start < HOLE_MIN_CLIP_SECONDS) return keep;

  const firstSpeech = firstPrimarySpeechStart(f);
  // If this keep covers the beginning of the take (the opening hook):
  // Cleanly trim any pre-speech mouth noise, breaths, or preamble silence before speech begins
  if (
    firstSpeech != null &&
    keep.start <= firstSpeech + 0.15 &&
    firstSpeech > keep.start
  ) {
    const cleanStart = Math.max(keep.start, firstSpeech - 0.04);
    if (end - cleanStart >= HOLE_MIN_CLIP_SECONDS) {
      start = cleanStart;
    }
  }

  const lastSpeech = lastPrimarySpeechEnd(f);
  // Trim trailing nonspeech on the keep that covers last primary speech
  if (
    lastSpeech != null &&
    keep.start <= lastSpeech &&
    keep.end >= lastSpeech - 0.05
  ) {
    end = Math.min(end, Math.max(start + HOLE_MIN_CLIP_SECONDS, lastSpeech + TRAILING_CHATTER_PAD));
  }
  return { ...keep, start, end };
}

export type EdlValidationIssue = { code: string; message: string };

/**
 * Deterministic post-revision / post-plan checks for UGC single-take EDLs.
 */
export function validateUgcEdlSequence(
  sequence: PlannedClip[],
  intel: FootageIntelligence[],
  intentionalHoles: TimeRange[] = []
): { ok: boolean; errors: EdlValidationIssue[] } {
  const errors: EdlValidationIssue[] = [];
  const intelById = new Map(intel.map((f) => [f.sourceId, f]));
  const aroll = sequence.filter((c) => !c.isBroll);

  for (const c of aroll) {
    const f = intelById.get(c.sourceId);
    const dur = c.end - c.start;
    if (dur < HOLE_MIN_CLIP_SECONDS) {
      errors.push({
        code: 'min_duration',
        message: `${c.id} duration ${dur.toFixed(2)}s < ${HOLE_MIN_CLIP_SECONDS}s`,
      });
    }
    if (f) {
      if (c.start < -0.01 || c.end > f.sourceDuration + 0.05 || c.end <= c.start) {
        errors.push({
          code: 'source_range',
          message: `${c.id} invalid source range ${c.start.toFixed(2)}–${c.end.toFixed(2)} (src ${f.sourceDuration})`,
        });
      }
      // Mid-word: boundary deep inside a speech interval (not near edges)
      for (const edge of [c.start, c.end] as const) {
        const speech = primarySpeechIntervals(f).find(
          (s) => edge > s.start + 0.12 && edge < s.end - 0.12
        );
        if (speech) {
          errors.push({
            code: 'speech_boundary',
            message: `${c.id} boundary ${edge.toFixed(2)} inside speech ${speech.start.toFixed(2)}–${speech.end.toFixed(2)}`,
          });
        }
      }
    }
  }

  // Chronological order + no accidental overlap per source
  const bySource = new Map<string, PlannedClip[]>();
  for (const c of aroll) {
    const list = bySource.get(c.sourceId) || [];
    list.push(c);
    bySource.set(c.sourceId, list);
  }
  for (const [sourceId, clips] of bySource) {
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (cur.start < prev.end - 0.05) {
          errors.push({
            code: 'overlap',
            message: `${prev.id}/${cur.id} overlap on ${sourceId}`,
          });
        }
        if (cur.start > prev.end + 0.08) {
          const hole = { start: prev.end, end: cur.start };
          const intentional = intentionalHoles.some(
            (h) =>
              h.sourceId === sourceId &&
              h.start <= hole.start + 0.15 &&
              h.end >= hole.end - 0.15
          );
          // Gaps are OK only as intentional DROP holes for UGC jump cuts
          if (!intentional && hole.end - hole.start < PAUSE_GAP_SECONDS) {
            // small accidental gap — flag
            errors.push({
              code: 'accidental_gap',
              message: `${prev.id}→${cur.id} accidental gap ${hole.start.toFixed(2)}–${hole.end.toFixed(2)}`,
            });
          }
        }
      }
    }
    // Timeline order of clips for this source should match source chronology
    for (let i = 1; i < clips.length; i++) {
      const prevIdx = aroll.indexOf(clips[i - 1]);
      const curIdx = aroll.indexOf(clips[i]);
      if (prevIdx >= 0 && curIdx >= 0 && curIdx < prevIdx && clips[i].start > clips[i - 1].end) {
        // later source time appears earlier in timeline → reorder
        errors.push({
          code: 'order',
          message: `source ${sourceId} clips out of narrative order`,
        });
      }
    }
  }

  // CTA preservation: last primary speech / CTA interval must be mostly covered
  for (const f of intel) {
    const cta = resolveCtaInterval(f, { role: 'cta', editIntent: 'cta' });
    if (!cta) continue;
    const coverage = aroll
      .filter((c) => c.sourceId === f.sourceId)
      .reduce((acc, c) => {
        const s = Math.max(c.start, cta.start);
        const e = Math.min(c.end, cta.end);
        return acc + Math.max(0, e - s);
      }, 0);
    const need = cta.end - cta.start;
    if (need >= 0.8 && coverage < need * 0.85) {
      errors.push({
        code: 'cta',
        message: `CTA ${cta.start.toFixed(1)}–${cta.end.toFixed(1)} only ${coverage.toFixed(1)}s covered of ${need.toFixed(1)}s`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** True when ranges are effectively unchanged (no-op mutation). */
export function isNoOpRange(
  before: { start: number; end: number },
  after: { start: number; end: number },
  eps = 0.04
): boolean {
  return (
    Math.abs(before.start - after.start) < eps && Math.abs(before.end - after.end) < eps
  );
}

/**
 * Hard invariant: non-broll clips on the same sourceId must not overlap.
 * Returns human-readable errors (empty = ok).
 */
export function assertNoSourceOverlap(
  sequence: PlannedClip[],
  eps = 0.05
): string[] {
  const errors: string[] = [];
  const bySource = new Map<string, PlannedClip[]>();
  for (const c of sequence) {
    if (c.isBroll || c.role === 'broll') continue;
    const list = bySource.get(c.sourceId) || [];
    list.push(c);
    bySource.set(c.sourceId, list);
  }
  for (const [sourceId, clips] of bySource) {
    const sorted = [...clips].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start < prev.end - eps) {
        errors.push(
          `${prev.id}/${cur.id} overlap on ${sourceId}: source ${prev.start.toFixed(1)}–${prev.end.toFixed(1)} vs ${cur.start.toFixed(1)}–${cur.end.toFixed(1)}`
        );
      }
    }
  }
  return errors;
}

export function hasSourceOverlap(sequence: PlannedClip[]): boolean {
  return assertNoSourceOverlap(sequence).length > 0;
}

/**
 * Repair accidental same-source overlaps without unioning into one long take.
 * - If B starts inside A: set A.end = B.start
 * - If A fully contains B: keep B; split A into left/right remainders ≥ minDuration
 * - Drop pieces shorter than minDuration
 * Preserves timeline order of clip ids.
 */
export function repairSourceOverlaps(
  sequence: PlannedClip[],
  minDuration = HOLE_MIN_CLIP_SECONDS
): { sequence: PlannedClip[]; repairs: string[] } {
  const repairs: string[] = [];
  const out = sequence.map((c) => ({ ...c }));

  // Iterate until stable (nested overlaps can cascade)
  for (let pass = 0; pass < 8; pass++) {
    const arollIdx = out
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.isBroll && c.role !== 'broll');

    const bySource = new Map<string, Array<{ c: PlannedClip; i: number }>>();
    for (const row of arollIdx) {
      const list = bySource.get(row.c.sourceId) || [];
      list.push(row);
      bySource.set(row.c.sourceId, list);
    }

    let changed = false;
    const toSplice: Array<{ at: number; remove: number; insert: PlannedClip[] }> = [];

    for (const [sourceId, rows] of bySource) {
      const sorted = [...rows].sort((a, b) => a.c.start - b.c.start || a.c.end - b.c.end);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          // Re-read live objects from out (may have been mutated)
          const A = out[a.i];
          const B = out[b.i];
          if (!A || !B || A.isBroll || B.isBroll) continue;
          if (B.start >= A.end - 0.05) continue;

          // Fully nested: A contains B
          if (B.start >= A.start - 0.05 && B.end <= A.end + 0.05) {
            const leftDur = B.start - A.start;
            const rightDur = A.end - B.end;
            const pieces: PlannedClip[] = [];
            if (leftDur >= minDuration) {
              pieces.push({ ...A, end: B.start });
            }
            // Keep B as-is (already in sequence)
            if (rightDur >= minDuration) {
              pieces.push({
                ...A,
                id: `${A.id}_r`,
                start: B.end,
                end: A.end,
              });
            }
            const before = `${A.start.toFixed(1)}–${A.end.toFixed(1)}`;
            if (pieces.length === 0) {
              // Drop outer entirely
              toSplice.push({ at: a.i, remove: 1, insert: [] });
              repairs.push(
                `overlap repair ${sourceId}: dropped outer ${A.id} ${before} (nested in ${B.id})`
              );
            } else if (pieces.length === 1 && rightDur < minDuration) {
              out[a.i] = pieces[0];
              repairs.push(
                `overlap repair ${A.id}: ${before} → ${pieces[0].start.toFixed(1)}–${pieces[0].end.toFixed(1)} (trim before ${B.id})`
              );
            } else if (pieces.length === 1 && leftDur < minDuration) {
              out[a.i] = pieces[0];
              repairs.push(
                `overlap repair ${A.id}: ${before} → ${pieces[0].start.toFixed(1)}–${pieces[0].end.toFixed(1)} (trim after ${B.id})`
              );
            } else {
              toSplice.push({ at: a.i, remove: 1, insert: pieces });
              repairs.push(
                `overlap repair ${A.id}: ${before} split around ${B.id} → ${pieces
                  .map((p) => `${p.start.toFixed(1)}–${p.end.toFixed(1)}`)
                  .join(' + ')}`
              );
            }
            changed = true;
            break;
          }

          // Partial overlap: B starts inside A
          if (B.start > A.start && B.start < A.end) {
            const before = `${A.start.toFixed(1)}–${A.end.toFixed(1)}`;
            const bBefore = `${B.start.toFixed(1)}–${B.end.toFixed(1)}`;
            const bRemaining = B.end - A.end;

            // 1. If B has enough usable room, ripple B.start forward to let A complete thought
            if (bRemaining >= minDuration) {
              out[b.i] = { ...B, start: A.end };
              repairs.push(
                `overlap ripple ${B.id}: ${bBefore} → ${A.end.toFixed(1)}–${B.end.toFixed(1)} (after extended ${A.id})`
              );
              changed = true;
              break;
            }

            // 2. If B is almost fully covered by A and belongs to the same flow, merge them
            if (A.role === B.role || B.role === 'context' || B.role === 'explanation') {
              out[a.i] = { ...A, end: Math.max(A.end, B.end) };
              toSplice.push({ at: b.i, remove: 1, insert: [] });
              repairs.push(
                `overlap merge ${A.id} + ${B.id} → ${A.start.toFixed(1)}–${Math.max(A.end, B.end).toFixed(1)}`
              );
              changed = true;
              break;
            }

            // 3. Fallback: clamp A.end = B.start
            const newEnd = B.start;
            if (newEnd - A.start < minDuration) {
              toSplice.push({ at: a.i, remove: 1, insert: [] });
              repairs.push(
                `overlap repair ${sourceId}: dropped ${A.id} ${before} (too short after clamp to ${B.id})`
              );
            } else {
              out[a.i] = { ...A, end: newEnd };
              repairs.push(
                `overlap repair ${A.id}: ${before} → ${A.start.toFixed(1)}–${newEnd.toFixed(1)} (before ${B.id})`
              );
            }
            changed = true;
            break;
          }

          // B starts at/before A but ends after A.start (shouldn't happen after sort) — clamp B
          if (A.start < B.end && B.start <= A.start) {
            const before = `${B.start.toFixed(1)}–${B.end.toFixed(1)}`;
            const newStart = A.end;
            if (B.end - newStart < minDuration) {
              toSplice.push({ at: b.i, remove: 1, insert: [] });
              repairs.push(
                `overlap repair ${sourceId}: dropped ${B.id} ${before} (too short after clamp)`
              );
            } else {
              out[b.i] = { ...B, start: newStart };
              repairs.push(
                `overlap repair ${B.id}: ${before} → ${newStart.toFixed(1)}–${B.end.toFixed(1)}`
              );
            }
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (changed) break;
    }

    // Apply splices from highest index so indices stay valid
    if (toSplice.length) {
      toSplice.sort((a, b) => b.at - a.at);
      for (const s of toSplice) {
        out.splice(s.at, s.remove, ...s.insert);
      }
    }

    // Drop micro-clips
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      if (!c.isBroll && c.end - c.start < minDuration) {
        repairs.push(`overlap repair: dropped micro-clip ${c.id} ${(c.end - c.start).toFixed(2)}s`);
        out.splice(i, 1);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return { sequence: out, repairs };
}

/**
 * Lightweight validator for creative_recut / general EDLs:
 * overlap, min duration, source range validity.
 */
export function validateGeneralEdlSequence(
  sequence: PlannedClip[],
  intel: FootageIntelligence[]
): { ok: boolean; errors: EdlValidationIssue[] } {
  const errors: EdlValidationIssue[] = [];
  const intelById = new Map(intel.map((f) => [f.sourceId, f]));

  for (const msg of assertNoSourceOverlap(sequence)) {
    errors.push({ code: 'overlap', message: msg });
  }

  for (const c of sequence) {
    if (c.isBroll) continue;
    const dur = c.end - c.start;
    if (dur < HOLE_MIN_CLIP_SECONDS) {
      errors.push({
        code: 'min_duration',
        message: `${c.id} duration ${dur.toFixed(2)}s < ${HOLE_MIN_CLIP_SECONDS}s`,
      });
    }
    const f = intelById.get(c.sourceId);
    if (f && (c.start < -0.01 || c.end > f.sourceDuration + 0.05 || c.end <= c.start)) {
      errors.push({
        code: 'source_range',
        message: `${c.id} invalid source range ${c.start.toFixed(2)}–${c.end.toFixed(2)}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}
