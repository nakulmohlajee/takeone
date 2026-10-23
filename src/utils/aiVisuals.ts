/**
 * AI visuals in a plan — b-roll, overlays, memes, virtual backgrounds and AI overlay scenes:
 * finding what still needs an image, generating / uploading images, and writing them back.
 * Shared by the Master Cut export (auto-fill) and the AI visuals editor.
 */
import { VIDEO_BG_KEY, setVideoBackground, videoBackground } from './virtualBackground';
import type { Project, ProductionPrefs, Scene } from '../types/director';
import { extensionForMime, uploadBlobToGcs } from './renderClient';

export const INSERT_KINDS_NEEDING_ASSET = new Set(['broll_image', 'broll_video', 'meme']);

export function sceneHasMedia(scene: Scene): boolean {
  return Boolean(
    scene.userRecordedVideoUrl ||
      scene.gcsObjectPath ||
      scene.aiGeneratedImageUrl ||
      scene.aiGeneratedVideoUrl ||
      scene.userInsertUrl
  );
}

export type MissingAsset = {
  key: string;
  sceneId: string;
  sceneTitle: string;
  prompt: string;
  kind: 'insert' | 'background' | 'scene';
  insertIndex?: number;
};

/**
 * Every AI visual the plan contains but has no media yet (b-roll, overlays, memes, backgrounds,
 * AI overlay scenes), limited to what the cut will actually render with the current looks.
 */
export function findMissingAssets(project: Project, prefs: ProductionPrefs): MissingAsset[] {
  const out: MissingAsset[] = [];
  const looks = new Set(prefs.looks);
  // Same gate as server/cut/compile.ts — don't generate what the cut would drop.
  const insertRenders = (kind: string) =>
    kind === 'meme' ? looks.has('memes') : looks.has('broll') || looks.has('overlays');
  const byId = new Map(project.scenes.map((s) => [s.id, s]));
  for (const scene of project.scenes) {
    const recipe = scene.recipe;
    if (recipe) {
      (recipe.inserts || []).forEach((ins: any, idx) => {
        if (!INSERT_KINDS_NEEDING_ASSET.has(ins.kind) || !insertRenders(ins.kind)) return;
        if (ins.enabled === false || ins.assetUrl || ins.mediaUrl) return;
        const prompt = String(ins.prompt || '').trim();
        if (!prompt) return;
        out.push({
          key: `${scene.id}:ins:${idx}`,
          sceneId: scene.id,
          sceneTitle: scene.title,
          prompt,
          kind: 'insert',
          insertIndex: idx,
        });
      });
      // The whole video shares one background: queue it once.
      if (
        recipe.layout === 'virtual_background' &&
        !scene.virtualBackgroundBaked &&
        !out.some((m) => m.key === VIDEO_BG_KEY)
      ) {
        const bg = videoBackground(project.scenes);
        const prompt = String(bg?.prompt || '').trim();
        if (prompt && !bg?.assetUrl) {
          out.push({ key: VIDEO_BG_KEY, sceneId: scene.id, sceneTitle: 'Virtual background', prompt, kind: 'background' });
        }
      }
    }
    // AI overlay scenes (and cutaways that go in the cut) need their picture too.
    if (scene.filmedBy === 'ai' && scene.aiVisualEnabled !== false && !sceneHasMedia(scene)) {
      const prompt = String(scene.aiGenerationPrompt || '').trim();
      const parent = scene.overlayParentSceneId ? byId.get(scene.overlayParentSceneId) : undefined;
      const plateCoveredByTake =
        scene.overlayLayout === 'greenscreen' &&
        (parent?.virtualBackgroundBaked || parent?.recipe?.layout === 'virtual_background');
      const inCut = scene.mediaRole === 'overlay' || scene.includeInExport === true;
      if (prompt && inCut && !plateCoveredByTake) {
        out.push({
          key: `${scene.id}:scene`,
          sceneId: scene.id,
          sceneTitle: scene.title,
          prompt,
          kind: 'scene',
        });
      }
    }
  }
  return out;
}

/** Generate stills for `items` (2 at a time) and store them in GCS. Map key → gs:// URI. */
export async function generateAssets(
  items: MissingAsset[],
  opts: { aspectRatio: string; styleBible: string },
  onProgress?: (done: number, total: number) => void
): Promise<{ results: Map<string, string>; failed: number }> {
  const results = new Map<string, string>();
  let done = 0;
  let failed = 0;
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        const res = await fetch('/api/generate-cutaway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt:
              item.kind === 'background'
                ? `Clean cinematic background plate, no people, no text: ${item.prompt}`
                : item.prompt,
            sceneTitle: item.sceneTitle,
            aspectRatio: opts.aspectRatio,
            styleBible: opts.styleBible,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data?.imageUrl) throw new Error(data?.error || 'no image');
        const blob = await dataUrlToBlob(data.imageUrl);
        const mime = blob.type || 'image/png';
        const { gcsUri } = await uploadBlobToGcs(blob, 'broll', extensionForMime(mime), mime);
        results.set(item.key, gcsUri);
      } catch (e) {
        failed++;
        console.warn('[directors-cut] asset failed:', item.key, e);
      } finally {
        done++;
        onProgress?.(done, items.length);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return { results, failed };
}

/** Write generated asset URIs back into the project (recipe inserts, backgrounds, AI scenes). */
export function applyAssetResults(project: Project, results: Map<string, string>): Project {
  if (!results.size) return project;
  const videoBg = results.get(VIDEO_BG_KEY);
  if (videoBg) project = setVideoBackground(project, { assetUrl: videoBg });
  return {
    ...project,
    scenes: project.scenes.map((scene) => {
      let next = scene;
      const sceneUrl = results.get(`${scene.id}:scene`);
      if (sceneUrl) {
        next = {
          ...next,
          aiGeneratedImageUrl: sceneUrl,
          mediaType: 'image',
          aiGenerationStatus: 'ready',
        };
      }
      if (!next.recipe) return next;
      let recipe = next.recipe;
      const bg = results.get(`${scene.id}:bg`);
      if (bg && recipe.background) {
        recipe = { ...recipe, background: { ...recipe.background, assetUrl: bg } };
      }
      recipe = {
        ...recipe,
        inserts: (recipe.inserts || []).map((ins: any, idx) => {
          const url = results.get(`${scene.id}:ins:${idx}`);
          if (!url) return ins;
          // We generate stills, so a "video" b-roll slot becomes an image slot.
          return {
            ...ins,
            assetUrl: url,
            kind: ins.kind === 'broll_video' ? 'broll_image' : ins.kind,
          };
        }),
      };
      return { ...next, recipe };
    }),
  };
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

/** One AI visual as the editor shows it. */
export type AiVisual = {
  key: string;
  sceneId: string;
  sceneTitle: string;
  kind: MissingAsset['kind'];
  /** "AI overlay", "AI B-roll", "AI meme", "Virtual background", "AI scene". */
  label: string;
  /** Spoken phrase it appears on, when it has one. */
  anchor?: string;
  prompt: string;
  /** gs:// or data: image, if generated / uploaded. */
  assetUrl?: string;
  enabled: boolean;
  /** False when the current looks would leave it out of the cut. */
  inCut: boolean;
};

/** Every AI visual in the plan, in scene order (generated or not). */
export function listAiVisuals(project: Project, prefs: ProductionPrefs): AiVisual[] {
  const looks = new Set(prefs.looks);
  const out: AiVisual[] = [];
  for (const scene of project.scenes) {
    const recipe = scene.recipe;
    if (recipe?.layout === 'virtual_background' && !scene.virtualBackgroundBaked && !out.some((v) => v.key === VIDEO_BG_KEY)) {
      const bg = videoBackground(project.scenes);
      out.push({
        key: VIDEO_BG_KEY,
        sceneId: scene.id,
        sceneTitle: 'Every shot',
        kind: 'background',
        label: 'Virtual background',
        prompt: bg?.prompt || '',
        assetUrl: bg?.assetUrl,
        enabled: true,
        inCut: true,
      });
    }
    (recipe?.inserts || []).forEach((ins: any, idx) => {
      if (!INSERT_KINDS_NEEDING_ASSET.has(ins.kind)) return;
      out.push({
        key: `${scene.id}:ins:${idx}`,
        sceneId: scene.id,
        sceneTitle: scene.title,
        kind: 'insert',
        label: ins.kind === 'meme' ? 'AI meme' : ins.layout === 'pip' ? 'AI overlay' : 'AI B-roll',
        anchor: ins.anchorPhrase || undefined,
        prompt: ins.prompt || '',
        assetUrl: ins.assetUrl || ins.mediaUrl || undefined,
        enabled: ins.enabled !== false,
        inCut: ins.kind === 'meme' ? looks.has('memes') : looks.has('broll') || looks.has('overlays'),
      });
    });
    if (scene.filmedBy === 'ai' && scene.overlayLayout !== 'greenscreen') {
      out.push({
        key: `${scene.id}:scene`,
        sceneId: scene.id,
        sceneTitle: scene.title,
        kind: 'scene',
        label: scene.mediaRole === 'overlay' ? 'AI overlay' : 'AI B-roll',
        anchor: (scene as Scene & { mediaTimingHint?: string }).mediaTimingHint,
        prompt: scene.aiGenerationPrompt || '',
        assetUrl: scene.aiGeneratedImageUrl || scene.aiGeneratedVideoUrl || scene.userInsertUrl,
        // Overlays ride on their take; cutaways are only cut in when marked for export.
        enabled:
          scene.aiVisualEnabled !== false &&
          (scene.mediaRole === 'overlay' || scene.includeInExport === true),
        inCut: true,
      });
    }
  }
  return out;
}

/** Edit one AI visual: its prompt, whether it is used, or clear its image. */
export function updateAiVisual(
  project: Project,
  key: string,
  patch: { prompt?: string; enabled?: boolean; clearAsset?: boolean }
): Project {
  if (key === VIDEO_BG_KEY) {
    return setVideoBackground(project, {
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.clearAsset ? { assetUrl: undefined } : {}),
    });
  }
  const [sceneId, type, idxRaw] = key.split(':');
  return {
    ...project,
    scenes: project.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      if (type === 'scene') {
        return {
          ...scene,
          ...(patch.prompt !== undefined ? { aiGenerationPrompt: patch.prompt } : {}),
          ...(patch.enabled !== undefined
            ? {
                aiVisualEnabled: patch.enabled,
                ...(scene.mediaRole !== 'overlay' ? { includeInExport: patch.enabled } : {}),
              }
            : {}),
          ...(patch.clearAsset
            ? { aiGeneratedImageUrl: undefined, aiGeneratedVideoUrl: undefined, userInsertUrl: undefined }
            : {}),
        };
      }
      if (!scene.recipe) return scene;
      if (type === 'bg') {
        const bg = scene.recipe.background || { prompt: '' };
        return {
          ...scene,
          recipe: {
            ...scene.recipe,
            background: {
              ...bg,
              ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
              ...(patch.clearAsset ? { assetUrl: undefined } : {}),
            },
          },
        };
      }
      const idx = Number(idxRaw);
      return {
        ...scene,
        recipe: {
          ...scene.recipe,
          inserts: scene.recipe.inserts.map((ins, i) =>
            i !== idx
              ? ins
              : {
                  ...ins,
                  ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
                  ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                  ...(patch.clearAsset ? { assetUrl: undefined } : {}),
                }
          ),
        },
      };
    }),
  };
}

/** Upload a creator's own image for one visual. Returns the gs:// URI. */
export async function uploadOwnVisual(file: File): Promise<string> {
  const mime = file.type || 'image/jpeg';
  const { gcsUri } = await uploadBlobToGcs(file, 'broll', extensionForMime(mime), mime);
  return gcsUri;
}

export type NewVisualKind = 'broll' | 'overlay' | 'meme' | 'text_pop';

/** The look a visual kind needs switched on to make it into the cut. */
export function lookForKind(kind: NewVisualKind): ProductionPrefs['looks'][number] {
  return kind === 'broll' ? 'broll' : kind === 'overlay' ? 'overlays' : kind === 'meme' ? 'memes' : 'text_pops';
}

/** What a scene's creator actually says (teleprompter lines, or the transcript for imports). */
export function spokenTextOf(scene: Scene): string {
  return String(scene.teleprompterPrompt || scene.dialogue?.teleprompterText || scene.transcript || '').trim();
}

/** Spoken sentences across the creator's takes — the moments a new visual can land on. */
export function visualMoments(project: Project): Array<{ sceneId: string; sceneTitle: string; sentence: string; anchor: string }> {
  const out: Array<{ sceneId: string; sceneTitle: string; sentence: string; anchor: string }> = [];
  for (const scene of project.scenes) {
    if (scene.filmedBy !== 'user') continue;
    const sentences = spokenTextOf(scene)
      .split(/(?<=[.!?।])\s+|\n+/)
      .map((x) => x.trim())
      .filter((x) => x.split(/\s+/).length >= 3);
    for (const sentence of sentences) {
      const anchor = sentence
        .split(/\s+/)
        .slice(0, 6)
        .join(' ')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      out.push({ sceneId: scene.id, sceneTitle: scene.title, sentence, anchor });
    }
  }
  return out;
}

/** Add one visual to a scene's recipe. Returns the updated project and the new visual's key. */
export function addAiVisual(
  project: Project,
  v: { sceneId: string; anchorPhrase: string; kind: NewVisualKind; prompt?: string; text?: string }
): { project: Project; key: string } {
  let key = '';
  const scenes = project.scenes.map((scene) => {
    if (scene.id !== v.sceneId) return scene;
    const recipe = scene.recipe || { layout: 'talking_head' as const, inserts: [], punchIns: [], transitionOut: 'cut' as const };
    const insert =
      v.kind === 'text_pop'
        ? { anchorPhrase: v.anchorPhrase, kind: 'text_pop' as const, text: (v.text || '').trim().toUpperCase().slice(0, 40), layout: 'full' as const, durationSec: 2 }
        : {
            anchorPhrase: v.anchorPhrase,
            kind: v.kind === 'meme' ? ('meme' as const) : ('broll_image' as const),
            prompt: (v.prompt || '').trim(),
            ...(v.kind === 'meme' && v.text?.trim() ? { text: v.text.trim().slice(0, 40) } : {}),
            layout: v.kind === 'broll' ? ('full' as const) : ('pip' as const),
            durationSec: v.kind === 'broll' ? 3 : 2.5,
          };
    key = `${scene.id}:ins:${recipe.inserts.length}`;
    return { ...scene, recipe: { ...recipe, inserts: [...recipe.inserts, insert] } };
  });
  return { project: { ...project, scenes }, key };
}
