/**
 * Client+server speech helpers (no Node APIs).
 * Prefer audioEnvelope when present; pad speechEnd like edlHoles.lastPrimarySpeechEnd.
 */
import type { AudioEnvelope, FootageIntelligence } from '../types/editorial';

const SPEECH_END_PAD = 0.45;
const PAUSE_SNAP_MAX = 0.6;

/** Last end of primary speech (+ pad). Prefer ffmpeg audioEnvelope.speechEnd. */
export function lastPrimarySpeechEnd(f: FootageIntelligence | null | undefined): number | null {
  if (!f) return null;
  const envEnd = f.audioEnvelope?.speechEnd;
  const moments = f.observation?.moments || [];
  const speechMoments = moments.filter((m) => {
    const t = String(m.momentType || '').toLowerCase();
    if (t === 'silence' || t === 'filler') return false;
    if (m.containsSilence && !(m.transcript || '').trim()) return false;
    return true;
  });
  const momentEnd = speechMoments.length
    ? speechMoments[speechMoments.length - 1].end
    : null;
  const segs = (f.segments || []).filter((s) => (s.transcript || '').trim());
  const segEnd = segs.length ? segs[segs.length - 1].end : null;
  const raw =
    envEnd != null && envEnd > 0
      ? Math.max(envEnd, momentEnd ?? 0, segEnd ?? 0)
      : momentEnd ?? segEnd;
  if (raw == null) return null;
  const dur = f.sourceDuration || f.audioEnvelope?.duration || raw + SPEECH_END_PAD;
  return Math.min(dur, raw + SPEECH_END_PAD);
}

/** First start of primary speech (skip pre-roll). */
export function firstPrimarySpeechStart(f: FootageIntelligence | null | undefined): number | null {
  if (!f) return null;
  if (f.audioEnvelope?.speechStart != null && f.audioEnvelope.speechStart >= 0) {
    return f.audioEnvelope.speechStart;
  }
  const moments = f.observation?.moments || [];
  for (const m of moments) {
    const t = String(m.momentType || '').toLowerCase();
    if (t === 'silence' || t === 'filler') continue;
    if ((m.transcript || '').trim()) return m.start;
  }
  const seg = (f.segments || []).find((s) => (s.transcript || '').trim());
  return seg ? seg.start : null;
}

/** Snap a cut to nearest pause boundary within maxDist. */
export function snapCutToPause(
  t: number,
  envelope: AudioEnvelope | null | undefined,
  side: 'in' | 'out' = 'out',
  maxDist = PAUSE_SNAP_MAX
): number {
  if (!envelope?.pauses?.length) return t;
  let best = t;
  let bestDist = maxDist + 0.001;
  for (const p of envelope.pauses) {
    const candidates =
      side === 'out'
        ? [p.start, (p.start + p.end) / 2]
        : [p.end, (p.start + p.end) / 2];
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (t >= p.start - 0.02 && t <= p.end + 0.02) {
      return side === 'out'
        ? Math.max(p.start, Math.min(t, p.end))
        : Math.min(p.end, Math.max(t, p.start));
    }
  }
  return best;
}

/** True when t is near a pause, speechStart, or speechEnd (within tol). */
export function isNearPauseOrSpeechBound(
  t: number,
  envelope: AudioEnvelope | null | undefined,
  tol = PAUSE_SNAP_MAX
): boolean {
  if (!envelope) return true;
  if (Math.abs(t - envelope.speechStart) <= tol) return true;
  if (Math.abs(t - envelope.speechEnd) <= tol) return true;
  for (const p of envelope.pauses || []) {
    if (t >= p.start - tol && t <= p.end + tol) return true;
    if (Math.abs(t - p.start) <= tol || Math.abs(t - p.end) <= tol) return true;
  }
  return false;
}

/** Tail out-point after speech with pad (client-safe). */
export function tailOutAfterSpeech(envelope: AudioEnvelope, pad = 0.35): number {
  const base = envelope.speechEnd;
  const trailing = envelope.pauses.find(
    (p) => p.start >= base - 0.15 && p.end >= envelope.duration - 0.6
  );
  const out = (trailing ? trailing.start : base) + pad;
  return Math.min(envelope.duration, Math.max(base, out));
}
