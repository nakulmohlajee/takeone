/**
 * Deterministic base edit plan when no AI Director plan exists.
 * One keep per user take (not overlay); overlays stay via collectOverlayEvents.
 */
import type { Project, Scene } from '../types/director';
import type { PlannedClip, TransitionPrimitive, ValidatedEditPlan } from '../types/editorial';
import { mapLegacyPresetToStyle } from '../types/editorial';

function sceneTransitionToPrimitive(scene: Scene): TransitionPrimitive {
  const t = String(scene.transition || '').toLowerCase();
  if (t === 'zoom-snap' || t === 'zoom') return 'zoom';
  if (t === 'whip-pan' || t === 'whip') return 'whip';
  if (t === 'crossfade' || t === 'dissolve' || t === 'cross_dissolve') return 'cross_dissolve';
  if (t === 'fade-to-black' || t === 'dip-black' || t === 'dip_black') return 'dip_black';
  return 'hard_cut';
}
import {
  firstPrimarySpeechStart,
  lastPrimarySpeechEnd,
  tailOutAfterSpeech,
} from './speechBounds';

/** Local copy — avoid circular import with edl.ts */
function migrateKeepRanges(scene: Scene): Array<{ start: number; end: number }> {
  if (scene.keepRanges?.length) return scene.keepRanges;
  const inP = typeof scene.inPoint === 'number' ? scene.inPoint : 0;
  const outP =
    typeof scene.outPoint === 'number' && scene.outPoint > inP
      ? scene.outPoint
      : scene.recordedDuration || scene.durationSeconds || 0;
  if (outP > inP) return [{ start: inP, end: outP }];
  return [];
}

function hasUserMedia(scene: Scene): boolean {
  return Boolean(
    scene.gcsObjectPath ||
      scene.userRecordedVideoUrl ||
      (scene.filmedBy === 'user' && scene.recordedDuration)
  );
}

function resolveKeepEnd(scene: Scene): number {
  const env = scene.footageIntel?.audioEnvelope;
  if (env && env.speechEnd > 0) {
    return tailOutAfterSpeech(env, 0.35);
  }
  const speechEnd = lastPrimarySpeechEnd(scene.footageIntel);
  if (speechEnd != null) return speechEnd;
  return (
    scene.recordedDuration ||
    scene.durationSeconds ||
    scene.footageIntel?.sourceDuration ||
    5
  );
}

function resolveKeepStart(scene: Scene): number {
  const env = scene.footageIntel?.audioEnvelope;
  if (env && env.speechStart >= 0) return env.speechStart;
  const speechStart = firstPrimarySpeechStart(scene.footageIntel);
  if (speechStart != null) return speechStart;
  return 0;
}

export type BuildBasePlanOpts = {
  /** Master Cut: ignore unlocked AI/scene trims; use envelope or locked keepRanges only */
  forMaster?: boolean;
};

/**
 * Build a directed base plan: one PlannedClip per keep range / user take.
 * Does not include overlay scenes in the sequence.
 */
export function buildBasePlan(
  project: Project,
  opts?: BuildBasePlanOpts
): ValidatedEditPlan {
  const forMaster = Boolean(opts?.forMaster);
  const style = mapLegacyPresetToStyle(project.channelSettings?.aiEditingPreset);
  const aspectRatio = (project.aspectRatio === '16:9' ? '16:9' : '9:16') as '9:16' | '16:9';
  const sequence: PlannedClip[] = [];
  let clipIdx = 0;

  for (const scene of project.scenes || []) {
    if (scene.mediaRole === 'overlay') continue;
    if (scene.filmedBy === 'ai' && scene.insertKind !== 'title-card') {
      // Only include AI cutaways explicitly marked for export
      if (!(scene.mediaRole === 'cutaway' && scene.includeInExport === true)) continue;
    }
    if (scene.filmedBy === 'user' && !hasUserMedia(scene) && scene.insertKind !== 'title-card') {
      continue;
    }

    // Master Cut: locked multi-range keeps only when the user saved them
    if (forMaster && scene.userTrimLocked && scene.keepRanges && scene.keepRanges.length > 1) {
      for (const r of scene.keepRanges) {
        if (r.end - r.start < 0.25) continue;
        sequence.push({
          id: `base-${clipIdx++}`,
          sourceId: scene.id,
          start: r.start,
          end: r.end,
          role: scene.editRole || (clipIdx === 1 ? 'hook' : 'context'),
          transitionIn: 'hard_cut',
          transitionOut: sceneTransitionToPrimitive(scene),
          transitionDuration: scene.transitionDuration ?? 0.25,
          zoom: scene.editZoom ?? 1,
          musicDuck: 'speech',
        });
      }
      continue;
    }

    if (forMaster && scene.userTrimLocked) {
      const ranges = migrateKeepRanges(scene);
      if (ranges.length === 1) {
        sequence.push({
          id: `base-${clipIdx++}`,
          sourceId: scene.id,
          start: ranges[0].start,
          end: ranges[0].end,
          role: scene.editRole || (sequence.length === 0 ? 'hook' : 'context'),
          transitionIn: 'hard_cut',
          transitionOut: sceneTransitionToPrimitive(scene),
          transitionDuration: scene.transitionDuration ?? 0.25,
          zoom: scene.editZoom ?? 1,
          musicDuck: 'speech',
        });
        continue;
      }
    }

    // Unlocked / Master without trim: speech envelope head/tail only (no AI in/out)
    if (forMaster) {
      let start = resolveKeepStart(scene);
      let end = resolveKeepEnd(scene);
      if (end <= start + 0.25) {
        end = start + Math.max(0.5, scene.recordedDuration || scene.durationSeconds || 3);
      }
      sequence.push({
        id: `base-${clipIdx++}`,
        sourceId: scene.id,
        start: Math.max(0, start),
        end,
        role: scene.editRole || (sequence.length === 0 ? 'hook' : 'context'),
        transitionIn: 'hard_cut',
        transitionOut: sceneTransitionToPrimitive(scene),
        transitionDuration: scene.transitionDuration ?? 0.25,
        zoom: scene.editZoom ?? 1,
        musicDuck: 'speech',
      });
      continue;
    }

    // Non-master (prompt / insights scaffolding): allow unlocked keepRanges + envelope
    const ranges = migrateKeepRanges(scene);
    if (ranges.length > 1) {
      for (const r of ranges) {
        if (r.end - r.start < 0.25) continue;
        sequence.push({
          id: `base-${clipIdx++}`,
          sourceId: scene.id,
          start: r.start,
          end: r.end,
          role: scene.editRole || (clipIdx === 1 ? 'hook' : 'context'),
          transitionIn: 'hard_cut',
          transitionOut: sceneTransitionToPrimitive(scene),
          transitionDuration: scene.transitionDuration ?? 0.25,
          zoom: scene.editZoom ?? 1,
          musicDuck: 'speech',
        });
      }
      continue;
    }

    let start = resolveKeepStart(scene);
    let end = resolveKeepEnd(scene);
    if (ranges.length === 1) {
      start = ranges[0].start;
      end = ranges[0].end;
      const env = scene.footageIntel?.audioEnvelope;
      if (env && Math.abs(ranges[0].start) < 0.2 && env.speechStart > 0.15) {
        start = env.speechStart;
      }
      if (env && env.speechEnd > 0) {
        const speechTail = tailOutAfterSpeech(env, 0.35);
        if (ranges[0].end >= env.speechEnd - 0.5) {
          end = Math.min(ranges[0].end, Math.max(speechTail, start + 0.3));
        }
      }
    }

    if (end <= start + 0.25) {
      end = start + Math.max(0.5, scene.recordedDuration || scene.durationSeconds || 3);
    }

    sequence.push({
      id: `base-${clipIdx++}`,
      sourceId: scene.id,
      start: Math.max(0, start),
      end,
      role: scene.editRole || (sequence.length === 0 ? 'hook' : 'context'),
      transitionIn: 'hard_cut',
      transitionOut: sceneTransitionToPrimitive(scene),
      transitionDuration: scene.transitionDuration ?? 0.25,
      zoom: scene.editZoom ?? 1,
      musicDuck: 'speech',
    });
  }

  const targetDuration = Math.max(
    5,
    sequence.reduce((a, c) => a + (c.end - c.start), 0)
  );

  return {
    version: 1,
    projectId: project.id,
    targetDuration,
    aspectRatio,
    style,
    editPolicy: 'directed',
    sequence,
    musicCues: [],
    audioStrategy: {
      musicEnabled: Boolean(project.channelSettings?.musicTrackUrl),
      duckUnderSpeech: true,
      fadeInOut: true,
      notes: forMaster
        ? 'Master cut — envelope head/tail (or locked user keepRanges)'
        : 'Base cut — speech-bounded keep per take',
    },
    captionStrategy: {
      enabled: Boolean(project.channelSettings?.captionsEnabled),
      emphasizeKeywords: [],
    },
    warnings: sequence.length ? [] : ['Base plan: no usable user takes'],
    createdAt: Date.now(),
    iteration: 0,
  };
}
