/**
 * Stage B — UNDERSTAND
 * "What matters creatively and narratively?" across ALL takes.
 * No timeline, keep/drop, or EDL.
 */
import type {
  EditingStyle,
  FootageIntelligence,
  FootageTimeRef,
  MomentJudgment,
  ProjectUnderstanding,
  StoryUnderstanding,
  StyleConstraints,
} from '../../src/types/editorial';
import { STYLE_CONSTRAINTS } from '../../src/types/editorial';
import {
  observeOutputsHash,
  readStageCache,
  understandCacheKey,
  writeStageCache,
} from '../jobs/stageCache';
import { inferEditPolicy, intendedBeatsFromProject, policyPromptBlock } from './editPolicy';

type AiClient = {
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

function getConstraints(style: EditingStyle): StyleConstraints {
  return STYLE_CONSTRAINTS[style] || STYLE_CONSTRAINTS.high_energy_social;
}

function refFrom(
  sourceId: string,
  start: number,
  end: number,
  extra?: Partial<FootageTimeRef>
): FootageTimeRef {
  return { sourceId, start, end, ...extra };
}

/** Heuristic project understanding when Gemini fails — still no EDL. */
export function heuristicProjectUnderstanding(
  intel: FootageIntelligence[],
  project: {
    title?: string;
    logline?: string;
    entryPath?: string;
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
  }
): ProjectUnderstanding {
  const moments = intel.flatMap((f) =>
    (f.observation?.moments || f.segments.map((s) => ({
      start: s.start,
      end: s.end,
      transcript: s.transcript,
      momentType: s.momentType || 'speech_beat',
      containsMistake: s.containsMistake,
      containsSilence: s.containsSilence,
      containsFiller: s.containsFiller,
      description: s.transcript || '',
    }))).map((m) => ({
      sourceId: f.sourceId,
      start: m.start,
      end: m.end,
      text: ('transcript' in m ? m.transcript : '') || '',
      momentType: String(m.momentType || 'unknown'),
      containsMistake: Boolean(m.containsMistake),
      containsSilence: Boolean(m.containsSilence),
      containsFiller: Boolean(m.containsFiller),
      description: ('description' in m ? String(m.description) : '') || '',
    }))
  );

  const speech = moments.filter(
    (m) =>
      !m.containsMistake &&
      !(m.containsSilence && m.end - m.start > 2) &&
      (m.momentType.includes('speech') ||
        m.momentType.includes('thought') ||
        (m.text && m.text.length > 8))
  );
  const byLength = [...speech].sort(
    (a, b) => (b.text?.length || 0) - (a.text?.length || 0)
  );
  const hooks = byLength.slice(0, 4).map((m, i) =>
    refFrom(m.sourceId, m.start, m.end, {
      text: m.text,
      score: Math.max(0.35, 0.85 - i * 0.1),
      reason: 'speech beat candidate',
    })
  );
  const weak = moments
    .filter(
      (m) =>
        m.containsMistake ||
        (m.containsSilence && m.end - m.start > 2) ||
        m.momentType === 'filler'
    )
    .map((m) =>
      refFrom(m.sourceId, m.start, m.end, {
        reason: m.containsMistake ? 'mistake' : m.containsSilence ? 'long silence' : 'filler',
      })
    );

  const last = speech[speech.length - 1] || moments[moments.length - 1];
  const directed = inferEditPolicy(project) === 'directed';
  const firstIntel = intel[0];
  const firstSpeech = firstIntel
    ? speech.find((s) => s.sourceId === firstIntel.sourceId) || speech[0]
    : speech[0];
  const hookSource = directed && firstSpeech ? firstSpeech : null;
  const directedHooks = hookSource
    ? [
        refFrom(hookSource.sourceId, hookSource.start, hookSource.end, {
          text: hookSource.text,
          score: 0.8,
          reason: 'first directed beat',
        }),
      ]
    : hooks;
  const judgments: MomentJudgment[] = speech.slice(0, 24).map((m, i) => ({
    sourceId: m.sourceId,
    start: m.start,
    end: m.end,
    narrativeImportance: Math.max(0.3, 0.7 - i * 0.02),
    hookPotential: i < 3 ? 0.7 - i * 0.1 : 0.35,
    emotionalImportance: 0.4,
    visualImportance: 0.4,
    primaryFootageCandidate: true,
    brollCandidate: false,
    reactionCandidate: m.momentType === 'reaction',
    transitionCandidate: false,
    notes: m.text?.slice(0, 80),
  }));

  return {
    overallStory: project.logline || project.title || 'Creator video',
    majorStorySections: intel.map((i) => i.title || i.sourceId),
    primarySubject: project.title || intel[0]?.title || 'Creator video',
    intendedAudience: 'general social audience',
    keyMessage: (directed ? directedHooks[0]?.text : hooks[0]?.text)?.slice(0, 120) || 'Share the core idea clearly',
    strongestStatements: (directed ? directedHooks : hooks).slice(0, 3).map((h) => ({
      ...h,
      text: h.text || '',
    })),
    strongestEmotionalMoments: [],
    strongestVisualMoments: [],
    redundantInformation: [],
    weakIrrelevantMaterial: weak.slice(0, 12),
    candidateHooks: directed ? directedHooks : hooks,
    candidateEndings: last
      ? [refFrom(last.sourceId, last.start, last.end, { reason: 'final speech beat', text: last.text })]
      : [],
    candidateBroll: [],
    candidateReactions: moments
      .filter((m) => m.momentType === 'reaction')
      .slice(0, 4)
      .map((m) => refFrom(m.sourceId, m.start, m.end, { reason: 'reaction' })),
    candidateEstablishingShots: [],
    candidateCutaways: [],
    candidateTransitions: [],
    pacingOpportunities: directed
      ? ['Trim dead air', 'Remove mistakes', 'Keep scene order']
      : ['Open with strongest statement', 'Trim long silence', 'End with clear CTA'],
    possibleNarrativeOrder: directed
      ? intel.map((i) => i.title || i.sourceId)
      : ['hook', 'context', 'explanation', 'proof', 'cta'],
    momentJudgments: judgments,
    majorTopics: intel.map((i) => i.title || i.sourceId).filter(Boolean) as string[],
    repeatedInformation: [],
    irrelevantSections: weak.slice(0, 8),
    narrativeOpportunities: directed
      ? ['Polish the directed performance', 'Preserve complete thoughts']
      : ['Open with strongest statement', 'End with clear CTA'],
    naturalStoryProgression: directed
      ? intel.map((i) => i.title || i.sourceId)
      : ['hook', 'context', 'explanation', 'proof', 'cta'],
  };
}

/** Map Stage B → legacy StoryUnderstanding for DirectorCreativeBrief.story */
export function projectUnderstandingToStory(u: ProjectUnderstanding): StoryUnderstanding {
  return {
    primarySubject: u.primarySubject,
    intendedAudience: u.intendedAudience,
    keyMessage: u.keyMessage,
    majorTopics: u.majorTopics || u.majorStorySections || [],
    strongestStatements: (u.strongestStatements || []).map((s) => ({
      sourceId: s.sourceId,
      start: s.start,
      end: s.end,
      text: s.text || '',
    })),
    strongestEmotionalMoments: (u.strongestEmotionalMoments || []).map((s) => ({
      sourceId: s.sourceId,
      start: s.start,
      end: s.end,
      reason: s.reason || '',
    })),
    repeatedInformation: u.repeatedInformation || u.redundantInformation || [],
    irrelevantSections: (u.irrelevantSections || u.weakIrrelevantMaterial || []).map((s) => ({
      sourceId: s.sourceId,
      start: s.start,
      end: s.end,
      reason: s.reason || 'weak',
    })),
    narrativeOpportunities: u.narrativeOpportunities || u.pacingOpportunities || [],
    possibleOpeningHooks: (u.candidateHooks || []).map((h) => ({
      sourceId: h.sourceId,
      start: h.start,
      end: h.end,
      score: h.score ?? 0.5,
      reason: h.reason || h.text || 'hook candidate',
    })),
    strongestEnding: u.candidateEndings?.[0]
      ? {
          sourceId: u.candidateEndings[0].sourceId,
          start: u.candidateEndings[0].start,
          end: u.candidateEndings[0].end,
          reason: u.candidateEndings[0].reason || 'ending candidate',
        }
      : null,
    naturalStoryProgression: u.naturalStoryProgression || u.possibleNarrativeOrder || [],
  };
}

function compactObservations(intel: FootageIntelligence[]) {
  return intel.map((f) => ({
    sourceId: f.sourceId,
    title: f.title,
    duration: f.sourceDuration,
    nativeVideoAnalyzed: Boolean(f.nativeVideoAnalyzed),
    transcript: (f.fullTranscript || '').slice(0, 1200),
    shots: (f.observation?.shots || []).map((s) => ({
      shotId: s.shotId,
      start: s.start,
      end: s.end,
      shotType: s.shotType,
      framing: s.framing,
      cameraMovement: s.cameraMovement,
      subject: s.subject,
      scene: s.scene,
      stability: s.stability,
    })),
    moments: (f.observation?.moments || f.segments).map((m: any) => ({
      start: m.start,
      end: m.end,
      shotId: m.shotId,
      transcript: (m.transcript || m.text || '').slice(0, 160),
      momentType: m.momentType || 'speech_beat',
      description: (m.description || '').slice(0, 120),
      containsSilence: m.containsSilence,
      containsFiller: m.containsFiller,
      containsMistake: m.containsMistake,
      repetitionObserved: m.repetitionObserved ?? m.isRepetition,
    })),
    audio: f.observation?.audio
      ? {
          speechPresent: f.observation.audio.speechPresent,
          dialogueClarity: f.observation.audio.dialogueClarity,
          silenceRanges: f.observation.audio.silenceRanges?.slice(0, 8),
        }
      : undefined,
  }));
}

function normalizeRefs(arr: any): FootageTimeRef[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r: any) => ({
      sourceId: String(r.sourceId || ''),
      start: Number(r.start) || 0,
      end: Number(r.end) || 0,
      reason: r.reason != null ? String(r.reason) : undefined,
      text: r.text != null ? String(r.text) : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
    }))
    .filter((r) => r.sourceId && r.end > r.start);
}

export async function runUnderstand(
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
      entryPath?: string;
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
    style: EditingStyle;
    targetDuration: number;
    aspectRatio: '9:16' | '16:9';
  }
): Promise<ProjectUnderstanding> {
  const constraints: StyleConstraints = getConstraints(opts.style);
  const fallback = heuristicProjectUnderstanding(opts.footageIntel, opts.project);
  const compact = compactObservations(opts.footageIntel);
  const editPolicy = inferEditPolicy(opts.project);
  const intendedBeats = intendedBeatsFromProject(opts.project, opts.footageIntel);
  const cacheKey = understandCacheKey({
    observeHash: observeOutputsHash(compact),
    style: opts.style,
    targetDuration: opts.targetDuration,
    aspectRatio: opts.aspectRatio,
    editPolicy,
  });
  const cached = await readStageCache<ProjectUnderstanding>('understand', cacheKey);
  if (cached) {
    console.log('[understand-cache] hit');
    return cached;
  }

  try {
    const prompt = `You are TakeOne's PROJECT UNDERSTANDING stage (NOT the editor, NOT the renderer).

Job: "What matters creatively and narratively?" across ALL takes.

${policyPromptBlock(editPolicy, intendedBeats)}

Project: "${opts.project.title || 'Untitled'}"
Logline / brief: "${opts.project.logline || ''}"
Format: ${opts.project.videoFormat || 'short-form'} ${opts.aspectRatio}
Target duration: ~${opts.targetDuration}s
Editing style: ${opts.style}
Style constraints: ${JSON.stringify(constraints)}

Stage A OBSERVATIONS (factual — no keep/drop yet):
${JSON.stringify(compact).slice(0, 16000)}

RULES:
1. ${
      editPolicy === 'directed'
        ? 'Do NOT recommend reordering scenes or dropping a required beat. weakIrrelevantMaterial may only be mistakes, mumbles, or long silence INSIDE a take — never an entire scripted scene.'
        : 'Compare moments ACROSS takes. Identify the strongest hook only after seeing the whole project.'
    }
2. Do NOT output a timeline, keep/drop list, EDL, FFmpeg, or final sequence.
3. Do NOT invent footage that is not in the observations.
4. Prefer short, accurate judgments over huge speculative lists.
5. Production words like cut/action are not mistakes.
6. Introduce project-level scores on moments: narrativeImportance, hookPotential, emotionalImportance, visualImportance, and candidate flags.
7. ${
      editPolicy === 'directed'
        ? 'possibleNarrativeOrder / naturalStoryProgression MUST match the intended beats in creator order.'
        : 'possibleNarrativeOrder is a suggested story, not a locked production plan.'
    }

Return JSON only:
{
  "overallStory": "",
  "majorStorySections": [],
  "primarySubject": "",
  "intendedAudience": "",
  "keyMessage": "",
  "strongestStatements": [{"sourceId":"","start":0,"end":0,"text":"","reason":""}],
  "strongestEmotionalMoments": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "strongestVisualMoments": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "redundantInformation": [],
  "weakIrrelevantMaterial": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateHooks": [{"sourceId":"","start":0,"end":0,"score":0.8,"reason":"","text":""}],
  "candidateEndings": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateBroll": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateReactions": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateEstablishingShots": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateCutaways": [{"sourceId":"","start":0,"end":0,"reason":""}],
  "candidateTransitions": [{"fromSourceId":"","toSourceId":"","suggestion":"hard_cut","reason":""}],
  "pacingOpportunities": [],
  "possibleNarrativeOrder": ["hook","context","explanation","cta"],
  "momentJudgments": [
    {
      "sourceId": "",
      "start": 0,
      "end": 0,
      "narrativeImportance": 0.5,
      "hookPotential": 0.5,
      "emotionalImportance": 0.5,
      "visualImportance": 0.5,
      "primaryFootageCandidate": true,
      "brollCandidate": false,
      "reactionCandidate": false,
      "transitionCandidate": false,
      "notes": ""
    }
  ]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(response.text || '{}');
    const momentJudgments: MomentJudgment[] = Array.isArray(parsed.momentJudgments)
      ? parsed.momentJudgments
          .map((j: any) => ({
            sourceId: String(j.sourceId || ''),
            start: Number(j.start) || 0,
            end: Number(j.end) || 0,
            narrativeImportance:
              typeof j.narrativeImportance === 'number' ? j.narrativeImportance : undefined,
            hookPotential: typeof j.hookPotential === 'number' ? j.hookPotential : undefined,
            emotionalImportance:
              typeof j.emotionalImportance === 'number' ? j.emotionalImportance : undefined,
            visualImportance: typeof j.visualImportance === 'number' ? j.visualImportance : undefined,
            primaryFootageCandidate: Boolean(j.primaryFootageCandidate),
            brollCandidate: Boolean(j.brollCandidate),
            reactionCandidate: Boolean(j.reactionCandidate),
            transitionCandidate: Boolean(j.transitionCandidate),
            notes: j.notes != null ? String(j.notes) : undefined,
          }))
          .filter((j: MomentJudgment) => j.sourceId && j.end > j.start)
      : fallback.momentJudgments;

    const understanding: ProjectUnderstanding = {
      overallStory: String(parsed.overallStory || fallback.overallStory),
      majorStorySections: Array.isArray(parsed.majorStorySections)
        ? parsed.majorStorySections.map(String)
        : fallback.majorStorySections,
      primarySubject: String(parsed.primarySubject || fallback.primarySubject),
      intendedAudience: String(parsed.intendedAudience || fallback.intendedAudience),
      keyMessage: String(parsed.keyMessage || fallback.keyMessage),
      strongestStatements: normalizeRefs(parsed.strongestStatements).length
        ? normalizeRefs(parsed.strongestStatements)
        : fallback.strongestStatements,
      strongestEmotionalMoments: normalizeRefs(parsed.strongestEmotionalMoments),
      strongestVisualMoments: normalizeRefs(parsed.strongestVisualMoments),
      redundantInformation: Array.isArray(parsed.redundantInformation)
        ? parsed.redundantInformation.map(String)
        : [],
      weakIrrelevantMaterial: normalizeRefs(parsed.weakIrrelevantMaterial).length
        ? normalizeRefs(parsed.weakIrrelevantMaterial)
        : fallback.weakIrrelevantMaterial,
      candidateHooks: normalizeRefs(parsed.candidateHooks).length
        ? normalizeRefs(parsed.candidateHooks)
        : fallback.candidateHooks,
      candidateEndings: normalizeRefs(parsed.candidateEndings).length
        ? normalizeRefs(parsed.candidateEndings)
        : fallback.candidateEndings,
      candidateBroll: normalizeRefs(parsed.candidateBroll),
      candidateReactions: normalizeRefs(parsed.candidateReactions),
      candidateEstablishingShots: normalizeRefs(parsed.candidateEstablishingShots),
      candidateCutaways: normalizeRefs(parsed.candidateCutaways),
      candidateTransitions: Array.isArray(parsed.candidateTransitions)
        ? parsed.candidateTransitions.map((t: any) => ({
            fromSourceId: String(t.fromSourceId || ''),
            toSourceId: String(t.toSourceId || ''),
            suggestion: String(t.suggestion || 'hard_cut'),
            reason: String(t.reason || ''),
          }))
        : [],
      pacingOpportunities: Array.isArray(parsed.pacingOpportunities)
        ? parsed.pacingOpportunities.map(String)
        : fallback.pacingOpportunities,
      possibleNarrativeOrder: Array.isArray(parsed.possibleNarrativeOrder)
        ? parsed.possibleNarrativeOrder.map(String)
        : fallback.possibleNarrativeOrder,
      momentJudgments,
      majorTopics: Array.isArray(parsed.majorStorySections)
        ? parsed.majorStorySections.map(String)
        : fallback.majorTopics,
      repeatedInformation: Array.isArray(parsed.redundantInformation)
        ? parsed.redundantInformation.map(String)
        : [],
      irrelevantSections: normalizeRefs(parsed.weakIrrelevantMaterial),
      narrativeOpportunities: Array.isArray(parsed.pacingOpportunities)
        ? parsed.pacingOpportunities.map(String)
        : fallback.narrativeOpportunities,
      naturalStoryProgression: Array.isArray(parsed.possibleNarrativeOrder)
        ? parsed.possibleNarrativeOrder.map(String)
        : fallback.naturalStoryProgression,
    };

    console.log(
      `[PROJECT UNDERSTANDING] hooks=${understanding.candidateHooks.length} weak=${understanding.weakIrrelevantMaterial.length} judgments=${understanding.momentJudgments.length}`
    );
    await writeStageCache('understand', cacheKey, understanding);
    return understanding;
  } catch (err) {
    console.warn('Stage B understand failed, heuristic:', (err as Error).message);
    return fallback;
  }
}
