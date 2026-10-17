/**
 * Orchestrates: Observe → Understand → Direct → Plan → Rough → Critic → Revise
 */
import fs from 'fs/promises';
import type {
  CriticIterationRecord,
  CriticReport,
  DirectorCreativeBrief,
  DirectorEditResult,
  EditInsight,
  FootageIntelligence,
  ProjectUnderstanding,
  QualityScores,
  StoryUnderstanding,
  ValidatedEditPlan,
} from '../../src/types/editorial';
import { analyzeAllTakes } from './analyze';
import { runDirector, resolveStyle } from './director';
import { runUnderstand } from './understand';
import { runPlanner, applyCriticActions, revisePlanWithCritic } from './planner';
import { hasSourceOverlap, repairSourceOverlaps } from './edlHoles';
import { runCritic } from './critic';
import { renderRoughCutLocal } from '../render';
import { buildEditDecisionListFromPlan } from '../../src/utils/edl';
import { runEdlPreflight } from './edlPreflight';
import { appendCost } from '../jobs/cost';
import { editsPath, loadJson, saveJson } from '../jobs/store';

type AiClient = {
  files?: any;
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

export type ProgressFn = (stage: string, message: string, percent: number) => void;

function timelineTranscriptFromPlan(
  plan: ValidatedEditPlan,
  intel: FootageIntelligence[]
): string {
  const byId = new Map(intel.map((i) => [i.sourceId, i]));
  const parts: string[] = [];
  let t = 0;
  for (const c of plan.sequence) {
    if (c.isBroll) {
      t += c.end - c.start;
      continue;
    }
    const f = byId.get(c.sourceId);
    const segs = (f?.segments || []).filter((s) => s.end > c.start && s.start < c.end);
    const text =
      segs.map((s) => s.transcript).filter(Boolean).join(' ') ||
      (f?.fullTranscript || '').slice(0, 200);
    parts.push(`[${t.toFixed(1)}s role=${c.role}] ${text}`);
    t += c.end - c.start;
  }
  return parts.join('\n');
}

function applyPlanOntoScenes(scenes: any[], plan: ValidatedEditPlan, intel: FootageIntelligence[]) {
  const intelById = new Map(intel.map((i) => [i.sourceId, i]));
  const seen = new Set<string>();

  return scenes.map((scene) => {
    const next = { ...scene };
    const fi = intelById.get(scene.id);
    if (fi) next.footageIntel = fi;

    // Overlay scenes keep their own timing; never wipe in/out for compositing
    if (scene.mediaRole === 'overlay') {
      return next;
    }

    const userLocked = Boolean(scene.userTrimLocked);
    const lockedIn = typeof scene.inPoint === 'number' ? scene.inPoint : 0;
    const lockedOut =
      typeof scene.outPoint === 'number' && scene.outPoint > lockedIn
        ? scene.outPoint
        : null;

    if (!userLocked) {
      delete next.inPoint;
      delete next.outPoint;
    }
    delete next.editRole;

    for (const clip of plan.sequence) {
      if (clip.isBroll) continue;
      if (clip.sourceId !== scene.id) continue;
      if (seen.has(scene.id)) continue;

      if (userLocked && lockedOut != null) {
        // Clamp Gemini suggestions inside the user keep; never replace user in/out
        const clampedStart = Math.max(lockedIn, Math.min(clip.start, lockedOut - 0.3));
        const clampedEnd = Math.min(lockedOut, Math.max(clip.end, clampedStart + 0.3));
        next.inPoint = lockedIn;
        next.outPoint = lockedOut;
        // Prefer full user keep when plan overlaps; store role/zoom for UI
        void clampedStart;
        void clampedEnd;
      } else {
        next.inPoint = clip.start;
        next.outPoint = clip.end;
      }
      next.editRole = clip.role;
      next.editZoom = clip.zoom;
      next.transition = 'cut';
      next.transitionDuration = 0;
      seen.add(scene.id);
      break;
    }

    // Locked takes with no plan hit still keep user in/out
    if (userLocked && lockedOut != null) {
      next.inPoint = lockedIn;
      next.outPoint = lockedOut;
      next.userTrimLocked = true;
    }
    return next;
  });
}

async function roughCutForPlan(
  project: any,
  plan: ValidatedEditPlan
): Promise<{ path: string; workDir: string } | null> {
  try {
    let edl = buildEditDecisionListFromPlan(project, plan, {
      musicEnabled: false,
      channelOverrides: {
        captionsEnabled: false,
        youtubeOutroEnabled: false,
        introMode: 'off',
      },
    });
    const pf = runEdlPreflight({
      project,
      edl,
      plan,
      autoRepair: true,
    });
    edl = pf.edl;
    if (pf.warnings.length) {
      console.log(`[PREFLIGHT] rough-cut: ${pf.warnings.slice(0, 4).join('; ')}`);
    }
    // Cap rough cut for critic time budget — but ALWAYS preserve the ending/CTA clip
    if (edl.totalDurationSeconds > 120 && edl.clips.length > 4) {
      const last = edl.clips[edl.clips.length - 1];
      const head = edl.clips.slice(0, Math.max(2, Math.floor(edl.clips.length * 0.7)));
      edl.clips = head.some((c) => c.sceneId === last.sceneId && c.inPoint === last.inPoint) ? head : [...head, last];
      edl.totalDurationSeconds = edl.clips.reduce((a, c) => a + c.durationSeconds, 0);
      edl.outroSafeSeconds = 0;
      edl.introDurationSeconds = 0;
    }
    return await renderRoughCutLocal(edl);
  } catch (err) {
    console.warn('Rough cut render failed (critic will use EDL-only):', (err as Error).message);
    return null;
  }
}

function defaultDirectorMode(project: any, explicit?: 'analyze' | 'recut'): 'analyze' | 'recut' {
  if (explicit === 'analyze' || explicit === 'recut') return explicit;
  const strategy =
    project?.captureStrategy || project?.creativeBrief?.captureStrategy || '';
  if (strategy === 'single_take') return 'analyze';
  return 'recut';
}

function shapeInsightsFromCriticAndDrops(
  critic: CriticReport | undefined,
  brief: DirectorCreativeBrief | undefined,
  plan: ValidatedEditPlan
): EditInsight[] {
  const insights: EditInsight[] = [];
  let n = 0;

  for (const issue of critic?.issues || []) {
    n += 1;
    const p = issue.parameters || {};
    let mutation: EditInsight['mutation'] | undefined;
    if (
      (issue.action === 'trim_clip' ||
        issue.action === 'extend_clip' ||
        issue.action === 'set_range' ||
        issue.action === 'complete_ending') &&
      (p.sourceStart != null || p.newStart != null) &&
      (p.sourceEnd != null || p.newEnd != null)
    ) {
      const clip = plan.sequence.find((c) => c.id === p.clipId) || plan.sequence[0];
      mutation = {
        op: 'set_range',
        clipId: p.clipId || clip?.id,
        sourceStart: p.sourceStart ?? p.newStart,
        sourceEnd: p.sourceEnd ?? p.newEnd,
      };
    } else if (
      p.removeStart != null &&
      p.removeEnd != null &&
      (p.clipId || plan.sequence[0])
    ) {
      const clip = plan.sequence.find((c) => c.id === p.clipId) || plan.sequence[0];
      mutation = {
        op: 'drop_range',
        sourceId: clip?.sourceId,
        sourceStart: p.removeStart,
        sourceEnd: p.removeEnd,
      };
    }

    insights.push({
      id: `critic-${n}`,
      title: `${issue.category}: ${issue.problem.slice(0, 60)}`,
      severity: issue.severity,
      problem: issue.problem,
      recommendation: issue.recommendation || issue.reason || 'Review this moment',
      mutation,
    });
  }

  for (const d of (brief?.keepDrop || []).filter((k) => k.action === 'drop')) {
    n += 1;
    insights.push({
      id: `drop-${n}`,
      title: `Suggested drop ${d.sourceId} ${d.start.toFixed(1)}–${d.end.toFixed(1)}`,
      severity: 'medium',
      problem: d.reason || 'Director marked this range as droppable',
      recommendation: `Drop ${d.start.toFixed(1)}–${d.end.toFixed(1)}s on ${d.sourceId}`,
      mutation: {
        op: 'drop_range',
        sourceId: d.sourceId,
        sourceStart: d.start,
        sourceEnd: d.end,
      },
    });
  }

  return insights.slice(0, 24);
}

/** Analyze mode: attach intel + retimed captions without changing in/out. */
function applyIntelOnlyOntoScenes(scenes: any[], intel: FootageIntelligence[]) {
  const intelById = new Map(intel.map((i) => [i.sourceId, i]));
  return scenes.map((scene) => {
    const fi = intelById.get(scene.id);
    if (!fi) return { ...scene };
    return {
      ...scene,
      footageIntel: fi,
      transcriptSegments: fi.retimedTranscriptSegments || scene.transcriptSegments,
    };
  });
}

/**
 * Full director-edit pipeline. Critic watches rendered rough cut when possible.
 * Flow: OBSERVE → UNDERSTAND → DIRECT → PLAN → ROUGH → CRITIC → REVISION
 */
async function loadCheckpoint<T>(jobId: string | undefined, name: string): Promise<T | null> {
  if (!jobId) return null;
  return loadJson<T>(editsPath(jobId, name));
}

async function saveCheckpoint(jobId: string | undefined, name: string, data: unknown): Promise<void> {
  if (!jobId) return;
  await saveJson(editsPath(jobId, name), data, 'edit');
}

export async function runDirectorEditPipeline(
  ai: AiClient,
  project: any,
  opts?: {
    preset?: string;
    style?: string;
    maxCriticIterations?: number;
    onProgress?: ProgressFn;
    jobId?: string;
    /** analyze = insights only (default for single_take); recut = apply plan */
    mode?: 'analyze' | 'recut';
  }
): Promise<DirectorEditResult> {
  const onProgress = opts?.onProgress || (() => {});
  const mode = defaultDirectorMode(project, opts?.mode);
  // Analyze: one critic pass on a temporary plan; Recut: full revise loop
  const maxIter =
    mode === 'analyze'
      ? 1
      : Math.min(3, Math.max(1, opts?.maxCriticIterations ?? 2));
  const style = resolveStyle(opts?.style || opts?.preset || project?.channelSettings?.aiEditingPreset);
  const aspectRatio = (project.aspectRatio === '16:9' ? '16:9' : '9:16') as '9:16' | '16:9';
  const targetDuration = Math.min(
    180,
    Math.max(15, project.estimatedTotalSeconds || (project.videoFormat === 'long-form' ? 90 : 45))
  );

  const roughDirs: string[] = [];

  try {
    onProgress('observe', mode === 'analyze' ? 'Reading take…' : 'Analyzing footage…', 5);
    let footageIntel = await loadCheckpoint<FootageIntelligence[]>(opts?.jobId, 'observe.json');
    if (footageIntel?.length) {
      console.log(`[checkpoint] resume observe (${footageIntel.length} takes)`);
    } else {
      const observeStarted = Date.now();
      footageIntel = await analyzeAllTakes(ai, project.scenes || [], (msg, pct) => {
        onProgress('observe', msg, 5 + Math.round(pct * 0.18));
      });
      if (footageIntel.length) await saveCheckpoint(opts?.jobId, 'observe.json', footageIntel);
      await appendCost({
        ts: Date.now(),
        jobId: opts?.jobId || 'anon',
        kind: 'director-edit',
        event: 'observe',
        observeWallMs: Date.now() - observeStarted,
        geminiCalls: footageIntel.filter((f) => f.nativeVideoAnalyzed).length,
      });
    }

    if (!footageIntel.length) {
      return {
        ok: false,
        stage: 'observe',
        iterations: 0,
        error: 'No recorded user takes found to analyze. Film scenes first.',
      };
    }

    const nativeCount = footageIntel.filter((f) => f.nativeVideoAnalyzed).length;
    const obsSummary = footageIntel.map((f) => ({
      sourceId: f.sourceId,
      observation: f.observation,
      nativeVideoAnalyzed: f.nativeVideoAnalyzed,
    }));
    console.log(
      `[OBSERVATION] ${footageIntel.length} takes, native=${nativeCount}; shots=${footageIntel.reduce((a, f) => a + (f.observation?.shots.length || 0), 0)} moments=${footageIntel.reduce((a, f) => a + (f.observation?.moments.length || 0), 0)}`
    );

    onProgress(
      'understand',
      mode === 'analyze'
        ? 'Story notes…'
        : `Understanding story across ${footageIntel.length} takes (${nativeCount} native)…`,
      28
    );

    let projectUnderstanding =
      (await loadCheckpoint<ProjectUnderstanding>(opts?.jobId, 'understand.json')) || null;
    if (projectUnderstanding) {
      console.log('[checkpoint] resume understand');
    } else {
      projectUnderstanding = await runUnderstand(ai, {
        project,
        footageIntel,
        style,
        targetDuration,
        aspectRatio,
      });
      await saveCheckpoint(opts?.jobId, 'understand.json', projectUnderstanding);
      await appendCost({
        ts: Date.now(),
        jobId: opts?.jobId || 'anon',
        kind: 'director-edit',
        event: 'understand',
        geminiCalls: 1,
      });
    }

    onProgress('direct', mode === 'analyze' ? 'Suggestions…' : 'Building edit…', 38);

    let directed = await loadCheckpoint<{ story: StoryUnderstanding; brief: DirectorCreativeBrief }>(
      opts?.jobId,
      'direct.json'
    );
    if (directed) {
      console.log('[checkpoint] resume direct');
    } else {
      directed = await runDirector(ai, {
        project,
        footageIntel,
        projectUnderstanding,
        style,
        preset: opts?.preset,
      });
      await saveCheckpoint(opts?.jobId, 'direct.json', directed);
      await appendCost({
        ts: Date.now(),
        jobId: opts?.jobId || 'anon',
        kind: 'director-edit',
        event: 'direct',
        geminiCalls: 1,
      });
    }
    const { story, brief } = directed;

    onProgress('plan', mode === 'analyze' ? 'Suggestions…' : 'Building edit…', 45);
    let plan =
      (await loadCheckpoint<ValidatedEditPlan>(opts?.jobId, 'plan.json')) ||
      (await runPlanner(ai, brief, footageIntel, project.id));
    await saveCheckpoint(opts?.jobId, 'plan.json', plan);
    console.log(`[EDL] ${plan.sequence.length} clips, style=${plan.style}`);

    let bestPlan = plan;
    let bestScores: QualityScores | undefined;
    let lastCritic: CriticReport | undefined;
    let iterations = 0;
    let watchedRough = false;
    const criticIterations: CriticIterationRecord[] = [];
    const ledgerLines: string[] = [];

    for (let i = 0; i < maxIter; i++) {
      iterations = i + 1;

      // Analyze: text-only critic (no rough cut). Recut: render rough for video critic.
      let rough: { path: string; workDir: string } | null = null;
      if (mode === 'analyze') {
        onProgress('critic', 'Suggestions…', 58 + i * 16);
        console.log(`[ROUGH CUT] pass=${i + 1} skipped (analyze text-only critic)`);
      } else {
        onProgress('rough', `ROUGH CUT: rendering for critic (pass ${i + 1})…`, 50 + i * 16);
        rough = await roughCutForPlan(
          { ...project, channelSettings: { ...project.channelSettings, aiEditingPreset: style } },
          plan
        );
        if (rough) roughDirs.push(rough.workDir);
        console.log(`[ROUGH CUT] pass=${i + 1} ok=${Boolean(rough)}`);
        onProgress(
          'critic',
          rough
            ? 'CRITIC: watching rendered rough cut…'
            : 'CRITIC: EDL-only (rough render unavailable)…',
          58 + i * 16
        );
      }

      const transcript = timelineTranscriptFromPlan(plan, footageIntel);
      const critic = await runCritic(ai, {
        plan,
        brief,
        footageIntel,
        timelineTranscript: transcript,
        roughCutPath: rough?.path || null,
      });
      if (rough) watchedRough = true;
      lastCritic = critic;

      const beforeStats = {
        issueCount: critic.issues.length,
        highSeverity: critic.issues.filter((x) => x.severity === 'high').length,
        overall: critic.scores.overall,
      };
      console.log(
        `[CRITIC] pass=${i + 1} overall=${beforeStats.overall} approve=${critic.approve} issues=${beforeStats.issueCount} high=${beforeStats.highSeverity}`
      );
      ledgerLines.push(
        `ITERATION ${i + 1} — EDL v${plan.iteration}, ${plan.sequence.length} clips, rough=${rough ? 'ok' : 'skip'}, Critic issues=${beforeStats.issueCount} high=${beforeStats.highSeverity}`
      );

      // Never prefer an overlapping EDL (duplicate footage) even if score is higher
      const planOverlaps = hasSourceOverlap(plan.sequence);
      if (
        !planOverlaps &&
        (!bestScores ||
          hasSourceOverlap(bestPlan.sequence) ||
          critic.scores.overall > bestScores.overall)
      ) {
        bestScores = critic.scores;
        bestPlan = plan;
      } else if (!bestScores && !planOverlaps) {
        bestScores = critic.scores;
        bestPlan = plan;
      }

      if (critic.approve || beforeStats.highSeverity === 0) {
        criticIterations.push({
          iteration: i + 1,
          edlClipCount: plan.sequence.length,
          roughCutOk: Boolean(rough),
          before: beforeStats,
          changesApplied: [],
          unresolved: critic.issues
            .filter((x) => x.severity === 'high')
            .map((x) => x.problem)
            .slice(0, 8),
        });
        break;
      }

      if (i + 1 >= maxIter) {
        criticIterations.push({
          iteration: i + 1,
          edlClipCount: plan.sequence.length,
          roughCutOk: Boolean(rough),
          before: beforeStats,
          changesApplied: [],
          unresolved: critic.issues
            .filter((x) => x.severity === 'high' || x.severity === 'medium')
            .map((x) => `${x.action || 'none'}: ${x.problem}`)
            .slice(0, 8),
        });
        break;
      }

      onProgress('revise', 'Refining…', 70 + i * 10);
      const { plan: revised, changes, rejected } = applyCriticActions(
        plan,
        critic.issues,
        footageIntel
      );
      plan = revised;
      await saveCheckpoint(opts?.jobId, 'plan.json', plan);
      if (rejected.length) {
        console.warn(`[REVISION] rejected: ${rejected.join('; ')}`);
        ledgerLines.push(`REVISION rejected: ${rejected.join('; ')}`);
      }
      if (changes.length) {
        console.log(`[REVISION] applied: ${changes.join('; ')}`);
        ledgerLines.push(`REVISION applied: ${changes.join('; ')}`);
      } else {
        // Fallback thin wrapper (same mutate path)
        plan = await revisePlanWithCritic(ai, plan, critic.issues, footageIntel, brief);
        ledgerLines.push('REVISION: no structured actions; heuristic parse attempted');
      }
      console.log(`[REVISION] pass=${i + 1} clips=${plan.sequence.length} iteration=${plan.iteration}`);

      onProgress('rough', 'ROUGH CUT: re-rendering revised plan…', 78 + i * 8);
      const rough2 = await roughCutForPlan(project, plan);
      if (rough2) roughDirs.push(rough2.workDir);

      const after = await runCritic(ai, {
        plan,
        brief,
        footageIntel,
        timelineTranscript: timelineTranscriptFromPlan(plan, footageIntel),
        roughCutPath: rough2?.path || null,
      });
      lastCritic = after;
      const afterStats = {
        issueCount: after.issues.length,
        highSeverity: after.issues.filter((x) => x.severity === 'high').length,
        overall: after.scores.overall,
      };
      console.log(
        `[CRITIC] after-revision overall=${afterStats.overall} issues=${afterStats.issueCount} high=${afterStats.highSeverity}`
      );

      const revisedClean = !hasSourceOverlap(plan.sequence);
      const stillDuplicate = after.issues.some((x) =>
        /overlap|duplicate|same (?:footage|clip|section)|repeated/i.test(
          `${x.problem} ${x.reason || ''} ${x.recommendation || ''}`
        )
      );
      const revisionPersisted = changes.length > 0 && revisedClean;
      const improved =
        (revisionPersisted && !stillDuplicate) ||
        afterStats.highSeverity < beforeStats.highSeverity ||
        afterStats.issueCount < beforeStats.issueCount;

      if (changes.length && !revisionPersisted) {
        ledgerLines.push(
          `REVISION FAILED to persist clean ranges (changes=${changes.length}, overlap=${!revisedClean})`
        );
      }

      ledgerLines.push(
        `ITERATION ${i + 2} — EDL v${plan.iteration}, ${plan.sequence.length} clips, rough=${rough2 ? 'ok' : 'skip'}, before {${beforeStats.issueCount},${beforeStats.highSeverity}} after {${afterStats.issueCount},${afterStats.highSeverity}}${improved ? '' : ' (no claim of improvement)'}`
      );

      criticIterations.push({
        iteration: i + 1,
        edlClipCount: plan.sequence.length,
        roughCutOk: Boolean(rough2 || rough),
        before: beforeStats,
        after: afterStats,
        changesApplied: revisionPersisted || changes.length ? changes : [],
        unresolved: after.issues
          .filter((x) => x.severity === 'high' || x.severity === 'medium')
          .map((x) => `${x.action || 'none'}: ${x.problem}`)
          .slice(0, 8),
      });

      // Prefer overlap-clean revised EDL over a higher-scoring overlapping predecessor
      const bestOverlaps = hasSourceOverlap(bestPlan.sequence);
      if (revisedClean && (bestOverlaps || !bestScores)) {
        bestScores = after.scores;
        bestPlan = plan;
      } else if (
        revisedClean &&
        (!bestScores ||
          (improved && after.scores.overall >= bestScores.overall) ||
          after.scores.overall > bestScores.overall)
      ) {
        bestScores = after.scores;
        bestPlan = plan;
      }

      if (after.approve || afterStats.highSeverity === 0) {
        break;
      }
    }

    const finalUnresolved =
      lastCritic?.issues
        .filter((x) => x.severity === 'high' || x.severity === 'medium')
        .map((x) => `${x.timestamp} ${x.action || ''}: ${x.problem}`)
        .slice(0, 8) || [];
    if (finalUnresolved.length) {
      ledgerLines.push(`FINAL unresolved: ${finalUnresolved.join(' | ')}`);
    } else {
      ledgerLines.push('FINAL unresolved: none');
    }

    onProgress('final', 'Locking highest-scoring edit plan…', 92);

    // Final safety: never export an overlapping EDL
    if (hasSourceOverlap(bestPlan.sequence)) {
      const repaired = repairSourceOverlaps(bestPlan.sequence, 0.8);
      console.warn(
        `[EDL OVERLAP] final bestPlan repaired: ${repaired.repairs.join('; ') || '(none)'}`
      );
      bestPlan = { ...bestPlan, sequence: repaired.sequence };
      ledgerLines.push(
        `FINAL overlap repair: ${repaired.repairs.join('; ') || 'cleared'}`
      );
    }

    bestPlan = {
      ...bestPlan,
      sequence: bestPlan.sequence
        .map((clip) => {
          const scene = (project.scenes || []).find((s: any) => s.id === clip.sourceId);
          if (
            !scene?.userTrimLocked ||
            typeof scene.inPoint !== 'number' ||
            typeof scene.outPoint !== 'number' ||
            scene.outPoint <= scene.inPoint
          ) {
            return clip;
          }
          const start = Math.max(scene.inPoint, Math.min(clip.start, scene.outPoint - 0.3));
          const end = Math.min(scene.outPoint, Math.max(clip.end, start + 0.3));
          return { ...clip, start, end };
        })
        .filter((c) => c.end - c.start >= 0.25),
    };

    if (hasSourceOverlap(bestPlan.sequence)) {
      const repaired = repairSourceOverlaps(bestPlan.sequence, 0.8);
      bestPlan = { ...bestPlan, sequence: repaired.sequence };
    }

    const hookReason = brief.openingHook.reason || 'hook-first open';
    const dropped = (brief.keepDrop || []).filter((k) => k.action === 'drop');
    const insights = shapeInsightsFromCriticAndDrops(lastCritic, brief, bestPlan);

    const directorLog = [
      '── OBSERVATION ──',
      `Takes: ${footageIntel.length} (native video: ${nativeCount}/${footageIntel.length})`,
      ...footageIntel.map(
        (f) =>
          `  ${f.sourceId}: ${(f.observation?.shots.length ?? 0)} shots, ${(f.observation?.moments.length ?? f.segments.length)} moments`
      ),
      '── PROJECT UNDERSTANDING ──',
      `Story: ${projectUnderstanding.overallStory.slice(0, 140)}`,
      `Hook candidates: ${projectUnderstanding.candidateHooks.length}`,
      ...projectUnderstanding.candidateHooks.slice(0, 3).map(
        (h) =>
          `  hook ${h.sourceId} ${h.start.toFixed(1)}–${h.end.toFixed(1)}s (${h.score ?? '?'}) — ${h.reason || h.text || ''}`
      ),
      `Weak/irrelevant: ${projectUnderstanding.weakIrrelevantMaterial.length}`,
      '── DIRECTOR PLAN ──',
      `Hook: ${brief.openingHook.sourceId} ${brief.openingHook.start.toFixed(1)}–${brief.openingHook.end.toFixed(1)}s — ${hookReason}`,
      `Sequence roles: ${brief.sequenceRoles.length}; dropped ${dropped.length} ranges`,
      ...dropped.slice(0, 6).map(
        (d) => `  drop ${d.sourceId} ${d.start.toFixed(1)}–${d.end.toFixed(1)}: ${d.reason}`
      ),
      mode === 'analyze' ? '── ANALYZE (insights only — cuts not applied) ──' : '── EDL ──',
      `Plan: ${bestPlan.sequence.length} clips, style ${bestPlan.style}`,
      '── CRITIC / REVISION LEDGER ──',
      watchedRough ? 'Critic watched rough cut' : 'Critic did not receive a rendered rough cut',
      lastCritic?.summary ? `Critic: ${lastCritic.summary}` : '',
      ...ledgerLines,
    ].filter(Boolean);

    if (mode === 'analyze') {
      const scenes = applyIntelOnlyOntoScenes(project.scenes || [], footageIntel);
      return {
        ok: true,
        stage: 'final',
        mode: 'analyze',
        footageIntel,
        observation: obsSummary,
        projectUnderstanding,
        story,
        brief,
        // Do not return a mutating editPlan — caller keeps base cut
        editPlan: undefined,
        critic: lastCritic,
        qualityScores: bestScores,
        iterations,
        criticIterations,
        scenes,
        channelSettings: {
          ...(project.channelSettings || {}),
          aiEditingPreset: style,
          noiseRemovalEnabled: true,
        },
        editingStyleSummary: `Analyze ready: ${insights.length} insights. Cuts not applied.`,
        directorLog,
        criticWatchedRoughCut: watchedRough,
        insights,
      };
    }

    const scenes = applyPlanOntoScenes(project.scenes || [], bestPlan, footageIntel);
    const channelSettings = {
      ...(project.channelSettings || {}),
      aiEditingPreset: style,
      captionsEnabled:
        bestPlan.captionStrategy.enabled ?? project.channelSettings?.captionsEnabled ?? false,
      noiseRemovalEnabled: true,
    };

    const editingStyleSummary = watchedRough
      ? `Critic watched rough cut. ${hookReason}. ${bestPlan.sequence.length} edited segments (dropped ${dropped.length} ranges).`
      : `Critic EDL-only (rough render skipped). ${hookReason}. ${bestPlan.sequence.length} edited segments.`;

    return {
      ok: true,
      stage: 'final',
      mode: 'recut',
      footageIntel,
      observation: obsSummary,
      projectUnderstanding,
      story,
      brief,
      editPlan: bestPlan,
      critic: lastCritic,
      qualityScores: bestScores,
      iterations,
      criticIterations,
      scenes,
      channelSettings,
      editingStyleSummary,
      directorLog,
      criticWatchedRoughCut: watchedRough,
      insights,
    };
  } catch (err: any) {
    console.error('Director edit pipeline failed:', err);
    return {
      ok: false,
      stage: 'error',
      iterations: 0,
      error: err?.message || String(err),
    };
  } finally {
    for (const dir of roughDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
