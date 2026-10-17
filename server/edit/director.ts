/**
 * Stage C — DIRECT
 * "What finished video should we create?"
 * Consumes Stage A observations + Stage B project understanding.
 * Does NOT emit FFmpeg — Planner builds the validated EDL.
 */
import type {
  DirectorCreativeBrief,
  EditingStyle,
  FootageIntelligence,
  ProjectUnderstanding,
  StoryUnderstanding,
  StyleConstraints,
} from '../../src/types/editorial';
import { STYLE_CONSTRAINTS as CONSTRAINTS, mapLegacyPresetToStyle } from '../../src/types/editorial';
import { projectUnderstandingToStory } from './understand';
import {
  inferEditPolicy,
  intendedBeatsFromProject,
  lockBriefToDirectedPolicy,
  policyPromptBlock,
} from './editPolicy';
import {
  directCacheKey,
  observeOutputsHash,
  readStageCache,
  understandingHash,
  writeStageCache,
} from '../jobs/stageCache';

type AiClient = {
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

export function resolveStyle(preset?: string | null): EditingStyle {
  if (
    preset &&
    [
      'cinematic',
      'youtube',
      'high_energy_social',
      'documentary',
      'corporate',
      'travel',
      'interview_podcast',
    ].includes(preset)
  ) {
    return preset as EditingStyle;
  }
  return mapLegacyPresetToStyle(preset);
}

export function getStyleConstraints(style: EditingStyle): StyleConstraints {
  return CONSTRAINTS[style] || CONSTRAINTS.high_energy_social;
}

function heuristicBrief(
  story: StoryUnderstanding,
  understanding: ProjectUnderstanding,
  intel: FootageIntelligence[],
  style: EditingStyle,
  targetDuration: number,
  aspectRatio: '9:16' | '16:9'
): DirectorCreativeBrief {
  const constraints = getStyleConstraints(style);
  const opening = story.possibleOpeningHooks[0] ||
    understanding.candidateHooks[0] || {
      sourceId: intel[0]?.sourceId || '',
      start: 0,
      end: Math.min(4, intel[0]?.sourceDuration || 4),
      reason: 'first available take',
    };

  const weakSet = new Set(
    (understanding.weakIrrelevantMaterial || []).map(
      (w) => `${w.sourceId}:${w.start.toFixed(1)}-${w.end.toFixed(1)}`
    )
  );

  const keepDrop = intel.flatMap((i) =>
    i.segments.map((s) => {
      const key = `${s.sourceId}:${s.start.toFixed(1)}-${s.end.toFixed(1)}`;
      const drop =
        s.containsMistake ||
        (s.containsSilence && s.end - s.start > 2.0) ||
        weakSet.has(key);
      return {
        sourceId: s.sourceId,
        start: s.start,
        end: s.end,
        action: (drop ? 'drop' : 'keep') as 'keep' | 'drop',
        reason: s.containsMistake
          ? 'mistake'
          : s.containsSilence && s.end - s.start > 2.0
            ? 'long dead air'
            : drop
              ? 'weak/irrelevant (Stage B)'
              : 'keep for story',
      };
    })
  );

  const keeps = keepDrop.filter((k) => k.action === 'keep');
  const sequenceRoles: DirectorCreativeBrief['sequenceRoles'] = [];

  if (opening.sourceId) {
    sequenceRoles.push({
      sourceId: opening.sourceId,
      start: opening.start,
      end: opening.end,
      role: 'hook',
      notes: ('reason' in opening ? opening.reason : undefined) || 'hook candidate',
      transitionOut: 'hard_cut',
    });
  }

  const narrativeOrder = understanding.possibleNarrativeOrder || [
    'context',
    'explanation',
    'proof',
    'cta',
  ];
  const roles: Array<DirectorCreativeBrief['sequenceRoles'][0]['role']> = [
    'context',
    'explanation',
    'proof',
    'cta',
  ];
  let ri = 0;

  // Prefer Stage B primary candidates spanning full speech per take
  for (const f of intel) {
    const speechSegs = f.segments.filter(
      (s) => !(s.containsMistake || (s.containsSilence && s.end - s.start > 2.0))
    );
    if (!speechSegs.length) continue;
    const start = Math.min(...speechSegs.map((s) => s.start));
    const end = Math.max(...speechSegs.map((s) => s.end));
    if (
      f.sourceId === opening.sourceId &&
      Math.abs(start - opening.start) < 0.5 &&
      Math.abs(end - opening.end) < 1.5
    ) {
      continue;
    }
    const already = sequenceRoles.some(
      (r) => r.sourceId === f.sourceId && Math.abs(r.start - start) < 0.4
    );
    if (already) continue;
    sequenceRoles.push({
      sourceId: f.sourceId,
      start,
      end: Math.min(end, f.sourceDuration),
      role: roles[Math.min(ri, roles.length - 1)],
      transitionOut: 'hard_cut',
    });
    ri++;
  }

  // Fill from keeps if still thin
  for (const k of keeps) {
    if (sequenceRoles.length >= Math.max(3, intel.length + 1)) break;
    if (
      k.sourceId === opening.sourceId &&
      Math.abs(k.start - opening.start) < 0.4 &&
      Math.abs(k.end - opening.end) < 0.4
    ) {
      continue;
    }
    const dup = sequenceRoles.some(
      (r) => r.sourceId === k.sourceId && Math.abs(r.start - k.start) < 0.4
    );
    if (dup) continue;
    sequenceRoles.push({
      sourceId: k.sourceId,
      start: k.start,
      end: k.end,
      role: roles[Math.min(ri, roles.length - 1)],
      transitionOut: 'hard_cut',
    });
    ri++;
  }

  void narrativeOrder;

  let total = 0;
  const capped = [];
  for (const s of sequenceRoles) {
    const dur = s.end - s.start;
    if (total + dur > targetDuration * 1.15 && capped.length >= 2) break;
    capped.push(s);
    total += dur;
  }

  const brollOpportunities = (understanding.candidateBroll || []).slice(0, 4).map((b) => ({
    atSourceId: b.sourceId,
    atTime: b.start,
    concept: b.reason || 'broll candidate',
    preferredSourceId: b.sourceId,
    preferredStart: b.start,
    preferredEnd: b.end,
    durationSeconds: Math.min(3, Math.max(0.8, b.end - b.start)),
    replaceOrOverlay: 'replace' as const,
    whyNeeded: b.reason || 'Stage B broll candidate',
  }));

  return {
    style,
    targetDuration,
    aspectRatio,
    story,
    openingHook: {
      sourceId: opening.sourceId,
      start: opening.start,
      end: opening.end,
      reason:
        ('reason' in opening ? String(opening.reason) : '') ||
        'strongest hook from Stage B',
    },
    sequenceRoles: capped,
    keepDrop,
    granularCuts: (() => {
      const cuts: DirectorCreativeBrief['granularCuts'] = [];
      for (const f of intel) {
        const speechSegs = f.segments.filter(
          (s) => !(s.containsMistake || (s.containsSilence && s.end - s.start > 2.0))
        );
        if (speechSegs.length >= 1) {
          const start = Math.min(...speechSegs.map((s) => s.start));
          const end = Math.max(...speechSegs.map((s) => s.end));
          cuts.push({
            sourceId: f.sourceId,
            start,
            end: Math.min(end, f.sourceDuration),
            action: 'keep',
            reason: 'full take keep (conservative)',
          });
          for (const s of f.segments) {
            if (s.containsMistake || (s.containsSilence && s.end - s.start > 2.0)) {
              cuts.push({
                sourceId: s.sourceId,
                start: s.start,
                end: s.end,
                action: 'drop',
                reason: s.containsMistake ? 'mistake' : 'long dead air',
              });
            }
          }
          continue;
        }
        for (const s of f.segments) {
          cuts.push({
            sourceId: s.sourceId,
            start: s.start,
            end: s.end,
            action: 'drop',
            reason: 'no usable speech',
          });
        }
      }
      return cuts;
    })(),
    brollOpportunities,
    audioStrategy: {
      musicEnabled: constraints.musicIntensity !== 'none',
      duckUnderSpeech: true,
      fadeInOut: true,
      notes: `Style ${style}: music ${constraints.musicIntensity}`,
    },
    captionStrategy: {
      enabled: constraints.captionDensity !== 'sparse',
      emphasizeKeywords: [],
    },
    pacingNotes: `Avg shot ${constraints.avgShotSeconds[0]}–${constraints.avgShotSeconds[1]}s; preferHardCuts=${constraints.preferHardCuts}`,
    transitionPhilosophy:
      'Always hard_cut between talking-head scenes. Occasional L-cut into B-roll only.',
  };
}

function compactObservationsForDirector(intel: FootageIntelligence[]) {
  return intel.map((f) => ({
    sourceId: f.sourceId,
    title: f.title,
    duration: f.sourceDuration,
    nativeVideoAnalyzed: Boolean(f.nativeVideoAnalyzed),
    transcript: (f.fullTranscript || '').slice(0, 800),
    shots: (f.observation?.shots || []).slice(0, 12).map((s) => ({
      shotId: s.shotId,
      start: s.start,
      end: s.end,
      shotType: s.shotType,
      cameraMovement: s.cameraMovement,
      subject: s.subject,
      stability: s.stability,
    })),
    moments: (f.observation?.moments || f.segments).slice(0, 40).map((m: any) => ({
      start: m.start,
      end: m.end,
      shotId: m.shotId,
      text: (m.transcript || '').slice(0, 140),
      momentType: m.momentType || 'speech_beat',
      containsMistake: m.containsMistake,
      containsFiller: m.containsFiller,
      containsSilence: m.containsSilence,
      naturalCutPoints: m.naturalCutPoints,
    })),
  }));
}

export async function runDirector(
  ai: AiClient,
  opts: {
    project: {
      id: string;
      title?: string;
      logline?: string;
      videoFormat?: string;
      aspectRatio?: string;
      estimatedTotalSeconds?: number;
      channelSettings?: { aiEditingPreset?: string };
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
    footageIntel: FootageIntelligence[];
    projectUnderstanding: ProjectUnderstanding;
    style?: EditingStyle;
    preset?: string;
  }
): Promise<{ story: StoryUnderstanding; brief: DirectorCreativeBrief }> {
  const style =
    opts.style || resolveStyle(opts.preset || opts.project.channelSettings?.aiEditingPreset);
  const constraints = getStyleConstraints(style);
  const aspectRatio = (opts.project.aspectRatio === '16:9' ? '16:9' : '9:16') as
    | '9:16'
    | '16:9';
  const targetDuration = Math.min(
    180,
    Math.max(
      15,
      opts.project.estimatedTotalSeconds || (opts.project.videoFormat === 'long-form' ? 90 : 45)
    )
  );

  const story = projectUnderstandingToStory(opts.projectUnderstanding);
  const editPolicy = inferEditPolicy(opts.project);
  const intendedBeats = intendedBeatsFromProject(opts.project, opts.footageIntel);
  console.log(
    `[EDIT POLICY] ${editPolicy} beats=${intendedBeats.map((b) => b.label).join(' → ') || 'n/a'}`
  );
  let fallback = heuristicBrief(
    story,
    opts.projectUnderstanding,
    opts.footageIntel,
    style,
    targetDuration,
    aspectRatio
  );
  fallback = {
    ...fallback,
    editPolicy,
    intendedBeats,
  };
  if (editPolicy === 'directed') {
    fallback = lockBriefToDirectedPolicy(fallback, opts.footageIntel, intendedBeats);
  }

  const compactObs = compactObservationsForDirector(opts.footageIntel);
  const compactUnderstanding = {
    overallStory: opts.projectUnderstanding.overallStory,
    keyMessage: opts.projectUnderstanding.keyMessage,
    candidateHooks: opts.projectUnderstanding.candidateHooks,
    candidateEndings: opts.projectUnderstanding.candidateEndings,
    weakIrrelevantMaterial: opts.projectUnderstanding.weakIrrelevantMaterial,
    strongestStatements: opts.projectUnderstanding.strongestStatements,
    strongestEmotionalMoments: opts.projectUnderstanding.strongestEmotionalMoments,
    strongestVisualMoments: opts.projectUnderstanding.strongestVisualMoments,
    candidateBroll: opts.projectUnderstanding.candidateBroll,
    candidateReactions: opts.projectUnderstanding.candidateReactions,
    candidateCutaways: opts.projectUnderstanding.candidateCutaways,
    pacingOpportunities: opts.projectUnderstanding.pacingOpportunities,
    possibleNarrativeOrder: opts.projectUnderstanding.possibleNarrativeOrder,
    momentJudgments: (opts.projectUnderstanding.momentJudgments || []).slice(0, 40),
  };

  const cacheKey = directCacheKey({
    observeHash: observeOutputsHash(compactObs),
    understandHash: understandingHash(compactUnderstanding),
    style,
    editPolicy,
  });
  const cached = await readStageCache<{ story: StoryUnderstanding; brief: DirectorCreativeBrief }>(
    'direct',
    cacheKey
  );
  if (cached?.brief && cached?.story) {
    console.log('[direct-cache] hit');
    if (editPolicy === 'directed') {
      cached.brief = lockBriefToDirectedPolicy(cached.brief, opts.footageIntel, intendedBeats);
    }
    return cached;
  }

  const directedRules =
    editPolicy === 'directed'
      ? `3. NEVER drop a REQUIRED beat / whole source because Stage B labeled it weak. Weak scores may only trim dead air or mistakes inside a take.
4. NEVER reorder scenes. sequenceRoles and granularCuts MUST follow intended beat order. openingHook = first directed beat, not the "strongest" later clip.
5. Preserve complete spoken thoughts. Drop ONLY true mistakes, mumbles/noise, or long silence (>~2s) inside a take.`
      : `3. Default KEEP full spoken takes. Drop mistakes, long silence (>~2s), or Stage B weakIrrelevantMaterial.
4. You MAY reorder and drop sections to find the best story from raw footage.
5. Use Stage B candidateHooks for the opening.`;

  const ugcJump =
    opts.project.creativeBrief?.contentType === 'ugc_ad' ||
    opts.project.creativeBrief?.editingStrategy === 'jump_cut_social' ||
    opts.project.captureStrategy === 'single_take'
      ? `
UGC / jump_cut_social: preserve narrative beat order and complete dialogue. Remove mistakes, dead air, and redundant phrases. Tasteful jump cuts, subtle punch-ins, captions, music, overlays, optional B-roll. Do NOT radically reorder the performance, cut arbitrary sentence fragments together, or turn one continuous take into an incoherent montage.`
      : '';

  try {
    const prompt = `You are TakeOne's AI DIRECTOR (Stage C — NOT the observer, NOT the renderer).

Job: "What finished video should we create?"

You receive:
1) Stage A OBSERVATIONS (factual shots/moments — no keep/drop)
2) Stage B PROJECT UNDERSTANDING (what matters across takes)

${policyPromptBlock(editPolicy, intendedBeats)}

Project: "${opts.project.title || 'Untitled'}"
Logline: "${opts.project.logline || ''}"
Format: ${opts.project.videoFormat || 'short-form'} ${aspectRatio}
Target duration: ~${targetDuration}s
Editing style: ${style}
Style constraints: ${JSON.stringify(constraints)}

STAGE A OBSERVATIONS:
${JSON.stringify(compactObs).slice(0, 10000)}

STAGE B PROJECT UNDERSTANDING:
${JSON.stringify(compactUnderstanding).slice(0, 8000)}

RULES:
1. HOOK COMPLETENESS (critical): A hook must establish the premise, preserve enough context to make sense, and FINISH THE THOUGHT (or intentionally hand off). End at a natural linguistic/visual boundary. Prefer an 8.6s complete hook over a 7s fragment. Do NOT truncate a statement merely because target duration is short.
2. SPEECH CONTINUITY & SINGLE TAKE: In a continuous take, DO NOT drop normal pauses between sentences under 1.8s. A 0.8s–1.2s pause between sentences is normal human cadence; dropping it creates jarring, unnatural face jumps. Only drop real dead air (>1.8s), false starts, or pre/post-roll silence outside speech.
3. Do NOT drop ranges just because transcript contains "cut" or "action".
${directedRules}
${ugcJump}
6. HARD CUTS between talking-head scenes. No xfade / dissolve / whip on A-roll joins.
7. ZOOM LANGUAGE: default 1.00x. Subtle emphasis only 1.04–1.06x. Never exceed 1.10x. Do not punch in on every cut; avoid consecutive unrelated zooms (1.00→1.10→1.02).
8. Prefer sentence boundaries / naturalCutPoints / completed_thought moments for in/out — especially last clip ending.
9. Do NOT output FFmpeg or shell. JSON only.
10. Do NOT re-observe the video or invent new moments not in Stage A/B.

Return JSON:
{
  "openingHook": {"sourceId":"","start":0,"end":0,"reason":""},
  "sequenceRoles": [{"sourceId":"","start":0,"end":0,"role":"hook|context|explanation|proof|cta|bridge|outro","notes":"","zoom":1.0,"transitionOut":"hard_cut"}],
  "keepDrop": [{"sourceId":"","start":0,"end":0,"action":"keep|drop","reason":""}],
  "granularCuts": [
    {"sourceId":"","start":0.8,"end":28,"action":"keep","reason":"full spoken take"},
    {"sourceId":"","start":0,"end":0.8,"action":"drop","reason":"leading dead air before speech starts"}
  ],
  "brollOpportunities": [],
  "audioStrategy": {"musicEnabled":true,"duckUnderSpeech":true,"fadeInOut":true,"notes":""},
  "captionStrategy": {"enabled":true,"emphasizeKeywords":[]},
  "pacingNotes": "",
  "transitionPhilosophy": "Always hard_cut between scenes. No xfade on talking-head joins."
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(response.text || '{}');

    let brief: DirectorCreativeBrief = {
      style,
      targetDuration,
      aspectRatio,
      editPolicy,
      intendedBeats,
      story,
      openingHook: parsed.openingHook || fallback.openingHook,
      sequenceRoles:
        Array.isArray(parsed.sequenceRoles) && parsed.sequenceRoles.length
          ? parsed.sequenceRoles
          : fallback.sequenceRoles,
      keepDrop:
        Array.isArray(parsed.keepDrop) && parsed.keepDrop.length
          ? parsed.keepDrop
          : fallback.keepDrop,
      granularCuts: Array.isArray(parsed.granularCuts)
        ? parsed.granularCuts
        : fallback.granularCuts,
      brollOpportunities: Array.isArray(parsed.brollOpportunities)
        ? parsed.brollOpportunities
        : fallback.brollOpportunities,
      audioStrategy: { ...fallback.audioStrategy, ...(parsed.audioStrategy || {}) },
      captionStrategy: { ...fallback.captionStrategy, ...(parsed.captionStrategy || {}) },
      pacingNotes: parsed.pacingNotes || fallback.pacingNotes,
      transitionPhilosophy:
        parsed.transitionPhilosophy ||
        fallback.transitionPhilosophy ||
        'Default hard_cut. Avoid transition spam.',
    };
    if (editPolicy === 'directed') {
      brief = lockBriefToDirectedPolicy(brief, opts.footageIntel, intendedBeats);
    }

    console.log(
      `[DIRECTOR PLAN] hook=${brief.openingHook.sourceId} ${brief.openingHook.start.toFixed(1)}-${brief.openingHook.end.toFixed(1)} roles=${brief.sequenceRoles.length} drops=${brief.keepDrop.filter((k) => k.action === 'drop').length}`
    );

    await writeStageCache('direct', cacheKey, { story, brief });
    return { story, brief };
  } catch (err) {
    console.warn('Director Gemini failed, heuristic brief:', (err as Error).message);
    return { story, brief: fallback };
  }
}
