/**
 * Shared EDL preflight (client + server). No Node-only APIs.
 * Validates clip ranges, pause snaps, overlays; optionally repairs.
 */
import type { Project, Scene } from '../types/director';
import type { ValidatedEditPlan } from '../types/editorial';
import type { EditDecisionList, EdlClip, EdlOverlayEvent } from './edl';
import { migrateKeepRanges } from './edl';
import {
  isNearPauseOrSpeechBound,
  lastPrimarySpeechEnd,
  snapCutToPause,
} from './speechBounds';

export type PreflightResult = {
  ok: boolean;
  repaired: boolean;
  errors: string[];
  warnings: string[];
  edl: EditDecisionList;
  plan?: ValidatedEditPlan;
};

const OVERLAY_LAYOUTS = new Set(['full', 'pip_br', 'pip_bl', 'greenscreen']);

function fmt(a: number, b: number): string {
  return `${a.toFixed(2)}-${b.toFixed(2)}`;
}

function sceneById(project: Project): Map<string, Scene> {
  return new Map((project.scenes || []).map((s) => [s.id, s]));
}

function userVideoCount(project: Project): number {
  return (project.scenes || []).filter(
    (s) =>
      s.filmedBy === 'user' &&
      s.mediaRole !== 'overlay' &&
      (s.userRecordedVideoUrl || s.gcsObjectPath || s.recordedDuration)
  ).length;
}

function isSingleTakeContext(project: Project): boolean {
  if (project.captureStrategy === 'single_take') return true;
  if (project.creativeBrief?.captureStrategy === 'single_take') return true;
  return userVideoCount(project) === 1;
}

function mapSourceToTimeline(
  clips: EdlClip[],
  parentSourceId: string,
  sourceStart: number,
  sourceEnd: number
): { timelineStart: number; timelineEnd: number } | null {
  let t = 0;
  for (const c of clips) {
    if (c.isBroll) {
      t += c.durationSeconds;
      continue;
    }
    const inP = typeof c.inPoint === 'number' ? c.inPoint : 0;
    const outP =
      typeof c.outPoint === 'number' ? c.outPoint : inP + c.durationSeconds;
    const sid = c.sourceId || c.sceneId;
    if (sid === parentSourceId && sourceEnd > inP + 0.05 && sourceStart < outP - 0.05) {
      const clipLocalStart = Math.max(0, sourceStart - inP);
      const clipLocalEnd = Math.min(outP - inP, sourceEnd - inP);
      return {
        timelineStart: t + clipLocalStart,
        timelineEnd: t + clipLocalEnd,
      };
    }
    t += c.durationSeconds;
  }
  return null;
}

function overlayMapsOntoKeptClip(
  clips: EdlClip[],
  parentSourceId: string,
  sourceStart: number,
  sourceEnd: number
): boolean {
  for (const c of clips) {
    if (c.isBroll) continue;
    const sid = c.sourceId || c.sceneId;
    if (sid !== parentSourceId) continue;
    const inP = typeof c.inPoint === 'number' ? c.inPoint : 0;
    const outP =
      typeof c.outPoint === 'number' ? c.outPoint : inP + c.durationSeconds;
    // Overlap with kept source window
    if (sourceEnd > inP + 0.05 && sourceStart < outP - 0.05) return true;
  }
  return false;
}

function repairClipPauseSnap(
  clip: EdlClip,
  scene: Scene | undefined,
  autoRepair: boolean,
  warnings: string[],
  repaired: { value: boolean }
): EdlClip {
  const env = scene?.footageIntel?.audioEnvelope;
  if (!env?.pauses?.length) return clip;

  let inP = typeof clip.inPoint === 'number' ? clip.inPoint : 0;
  let outP =
    typeof clip.outPoint === 'number' ? clip.outPoint : inP + clip.durationSeconds;

  const checkEdge = (edge: number, side: 'in' | 'out', label: string) => {
    if (isNearPauseOrSpeechBound(edge, env, 0.6)) return edge;
    warnings.push(
      `Mid-word risk: ${clip.title || clip.sceneId} ${label} ${edge.toFixed(2)} not near pause`
    );
    if (!autoRepair) return edge;
    const snapped = snapCutToPause(edge, env, side, 0.6);
    if (Math.abs(snapped - edge) > 0.02) {
      repaired.value = true;
      warnings.push(
        `Repaired ${label}: ${edge.toFixed(2)} → ${snapped.toFixed(2)} (pause snap)`
      );
      return snapped;
    }
    return edge;
  };

  inP = checkEdge(inP, 'in', 'in');
  outP = checkEdge(outP, 'out', 'out');

  // Also validate keepRanges boundaries on the scene
  const ranges = scene ? migrateKeepRanges(scene) : [];
  for (const r of ranges) {
    if (!isNearPauseOrSpeechBound(r.start, env, 0.6)) {
      warnings.push(
        `keepRanges start ${r.start.toFixed(2)} on ${scene!.id} not near pause`
      );
    }
    if (!isNearPauseOrSpeechBound(r.end, env, 0.6)) {
      warnings.push(
        `keepRanges end ${r.end.toFixed(2)} on ${scene!.id} not near pause`
      );
    }
  }

  if (outP <= inP + 0.2) return clip;
  return {
    ...clip,
    inPoint: inP,
    outPoint: outP,
    durationSeconds: outP - inP,
  };
}

function logOverlayAndVideoLines(
  project: Project,
  edl: EditDecisionList,
  scenes: Map<string, Scene>
): void {
  const overlays: EdlOverlayEvent[] = edl.overlayEvents || [];
  for (const ev of overlays) {
    const overlayScene = scenes.get(ev.sourceSceneId);
    const parent = scenes.get(ev.parentSourceId);
    const origStart =
      typeof overlayScene?.overlayStartSeconds === 'number'
        ? overlayScene.overlayStartSeconds
        : typeof overlayScene?.inPoint === 'number'
          ? overlayScene.inPoint
          : ev.sourceStart;
    const origDur =
      typeof overlayScene?.overlayDurationSeconds === 'number'
        ? overlayScene.overlayDurationSeconds
        : typeof overlayScene?.outPoint === 'number' &&
            typeof overlayScene?.inPoint === 'number'
          ? overlayScene.outPoint - overlayScene.inPoint
          : ev.sourceEnd - ev.sourceStart;
    const origEnd = origStart + Math.max(0.4, origDur);

    // "after-AI" = current scene timing (may have been director-adjusted)
    const afterStart = ev.sourceStart;
    const afterEnd = ev.sourceEnd;

    const mapped = mapSourceToTimeline(
      edl.clips,
      ev.parentSourceId,
      afterStart,
      afterEnd
    );
    const tlStart = mapped?.timelineStart ?? ev.timelineStart ?? afterStart;
    const tlEnd = mapped?.timelineEnd ?? ev.timelineEnd ?? afterEnd;

    // Find covering video layer clip
    let videoLine = 'video layer (none)';
    let t = 0;
    let clipN = 0;
    for (const c of edl.clips) {
      if (c.isBroll) {
        t += c.durationSeconds;
        continue;
      }
      clipN += 1;
      const sid = c.sourceId || c.sceneId;
      const inP = typeof c.inPoint === 'number' ? c.inPoint : 0;
      const outP =
        typeof c.outPoint === 'number' ? c.outPoint : inP + c.durationSeconds;
      if (
        sid === ev.parentSourceId &&
        afterEnd > inP + 0.05 &&
        afterStart < outP - 0.05
      ) {
        const tlIn = t + Math.max(0, afterStart - inP);
        const tlOut = t + Math.min(outP - inP, afterEnd - inP);
        videoLine = `video layer clip${clipN} src ${fmt(inP, outP)} -> timeline ${fmt(tlIn, tlOut)}`;
        break;
      }
      t += c.durationSeconds;
    }

    void parent;
    console.log(
      `[PREFLIGHT] overlay original src ${fmt(origStart, origEnd)} | after-AI src ${fmt(afterStart, afterEnd)} | final timeline ${fmt(tlStart, tlEnd)} | ${videoLine}`
    );
  }

  // Log each primary video clip
  let t = 0;
  let n = 0;
  for (const c of edl.clips) {
    if (c.isBroll) {
      t += c.durationSeconds;
      continue;
    }
    n += 1;
    const inP = typeof c.inPoint === 'number' ? c.inPoint : 0;
    const outP =
      typeof c.outPoint === 'number' ? c.outPoint : inP + c.durationSeconds;
    console.log(
      `[PREFLIGHT] video layer clip${n} src ${fmt(inP, outP)} -> timeline ${fmt(t, t + (outP - inP))}`
    );
    t += c.durationSeconds;
  }
  void project;
}

/**
 * Run EDL preflight checks; optionally snap mid-word cuts and extend speech end.
 */
export function runEdlPreflight(opts: {
  project: Project;
  edl: EditDecisionList;
  plan?: ValidatedEditPlan | null;
  autoRepair?: boolean;
}): PreflightResult {
  const { project, plan } = opts;
  const autoRepair = opts.autoRepair !== false;
  const errors: string[] = [];
  const warnings: string[] = [...(opts.edl.warnings || [])];
  const scenes = sceneById(project);
  const repairedFlag = { value: false };

  let clips = (opts.edl.clips || []).map((c) => ({ ...c }));
  const overlayEvents = (opts.edl.overlayEvents || []).map((e) => ({ ...e }));

  // 1. Every video clip: 0 <= in < out; scene not overlay
  for (const clip of clips) {
    if (clip.mediaKind === 'title-card' || clip.isBroll) continue;
    const inP = typeof clip.inPoint === 'number' ? clip.inPoint : 0;
    const outP =
      typeof clip.outPoint === 'number'
        ? clip.outPoint
        : inP + Math.max(0, clip.durationSeconds || 0);
    if (!(inP >= 0 && outP > inP)) {
      errors.push(
        `Clip "${clip.title || clip.sceneId}": invalid range ${inP}–${outP}`
      );
    }
    const scene = scenes.get(clip.sourceId || clip.sceneId);
    if (scene?.mediaRole === 'overlay') {
      if (autoRepair) {
        warnings.push(`Overlay scene ${scene.id} removed from primary video layer`);
        repairedFlag.value = true;
      } else {
        errors.push(`Overlay scene ${scene.id} appears as primary video clip`);
      }
    }
  }

  // 6. No overlay scene id in video layer
  const overlayIds = new Set(
    (project.scenes || []).filter((s) => s.mediaRole === 'overlay').map((s) => s.id)
  );
  clips = clips.filter((c) => {
    const sid = c.sourceId || c.sceneId;
    if (overlayIds.has(sid) && !c.isBroll) {
      if (autoRepair) {
        repairedFlag.value = true;
        return false;
      }
      errors.push(`Overlay scene id ${sid} in video layer`);
      return true;
    }
    return true;
  });

  // 2. Single-take / one user video: last clip out >= speechEnd
  if (isSingleTakeContext(project)) {
    const primaryClips = clips.filter((c) => !c.isBroll && c.mediaKind === 'video');
    const last = primaryClips[primaryClips.length - 1];
    if (last) {
      const scene = scenes.get(last.sourceId || last.sceneId);
      const speechEnd = lastPrimarySpeechEnd(scene?.footageIntel);
      const outP =
        typeof last.outPoint === 'number'
          ? last.outPoint
          : (last.inPoint || 0) + last.durationSeconds;
      if (speechEnd != null && outP < speechEnd - 0.05) {
        const msg = `Last clip out ${outP.toFixed(2)} < speechEnd ${speechEnd.toFixed(2)}`;
        if (autoRepair) {
          warnings.push(`Repaired: ${msg}`);
          const idx = clips.indexOf(last);
          const inP = typeof last.inPoint === 'number' ? last.inPoint : 0;
          clips[idx] = {
            ...last,
            outPoint: speechEnd,
            durationSeconds: Math.max(0.3, speechEnd - inP),
          };
          repairedFlag.value = true;
        } else {
          errors.push(msg);
        }
      }
    }
  }

  // 3. Mid-word pause snap for clip in/out + keepRanges boundaries
  clips = clips.map((clip) => {
    if (clip.isBroll || clip.mediaKind === 'title-card') return clip;
    const scene = scenes.get(clip.sourceId || clip.sceneId);
    return repairClipPauseSnap(clip, scene, autoRepair, warnings, repairedFlag);
  });

  // 4. overlayEvents all have overlay-ish layouts; none as primary
  for (const ev of overlayEvents) {
    if (!OVERLAY_LAYOUTS.has(ev.layout || '')) {
      warnings.push(
        `Overlay ${ev.id} layout "${ev.layout}" not overlay-ish; defaulting pip_br`
      );
      if (autoRepair) {
        ev.layout = 'pip_br';
        repairedFlag.value = true;
      }
    }
    if (clips.some((c) => !c.isBroll && (c.sourceId || c.sceneId) === ev.sourceSceneId)) {
      errors.push(
        `Overlay event ${ev.id} source ${ev.sourceSceneId} also appears as primary clip`
      );
    }
  }

  // 5. Each overlay timeline window maps onto a kept clip's source window
  for (const ev of overlayEvents) {
    if (
      !overlayMapsOntoKeptClip(
        clips,
        ev.parentSourceId,
        ev.sourceStart,
        ev.sourceEnd
      )
    ) {
      warnings.push(
        `Overlay ${ev.id} src ${fmt(ev.sourceStart, ev.sourceEnd)} does not overlap kept clip on ${ev.parentSourceId}`
      );
    }
  }

  // Recompute total duration
  const scenesTotal = clips.reduce((a, c) => a + c.durationSeconds, 0);
  const edl: EditDecisionList = {
    ...opts.edl,
    clips,
    overlayEvents,
    warnings: [...new Set(warnings)],
    totalDurationSeconds: Math.max(
      0,
      (opts.edl.introDurationSeconds || 0) +
        scenesTotal +
        (opts.edl.outroSafeSeconds || 0)
    ),
  };

  logOverlayAndVideoLines(project, edl, scenes);

  const hardOk = errors.filter((e) => !e.includes('Repaired')).length === 0;
  // Soft: overlay-as-primary that we repaired shouldn't fail ok if clips remain
  const ok = clips.length > 0 && hardOk;

  return {
    ok,
    repaired: repairedFlag.value,
    errors,
    warnings: edl.warnings,
    edl,
    plan: plan || undefined,
  };
}
