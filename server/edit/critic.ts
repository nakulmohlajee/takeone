/**
 * AI Editorial Critic — watches rendered rough cut; emits timestamped edit operations.
 * Does NOT regenerate the EDL — Planner mutates affected clips only.
 */
import type {
  CriticEditAction,
  CriticIssue,
  CriticIssueParameters,
  CriticReport,
  QualityScores,
  ValidatedEditPlan,
  FootageIntelligence,
  DirectorCreativeBrief,
  PlannedClip,
} from '../../src/types/editorial';
import { mimeForVideoPath, uploadVideoForGemini, videoFilePart } from './geminiVideo';
import {
  directedSequenceIssues,
  flashFrameIssues,
  policyPromptBlock,
} from './editPolicy';

type AiClient = {
  files?: any;
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

const VALID_ACTIONS: CriticEditAction[] = [
  'extend_clip',
  'trim_clip',
  'set_range',
  'set_zoom',
  'normalize_zoom',
  'hard_cut',
  'complete_ending',
  'none',
];

/** Style zoom palette — high_energy_social defaults */
export function zoomPalette(style: string): { base: number; subtle: [number, number]; max: number } {
  if (style === 'high_energy_social') {
    return { base: 1.0, subtle: [1.04, 1.06], max: 1.1 };
  }
  if (style === 'cinematic' || style === 'documentary') {
    return { base: 1.0, subtle: [1.03, 1.06], max: 1.08 };
  }
  return { base: 1.0, subtle: [1.04, 1.08], max: 1.1 };
}

export function clampZoomForStyle(zoom: number | undefined, style: string): number {
  const pal = zoomPalette(style);
  const z = typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : pal.base;
  return Math.max(pal.base, Math.min(pal.max, Math.round(z * 100) / 100));
}

function clampScore(n: unknown, fallback = 6): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(10, v));
}

function overallFrom(scores: Omit<QualityScores, 'overall'>): number {
  const vals = [
    scores.story_score,
    scores.pacing_score,
    scores.visual_continuity_score,
    scores.audio_score,
    scores.transition_score,
    scores.caption_score,
    scores.professionalism_score,
  ];
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function countFancyTransitions(plan: ValidatedEditPlan): number {
  return plan.sequence.filter(
    (c) =>
      c.transitionOut &&
      !['hard_cut', 'cutaway', 'j_cut', 'l_cut', 'match_cut'].includes(c.transitionOut)
  ).length;
}

export function parseTimestampToSeconds(ts: string | undefined): number {
  if (!ts) return 0;
  const m = String(ts).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$|^(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  if (m[4] != null) return parseFloat(m[4]);
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseFloat(m[3]);
  return h * 3600 + min * 60 + sec;
}

export function formatTimelineTs(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}

export type TimelineClipMap = {
  clipId: string;
  role: string;
  sourceId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
  zoom: number;
  isBroll?: boolean;
};

/** Map plan clips onto rough-cut timeline (no intro in rough cut). */
export function buildTimelineMap(plan: ValidatedEditPlan): TimelineClipMap[] {
  let t = 0;
  return plan.sequence.map((c) => {
    const dur = Math.max(0.25, c.end - c.start);
    const row: TimelineClipMap = {
      clipId: c.id,
      role: c.role,
      sourceId: c.sourceId,
      sourceStart: c.start,
      sourceEnd: c.end,
      timelineStart: t,
      timelineEnd: t + dur,
      zoom: c.zoom || 1,
      isBroll: c.isBroll,
    };
    t += dur;
    return row;
  });
}

/**
 * Convert a rough-cut TIMELINE second into SOURCE seconds on the owning clip.
 * sourceT = clip.sourceStart + (timelineT - clip.timelineStart)
 */
export function toSourceTime(
  plan: ValidatedEditPlan,
  timelineT: number,
  clipId?: string
): { sourceId: string; sourceT: number; clipId: string } | null {
  const map = buildTimelineMap(plan);
  const hit = clipId
    ? map.find((m) => m.clipId === clipId)
    : map.find((m) => timelineT >= m.timelineStart - 0.05 && timelineT < m.timelineEnd + 0.05) ||
      map.find((m) => timelineT >= m.timelineStart - 0.05 && timelineT <= m.timelineEnd + 0.15);
  if (!hit) return null;
  const offset = Math.max(0, timelineT - hit.timelineStart);
  const sourceT = Math.min(hit.sourceEnd, hit.sourceStart + offset);
  return { sourceId: hit.sourceId, sourceT, clipId: hit.clipId };
}

/**
 * Ensure critic issue parameters are SOURCE seconds.
 * Converts any timeline-ish values using the timeline map.
 */
export function ensureSourceParams(
  plan: ValidatedEditPlan,
  issue: CriticIssue
): CriticIssue {
  const params = { ...(issue.parameters || {}) };
  const clip =
    (params.clipId && plan.sequence.find((c) => c.id === params.clipId)) ||
    resolveClipForIssue(plan, issue);
  const clipId = params.clipId || clip?.id;

  const convertIfTimeline = (val: number | undefined, label: string): number | undefined => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return val;
    // Heuristic: if value falls inside the rough-cut timeline span and outside
    // the owning clip's source range, treat it as timeline and convert.
    if (!clip) {
      const mapped = toSourceTime(plan, val, clipId);
      return mapped ? mapped.sourceT : val;
    }
    const map = buildTimelineMap(plan);
    const totalTl = map.length ? map[map.length - 1].timelineEnd : 0;
    const inSourceRange = val >= clip.start - 0.5 && val <= clip.end + 0.5;
    const inTimelineRange = val >= 0 && val <= totalTl + 0.5;
    if (!inSourceRange && inTimelineRange) {
      const mapped = toSourceTime(plan, val, clipId);
      if (mapped) {
        console.log(
          `[TIME] ${label} timeline ${val.toFixed(2)} → source ${mapped.sourceT.toFixed(2)} on ${mapped.clipId}`
        );
        return mapped.sourceT;
      }
    }
    return val;
  };

  if (typeof params.sourceStart === 'number') {
    params.sourceStart = convertIfTimeline(params.sourceStart, 'sourceStart');
    params.newStart = params.sourceStart;
  } else if (typeof params.newStart === 'number') {
    params.newStart = convertIfTimeline(params.newStart, 'newStart');
    params.sourceStart = params.newStart;
  }
  if (typeof params.sourceEnd === 'number') {
    params.sourceEnd = convertIfTimeline(params.sourceEnd, 'sourceEnd');
    params.newEnd = params.sourceEnd;
  } else if (typeof params.newEnd === 'number') {
    params.newEnd = convertIfTimeline(params.newEnd, 'newEnd');
    params.sourceEnd = params.newEnd;
  }
  if (typeof params.removeStart === 'number') {
    params.removeStart = convertIfTimeline(params.removeStart, 'removeStart');
  }
  if (typeof params.removeEnd === 'number') {
    params.removeEnd = convertIfTimeline(params.removeEnd, 'removeEnd');
  }
  if (clipId && !params.clipId) params.clipId = clipId;

  return { ...issue, parameters: Object.keys(params).length ? params : undefined };
}

function looksMidSentence(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length < 12) return false;
  if (/[.!?…]["']?\s*$/.test(t)) return false;
  // Ends with hanging conjunction / incomplete clause
  if (/\b(and|but|because|so|when|if|that|the|a|an|to|of|with)\s*$/i.test(t)) return true;
  // No terminal punctuation in last 40 chars
  const tail = t.slice(-40);
  return !/[.!?…]/.test(tail);
}

function normalizeIssue(raw: any, fallbackTs = '00:00.0'): CriticIssue {
  const actionRaw = String(raw.action || 'none') as CriticEditAction;
  let action = VALID_ACTIONS.includes(actionRaw) ? actionRaw : 'none';
  const params: CriticIssueParameters = {};
  const p = raw.parameters || {};
  if (p.clipId != null) params.clipId = String(p.clipId);
  // Canonical source coords; accept sourceStart/sourceEnd or legacy newStart/newEnd
  if (typeof p.sourceStart === 'number') params.sourceStart = p.sourceStart;
  if (typeof p.sourceEnd === 'number') params.sourceEnd = p.sourceEnd;
  if (typeof p.newStart === 'number') params.newStart = p.newStart;
  if (typeof p.newEnd === 'number') params.newEnd = p.newEnd;
  if (params.sourceStart == null && typeof params.newStart === 'number') {
    params.sourceStart = params.newStart;
  }
  if (params.sourceEnd == null && typeof params.newEnd === 'number') {
    params.sourceEnd = params.newEnd;
  }
  if (params.newStart == null && typeof params.sourceStart === 'number') {
    params.newStart = params.sourceStart;
  }
  if (params.newEnd == null && typeof params.sourceEnd === 'number') {
    params.newEnd = params.sourceEnd;
  }
  if (typeof p.removeStart === 'number') params.removeStart = p.removeStart;
  if (typeof p.removeEnd === 'number') params.removeEnd = p.removeEnd;
  if (typeof p.zoom === 'number') params.zoom = p.zoom;
  if (Array.isArray(p.zoomValues)) {
    params.zoomValues = p.zoomValues.map(Number).filter((n: number) => Number.isFinite(n));
  }
  const start =
    typeof raw.start === 'number'
      ? raw.start
      : parseTimestampToSeconds(raw.timestamp || fallbackTs);
  const end = typeof raw.end === 'number' ? raw.end : start + 0.5;
  const recommendation =
    String(raw.recommendation || raw.reason || '') ||
    (action !== 'none' ? `${action} ${JSON.stringify(params)}` : '');

  const textCorpus = `${raw.problem || ''} ${raw.reason || ''} ${raw.seenHeard || ''} ${recommendation}`.toLowerCase();
  const isTruncation = /truncat|cut(?:s|ting)? (?:off|into)|mid[- ]?(?:sentence|thought|word)|incomplete thought|incomplete word|abrupt(?:ly)?/i.test(textCorpus);
  if (isTruncation && (action === 'trim_clip' || action === 'none')) {
    action = 'extend_clip';
  }

  // Parse explicit "extending ... to source X.Xs" or "to source X.Xs" into params
  const extendMatch = String(recommendation || raw.problem || '').match(
    /(?:extend(?:ing)?(?:\s+clip\s+\w+)?(?:\s+to)?|to)\s*(?:source\s*)?(\d+(?:\.\d+)?)\s*s?/i
  );
  if (extendMatch) {
    const targetVal = parseFloat(extendMatch[1]);
    if (Number.isFinite(targetVal) && targetVal > 0) {
      params.newEnd = targetVal;
      params.sourceEnd = targetVal;
    }
  }

  // Tail black: mark action only — NEVER write timeline `start` into source params.
  // Conversion to source happens later via ensureSourceParams(plan, issue).
  const isTailBlack = /black (?:frame|screen)|blank (?:frame|black)|pure black|dead silence at (?:the )?end|ends? on .*black/i.test(textCorpus);
  if (isTailBlack && (action === 'none' || action === 'trim_clip')) {
    action = 'trim_clip';
  }

  return {
    severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
    timestamp: String(raw.timestamp || formatTimelineTs(start)),
    start,
    end,
    category: isTailBlack ? 'ending' : (raw.category || 'professionalism'),
    problem: String(raw.problem || ''),
    seenHeard: raw.seenHeard != null ? String(raw.seenHeard) : undefined,
    reason: raw.reason != null ? String(raw.reason) : undefined,
    recommendation,
    action,
    parameters: Object.keys(params).length ? params : undefined,
  };
}

/** Deterministic critic heuristics — no "trim long hook", no "add punch-in spam" */
export function heuristicCritique(
  plan: ValidatedEditPlan,
  brief: DirectorCreativeBrief,
  intel?: FootageIntelligence[]
): CriticReport {
  const issues: CriticIssue[] = [];
  const seq = plan.sequence;
  const map = buildTimelineMap(plan);
  const pal = zoomPalette(plan.style);

  if (!seq.length) {
    return {
      issues: [
        {
          severity: 'high',
          timestamp: '00:00.0',
          start: 0,
          end: 0.5,
          category: 'story',
          problem: 'Empty sequence',
          recommendation: 'Add at least a hook and one context clip',
          action: 'none',
        },
      ],
      scores: {
        story_score: 1,
        pacing_score: 1,
        visual_continuity_score: 1,
        audio_score: 5,
        transition_score: 5,
        caption_score: 5,
        professionalism_score: 1,
        overall: 2,
      },
      summary: 'No clips to evaluate',
      approve: false,
    };
  }

  if (seq[0].role !== 'hook' && brief.editPolicy !== 'directed') {
    issues.push({
      severity: 'high',
      timestamp: '00:00.0',
      start: 0,
      end: map[0]?.timelineEnd || 1,
      category: 'hook',
      problem: 'Opening is not marked as a hook',
      seenHeard: 'First clip role is not hook',
      reason: 'Cold open should start with the strongest complete statement',
      recommendation: `Move hook from ${brief.openingHook.sourceId} to position 0`,
      action: 'none',
      parameters: { clipId: seq[0].id },
    });
  }

  // Hook completeness: mid-sentence truncation (never flag "hook too long")
  const hookClip = seq.find((c) => c.role === 'hook') || seq[0];
  const hookMap = map.find((m) => m.clipId === hookClip.id) || map[0];
  const hookIntel = intel?.find((f) => f.sourceId === hookClip.sourceId);
  const hookText =
    (hookIntel?.segments || [])
      .filter((s) => s.end > hookClip.start && s.start < hookClip.end)
      .map((s) => s.transcript)
      .filter(Boolean)
      .join(' ') ||
    (hookIntel?.fullTranscript || '').slice(0, 200);
  if (looksMidSentence(hookText)) {
    const suggestedEnd = Math.min(
      hookIntel?.sourceDuration || hookClip.end + 2,
      Math.max(hookClip.end + 0.8, brief.openingHook.end || hookClip.end + 1.5)
    );
    issues.push({
      severity: 'high',
      timestamp: formatTimelineTs(hookMap.timelineEnd - 0.3),
      start: Math.max(0, hookMap.timelineEnd - 1),
      end: hookMap.timelineEnd,
      category: 'hook',
      problem: 'The hook cuts off before the speaker completes the thought.',
      seenHeard: `Speech near hook out-point: "${hookText.slice(-80)}"`,
      reason: 'Preserve the complete statement and end at a natural sentence boundary.',
      recommendation: `extend_clip ${hookClip.id} newEnd≈${suggestedEnd.toFixed(1)}`,
      action: 'extend_clip',
      parameters: { clipId: hookClip.id, newEnd: suggestedEnd },
    });
  }

  // Zoom consistency
  const aroll = map.filter((m) => !m.isBroll);
  for (let i = 1; i < aroll.length; i++) {
    const a = aroll[i - 1].zoom;
    const b = aroll[i].zoom;
    if (Math.abs(a - b) > 0.06) {
      issues.push({
        severity: 'medium',
        timestamp: formatTimelineTs(aroll[i].timelineStart),
        start: aroll[i].timelineStart,
        end: aroll[i].timelineEnd,
        category: 'zoom_consistency',
        problem: `Adjacent clips use inconsistent punch-in magnitudes (${a.toFixed(2)}x → ${b.toFixed(2)}x).`,
        seenHeard: `Scale jump between ${aroll[i - 1].clipId} and ${aroll[i].clipId}`,
        reason: `Style ${plan.style}: prefer base ${pal.base}x and subtle ${pal.subtle[0]}–${pal.subtle[1]}x`,
        recommendation: `normalize_zoom to [${pal.base}, ${pal.subtle[0]}]`,
        action: 'normalize_zoom',
        parameters: {
          clipId: aroll[i].clipId,
          zoomValues: [pal.base, pal.subtle[0]],
        },
      });
      break;
    }
  }
  for (const m of aroll) {
    if (m.zoom > pal.max + 0.001) {
      issues.push({
        severity: 'medium',
        timestamp: formatTimelineTs(m.timelineStart),
        start: m.timelineStart,
        end: m.timelineEnd,
        category: 'zoom_consistency',
        problem: `Punch-in ${m.zoom.toFixed(2)}x exceeds style max ${pal.max}x`,
        seenHeard: `Clip ${m.clipId} zoom too strong`,
        reason: 'Use subtle emphasis rather than abrupt scale changes',
        recommendation: `set_zoom ${m.clipId} → ${pal.subtle[0]}`,
        action: 'set_zoom',
        parameters: { clipId: m.clipId, zoom: pal.subtle[0] },
      });
    }
  }

  // Ending completeness
  const lastAroll = [...seq].reverse().find((c) => !c.isBroll);
  if (lastAroll) {
    const lastMap = map.find((m) => m.clipId === lastAroll.id)!;
    const lastIntel = intel?.find((f) => f.sourceId === lastAroll.sourceId);
    const lastText =
      (lastIntel?.segments || [])
        .filter((s) => s.end > lastAroll.start && s.start < lastAroll.end)
        .map((s) => s.transcript)
        .filter(Boolean)
        .join(' ') || '';
    if (looksMidSentence(lastText)) {
      const newEnd = Math.min(
        lastIntel?.sourceDuration || lastAroll.end + 1.5,
        lastAroll.end + 2
      );
      issues.push({
        severity: 'medium',
        timestamp: formatTimelineTs(lastMap.timelineEnd - 0.2),
        start: Math.max(0, lastMap.timelineEnd - 1),
        end: lastMap.timelineEnd,
        category: 'ending',
        problem: 'Ending cuts mid-sentence.',
        seenHeard: `Last speech: "${lastText.slice(-80)}"`,
        reason: 'Finish the thought then fade out',
        recommendation: `complete_ending newEnd≈${newEnd.toFixed(1)}`,
        action: 'complete_ending',
        parameters: { clipId: lastAroll.id, newEnd },
      });
    }
  }

  const fancy = countFancyTransitions(plan);
  if (fancy > 0) {
    issues.push({
      severity: 'medium',
      timestamp: '00:00.0',
      start: 0,
      end: 1,
      category: 'transition',
      problem: `${fancy} non-hard-cut transition(s) on talking-head joins`,
      reason: 'Prefer hard_cut between scenes',
      recommendation: 'hard_cut all A-roll joins',
      action: 'hard_cut',
    });
  }

  issues.push(...flashFrameIssues(plan));
  issues.push(...directedSequenceIssues(plan, brief));

  const high = issues.filter((i) => i.severity === 'high').length;
  const med = issues.filter((i) => i.severity === 'medium').length;
  const scoresBase = {
    story_score: clampScore(9 - high * 2 - (seq[0].role !== 'hook' ? 1 : 0)),
    pacing_score: clampScore(8.5 - med * 0.3),
    visual_continuity_score: clampScore(8.5 - med * 0.5),
    audio_score: clampScore(plan.audioStrategy.duckUnderSpeech ? 8 : 6),
    transition_score: clampScore(9 - fancy * 1.5),
    caption_score: clampScore(plan.captionStrategy.enabled ? 8 : 6),
    professionalism_score: clampScore(8.5 - high * 1.5 - med * 0.4),
  };
  const scores: QualityScores = { ...scoresBase, overall: overallFrom(scoresBase) };

  return {
    issues,
    scores,
    summary:
      high === 0
        ? 'Solid rough cut with minor polish opportunities'
        : 'Rough cut needs targeted revision before final',
    approve: high === 0 && scores.overall >= 7,
  };
}

async function critiqueFromRenderedVideo(
  ai: AiClient,
  roughPath: string,
  plan: ValidatedEditPlan,
  brief: DirectorCreativeBrief,
  timelineTranscript: string
): Promise<CriticReport | null> {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const mime = mimeForVideoPath(roughPath);
    const uploaded = await uploadVideoForGemini(ai, roughPath, mime, 'rough-cut');
    cleanup = uploaded.cleanup;

    const timeline = buildTimelineMap(plan);
    const pal = zoomPalette(plan.style);

    const prompt = `You are TakeOne's AI Editorial Critic watching the ACTUAL RENDERED ROUGH CUT.

Your job: return ACTIONABLE edit operations with timestamps — not vague advice.

${policyPromptBlock(brief.editPolicy || 'creative_recut', brief.intendedBeats || [])}

FORBIDDEN generic feedback (do NOT return these):
- "improve pacing" / "add more B-roll" / "improve transitions" / "make the hook stronger" / "zooms feel inconsistent"
Instead name the exact problem, what you SEE/HEAR, and a structured action.

REQUIRED checks:
1) HOOK COMPLETENESS — Does the opening finish the thought? Flag sentence truncation, thought truncation, abrupt speech cutoff, visual cutoff, unnatural hook ending.
   CRITICAL: If a sentence or thought is cut off mid-sentence (e.g. at 1.5s), you MUST set "action": "extend_clip". NEVER use "trim_clip" for sentence or thought truncation!
   In "parameters", "newEnd" MUST be the TARGET SOURCE SECONDS where the complete statement ends (e.g. 5.4s). NEVER set newEnd to the truncated cutoff time (1.5s) — setting newEnd to the cut point collapses the statement into a fragment!
2) ZOOM SYSTEM — Style ${plan.style}: base ${pal.base}x, subtle ${pal.subtle[0]}–${pal.subtle[1]}x, max ${pal.max}x. Flag excessive punch-ins, abrupt zoom changes, consecutive unrelated magnitudes, unnecessary punch-ins. Prefer normalize_zoom / set_zoom. Do NOT recommend more punch-ins.
3) ENDING — Does the last line finish? Flag mid-sentence end → complete_ending.
4) TAIL BLACK FRAMES / SILENCE — If the rough cut ends on blank black frames or dead silence, set category="ending", action="trim_clip" on the final clip with parameters.newEnd = the timestamp where content actually finishes.
5) Prefer HARD CUTS. Do NOT recommend more transitions, B-roll, animations, or effects.
6) INTENDED SEQUENCE — Does the final video still follow the intended narrative beats? Example Expected: Hook → Problem → Product → Benefit → CTA vs Actual: Hook → Benefit → Hook fragment → CTA. That is HIGH severity category=story action=none. Do not "fix" a sequence break by dropping a required beat.
7) FLASH FRAMES — A clip under ~0.5s is a flash, not a keep. To remove it, use trim_clip with parameters.removeStart/removeEnd = the BAD source window, and keep the surrounding usable footage. NEVER set newStart/newEnd to a 0.3s window (that collapses the entire clip into the flash).

trim_clip parameter rules:
- removeStart/removeEnd = excise this source range; keep the rest of the clip (≥0.8s).
- newStart/newEnd = surviving keep range; must remain ≥0.8s. Heads/tails only. NEVER use trim_clip for mid-sentence speech truncation (use extend_clip instead).

Timeline map (clipId + rough-cut times + SOURCE in/out). parameters.newStart/newEnd/removeStart/removeEnd are SOURCE seconds on that clip's sourceId:
${JSON.stringify(timeline).slice(0, 6000)}

Intended hook: ${JSON.stringify(brief.openingHook)}
Intended beats: ${JSON.stringify(brief.intendedBeats || [])}
Style: ${plan.style}. Target: ${plan.targetDuration}s.
Transcript approx:
"""${timelineTranscript.slice(0, 2500)}"""

Return JSON only:
{
  "watchedVideo": true,
  "issues": [
    {
      "severity": "high|medium|low",
      "timestamp": "00:04.8",
      "start": 4.8,
      "end": 7.0,
      "category": "hook|zoom_consistency|ending|story|pacing|visual_continuity|audio|transition|caption|professionalism|social_effectiveness",
      "problem": "The hook cuts off before the speaker completes the thought.",
      "seenHeard": "Speaker is mid-sentence at the cut",
      "reason": "Preserve the complete statement at a natural boundary.",
      "action": "extend_clip|trim_clip|set_zoom|normalize_zoom|hard_cut|complete_ending|none",
      "parameters": { "clipId": "c0", "newEnd": 8.6, "removeStart": 0.5, "removeEnd": 0.8, "zoom": 1.06, "zoomValues": [1.0, 1.06] },
      "recommendation": "00:04.8: extend clip c0 to source 8.6s"
    }
  ],
  "scores": {
    "story_score": 0,
    "pacing_score": 0,
    "visual_continuity_score": 0,
    "audio_score": 0,
    "transition_score": 0,
    "caption_score": 0,
    "professionalism_score": 0
  },
  "summary": "",
  "approve": false
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: {
        parts: [videoFilePart(uploaded.uri, uploaded.mimeType), { text: prompt }],
      },
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(response.text || '{}');
    const issues: CriticIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((i: any) => normalizeIssue(i))
      : [];

    const s = parsed.scores || {};
    const scoresBase = {
      story_score: clampScore(s.story_score, 6),
      pacing_score: clampScore(s.pacing_score, 6),
      visual_continuity_score: clampScore(s.visual_continuity_score, 6),
      audio_score: clampScore(s.audio_score, 6),
      transition_score: clampScore(s.transition_score, 6),
      caption_score: clampScore(s.caption_score, 6),
      professionalism_score: clampScore(s.professionalism_score, 6),
    };
    const scores: QualityScores = { ...scoresBase, overall: overallFrom(scoresBase) };
    const high = issues.filter((i) => i.severity === 'high').length;

    return {
      issues,
      scores,
      summary: String(parsed.summary || 'Critiqued from rendered rough cut'),
      approve: Boolean(parsed.approve) && high === 0 && scores.overall >= 7,
    };
  } catch (err) {
    console.warn('Video critic failed:', (err as Error).message);
    return null;
  } finally {
    if (cleanup) await cleanup();
  }
}

export function criticPassStats(report: CriticReport): {
  issueCount: number;
  highSeverity: number;
  overall: number;
} {
  return {
    issueCount: report.issues.length,
    highSeverity: report.issues.filter((i) => i.severity === 'high').length,
    overall: report.scores.overall,
  };
}

export async function runCritic(
  ai: AiClient,
  opts: {
    plan: ValidatedEditPlan;
    brief: DirectorCreativeBrief;
    footageIntel: FootageIntelligence[];
    timelineTranscript?: string;
    roughCutPath?: string | null;
  }
): Promise<CriticReport> {
  const fallback = heuristicCritique(opts.plan, opts.brief, opts.footageIntel);
  const transcript = opts.timelineTranscript || '';

  if (opts.roughCutPath) {
    const fromVideo = await critiqueFromRenderedVideo(
      ai,
      opts.roughCutPath,
      opts.plan,
      opts.brief,
      transcript
    );
    if (fromVideo) {
      for (const h of fallback.issues.filter((i) => i.severity === 'high')) {
        if (
          !fromVideo.issues.some(
            (i) => i.category === h.category && i.action === h.action && i.problem.slice(0, 40) === h.problem.slice(0, 40)
          )
        ) {
          fromVideo.issues.push(h);
        }
      }
      const high = fromVideo.issues.filter((i) => i.severity === 'high').length;
      if (fromVideo.issues.some((i) => i.category === 'story' && i.severity === 'high')) {
        fromVideo.scores.story_score = Math.min(fromVideo.scores.story_score, 3);
        fromVideo.scores.overall = overallFrom(fromVideo.scores);
      }
      fromVideo.approve = high === 0 && fromVideo.scores.overall >= 7;
      fromVideo.summary = `[watched rough cut] ${fromVideo.summary}`;
      return fromVideo;
    }
  }

  try {
    const timeline = buildTimelineMap(opts.plan);
    const prompt = `You are TakeOne's Critic (EDL-only — no rendered video). Return ACTIONABLE issues only.
${policyPromptBlock(opts.brief.editPolicy || 'creative_recut', opts.brief.intendedBeats || [])}
FORBIDDEN: vague "improve pacing/B-roll/transitions". Prefer hard cuts. Prefer extend_clip for incomplete hooks, never shorten a strong complete hook.
Directed sequence check: if clips no longer follow intended beats, HIGH severity story / action=none.
trim_clip: removeStart/removeEnd = bad window to excise. newStart/newEnd = surviving keep ≥0.8s. Never collapse a clip to a 0.3s flash.
Timeline: ${JSON.stringify(timeline).slice(0, 5000)}
Hook: ${JSON.stringify(opts.brief.openingHook)}
Intended beats: ${JSON.stringify(opts.brief.intendedBeats || [])}
Transcript: """${transcript.slice(0, 2500)}"""
Return JSON issues with action/parameters/start/end/seenHeard as in the video critic schema.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{}');
    const issues: CriticIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((i: any) => normalizeIssue(i))
      : fallback.issues;

    for (const h of fallback.issues.filter((i) => i.severity === 'high')) {
      if (!issues.some((i) => i.problem === h.problem)) issues.push(h);
    }

    const s = parsed.scores || {};
    const scoresBase = {
      story_score: clampScore(s.story_score, fallback.scores.story_score),
      pacing_score: clampScore(s.pacing_score, fallback.scores.pacing_score),
      visual_continuity_score: clampScore(
        s.visual_continuity_score,
        fallback.scores.visual_continuity_score
      ),
      audio_score: clampScore(s.audio_score, fallback.scores.audio_score),
      transition_score: clampScore(s.transition_score, fallback.scores.transition_score),
      caption_score: clampScore(s.caption_score, fallback.scores.caption_score),
      professionalism_score: clampScore(
        s.professionalism_score,
        fallback.scores.professionalism_score
      ),
    };
    const scores: QualityScores = { ...scoresBase, overall: overallFrom(scoresBase) };
    const high = issues.filter((i) => i.severity === 'high').length;
    return {
      issues,
      scores,
      summary: `[edl-only] ${String(parsed.summary || fallback.summary)}`,
      approve: Boolean(parsed.approve) && high === 0 && scores.overall >= 7,
    };
  } catch (err) {
    console.warn('Critic Gemini failed, heuristic:', (err as Error).message);
    return fallback;
  }
}

/** Resolve which plan clip an issue targets */
export function resolveClipForIssue(
  plan: ValidatedEditPlan,
  issue: CriticIssue
): PlannedClip | null {
  if (issue.parameters?.clipId) {
    const byId = plan.sequence.find((c) => c.id === issue.parameters!.clipId);
    if (byId) return byId;
  }
  const map = buildTimelineMap(plan);
  const t = issue.start ?? parseTimestampToSeconds(issue.timestamp);
  const hit = map.find((m) => t >= m.timelineStart - 0.05 && t < m.timelineEnd + 0.05);
  if (hit) return plan.sequence.find((c) => c.id === hit.clipId) || null;
  if (issue.action === 'complete_ending') {
    return [...plan.sequence].reverse().find((c) => !c.isBroll) || null;
  }
  return plan.sequence[0] || null;
}
