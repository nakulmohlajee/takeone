import type { Scene } from '../types/director';
import { firstPrimarySpeechStart, lastPrimarySpeechEnd, tailOutAfterSpeech } from './speechBounds';

export type OverlayWindow = {
  startSeconds: number;
  durationSeconds: number;
};

function normalizeMatchText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Soft match hint/dialogue against parent transcript segments; returns segment start or null. */
function matchHintAgainstTranscript(
  hint: string,
  segments: Array<{ start: number; end: number; text: string }>
): number | null {
  const needle = normalizeMatchText(hint);
  if (!needle || needle.length < 3 || !segments.length) return null;

  const words = needle.split(' ').filter((w) => w.length > 2);
  let best: { start: number; score: number } | null = null;

  for (const seg of segments) {
    const hay = normalizeMatchText(seg.text || '');
    if (!hay) continue;
    if (hay.includes(needle) || needle.includes(hay)) {
      return Math.max(0, seg.start);
    }
    if (words.length === 0) continue;
    const hits = words.filter((w) => hay.includes(w)).length;
    const score = hits / words.length;
    if (score >= 0.45 && (!best || score > best.score)) {
      best = { start: Math.max(0, seg.start), score };
    }
  }
  return best ? best.start : null;
}

/** Start time of `hint`'s words in the parent's word timings (in-order match), or null. */
function matchHintAgainstWords(
  hint: string,
  words: Array<{ w: string; start: number; end: number }>
): number | null {
  const needle = normalizeMatchText(hint).split(' ').filter(Boolean);
  if (!needle.length || !words.length) return null;
  const norm = words.map((w) => normalizeMatchText(w.w));
  const need = needle.length <= 2 ? needle.length : Math.ceil(needle.length * 0.7);
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] !== needle[0] && needle.length > 1 && norm[i] !== needle[1]) continue;
    let k = 0;
    for (let j = i; j < norm.length && j < i + needle.length + 3 && k < needle.length; j++) {
      if (norm[j] === needle[k]) k++;
    }
    if (k >= need) return Math.max(0, words[i].start);
  }
  return null;
}

function parentSpeechSpan(parentScene: Scene | null | undefined): { start: number; end: number } {
  const env = parentScene?.footageIntel?.audioEnvelope;
  if (env && env.speechEnd > 0) {
    return {
      start: Math.max(0, env.speechStart),
      end: tailOutAfterSpeech(env, 0.15),
    };
  }
  const start = firstPrimarySpeechStart(parentScene?.footageIntel) ?? 0;
  const end =
    lastPrimarySpeechEnd(parentScene?.footageIntel) ??
    parentScene?.recordedDuration ??
    parentScene?.durationSeconds ??
    8;
  return { start, end: Math.max(start + 0.5, end) };
}

/**
 * Resolve when an overlay should appear on its parent talking-head take.
 * Greenscreen / unset overlays span the parent speech window.
 * Explicit overlayStartSeconds / locked in-out keep a short window (capped).
 */
export function resolveOverlayWindow(
  overlayScene: Scene,
  parentScene: Scene | null | undefined
): OverlayWindow {
  const shortCap = 3;
  const isGreenscreen =
    overlayScene.overlayLayout === 'greenscreen' ||
    (overlayScene as Scene & { mediaPlan?: { kind?: string } }).mediaPlan?.kind === 'greenscreen';

  const speech = parentSpeechSpan(parentScene);
  const speechDur = Math.max(0.8, speech.end - speech.start);

  // Explicit user/AI timing that was intentionally set (not greenscreen defaults)
  const hasExplicitStart =
    typeof overlayScene.overlayStartSeconds === 'number' &&
    Number.isFinite(overlayScene.overlayStartSeconds);
  const hasExplicitDur =
    typeof overlayScene.overlayDurationSeconds === 'number' &&
    overlayScene.overlayDurationSeconds > 0.3;

  if (hasExplicitStart && !isGreenscreen) {
    const start = Math.max(0, overlayScene.overlayStartSeconds!);
    const dur = hasExplicitDur
      ? Math.min(shortCap, overlayScene.overlayDurationSeconds!)
      : Math.min(shortCap, Math.max(1.2, overlayScene.durationSeconds || 2.5));
    return { startSeconds: start, durationSeconds: dur };
  }

  // Greenscreen (or greenscreen with explicit start): cover the talking-head speech span
  if (isGreenscreen) {
    if (hasExplicitStart && hasExplicitDur && overlayScene.overlayDurationSeconds! >= speechDur * 0.5) {
      return {
        startSeconds: Math.max(0, overlayScene.overlayStartSeconds!),
        durationSeconds: overlayScene.overlayDurationSeconds!,
      };
    }
    return {
      startSeconds: speech.start,
      durationSeconds: speechDur,
    };
  }

  if (
    typeof overlayScene.inPoint === 'number' &&
    Number.isFinite(overlayScene.inPoint) &&
    (typeof overlayScene.outPoint === 'number' || hasExplicitDur)
  ) {
    const start = Math.max(0, overlayScene.inPoint);
    const dur =
      typeof overlayScene.outPoint === 'number' && overlayScene.outPoint > start
        ? Math.min(shortCap, overlayScene.outPoint - start)
        : Math.min(shortCap, Math.max(1.2, overlayScene.overlayDurationSeconds || 2.5));
    return { startSeconds: start, durationSeconds: dur };
  }

  const parentDur = Math.max(
    0.5,
    parentScene?.recordedDuration ||
      (typeof parentScene?.outPoint === 'number' && typeof parentScene?.inPoint === 'number'
        ? parentScene.outPoint - parentScene.inPoint
        : 0) ||
      parentScene?.durationSeconds ||
      speechDur ||
      8
  );

  // A pop-in visual reads in ~2.5s; the beat's planned duration is not how long it should cover you.
  const defaultDur = Math.min(3, Math.max(1.2, overlayScene.overlayDurationSeconds || 2.5));

  const hintCandidates = [
    (overlayScene as Scene & { mediaTimingHint?: string }).mediaTimingHint,
    overlayScene.dialogue?.teleprompterText,
    overlayScene.teleprompterPrompt,
    overlayScene.plainInstruction,
    overlayScene.title,
  ]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);

  const segs = parentScene?.transcriptSegments || [];
  const words = parentScene?.words || [];
  for (const hint of hintCandidates) {
    const matched = matchHintAgainstWords(hint, words) ?? matchHintAgainstTranscript(hint, segs);
    if (matched != null) {
      const remaining = Math.max(0.8, parentDur - matched);
      return {
        startSeconds: matched,
        durationSeconds: Math.min(defaultDur, remaining, shortCap),
      };
    }
  }

  // ~25% into parent speech span (short pip overlays)
  const start = Math.max(speech.start, speech.start + speechDur * 0.25);
  const remaining = Math.max(0.8, speech.end - start);
  return {
    startSeconds: start,
    durationSeconds: Math.min(defaultDur, remaining, shortCap),
  };
}
