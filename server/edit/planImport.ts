/**
 * Plan an edit for footage the creator shot elsewhere (Import flow).
 *
 * Input: what the video is for, what the creator wants done, the looks they picked, and each
 * clip's transcript. Output: a title, a music mood and, per clip, an edit recipe — b-roll /
 * overlay / meme inserts with image prompts, text pops and punch-ins — anchored to words the
 * creator actually said.
 *
 * Gemini proposes; the same guarantees as the script planner make it safe: anchors are repaired
 * to verbatim spoken phrases and any picked look that is still missing is placed
 * deterministically, so the plan is usable even if Gemini fails.
 */
import type { ProductionPrefs, SceneRecipe } from '../../src/types/director';
import { normalizeSceneRecipe, repairPlanAnchors } from '../script/productionPlan';
import { fillMissingLooks } from '../script/planGuarantees';

export type ImportClip = {
  sceneId: string;
  title: string;
  durationSeconds: number;
  transcript: string;
};

export type PlanImportInput = {
  goal: string;
  request: string;
  prefs: ProductionPrefs;
  clips: ImportClip[];
  language?: string;
};

export type PlanImportResult = {
  title: string;
  logline: string;
  musicMood: string;
  summary: string;
  scenes: Array<{ sceneId: string; title: string; recipe: SceneRecipe }>;
  model: string;
};

type Ai = { models: { generateContent: (req: any) => Promise<{ text?: string }> } };

const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'];
const MUSIC_MOODS = ['Warm Acoustic', 'Lo-fi', 'Upbeat Pop', 'Cinematic', 'Corporate', 'Chill Electronic'];

function looksBrief(prefs: ProductionPrefs): string {
  const l = new Set(prefs.looks);
  const out: string[] = [];
  if (l.has('broll')) out.push('B-ROLL: full-screen AI pictures (kind "broll_image", layout "full"), about one every 8–10 seconds of speech.');
  if (l.has('overlays')) out.push('OVERLAYS: AI pictures beside the speaker (kind "broll_image", layout "pip"), at least one.');
  if (l.has('memes')) out.push('MEMES: at least one reaction image (kind "meme") on a funny or relatable line.');
  if (l.has('text_pops')) out.push('TEXT POPS: short 1–4 word captions (kind "text_pop", `text`) on the key claims.');
  return out.join('\n') || 'No extra visuals were requested — punch-ins only, unless the request asks for more.';
}

function buildPrompt(input: PlanImportInput): string {
  const clips = input.clips
    .map(
      (c, i) =>
        `CLIP ${i + 1} (sceneId: ${c.sceneId}, ~${Math.round(c.durationSeconds)}s, file "${c.title}"):\n${
          c.transcript.trim() || '(no speech — visual footage)'
        }`
    )
    .join('\n\n');
  return `You are TakeOne's AI editor. The creator filmed this footage themselves and wants it edited into a finished short video.

What the video is for: ${input.goal.trim() || '(not given — infer it from the transcript)'}
What the creator wants done: ${input.request.trim() || '(nothing specific — make it engaging)'}
Spoken language: ${input.language || 'detect from the transcript'}

Looks to add:
${looksBrief(input.prefs)}

Rules:
- Every insert and punch-in has an anchorPhrase of 3–8 words copied VERBATIM from that clip's transcript (same language and script). Never invent words that were not said.
- Every broll_image / meme insert has a concrete \`prompt\`: what the picture shows — subject, setting, light, style. Vertical framing. No text in the image, no logos, no real people's faces.
- Text pops: 1–4 words, uppercase, in the spoken language.
- Punch-ins (zoom 1.08–1.2) on the hook and the strongest claims, at most one every ~10 seconds.
- Follow the creator's request when it asks for specific visuals or moments.
- Write the title and logline in the spoken language.

Footage transcripts:
${clips}

Return JSON only:
{"title": "...", "logline": "one sentence", "musicMood": one of ${JSON.stringify(MUSIC_MOODS)}, "summary": "one sentence on what you planned",
 "scenes": [{"sceneId": "...", "title": "short scene title", "recipe": {"layout": "talking_head", "inserts": [{"anchorPhrase": "...", "kind": "broll_image|meme|text_pop", "layout": "full|pip", "prompt": "...", "text": "...", "durationSec": 2.5}], "punchIns": [{"anchorPhrase": "...", "zoom": 1.12}], "transitionOut": "cut"}}]}`;
}

function stripFence(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

export async function planImportEdit(ai: Ai | null, input: PlanImportInput): Promise<PlanImportResult> {
  let parsed: any = null;
  let model = 'deterministic';
  if (ai) {
    for (const m of MODELS) {
      try {
        const response = await ai.models.generateContent({
          model: m,
          contents: buildPrompt(input),
          config: { responseMimeType: 'application/json', temperature: 0.4 },
        });
        parsed = JSON.parse(stripFence(response.text || ''));
        if (parsed && typeof parsed === 'object') {
          model = m;
          break;
        }
      } catch (err: any) {
        console.warn(`[plan-import] ${m} failed:`, String(err?.message || err).slice(0, 200));
        parsed = null;
      }
    }
  }

  const byId = new Map<string, any>(
    (Array.isArray(parsed?.scenes) ? parsed.scenes : []).map((s: any) => [String(s?.sceneId || ''), s])
  );
  // Plan-shaped scenes so the anchor repair and look guarantees can read the spoken text.
  const planScenes = input.clips.map((c) => {
    const g = byId.get(c.sceneId);
    const recipe =
      normalizeSceneRecipe(g?.recipe) ||
      ({ layout: 'talking_head', inserts: [], punchIns: [], transitionOut: 'cut' } as SceneRecipe);
    return {
      id: c.sceneId,
      sceneNumber: 0,
      title: String(g?.title || c.title || 'Clip').slice(0, 80),
      filmedBy: 'user',
      mediaRole: 'capture',
      durationSeconds: Math.max(1, Math.round(c.durationSeconds)),
      dialogue: { required: Boolean(c.transcript.trim()), teleprompterText: c.transcript.trim() || null },
      recipe: { ...recipe, layout: 'talking_head' as const },
    };
  });

  let plan: { scenes: any[]; estimatedTotalSeconds: number } = {
    scenes: planScenes,
    estimatedTotalSeconds: input.clips.reduce((a, c) => a + c.durationSeconds, 0),
  };
  plan = repairPlanAnchors(plan);
  plan = repairPlanAnchors(fillMissingLooks(plan, input.prefs, input.goal || input.request));

  const mood = MUSIC_MOODS.includes(parsed?.musicMood) ? parsed.musicMood : 'Warm Acoustic';
  return {
    title: String(parsed?.title || '').trim().slice(0, 90) || input.clips[0]?.title || 'My video',
    logline: String(parsed?.logline || input.goal || '').trim().slice(0, 240),
    musicMood: mood,
    summary: String(parsed?.summary || '').trim().slice(0, 240),
    scenes: plan.scenes.map((s) => ({ sceneId: s.id, title: s.title, recipe: s.recipe as SceneRecipe })),
    model,
  };
}
