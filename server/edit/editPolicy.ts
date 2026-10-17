/**
 * Two editing policies:
 *   directed      — TakeOne-recorded UGC. Polish the already-directed performance.
 *   creative_recut — Imported/raw footage. Find the best story.
 *
 * Directed locks scene/beat order and refuses whole-source drops of required beats.
 * trim_clip mutations excise a bad window instead of collapsing a keep into a flash frame.
 */
import type {
  ClipRole,
  CriticIssue,
  DirectorCreativeBrief,
  EditPolicy,
  FootageIntelligence,
  GranularCutAction,
  IntendedBeat,
  KeepDropDecision,
  PlannedClip,
  ValidatedEditPlan,
} from '../../src/types/editorial';
import {
  firstPrimarySpeechStart,
  lastPrimarySpeechEnd,
} from './edlHoles';

export const MIN_USABLE_CLIP_SECONDS = 0.8;
export const FLASH_FRAME_SECONDS = 0.55;

export type ProjectForPolicy = {
  entryPath?: 'shoot' | 'import' | string;
  captureStrategy?: string;
  creativeBrief?: { contentType?: string; editingStrategy?: string };
  narrativeBeats?: Array<{ id?: string; title?: string; purpose?: string }>;
  scenes?: Array<{
    id: string;
    sceneNumber?: number;
    title?: string;
    purpose?: string;
    filmedBy?: string;
    mediaSource?: string;
    editIntent?: string;
    includeInExport?: boolean;
  }>;
};

export function inferEditPolicy(project: ProjectForPolicy | null | undefined): EditPolicy {
  if (!project) return 'directed';
  if (project.creativeBrief?.contentType === 'ugc_ad') return 'directed';
  if (project.entryPath === 'import') return 'creative_recut';
  if (project.entryPath === 'shoot') return 'directed';
  const scenes = project.scenes || [];
  const user = scenes.filter((s) => !s.filmedBy || s.filmedBy === 'user');
  if (!user.length) return 'directed';
  const imported = user.filter(
    (s) => s.mediaSource === 'imported' || String(s.id).toLowerCase().includes('import')
  );
  if (imported.length >= Math.max(1, user.length * 0.6)) return 'creative_recut';
  return 'directed';
}

export function roleFromIntent(
  intent: string | undefined,
  index: number,
  lastIndex: number
): ClipRole {
  const i = String(intent || '').toLowerCase();
  if (i === 'hook') return 'hook';
  if (i === 'cta' || i === 'ending') return 'cta';
  if (i === 'demonstration' || i === 'payoff' || i === 'product' || i === 'benefit') return 'proof';
  if (i === 'explanation' || i === 'problem') return 'explanation';
  if (i === 'broll') return 'broll';
  if (i === 'reaction' || i === 'transition') return 'bridge';
  if (index === 0) return 'hook';
  if (index === lastIndex) return 'cta';
  if (i === 'context' || i === 'establishing' || i === 'progression') return 'context';
  if (index === 1) return 'context';
  if (index === lastIndex - 1) return 'proof';
  return 'explanation';
}

export function intendedBeatsFromProject(
  project: ProjectForPolicy | null | undefined,
  intel: FootageIntelligence[]
): IntendedBeat[] {
  const intelIds = new Set(intel.map((f) => f.sourceId));
  const scenes = [...(project?.scenes || [])]
    .filter((s) => s.filmedBy !== 'ai' && intelIds.has(s.id))
    .sort((a, b) => (a.sceneNumber || 0) - (b.sceneNumber || 0));

  if (scenes.length) {
    return scenes.map((s, i, arr) => {
      const intent = String(s.editIntent || '');
      const optional = intent === 'broll' || intent === 'transition' || s.includeInExport === false;
      return {
        sourceId: s.id,
        label: s.title || s.purpose || `Scene ${s.sceneNumber || i + 1}`,
        required: !optional,
        role: roleFromIntent(s.editIntent, i, arr.length - 1),
      };
    });
  }

  return intel.map((f, i, arr) => ({
    sourceId: f.sourceId,
    label: f.title || f.sourceId,
    required: true,
    role: roleFromIntent(undefined, i, arr.length - 1),
  }));
}

export function usableRangeForSource(f: FootageIntelligence): { start: number; end: number } {
  // Prefer primary-speaker speech bounds so trailing chatter/"Hey" is not kept
  // as part of the default directed range (hole materialization still splits interiors).
  const speechStart = firstPrimarySpeechStart(f);
  const speechEnd = lastPrimarySpeechEnd(f);
  if (
    speechStart != null &&
    speechEnd != null &&
    speechEnd - speechStart >= MIN_USABLE_CLIP_SECONDS
  ) {
    return {
      start: Math.max(0, speechStart),
      end: Math.min(f.sourceDuration, speechEnd),
    };
  }

  const segs = f.segments || [];
  const keep = segs.filter(
    (s) => !s.containsMistake && !(s.containsSilence && s.end - s.start > 2)
  );
  if (keep.length) {
    const start = Math.min(...keep.map((s) => s.start));
    const end = Math.min(f.sourceDuration, Math.max(...keep.map((s) => s.end)));
    if (end - start >= MIN_USABLE_CLIP_SECONDS) return { start, end };
  }
  const speech = segs.filter((s) => !s.containsSilence);
  if (speech.length) {
    const start = Math.min(...speech.map((s) => s.start));
    const end = Math.min(f.sourceDuration, Math.max(...speech.map((s) => s.end)));
    if (end - start >= 0.4) return { start, end };
  }
  return { start: 0, end: Math.max(MIN_USABLE_CLIP_SECONDS, f.sourceDuration) };
}

function isWholeSourceDrop(
  g: { sourceId: string; start: number; end: number; action?: string },
  intelById: Map<string, FootageIntelligence>
): boolean {
  if (g.action !== 'drop') return false;
  const f = intelById.get(g.sourceId);
  if (!f) return false;
  const span = g.end - g.start;
  return span >= Math.min(f.sourceDuration, Math.max(2, f.sourceDuration * 0.75));
}

function clampRange(
  start: number,
  end: number,
  srcDur: number
): { start: number; end: number } {
  const s = Math.max(0, Math.min(start, Math.max(0, srcDur - MIN_USABLE_CLIP_SECONDS)));
  const e = Math.max(s + MIN_USABLE_CLIP_SECONDS, Math.min(end, srcDur));
  return { start: s, end: e };
}

/** Hard lock: required beats stay, in creator order. Polish trims are kept. */
export function lockBriefToDirectedPolicy(
  brief: DirectorCreativeBrief,
  intel: FootageIntelligence[],
  beats: IntendedBeat[]
): DirectorCreativeBrief {
  const intelById = new Map(intel.map((f) => [f.sourceId, f]));
  const required = beats.filter((b) => b.required && intelById.has(b.sourceId));
  const order = required.length
    ? required.map((b) => b.sourceId)
    : intel.map((f) => f.sourceId);
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  const cuts: GranularCutAction[] = [...(brief.granularCuts || [])].filter((g) => {
    if (isWholeSourceDrop(g, intelById) && orderIndex.has(g.sourceId)) {
      console.log(
        `[EDIT POLICY] refused whole-source drop ${g.sourceId} ${g.start.toFixed(1)}–${g.end.toFixed(1)}`
      );
      return false;
    }
    return true;
  });

  const keepDrop: KeepDropDecision[] = [...(brief.keepDrop || [])].filter((k) => {
    if (isWholeSourceDrop(k, intelById) && orderIndex.has(k.sourceId)) {
      console.log(
        `[EDIT POLICY] refused whole-source drop ${k.sourceId} ${k.start.toFixed(1)}–${k.end.toFixed(1)}`
      );
      return false;
    }
    return true;
  });

  for (const id of order) {
    const f = intelById.get(id)!;
    const u = usableRangeForSource(f);
    if (!cuts.some((g) => g.sourceId === id && g.action !== 'drop')) {
      cuts.push({
        sourceId: id,
        start: u.start,
        end: u.end,
        action: 'keep',
        reason: 'required directed beat',
      });
    }
    if (!keepDrop.some((k) => k.sourceId === id && k.action === 'keep')) {
      keepDrop.push({
        sourceId: id,
        start: u.start,
        end: u.end,
        action: 'keep',
        reason: 'required directed beat',
      });
    }
  }

  cuts.sort((a, b) => {
    const ia = orderIndex.has(a.sourceId) ? orderIndex.get(a.sourceId)! : 999;
    const ib = orderIndex.has(b.sourceId) ? orderIndex.get(b.sourceId)! : 999;
    if (ia !== ib) return ia - ib;
    return a.start - b.start;
  });

  const llmRoles = brief.sequenceRoles || [];
  const sequenceRoles = order.map((id, i) => {
    const f = intelById.get(id)!;
    const u = usableRangeForSource(f);
    const beat = required[i] || beats.find((b) => b.sourceId === id);
    const fromLlm = llmRoles.find((r) => r.sourceId === id);
    let start = fromLlm?.start ?? u.start;
    let end = fromLlm?.end ?? u.end;
    if (end - start < MIN_USABLE_CLIP_SECONDS) {
      start = u.start;
      end = u.end;
    }
    const clamped = clampRange(start, end, f.sourceDuration);
    return {
      sourceId: id,
      start: clamped.start,
      end: clamped.end,
      role: beat?.role || roleFromIntent(undefined, i, order.length - 1),
      notes: beat?.label || fromLlm?.notes,
      zoom: fromLlm?.zoom,
      transitionOut: 'hard_cut' as const,
    };
  });

  const first = sequenceRoles[0];
  return {
    ...brief,
    editPolicy: 'directed',
    intendedBeats: beats,
    openingHook: first
      ? {
          sourceId: first.sourceId,
          start: first.start,
          end: first.end,
          reason: 'first directed beat (scene order locked)',
        }
      : brief.openingHook,
    sequenceRoles,
    keepDrop,
    granularCuts: cuts,
    pacingNotes: `${brief.pacingNotes || ''} Directed footage: scene/beat order locked; polish only.`.trim(),
  };
}

/** After planner build: restore missing required sources and restore creator order. */
export function enforceDirectedSequence(
  sequence: PlannedClip[],
  intel: FootageIntelligence[],
  brief: DirectorCreativeBrief
): PlannedClip[] {
  const beats = brief.intendedBeats || [];
  const intelById = new Map(intel.map((f) => [f.sourceId, f]));
  const required = (beats.length ? beats : intel.map((f) => ({
    sourceId: f.sourceId,
    label: f.title || f.sourceId,
    required: true,
    role: undefined as ClipRole | undefined,
  }))).filter((b) => b.required !== false && intelById.has(b.sourceId));
  const order = required.map((b) => b.sourceId);
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  const aroll = sequence.filter((c) => !c.isBroll);
  const broll = sequence.filter((c) => c.isBroll);
  const present = new Set(aroll.map((c) => c.sourceId));

  const restored = [...aroll];
  let nextId = sequence.length;
  for (const beat of required) {
    if (present.has(beat.sourceId)) continue;
    const f = intelById.get(beat.sourceId)!;
    const u = usableRangeForSource(f);
    console.log(`[EDIT POLICY] restored required beat ${beat.sourceId} (${beat.label})`);
    restored.push({
      id: `r${nextId++}`,
      sourceId: beat.sourceId,
      start: u.start,
      end: u.end,
      role: beat.role || 'context',
      transitionIn: 'hard_cut',
      transitionOut: 'hard_cut',
      zoom: 1,
      musicDuck: 'speech',
      notes: `required directed beat: ${beat.label}`,
    });
    present.add(beat.sourceId);
  }

  restored.sort((a, b) => {
    const ia = orderIndex.has(a.sourceId) ? orderIndex.get(a.sourceId)! : 999;
    const ib = orderIndex.has(b.sourceId) ? orderIndex.get(b.sourceId)! : 999;
    if (ia !== ib) return ia - ib;
    return a.start - b.start;
  });

  if (restored[0] && restored[0].role !== 'hook') {
    restored[0] = { ...restored[0], role: 'hook' };
  }
  const lastA = restored.filter((c) => c.role !== 'broll');
  const last = lastA[lastA.length - 1];
  if (last && last !== restored[0] && (required[required.length - 1]?.role === 'cta' || last.role === 'context')) {
    const lastBeat = required[required.length - 1];
    if (lastBeat && last.sourceId === lastBeat.sourceId && lastBeat.role === 'cta') {
      const idx = restored.findIndex((c) => c.id === last.id);
      if (idx >= 0) restored[idx] = { ...restored[idx], role: 'cta' };
    }
  }

  const out: PlannedClip[] = [];
  for (const a of restored) {
    out.push(a);
    for (const b of broll) {
      if (b.parentClipId === a.id || b.sourceId === a.sourceId) {
        if (!out.includes(b)) out.push(b);
      }
    }
  }
  for (const b of broll) {
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

export function directedSequenceIssues(plan: ValidatedEditPlan, brief: DirectorCreativeBrief): CriticIssue[] {
  if (brief.editPolicy !== 'directed') return [];
  const beats = (brief.intendedBeats || []).filter((b) => b.required);
  if (beats.length < 2) return [];

  const actual = plan.sequence.filter((c) => !c.isBroll).map((c) => c.sourceId);
  const expected = beats.map((b) => b.sourceId);
  const uniqueActual: string[] = [];
  for (const id of actual) {
    if (!uniqueActual.includes(id)) uniqueActual.push(id);
  }

  const missing = expected.filter((id) => !uniqueActual.includes(id));
  const expectedPresent = expected.filter((id) => uniqueActual.includes(id));
  const orderBroken = uniqueActual.join('|') !== expectedPresent.join('|');

  const expectedLabels = beats.map((b) => b.label).join(' → ');
  const actualLabels = uniqueActual
    .map((id) => beats.find((b) => b.sourceId === id)?.label || id)
    .join(' → ');

  const issues: CriticIssue[] = [];
  if (missing.length) {
    issues.push({
      severity: 'high',
      timestamp: '00:00.0',
      start: 0,
      end: 1,
      category: 'story',
      problem: `Final video is missing required directed beat(s): ${missing
        .map((id) => beats.find((b) => b.sourceId === id)?.label || id)
        .join(', ')}.`,
      seenHeard: `Expected: ${expectedLabels}. Actual: ${actualLabels || '(empty)'}.`,
      reason: 'TakeOne directed footage must keep every required narrative beat.',
      recommendation: 'Restore the missing beat in original scene order. Do not drop required scenes.',
      action: 'none',
    });
  }
  if (orderBroken && uniqueActual.length) {
    issues.push({
      severity: 'high',
      timestamp: '00:00.0',
      start: 0,
      end: 1,
      category: 'story',
      problem: 'These clips no longer make sense in the intended sequence.',
      seenHeard: `Expected: ${expectedLabels}. Actual: ${actualLabels}.`,
      reason: 'Directed footage must follow the creator’s narrative beats, not a recut story.',
      recommendation: 'Restore original scene/beat order. Do not globally reorder.',
      action: 'none',
    });
  }
  return issues;
}

export function flashFrameIssues(plan: ValidatedEditPlan): CriticIssue[] {
  const issues: CriticIssue[] = [];
  let t = 0;
  for (const c of plan.sequence) {
    const dur = c.end - c.start;
    if (!c.isBroll && dur < FLASH_FRAME_SECONDS) {
      issues.push({
        severity: 'high',
        timestamp: formatTs(t),
        start: t,
        end: t + dur,
        category: 'pacing',
        problem: `${dur.toFixed(1)}s flash frame`,
        seenHeard: `Clip ${c.id} is only ${dur.toFixed(2)}s of source ${c.sourceId}`,
        reason: 'A flash frame is not a keep. Restore surrounding usable footage or drop the fragment.',
        recommendation: `Remove the ${Math.round(dur * 1000)}ms flash; keep surrounding usable footage on ${c.id}`,
        action: 'trim_clip',
        parameters: {
          clipId: c.id,
          removeStart: c.start,
          removeEnd: c.end,
        },
      });
    }
    t += Math.max(0, dur);
  }
  return issues;
}

function formatTs(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

/**
 * trim_clip semantics:
 * - removeStart/removeEnd (or a tiny nested newStart/newEnd) = EXCISE that window, keep the rest
 * - otherwise newStart/newEnd = KEEP RANGE (heads/tails), never shorter than MIN_USABLE
 * - a clip that is already a flash frame is dropped, unless it is the only coverage of that source
 *   in which case we restore intel usableRange
 */
export function applyTrimClipMutation(
  sequence: PlannedClip[],
  idx: number,
  issue: CriticIssue,
  srcDur: number,
  intel: FootageIntelligence[]
): { sequence: PlannedClip[]; change: string } {
  const clip = sequence[idx];
  if (!clip) return { sequence, change: '' };

  const textCorpus = `${issue.problem || ''} ${issue.reason || ''} ${issue.seenHeard || ''} ${issue.recommendation || ''}`.toLowerCase();
  const isTruncation = /truncat|cut(?:s|ting)? (?:off|into)|mid[- ]?(?:sentence|thought|word)|incomplete thought|incomplete word|abrupt(?:ly)?/i.test(textCorpus);
  if (isTruncation) {
    console.warn(`[EDIT POLICY] Refusing trim_clip on truncation issue — preserving ${clip.id}`);
    return { sequence, change: `trim_clip ${clip.id} skipped (refused shrink on truncation issue)` };
  }

  const origDur = clip.end - clip.start;
  const params = issue.parameters || {};
  const f = intel.find((i) => i.sourceId === clip.sourceId);
  const restore = (): { start: number; end: number } =>
    f ? usableRangeForSource(f) : { start: clip.start, end: Math.min(srcDur, clip.start + Math.max(origDur, 2)) };

  const otherCoverage = sequence.some(
    (c, i) => i !== idx && !c.isBroll && c.sourceId === clip.sourceId && c.end - c.start >= MIN_USABLE_CLIP_SECONDS
  );

  let exciseStart: number | null = null;
  let exciseEnd: number | null = null;
  if (
    typeof params.removeStart === 'number' &&
    typeof params.removeEnd === 'number' &&
    params.removeEnd > params.removeStart
  ) {
    exciseStart = params.removeStart;
    exciseEnd = params.removeEnd;
  } else {
    const ns = params.newStart ?? clip.start;
    const ne = params.newEnd ?? clip.end;
    const proposedDur = ne - ns;
    const nested =
      ns >= clip.start - 0.08 && ne <= clip.end + 0.08 && proposedDur > 0;
    const tiny = proposedDur < Math.min(0.85, origDur * 0.45);
    if (nested && tiny && origDur >= MIN_USABLE_CLIP_SECONDS) {
      exciseStart = ns;
      exciseEnd = ne;
    }
  }

  if (exciseStart != null && exciseEnd != null) {
    const leftDur = exciseStart - clip.start;
    const rightDur = clip.end - exciseEnd;
    const pieces: PlannedClip[] = [];
    if (leftDur >= MIN_USABLE_CLIP_SECONDS) {
      pieces.push({ ...clip, end: exciseStart });
    }
    if (rightDur >= MIN_USABLE_CLIP_SECONDS) {
      pieces.push({
        ...clip,
        id: pieces.length ? `${clip.id}b` : clip.id,
        start: exciseEnd,
      });
    }
    if (pieces.length) {
      const next = [...sequence];
      next.splice(idx, 1, ...pieces);
      const kept = pieces.map((p) => `${p.start.toFixed(1)}–${p.end.toFixed(1)}`).join(' + ');
      return {
        sequence: next,
        change: `trim_clip ${clip.id} excised ${exciseStart.toFixed(1)}–${exciseEnd.toFixed(1)} keep ${kept}`,
      };
    }
    if (origDur < MIN_USABLE_CLIP_SECONDS && !otherCoverage) {
      const u = restore();
      const next = [...sequence];
      next[idx] = { ...clip, start: u.start, end: u.end };
      return {
        sequence: next,
        change: `trim_clip ${clip.id} restored ${u.start.toFixed(1)}–${u.end.toFixed(1)} (refused flash keep)`,
      };
    }
    if (origDur < MIN_USABLE_CLIP_SECONDS && otherCoverage) {
      const next = [...sequence];
      next.splice(idx, 1);
      return { sequence: next, change: `trim_clip ${clip.id} dropped flash frame` };
    }
    return { sequence, change: `trim_clip ${clip.id} skipped (would create flash frame)` };
  }

  let newStart = params.newStart ?? clip.start;
  let newEnd = params.newEnd ?? clip.end;
  newStart = Math.max(0, Math.min(newStart, srcDur - MIN_USABLE_CLIP_SECONDS));
  newEnd = Math.min(srcDur, Math.max(newStart + MIN_USABLE_CLIP_SECONDS, newEnd));
  if (newEnd - newStart < MIN_USABLE_CLIP_SECONDS) {
    return { sequence, change: `trim_clip ${clip.id} skipped (keep shorter than ${MIN_USABLE_CLIP_SECONDS}s)` };
  }
  if (
    Math.abs(newStart - clip.start) < 0.04 &&
    Math.abs(newEnd - clip.end) < 0.04
  ) {
    return { sequence, change: `trim_clip ${clip.id} skipped (no-op)` };
  }
  const next = [...sequence];
  next[idx] = { ...clip, start: newStart, end: newEnd };
  return {
    sequence: next,
    change: `trim_clip ${clip.id} ${clip.start.toFixed(1)}–${clip.end.toFixed(1)} → ${newStart.toFixed(1)}–${newEnd.toFixed(1)}`,
  };
}

export function policyPromptBlock(policy: EditPolicy, beats: IntendedBeat[]): string {
  if (policy === 'creative_recut') {
    return `EDIT POLICY: creative_recut (imported / raw footage).
You MAY reorder, drop weak sections, combine takes, create a different hook, and restructure the story.
Find the best story from all available footage.`;
  }
  const list =
    beats.length > 0
      ? beats.map((b, i) => `${i + 1}. ${b.label} [${b.sourceId}] ${b.required ? 'REQUIRED' : 'optional'} role=${b.role || '?'}`).join('\n')
      : '(use footage order as shot)';
  return `EDIT POLICY: directed (TakeOne-recorded production).
You are a professional editor polishing an ALREADY-DIRECTED performance. You are NOT a creative editor rewriting the story.

LOCKED:
- scene order
- narrative beat order
- complete spoken thoughts (trim mumbles/noise/dead air only)

ALLOWED: best take, trim dead air, remove mistakes, trim heads/tails, punch-in, B-roll, captions, music, overlays, smooth audio, tasteful transitions.

FORBIDDEN: globally reorder scenes, drop a REQUIRED beat because Stage B scored it weak, invent a new hook from a later scene, assemble a "better" story.

Intended beats (creator order):
${list}`;
}
