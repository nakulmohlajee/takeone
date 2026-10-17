/**
 * Separate story beats from camera recordings.
 * Gemini scenes are creative units. This module owns structure.
 */
import type {
  CaptureStrategy,
  CaptureUnit,
  ContentType,
  DirectorCue,
  ProductionPrefs,
  SceneRecipe,
  NarrativeBeat,
} from '../../src/types/director';
import { UGC_SAFE_CUES } from '../../src/types/director';

const UGC_TYPES = new Set<string>([
  'ugc_ad',
  'talking_head',
  'commentary',
  'educational',
  'interview',
]);

const VISUAL_MULTI_SHOT = new Set<string>([
  'workout',
  'gardening',
  'cooking',
  'diy_build',
  'woodworking',
  'travel',
  'transformation',
  'product_demo',
  'cinematic_montage',
]);

const CAPTURE_STRATEGIES: CaptureStrategy[] = [
  'single_take',
  'multi_take',
  'montage',
  'multi_shot',
];

const VISUAL_IDEA =
  /\b(plants?|garden|jungle|succulent|houseplant|watering|collection|workout|cook|recipe|diy|build|travel|montage|hands|room full|living room|care for)\b/i;

const COLLAPSE_COPY = /one continuous recording/i;

export function isVisualFirstContent(contentType: string, idea?: string): boolean {
  const type = String(contentType || '').toLowerCase();
  if (type === 'ugc_ad') return false;
  if (VISUAL_MULTI_SHOT.has(type) || type === 'cinematic_montage') return true;
  return VISUAL_IDEA.test(String(idea || ''));
}

const STRONG_UGC_AD =
  /\b(ugc(\s+ad)?|testimonial|direct([ -]?to[ -]?camera)|to camera|product recommendation|app (ad|advert)|advertisement|sponsor(ed)? (ad|post)|ugc ad)\b/i;

export function isUgcAdContent(contentType: string, idea?: string): boolean {
  const type = String(contentType || '').toLowerCase();
  if (type === 'ugc_ad' || type === 'product_demo') return true;
  if (VISUAL_MULTI_SHOT.has(type)) return false;
  return STRONG_UGC_AD.test(String(idea || ''));
}

export function explicitMultiShotRequest(idea?: string, preferred?: string): boolean {
  if (preferred === 'multi_shot') return true;
  return /\b(multi[ -]?shot|several shots|different angles|change camera|multiple setups)\b/i.test(
    String(idea || '')
  );
}

/** Map the creator's shot-budget preference to a capture strategy. */
export function captureStrategyFromShotsPref(
  shots?: ProductionPrefs['shots'] | string | null
): CaptureStrategy | null {
  if (shots === 'one_take') return 'single_take';
  if (shots === 'few') return 'multi_take';
  if (shots === 'cinematic') return 'multi_shot';
  return null;
}

export function inferCaptureStrategy(opts: {
  contentType: string;
  isLongForm: boolean;
  targetDuration: number;
  idea?: string;
  style?: string;
  prefs?: ProductionPrefs | null;
  preferredCaptureStrategy?: string | null;
}): CaptureStrategy {
  const type = String(opts.contentType || '').toLowerCase();
  const idea = `${opts.idea || ''} ${opts.style || ''}`.toLowerCase();

  // Creator choice wins: prefs.shots, then an explicit preferred strategy.
  const fromPrefs = captureStrategyFromShotsPref(opts.prefs?.shots);
  if (fromPrefs) return fromPrefs;
  const preferred = String(opts.preferredCaptureStrategy || '').trim();
  if (CAPTURE_STRATEGIES.includes(preferred as CaptureStrategy)) {
    return preferred as CaptureStrategy;
  }

  if (type === 'cinematic_montage') return 'montage';
  if (
    type === 'ugc_ad' ||
    type === 'product_demo' ||
    isUgcAdContent(type, idea)
  ) {
    if (opts.isLongForm && opts.targetDuration > 180) return 'multi_take';
    return 'single_take';
  }
  // Short-form defaults to one take unless the creator explicitly asked for cinematic coverage.
  if (VISUAL_MULTI_SHOT.has(type) || isVisualFirstContent(type, idea)) {
    if (!opts.isLongForm && opts.prefs?.shots !== 'cinematic') return 'single_take';
    return 'multi_shot';
  }

  const looksUgc =
    UGC_TYPES.has(type) ||
    /\b(ugc|testimonial|selfie|talking.?head|to camera|direct.to.camera|rant|review|i stopped|my story)\b/.test(
      idea
    );

  const looksVisualHowTo =
    type === 'tutorial' &&
    /\b(cook|recipe|diy|build|plant|garden|workout|hands|step.?by.?step demo)\b/.test(idea);

  if (looksVisualHowTo) return !opts.isLongForm && opts.prefs?.shots !== 'cinematic' ? 'single_take' : 'multi_shot';

  if (type === 'tutorial' && !looksVisualHowTo && !opts.isLongForm) {
    return 'single_take';
  }

  if (looksUgc || type === 'hybrid') {
    if (opts.isLongForm && opts.targetDuration > 180) return 'multi_take';
    return 'single_take';
  }

  return opts.isLongForm ? 'multi_shot' : 'single_take';
}

export function coerceCaptureStrategy(raw: unknown, fallback: CaptureStrategy): CaptureStrategy {
  const s = String(raw || '').trim();
  return CAPTURE_STRATEGIES.includes(s as CaptureStrategy) ? (s as CaptureStrategy) : fallback;
}

function beatId(idx: number): string {
  return `beat-${idx + 1}`;
}

function unitId(idx: number): string {
  return `capture-${idx + 1}`;
}

function spokenFrom(s: any): string {
  return String(s?.teleprompterPrompt || s?.dialogue?.teleprompterText || '').trim();
}

function hasDistinctVisual(s: any): boolean {
  const v = s?.visual || {};
  const blob = `${v.action || ''} ${v.camera || ''} ${v.framing || ''} ${s?.plainInstruction || ''}`;
  if (v.action && (v.camera || v.framing)) return true;
  if (s?.contentMode === 'visual_only' || s?.contentMode === 'natural_audio') return true;
  return /close-?up|macro|wide|top-?down|montage|hands|mist|pan|leaf|soil|collection|side angle|chest/i.test(
    blob
  );
}

function instructionFrom(s: any, durationSeconds: number): string {
  const raw = String(s?.plainInstruction || '').trim();
  if (raw && !COLLAPSE_COPY.test(raw)) return raw;
  const v = s?.visual || {};
  const parts: string[] = [];
  if (v.action) parts.push(String(v.action));
  if (v.camera || v.framing) {
    parts.push(`Phone: ${[v.camera, v.framing].filter(Boolean).join(', ')}.`);
  }
  if (v.movement) parts.push(String(v.movement));
  parts.push(`Hold about ${durationSeconds}s, then stop.`);
  return parts.join(' ') || `Capture this shot for about ${durationSeconds} seconds.`;
}

function cuesFromScene(s: any, beatIdValue: string): DirectorCue[] {
  const cues: DirectorCue[] = [];
  const raw = Array.isArray(s.directorCues) ? s.directorCues : [];
  for (const c of raw) {
    if (!c) continue;
    cues.push({
      kind: String(c.kind || c),
      label: c.label,
      atBeatId: c.atBeatId || beatIdValue,
      afterPhraseIndex: typeof c.afterPhraseIndex === 'number' ? c.afterPhraseIndex : undefined,
      holdMs: typeof c.holdMs === 'number' ? c.holdMs : 2200,
    });
  }
  if (s.delivery?.lookAtCamera || /look (into|at) the camera/i.test(String(s.plainInstruction || ''))) {
    if (!cues.some((c) => String(c.kind).toUpperCase() === 'LOOK_AT_CAMERA')) {
      cues.push({ kind: 'LOOK_AT_CAMERA', atBeatId: beatIdValue, holdMs: 2200 });
    }
  }
  if (s.delivery?.breathingPoint) {
    cues.push({ kind: 'PAUSE', label: 'Breathe', atBeatId: beatIdValue, holdMs: 1800 });
  }
  if (
    !spokenFrom(s) &&
    (s.contentMode === 'visual_only' || s.contentMode === 'natural_audio') &&
    !cues.some((c) => String(c.kind).toUpperCase() === 'START_ACTION')
  ) {
    cues.push({ kind: 'START_ACTION', atBeatId: beatIdValue, holdMs: 2500 });
  }
  return cues;
}

function filterUgcCues(cues: DirectorCue[]): DirectorCue[] {
  const allow = new Set(UGC_SAFE_CUES.map((k) => String(k)));
  return cues.filter((c) => allow.has(String(c.kind || '').toUpperCase()));
}

function isInsertLikeScene(s: any): boolean {
  if (s.filmedBy === 'ai' || s.mediaRole === 'overlay' || s.mediaRole === 'cutaway') return true;
  if (s.mediaPlan?.kind && s.mediaPlan.kind !== 'none') return true;
  if (spokenFrom(s)) return false;
  if (s.contentMode === 'visual_only' || s.contentMode === 'natural_audio') return true;
  if (s.editIntent === 'broll') return true;
  const blob = `${s.title || ''} ${s.purpose || ''} ${s.visual?.action || ''} ${s.plainInstruction || ''}`;
  return /close-?up|app screen|hands|reveal|insert|b-?roll|product shot/i.test(blob);
}

/** Only invent optional inserts when the idea/hints explicitly ask for them.
 * Note: preferOverlays alone does NOT qualify — that drives mediaPlan overlays from Gemini,
 * not auto-invented product B-roll via recommendUgcInserts.
 */
export function ideaAsksForInserts(
  idea?: string,
  briefHints?: Record<string, unknown> | null
): boolean {
  const hints = briefHints && typeof briefHints === 'object' ? briefHints : {};
  if (Array.isArray(hints.mustInclude)) {
    const must = hints.mustInclude.map((x) => String(x).toLowerCase()).join(' ');
    if (/\b(insert|b-?roll|overlay|cutaway|green\s*screen|product|close-?up)\b/.test(must)) {
      return true;
    }
  }
  // Check idea + answer text only — avoid matching the key name "preferOverlays"
  const answerText = Array.isArray((hints as any).answers)
    ? (hints as any).answers.map((a: any) => `${a?.id || ''} ${a?.answer || ''}`).join(' ')
    : '';
  const blob = `${idea || ''} ${answerText}`.toLowerCase();
  return /\b(inserts?|b-?roll|product (close-?up|shot)|app screen|optional inserts?|show the (app|product)|cutaways?|overlays?|green\s*screen|picture.?in.?picture|\bpip\b)\b/.test(
    blob
  );
}

function recommendUgcInserts(idea: string): any[] {
  const k = String(idea || '').toLowerCase();
  const product = /\b(app|product|recommend|shop|brand)\b/.test(k);
  const inserts: any[] = [
    {
      title: product ? 'Product / app close-up' : 'Detail insert',
      purpose: 'Optional insert — product or app screen',
      contentMode: 'visual_only',
      durationSeconds: 5,
      plainInstruction:
        'Optional. After the main take, film a 3–5s close-up of the product or app screen. Phone over the object. No talking. Skip if you only want the talking take.',
      directorTip: 'This is B-roll. The ad still works without it.',
      visual: { action: 'Close-up of product or app', framing: 'tight', camera: 'overhead or close handheld' },
      editIntent: 'broll',
      dialogue: { required: false, teleprompterText: null },
      filmedBy: 'user',
      mediaRole: 'cutaway',
      includeInExport: false,
      optionalInsert: true,
    },
  ];
  if (product) {
    inserts.push({
      title: 'Hands using it',
      purpose: 'Optional insert — hands on product',
      contentMode: 'visual_only',
      durationSeconds: 5,
      plainInstruction:
        'Optional. Film your hands using the product or tapping the app for 3–5 seconds. No talking.',
      directorTip: 'Keep it simple — one action.',
      visual: { action: 'Hands using product', framing: 'hands close-up' },
      editIntent: 'broll',
      dialogue: { required: false, teleprompterText: null },
      filmedBy: 'user',
      mediaRole: 'cutaway',
      includeInExport: false,
      optionalInsert: true,
    });
  }
  return inserts.slice(0, 3);
}

/** Merge SceneRecipes from several beats into one (used when beats collapse into a single take). */
export function mergeSceneRecipes(scenes: any[]): SceneRecipe | undefined {
  const recipes = scenes
    .map((s) => s?.recipe as SceneRecipe | undefined)
    .filter((r): r is SceneRecipe => Boolean(r) && typeof r === 'object');
  if (!recipes.length) return undefined;
  const layoutPriority: SceneRecipe['layout'][] = ['virtual_background', 'split', 'pip', 'talking_head'];
  const layout =
    layoutPriority.find((l) => recipes.some((r) => r.layout === l)) || recipes[0].layout;
  const background = recipes.find((r) => r.background?.prompt)?.background;
  // Anchors are phrase-based, so merging across beats preserves timing intent.
  const merged: SceneRecipe = {
    layout,
    ...(background ? { background } : {}),
    inserts: recipes.flatMap((r) => r.inserts || []),
    punchIns: recipes.flatMap((r) => r.punchIns || []),
    transitionOut: recipes[recipes.length - 1].transitionOut || 'cut',
  };
  return merged;
}

/**
 * Fold adjacent filmed scenes into at most `maxSetups` capture setups (balanced by spoken length).
 * Insert-like scenes (AI media, b-roll) stay separate. Used instead of a model repair call when
 * the plan has more setups than the creator's shot budget.
 */
export function mergeScenesToShotBudget(scenesIn: any[], maxSetups: number): any[] {
  const filmedIdx = scenesIn
    .map((s, i) => (isInsertLikeScene(s) ? -1 : i))
    .filter((i) => i >= 0);
  if (maxSetups < 1 || filmedIdx.length <= maxSetups) return scenesIn;

  const weight = (s: any) =>
    Math.max(1, spokenFrom(s).split(/\s+/).filter(Boolean).length || Number(s.durationSeconds) || 5);
  const total = filmedIdx.reduce((a, i) => a + weight(scenesIn[i]), 0);
  const groups: number[][] = [];
  let current: number[] = [];
  let acc = 0;
  filmedIdx.forEach((sceneIdx, k) => {
    current.push(sceneIdx);
    acc += weight(scenesIn[sceneIdx]);
    const remainingScenes = filmedIdx.length - k - 1;
    const remainingGroups = maxSetups - groups.length - 1;
    const target = (total * (groups.length + 1)) / maxSetups;
    if (remainingGroups > 0 && (acc >= target || remainingScenes === remainingGroups)) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);

  const mergedByFirst = new Map<number, any>();
  const absorbed = new Set<number>();
  for (const g of groups) {
    if (g.length === 1) continue;
    const parts = g.map((i) => scenesIn[i]);
    const first = parts[0];
    const spoken = parts.map(spokenFrom).filter(Boolean).join('\n\n');
    const recipe = mergeSceneRecipes(parts);
    // Later beats' on-screen captions become text pops so they survive the merge.
    const textPops = parts.slice(1).flatMap((p) => {
      const text = String(p.onScreenText || '').trim();
      const words = spokenFrom(p).split(/\s+/).filter(Boolean);
      if (!text || words.length < 3) return [];
      return [{ kind: 'text_pop', anchorPhrase: words.slice(0, 5).join(' '), text: text.slice(0, 40) }];
    });
    const durationSeconds = parts.reduce((a, p) => a + (Number(p.durationSeconds) || 0), 0);
    mergedByFirst.set(g[0], {
      ...first,
      title: first.chapterTitle || first.title,
      durationSeconds: durationSeconds || first.durationSeconds,
      editZoom: Math.max(...parts.map((p) => Number(p.editZoom) || 1)),
      teleprompterPrompt: spoken || first.teleprompterPrompt,
      dialogue: { ...(first.dialogue || {}), required: Boolean(spoken), teleprompterText: spoken || null },
      plainInstruction: first.plainInstruction,
      purpose: parts.map((p) => p.title).filter(Boolean).join(' → '),
      directorCues: parts.flatMap((p) => (Array.isArray(p.directorCues) ? p.directorCues : [])),
      ...(recipe || textPops.length
        ? {
            recipe: {
              layout: 'talking_head',
              punchIns: [],
              transitionOut: 'cut',
              ...(recipe || {}),
              inserts: [...(recipe?.inserts || []), ...textPops] as any,
            },
          }
        : {}),
    });
    g.slice(1).forEach((i) => absorbed.add(i));
  }
  return scenesIn
    .map((s, i) => (absorbed.has(i) ? null : mergedByFirst.get(i) || s))
    .filter(Boolean);
}

export function beatsFromScenes(scenes: any[]): NarrativeBeat[] {
  return scenes.map((s, idx) => ({
    id: s.id || beatId(idx),
    title: String(s.title || `Beat ${idx + 1}`),
    purpose: s.purpose ? String(s.purpose) : undefined,
    contentMode: s.contentMode,
    editIntent: s.editIntent,
    dialogue: spokenFrom(s) || undefined,
    voiceover: s.voiceover?.text ? String(s.voiceover.text) : undefined,
    durationSeconds: Number(s.durationSeconds) || undefined,
    directorCues: cuesFromScene(s, s.id || beatId(idx)),
    delivery: s.delivery,
  }));
}

function groupBeatsByIntent(scenes: any[]): { beats: NarrativeBeat[]; beatIdByScene: string[] } {
  const beats: NarrativeBeat[] = [];
  const beatIdByScene: string[] = [];
  let current: NarrativeBeat | null = null;
  let currentIntent = '';

  scenes.forEach((s, idx) => {
    const intent = String(s.editIntent || `unit-${idx}`);
    const spoken = spokenFrom(s);
    if (!current || intent !== currentIntent) {
      const id = beatId(beats.length);
      current = {
        id,
        title: String(s.title || `Beat ${beats.length + 1}`),
        purpose: s.purpose ? String(s.purpose) : undefined,
        contentMode: s.contentMode,
        editIntent: s.editIntent,
        dialogue: spoken || undefined,
        voiceover: s.voiceover?.text ? String(s.voiceover.text) : undefined,
        durationSeconds: Number(s.durationSeconds) || undefined,
        directorCues: cuesFromScene(s, id),
        delivery: s.delivery,
      };
      beats.push(current);
      currentIntent = intent;
    } else if (current) {
      if (spoken) {
        current.dialogue = [current.dialogue, spoken].filter(Boolean).join('\n\n');
      }
      current.durationSeconds = (current.durationSeconds || 0) + (Number(s.durationSeconds) || 0);
    }
    beatIdByScene.push(current!.id);
  });

  return { beats, beatIdByScene };
}

function toCaptureUnit(s: any, idx: number, beatIds: string[]): CaptureUnit {
  const durationSeconds = Math.max(2, Number(s.durationSeconds) || 5);
  const spoken = spokenFrom(s);
  const dialogueRequired = Boolean(s.dialogue?.required && spoken);
  return {
    id: unitId(idx),
    title: String(s.title || `Shot ${idx + 1}`),
    beatIds,
    contentMode: s.contentMode,
    durationSeconds,
    instruction: instructionFrom(s, durationSeconds),
    camera: s.visual?.camera ? String(s.visual.camera) : undefined,
    framing: s.visual?.framing ? String(s.visual.framing) : undefined,
    action: s.visual?.action ? String(s.visual.action) : undefined,
    dialogueRequired,
    teleprompterRequired: dialogueRequired,
  };
}

function sceneFromCapture(s: any, capture: CaptureUnit, beats: NarrativeBeat[]): any {
  const related = beats.filter((b) => capture.beatIds.includes(b.id));
  const isAiMedia =
    s.filmedBy === 'ai' || s.mediaRole === 'overlay' || s.mediaRole === 'cutaway';
  const spoken =
    !isAiMedia && capture.dialogueRequired
      ? related.map((b) => b.dialogue).filter(Boolean).join('\n\n') || spokenFrom(s)
      : undefined;
  return {
    ...s,
    sceneNumber: s.sceneNumber,
    title: capture.title,
    // Preserve mediaPlan-derived filmedBy (do not force "user" for overlays/cutaways)
    filmedBy: isAiMedia ? 'ai' : s.filmedBy || 'user',
    durationSeconds: capture.durationSeconds,
    contentMode: isAiMedia ? s.contentMode || 'visual_only' : capture.contentMode || s.contentMode,
    plainInstruction: capture.instruction || instructionFrom(s, capture.durationSeconds),
    directorTip: String(s.directorTip || 'Keep it natural — authenticity beats perfection.'),
    ...(spoken ? { teleprompterPrompt: spoken } : isAiMedia ? {} : { teleprompterPrompt: undefined }),
    dialogue: {
      required: Boolean(spoken),
      teleprompterText: spoken || null,
    },
    narrativeBeatIds: capture.beatIds,
    captureUnitId: capture.id,
    directorCues: s.directorCues || related.flatMap((b) => b.directorCues || []),
    delivery: s.delivery || { speakingPace: 'natural' },
    optionalInsert: Boolean(capture.optional) || isAiMedia,
    includeInExport: capture.optional || isAiMedia ? false : s.includeInExport,
    mediaRole: s.mediaRole || (isAiMedia ? 'overlay' : 'capture'),
    ...(s.overlayLayout ? { overlayLayout: s.overlayLayout } : {}),
    ...(s.overlayParentSceneId ? { overlayParentSceneId: s.overlayParentSceneId } : {}),
    ...(s.aiGenerationPrompt ? { aiGenerationPrompt: s.aiGenerationPrompt } : {}),
    ...(s.insertKind ? { insertKind: s.insertKind } : {}),
    visual: s.visual || {
      action: capture.action,
      camera: capture.camera,
      framing: capture.framing,
    },
  };
}

function collapseUgcAd(
  scenesIn: any[],
  idea?: string,
  briefHints?: Record<string, unknown> | null
): {
  scenes: any[];
  narrativeBeats: NarrativeBeat[];
  captureUnits: CaptureUnit[];
  captureStrategy: CaptureStrategy;
} {
  const narrativeScenes = scenesIn.filter((s) => !isInsertLikeScene(s));
  const sourceBeats = narrativeScenes.length ? narrativeScenes : scenesIn.filter((s) => spokenFrom(s));
  const beatSource = sourceBeats.length ? sourceBeats : scenesIn;
  const narrativeBeats = beatsFromScenes(beatSource).map((b) => ({
    ...b,
    directorCues: filterUgcCues(b.directorCues || []),
  }));
  const durationSeconds = Math.max(
    12,
    beatSource.reduce((a, s) => a + (Number(s.durationSeconds) || 0), 0)
  );
  const spoken = narrativeBeats.map((b) => (b.dialogue || '').trim()).filter(Boolean).join('\n\n');
  const first = beatSource[0] || scenesIn[0] || {};
  const capture: CaptureUnit = {
    id: unitId(0),
    title: 'Main take',
    beatIds: narrativeBeats.map((b) => b.id),
    contentMode: 'dialogue',
    durationSeconds,
    instruction:
      'ONE CAMERA. ONE POSITION. ONE CONTINUOUS TAKE. Phone at eye level, chest-up. Speak the whole script without stopping between beats. TakeOne will cut it later.',
    camera: first.visual?.camera || 'front camera',
    framing: first.visual?.framing || 'chest-up talking head',
    action: 'Talk to camera through every beat',
    dialogueRequired: Boolean(spoken),
    teleprompterRequired: Boolean(spoken),
    optional: false,
    kind: 'main',
  };

  const mainScene = sceneFromCapture(
    {
      ...first,
      sceneNumber: 1,
      title: 'Main take',
      chapterTitle: 'Continuous performance',
      filmedBy: 'user',
      mediaRole: 'capture',
      purpose: narrativeBeats.map((b) => b.title).join(' → '),
      directorCues: filterUgcCues(narrativeBeats.flatMap((b) => b.directorCues || [])),
      delivery: { speakingPace: 'natural', lookAtCamera: true },
      ...(mergeSceneRecipes(beatSource) ? { recipe: mergeSceneRecipes(beatSource) } : {}),
      visual: {
        action: 'Talk to camera — do not change setup',
        camera: 'front camera, one position',
        framing: 'chest-up talking head',
        movement: 'hold still',
      },
      includeInExport: true,
    },
    capture,
    narrativeBeats
  );

  const existingInserts = scenesIn.filter(isInsertLikeScene).slice(0, 6);
  // Gate auto-invention unless idea/hints ask for inserts
  const insertSources = existingInserts.length
    ? existingInserts
    : ideaAsksForInserts(idea, briefHints)
      ? recommendUgcInserts(idea || '')
      : [];
  const insertUnits: CaptureUnit[] = [];
  const insertScenes = insertSources.slice(0, 6).map((s, idx) => {
    const isAiMedia =
      s.filmedBy === 'ai' || s.mediaRole === 'overlay' || s.mediaRole === 'cutaway';
    const unit = toCaptureUnit(
      {
        ...s,
        title: s.title,
        durationSeconds: Math.min(8, Number(s.durationSeconds) || 5),
        plainInstruction: s.plainInstruction,
      },
      idx + 1,
      []
    );
    unit.optional = true;
    unit.kind = 'insert';
    unit.dialogueRequired = false;
    unit.teleprompterRequired = false;
    unit.instruction = String(s.plainInstruction || unit.instruction);
    insertUnits.push(unit);
    return sceneFromCapture(
      {
        ...s,
        sceneNumber: idx + 2,
        filmedBy: isAiMedia ? 'ai' : s.filmedBy || 'user',
        contentMode: 'visual_only',
        editIntent: s.editIntent || 'broll',
        dialogue: { required: false, teleprompterText: null },
        teleprompterPrompt: undefined,
        directorCues: [],
        includeInExport: false,
        mediaRole: s.mediaRole || (isAiMedia ? 'overlay' : 'cutaway'),
        optionalInsert: true,
      },
      unit,
      []
    );
  });

  return {
    captureStrategy: 'single_take',
    narrativeBeats,
    captureUnits: [capture, ...insertUnits],
    scenes: [mainScene, ...insertScenes],
  };
}

/**
 * Gemini scenes are creative units. Derive beats + capture plan, then scenes[] from captures.
 * Never replace a shot card with "one continuous recording" boilerplate.
 */
export function applyCaptureStrategy(plan: {
  scenes: any[];
  contentType: ContentType | string;
  captureStrategy: CaptureStrategy;
  idea?: string;
  briefHints?: Record<string, unknown> | null;
  prefs?: ProductionPrefs | null;
}): {
  scenes: any[];
  narrativeBeats: NarrativeBeat[];
  captureUnits: CaptureUnit[];
  captureStrategy: CaptureStrategy;
} {
  const shotsPref = plan.prefs?.shots;
  const rawScenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  const scenesIn =
    shotsPref === 'few'
      ? mergeScenesToShotBudget(rawScenes, 3)
      : shotsPref === 'cinematic'
        ? mergeScenesToShotBudget(rawScenes, 6)
        : rawScenes;
  const ugc = isUgcAdContent(plan.contentType, plan.idea);
  // Only escalate to multi_shot for visual-first content when the creator didn't ask for fewer shots.
  const allowVisualEscalation = !shotsPref || shotsPref === 'cinematic';
  const visualFirst =
    allowVisualEscalation &&
    !ugc &&
    (isVisualFirstContent(plan.contentType, plan.idea) ||
      scenesIn.filter(hasDistinctVisual).length >= Math.max(2, Math.ceil(scenesIn.length * 0.4)));

  let strategy = plan.captureStrategy;
  if (ugc && !shotsPref && strategy !== 'multi_shot' && strategy !== 'montage') {
    strategy = 'single_take';
  }
  if (visualFirst && strategy === 'single_take') {
    strategy = 'multi_shot';
  }

  const hasAiMediaScenes = scenesIn.some(
    (x) => x?.filmedBy === 'ai' || x?.mediaRole === 'overlay' || x?.mediaRole === 'cutaway'
  );
  if (strategy === 'single_take' && (ugc || hasAiMediaScenes)) {
    return collapseUgcAd(scenesIn, plan.idea, plan.briefHints);
  }

  if (strategy === 'single_take' && !visualFirst && scenesIn.length > 1) {
    const narrativeBeats = beatsFromScenes(scenesIn);
    const durationSeconds = Math.max(
      8,
      scenesIn.reduce((a, s) => a + (Number(s.durationSeconds) || 0), 0)
    );
    const spoken = narrativeBeats.map((b) => (b.dialogue || '').trim()).filter(Boolean).join('\n\n');
    const instruction = scenesIn
      .map((s, i) => `${i + 1}. ${instructionFrom(s, Number(s.durationSeconds) || 5)}`)
      .join(' ');
    const first = scenesIn[0] || {};
    const capture: CaptureUnit = {
      id: unitId(0),
      title: first.title || 'Continuous take',
      beatIds: narrativeBeats.map((b) => b.id),
      contentMode: spoken ? 'dialogue' : first.contentMode || 'dialogue',
      durationSeconds,
      instruction,
      camera: first.visual?.camera,
      framing: first.visual?.framing || 'chest-up talking head',
      action: first.visual?.action,
      dialogueRequired: Boolean(spoken),
      teleprompterRequired: Boolean(spoken),
    };
    const collapsed = sceneFromCapture(
      {
        ...first,
        sceneNumber: 1,
        chapterTitle: first.chapterTitle || 'Take 1',
        purpose: narrativeBeats.map((b) => b.title).join(' → '),
        directorCues: narrativeBeats.flatMap((b) => b.directorCues || []),
        ...(mergeSceneRecipes(scenesIn.filter((x) => !isInsertLikeScene(x)))
          ? { recipe: mergeSceneRecipes(scenesIn.filter((x) => !isInsertLikeScene(x))) }
          : {}),
      },
      capture,
      narrativeBeats
    );
    return {
      captureStrategy: 'single_take',
      narrativeBeats,
      captureUnits: [capture],
      scenes: [collapsed],
    };
  }

  const grouped =
    strategy === 'multi_shot' || strategy === 'montage'
      ? groupBeatsByIntent(scenesIn)
      : { beats: beatsFromScenes(scenesIn), beatIdByScene: scenesIn.map((_, i) => beatId(i)) };

  const captureUnits = scenesIn.map((s, idx) =>
    toCaptureUnit(s, idx, [grouped.beatIdByScene[idx]].filter(Boolean))
  );

  const scenes = scenesIn.map((s, idx) =>
    sceneFromCapture(
      { ...s, sceneNumber: idx + 1 },
      captureUnits[idx],
      grouped.beats
    )
  );

  return {
    captureStrategy: strategy,
    narrativeBeats: grouped.beats,
    captureUnits,
    scenes,
  };
}
