/**
 * Context-aware Production Plan generation helpers for /api/generate-script.
 * Classifies content type and builds visual-first or dialogue plans without
 * forcing every idea into talking-head teleprompter scenes.
 */
import { Type } from '@google/genai';
import {
  applyCaptureStrategy,
  coerceCaptureStrategy,
  inferCaptureStrategy,
  captureStrategyFromShotsPref,
  isUgcAdContent,
  isVisualFirstContent,
  explicitMultiShotRequest,
} from './captureStrategy';
import { defaultProductionPrefs } from '../../src/types/director';
import type { ProductionPrefs, SceneRecipe } from '../../src/types/director';
import {
  detectSpokenLanguageFromText,
  normalizeSpokenLanguage,
} from '../../src/utils/spokenLanguage';

export type ContentType =
  | 'ugc_ad'
  | 'talking_head'
  | 'educational'
  | 'tutorial'
  | 'workout'
  | 'cooking'
  | 'gardening'
  | 'diy_build'
  | 'woodworking'
  | 'product_demo'
  | 'travel'
  | 'transformation'
  | 'cinematic_montage'
  | 'interview'
  | 'commentary'
  | 'hybrid';

const CONTENT_TYPES: ContentType[] = [
  'ugc_ad',
  'talking_head',
  'educational',
  'tutorial',
  'workout',
  'cooking',
  'gardening',
  'diy_build',
  'woodworking',
  'product_demo',
  'travel',
  'transformation',
  'cinematic_montage',
  'interview',
  'commentary',
  'hybrid',
];

const EDIT_INTENTS = [
  'hook',
  'problem',
  'product',
  'benefit',
  'context',
  'demonstration',
  'explanation',
  'progression',
  'reaction',
  'transition',
  'payoff',
  'cta',
  'ending',
  'establishing',
  'broll',
];

const CONTENT_MODES = [
  'dialogue',
  'voiceover',
  'visual_only',
  'natural_audio',
  'text_overlay',
  'mixed',
];

export function parseTargetSeconds(durationStr: string, isLongForm: boolean): number {
  const d = (durationStr || '').toLowerCase();
  const minMatch = d.match(/(\d+)\s*min/);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;
  const secMatch = d.match(/(\d+)\s*sec/);
  if (secMatch) return parseInt(secMatch[1], 10);
  if (isLongForm) return 300;
  return 45;
}

/** Heuristic classify for fallbacks (Gemini does primary classify). */
export function inferContentType(idea: string): ContentType {
  const k = idea.toLowerCase();
  const strongUgc =
    /\b(ugc(\s+ad)?|testimonial|direct([ -]?to[ -]?camera)|to camera|product recommendation|app (ad|advert)|advertisement|sponsor(ed)? (ad|post))\b/.test(
      k
    );
  if (strongUgc) return 'ugc_ad';
  if (/\b(kettlebell|workout|exercise|hiit|gym|squat|deadlift|reps)\b/.test(k)) return 'workout';
  if (
    /\b(garden|tomato|plants?|seedling|soil|raised bed|jungle|succulent|monstera|fern)\b/.test(k) &&
    /\b(build|built|diy|wood|planter)\b/.test(k)
  )
    return 'diy_build';
  if (
    /\b(garden|tomato|plants?|seedling|watering|soil|jungle|succulent|monstera|fern|houseplant)\b/.test(
      k
    ) ||
    /\blove of plants\b/.test(k)
  )
    return 'gardening';
  if (/\b(wood|planter|raised bed|build|built|diy|assemble)\b/.test(k)) return 'diy_build';
  if (/\b(pour-?over|coffee|brew|espresso|recipe|cook|kitchen|bake)\b/.test(k)) {
    return /\b(cook|bake|recipe|meal)\b/.test(k) ? 'cooking' : 'tutorial';
  }
  if (/\b(rome|travel|visit|trip|destination|city guide)\b/.test(k)) return 'travel';
  if (/\b(before|after|transform|makeover|progress)\b/.test(k)) return 'transformation';
  if (/\b(ugc|selfie|talking.?head|my story|review)\b/.test(k)) return 'ugc_ad';
  if (/\b(explain|why|opinion|stopped|commentary|rant|thoughts)\b/.test(k)) return 'commentary';
  if (/\b(how to|tutorial|step.?by.?step|demo)\b/.test(k)) return 'tutorial';
  if (/\b(interview|q&a|conversation)\b/.test(k)) return 'interview';
  if (/\b(sleep|matters|fact|learn|educational)\b/.test(k)) return 'educational';
  return 'hybrid';
}

/** Tone targets across genres — spoken beats should sound like a real person talking. */
export const HUMAN_VOICE_EXAMPLES = [
  "Okay, quick story — I almost quit this on day three.",
  "Here's the thing nobody tells you about learning this the hard way.",
  "I tested it for a week so you don't have to. Honest verdict: it's weirdly good.",
  "Stop scrolling — this one trick saved me two hours every single day.",
  "Wait, it gets better. Watch what happens when I flip it around.",
  "If you only remember one thing from this video, make it this.",
] as const;

export function buildHumanVoiceStyleBlock(): string {
  return `HUMAN VOICE (hard rule): write like a real creator talking to one friend on their phone. Contractions, short sentences, natural pauses. No corporate filler ("Today we're going to explore…", "Let's dive in…", "Without further ado…", "In this video…").

Tone examples across genres (match this energy, do not copy verbatim):
${HUMAN_VOICE_EXAMPLES.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Adapt voice to the genre: explainers are clear and curious, vlogs are casual and personal, tutorials are calm and specific, comedy is dry and well-timed, reviews are honest and opinionated, motivational is direct and warm. When the creator films one continuous take, write the spoken script as ONE continuous monologue — each beat flows into the next without a reset.`;
}

function prefsSummary(prefs?: ProductionPrefs | null): string {
  if (!prefs) return '(none — choose sensible defaults for the genre)';
  return JSON.stringify(prefs);
}

function shotBudgetLine(prefs?: ProductionPrefs | null, isLongForm = false): string {
  switch (prefs?.shots) {
    case 'one_take':
      return 'SHOT BUDGET (one_take): exactly 1 capture setup — one continuous monologue to camera. You may split the script into story beats (scenes) but they will be merged into one recording; write them so they flow without a reset. Variety comes from edit recipes (punch-ins, inserts, text pops), NOT extra camera setups.';
    case 'few':
      return 'SHOT BUDGET (few): 2–3 capture setups total. Each scene = one phone recording. Keep setups simple (same room / one location change at most).';
    case 'cinematic':
      return 'SHOT BUDGET (cinematic): up to 6 capture setups with varied angles / locations. Each scene = one phone recording. Keep every setup shootable on a phone.';
    default:
      return isLongForm
        ? 'SHOT BUDGET: 2–4 capture setups; each scene = one phone recording.'
        : 'SHOT BUDGET: default to 1 continuous take (short-form). Only add setups if the idea clearly needs different locations.';
  }
}

function looksLine(prefs?: ProductionPrefs | null): string {
  const looks = prefs?.looks || [];
  if (!looks.length) return '';
  const parts: string[] = [];
  const visualLooks = ['broll', 'overlays', 'memes'].filter((l) => looks.includes(l as any));
  if (visualLooks.length) {
    parts.push(
      'AI VISUALS: TakeOne generates every image you plan. Each recipe.insert of kind "broll_image", "broll_video" or "meme" MUST have a concrete `prompt` (what the picture shows: subject, setting, style) and an anchorPhrase = 3–8 words copied verbatim from that scene\'s spoken dialogue (never the caption or on-screen text). Inserts without a prompt are dropped.'
    );
  }
  if (looks.includes('virtual_background')) {
    parts.push(
      'VIRTUAL BACKGROUND: at least one scene MUST set recipe.layout = "virtual_background" with recipe.background.prompt describing a vivid, on-topic background plate (the creator is keyed over it).'
    );
  }
  if (looks.includes('broll')) {
    parts.push(
      'B-ROLL: full-screen AI cutaway pictures — recipe.inserts of kind "broll_image" (or "broll_video") with layout "full". Roughly one every 6–10 seconds of speech.'
    );
  }
  if (looks.includes('overlays')) {
    parts.push(
      'OVERLAYS: AI pictures shown beside the speaker — recipe.inserts of kind "broll_image" with layout "pip", illustrating the exact thing being said. Roughly one every 8–12 seconds of speech, at least one per video.'
    );
  }
  if (looks.includes('memes')) {
    parts.push(
      'MEMES: include at least one recipe.insert of kind "meme" (prompt = what the meme/reaction image shows, optional short `text`) on a punchline or relatable moment.'
    );
  }
  if (looks.includes('text_pops')) {
    parts.push(
      'TEXT POPS: include recipe.inserts of kind "text_pop" with short punchy `text` (1–5 words) on the key claims.'
    );
  }
  if (looks.includes('talking_head') && parts.length === 0) {
    parts.push('LOOK: clean talking head with punch-ins on emphasis. No extra inserts needed.');
  }
  return parts.join('\n');
}

export function buildSystemInstruction(
  duration: string,
  isLongForm: boolean,
  prefs?: ProductionPrefs | null
): string {
  return `You are TakeOne's AI director for every kind of creator — explainers, vlogs, tutorials, comedy, reviews, motivational, product reviews, storytelling.
Thesis: the creator films simple phone takes; YOU design a shootable screenplay + edit recipe so the master cut looks professionally edited without a separate editor.

Produce a complete, shootable production plan for THIS idea — as if you studied the top-performing videos on the same topic (TikTok / Reels / Shorts / YouTube): hook, pacing, punch-ins, text pops, music energy, and when (and when NOT) to use B-roll / memes / overlays.

VIRAL STYLE ANALYSIS (required in creativeBrief.viralStyle):
- referenceLook: 1–2 sentences on how winning videos for this niche look/sound.
- effects: edit moves to bake in (e.g. "punch zoom on the claim", "zoom-snap into the reveal", "text pop on the key number"). Prefer in-camera + recipe effects (punch-ins, transitions, text pops) over stacking AI overlays.
- overlayPolicy: "none" | "selective" | "meme". Use "selective"/"meme" when the creator's looks include overlays / b-roll / memes; otherwise "none".
- musicEnergy: short mood for bed music${prefs && !prefs.music ? ' (creator turned music off — use "none")' : ''}.

Creator production prefs (honor them): ${prefsSummary(prefs)}

Speech: teleprompter in the SAME LANGUAGE as the idea. Set spokenLanguage (en, hi, es, …).

Format: ${isLongForm ? 'Long-form (3–60 min)' : 'Short-form vertical video (15–90s)'}. Target: ${duration}.

Per beat set:
- editZoom: 1.0–1.15 (punch on hook / key claim / CTA; 1.0 elsewhere)
- transition: cut | zoom-snap | crossfade | whip-pan
- onScreenText: short caption when useful (null otherwise)
- recipe: layout, background, inserts, punchIns, transitionOut (see schema). Anchor every insert/punch-in to an exact phrase the creator actually says.

${buildHumanVoiceStyleBlock()}

Output JSON matching the schema. Prefer editIntent values: hook, context, explanation, demonstration, payoff, cta.`;
}

function buildMediaPlanHardInstructions(
  briefHints?: Record<string, unknown> | null,
  idea?: string,
  prefs?: ProductionPrefs | null
): string {
  const hints = briefHints && typeof briefHints === 'object' ? briefHints : {};
  const looks = prefs?.looks || [];
  const hintsBlob = JSON.stringify(hints);
  const preferOverlays =
    hints.preferOverlays === true ||
    looks.includes('overlays') ||
    looks.includes('broll') ||
    looks.includes('memes');
  const wantGreenscreen =
    hints.greenscreen === true ||
    looks.includes('virtual_background') ||
    /\b(green\s*screen|virtual background|background (replace|swap))\b/i.test(
      `${idea || ''} ${hintsBlob}`
    );
  const wantCutaways =
    hints.preferOverlays === false &&
    /\b(cutaway|hard cut|b-?roll cut)\b/i.test(`${idea || ''} ${hintsBlob}`);
  const ideaWantsMedia =
    preferOverlays ||
    wantGreenscreen ||
    /\b(overlay|pip|picture.?in.?picture|insert|cutaway|ai (still|image|b-?roll)|green\s*screen|virtual background|background|b-?roll)\b/i.test(
      String(idea || '')
    );

  if (!ideaWantsMedia && !wantCutaways) {
    return `
MEDIA PLAN (default): mediaPlan.kind = "none" on nearly every beat. The look comes from recipe punch-ins, editZoom, transition, and onScreenText. Only emit overlay/meme media if one beat truly needs a card.`;
  }

  const lines: string[] = [
    '',
    'MEDIA INSTRUCTIONS (must follow — not soft context):',
    'Every scene MUST include mediaPlan.kind. Creator takes use kind "none". Express looks primarily through scene.recipe (layout / background / inserts anchored to spoken phrases).',
  ];

  if (wantGreenscreen) {
    lines.push(
      'Creator wants a VIRTUAL BACKGROUND / greenscreen: at least one scene MUST have recipe.layout = "virtual_background" with recipe.background.prompt describing the background plate (a scene with mediaPlan.kind = "greenscreen" also satisfies this).'
    );
  }
  if (preferOverlays || (ideaWantsMedia && !wantGreenscreen && !wantCutaways)) {
    lines.push(
      'Creator wants OVERLAYS / B-ROLL: add recipe.inserts (broll_image / broll_video / meme) with exact anchorPhrase, a concrete prompt, layout "full" or "pip". Do NOT use hard cutaways for these.'
    );
  }
  if (wantCutaways) {
    lines.push(
      'Creator wants hard CUTAWAYS: use mediaPlan.kind = "cutaway" with aiPrompt (or empty aiPrompt + upload slot). filmedBy "ai".'
    );
  }
  lines.push(
    'A beat with spoken lines is ALWAYS a creator take (mediaPlan.kind "none"). Put AI media in its OWN scene with no dialogue, parentBeatRef = the spoken beat, and timingHint = 2–6 words copied verbatim from that beat\'s dialogue. Its plainInstruction describes the visual (what the image/clip shows), never how the creator performs; its directorTip is empty.',
    'For a virtual background, prefer recipe.layout "virtual_background" on the spoken take itself over a separate greenscreen scene — never both.',
    'mediaPlan fields: kind (none|overlay|greenscreen|cutaway), parentBeatRef?, layout?, timingHint?, aiPrompt?.',
    'Greenscreen = kind "greenscreen" (normalizer maps to mediaRole overlay + overlayLayout greenscreen).'
  );
  return `\n${lines.join('\n')}\n`;
}

export function buildUserPrompt(opts: {
  idea: string;
  duration: string;
  style: string;
  aspectRatio: string;
  isLongForm: boolean;
  briefHints?: Record<string, unknown> | null;
  prefs?: ProductionPrefs | null;
}): string {
  const hints = opts.briefHints && typeof opts.briefHints === 'object' ? opts.briefHints : null;
  const softHints =
    hints && Object.keys(hints).length
      ? `\nCreator context (honor when relevant):\n${JSON.stringify(hints, null, 2)}\n`
      : '';
  const mediaHard = buildMediaPlanHardInstructions(hints, opts.idea, opts.prefs);
  const looks = looksLine(opts.prefs);

  return `Video idea: "${opts.idea}"
Target duration: ${opts.duration} (${opts.isLongForm ? 'Long-Form' : 'Short-Form'})
Style/Tone: ${opts.style}
Aspect Ratio: ${opts.aspectRatio}
Creator prefs: ${prefsSummary(opts.prefs)}
${softHints}${mediaHard}
${shotBudgetLine(opts.prefs, opts.isLongForm)}
${looks ? `\nLOOKS THE CREATOR PICKED (hard requirements):\n${looks}\n` : ''}
${buildHumanVoiceStyleBlock()}

Produce a full shootable plan:
1) Infer contentType + creativeBrief including viralStyle (referenceLook, effects[], overlayPolicy, musicEnergy). Choose the structure that fits the genre (hook → payoff for stories, claim → proof → takeaway for explainers, steps for tutorials, verdict for reviews).
2) Mentally reference how top videos for THIS topic hook, pace and sound, and encode that into editZoom / transition / onScreenText / recipe per beat.
3) Spoken beats: dialogue.required=true + teleprompter in the idea's language. Set spokenLanguage.
4) Visual beats: clear plainInstruction (phone height, light, what is in frame).
5) Respect the shot budget above. Do NOT invent extra camera setups to add variety — use recipe instead.
6) Per beat: editZoom (1.0–1.15), transition (cut|zoom-snap|crossfade|whip-pan), onScreenText nullable, recipe.

Match duration. The creator shoots simple takes; the master cut should look professionally edited from YOUR screenplay fields alone.`;
}

/** Pass 1 — free-form creative script (no schema, high temperature). */
export function buildCreativeScriptPrompt(opts: {
  idea: string;
  duration: string;
  style: string;
  isLongForm: boolean;
  prefs?: ProductionPrefs | null;
  spokenLanguage?: string;
  briefHints?: Record<string, unknown> | null;
}): { systemInstruction: string; prompt: string } {
  const targetSeconds = parseTargetSeconds(opts.duration, opts.isLongForm);
  const targetWords = Math.round(targetSeconds * 2.5);
  const hints = opts.briefHints && typeof opts.briefHints === 'object' ? opts.briefHints : null;
  const hintsBlock =
    hints && Object.keys(hints).length
      ? `\nCreator context (honor when relevant):\n${JSON.stringify(hints, null, 2)}\n`
      : '';
  const systemInstruction = `You are a top short-form scriptwriter who has studied thousands of viral videos. You write scripts that sound spoken, not written. You adapt to ANY genre — explainer, vlog, tutorial, comedy, review, motivational, storytelling, product review.`;
  const prompt = `Write the best ${opts.isLongForm ? 'long-form' : 'short-form'} video script for this idea, informed by how viral videos on this topic hook, pace and sound.

Idea: "${opts.idea}"
Duration: ${opts.duration} (~${targetWords} spoken words at a natural pace)
Style/Tone: ${opts.style}
Spoken language: ${opts.spokenLanguage || 'same language as the idea'}
Creator prefs: ${prefsSummary(opts.prefs)}
${hintsBlock}
${shotBudgetLine(opts.prefs, opts.isLongForm)}
${looksLine(opts.prefs) ? `\nLooks the creator wants (write moments that make these natural — a visual to show, a punchline to meme, a key claim to pop on screen):\n${looksLine(opts.prefs)}\n` : ''}
${buildHumanVoiceStyleBlock()}

Format your answer as plain text:
- A one-line TITLE.
- A one-line LOGLINE.
- The SCRIPT as spoken lines only, grouped into short paragraphs (one paragraph per story beat: hook, build, payoff, ending).
- After each paragraph, an optional bracketed [VISUAL/EDIT NOTE: ...] on a new line (what to show, where to punch in, where a text pop / b-roll / meme lands). Notes are not spoken.

Start with a hook that earns the next 3 seconds. No filler intro. Make it genuinely good — specific, surprising, human.`;
  return { systemInstruction, prompt };
}

/** Pass 2 — structure the creative script into the production-plan schema without rewriting speech. */
export function buildStructurePrompt(opts: {
  creativeScript: string;
  idea: string;
  duration: string;
  style: string;
  aspectRatio: string;
  isLongForm: boolean;
  briefHints?: Record<string, unknown> | null;
  prefs?: ProductionPrefs | null;
}): string {
  const base = buildUserPrompt(opts);
  return `${base}

=== APPROVED CREATIVE SCRIPT (from pass 1) ===
${opts.creativeScript}
=== END SCRIPT ===

STRUCTURING RULES:
- Split the approved script into scenes (beats) following the shot budget. DO NOT rewrite, paraphrase, reorder or drop any spoken words — copy them verbatim into dialogue.teleprompterText / teleprompterPrompt.
- Bracketed [VISUAL/EDIT NOTE] lines are NOT spoken: turn them into recipe.inserts / recipe.punchIns / onScreenText / plainInstruction.
- recipe.inserts[].anchorPhrase and recipe.punchIns[].anchorPhrase must be 3–8 words copied verbatim from that scene's spoken dialogue (the words the creator will actually say). Never put the on-screen caption, text-pop text or a title there — that goes in the text field.
- Fill recipe for every scene: layout, background (only for virtual_background), inserts, punchIns, transitionOut.
- Honor the creator prefs and looks above.`;
}

/** Repair prompt used when a normalized plan fails validateAgainstPrefs. */
export function buildRepairPrompt(opts: {
  previousJson: string;
  missing: string[];
  prefs?: ProductionPrefs | null;
  /** Include when the repair must restore spoken lines. */
  creativeScript?: string;
}): string {
  return `The production plan JSON below does not satisfy the creator's chosen production prefs.

Creator prefs: ${prefsSummary(opts.prefs)}

MISSING / VIOLATIONS:
${opts.missing.map((m) => `- ${m}`).join('\n')}

Return the FULL corrected plan JSON (same schema). Keep all spoken words, titles and structure unchanged — only add or fix the recipe / media fields needed to satisfy the violations. Anchor phrases must be 3–8 words copied verbatim from that scene's spoken dialogue (never caption text).

${looksLine(opts.prefs)}
${
  opts.creativeScript
    ? `\n=== APPROVED CREATIVE SCRIPT (copy spoken words verbatim from here) ===\n${opts.creativeScript}\n=== END SCRIPT ===\n`
    : ''
}
PREVIOUS PLAN JSON:
${opts.previousJson}`;
}

/**
 * Split a pass-1 script into `parts` contiguous chunks (by paragraph, balanced by words) so
 * long-form structuring can run in parallel. TITLE / LOGLINE header goes with every part;
 * bracketed [VISUAL/EDIT NOTE] paragraphs stay attached to the paragraph they follow.
 */
export function splitCreativeScript(script: string, parts: number): string[] {
  const paras = String(script || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const header: string[] = [];
  const body: string[] = [];
  for (const p of paras) {
    if (!body.length && /^\W*(title|logline)\b/i.test(p)) header.push(p);
    else if (/^\[/.test(p) && body.length) body[body.length - 1] += `\n${p}`;
    else body.push(p);
  }
  if (parts < 2 || body.length < parts * 2) return [script];
  const words = (p: string) => p.split(/\s+/).filter(Boolean).length;
  const total = body.reduce((a, p) => a + words(p), 0);
  const chunks: string[][] = [];
  let current: string[] = [];
  let acc = 0;
  body.forEach((p, i) => {
    current.push(p);
    acc += words(p);
    const remainingParas = body.length - i - 1;
    const remainingChunks = parts - chunks.length - 1;
    if (
      remainingChunks > 0 &&
      (acc >= (total * (chunks.length + 1)) / parts || remainingParas === remainingChunks)
    ) {
      chunks.push(current);
      current = [];
    }
  });
  if (current.length) chunks.push(current);
  const head = header.join('\n\n');
  return chunks.map((c) => [head, ...c].filter(Boolean).join('\n\n'));
}

/** Compact schema — enough for the app; not a novel of required nested fields. */
export const productionPlanSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    logline: { type: Type.STRING },
    videoFormat: { type: Type.STRING },
    aspectRatio: { type: Type.STRING },
    estimatedTotalSeconds: { type: Type.INTEGER },
    musicMood: { type: Type.STRING },
    spokenLanguage: { type: Type.STRING },
    creativeBrief: {
      type: Type.OBJECT,
      properties: {
        contentType: { type: Type.STRING },
        storyObjective: { type: Type.STRING },
        audience: { type: Type.STRING },
        tone: { type: Type.STRING },
        platform: { type: Type.STRING },
        targetDuration: { type: Type.NUMBER },
        captureStrategy: { type: Type.STRING },
        storytellingMode: { type: Type.STRING },
        editingStrategy: { type: Type.STRING },
        dialoguePriority: { type: Type.STRING },
        teleprompterRequired: { type: Type.BOOLEAN },
        visualPriority: { type: Type.STRING },
        voiceoverPossible: { type: Type.BOOLEAN },
        naturalAudioImportance: { type: Type.STRING },
        creatorPresence: { type: Type.STRING },
        narrativeStructure: { type: Type.STRING },
        pacing: { type: Type.STRING },
        spokenLanguage: { type: Type.STRING },
        viralStyle: {
          type: Type.OBJECT,
          properties: {
            referenceLook: { type: Type.STRING },
            effects: { type: Type.ARRAY, items: { type: Type.STRING } },
            overlayPolicy: { type: Type.STRING },
            musicEnergy: { type: Type.STRING },
          },
        },
      },
      required: ['contentType', 'storyObjective', 'captureStrategy'],
    },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sceneNumber: { type: Type.INTEGER },
          chapterTitle: { type: Type.STRING },
          title: { type: Type.STRING },
          purpose: { type: Type.STRING },
          contentMode: { type: Type.STRING },
          filmedBy: { type: Type.STRING },
          durationSeconds: { type: Type.INTEGER },
          plainInstruction: { type: Type.STRING },
          directorTip: { type: Type.STRING },
          teleprompterPrompt: { type: Type.STRING, nullable: true },
          visual: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING },
              camera: { type: Type.STRING },
              framing: { type: Type.STRING },
              movement: { type: Type.STRING },
              environment: { type: Type.STRING },
            },
          },
          dialogue: {
            type: Type.OBJECT,
            properties: {
              required: { type: Type.BOOLEAN },
              teleprompterText: { type: Type.STRING, nullable: true },
            },
          },
          voiceover: {
            type: Type.OBJECT,
            properties: {
              required: { type: Type.BOOLEAN },
              text: { type: Type.STRING, nullable: true },
            },
          },
          naturalAudio: { type: Type.STRING, nullable: true },
          onScreenText: { type: Type.STRING, nullable: true },
          editIntent: { type: Type.STRING },
          editZoom: { type: Type.NUMBER },
          transition: { type: Type.STRING },
          transitionDuration: { type: Type.NUMBER },
          directorCues: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING },
                label: { type: Type.STRING },
                holdMs: { type: Type.NUMBER },
              },
            },
          },
          delivery: {
            type: Type.OBJECT,
            properties: {
              speakingPace: { type: Type.STRING },
              pauseSec: { type: Type.NUMBER },
              emphasisPhrase: { type: Type.STRING },
              lookAtCamera: { type: Type.BOOLEAN },
              breathingPoint: { type: Type.BOOLEAN },
            },
          },
          recipe: {
            type: Type.OBJECT,
            properties: {
              layout: {
                type: Type.STRING,
                enum: ['talking_head', 'virtual_background', 'pip', 'split'],
              },
              background: {
                type: Type.OBJECT,
                nullable: true,
                properties: { prompt: { type: Type.STRING } },
              },
              inserts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    anchorPhrase: {
                      type: Type.STRING,
                      description: '3–8 words copied verbatim from this scene\'s spoken dialogue',
                    },
                    kind: {
                      type: Type.STRING,
                      enum: ['broll_image', 'broll_video', 'text_pop', 'meme'],
                    },
                    prompt: { type: Type.STRING, nullable: true },
                    text: { type: Type.STRING, nullable: true },
                    layout: { type: Type.STRING, enum: ['full', 'pip'] },
                    durationSec: { type: Type.NUMBER },
                  },
                  required: ['anchorPhrase', 'kind', 'layout', 'durationSec'],
                },
              },
              punchIns: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    anchorPhrase: {
                      type: Type.STRING,
                      description: '3–8 words copied verbatim from this scene\'s spoken dialogue',
                    },
                    zoom: { type: Type.NUMBER },
                  },
                  required: ['anchorPhrase', 'zoom'],
                },
              },
              transitionOut: {
                type: Type.STRING,
                enum: ['cut', 'zoom_snap', 'whip', 'crossfade'],
              },
            },
            required: ['layout', 'inserts', 'punchIns', 'transitionOut'],
          },
          mediaPlan: {
            type: Type.OBJECT,
            properties: {
              kind: { type: Type.STRING },
              parentBeatRef: { type: Type.STRING, nullable: true },
              layout: { type: Type.STRING, nullable: true },
              timingHint: { type: Type.STRING, nullable: true },
              aiPrompt: { type: Type.STRING, nullable: true },
            },
          },
        },
        required: [
          'sceneNumber',
          'title',
          'filmedBy',
          'durationSeconds',
          'plainInstruction',
          'directorTip',
          'editIntent',
        ],
      },
    },
  },
  required: ['title', 'logline', 'scenes', 'creativeBrief'],
};

const MEDIA_PLAN_KINDS = new Set(['none', 'overlay', 'greenscreen', 'cutaway']);
const OVERLAY_LAYOUTS = new Set(['full', 'pip_br', 'pip_bl', 'greenscreen']);

/** Map Gemini mediaPlan → Scene mediaRole / overlay / filmedBy fields. */
export function mapMediaPlanToSceneFields(mediaPlan: any): {
  filmedBy: 'user' | 'ai';
  mediaRole?: 'capture' | 'cutaway' | 'overlay';
  overlayLayout?: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
  overlayParentBeatRef?: string;
  includeInExport?: boolean;
  aiGenerationPrompt?: string;
  insertKind?: 'broll';
  /** Empty upload slot when kind needs media but no aiPrompt */
  userInsertUrlSlot?: boolean;
} {
  const rawKind = String(mediaPlan?.kind || 'none').toLowerCase().trim();
  const kind = MEDIA_PLAN_KINDS.has(rawKind) ? rawKind : 'none';

  if (kind === 'none') {
    return { filmedBy: 'user', mediaRole: 'capture' };
  }

  const aiPrompt = cleanTeleprompter(mediaPlan?.aiPrompt);
  const layoutRaw = String(mediaPlan?.layout || '').toLowerCase().trim();
  const parentBeatRef = mediaPlan?.parentBeatRef
    ? String(mediaPlan.parentBeatRef).trim()
    : undefined;

  if (kind === 'cutaway') {
    return {
      filmedBy: 'ai',
      mediaRole: 'cutaway',
      includeInExport: false,
      ...(aiPrompt ? { aiGenerationPrompt: aiPrompt } : { userInsertUrlSlot: true, insertKind: 'broll' as const }),
      ...(parentBeatRef ? { overlayParentBeatRef: parentBeatRef } : {}),
    };
  }

  // overlay + greenscreen → mediaRole overlay; greenscreen forces overlayLayout
  const overlayLayout =
    kind === 'greenscreen'
      ? ('greenscreen' as const)
      : OVERLAY_LAYOUTS.has(layoutRaw) && layoutRaw !== 'greenscreen'
        ? (layoutRaw as 'full' | 'pip_br' | 'pip_bl')
        : layoutRaw === 'greenscreen'
          ? ('greenscreen' as const)
          : ('pip_br' as const);

  return {
    filmedBy: 'ai',
    mediaRole: 'overlay',
    overlayLayout,
    includeInExport: false,
    ...(aiPrompt ? { aiGenerationPrompt: aiPrompt } : { userInsertUrlSlot: true, insertKind: 'broll' as const }),
    ...(parentBeatRef ? { overlayParentBeatRef: parentBeatRef } : {}),
  };
}

function plainFromVisual(visual: any, title: string, durationSeconds: number): string {
  const parts: string[] = [];
  if (visual?.action) parts.push(String(visual.action));
  if (visual?.camera || visual?.framing) {
    parts.push(
      `Camera: ${[visual.camera, visual.framing].filter(Boolean).join(', ')}.`
    );
  }
  if (visual?.movement) parts.push(`Movement: ${visual.movement}.`);
  if (visual?.environment) parts.push(`Setting: ${visual.environment}.`);
  parts.push(`Hold about ${durationSeconds}s, then stop.`);
  if (!parts.length) {
    return `Capture "${title}" for about ${durationSeconds} seconds. Hold the phone steady. No dialogue needed.`;
  }
  return parts.join(' ');
}

function cleanTeleprompter(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (!t || t === '—' || t.toLowerCase() === 'none' || t.toLowerCase() === 'n/a') return undefined;
  return t;
}

const RECIPE_LAYOUTS = new Set(['talking_head', 'virtual_background', 'pip', 'split']);
const RECIPE_INSERT_KINDS = new Set(['broll_image', 'broll_video', 'text_pop', 'meme']);
const RECIPE_TRANSITIONS: Record<string, SceneRecipe['transitionOut']> = {
  cut: 'cut',
  hard_cut: 'cut',
  zoom_snap: 'zoom_snap',
  'zoom-snap': 'zoom_snap',
  whip: 'whip',
  'whip-pan': 'whip',
  whip_pan: 'whip',
  crossfade: 'crossfade',
  dissolve: 'crossfade',
};

/** Map Gemini recipe output → SceneRecipe (tolerant of missing / malformed fields). */
export function normalizeSceneRecipe(raw: any): SceneRecipe | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const layoutRaw = String(raw.layout || '').toLowerCase().trim();
  const layout = (RECIPE_LAYOUTS.has(layoutRaw) ? layoutRaw : 'talking_head') as SceneRecipe['layout'];
  const bgPrompt = cleanTeleprompter(raw.background?.prompt);
  const bgAsset = cleanTeleprompter(raw.background?.assetUrl);
  const inserts = (Array.isArray(raw.inserts) ? raw.inserts : [])
    .map((i: any) => {
      const kind = String(i?.kind || '').toLowerCase().trim();
      if (!RECIPE_INSERT_KINDS.has(kind)) return null;
      const anchorPhrase = String(i?.anchorPhrase || '').trim();
      const text = cleanTeleprompter(i?.text);
      const prompt = cleanTeleprompter(i?.prompt);
      if (!anchorPhrase && !text && !prompt) return null;
      const layoutIn = String(i?.layout || '').toLowerCase().trim();
      return {
        anchorPhrase,
        kind: kind as SceneRecipe['inserts'][number]['kind'],
        ...(prompt ? { prompt } : {}),
        ...(text ? { text } : {}),
        layout: (layoutIn === 'pip' || layoutIn === 'full'
          ? layoutIn
          : kind === 'text_pop'
            ? 'full'
            : 'pip') as 'full' | 'pip',
        durationSec: Math.max(0.8, Math.min(8, Number(i?.durationSec) || 2)),
      };
    })
    .filter(Boolean) as SceneRecipe['inserts'];
  const punchIns = (Array.isArray(raw.punchIns) ? raw.punchIns : [])
    .map((p: any) => {
      const anchorPhrase = String(p?.anchorPhrase || '').trim();
      if (!anchorPhrase) return null;
      return { anchorPhrase, zoom: Math.max(1, Math.min(1.35, Number(p?.zoom) || 1.1)) };
    })
    .filter(Boolean) as SceneRecipe['punchIns'];
  const transitionOut =
    RECIPE_TRANSITIONS[String(raw.transitionOut || '').toLowerCase().trim()] || 'cut';
  return {
    layout,
    ...(bgPrompt ? { background: { prompt: bgPrompt, ...(bgAsset ? { assetUrl: bgAsset } : {}) } } : {}),
    inserts,
    punchIns,
    transitionOut,
  };
}

const RECIPE_TO_SCENE_TRANSITION: Record<SceneRecipe['transitionOut'], string> = {
  cut: 'cut',
  zoom_snap: 'zoom-snap',
  whip: 'whip-pan',
  crossfade: 'crossfade',
};

function recipeTransitionFallback(rawRecipe: any): string | undefined {
  const key = RECIPE_TRANSITIONS[String(rawRecipe?.transitionOut || '').toLowerCase().trim()];
  return key ? RECIPE_TO_SCENE_TRANSITION[key] : undefined;
}

const MEDIA_KINDS_WITH_ASSET = new Set(['overlay', 'greenscreen', 'cutaway']);

function spokenOf(s: any): string {
  return (
    cleanTeleprompter(s?.dialogue?.teleprompterText) ||
    cleanTeleprompter(s?.teleprompterPrompt) ||
    ''
  );
}

/**
 * Gemini sometimes puts mediaPlan.kind "overlay" / "greenscreen" / "cutaway" on a beat that the
 * creator speaks. Mapping that beat to filmedBy "ai" silently drops its lines from the main take
 * while its performance notes ("hit the punchline…") end up on an AI card. Keep the spoken beat
 * as a creator take and move the media onto it (virtual background) or into its own AI scene.
 */
function splitSpokenMediaBeats(raw: any[]): any[] {
  const out: any[] = [];
  /** Gemini sceneNumber → new sceneNumber, so numeric parentBeatRefs still resolve. */
  const renumber = new Map<number, number>();
  for (const s of raw) {
    const kind = String(s?.mediaPlan?.kind || 'none').toLowerCase().trim();
    const spoken = spokenOf(s);
    if (!spoken || !MEDIA_KINDS_WITH_ASSET.has(kind)) {
      if (Number(s?.sceneNumber)) renumber.set(Number(s.sceneNumber), out.length + 1);
      out.push(s);
      continue;
    }
    const aiPrompt = cleanTeleprompter(s.mediaPlan?.aiPrompt);
    const take = { ...s, filmedBy: 'user', mediaPlan: { kind: 'none' } };
    if (kind === 'greenscreen') {
      const recipe = s.recipe && typeof s.recipe === 'object' ? s.recipe : {};
      take.recipe = {
        ...recipe,
        layout: 'virtual_background',
        background: {
          ...(recipe.background || {}),
          prompt: cleanTeleprompter(recipe.background?.prompt) || aiPrompt || '',
        },
      };
    }
    if (Number(s?.sceneNumber)) renumber.set(Number(s.sceneNumber), out.length + 1);
    out.push(take);
    if (kind === 'greenscreen' || !aiPrompt) continue;
    const parentNumber = out.length;
    out.push({
      title: `${String(s.title || 'Beat')} — visual`,
      contentMode: 'visual_only',
      filmedBy: 'ai',
      durationSeconds: 3,
      plainInstruction: '',
      directorTip: '',
      editIntent: 'broll',
      dialogue: { required: false, teleprompterText: null },
      mediaPlan: { ...s.mediaPlan, parentBeatRef: String(parentNumber) },
      _splitParent: true,
    });
  }
  if (out.length === raw.length) return raw;
  return out.map((s, i) => {
    const ref = Number(s?.mediaPlan?.parentBeatRef);
    const mediaPlan =
      s?.mediaPlan && !s._splitParent && Number.isFinite(ref) && renumber.has(ref)
        ? { ...s.mediaPlan, parentBeatRef: String(renumber.get(ref)) }
        : s?.mediaPlan;
    const { _splitParent, ...rest } = s;
    return { ...rest, sceneNumber: i + 1, ...(mediaPlan ? { mediaPlan } : {}) };
  });
}

const OVERLAY_LAYOUT_LABEL: Record<string, string> = {
  full: 'full-screen',
  pip_br: 'picture-in-picture',
  pip_bl: 'picture-in-picture',
};

/**
 * Final pass on the captured scenes:
 * - Green-screen "overlay" scenes fold into their take's virtual-background recipe, so there is
 *   one background plate (generated once, one aspect ratio) instead of two.
 * - AI overlay / cutaway cards describe the visual (not a performance note), and their timing
 *   hint is a phrase the creator actually says in the parent take.
 * - Overlay parent refs are renumbered against the final scene order.
 */
function groundAiMediaScenes(scenesIn: any[], idea = ''): any[] {
  const parentOf = (s: any, idx: number, list: any[]): any | undefined => {
    const m = String(s.overlayParentSceneId || '').match(/^scene-ref:(\d+)$/);
    const users = list.filter((p) => p.filmedBy === 'user');
    if (m) {
      const hit = users.find((p) => Number(p.sceneNumber) === Number(m[1]));
      if (hit) return hit;
    }
    for (let j = idx - 1; j >= 0; j--) if (list[j].filmedBy === 'user') return list[j];
    return users[0];
  };
  const parents = new Map<any, any>();
  scenesIn.forEach((s, idx) => {
    if (s.filmedBy === 'ai' || s.mediaRole === 'overlay' || s.mediaRole === 'cutaway') {
      const p = parentOf(s, idx, scenesIn);
      if (p) parents.set(s, p);
    }
  });

  // 1) Fold green-screen overlays into the parent take's recipe.
  const folded = new Set<any>();
  for (const s of scenesIn) {
    if (s.mediaRole !== 'overlay' || s.overlayLayout !== 'greenscreen') continue;
    const parent = parents.get(s);
    if (!parent) continue;
    const recipe = parent.recipe || { layout: 'talking_head', inserts: [], punchIns: [], transitionOut: 'cut' };
    const prompt = cleanTeleprompter(recipe.background?.prompt) || cleanTeleprompter(s.aiGenerationPrompt);
    parent.recipe = {
      ...recipe,
      layout: 'virtual_background',
      ...(prompt ? { background: { ...(recipe.background || {}), prompt } } : {}),
    };
    folded.add(s);
  }
  if (folded.size) console.log(`[plan] folded ${folded.size} green-screen overlay(s) into the take's virtual background`);
  const scenes = scenesIn.filter((s) => !folded.has(s));

  // 2) Ground AI overlay / cutaway copy + timing in the parent's spoken lines.
  for (const s of scenes) {
    if (s.filmedBy !== 'ai') continue;
    const parent = parents.get(s);
    const spoken = parent ? spokenOf(parent) : '';
    const spokenWords = spoken.split(/\s+/).filter(Boolean);
    let aiPrompt = cleanTeleprompter(s.aiGenerationPrompt) || '';
    let hint = cleanTeleprompter(s.mediaTimingHint);
    if (spokenWords.length >= 3) {
      if (!hint || !anchorIsSpoken(hint, anchorTokens(spoken))) {
        hint = pickSpokenAnchor(spokenWords, `${hint || ''} ${s.title || ''} ${aiPrompt}`, 0.5);
      }
    } else {
      hint = undefined;
    }
    if (hint) s.mediaTimingHint = hint;
    else delete s.mediaTimingHint;

    // An AI visual with nothing to generate from would ship as an empty slot: describe the line
    // it illustrates instead.
    if (!aiPrompt) {
      const line =
        (hint && spoken.split(/(?<=[.!?])\s+/).find((x) => x.toLowerCase().includes(hint!.toLowerCase()))) ||
        hint ||
        s.title ||
        '';
      aiPrompt = `Cinematic, photorealistic vertical photo, no text, illustrating: "${line}". Topic: ${String(idea).slice(0, 140)}.`;
      s.aiGenerationPrompt = aiPrompt;
      // Written by us, not the model — restoreSpokenLines may rewrite it from the real script.
      s._autoPrompt = true;
      delete s.userInsertUrl;
      delete s.insertKind;
    }

    const layout = OVERLAY_LAYOUT_LABEL[String(s.overlayLayout || '')] || '';
    const what = aiPrompt
      ? aiPrompt.length > 220
        ? `${aiPrompt.slice(0, 217).trimEnd()}…`
        : aiPrompt
      : 'Upload or generate a visual for this moment.';
    s.plainInstruction =
      s.mediaRole === 'cutaway'
        ? `AI cutaway: ${what}`
        : `AI ${layout ? `${layout} ` : ''}overlay: ${what}`;
    s.directorTip = hint
      ? `Nothing to film. It appears when you say “${hint}”.`
      : 'Nothing to film. TakeOne generates this and places it over your take.';
    if (s.mediaRole === 'overlay') {
      s.durationSeconds = Math.max(2, Math.min(3, Number(s.durationSeconds) || 3));
    }
  }

  // 3) Renumber and point overlay refs at the final numbering.
  scenes.forEach((s, i) => {
    s.sceneNumber = i + 1;
  });
  for (const s of scenes) {
    const parent = parents.get(s);
    if (parent && scenes.includes(parent)) s.overlayParentSceneId = `scene-ref:${parent.sceneNumber}`;
  }
  return scenes;
}

export function normalizeProductionPlan(
  parsed: any,
  opts: {
    idea: string;
    duration: string;
    style: string;
    isLongForm: boolean;
    aspectRatio: string;
    /** User choice from Idea screen — wins over auto-collapse for short-form */
    preferredCaptureStrategy?: string;
    briefHints?: Record<string, unknown> | null;
    prefs?: ProductionPrefs | null;
  }
): any {
  const prefs = opts.prefs || null;
  const targetDuration = parseTargetSeconds(opts.duration, opts.isLongForm);
  const inferred = inferContentType(opts.idea);
  const briefIn = parsed?.creativeBrief || {};
  let contentType = CONTENT_TYPES.includes(briefIn.contentType)
    ? briefIn.contentType
    : inferred;
  // Trust Gemini's classification; only fall back to explicit UGC-ad cues when it was vague.
  if (contentType === 'hybrid' && inferred === 'ugc_ad') {
    contentType = 'ugc_ad';
  }

  const spokenLanguage = normalizeSpokenLanguage(
    briefIn.spokenLanguage ||
      parsed?.spokenLanguage ||
      detectSpokenLanguageFromText(
        `${opts.idea}\n${parsed?.scenes?.[0]?.dialogue?.teleprompterText || ''}\n${parsed?.logline || ''}`
      )
  );

  const viralIn = briefIn.viralStyle && typeof briefIn.viralStyle === 'object' ? briefIn.viralStyle : {};
  const overlayPolicy = String(viralIn.overlayPolicy || 'none').toLowerCase();
  const looksIn = prefs?.looks || [];
  const wantsMemes = looksIn.includes('memes') || overlayPolicy === 'meme';
  const wantsMediaLooks =
    looksIn.some((l) => l === 'overlays' || l === 'broll' || l === 'memes' || l === 'virtual_background') ||
    opts.briefHints?.preferOverlays === true ||
    opts.briefHints?.greenscreen === true ||
    overlayPolicy === 'selective' ||
    overlayPolicy === 'meme';

  const creativeBrief = {
    contentType,
    storyObjective: String(briefIn.storyObjective || parsed?.logline || opts.idea).slice(0, 400),
    audience: String(
      briefIn.audience ||
        'general social audience'
    ),
    visualPriority: String(
      briefIn.visualPriority || 'medium'
    ),
    dialoguePriority: String(briefIn.dialoguePriority || 'medium'),
    teleprompterRequired: Boolean(briefIn.teleprompterRequired),
    voiceoverPossible: briefIn.voiceoverPossible !== false,
    naturalAudioImportance: String(briefIn.naturalAudioImportance || 'medium'),
    creatorPresence: String(briefIn.creatorPresence || 'frequent'),
    narrativeStructure: String(
      briefIn.narrativeStructure || 'hook → build → payoff'
    ),
    pacing: String(briefIn.pacing || 'steady'),
    tone: String(briefIn.tone || opts.style || 'authentic'),
    platform: String(
      briefIn.platform || (opts.isLongForm ? 'YouTube long-form' : 'short-form social video')
    ),
    targetDuration: Number(briefIn.targetDuration) || targetDuration,
    spokenLanguage,
    viralStyle: {
      referenceLook: String(
        viralIn.referenceLook ||
          'Fast social pacing with a clear hook, punch-ins on key claims, and short text pops.'
      ),
      effects: Array.isArray(viralIn.effects)
        ? viralIn.effects.map((e: unknown) => String(e)).slice(0, 10)
        : ['punch zoom on hook', 'zoom-snap into the key claim', 'on-screen CTA'],
      overlayPolicy: wantsMediaLooks ? (wantsMemes ? 'meme' : 'selective') : 'none',
      musicEnergy: String(
        prefs && !prefs.music ? 'none' : viralIn.musicEnergy || briefIn.pacing || 'warm upbeat'
      ),
    },
    ...(prefs ? { prefs } : {}),
    storytellingMode:
      briefIn.storytellingMode ||
      (contentType === 'ugc_ad' ||
      contentType === 'product_demo' ||
      isUgcAdContent(contentType, opts.idea)
        ? 'direct_to_camera'
        : isVisualFirstContent(contentType, opts.idea)
          ? 'visual_first'
          : 'mixed'),
    editingStrategy:
      briefIn.editingStrategy ||
      (contentType === 'ugc_ad' ||
      contentType === 'product_demo' ||
      isUgcAdContent(contentType, opts.idea)
        ? 'jump_cut_social'
        : undefined),
    captureStrategy: (() => {
      const inferredStrategy = inferCaptureStrategy({
        contentType,
        isLongForm: opts.isLongForm,
        targetDuration,
        idea: opts.idea,
        style: opts.style,
        prefs,
        preferredCaptureStrategy: opts.preferredCaptureStrategy,
      });
      // Creator's shot budget wins, then an explicit preferred strategy.
      const fromPrefs = captureStrategyFromShotsPref(prefs?.shots);
      if (fromPrefs) return fromPrefs;
      if (opts.preferredCaptureStrategy) {
        return coerceCaptureStrategy(opts.preferredCaptureStrategy, inferredStrategy);
      }
      if (explicitMultiShotRequest(opts.idea, undefined)) return 'multi_shot';
      // Short-form defaults to one take; long-form may follow Gemini's brief.
      if (!opts.isLongForm) return inferredStrategy;
      return coerceCaptureStrategy(briefIn.captureStrategy, inferredStrategy);
    })(),
  };

  const TRANSITIONS = new Set([
    'cut',
    'crossfade',
    'dissolve',
    'zoom-snap',
    'whip-pan',
    'fade-to-black',
    'hard_cut',
  ]);

  const rawScenes = splitSpokenMediaBeats(Array.isArray(parsed?.scenes) ? parsed.scenes : []);
  const scenes = rawScenes.map((s: any, idx: number) => {
    const contentMode = CONTENT_MODES.includes(s.contentMode) ? s.contentMode : 'mixed';
    const spoken =
      cleanTeleprompter(s.dialogue?.teleprompterText) ||
      cleanTeleprompter(s.teleprompterPrompt) ||
      cleanTeleprompter(s.voiceover?.text);
    // Preserve any speech Gemini wrote — do not strip because contentMode isn't exactly "dialogue"
    const dialogueRequired =
      Boolean(spoken) ||
      s.dialogue?.required === true ||
      contentMode === 'dialogue' ||
      contentMode === 'voiceover';
    const teleprompterPrompt = spoken || undefined;
    const durationSeconds = Math.max(2, Math.min(600, Number(s.durationSeconds) || 5));
    let plainInstruction = String(s.plainInstruction || '').trim();
    if (plainInstruction.length < 12) {
      plainInstruction = plainFromVisual(s.visual, s.title || `Scene ${idx + 1}`, durationSeconds);
    }

    const editIntent = EDIT_INTENTS.includes(s.editIntent)
      ? s.editIntent
      : 'context';
    const defaultZoom =
      editIntent === 'hook' || editIntent === 'product' || editIntent === 'cta' ? 1.08 : 1.0;
    const editZoom = Math.max(1, Math.min(1.15, Number(s.editZoom) || defaultZoom));
    const transitionRaw = String(s.transition || '').toLowerCase().trim();
    const transition = TRANSITIONS.has(transitionRaw)
      ? transitionRaw === 'hard_cut'
        ? 'cut'
        : transitionRaw
      : recipeTransitionFallback(s.recipe)
        ? (recipeTransitionFallback(s.recipe) as string)
        : editIntent === 'hook'
          ? 'zoom-snap'
          : 'cut';

    const mediaPlanIn =
      s.mediaPlan && typeof s.mediaPlan === 'object' ? { ...s.mediaPlan } : { kind: 'none' };
    const recipe = normalizeSceneRecipe(s.recipe);
    const mediaFields = mapMediaPlanToSceneFields(mediaPlanIn);
    const filmedBy = mediaFields.filmedBy;

    return {
      sceneNumber: Number(s.sceneNumber) || idx + 1,
      chapterTitle: s.chapterTitle || undefined,
      title: String(s.title || `Scene ${idx + 1}`),
      purpose: s.purpose ? String(s.purpose) : undefined,
      contentMode:
        filmedBy === 'ai'
          ? 'visual_only'
          : teleprompterPrompt && contentMode === 'visual_only'
            ? 'mixed'
            : contentMode,
      filmedBy,
      durationSeconds,
      plainInstruction,
      directorTip: String(
        s.directorTip ||
          'Keep it natural — authenticity beats perfection.'
      ),
      ...(teleprompterPrompt && filmedBy === 'user' ? { teleprompterPrompt } : {}),
      visual: s.visual && typeof s.visual === 'object' ? s.visual : undefined,
      dialogue: {
        required: Boolean(dialogueRequired && teleprompterPrompt && filmedBy === 'user'),
        teleprompterText:
          filmedBy === 'user' ? teleprompterPrompt || null : null,
      },
      voiceover: {
        required: Boolean(s.voiceover?.required && cleanTeleprompter(s.voiceover?.text)),
        text: s.voiceover?.required ? cleanTeleprompter(s.voiceover?.text) || null : null,
      },
      naturalAudio: s.naturalAudio != null ? String(s.naturalAudio) : null,
      onScreenText: s.onScreenText != null ? String(s.onScreenText) : null,
      editIntent: filmedBy === 'ai' ? 'broll' : editIntent,
      editZoom,
      transition,
      transitionDuration: Math.min(0.7, Math.max(0.15, Number(s.transitionDuration) || 0.25)),
      directorCues: Array.isArray(s.directorCues) ? s.directorCues : undefined,
      delivery: s.delivery && typeof s.delivery === 'object' ? s.delivery : undefined,
      mediaRole: mediaFields.mediaRole,
      ...(mediaFields.overlayLayout ? { overlayLayout: mediaFields.overlayLayout } : {}),
      ...(mediaFields.includeInExport === false ? { includeInExport: false } : {}),
      ...(mediaFields.aiGenerationPrompt
        ? { aiGenerationPrompt: mediaFields.aiGenerationPrompt }
        : {}),
      ...(mediaFields.insertKind ? { insertKind: mediaFields.insertKind } : {}),
      ...(mediaFields.userInsertUrlSlot ? { userInsertUrl: undefined } : {}),
      ...(mediaFields.overlayParentBeatRef
        ? { overlayParentBeatRef: mediaFields.overlayParentBeatRef }
        : {}),
      ...(mediaPlanIn?.timingHint
        ? { mediaTimingHint: String(mediaPlanIn.timingHint) }
        : {}),
      mediaPlan: mediaPlanIn,
      ...(recipe ? { recipe } : {}),
    };
  });

  // Resolve overlayParentBeatRef → nearest matching user scene number (client assigns real ids).
  scenes.forEach((s: any, idx: number) => {
    if (s.mediaRole !== 'overlay' && s.mediaRole !== 'cutaway') return;
    const ref = s.overlayParentBeatRef;
    if (!ref) return;
    const asNum = Number(ref);
    let parent =
      Number.isFinite(asNum) && asNum > 0
        ? scenes.find((p: any) => Number(p.sceneNumber) === asNum && p.filmedBy === 'user')
        : scenes.find(
            (p: any) =>
              p.filmedBy === 'user' &&
              (String(p.title).toLowerCase() === String(ref).toLowerCase() ||
                String(p.purpose || '').toLowerCase().includes(String(ref).toLowerCase()))
          );
    if (!parent) {
      for (let j = idx - 1; j >= 0; j--) {
        if (scenes[j].filmedBy === 'user') {
          parent = scenes[j];
          break;
        }
      }
    }
    if (parent) {
      // Placeholder until IdeaInputView assigns scene ids; keeps beat number for remap.
      s.overlayParentSceneId = `scene-ref:${parent.sceneNumber}`;
    }
  });

  // Do NOT genre-police or strip teleprompter for gardening/workout/etc.
  // Gemini decides speech vs visual; we only preserve what it wrote.

  const captured = applyCaptureStrategy({
    scenes,
    contentType,
    captureStrategy: creativeBrief.captureStrategy,
    idea: opts.idea,
    briefHints: opts.briefHints,
    prefs,
  });
  creativeBrief.captureStrategy = captured.captureStrategy;
  captured.scenes = groundAiMediaScenes(captured.scenes, opts.idea);
  captured.captureUnits = captured.captureUnits.filter(
    (u) => !u.id || captured.scenes.some((s: any) => !s.captureUnitId || s.captureUnitId === u.id)
  );

  const estimated =
    Number(parsed?.estimatedTotalSeconds) ||
    captured.scenes.reduce((a: number, c: any) => a + c.durationSeconds, 0) ||
    targetDuration;

  return {
    title: String(parsed?.title || 'Untitled video'),
    logline: String(parsed?.logline || opts.idea),
    videoFormat: opts.isLongForm ? 'long-form' : 'short-form',
    aspectRatio: opts.aspectRatio || (opts.isLongForm ? '16:9' : '9:16'),
    estimatedTotalSeconds: estimated,
    musicMood: String(parsed?.musicMood || 'Warm Acoustic'),
    spokenLanguage,
    ...(prefs ? { prefs } : {}),
    creativeBrief,
    captureStrategy: captured.captureStrategy,
    narrativeBeats: captured.narrativeBeats,
    captureUnits: captured.captureUnits,
    capturePlan: captured.captureUnits,
    scenes: captured.scenes,
  };
}

/**
 * Check a normalized plan against the creator's production prefs.
 * Returns the list of unmet requirements (empty = ok).
 */
export function validateAgainstPrefs(
  plan: { scenes?: any[]; captureUnits?: any[]; estimatedTotalSeconds?: number } | null | undefined,
  prefs: ProductionPrefs | null | undefined
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!plan || !prefs) return { ok: true, missing };
  const scenes: any[] = Array.isArray(plan.scenes) ? plan.scenes : [];
  const looks = prefs.looks || [];
  const allInserts = scenes.flatMap((s) => (Array.isArray(s?.recipe?.inserts) ? s.recipe.inserts : []));
  /** An AI picture insert only renders if there is a prompt to generate it from. */
  const hasPrompt = (i: any) => Boolean(String(i?.prompt || '').trim());
  const mediaScenes = scenes.filter(
    (s) => s?.mediaRole === 'overlay' || s?.mediaRole === 'cutaway' || s?.filmedBy === 'ai'
  );
  const totalSeconds =
    Number(plan.estimatedTotalSeconds) ||
    scenes.reduce((a, s) => a + (Number(s?.durationSeconds) || 0), 0) ||
    45;

  if (looks.includes('virtual_background')) {
    const ok = scenes.some(
      (s) =>
        (s?.recipe?.layout === 'virtual_background' &&
          String(s?.recipe?.background?.prompt || s?.recipe?.background?.assetUrl || '').trim()) ||
        s?.mediaPlan?.kind === 'greenscreen' ||
        s?.overlayLayout === 'greenscreen'
    );
    if (!ok) {
      missing.push(
        'virtual_background: at least one scene needs recipe.layout = "virtual_background" with recipe.background.prompt'
      );
    }
  }

  if (looks.includes('broll')) {
    const brollInserts = allInserts.filter(
      (i: any) => (i?.kind === 'broll_image' || i?.kind === 'broll_video') && hasPrompt(i)
    ).length;
    const brollScenes = mediaScenes.filter(
      (s) => s?.mediaPlan?.kind !== 'greenscreen' && s?.overlayLayout !== 'greenscreen' && s?.aiGenerationPrompt
    ).length;
    const need = Math.max(1, Math.min(6, Math.round(totalSeconds / 20)));
    if (brollInserts + brollScenes < need) {
      missing.push(
        `broll: need at least ${need} b-roll inserts (recipe.inserts kind broll_image/broll_video with a prompt, anchored to spoken phrases); found ${brollInserts + brollScenes}`
      );
    }
  }

  if (looks.includes('overlays')) {
    const ok =
      allInserts.some(
        (i: any) =>
          (i?.kind === 'broll_image' || i?.kind === 'broll_video') && i?.layout === 'pip' && hasPrompt(i)
      ) ||
      mediaScenes.some(
        (s) => s?.mediaRole === 'overlay' && s?.overlayLayout !== 'greenscreen' && s?.aiGenerationPrompt
      );
    if (!ok) {
      missing.push(
        'overlays: need at least one recipe.insert kind "broll_image" with layout "pip" and a prompt describing the AI picture'
      );
    }
  }

  if (looks.includes('memes')) {
    if (!allInserts.some((i: any) => i?.kind === 'meme' && (hasPrompt(i) || String(i?.text || '').trim()))) {
      missing.push('memes: need at least one recipe.insert with kind "meme" and a prompt');
    }
  }

  if (looks.includes('text_pops')) {
    const ok =
      allInserts.some((i: any) => i?.kind === 'text_pop') ||
      scenes.some((s) => String(s?.onScreenText || '').trim());
    if (!ok) {
      missing.push('text_pops: need at least one recipe.insert with kind "text_pop" (short `text`)');
    }
  }

  const captureUnits: any[] = Array.isArray(plan.captureUnits) ? plan.captureUnits : [];
  const requiredSetups = captureUnits.filter((c) => !c?.optional).length;
  if (captureUnits.length) {
    if (prefs.shots === 'one_take' && requiredSetups > 1) {
      missing.push(`shots: one_take requires a single capture setup; found ${requiredSetups}`);
    } else if (prefs.shots === 'few' && (requiredSetups < 1 || requiredSetups > 4)) {
      missing.push(`shots: "few" requires 2–3 capture setups (max 4); found ${requiredSetups}`);
    }
  }

  return { ok: missing.length === 0, missing };
}

const ANCHOR_STOPWORDS = new Set(
  'a an the and or but so to of in on for with at by from is are was were be been it this that these those i you we they he she my your our their me us them do does did not no yes just very really'.split(
    ' '
  )
);

function anchorTokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** True when ≥ 70% of the anchor's words appear in order inside the spoken text. */
function anchorIsSpoken(anchor: string, spokenTokens: string[]): boolean {
  const a = anchorTokens(anchor);
  if (!a.length) return false;
  let k = 0;
  for (const t of spokenTokens) {
    if (k < a.length && t === a[k]) k++;
  }
  if (k / a.length < 0.7) return false;
  const joined = ` ${spokenTokens.join(' ')} `;
  return a.length <= 2 ? joined.includes(` ${a.join(' ')} `) : true;
}

/**
 * Pick a 5-word spoken window for an insert: the window sharing the most content words with
 * `hint` (old anchor + caption + prompt), else evenly spaced at `slot` (0–1).
 */
function pickSpokenAnchor(spokenWords: string[], hint: string, slot: number): string {
  const size = Math.min(5, spokenWords.length);
  const norm = spokenWords.map((w) => anchorTokens(w)[0] || '');
  const hintSet = new Set(anchorTokens(hint).filter((t) => t.length > 2 && !ANCHOR_STOPWORDS.has(t)));
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i + size <= spokenWords.length; i++) {
    let score = 0;
    for (let j = i; j < i + size; j++) if (hintSet.has(norm[j])) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) {
    bestIdx = Math.max(0, Math.min(spokenWords.length - size, Math.round(slot * (spokenWords.length - size))));
  }
  return spokenWords
    .slice(bestIdx, bestIdx + size)
    .join(' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Re-anchor recipe inserts / punch-ins whose anchorPhrase is not in the scene's spoken text
 * (Gemini sometimes puts the caption there), so compile can find them in the transcript.
 */
export function repairPlanAnchors<T extends { scenes?: any[] }>(plan: T): T {
  if (!plan || !Array.isArray(plan.scenes)) return plan;
  let fixed = 0;
  const scenes = plan.scenes.map((scene: any) => {
    const recipe = scene?.recipe;
    if (!recipe) return scene;
    const spoken = String(scene.teleprompterPrompt || scene.dialogue?.teleprompterText || '').trim();
    const spokenWords = spoken.split(/\s+/).filter(Boolean);
    if (spokenWords.length < 3) return scene;
    const spokenTokens = anchorTokens(spoken);
    const fix = (items: any[] | undefined, hintOf: (x: any) => string) =>
      (items || []).map((item: any, idx: number, arr: any[]) => {
        if (!item || anchorIsSpoken(item.anchorPhrase, spokenTokens)) return item;
        fixed++;
        const anchorPhrase = pickSpokenAnchor(spokenWords, hintOf(item), (idx + 1) / (arr.length + 1));
        // Caption text that was misplaced into anchorPhrase becomes the text-pop text.
        const text =
          item.kind === 'text_pop' && !String(item.text || '').trim() ? item.anchorPhrase : item.text;
        return { ...item, anchorPhrase, ...(text !== undefined ? { text } : {}) };
      });
    return {
      ...scene,
      recipe: {
        ...recipe,
        inserts: fix(recipe.inserts, (x) => `${x.anchorPhrase || ''} ${x.text || ''} ${x.prompt || ''}`),
        punchIns: fix(recipe.punchIns, (x) => String(x.anchorPhrase || '')),
      },
    };
  });
  if (fixed) console.log(`[plan] re-anchored ${fixed} insert/punch-in phrase(s) to spoken dialogue`);
  return { ...plan, scenes };
}

const PREF_SHOTS = new Set(['one_take', 'few', 'cinematic']);
const PREF_LOOKS = new Set(['talking_head', 'virtual_background', 'broll', 'overlays', 'memes', 'text_pops']);
const PREF_CAPTIONS = new Set(['bold_pop', 'karaoke', 'clean', 'off']);

/** Coerce untrusted request JSON into ProductionPrefs (fills gaps from defaults). */
export function sanitizeProductionPrefs(raw: unknown, format?: string): ProductionPrefs {
  const base = defaultProductionPrefs(format);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, any>;
  const looks = Array.isArray(r.looks)
    ? Array.from(new Set(r.looks.map((l: unknown) => String(l)).filter((l: string) => PREF_LOOKS.has(l))))
    : base.looks;
  return {
    shots: PREF_SHOTS.has(String(r.shots)) ? r.shots : base.shots,
    looks: (looks.length ? looks : base.looks) as ProductionPrefs['looks'],
    captions: PREF_CAPTIONS.has(String(r.captions)) ? r.captions : base.captions,
    cleanup: {
      silences: typeof r.cleanup?.silences === 'boolean' ? r.cleanup.silences : base.cleanup.silences,
      fillers: typeof r.cleanup?.fillers === 'boolean' ? r.cleanup.fillers : base.cleanup.fillers,
    },
    music: typeof r.music === 'boolean' ? r.music : base.music,
    ...(['bottom', 'middle', 'top'].includes(r.captionPosition) ? { captionPosition: r.captionPosition } : {}),
    ...(['small', 'medium', 'large'].includes(r.captionSize) ? { captionSize: r.captionSize } : {}),
  };
}

/** Soft signal: idea/clarify suggest spoken performance is expected. */
export function ideaLikelyNeedsSpeech(
  idea: string,
  briefHints?: Record<string, unknown> | null
): boolean {
  const blob = `${idea} ${JSON.stringify(briefHints || {})}`.toLowerCase();
  if (
    /\b(silent|no (talk|speech|dialogue)|b-?roll only|visual only|workout reps only)\b/.test(blob)
  ) {
    return false;
  }
  return /\b(talk|speak|say|script|dialogue|hook|ugc|ad|testimonial|explain|story|vlog|review|opinion|why|love of|tell|pitch|sell|cta|to.?camera)\b/.test(
    blob
  );
}

export function planHasSpokenLines(plan: { scenes?: any[] }): boolean {
  return (plan.scenes || []).some(
    (s) =>
      Boolean(cleanTeleprompter(s.teleprompterPrompt)) ||
      Boolean(cleanTeleprompter(s.dialogue?.teleprompterText)) ||
      Boolean(cleanTeleprompter(s.voiceover?.text))
  );
}

/**
 * After single_take collapse, beats are joined with \\n\\n.
 * One Gemini pass rewrites them into a single continuous voice while keeping
 * those separators as beat markers for the teleprompter.
 */
export function buildTeleprompterFlowPassPrompt(opts: {
  joinedScript: string;
  idea?: string;
  style?: string;
}): string {
  return `You rewrite creator teleprompter scripts into one natural continuous voice.

Rule: write like you talk to one friend. Contractions. Short sentences. No corporate filler.

Tone examples:
${HUMAN_VOICE_EXAMPLES.map((e) => `- "${e}"`).join('\n')}

Idea: ${opts.idea || '(unspecified)'}
Style: ${opts.style || 'warm authentic'}

The script below is one continuous take. Beats are separated by a blank line (\\n\\n).
Rewrite the WHOLE thing so it flows as one monologue in a single voice — same meaning, smoother transitions.
KEEP the blank-line separators between beats (same number of beat blocks) so the teleprompter can still show sections.
Do not add titles, beat labels, markdown, or quotation marks around the whole script.
Return ONLY the rewritten script text.

SCRIPT:
${opts.joinedScript}`;
}

export function applyTeleprompterFlowPass(
  plan: any,
  rewritten: string
): any {
  const text = String(rewritten || '').trim();
  if (!text || !plan?.scenes?.length) return plan;

  // Prefer the main spoken take (first user scene that already has teleprompter)
  let applied = false;
  const scenes = plan.scenes.map((s: any) => {
    if (applied) return s;
    if (s.filmedBy === 'ai' || s.mediaRole === 'overlay' || s.mediaRole === 'cutaway') {
      return s;
    }
    if (s.optionalInsert) return s;
    const hadSpeech =
      Boolean(cleanTeleprompter(s.teleprompterPrompt)) ||
      Boolean(cleanTeleprompter(s.dialogue?.teleprompterText));
    if (!hadSpeech) return s;
    applied = true;
    return {
      ...s,
      teleprompterPrompt: text,
      dialogue: {
        required: true,
        teleprompterText: text,
      },
    };
  });

  const narrativeBeats = Array.isArray(plan.narrativeBeats)
    ? (() => {
        const blocks = text.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
        return plan.narrativeBeats.map((b: any, i: number) => ({
          ...b,
          dialogue: blocks[i] || b.dialogue,
        }));
      })()
    : plan.narrativeBeats;

  return { ...plan, scenes, narrativeBeats };
}

export async function runTeleprompterFlowPass(
  ai: { models: { generateContent: (req: any) => Promise<{ text?: string }> } },
  plan: any,
  opts: { idea?: string; style?: string; model?: string } = {}
): Promise<any> {
  if (!plan || plan.captureStrategy !== 'single_take') return plan;
  const main = (plan.scenes || []).find(
    (s: any) =>
      s.filmedBy !== 'ai' &&
      (cleanTeleprompter(s.teleprompterPrompt) || cleanTeleprompter(s.dialogue?.teleprompterText))
  );
  if (!main) return plan;
  const joined =
    cleanTeleprompter(main.teleprompterPrompt) ||
    cleanTeleprompter(main.dialogue?.teleprompterText) ||
    '';
  if (!joined.includes('\n\n')) return plan;

  try {
    const response = await ai.models.generateContent({
      model: opts.model || 'gemini-3.8-flash',
      contents: buildTeleprompterFlowPassPrompt({
        joinedScript: joined,
        idea: opts.idea,
        style: opts.style,
      }),
    });
    const rewritten = String(response?.text || '').trim();
    if (!rewritten || rewritten.length < 20) return plan;
    return applyTeleprompterFlowPass(plan, rewritten);
  } catch {
    return plan;
  }
}

function sceneUnit(partial: Record<string, any>): any {
  const contentMode = partial.contentMode || 'visual_only';
  const dialogueRequired = Boolean(partial.dialogue?.required);
  const tele = dialogueRequired
    ? cleanTeleprompter(partial.dialogue?.teleprompterText || partial.teleprompterPrompt)
    : undefined;
  return {
    sceneNumber: partial.sceneNumber,
    chapterTitle: partial.chapterTitle,
    title: partial.title,
    purpose: partial.purpose,
    contentMode,
    filmedBy: 'user',
    durationSeconds: partial.durationSeconds,
    plainInstruction: partial.plainInstruction,
    directorTip: partial.directorTip,
    ...(tele ? { teleprompterPrompt: tele } : {}),
    visual: partial.visual,
    dialogue: {
      required: Boolean(tele),
      teleprompterText: tele || null,
    },
    voiceover: partial.voiceover || { required: false, text: null },
    naturalAudio: partial.naturalAudio ?? null,
    onScreenText: partial.onScreenText ?? null,
    editIntent: partial.editIntent || 'context',
    directorCues: partial.directorCues,
    delivery: partial.delivery,
  };
}

function finalizeDynamic(
  plan: any,
  type: ContentType,
  idea: string,
  isLongForm: boolean,
  targetDuration: number,
  preferredCaptureStrategy?: string
) {
  const inferred = inferCaptureStrategy({
    contentType: plan.creativeBrief?.contentType || type,
    isLongForm,
    targetDuration,
    idea,
  });
  const strategy = preferredCaptureStrategy
    ? coerceCaptureStrategy(preferredCaptureStrategy, inferred)
    : inferred;
  const captured = applyCaptureStrategy({
    scenes: plan.scenes,
    contentType: plan.creativeBrief?.contentType || type,
    captureStrategy: strategy,
    idea,
  });
  return {
    ...plan,
    estimatedTotalSeconds: captured.scenes.reduce(
      (a: number, s: any) => a + (s.durationSeconds || 0),
      0
    ),
    creativeBrief: {
      ...plan.creativeBrief,
      captureStrategy: captured.captureStrategy,
      storytellingMode:
        plan.creativeBrief?.storytellingMode ||
        (type === 'ugc_ad' ? 'direct_to_camera' : plan.creativeBrief?.storytellingMode),
      editingStrategy:
        plan.creativeBrief?.editingStrategy ||
        (type === 'ugc_ad' ? 'jump_cut_social' : plan.creativeBrief?.editingStrategy),
    },
    captureStrategy: captured.captureStrategy,
    narrativeBeats: captured.narrativeBeats,
    captureUnits: captured.captureUnits,
    capturePlan: captured.captureUnits,
    scenes: captured.scenes,
  };
}

/** Content-aware fallback when Gemini fails — not a forced talking-head script. */
export function buildDynamicScript(
  idea: string,
  durationStr = '45 seconds',
  style = 'Warm & authentic vlog',
  isLongForm = false,
  aspectRatio = '9:16',
  preferredCaptureStrategy?: string
) {
  const type = inferContentType(idea);
  const targetDuration = parseTargetSeconds(durationStr, isLongForm);
  const platform = isLongForm ? 'YouTube long-form' : 'short-form social';

  const briefBase = {
    contentType: type,
    storyObjective: idea,
    audience: 'curious beginners',
    visualPriority: 'high' as string,
    dialoguePriority: 'low' as string,
    teleprompterRequired: false,
    voiceoverPossible: true,
    naturalAudioImportance: 'high' as string,
    creatorPresence: 'intermittent' as string,
    narrativeStructure: 'adaptive',
    pacing: 'steady',
    tone: style,
    platform,
    targetDuration,
  };

  if (type === 'ugc_ad') {
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Hook',
        purpose: 'Open with a concrete claim',
        contentMode: 'dialogue',
        durationSeconds: isLongForm ? Math.round(targetDuration * 0.12) : 8,
        plainInstruction: 'Phone at eye level. One position. Start talking — do not cut.',
        directorTip: 'Skip the welcome. Start on the thought.',
        dialogue: {
          required: true,
          teleprompterText: "The reason I actually stuck with this? It stopped wasting my mornings.",
        },
        visual: { action: 'Talk to camera', framing: 'chest-up' },
        editIntent: 'hook',
        delivery: { speakingPace: 'natural', lookAtCamera: true },
        directorCues: [{ kind: 'LOOK_AT_CAMERA', holdMs: 2200 }],
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Problem',
        purpose: 'Name the frustration',
        contentMode: 'dialogue',
        durationSeconds: isLongForm ? Math.round(targetDuration * 0.18) : 9,
        plainInstruction: 'Same framing. Keep rolling.',
        directorTip: 'Stay in the same take.',
        dialogue: {
          required: true,
          teleprompterText: "But here's what I was doing before — switching apps, losing the thread, starting over every day.",
        },
        editIntent: 'problem',
        delivery: { speakingPace: 'natural', breathingPoint: true },
        directorCues: [{ kind: 'PAUSE', holdMs: 1600 }],
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Product',
        purpose: 'Introduce what you use',
        contentMode: 'dialogue',
        durationSeconds: isLongForm ? Math.round(targetDuration * 0.2) : 10,
        plainInstruction: 'Same camera. Hold the product or mention the app — do not reframe.',
        directorTip: 'SHOW_PRODUCT is a hand raise, not a new shot.',
        dialogue: {
          required: true,
          teleprompterText: "Then I found this. One place. I open it, I do the thing, I close it.",
        },
        editIntent: 'product',
        directorCues: [{ kind: 'SHOW_PRODUCT', holdMs: 2000 }],
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Benefit',
        purpose: 'What changed',
        contentMode: 'dialogue',
        durationSeconds: isLongForm ? Math.round(targetDuration * 0.18) : 9,
        plainInstruction: 'Keep talking. Same position.',
        directorTip: 'One concrete result beats a feature list.',
        dialogue: {
          required: true,
          teleprompterText: "Now I finish in ten minutes and I'm not hunting for what I already said.",
        },
        editIntent: 'benefit',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'CTA',
        purpose: 'Soft ask',
        contentMode: 'dialogue',
        durationSeconds: isLongForm ? Math.round(targetDuration * 0.12) : 7,
        plainInstruction: 'Hold the last line, then smile. Still recording.',
        directorTip: 'End like a friend, not a commercial.',
        dialogue: {
          required: true,
          teleprompterText: "If you're in the same loop, try it once this week.",
        },
        editIntent: 'cta',
        delivery: { speakingPace: 'natural', lookAtCamera: true },
        directorCues: [{ kind: 'SMILE', holdMs: 1800 }],
      }),
    ];
    return finalizeDynamic(
      {
        title: 'UGC take',
        logline: idea,
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || (isLongForm ? '16:9' : '9:16'),
        musicMood: 'Upbeat Social',
        creativeBrief: {
          ...briefBase,
          contentType: 'ugc_ad',
          visualPriority: 'low',
          dialoguePriority: 'high',
          teleprompterRequired: true,
          naturalAudioImportance: 'low',
          creatorPresence: 'constant',
          narrativeStructure: 'hook → problem → product → benefit → CTA',
          storytellingMode: 'direct_to_camera',
          editingStrategy: 'jump_cut_social',
          pacing: 'punchy',
        },
        scenes,
      },
      'ugc_ad',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  if (type === 'workout') {
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Quick goal',
        purpose: 'State the workout goal',
        contentMode: 'dialogue',
        durationSeconds: 5,
        plainInstruction: 'Face the camera at chest height. Hold the kettlebell at your side. Say one short line, then start.',
        directorTip: 'Keep the intro under five seconds — action sells the workout.',
        dialogue: {
          required: true,
          teleprompterText: "Five minutes. Three moves. Beginners, grab a light kettlebell.",
        },
        visual: { action: 'Creator faces camera holding kettlebell', framing: 'waist-up', camera: 'phone at eye level' },
        editIntent: 'hook',
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Goblet squat demo',
        purpose: 'Show one clean goblet squat',
        contentMode: 'visual_only',
        durationSeconds: 8,
        plainInstruction: 'Film from the side. Do one slow goblet squat. No talking.',
        directorTip: 'Show one clean repetition from the side.',
        visual: { action: 'Kettlebell goblet squat', framing: 'full body side', camera: 'phone on a chair or held by a friend' },
        naturalAudio: 'Feet on floor, breath',
        onScreenText: '3 × 8',
        editIntent: 'demonstration',
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Kettlebell swing',
        purpose: 'Demonstrate swing hip hinge',
        contentMode: 'natural_audio',
        durationSeconds: 8,
        plainInstruction: 'Same side angle. Two controlled swings. Stay quiet.',
        directorTip: 'Hips drive the weight — keep the camera locked off.',
        visual: { action: 'Kettlebell swing', framing: 'full body', movement: 'static camera' },
        naturalAudio: 'Breathing + kettlebell whoosh',
        onScreenText: '3 × 10',
        editIntent: 'demonstration',
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Common mistake',
        purpose: 'Show wrong vs right posture briefly',
        contentMode: 'mixed',
        durationSeconds: 6,
        plainInstruction: 'Quick front angle. Show rounded back once, then the correct hinge. Optional one-line VO later.',
        directorTip: 'Exaggerating the mistake for half a second is enough.',
        visual: { action: 'Wrong then right hinge', framing: 'side mid-shot' },
        voiceover: { required: true, text: 'Hinge at the hips — not a squat.' },
        editIntent: 'explanation',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'Finish sequence',
        purpose: 'End with effort and a timer feel',
        contentMode: 'natural_audio',
        durationSeconds: 8,
        plainInstruction: 'Front angle. Finish the last reps. Keep recording two seconds after you set the bell down.',
        directorTip: 'Breathing and music carry this — no speech needed.',
        visual: { action: 'Final reps then rest', framing: 'waist-up' },
        naturalAudio: 'Breathing + music',
        onScreenText: 'Done',
        editIntent: 'ending',
      }),
    ];
    return finalizeDynamic(
      {
        title: '5-Minute Beginner Kettlebell',
        logline: 'A short action-led kettlebell session — mostly visual demos, minimal talk.',
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || '9:16',
        musicMood: 'Driving Workout',
        creativeBrief: {
          ...briefBase,
          contentType: 'workout',
          visualPriority: 'very_high',
          dialoguePriority: 'low',
          narrativeStructure: 'goal → setup → exercises → technique → finish',
          creatorPresence: 'frequent',
        },
        scenes,
      },
      'workout',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  if (type === 'gardening') {
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Show the result',
        purpose: 'Open on healthy tomato plants or bed',
        contentMode: 'visual_only',
        durationSeconds: 4,
        plainInstruction: 'Wide shot of the garden bed or tomatoes. Hold still. No talking.',
        directorTip: 'Start with the payoff so people know where this is going.',
        visual: { action: 'Wide of finished planting', framing: 'wide', environment: 'garden' },
        naturalAudio: 'Birds / outdoor ambience',
        editIntent: 'hook',
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Materials',
        purpose: 'Lay out soil, seedlings, tools',
        contentMode: 'visual_only',
        durationSeconds: 5,
        plainInstruction: 'Top-down on soil bag, seedlings, trowel. Hands arrange them. Silent.',
        directorTip: 'Keep this shot quiet. Focus on texture.',
        visual: { action: 'Hands arrange materials', framing: 'close-up top-down', camera: 'phone above workspace' },
        naturalAudio: 'Soil bag rustle',
        editIntent: 'context',
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Prepare the bed',
        purpose: 'Add soil into the bed',
        contentMode: 'visual_only',
        durationSeconds: 6,
        plainInstruction: 'Close-up on hands placing soil into the bed. No dialogue.',
        directorTip: 'Focus on the hands and the texture of the soil.',
        visual: { action: 'Creator places soil into bed', framing: 'close-up hands', camera: 'angled down' },
        naturalAudio: 'Soil / tools',
        editIntent: 'demonstration',
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Plant the seedling',
        purpose: 'Plant one tomato seedling',
        contentMode: 'visual_only',
        durationSeconds: 7,
        plainInstruction: 'Move closer. Capture hands planting the seedling. Hold two seconds after it is set.',
        directorTip: 'Now move closer and capture the hands planting the seedling.',
        visual: { action: 'Planting seedling', framing: 'close-up', movement: 'slow' },
        naturalAudio: 'Soil packing',
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'Water',
        purpose: 'Water the new plant',
        contentMode: 'natural_audio',
        durationSeconds: 5,
        plainInstruction: 'Side angle. Water gently. Silent except water sound.',
        directorTip: 'Let the water be the audio.',
        visual: { action: 'Watering can pour', framing: 'mid' },
        naturalAudio: 'Water on soil',
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 6,
        title: 'Quick tip to camera',
        purpose: 'One short spoken tip',
        contentMode: 'dialogue',
        durationSeconds: 5,
        plainInstruction: 'Look into the camera for the next sentence. Soft daylight on your face.',
        directorTip: 'One tip only — then back to visuals.',
        dialogue: {
          required: true,
          teleprompterText: "Don't bury the stem too deep. Leave the top leaves clear.",
        },
        visual: { action: 'Creator to camera', framing: 'chest-up' },
        editIntent: 'explanation',
      }),
      sceneUnit({
        sceneNumber: 7,
        title: 'Final reveal',
        purpose: 'Wide of planted bed',
        contentMode: 'visual_only',
        durationSeconds: 4,
        plainInstruction: 'Step back for a wide of the whole bed. No talking.',
        directorTip: 'End on the result you opened with.',
        visual: { action: 'Wide planted bed', framing: 'wide' },
        editIntent: 'payoff',
      }),
    ];
    return finalizeDynamic(
      {
        title: 'Planting Tomatoes',
        logline: 'A visual-first garden plant — soil, hands, seedling, water, short tip.',
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || '9:16',
        musicMood: 'Warm Acoustic',
        creativeBrief: {
          ...briefBase,
          contentType: 'gardening',
          narrativeStructure: 'result → materials → prep → planting → progress → result',
          visualPriority: 'very_high',
        },
        scenes,
      },
      'gardening',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  if (type === 'diy_build' || type === 'woodworking') {
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Finished object',
        purpose: 'Show the completed planter/bed',
        contentMode: 'visual_only',
        durationSeconds: 4,
        plainInstruction: 'Wide shot of the finished wooden planter. Orbit slowly or hold still. Silent.',
        directorTip: 'Open on the finished object so the build has a destination.',
        visual: { action: 'Reveal finished planter', framing: 'wide', environment: 'yard/workshop' },
        editIntent: 'hook',
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Materials',
        purpose: 'Show lumber and hardware',
        contentMode: 'visual_only',
        durationSeconds: 5,
        plainInstruction: 'Top-down on boards, screws, drill. Hands tap each piece. No talking.',
        directorTip: 'Get a wide of materials first, then closer on the wood grain.',
        visual: { action: 'Lay out materials', framing: 'top-down' },
        naturalAudio: 'Wood / tools',
        editIntent: 'context',
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Cut / measure',
        purpose: 'Measure and mark a board',
        contentMode: 'visual_only',
        durationSeconds: 6,
        plainInstruction: 'Close on hands measuring and marking. Silent.',
        directorTip: 'Keep this shot quiet. Focus on the hands.',
        visual: { action: 'Measuring board', framing: 'close-up hands' },
        naturalAudio: 'Tape measure',
        editIntent: 'demonstration',
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Assembly',
        purpose: 'Screw first corner',
        contentMode: 'natural_audio',
        durationSeconds: 8,
        plainInstruction: 'Mid shot of drilling/screwing a corner. Natural tool sound only.',
        directorTip: 'Repeat that movement once more, but slower.',
        visual: { action: 'Assembling corner', framing: 'mid', camera: 'phone on tripod' },
        naturalAudio: 'Drill',
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'Setback',
        purpose: 'Show a misaligned piece then fix',
        contentMode: 'mixed',
        durationSeconds: 6,
        plainInstruction: 'Show the gap/mistake, then the fix. Optional short VO later.',
        directorTip: 'Problem then solution — viewers feel progress.',
        visual: { action: 'Misalign then correct', framing: 'close-up' },
        voiceover: { required: true, text: 'This corner was off — one shim fixed it.' },
        editIntent: 'reaction',
      }),
      sceneUnit({
        sceneNumber: 6,
        title: 'Progress',
        purpose: 'Frame mostly assembled',
        contentMode: 'visual_only',
        durationSeconds: 5,
        plainInstruction: 'Step back. Whole frame coming together. Silent.',
        directorTip: 'Show progress, not every screw.',
        visual: { action: 'Mostly built frame', framing: 'wide' },
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 7,
        title: 'Reveal',
        purpose: 'Match opening shot of finished piece',
        contentMode: 'visual_only',
        durationSeconds: 4,
        plainInstruction: 'Same angle as scene 1. Finished planter. Hold two seconds after you stop moving.',
        directorTip: 'Keep recording for two seconds after the action finishes.',
        visual: { action: 'Final reveal', framing: 'wide' },
        editIntent: 'payoff',
      }),
      sceneUnit({
        sceneNumber: 8,
        title: 'One tip',
        purpose: 'Optional spoken takeaway',
        contentMode: 'dialogue',
        durationSeconds: 5,
        plainInstruction: 'Look into the camera for the next sentence.',
        directorTip: 'Only talk if it helps — one tip is enough.',
        dialogue: {
          required: true,
          teleprompterText: "Pre-drill soft wood. Saves you from splitting the boards.",
        },
        visual: { action: 'To camera', framing: 'chest-up' },
        editIntent: 'cta',
      }),
    ];
    return finalizeDynamic(
      {
        title: 'Building a Wooden Planter',
        logline: 'Transformation build — finished object, materials, construction, fix, reveal.',
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || '9:16',
        musicMood: 'Maker Focus',
        creativeBrief: {
          ...briefBase,
          contentType: 'diy_build',
          narrativeStructure: 'finished → materials → construction → setback → solution → reveal',
          visualPriority: 'very_high',
        },
        scenes,
      },
      'diy_build',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  if (type === 'tutorial' || type === 'cooking') {
    // pour-over / process tutorial — visual-led
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Finished cup',
        purpose: 'Open on the finished pour-over',
        contentMode: 'visual_only',
        durationSeconds: 3,
        plainInstruction: 'Close-up of the finished mug steaming. Silent.',
        directorTip: 'Start with the result.',
        visual: { action: 'Steaming mug', framing: 'close-up', environment: 'kitchen' },
        editIntent: 'hook',
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Gear',
        purpose: 'Show dripper, kettle, beans',
        contentMode: 'visual_only',
        durationSeconds: 5,
        plainInstruction: 'Top-down on dripper, gooseneck kettle, beans. Hands place them. No talking.',
        directorTip: 'Quiet shot — texture of beans and metal.',
        visual: { action: 'Arrange gear', framing: 'top-down' },
        naturalAudio: 'Kitchen ambience',
        editIntent: 'context',
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Grind & bloom',
        purpose: 'Bloom the grounds',
        contentMode: 'natural_audio',
        durationSeconds: 8,
        plainInstruction: 'Angle down on the dripper. Pour the bloom. Stay silent.',
        directorTip: 'Let the pour be the visual.',
        visual: { action: 'Pour bloom', framing: 'close-up', camera: 'phone tilted down' },
        naturalAudio: 'Water on grounds',
        onScreenText: '45s bloom',
        editIntent: 'demonstration',
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Main pour',
        purpose: 'Circular pour to finish',
        contentMode: 'visual_only',
        durationSeconds: 8,
        plainInstruction: 'Same angle. Slow circular pour until the kettle is empty enough. No dialogue.',
        directorTip: 'Keep hands and kettle in frame.',
        visual: { action: 'Circular pour', framing: 'close-up hands' },
        naturalAudio: 'Pouring water',
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'First sip',
        purpose: 'Taste reaction',
        contentMode: 'natural_audio',
        durationSeconds: 5,
        plainInstruction: 'Chest height. Sip. Genuine reaction. Optional one soft line after.',
        directorTip: 'That post-sip face matters more than a slogan.',
        visual: { action: 'Sip', framing: 'chest-up' },
        naturalAudio: 'Quiet kitchen',
        editIntent: 'reaction',
      }),
      sceneUnit({
        sceneNumber: 6,
        title: 'One line',
        purpose: 'Optional spoken close',
        contentMode: 'dialogue',
        durationSeconds: 4,
        plainInstruction: 'Look into the camera for the next sentence.',
        directorTip: 'Land the feeling, not a slogan.',
        dialogue: {
          required: true,
          teleprompterText: "Five minutes. Then the day can wait.",
        },
        visual: { action: 'To camera with mug', framing: 'chest-up' },
        editIntent: 'ending',
      }),
    ];
    return finalizeDynamic(
      {
        title: 'Morning Pour-Over',
        logline: 'Process-led coffee ritual — mostly hands and pour, light dialogue.',
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || '9:16',
        musicMood: 'Chill Lo-Fi',
        creativeBrief: {
          ...briefBase,
          contentType: type === 'cooking' ? 'cooking' : 'tutorial',
          narrativeStructure: 'result → ingredients → prep → process → sip → close',
          visualPriority: 'high',
          dialoguePriority: 'low',
        },
        scenes,
      },
      type === 'cooking' ? 'cooking' : 'tutorial',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  if (type === 'travel') {
    const scenes = [
      sceneUnit({
        sceneNumber: 1,
        title: 'Destination hook',
        purpose: 'Establish Rome energy',
        contentMode: 'visual_only',
        durationSeconds: 4,
        plainInstruction: 'Wide of a landmark or street. Hold. Silent.',
        directorTip: 'Get a wide shot of the place first.',
        visual: { action: 'Wide city establishing', framing: 'wide', environment: 'Rome street' },
        naturalAudio: 'City ambience',
        editIntent: 'hook',
      }),
      sceneUnit({
        sceneNumber: 2,
        title: 'Place one',
        purpose: 'First loved place',
        contentMode: 'mixed',
        durationSeconds: 8,
        plainInstruction: 'Walk toward the spot, then one short line to camera.',
        directorTip: 'Show the place before you talk about it.',
        visual: { action: 'Approach location', framing: 'walking mid' },
        dialogue: {
          required: true,
          teleprompterText: "First stop — this quiet corner at golden hour.",
        },
        editIntent: 'context',
      }),
      sceneUnit({
        sceneNumber: 3,
        title: 'Details',
        purpose: 'Texture details',
        contentMode: 'visual_only',
        durationSeconds: 5,
        plainInstruction: 'Close-ups: stone, food, sign. No talking.',
        directorTip: 'Details sell travel better than a monologue.',
        visual: { action: 'Detail montage clips', framing: 'close-up' },
        naturalAudio: 'Street sound',
        editIntent: 'broll',
      }),
      sceneUnit({
        sceneNumber: 4,
        title: 'Place two',
        purpose: 'Second place experience',
        contentMode: 'voiceover',
        durationSeconds: 7,
        plainInstruction: 'Film you walking/experiencing. Add VO later if needed — stay quiet on camera.',
        directorTip: 'Capture the experience; words can wait.',
        visual: { action: 'Experience second place', framing: 'mid' },
        voiceover: { required: true, text: 'Number two felt local — less postcard, more neighborhood.' },
        editIntent: 'progression',
      }),
      sceneUnit({
        sceneNumber: 5,
        title: 'Place three + payoff',
        purpose: 'Third place and close',
        contentMode: 'dialogue',
        durationSeconds: 7,
        plainInstruction: 'At the third spot, look into the camera for the closing thought.',
        directorTip: 'End on feeling, not a list.',
        dialogue: {
          required: true,
          teleprompterText: "Third one's my favorite. Go at dusk if you can.",
        },
        visual: { action: 'To camera at final spot', framing: 'chest-up' },
        editIntent: 'payoff',
      }),
    ];
    return finalizeDynamic(
      {
        title: 'Three Places I Loved in Rome',
        logline: 'Hybrid travel — establishing visuals, short lines, detail shots.',
        estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
        videoFormat: isLongForm ? 'long-form' : 'short-form',
        aspectRatio: aspectRatio || '9:16',
        musicMood: 'Cinematic Warm',
        creativeBrief: {
          ...briefBase,
          contentType: 'travel',
          narrativeStructure: 'hook destination → establish → experience → details → payoff',
          visualPriority: 'high',
          dialoguePriority: 'medium',
          creatorPresence: 'intermittent',
          teleprompterRequired: true,
        },
        scenes,
      },
      'travel',
      idea,
      isLongForm,
      targetDuration,
      preferredCaptureStrategy
    );
  }

  // commentary / educational / talking_head / default — dialogue OK but spoken
  const isSleep = /sleep/i.test(idea);
  const scenes = [
    sceneUnit({
      sceneNumber: 1,
      title: isSleep ? 'Why it hits' : 'The open',
      purpose: 'Hook with a concrete claim',
      contentMode: 'dialogue',
      durationSeconds: isLongForm ? Math.round(targetDuration * 0.12) : 8,
      plainInstruction: 'Phone at eye level. Soft window light. Talk like a friend, not a lecture.',
      directorTip: 'Skip the welcome. Start on the thought.',
      dialogue: {
        required: true,
        teleprompterText: isSleep
          ? "I used to treat sleep like optional. Then my focus fell apart for a week straight."
          : "Here's the part nobody says out loud about this.",
      },
      visual: { action: 'Talking to camera', framing: 'chest-up' },
      editIntent: 'hook',
      delivery: { speakingPace: 'natural', lookAtCamera: true },
      directorCues: [{ kind: 'LOOK_AT_CAMERA', holdMs: 2200 }],
    }),
    sceneUnit({
      sceneNumber: 2,
      title: 'Context',
      purpose: 'Make the stakes clear',
      contentMode: 'dialogue',
      durationSeconds: isLongForm ? Math.round(targetDuration * 0.2) : 10,
      plainInstruction: 'Same framing. Small hand gestures. Pause between thoughts.',
      directorTip: 'Short sentences. Leave air.',
      dialogue: {
        required: true,
        teleprompterText: isSleep
          ? "Miss a few nights and mood slips first. Memory next. Your workouts feel heavier even when the weights don't change."
          : "Context first — then the one move that actually helped.",
      },
      visual: { action: 'Continue talking head', framing: 'chest-up' },
      editIntent: 'context',
      delivery: { speakingPace: 'natural', breathingPoint: true },
    }),
    sceneUnit({
      sceneNumber: 3,
      title: 'The point',
      purpose: 'Core argument / takeaway',
      contentMode: 'dialogue',
      durationSeconds: isLongForm ? Math.round(targetDuration * 0.35) : 12,
      plainInstruction: 'Lean slightly in. Keep eyes on the lens.',
      directorTip: 'One idea per breath.',
      dialogue: {
        required: true,
        teleprompterText: isSleep
          ? "Protect a wind-down. Same hour. Screens down. Dark room. Boring on purpose — that's the point."
          : "Do the boring version consistently. Fancy hacks can wait.",
      },
      visual: { action: 'Talking head emphasis', framing: 'closer chest-up' },
      editIntent: 'explanation',
      delivery: { speakingPace: 'natural', lookAtCamera: true },
    }),
    sceneUnit({
      sceneNumber: 4,
      title: 'Close',
      purpose: 'Takeaway + soft CTA',
      contentMode: 'dialogue',
      durationSeconds: isLongForm ? Math.round(targetDuration * 0.15) : 7,
      plainInstruction: 'Warm smile. Deliver the last line, then hold a beat.',
      directorTip: 'End like you finished a thought — not a pitch deck.',
      dialogue: {
        required: true,
        teleprompterText: isSleep
          ? "Try one earlier night this week. Tell me if your morning feels different."
          : "Try it once this week. Keep what works.",
      },
      visual: { action: 'Closing to camera', framing: 'chest-up' },
      editIntent: 'cta',
      delivery: { speakingPace: 'natural', lookAtCamera: true },
      directorCues: [{ kind: 'SMILE', holdMs: 1800 }],
    }),
  ];

  if (isLongForm) {
    scenes.splice(
      3,
      0,
      sceneUnit({
        sceneNumber: 4,
        chapterTitle: 'Evidence',
        title: 'What I noticed',
        purpose: 'Evidence beat',
        contentMode: 'dialogue',
        durationSeconds: Math.round(targetDuration * 0.18),
        plainInstruction: 'Same seat. Conversational.',
        directorTip: 'Specific beats abstract every time.',
        dialogue: {
          required: true,
          teleprompterText:
            "Week two, my afternoon crash got quieter. Not magic — just fewer foggy decisions.",
        },
        editIntent: 'explanation',
      })
    );
    scenes.forEach((s, i) => {
      s.sceneNumber = i + 1;
    });
  }

  return finalizeDynamic(
    {
      title: isSleep ? 'Why Sleep Actually Matters' : 'Straight Talk',
      logline: idea,
      estimatedTotalSeconds: scenes.reduce((a, s) => a + s.durationSeconds, 0),
      videoFormat: isLongForm ? 'long-form' : 'short-form',
      aspectRatio: aspectRatio || (isLongForm ? '16:9' : '9:16'),
      musicMood: 'Warm Acoustic',
      creativeBrief: {
        ...briefBase,
        contentType: type === 'hybrid' ? (isSleep ? 'educational' : 'commentary') : type,
        visualPriority: 'low',
        dialoguePriority: 'high',
        teleprompterRequired: true,
        naturalAudioImportance: 'low',
        creatorPresence: 'constant',
        narrativeStructure: 'hook → context → argument → takeaway → CTA',
      },
      scenes,
    },
    type === 'hybrid' ? (isSleep ? 'educational' : 'commentary') : type,
    idea,
    isLongForm,
    targetDuration,
    preferredCaptureStrategy
  );
}

/**
 * After single_take collapse: one Gemini pass rewrites joined beats into one voice.
 * Collapsed takes keep \\n\\n beat markers; multi-scene plans use ===BEAT n=== markers.
 */
export async function flowPassVoiceRewrite(
  plan: any,
  ai: { models: { generateContent: (opts: any) => Promise<{ text?: string }> } },
  model = 'gemini-flash-latest'
): Promise<any> {
  const strategy = plan?.creativeBrief?.captureStrategy || plan?.captureStrategy;
  if (strategy !== 'single_take') return plan;
  const scenes: any[] = Array.isArray(plan?.scenes) ? plan.scenes : [];

  // Common path: collapse joined beats with \n\n into one main take
  const main = scenes.find(
    (s) =>
      s.filmedBy !== 'ai' &&
      s.mediaRole !== 'overlay' &&
      s.mediaRole !== 'cutaway' &&
      (cleanTeleprompter(s.teleprompterPrompt) || cleanTeleprompter(s.dialogue?.teleprompterText))
  );
  const mainJoined =
    (main &&
      (cleanTeleprompter(main.teleprompterPrompt) ||
        cleanTeleprompter(main.dialogue?.teleprompterText))) ||
    '';
  if (main && mainJoined.includes('\n\n')) {
    return runTeleprompterFlowPass(ai, plan, {
      idea: plan?.logline,
      style: plan?.creativeBrief?.tone,
      model,
    });
  }

  // Fallback: multiple spoken scenes still present
  const spokenIdx: number[] = [];
  const parts: string[] = [];
  scenes.forEach((s, i) => {
    const line =
      cleanTeleprompter(s.teleprompterPrompt) ||
      cleanTeleprompter(s.dialogue?.teleprompterText);
    if (!line) return;
    spokenIdx.push(i);
    parts.push(`===BEAT ${spokenIdx.length} (${s.title || `Scene ${i + 1}`})===\n${line}`);
  });
  if (parts.length < 2) return plan;

  const joined = parts.join('\n\n');
  try {
    const response = await ai.models.generateContent({
      model,
      contents: `Rewrite this multi-beat teleprompter into ONE continuous creator monologue — same voice talking to one friend. Keep the ===BEAT n=== markers and the same number of beats. Soften any corporate / lecture tone. Do not add new beats or remove beats.

${buildHumanVoiceStyleBlock()}

SCRIPT:
${joined}`,
      config: { responseMimeType: 'text/plain' },
    });
    const text = String(response?.text || '').trim();
    if (!text) return plan;

    const beatBlocks = text.split(/===BEAT\s+\d+[^=]*===/i).map((b) => b.trim()).filter(Boolean);
    const re = /===BEAT\s+(\d+)[^=]*===\s*([\s\S]*?)(?===BEAT\s+\d+|$)/gi;
    const extracted: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      extracted.push(m[2].trim());
    }
    const lines = extracted.length >= spokenIdx.length ? extracted : beatBlocks;
    if (lines.length < spokenIdx.length) return plan;

    const nextScenes = scenes.map((s: any, i: number) => {
      const pos = spokenIdx.indexOf(i);
      if (pos < 0) return s;
      const rewritten = cleanTeleprompter(lines[pos]);
      if (!rewritten) return s;
      return {
        ...s,
        teleprompterPrompt: rewritten,
        dialogue: {
          ...(s.dialogue || {}),
          required: true,
          teleprompterText: rewritten,
        },
      };
    });
    console.log(`[flow-pass] rewrote ${spokenIdx.length} spoken beats into one voice`);
    return { ...plan, scenes: nextScenes };
  } catch (err: any) {
    console.warn('[flow-pass] skipped:', err?.message || err);
    return plan;
  }
}
