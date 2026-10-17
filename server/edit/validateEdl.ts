/**
 * Validate structured edit plans. Never accepts shell/FFmpeg from the model.
 */
import {
  TRANSITION_PRIMITIVES,
  type EditingStyle,
  type MusicCue,
  type PlannedClip,
  type TransitionPrimitive,
  type ValidatedEditPlan,
  type ClipRole,
} from '../../src/types/editorial';
import { assertNoSourceOverlap } from './edlHoles';

const ROLES: ClipRole[] = [
  'hook',
  'context',
  'explanation',
  'proof',
  'cta',
  'broll',
  'outro',
  'bridge',
];

const STYLES: EditingStyle[] = [
  'cinematic',
  'youtube',
  'high_energy_social',
  'documentary',
  'corporate',
  'travel',
  'interview_podcast',
];

const ASPECTS = ['9:16', '16:9'] as const;

export interface SourceDurationMap {
  [sourceId: string]: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  plan?: ValidatedEditPlan;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function validateEditPlan(
  raw: any,
  sourceDurations: SourceDurationMap,
  meta: {
    projectId: string;
    iteration?: number;
    defaultAspect?: '9:16' | '16:9';
    defaultStyle?: EditingStyle;
    targetDuration?: number;
  }
): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan must be a JSON object'] };
  }

  // Reject any shell / ffmpeg leakage
  const blob = JSON.stringify(raw);
  if (/ffmpeg|ffprobe|\/bin\/|shell|exec\(|spawn\(/i.test(blob)) {
    return { ok: false, errors: ['Plan must not contain shell or FFmpeg commands'] };
  }

  const style: EditingStyle = STYLES.includes(raw.style)
    ? raw.style
    : meta.defaultStyle || 'high_energy_social';

  const aspectRatio = ASPECTS.includes(raw.aspectRatio)
    ? raw.aspectRatio
    : meta.defaultAspect || '9:16';

  const targetDuration = clamp(
    num(raw.targetDuration, meta.targetDuration || 60),
    5,
    600
  );

  const sequenceRaw = Array.isArray(raw.sequence) ? raw.sequence : [];
  if (!sequenceRaw.length) {
    errors.push('sequence must contain at least one clip');
  }

  const sequence: PlannedClip[] = [];
  for (let i = 0; i < sequenceRaw.length; i++) {
    const c = sequenceRaw[i];
    const sourceId = String(c.sourceId || c.source_id || '');
    if (!sourceId) {
      errors.push(`sequence[${i}]: missing sourceId`);
      continue;
    }
    if (!(sourceId in sourceDurations)) {
      errors.push(`sequence[${i}]: unknown sourceId "${sourceId}"`);
      continue;
    }

    const srcDur = sourceDurations[sourceId];
    let start = num(c.start, 0);
    let end = num(c.end, start + 1);
    start = clamp(start, 0, Math.max(0, srcDur - 0.2));
    end = clamp(end, start + 0.25, srcDur);

    if (end <= start) {
      errors.push(`sequence[${i}]: end must be > start for ${sourceId}`);
      continue;
    }

    const transitionIn = (TRANSITION_PRIMITIVES.includes(c.transitionIn)
      ? c.transitionIn
      : 'hard_cut') as TransitionPrimitive;
    const transitionOut = (TRANSITION_PRIMITIVES.includes(c.transitionOut)
      ? c.transitionOut
      : TRANSITION_PRIMITIVES.includes(c.transition)
        ? c.transition
        : 'hard_cut') as TransitionPrimitive;

    const role = (ROLES.includes(c.role) ? c.role : 'context') as ClipRole;
    const zoom = c.zoom != null ? clamp(num(c.zoom, 1), 1, 1.15) : 1;
    const transitionDuration = clamp(num(c.transitionDuration, 0.35), 0.2, 0.8);

    sequence.push({
      id: String(c.id || `clip-${i}`),
      sourceId,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      role,
      transitionIn,
      transitionOut,
      transitionDuration,
      crop: c.crop === 'face_priority' ? 'face_priority' : 'none',
      zoom,
      audioGainDb: c.audioGainDb != null ? clamp(num(c.audioGainDb), -12, 6) : undefined,
      musicDuck: ['speech', 'lift', 'hold'].includes(c.musicDuck) ? c.musicDuck : 'speech',
      isBroll: Boolean(c.isBroll || role === 'broll'),
      parentClipId: c.parentClipId ? String(c.parentClipId) : undefined,
      emphasisPhrases: Array.isArray(c.emphasisPhrases)
        ? c.emphasisPhrases.map(String).slice(0, 8)
        : undefined,
      notes: c.notes ? String(c.notes).slice(0, 200) : undefined,
    });
  }

  if (!sequence.length) {
    return { ok: false, errors: errors.length ? errors : ['No valid clips in sequence'] };
  }

  // Hard invariant: same-source A-roll ranges must not overlap (duplicate footage)
  for (const msg of assertNoSourceOverlap(sequence)) {
    errors.push(`source overlap: ${msg}`);
  }

  // Ensure first clip is a hook if any hook exists later
  const hookIdx = sequence.findIndex((c) => c.role === 'hook');
  if (hookIdx > 0) {
    // Soft warning only — director should have ordered, but we don't auto-reorder here
    errors.push(`Note: hook is at index ${hookIdx}, not opening (kept as planned)`);
  }

  const musicCuesRaw = Array.isArray(raw.musicCues) ? raw.musicCues : [];
  const musicCues: MusicCue[] = musicCuesRaw
    .map((m: any) => ({
      start: Math.max(0, num(m.start)),
      end: Math.max(num(m.start) + 0.1, num(m.end)),
      level: (['ducked', 'lift', 'mute', 'hold'].includes(m.level)
        ? m.level
        : 'ducked') as MusicCue['level'],
    }))
    .filter((m: MusicCue) => m.end > m.start);

  const softWarnings = errors.filter((e) => e.startsWith('Note:'));
  const hardErrors = errors.filter((e) => !e.startsWith('Note:'));

  if (hardErrors.length) {
    return { ok: false, errors: hardErrors };
  }

  const plan: ValidatedEditPlan = {
    version: 1,
    projectId: meta.projectId,
    targetDuration,
    aspectRatio,
    style,
    sequence,
    musicCues,
    audioStrategy: {
      musicEnabled: Boolean(raw.audioStrategy?.musicEnabled ?? musicCues.length > 0),
      duckUnderSpeech: raw.audioStrategy?.duckUnderSpeech !== false,
      fadeInOut: raw.audioStrategy?.fadeInOut !== false,
      notes: String(raw.audioStrategy?.notes || '').slice(0, 400),
    },
    captionStrategy: {
      enabled: Boolean(raw.captionStrategy?.enabled ?? true),
      emphasizeKeywords: Array.isArray(raw.captionStrategy?.emphasizeKeywords)
        ? raw.captionStrategy.emphasizeKeywords.map(String).slice(0, 12)
        : [],
    },
    warnings: softWarnings,
    createdAt: Date.now(),
    iteration: meta.iteration ?? 0,
    editPolicy: raw.editPolicy === 'creative_recut' ? 'creative_recut' : raw.editPolicy === 'directed' ? 'directed' : undefined,
  };

  return { ok: true, errors: softWarnings, plan };
}

/** Build a repair prompt fragment from validation errors */
export function repairPromptForErrors(errors: string[]): string {
  return `Your previous edit plan was INVALID. Fix these errors and return corrected JSON only:\n- ${errors.join('\n- ')}\nDo NOT include FFmpeg or shell commands. Use only known sourceIds and valid timestamps.`;
}
