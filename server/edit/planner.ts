/**
 * Edit Planner — converts Director creative brief into a validated EDL.
 * Snaps in/out to Stage A observed moments (not editorial scores).
 * Default transitions = hard_cut. Prefer existing footage for B-roll.
 */
import type {
  CriticIssue,
  DirectorCreativeBrief,
  FootageIntelligence,
  PlannedClip,
  ValidatedEditPlan,
} from '../../src/types/editorial';
import { getStyleConstraints } from './director';
import { clampZoomForStyle, ensureSourceParams, resolveClipForIssue, toSourceTime } from './critic';
import { validateEditPlan, type SourceDurationMap } from './validateEdl';
import {
  applyTrimClipMutation,
  enforceDirectedSequence,
  MIN_USABLE_CLIP_SECONDS,
} from './editPolicy';
import {
  hasSourceOverlap,
  isNoOpRange,
  lastPrimarySpeechEnd,
  materializeKeepHoles,
  nearestSafeBoundary,
  primarySpeechIntervals,
  repairSourceOverlaps,
  type TimeRange,
  validateGeneralEdlSequence,
  validateUgcEdlSequence,
} from './edlHoles';
import { snapCutToPause, tailOutAfterSpeech } from './audioEnvelope';

type AiClient = {
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

function sourceDurationMap(intel: FootageIntelligence[]): SourceDurationMap {
  const m: SourceDurationMap = {};
  for (const f of intel) m[f.sourceId] = f.sourceDuration;
  return m;
}

/** Snap cut times to nearest transcript/segment boundary within ±450ms (avoid mid-word chops). */
function snapToSegmentBoundary(
  t: number,
  segments: Array<{ start: number; end: number }>,
  edge: 'in' | 'out'
): number {
  if (!segments.length) return t;
  let best = t;
  let bestDist = 0.45;

  for (const s of segments) {
    // If cutting out and t lands in the middle of an active thought, prefer the end of that thought
    if (edge === 'out' && t > s.start && t < s.end) {
      const d = Math.abs(s.end - t);
      if (d <= 0.8) {
        bestDist = d;
        best = s.end;
      }
    } else if (edge === 'in' && t > s.start && t < s.end) {
      // If cutting in and t lands in the middle of an active thought, prefer the start of that thought
      const d = Math.abs(s.start - t);
      if (d <= 0.8) {
        bestDist = d;
        best = s.start;
      }
    }

    const candidates = edge === 'in' ? [s.start, s.end] : [s.end, s.start];
    for (const b of candidates) {
      const d = Math.abs(b - t);
      if (d <= bestDist) {
        bestDist = d;
        best = b;
      }
    }
  }
  return best;
}

type SnapOpts = {
  /** When true, never expand end past the requested/current clip end (critic shrink). */
  allowExpand?: boolean;
  /** Prefer Stage A shot boundaries (creative_recut). */
  preferShots?: boolean;
  /** Cap expansion to this source-second ceiling (e.g. next sibling keep). */
  expandCeiling?: number;
};

function shotBoundaries(f: FootageIntelligence): Array<{ start: number; end: number }> {
  const shots = f.observation?.shots || [];
  return shots
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }));
}

/** Phrase/word-safe snap candidates from STT + completed_thought moments. */
function phraseBoundaries(f: FootageIntelligence): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const moments = f.observation?.moments || [];
  for (const m of moments) {
    const t = String(m.momentType || '');
    if (
      t === 'completed_thought' ||
      t === 'natural_cut_point' ||
      t === 'speech_beat' ||
      /[.!?…]["']?\s*$/.test((m.transcript || '').trim())
    ) {
      out.push({ start: m.start, end: m.end });
    }
    if (Array.isArray(m.naturalCutPoints)) {
      for (const p of m.naturalCutPoints) {
        if (Number.isFinite(p)) out.push({ start: p, end: p });
      }
    }
  }
  for (const s of f.segments || []) {
    const text = (s.transcript || '').trim();
    if (!text) continue;
    // Prefer ends that look like phrase/sentence boundaries
    if (/[.!?…]["']?\s*$/.test(text) || text.split(/\s+/).length >= 3) {
      out.push({ start: s.start, end: s.end });
    }
    if (Array.isArray(s.naturalCutPoints)) {
      for (const p of s.naturalCutPoints) {
        if (Number.isFinite(p)) out.push({ start: p, end: p });
      }
    }
  }
  return out;
}

function snapClipToIntel(
  clip: PlannedClip,
  intel: FootageIntelligence[],
  opts: SnapOpts = {}
): PlannedClip {
  const allowExpand = opts.allowExpand !== false;
  const f = intel.find((i) => i.sourceId === clip.sourceId);
  if (!f) return clip;

  const shots = shotBoundaries(f);
  const phrases = phraseBoundaries(f);
  const moments = f.observation?.moments?.length
    ? f.observation.moments
    : f.segments || [];

  const segs: Array<{ start: number; end: number }> = [];
  // Prefer transcript word/phrase ends over coarse moment edges
  if (phrases.length) {
    segs.push(...phrases);
  }
  // creative_recut: shot boundaries so Director ranges snap to the shot, not the take
  if (opts.preferShots && shots.length) {
    segs.push(...shots);
  }
  for (const m of moments) {
    segs.push({ start: m.start, end: m.end });
  }
  if (!opts.preferShots && shots.length) {
    segs.push(...shots);
  }

  if (!segs.length) return clip;

  const cutPoints: number[] = [];
  for (const m of moments as Array<{ naturalCutPoints?: number[] }>) {
    if (Array.isArray(m.naturalCutPoints)) cutPoints.push(...m.naturalCutPoints);
  }
  const withCuts = [
    ...segs,
    ...cutPoints.filter((n) => Number.isFinite(n)).map((n) => ({ start: n, end: n })),
  ];
  let start = snapToSegmentBoundary(clip.start, withCuts, 'in');
  let end = snapToSegmentBoundary(clip.end, withCuts, 'out');
  if (end <= start + 0.2) {
    start = clip.start;
    end = clip.end;
  }
  // Prefer ffmpeg pause snap when envelope is present (avoids mid-word cuts)
  if (f.audioEnvelope) {
    start = snapCutToPause(start, f.audioEnvelope, 'in', 0.6);
    end = snapCutToPause(end, f.audioEnvelope, 'out', 0.6);
  }
  const maxDur = f.sourceDuration || end;
  start = Math.max(0, Math.min(start, maxDur - 0.25));
  end = Math.max(start + 0.25, Math.min(end, maxDur));
  // Never let Polish/UGC out-point land before protected speech end
  const speechEnd = lastPrimarySpeechEnd(f);
  if (speechEnd != null && end < speechEnd - 0.05 && clip.end >= (f.audioEnvelope?.speechEnd ?? clip.end) - 2) {
    // Only expand when this looks like a truncated ending (clip.end near bogus speech end)
    if (f.audioEnvelope) {
      end = Math.min(maxDur, Math.max(end, tailOutAfterSpeech(f.audioEnvelope, 0.35)));
    } else {
      end = Math.min(maxDur, Math.max(end, speechEnd));
    }
  }

  // Never expand past requested end on intentional shrink
  if (!allowExpand && end > clip.end + 0.02) {
    end = clip.end;
  }

  let next: PlannedClip = { ...clip, start, end };
  if (allowExpand) {
    next = ensureActionComplete(next, intel, {
      preferShots: opts.preferShots,
      expandCeiling: opts.expandCeiling,
    });
    if (opts.expandCeiling != null && next.end > opts.expandCeiling) {
      next = { ...next, end: Math.max(next.start + 0.25, opts.expandCeiling) };
    }
  }
  return next;
}

/**
 * If a clip covers a movement_peak / setup, do not let the out-point sit
 * before completed_thought or recovery — but never expand past the current
 * Stage A shot (or expandCeiling) so a 23.5–28.0 hook is not blown out to 88s.
 */
function ensureActionComplete(
  clip: PlannedClip,
  intel: FootageIntelligence[],
  opts: { preferShots?: boolean; expandCeiling?: number } = {}
): PlannedClip {
  const f = intel.find((i) => i.sourceId === clip.sourceId);
  const moments = f?.observation?.moments || [];
  if (!moments.length) return clip;

  const typeOf = (m: { momentType?: string; type?: string }) =>
    String(m.momentType || m.type || '').toLowerCase();
  const isAction = (t: string) => t === 'movement_peak' || t === 'setup';
  const isComplete = (t: string) => t === 'completed_thought' || t === 'recovery';

  const overlappingAction = moments.filter((m) => {
    const t = typeOf(m);
    return isAction(t) && m.end > clip.start && m.start < clip.end;
  });
  if (!overlappingAction.length) return clip;

  let end = clip.end;
  for (const action of overlappingAction) {
    const completion = moments.find(
      (m) => isComplete(typeOf(m)) && m.start >= action.start - 0.05 && m.end >= action.end
    );
    const need = completion ? completion.end : action.end;
    if (end < need) end = need;
  }

  // Cap to containing / next shot so we don't swallow the rest of the take
  const shots = shotBoundaries(f!);
  if (opts.preferShots && shots.length) {
    const containing = shots.find((s) => clip.start >= s.start - 0.05 && clip.start < s.end);
    const shotCap = containing
      ? containing.end
      : shots.find((s) => s.start >= clip.start)?.start;
    if (shotCap != null) end = Math.min(end, shotCap);
  }
  if (opts.expandCeiling != null) {
    end = Math.min(end, opts.expandCeiling);
  }

  const maxDur = f?.sourceDuration || end;
  end = Math.max(clip.start + 0.25, Math.min(end, maxDur));
  // Also never expand more than ~2s past original out unless still inside same shot
  if (end > clip.end + 2.0) {
    const containing = shots.find((s) => clip.end > s.start && clip.end <= s.end + 0.05);
    if (!containing) end = Math.min(end, clip.end + 2.0);
  }
  if (end <= clip.end + 0.02) return clip;
  return { ...clip, end };
}

function isUgcSingleTake(
  brief: DirectorCreativeBrief,
  intel: FootageIntelligence[]
): boolean {
  if (brief.editPolicy !== 'directed') return false;
  const sources = new Set(intel.map((f) => f.sourceId));
  if (sources.size === 1) return true;
  const roleSources = new Set((brief.sequenceRoles || []).map((r) => r.sourceId));
  return roleSources.size === 1 && intel.length <= 2;
}

/** Deterministic planner from Director brief — no LLM required for first pass. */
export function planFromBrief(
  brief: DirectorCreativeBrief,
  intel: FootageIntelligence[],
  projectId: string,
  iteration = 0
): ValidatedEditPlan {
  const constraints = getStyleConstraints(brief.style);
  const durations = sourceDurationMap(intel);
  const sequence: PlannedClip[] = [];
  let clipIdx = 0;
  const ugcSingleTake = isUgcSingleTake(brief, intel);
  let intentionalHoles: TimeRange[] = [];

  // Talking-head master: always hard_cut between scenes (no xfade)
  const allowFancy = (_wanted: PlannedClip['transitionOut']): PlannedClip['transitionOut'] => {
    return 'hard_cut';
  };

  // Collect KEEP / DROP from granularCuts + keepDrop, then materialize holes.
  const granular = (brief.granularCuts || []).filter((g) => g.sourceId in durations);
  const keepDrop = (brief.keepDrop || []).filter((k) => k.sourceId in durations);

  const rawKeeps: TimeRange[] = [];
  const rawDrops: TimeRange[] = [];
  const specialActions: typeof granular = [];

  const isPolish = brief.editPolicy === 'directed';

  for (const g of granular) {
    if (g.action === 'drop') {
      // Polish: ignore interior drops — one-take must stay continuous
      if (isPolish) {
        console.log(
          `[POLISH] ignored interior drop ${g.sourceId} ${g.start.toFixed(1)}–${g.end.toFixed(1)}`
        );
        continue;
      }
      rawDrops.push({
        sourceId: g.sourceId,
        start: g.start,
        end: g.end,
        reason: g.reason,
        action: 'drop',
      });
    } else if (
      g.action === 'keep' ||
      g.action === 'punch_in' ||
      g.action === 'cover_with_broll' ||
      g.action === 'split_return'
    ) {
      // Polish: cover_with_broll becomes overlay opportunity, not a hard splice
      if (isPolish && (g.action === 'cover_with_broll' || g.action === 'split_return')) {
        rawKeeps.push({
          sourceId: g.sourceId,
          start: g.start,
          end: g.end,
          reason: g.reason,
          action: 'keep',
          zoom: g.zoom,
        });
        continue;
      }
      rawKeeps.push({
        sourceId: g.sourceId,
        start: g.start,
        end: g.end,
        reason: g.reason,
        action: g.action,
        zoom: g.zoom,
      });
      if (g.action === 'cover_with_broll' || g.action === 'split_return') {
        specialActions.push(g);
      }
    }
  }
  for (const k of keepDrop) {
    if (k.action === 'drop') {
      if (isPolish) {
        console.log(
          `[POLISH] ignored keepDrop drop ${k.sourceId} ${k.start.toFixed(1)}–${k.end.toFixed(1)}`
        );
        continue;
      }
      rawDrops.push({
        sourceId: k.sourceId,
        start: k.start,
        end: k.end,
        reason: k.reason,
        action: 'drop',
      });
    } else if (k.action === 'keep') {
      // Avoid duplicating an identical granular keep
      const dup = rawKeeps.some(
        (r) =>
          r.sourceId === k.sourceId &&
          Math.abs(r.start - k.start) < 0.05 &&
          Math.abs(r.end - k.end) < 0.05
      );
      if (!dup) {
        rawKeeps.push({
          sourceId: k.sourceId,
          start: k.start,
          end: k.end,
          reason: k.reason,
          action: 'keep',
        });
      }
    }
  }

  // Fallback keeps from sequenceRoles when Director emitted only drops / thin keeps
  if (rawKeeps.length < 1) {
    for (const role of brief.sequenceRoles || []) {
      if (!(role.sourceId in durations)) continue;
      rawKeeps.push({
        sourceId: role.sourceId,
        start: role.start,
        end: role.end,
        reason: role.notes || role.role,
        action: 'keep',
        zoom: role.zoom,
      });
    }
  }

  // Polish: collapse to one keep per source = usable speech range (head/tail only)
  if (isPolish && rawKeeps.length >= 1) {
    const bySource = new Map<string, TimeRange>();
    for (const k of rawKeeps) {
      const prev = bySource.get(k.sourceId);
      if (!prev) {
        bySource.set(k.sourceId, { ...k });
      } else {
        prev.start = Math.min(prev.start, k.start);
        prev.end = Math.max(prev.end, k.end);
      }
    }
    // Expand to speech bounds when available — envelope is authoritative for CTA end
    for (const [sourceId, keep] of bySource) {
      const f = intel.find((i) => i.sourceId === sourceId);
      if (f) {
        const speech = primarySpeechIntervals(f);
        if (speech.length) {
          keep.start = Math.min(keep.start, speech[0].start);
          keep.end = Math.max(keep.end, speech[speech.length - 1].end);
        }
        if (f.audioEnvelope) {
          keep.start = Math.min(keep.start, f.audioEnvelope.speechStart);
          keep.end = Math.max(keep.end, tailOutAfterSpeech(f.audioEnvelope, 0.35));
        } else {
          const se = lastPrimarySpeechEnd(f);
          if (se != null) keep.end = Math.max(keep.end, se);
        }
      }
      keep.action = 'keep';
      keep.reason = keep.reason || 'polish single keep';
    }
    rawKeeps.length = 0;
    rawKeeps.push(...bySource.values());
    rawDrops.length = 0;
    console.log(
      `[POLISH] collapsed to ${rawKeeps.length} continuous keep(s); no interior drops`
    );
  }

  const rolesWanted = brief.sequenceRoles.length;
  let afterGranular = 0;

  if (rawKeeps.length >= 1) {
    // Creative recut may still reorder; for directed, preserve source/time order.
    if (brief.editPolicy !== 'directed' && brief.openingHook) {
      const hook = brief.openingHook;
      const hookIdx = rawKeeps.findIndex(
        (g) =>
          g.sourceId === hook.sourceId && Math.abs(g.start - hook.start) < 0.6
      );
      if (hookIdx > 0) {
        const [h] = rawKeeps.splice(hookIdx, 1);
        rawKeeps.unshift(h);
      }
    }

    // Polish: never materialize interior holes; Recut may.
    const materialized = isPolish
      ? {
          keepsAfter: rawKeeps.map((k) => ({ ...k })),
          drops: [] as TimeRange[],
        }
      : materializeKeepHoles({
          keeps: rawKeeps,
          drops: rawDrops,
          intel,
          ugcSingleTake,
          minDuration: MIN_USABLE_CLIP_SECONDS,
        });
    intentionalHoles = materialized.drops;

    // Role hints from sequenceRoles — match by range overlap (same source may have many roles)
    const roleForKeep = (g: TimeRange): PlannedClip['role'] => {
      let best: { role: PlannedClip['role']; overlap: number } | null = null;
      for (const r of brief.sequenceRoles || []) {
        if (r.sourceId !== g.sourceId) continue;
        const overlap = Math.min(g.end, r.end) - Math.max(g.start, r.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) {
          best = { role: r.role, overlap };
        }
      }
      return best?.role || 'context';
    };

    for (const g of materialized.keepsAfter) {
      if (!(g.sourceId in durations)) {
        console.log(`[EDL TRACE] skipped: no duration ${g.sourceId}`);
        continue;
      }
      const srcDur = durations[g.sourceId];
      const start = Math.max(0, Math.min(g.start, srcDur - MIN_USABLE_CLIP_SECONDS));
      const end = Math.max(start + MIN_USABLE_CLIP_SECONDS, Math.min(g.end, srcDur));
      if (end - start < MIN_USABLE_CLIP_SECONDS) continue;

      const special = specialActions.find(
        (s) =>
          s.sourceId === g.sourceId &&
          s.start <= g.start + 0.2 &&
          s.end >= g.end - 0.2 &&
          s.action === 'cover_with_broll' &&
          s.brollSourceId &&
          s.brollSourceId in durations
      );
      if (special?.brollSourceId) {
        const mid = special.returnStart != null ? special.start : start;
        const leadEnd = Math.min(end, Math.max(start + 0.4, mid + (end - start) * 0.35));
        sequence.push({
          id: `c${clipIdx++}`,
          sourceId: g.sourceId,
          start,
          end: leadEnd,
          role: sequence.length === 0 ? 'hook' : 'context',
          transitionIn: 'hard_cut',
          transitionOut: 'hard_cut',
          zoom: 1,
          musicDuck: 'speech',
          notes: g.reason,
        });
        const bStart = Math.max(0, special.brollStart ?? 0);
        const bEnd = Math.min(
          durations[special.brollSourceId],
          special.brollEnd ?? bStart + 2
        );
        if (bEnd - bStart >= 0.5) {
          sequence.push({
            id: `c${clipIdx++}`,
            sourceId: special.brollSourceId,
            start: bStart,
            end: bEnd,
            role: 'broll',
            transitionIn: 'l_cut',
            transitionOut: 'hard_cut',
            isBroll: true,
            musicDuck: 'lift',
            notes: special.reason,
          });
        }
        const retStart = Math.max(leadEnd, special.returnStart ?? leadEnd);
        const retEnd = Math.min(srcDur, special.returnEnd ?? end);
        if (retEnd - retStart >= MIN_USABLE_CLIP_SECONDS) {
          sequence.push({
            id: `c${clipIdx++}`,
            sourceId: g.sourceId,
            start: retStart,
            end: retEnd,
            role: 'explanation',
            transitionIn: 'hard_cut',
            transitionOut: 'hard_cut',
            zoom: constraints.punchInAllowed ? 1.05 : 1,
            crop: constraints.punchInAllowed ? 'face_priority' : 'none',
            musicDuck: 'speech',
          });
        }
        continue;
      }

      const zoom = clampZoomForStyle(
        g.action === 'punch_in' ? g.zoom || 1.06 : g.zoom || 1,
        brief.style
      );
      const roleHint = roleForKeep(g);
      // Opening hook: prefer Director openingHook range when it matches this keep
      const isOpeningHook =
        brief.openingHook &&
        g.sourceId === brief.openingHook.sourceId &&
        Math.abs(g.start - brief.openingHook.start) < 0.6 &&
        Math.abs(g.end - brief.openingHook.end) < 1.5;
      sequence.push({
        id: `c${clipIdx++}`,
        sourceId: g.sourceId,
        start,
        end,
        role: isOpeningHook ? 'hook' : roleHint || (sequence.length === 0 ? 'hook' : 'context'),
        transitionIn: 'hard_cut',
        transitionOut: 'hard_cut',
        transitionDuration: 0.3,
        crop: zoom > 1 ? 'face_priority' : 'none',
        zoom,
        musicDuck: 'speech',
        notes: g.reason,
      });
    }

    // creative_recut: put openingHook first in timeline order when present
    if (brief.editPolicy === 'creative_recut' && brief.openingHook) {
      const hookIdx = sequence.findIndex(
        (c) =>
          !c.isBroll &&
          c.sourceId === brief.openingHook.sourceId &&
          Math.abs(c.start - brief.openingHook.start) < 0.6
      );
      if (hookIdx > 0) {
        const [h] = sequence.splice(hookIdx, 1);
        sequence.unshift({ ...h, role: 'hook' });
      }
    }
    afterGranular = sequence.filter((c) => !c.isBroll).length;

    // Last A-roll → CTA when we have a jump-cut pair (body + ending)
    if (ugcSingleTake && sequence.length) {
      const arollIdx: number[] = [];
      for (let i = 0; i < sequence.length; i++) {
        if (!sequence[i].isBroll) arollIdx.push(i);
      }
      if (arollIdx.length >= 2) {
        const lastA = arollIdx[arollIdx.length - 1];
        sequence[lastA] = { ...sequence[lastA], role: 'cta' };
        if (sequence[arollIdx[0]].role !== 'hook') {
          sequence[arollIdx[0]] = { ...sequence[arollIdx[0]], role: 'hook' };
        }
      }
    }
  }

  // Fallback / supplement from sequenceRoles if hole materialization was thin
  if (sequence.filter((c) => !c.isBroll).length < 1) {
    sequence.length = 0;
    clipIdx = 0;
    for (const role of brief.sequenceRoles) {
      if (!(role.sourceId in durations)) {
        console.log(`[EDL TRACE] skipped role ${role.role} ${role.sourceId}: no duration`);
        continue;
      }
      const srcDur = durations[role.sourceId];
      const start = Math.max(0, Math.min(role.start, srcDur - 0.3));
      const end = Math.max(start + 0.3, Math.min(role.end, srcDur));
      if (end <= start) {
        console.log(`[EDL TRACE] skipped role ${role.role} ${role.sourceId}: invalid range`);
        continue;
      }
      const zoom = clampZoomForStyle(
        role.zoom ||
          (constraints.punchInAllowed && (role.role === 'hook' || role.role === 'proof') ? 1.06 : 1),
        brief.style
      );
      const tOut = allowFancy((role.transitionOut as any) || 'hard_cut');

      sequence.push({
        id: `c${clipIdx++}`,
        sourceId: role.sourceId,
        start,
        end,
        role: role.role,
        transitionIn: 'hard_cut',
        transitionOut: tOut,
        transitionDuration: 0.35,
        crop: zoom > 1 ? 'face_priority' : 'none',
        zoom,
        musicDuck: 'speech',
        notes: role.notes,
      });
    }
  }

  // B-roll opportunities: hard cutaways only when replace; overlays attach later via scene.brollInserts
  // Polish: NEVER splice replace/cover into the main sequence
  for (const op of brief.brollOpportunities || []) {
    if (op.replaceOrOverlay === 'overlay' || isPolish) {
      // Overlay assets are composited on the parent take — do not splice a separate A-roll replacement
      continue;
    }
    if (!op.preferredSourceId || !(op.preferredSourceId in durations)) continue;
    const anchorIdx = sequence.findIndex(
      (c) => c.sourceId === op.atSourceId && !c.isBroll
    );
    if (anchorIdx < 0) continue;
    const bStart = Math.max(0, op.preferredStart ?? 0);
    const bEnd = Math.min(
      durations[op.preferredSourceId],
      bStart + Math.min(op.durationSeconds || 2, 3)
    );
    if (bEnd - bStart < 0.5) continue;
    sequence.splice(anchorIdx + 1, 0, {
      id: `c${clipIdx++}`,
      sourceId: op.preferredSourceId,
      start: bStart,
      end: bEnd,
      role: 'broll',
      transitionIn: 'l_cut',
      transitionOut: 'hard_cut',
      isBroll: true,
      musicDuck: 'lift',
      notes: op.whyNeeded || op.concept,
    });
  }

  // Force hard_cut on all A-roll joins — no xfade between talking-head scenes
  for (let i = 0; i < sequence.length; i++) {
    const c = sequence[i];
    if (!c.isBroll) {
      c.transitionOut = 'hard_cut';
      c.transitionIn = 'hard_cut';
      c.transitionDuration = 0;
    } else if (i > 0) {
      c.transitionIn = c.transitionIn === 'l_cut' || c.transitionIn === 'j_cut' ? c.transitionIn : 'hard_cut';
    }
  }

  const preferShots = brief.editPolicy === 'creative_recut';
  const snapOptsFor = (clip: PlannedClip, peers: PlannedClip[]): SnapOpts => {
    // Cap expansion at the next same-source keep start so ranges don't swallow siblings
    const nextSibling = peers
      .filter(
        (p) =>
          !p.isBroll &&
          p.sourceId === clip.sourceId &&
          p.id !== clip.id &&
          p.start > clip.start + 0.05
      )
      .sort((a, b) => a.start - b.start)[0];
    return {
      preferShots,
      allowExpand: true,
      expandCeiling: nextSibling ? nextSibling.start : undefined,
    };
  };

  // Snap in/out (±150ms) before merge — shot-bounded for creative_recut
  for (let i = 0; i < sequence.length; i++) {
    if (!sequence[i].isBroll) {
      sequence[i] = snapClipToIntel(sequence[i], intel, snapOptsFor(sequence[i], sequence));
    }
  }

  // Repair nested/overlapping same-source keeps BEFORE merge (never union to full take)
  {
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    if (repaired.repairs.length) {
      console.log(`[EDL OVERLAP] repaired: ${repaired.repairs.join('; ')}`);
      sequence.length = 0;
      sequence.push(...repaired.sequence);
    }
  }

  // Merge adjacent same-source keeps with gaps up to ~0.8s (avoid mid-word chops).
  // Never merge across intentional DROP holes (UGC jump cuts).
  // Never merge nested overlaps (handled by repair above).
  const afterBuild = sequence.length;
  const mergeNotes: string[] = [];
  const merged: PlannedClip[] = [];
  const holeBetween = (a: PlannedClip, b: PlannedClip): boolean => {
    if (a.sourceId !== b.sourceId) return false;
    if (b.start <= a.end + 0.05) return false;
    return intentionalHoles.some(
      (h) =>
        h.sourceId === a.sourceId &&
        h.start <= a.end + 0.2 &&
        h.end >= b.start - 0.2
    );
  };
  for (const c of sequence) {
    const prev = merged[merged.length - 1];
    // creative_recut: never merge adjacent editorial segments (would glue
    // hook+setup+execution back into one long overlapping take).
    const allowMerge =
      brief.editPolicy !== 'creative_recut' &&
      prev &&
      !prev.isBroll &&
      !c.isBroll &&
      prev.sourceId === c.sourceId &&
      c.start - prev.end < 0.8 &&
      c.start >= prev.end - 0.15 &&
      (prev.zoom || 1) === (c.zoom || 1) &&
      prev.role === c.role &&
      !holeBetween(prev, c);
    if (allowMerge && prev) {
      mergeNotes.push(
        `merge ${c.sourceId} ${prev.start.toFixed(1)}–${prev.end.toFixed(1)} + ${c.start.toFixed(1)}–${c.end.toFixed(1)}`
      );
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    // Clamp zooms to style palette
    c.zoom = clampZoomForStyle(c.zoom, brief.style);
    merged.push(c);
  }

  // Soft re-snap after merge (still shot-bounded / sibling-capped)
  for (let i = 0; i < merged.length; i++) {
    if (!merged[i].isBroll) {
      const before = { start: merged[i].start, end: merged[i].end };
      merged[i] = snapClipToIntel(merged[i], intel, snapOptsFor(merged[i], merged));
      // creative_recut: do not let snap expand a Director-selected range by >0.35s
      if (
        preferShots &&
        merged[i].end - before.end > 0.35 &&
        before.end - before.start >= MIN_USABLE_CLIP_SECONDS
      ) {
        merged[i] = { ...merged[i], end: before.end };
      }
      merged[i].zoom = clampZoomForStyle(merged[i].zoom, brief.style);
    }
  }

  // Final overlap repair after snap
  {
    const repaired = repairSourceOverlaps(merged, MIN_USABLE_CLIP_SECONDS);
    if (repaired.repairs.length) {
      console.log(`[EDL OVERLAP] post-snap repaired: ${repaired.repairs.join('; ')}`);
      merged.length = 0;
      merged.push(...repaired.sequence);
    }
  }

  if (brief.editPolicy === 'directed') {
    const locked = enforceDirectedSequence(merged, intel, brief);
    merged.length = 0;
    merged.push(...locked);
    const repaired = repairSourceOverlaps(merged, MIN_USABLE_CLIP_SECONDS);
    if (repaired.repairs.length) {
      merged.length = 0;
      merged.push(...repaired.sequence);
    }
  }

  if (hasSourceOverlap(merged)) {
    console.warn(
      `[EDL OVERLAP] still present after repair — forcing clamp`
    );
    const forced = repairSourceOverlaps(merged, MIN_USABLE_CLIP_SECONDS);
    merged.length = 0;
    merged.push(...forced.sequence);
  }

  console.log(
    `[EDL TRACE] sequenceRoles=${rolesWanted} granularKeeps=${afterGranular} afterBuild=${afterBuild} afterMerge=${merged.length}` +
      (mergeNotes.length ? ` dropped: ${mergeNotes.join('; ')}` : '')
  );

  // Music cues: duck under speech for whole timeline, lift on broll
  let t = 0;
  const musicCues: ValidatedEditPlan['musicCues'] = [];
  for (const c of merged) {
    const dur = c.end - c.start;
    musicCues.push({
      start: t,
      end: t + dur,
      level: c.isBroll || c.musicDuck === 'lift' ? 'lift' : 'ducked',
    });
    t += dur;
  }

  const raw = {
    style: brief.style,
    aspectRatio: brief.aspectRatio,
    targetDuration: brief.targetDuration,
    editPolicy: brief.editPolicy,
    sequence: merged,
    musicCues,
    audioStrategy: brief.audioStrategy,
    captionStrategy: brief.captionStrategy,
  };

  let result = validateEditPlan(raw, durations, {
    projectId,
    iteration,
    defaultAspect: brief.aspectRatio,
    defaultStyle: brief.style,
    targetDuration: brief.targetDuration,
  });

  if (result.ok && result.plan) return result.plan;

  // Overlap hard-errors: repair and re-validate before emergency fallback
  if (result.errors?.some((e) => e.includes('overlap')) || hasSourceOverlap(merged)) {
    const repaired = repairSourceOverlaps(merged, MIN_USABLE_CLIP_SECONDS);
    console.log(
      `[EDL OVERLAP] validate failed — repaired: ${repaired.repairs.join('; ') || '(none)'}`
    );
    result = validateEditPlan(
      { ...raw, sequence: repaired.sequence },
      durations,
      {
        projectId,
        iteration,
        defaultAspect: brief.aspectRatio,
        defaultStyle: brief.style,
        targetDuration: brief.targetDuration,
      }
    );
    if (result.ok && result.plan) return result.plan;
  }

  // Emergency: one clip per keep source
  const emergency: PlannedClip[] = brief.sequenceRoles.slice(0, 8).map((r, i) => ({
    id: `e${i}`,
    sourceId: r.sourceId,
    start: Math.max(0, r.start),
    end: Math.max(r.start + 0.5, r.end),
    role: r.role,
    transitionIn: 'hard_cut' as const,
    transitionOut: 'hard_cut' as const,
    zoom: 1,
  }));

  const fallback = validateEditPlan(
    {
      style: brief.style,
      aspectRatio: brief.aspectRatio,
      targetDuration: brief.targetDuration,
      editPolicy: brief.editPolicy,
      sequence: emergency.filter((c) => c.sourceId in durations),
      musicCues: [],
      audioStrategy: brief.audioStrategy,
      captionStrategy: brief.captionStrategy,
    },
    durations,
    { projectId, iteration, defaultAspect: brief.aspectRatio, defaultStyle: brief.style }
  );

  if (!fallback.plan) {
    throw new Error(`Planner validation failed: ${(result.errors || []).join('; ')}`);
  }
  return fallback.plan;
}

/** Parse "extend to 8.6" / "extending clip c0 to source 8.6" / "newEnd 8.6" style hints from recommendation prose */
function parseExtendHint(text: string): number | null {
  const m = String(text || '').match(
    /(?:newEnd|extend(?:ing)?(?:\s+clip\s+\w+)?(?:\s+to)?|to)\s*(?:source\s*)?(\d+(?:\.\d+)?)\s*s?/i
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Parse newStart from critic prose: "starts at 55.3", "newStart 55.3", "move start to 55.3" */
function parseStartHint(text: string): number | null {
  const m = String(text || '').match(
    /(?:newStart|starts?\s+(?:at|from)|move\s+start\s+to|begin(?:s|ning)?\s+at|from\s+source\s*)\s*(\d+(?:\.\d+)?)/i
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function looksMidWordIssue(issue: CriticIssue): boolean {
  const blob = `${issue.problem} ${issue.reason || ''} ${issue.recommendation || ''} ${issue.seenHeard || ''}`.toLowerCase();
  return /mid[- ]?word|starts? mid|cut(?:s|ting)? (?:off|into) (?:a )?word|incomplete word|chopped/.test(
    blob
  );
}

function resolveSourceBounds(
  issue: CriticIssue,
  clip: PlannedClip,
  intel?: FootageIntelligence[]
): {
  newStart: number;
  newEnd: number;
} {
  const p = issue.parameters || {};
  // Canonical: sourceStart/sourceEnd; legacy: newStart/newEnd (also source coords)
  let newStart =
    typeof p.sourceStart === 'number'
      ? p.sourceStart
      : typeof p.newStart === 'number'
        ? p.newStart
        : clip.start;
  let newEnd =
    typeof p.sourceEnd === 'number'
      ? p.sourceEnd
      : typeof p.newEnd === 'number'
        ? p.newEnd
        : clip.end;

  const prose = `${issue.problem || ''} ${issue.recommendation || ''} ${issue.seenHeard || ''} ${issue.reason || ''}`.toLowerCase();
  const isLeadingArtifact =
    /pre-speech|vocal artifact|breath|mouth noise|throat|opens? with (?:an? )?(?:audible )?(?:vocal|noise|artifact)|leading (?:noise|silence|dead air)/i.test(
      prose
    );

  if (isLeadingArtifact && Math.abs(newStart - clip.start) < 0.05 && intel) {
    const f = intel.find((x) => x.sourceId === clip.sourceId);
    if (f) {
      const speech = primarySpeechIntervals(f);
      const relevant = speech.find((s) => s.end > clip.start + 0.1 && s.start < clip.end);
      if (relevant && relevant.start > clip.start + 0.05) {
        newStart = Math.min(clip.end - 0.5, Math.max(clip.start, relevant.start));
        console.log(`[CRITIC REVISION] inferred newStart=${newStart.toFixed(2)} from speech onset for artifact issue`);
      }
    }
  }

  return { newStart, newEnd };
}

function applySetRange(
  clip: PlannedClip,
  newStart: number,
  newEnd: number,
  srcDur: number,
  intel: FootageIntelligence[],
  label: string,
  opts: { preferShots?: boolean; expandCeiling?: number } = {}
): { clip: PlannedClip; change: string } | null {
  console.log(
    `[REVISION] BEFORE: ${clip.id} source=${clip.start.toFixed(1)}–${clip.end.toFixed(1)}`
  );
  let start = Math.max(0, Math.min(newStart, srcDur - MIN_USABLE_CLIP_SECONDS));
  let end = Math.min(srcDur, Math.max(start + MIN_USABLE_CLIP_SECONDS, newEnd));
  if (end - start < MIN_USABLE_CLIP_SECONDS) {
    console.log(`[REVISION] AFTER: ${clip.id} FAILED (too short)`);
    return null;
  }

  const shrinking = end < clip.end - 0.04 || start > clip.start + 0.04;
  const f = intel.find((i) => i.sourceId === clip.sourceId);
  if (f) {
    // Light boundary nudge only — do not jump far from requested source range
    const s2 = nearestSafeBoundary(start, f, 'in', 0.35);
    const e2 = nearestSafeBoundary(end, f, 'out', 0.35);
    if (Math.abs(s2 - start) <= 0.35) start = s2;
    if (Math.abs(e2 - end) <= 0.35) end = e2;
    start = Math.max(0, Math.min(start, srcDur - MIN_USABLE_CLIP_SECONDS));
    end = Math.min(srcDur, Math.max(start + MIN_USABLE_CLIP_SECONDS, end));
  }

  // Intentional shrink: snap without ensureActionComplete expansion
  const snapped = snapClipToIntel(
    { ...clip, start, end },
    intel,
    {
      allowExpand: !shrinking,
      preferShots: opts.preferShots,
      expandCeiling: opts.expandCeiling ?? (shrinking ? end : undefined),
    }
  );
  // Hard cap: never expand past requested sourceEnd on shrink
  if (shrinking && snapped.end > end + 0.02) {
    snapped.end = end;
  }

  if (isNoOpRange(clip, snapped)) {
    console.log(
      `[REVISION] AFTER: ${clip.id} source=${snapped.start.toFixed(1)}–${snapped.end.toFixed(1)} (no-op — failed)`
    );
    return null;
  }
  console.log(
    `[REVISION] AFTER: ${clip.id} source=${snapped.start.toFixed(1)}–${snapped.end.toFixed(1)}`
  );
  return {
    clip: snapped,
    change: `${label} ${clip.id} source=${clip.start.toFixed(1)}–${clip.end.toFixed(1)} → ${snapped.start.toFixed(1)}–${snapped.end.toFixed(1)}`,
  };
}

/**
 * Group critic issues that touch the same source region (adjacent clips / shared hole)
 * and apply one atomic transaction per region.
 */
function groupIssuesByRegion(
  sequence: PlannedClip[],
  issues: CriticIssue[],
  current: ValidatedEditPlan
): CriticIssue[][] {
  const resolved = issues.map((issue) => {
    const clip = resolveClipForIssue({ ...current, sequence }, issue);
    return { issue, clipId: clip?.id || null, sourceId: clip?.sourceId || null };
  });

  const groups: CriticIssue[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < resolved.length; i++) {
    if (used.has(i) || !resolved[i].clipId) continue;
    const group = [resolved[i].issue];
    used.add(i);
    const idx = sequence.findIndex((c) => c.id === resolved[i].clipId);
    let prevIdx = idx - 1;
    while (prevIdx >= 0 && sequence[prevIdx].isBroll) prevIdx--;
    let nextIdx = idx + 1;
    while (nextIdx < sequence.length && sequence[nextIdx].isBroll) nextIdx++;
    const neighborIds = new Set<string>();
    if (prevIdx >= 0) neighborIds.add(sequence[prevIdx].id);
    if (nextIdx < sequence.length) neighborIds.add(sequence[nextIdx].id);
    neighborIds.add(resolved[i].clipId!);

    for (let j = i + 1; j < resolved.length; j++) {
      if (used.has(j) || !resolved[j].clipId) continue;
      const sameSource = resolved[j].sourceId === resolved[i].sourceId;
      const adjacent = neighborIds.has(resolved[j].clipId!);
      if (sameSource && adjacent) {
        group.push(resolved[j].issue);
        used.add(j);
        neighborIds.add(resolved[j].clipId!);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Atomic region fix: previous too long + next starts mid-word →
 * shorten previous out + extend next start backward to a safe boundary.
 */
function applyAtomicRegionRevision(
  sequence: PlannedClip[],
  group: CriticIssue[],
  intel: FootageIntelligence[],
  durations: SourceDurationMap,
  current: ValidatedEditPlan
): { sequence: PlannedClip[]; changes: string[] } {
  const changes: string[] = [];
  const nextSeq = sequence.map((c) => ({ ...c }));

  // Collect target clips in this region
  const clipIds: string[] = [];
  for (const issue of group) {
    const clip = resolveClipForIssue({ ...current, sequence: nextSeq }, issue);
    if (clip && !clipIds.includes(clip.id)) clipIds.push(clip.id);
  }
  if (!clipIds.length) return { sequence: nextSeq, changes };

  const indices = clipIds
    .map((id) => nextSeq.findIndex((c) => c.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);

  const preferShots = current.editPolicy === 'creative_recut';

  // Prefer explicit per-clip source range mutations (e.g. c0 23.5–88.5 → 23.5–28.0)
  // before pair-boundary heuristics — so shrinks actually persist.
  const explicitRangeIssues = group.filter((issue) => {
    const p = issue.parameters || {};
    return (
      typeof p.sourceStart === 'number' ||
      typeof p.sourceEnd === 'number' ||
      typeof p.newStart === 'number' ||
      typeof p.newEnd === 'number' ||
      issue.action === 'set_range' ||
      issue.action === 'trim_clip'
    );
  });

  if (explicitRangeIssues.length) {
    const touched = new Set<string>();
    for (const issue of explicitRangeIssues) {
      const clip = resolveClipForIssue({ ...current, sequence: nextSeq }, issue);
      if (!clip || touched.has(clip.id)) continue;
      const idx = nextSeq.findIndex((c) => c.id === clip.id);
      if (idx < 0) continue;
      const srcDur = durations[clip.sourceId] ?? clip.end + 5;
      const cur = nextSeq[idx];

      if (issue.action === 'trim_clip') {
        const bounds = resolveSourceBounds(issue, cur, intel);
        // Map remove* → excise; otherwise treat new*/source* as keep-range
        const hasExcise =
          typeof issue.parameters?.removeStart === 'number' &&
          typeof issue.parameters?.removeEnd === 'number';
        if (!hasExcise && (bounds.newStart !== cur.start || bounds.newEnd !== cur.end)) {
          const result = applySetRange(
            cur,
            bounds.newStart,
            bounds.newEnd,
            srcDur,
            intel,
            'trim_clip',
            { preferShots }
          );
          if (result) {
            nextSeq[idx] = result.clip;
            changes.push(result.change);
            touched.add(cur.id);
          }
          continue;
        }
        console.log(
          `[REVISION] BEFORE: ${cur.id} source=${cur.start.toFixed(1)}–${cur.end.toFixed(1)}`
        );
        const { sequence: mutated, change } = applyTrimClipMutation(
          nextSeq,
          idx,
          issue,
          srcDur,
          intel
        );
        if (change && !change.includes('skipped') && !change.includes('no-op')) {
          nextSeq.length = 0;
          nextSeq.push(...mutated);
          const afterIdx = nextSeq.findIndex((c) => c.id === cur.id);
          if (afterIdx >= 0 && change.includes('→') && !change.includes('excised')) {
            // Soft snap without expansion
            nextSeq[afterIdx] = snapClipToIntel(nextSeq[afterIdx], intel, {
              allowExpand: false,
              preferShots,
            });
            if (isNoOpRange(cur, nextSeq[afterIdx])) {
              console.log(
                `[REVISION] AFTER: ${cur.id} source=${cur.start.toFixed(1)}–${cur.end.toFixed(1)} (no-op — failed)`
              );
              nextSeq[afterIdx] = cur;
            } else {
              console.log(
                `[REVISION] AFTER: ${cur.id} source=${nextSeq[afterIdx].start.toFixed(1)}–${nextSeq[afterIdx].end.toFixed(1)}`
              );
              changes.push(
                `trim_clip ${cur.id} source=${cur.start.toFixed(1)}–${cur.end.toFixed(1)} → ${nextSeq[afterIdx].start.toFixed(1)}–${nextSeq[afterIdx].end.toFixed(1)}`
              );
              touched.add(cur.id);
            }
          } else if (change) {
            changes.push(change);
            touched.add(cur.id);
          }
        } else {
          console.log(`[REVISION] AFTER: ${cur.id} (no-op — failed)`);
        }
        continue;
      }

      const bounds = resolveSourceBounds(issue, cur, intel);
      const result = applySetRange(
        cur,
        bounds.newStart,
        bounds.newEnd,
        srcDur,
        intel,
        issue.action === 'set_range' ? 'set_range' : String(issue.action || 'set_range'),
        { preferShots }
      );
      if (result) {
        nextSeq[idx] = result.clip;
        changes.push(result.change);
        touched.add(cur.id);
      }
    }

    // After explicit shrinks, repair any remaining same-source overlap
    if (hasSourceOverlap(nextSeq)) {
      const repaired = repairSourceOverlaps(nextSeq, MIN_USABLE_CLIP_SECONDS);
      if (repaired.repairs.length) {
        nextSeq.length = 0;
        nextSeq.push(...repaired.sequence);
        changes.push(...repaired.repairs.map((r) => `auto ${r}`));
      }
    }
    if (changes.length) return { sequence: nextSeq, changes };
  }

  // Pair-wise: if two adjacent A-roll clips, resolve shared hole atomically once
  if (indices.length >= 2) {
    const aIdx = indices[0];
    const bIdx = indices[indices.length - 1];
    const a = nextSeq[aIdx];
    const b = nextSeq[bIdx];
    if (
      !a.isBroll &&
      !b.isBroll &&
      a.sourceId === b.sourceId &&
      bIdx > aIdx
    ) {
      const f = intel.find((i) => i.sourceId === a.sourceId);
      const srcDur = durations[a.sourceId] ?? a.end + 5;
      let boundary = a.end <= b.start ? (a.end + b.start) / 2 : b.start;
      for (const issue of group) {
        const bounds = resolveSourceBounds(issue, a, intel);
        const startHint =
          typeof issue.parameters?.sourceStart === 'number'
            ? issue.parameters.sourceStart
            : issue.parameters?.newStart ??
              parseStartHint(issue.recommendation || issue.problem || '');
        const endHint =
          typeof issue.parameters?.sourceEnd === 'number'
            ? issue.parameters.sourceEnd
            : issue.parameters?.newEnd ??
              parseExtendHint(issue.recommendation || issue.problem || '');
        // Prefer explicit sourceEnd on the earlier clip (hook trim)
        if (endHint != null && endHint < a.end && endHint > a.start) {
          boundary = endHint;
        } else if (looksMidWordIssue(issue) && startHint != null) {
          boundary = startHint;
        } else if (bounds.newEnd < a.end && bounds.newEnd > a.start) {
          boundary = bounds.newEnd;
        }
      }
      if (f) boundary = nearestSafeBoundary(boundary, f, 'in', 0.5);

      const aEnd = Math.min(a.end, Math.max(a.start + MIN_USABLE_CLIP_SECONDS, boundary));
      const bStart = Math.max(boundary, Math.min(b.start, b.end - MIN_USABLE_CLIP_SECONDS));
      const aResult = applySetRange(a, a.start, aEnd, srcDur, intel, 'set_range', {
        preferShots,
      });
      const bResult = applySetRange(
        b,
        Math.min(bStart, b.end - MIN_USABLE_CLIP_SECONDS),
        b.end,
        srcDur,
        intel,
        'set_range',
        { preferShots }
      );
      if (aResult) {
        nextSeq[aIdx] = aResult.clip;
        changes.push(`atomic ${aResult.change}`);
      }
      if (bResult) {
        const bNow = nextSeq.findIndex((c) => c.id === b.id);
        if (bNow >= 0) {
          const prev = nextSeq[aIdx];
          let start = bResult.clip.start;
          if (start < prev.end - 0.02) start = prev.end;
          if (bResult.clip.end - start >= MIN_USABLE_CLIP_SECONDS) {
            nextSeq[bNow] = { ...bResult.clip, start };
            changes.push(`atomic ${bResult.change}`);
          }
        }
      }
      if (hasSourceOverlap(nextSeq)) {
        const repaired = repairSourceOverlaps(nextSeq, MIN_USABLE_CLIP_SECONDS);
        nextSeq.length = 0;
        nextSeq.push(...repaired.sequence);
        changes.push(...repaired.repairs.map((r) => `auto ${r}`));
      }
      const left = nextSeq.find((c) => c.id === a.id);
      const right = nextSeq.find((c) => c.id === b.id);
      if (
        left &&
        right &&
        (right.start < left.end - 0.05 ||
          left.end - left.start < MIN_USABLE_CLIP_SECONDS ||
          right.end - right.start < MIN_USABLE_CLIP_SECONDS)
      ) {
        console.warn('[REVISION] atomic region produced invalid pair — reverting region');
        return { sequence, changes: [] };
      }
      return { sequence: nextSeq, changes };
    }
  }

  // Single-clip / non-pair fallback
  const touched = new Set<string>();
  for (const issue of group) {
    const clip = resolveClipForIssue({ ...current, sequence: nextSeq }, issue);
    if (!clip) continue;
    const idx = nextSeq.findIndex((c) => c.id === clip.id);
    if (idx < 0) continue;
    const srcDur = durations[clip.sourceId] ?? clip.end + 5;
    const cur = nextSeq[idx];

    if (issue.action === 'set_zoom' || issue.action === 'normalize_zoom' || issue.action === 'hard_cut') {
      continue;
    }

    if (touched.has(cur.id) && (issue.action === 'trim_clip' || issue.action === 'extend_clip')) {
      console.log(`[REVISION] skipped contradictory ${issue.action} on ${cur.id} (already mutated in region)`);
      continue;
    }

    switch (issue.action) {
      case 'set_range': {
        const bounds = resolveSourceBounds(issue, cur, intel);
        const result = applySetRange(
          cur,
          bounds.newStart,
          bounds.newEnd,
          srcDur,
          intel,
          'set_range',
          { preferShots }
        );
        if (result) {
          nextSeq[idx] = result.clip;
          changes.push(result.change);
          touched.add(cur.id);
        }
        break;
      }
      case 'extend_clip':
      case 'complete_ending': {
        const prose = `${issue.recommendation || ''} ${issue.problem || ''}`;
        const p = issue.parameters || {};
        const hasExplicitEnd =
          typeof p.sourceEnd === 'number' || typeof p.newEnd === 'number';
        const hasExplicitStart =
          typeof p.sourceStart === 'number' || typeof p.newStart === 'number';
        const bounds = resolveSourceBounds(issue, cur, intel);
        const startHint = parseStartHint(prose);
        const endHint = parseExtendHint(prose);
        const isTrunc = /truncat|cut(?:s|ting)? (?:off|into)|mid[- ]?(?:sentence|thought|word)|incomplete thought|incomplete word|abrupt(?:ly)?/i.test(prose);

        let newStart = hasExplicitStart
          ? bounds.newStart
          : startHint ?? cur.start;
        const fForEnd = intel.find((i) => i.sourceId === cur.sourceId);
        const protectedEnd =
          fForEnd?.audioEnvelope != null
            ? tailOutAfterSpeech(fForEnd.audioEnvelope, 0.35)
            : lastPrimarySpeechEnd(fForEnd!) ?? null;
        let newEnd = endHint != null && endHint > cur.end
          ? endHint
          : hasExplicitEnd && bounds.newEnd > cur.end
            ? bounds.newEnd
            : isTrunc || issue.action === 'complete_ending'
              ? Math.min(
                  srcDur,
                  protectedEnd != null
                    ? Math.max(cur.end, protectedEnd)
                    : cur.end + 1.8
                )
              : endHint ?? (hasExplicitStart || startHint != null ? cur.end : Math.min(srcDur, cur.end + 1.2));

        if (
          looksMidWordIssue(issue) &&
          hasExplicitEnd &&
          !hasExplicitStart &&
          bounds.newEnd < cur.start + 0.5
        ) {
          newStart = bounds.newEnd;
          newEnd = cur.end;
        }
        // extend never shrinks
        if (newStart > cur.start) newStart = cur.start;
        if (newEnd < cur.end) newEnd = cur.end;
        // If truncation is detected but newEnd didn't advance past cur.end, advance it!
        if (isTrunc && newEnd <= cur.end + 0.05) {
          newEnd = endHint != null && endHint > cur.end ? endHint : Math.min(srcDur, cur.end + 1.8);
          console.log(
            `[EXTEND EXPANSION] advanced ${cur.id} from ${cur.end.toFixed(1)} to ${newEnd.toFixed(1)} for truncation`
          );
        }
        // Explicit end equal to current end with no start move → no-op only if not truncated
        if (
          !isTrunc &&
          hasExplicitEnd &&
          !hasExplicitStart &&
          Math.abs(newEnd - cur.end) < 0.04 &&
          Math.abs(newStart - cur.start) < 0.04
        ) {
          console.log(
            `[REVISION] skipped no-op ${issue.action} ${cur.id} source=${cur.start.toFixed(1)}–${cur.end.toFixed(1)}`
          );
          break;
        }
        const result = applySetRange(cur, newStart, newEnd, srcDur, intel, issue.action, {
          preferShots,
        });
        if (result) {
          nextSeq[idx] = result.clip;
          changes.push(result.change);
          touched.add(cur.id);
        }
        break;
      }
      case 'trim_clip': {
        const bounds = resolveSourceBounds(issue, cur, intel);
        const result = applySetRange(
          cur,
          bounds.newStart,
          bounds.newEnd,
          srcDur,
          intel,
          'trim_clip',
          { preferShots }
        );
        if (result) {
          nextSeq[idx] = result.clip;
          changes.push(result.change);
          touched.add(cur.id);
        }
        break;
      }
      default:
        break;
    }
  }

  return { sequence: nextSeq, changes };
}

/**
 * Apply Critic actions as targeted EDL mutations — do NOT regenerate the whole plan.
 * Returns { plan, changes } for the iteration ledger.
 * Rejects revisions that fail speech/CTA/range validation (keeps previous EDL).
 */
export function applyCriticActions(
  current: ValidatedEditPlan,
  issues: CriticIssue[],
  intel: FootageIntelligence[]
): { plan: ValidatedEditPlan; changes: string[]; rejected: string[] } {
  const durations = sourceDurationMap(intel);
  const rejected: string[] = [];
  let actionable = issues.filter(
    (i) =>
      (i.severity === 'high' || i.severity === 'medium') &&
      i.action &&
      i.action !== 'none'
  );
  if (!actionable.length) {
    // Try parse recommendation for extend / start hints on high issues
    const parsed: CriticIssue[] = [];
    for (const i of issues.filter((x) => x.severity === 'high' || x.severity === 'medium')) {
      const prose = i.recommendation || i.reason || i.problem || '';
      const endHint = parseExtendHint(prose);
      const startHint = parseStartHint(prose);
      if (endHint != null || startHint != null) {
        const params = { ...(i.parameters || {}) };
        if (endHint != null) params.newEnd = endHint;
        if (startHint != null) params.newStart = startHint;
        const action =
          startHint != null && endHint != null
            ? 'set_range'
            : i.category === 'ending'
              ? 'complete_ending'
              : startHint != null
                ? 'extend_clip'
                : 'extend_clip';
        parsed.push({ ...i, action, parameters: params });
      }
    }
    if (!parsed.length) return { plan: current, changes: [], rejected };
    return applyCriticActions(current, parsed, intel);
  }

  const isUgcDirected =
    current.editPolicy === 'directed' &&
    intel.length === 1;
  const isPolish = current.editPolicy === 'directed';

  // Polish critic may only emit head/tail trim/extend, overlay, audio — no interior cuts
  if (isPolish) {
    const POLISH_OK = new Set([
      'trim_clip',
      'extend_clip',
      'set_range',
      'complete_ending',
      'add_overlay',
      'fix_audio',
      'adjust_music',
      'punch_in',
      'none',
    ]);
    const filtered: CriticIssue[] = [];
    for (const i of actionable) {
      if (!POLISH_OK.has(i.action || 'none')) {
        rejected.push(`polish-blocked ${i.action}: ${i.problem}`);
        continue;
      }
      filtered.push(i);
    }
    actionable = filtered;
  }

  // Convert every issue to SOURCE coords, then promote/infer actions
  actionable = actionable.map((rawIssue) => {
    const issue = ensureSourceParams(current, rawIssue);
    const prose = `${issue.recommendation || ''} ${issue.problem || ''} ${issue.reason || ''} ${issue.seenHeard || ''}`;
    const params = { ...(issue.parameters || {}) };
    let action = issue.action;

    const isTruncation = /truncat|cut(?:s|ting)? (?:off|into)|mid[- ]?(?:sentence|thought|word)|incomplete thought|incomplete word|abrupt(?:ly)?/i.test(prose);
    if (isTruncation && (action === 'trim_clip' || action === 'none')) {
      console.log(`[ACTIONABLE INFERENCE] converting ${action} to extend_clip for truncation issue: ${issue.problem}`);
      action = 'extend_clip';
    }

    // Canonical source coords: prefer sourceStart/sourceEnd, mirror onto new*
    if (typeof params.sourceStart === 'number' && params.newStart == null) {
      params.newStart = params.sourceStart;
    }
    if (typeof params.sourceEnd === 'number' && params.newEnd == null) {
      params.newEnd = params.sourceEnd;
    }
    if (typeof params.newStart === 'number' && params.sourceStart == null) {
      params.sourceStart = params.newStart;
    }
    if (typeof params.newEnd === 'number' && params.sourceEnd == null) {
      params.sourceEnd = params.newEnd;
    }
    if (params.newStart == null && params.sourceStart == null) {
      const sh = parseStartHint(prose);
      if (sh != null) {
        params.newStart = sh;
        params.sourceStart = sh;
      } else {
        const isLeadingArtifact =
          /pre-speech|vocal artifact|breath|mouth noise|throat|opens? with (?:an? )?(?:audible )?(?:vocal|noise|artifact)|leading (?:noise|silence|dead air)/i.test(
            prose
          );
        if (isLeadingArtifact) {
          const clip = resolveClipForIssue(current, issue);
          if (clip) {
            const f = intel.find((x) => x.sourceId === clip.sourceId);
            if (f) {
              const speech = primarySpeechIntervals(f);
              const relevant = speech.find((s) => s.end > clip.start + 0.1 && s.start < clip.end);
              if (relevant && relevant.start > clip.start + 0.05) {
                const cleanStart = Math.min(clip.end - 0.5, Math.max(clip.start, relevant.start));
                params.newStart = cleanStart;
                params.sourceStart = cleanStart;
                console.log(`[ACTIONABLE INFERENCE] resolved newStart=${cleanStart.toFixed(2)} for ${action}`);
              }
            }
          }
        }
      }
    }
    const eh = parseExtendHint(prose);
    if (eh != null) {
      if (isTruncation || params.newEnd == null || (typeof params.newEnd === 'number' && params.newEnd < eh)) {
        params.newEnd = eh;
        params.sourceEnd = eh;
      }
    }

    // Tail black: convert TIMELINE issue.start → SOURCE via toSourceTime (never assign raw)
    const isTailBlack = /black (?:frame|screen)|blank (?:frame|black)|pure black|dead silence at (?:the )?end|ends? on .*black/i.test(prose);
    if (isTailBlack) {
      action = 'trim_clip';
      const lastClip = current.sequence[current.sequence.length - 1];
      if (lastClip && !params.clipId) {
        params.clipId = lastClip.id;
      }
      if (typeof issue.start === 'number' && issue.start > 0 && params.sourceEnd == null) {
        const mapped = toSourceTime(current, issue.start, params.clipId);
        if (mapped) {
          params.newEnd = mapped.sourceT;
          params.sourceEnd = mapped.sourceT;
          params.clipId = mapped.clipId;
          console.log(
            `[TIME] tail-black timeline ${issue.start.toFixed(2)} → source ${mapped.sourceT.toFixed(2)}`
          );
        }
      }
    }

    if (
      action === 'extend_clip' &&
      typeof params.newStart === 'number' &&
      typeof params.newEnd === 'number'
    ) {
      return { ...issue, action: 'set_range' as const, parameters: params };
    }
    return { ...issue, action, parameters: params };
  });

  let sequence = current.sequence.map((c) => ({ ...c }));
  const changes: string[] = [];

  // Split range mutations (atomic) vs visual-only mutations
  const rangeActions = new Set(['extend_clip', 'complete_ending', 'trim_clip', 'set_range']);
  const rangeIssues = actionable.filter((i) => rangeActions.has(i.action || ''));
  const otherIssues = actionable.filter((i) => !rangeActions.has(i.action || ''));

  const groups = groupIssuesByRegion(sequence, rangeIssues, current);
  for (const group of groups) {
    const before = sequence.map((c) => ({ ...c }));
    const { sequence: mutated, changes: regionChanges } = applyAtomicRegionRevision(
      sequence,
      group,
      intel,
      durations,
      current
    );
    if (!regionChanges.length) continue;

    // UGC single-take uses stricter speech/CTA checks; raw imports use overlap/min-dur only
    const check = isUgcDirected
      ? validateUgcEdlSequence(mutated, intel)
      : validateGeneralEdlSequence(mutated, intel);
    if (!check.ok) {
      // Try overlap auto-repair before rejecting
      const repaired = repairSourceOverlaps(mutated, MIN_USABLE_CLIP_SECONDS);
      const check2 = isUgcDirected
        ? validateUgcEdlSequence(repaired.sequence, intel)
        : validateGeneralEdlSequence(repaired.sequence, intel);
      if (!check2.ok) {
        // Retry once with corrected source bounds (clamp into source duration)
        const clamped = repaired.sequence.map((c) => {
          const srcDur = durations[c.sourceId] ?? c.end;
          const start = Math.max(0, Math.min(c.start, srcDur - MIN_USABLE_CLIP_SECONDS));
          const end = Math.max(start + MIN_USABLE_CLIP_SECONDS, Math.min(c.end, srcDur));
          return { ...c, start, end };
        });
        const check3 = isUgcDirected
          ? validateUgcEdlSequence(clamped, intel)
          : validateGeneralEdlSequence(clamped, intel);
        if (!check3.ok) {
          const reason = check.errors.map((e) => e.message).join('; ');
          console.warn(`[REVISION] rejected region revision (invalid EDL): ${reason}`);
          rejected.push(`rejected: ${reason}`);
          sequence = before;
          continue;
        }
        sequence = clamped;
        changes.push(...regionChanges, 'retry clamped bounds');
        continue;
      }
      sequence = repaired.sequence;
      changes.push(...regionChanges, ...repaired.repairs.map((r) => `auto ${r}`));
      continue;
    }
    sequence = mutated;
    changes.push(...regionChanges);
  }

  for (const issue of otherIssues) {
    const clip = resolveClipForIssue({ ...current, sequence }, issue);
    if (!clip) continue;
    const idx = sequence.findIndex((c) => c.id === clip.id);
    if (idx < 0) continue;
    const next = { ...sequence[idx] };

    switch (issue.action) {
      case 'set_zoom': {
        const z = clampZoomForStyle(issue.parameters?.zoom ?? 1.06, current.style);
        if (Math.abs((next.zoom || 1) - z) < 0.005) {
          console.log(`[REVISION] skipped no-op set_zoom ${next.id}`);
          break;
        }
        changes.push(`set_zoom ${next.id} ${(next.zoom || 1).toFixed(2)}→${z.toFixed(2)}`);
        sequence[idx] = {
          ...next,
          zoom: z,
          crop: z > 1 ? 'face_priority' : 'none',
        };
        break;
      }
      case 'normalize_zoom': {
        const vals = issue.parameters?.zoomValues || [1.0, 1.06];
        const a = clampZoomForStyle(vals[0] ?? 1, current.style);
        const b = clampZoomForStyle(vals[1] ?? 1.06, current.style);
        let prevIdx = idx - 1;
        while (prevIdx >= 0 && sequence[prevIdx].isBroll) prevIdx--;
        if (prevIdx >= 0) {
          sequence[prevIdx] = {
            ...sequence[prevIdx],
            zoom: a,
            crop: a > 1 ? 'face_priority' : 'none',
          };
        }
        sequence[idx] = {
          ...next,
          zoom: b,
          crop: b > 1 ? 'face_priority' : 'none',
        };
        changes.push(
          `normalize_zoom ${prevIdx >= 0 ? sequence[prevIdx].id + '/' : ''}${next.id} → ${a.toFixed(2)}/${b.toFixed(2)}`
        );
        break;
      }
      case 'hard_cut': {
        sequence[idx] = {
          ...next,
          transitionIn: 'hard_cut',
          transitionOut: 'hard_cut',
          transitionDuration: 0,
        };
        if (idx > 0) {
          sequence[idx - 1] = {
            ...sequence[idx - 1],
            transitionOut: 'hard_cut',
            transitionDuration: 0,
          };
        }
        changes.push(`hard_cut at ${next.id}`);
        break;
      }
      default:
        break;
    }
  }

  // Clamp all zooms after mutations
  for (const c of sequence) {
    c.zoom = clampZoomForStyle(c.zoom, current.style);
  }

  // Always repair residual same-source overlaps before accept
  if (hasSourceOverlap(sequence)) {
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    sequence = repaired.sequence;
    if (repaired.repairs.length) {
      changes.push(...repaired.repairs.map((r) => `auto ${r}`));
      console.log(`[REVISION] overlap auto-repair: ${repaired.repairs.join('; ')}`);
    }
  }

  // Final revalidation — UGC speech/CTA only for directed single-take; else general
  const finalCheck = isUgcDirected
    ? validateUgcEdlSequence(sequence, intel)
    : validateGeneralEdlSequence(sequence, intel);
  if (!finalCheck.ok && changes.length) {
    const hardErrors = finalCheck.errors.filter((e) => e.code !== 'cta' && e.code !== 'coverage');
    if (hardErrors.length > 0) {
      const reason = hardErrors.map((e) => e.message).join('; ');
      console.warn(`[REVISION] rejected full revision (keeping previous EDL): ${reason}`);
      rejected.push(`final-reject: ${reason}`);
      return { plan: current, changes: [], rejected };
    } else {
      console.log(`[REVISION] accepted speech revision with notes: ${finalCheck.errors.map((e) => e.message).join('; ')}`);
    }
  }

  // Never ship an overlapping EDL even if validation somehow soft-failed
  if (hasSourceOverlap(sequence)) {
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    sequence = repaired.sequence;
    if (hasSourceOverlap(sequence)) {
      console.warn('[REVISION] overlap remains after repair — keeping previous EDL');
      rejected.push('overlap remains after repair');
      return { plan: current, changes: [], rejected };
    }
  }

  const raw = {
    ...current,
    sequence,
    iteration: current.iteration + 1,
  };
  const result = validateEditPlan(raw, durations, {
    projectId: current.projectId,
    iteration: current.iteration + 1,
    defaultAspect: current.aspectRatio,
    defaultStyle: current.style,
    targetDuration: current.targetDuration,
  });

  if (result.ok && result.plan) {
    if (rejected.length) {
      console.log(`[REVISION] accepted ${changes.length}; rejected ${rejected.length}: ${rejected.join(' | ')}`);
    }
    return { plan: result.plan, changes, rejected };
  }

  // If validateEditPlan failed only on overlap notes we already cleared — try once more after repair
  if (result.errors?.some((e) => e.includes('overlap'))) {
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    const retry = validateEditPlan(
      { ...raw, sequence: repaired.sequence },
      durations,
      {
        projectId: current.projectId,
        iteration: current.iteration + 1,
        defaultAspect: current.aspectRatio,
        defaultStyle: current.style,
        targetDuration: current.targetDuration,
      }
    );
    if (retry.ok && retry.plan) {
      return {
        plan: retry.plan,
        changes: [...changes, ...repaired.repairs.map((r) => `auto ${r}`)],
        rejected,
      };
    }
  }

  const failReason = result.errors?.join('; ') || 'validation failed';
  console.warn('[REVISION] validation failed after mutate — keeping previous EDL:', failReason);
  rejected.push(`validate: ${failReason}`);
  return { plan: current, changes: [], rejected };
}

/** @deprecated Prefer applyCriticActions — kept as thin wrapper for callers */
export async function revisePlanWithCritic(
  _ai: AiClient,
  current: ValidatedEditPlan,
  issues: CriticIssue[],
  intel: FootageIntelligence[],
  _brief: DirectorCreativeBrief
): Promise<ValidatedEditPlan> {
  const { plan, changes } = applyCriticActions(current, issues, intel);
  if (changes.length) {
    console.log(`[REVISION] targeted mutations: ${changes.join('; ')}`);
  } else {
    console.log('[REVISION] no actionable mutations from Critic issues');
  }
  return plan;
}

export async function runPlanner(
  _ai: AiClient,
  brief: DirectorCreativeBrief,
  intel: FootageIntelligence[],
  projectId: string
): Promise<ValidatedEditPlan> {
  return planFromBrief(brief, intel, projectId, 0);
}
