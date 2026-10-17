/**
 * Apply "Tweak with a prompt" operations to a project — the fields the export reads: a take's
 * kept ranges, its recipe (AI visuals, text pops, punch-ins) and the production prefs.
 * Pure: returns the next project; the caller keeps the previous one for Undo.
 */
import type { Project, ProductionPrefs, Scene } from '../types/director';
import { addAiVisual, lookForKind, type NewVisualKind } from './aiVisuals';

export type KeepRange = { start: number; end: number };

export type TweakOp =
  | { op: 'restore_full'; sceneId: string }
  | { op: 'set_keep_ranges'; sceneId: string; ranges: KeepRange[] }
  | { op: 'cut_range'; sceneId: string; start: number; end: number }
  | { op: 'add_visual'; sceneId: string; anchorPhrase: string; kind: NewVisualKind; prompt?: string; text?: string }
  | { op: 'remove_visual'; sceneId: string; index: number }
  | { op: 'add_punch_in'; sceneId: string; anchorPhrase: string; zoom: number }
  | { op: 'remove_punch_in'; sceneId: string; index: number }
  | {
      op: 'set_visual';
      sceneId: string;
      index: number;
      /** Seconds on screen. */
      duration?: number;
      /** Shift in seconds from where it is now (negative = earlier). */
      nudge?: number;
      /** New spoken phrase to land on. */
      moveTo?: string;
      layout?: 'full' | 'pip';
      prompt?: string;
      text?: string;
    }
  | { op: 'set_overlay_scene'; sceneId: string; duration?: number; nudge?: number; prompt?: string }
  /** Virtual background: switch it on/off for a take, or describe a new one. */
  | { op: 'set_background'; sceneId: string; on?: boolean; prompt?: string }
  | { op: 'set_punch_in'; sceneId: string; index: number; zoom?: number; moveTo?: string }
  | { op: 'set_captions'; style?: ProductionPrefs['captions']; position?: 'bottom' | 'middle' | 'top'; size?: 'small' | 'medium' | 'large' }
  | { op: 'reorder_takes'; order: string[] }
  | { op: 'set_aspect'; ratio: '9:16' | '16:9' }
  | { op: 'set_cleanup'; silences?: boolean; fillers?: boolean }
  | { op: 'set_music'; on?: boolean; volume?: number; mood?: string };

function takeLength(s: Scene): number {
  const lastWord = s.words?.length ? Math.max(...s.words.map((w) => w.end)) + 0.6 : 0;
  return Math.max(Number(s.recordedDuration) || 0, lastWord, 0) || Number(s.durationSeconds) || 0;
}

/** What is kept of a take right now (whole take when untrimmed). */
export function currentKeep(s: Scene): KeepRange[] {
  if (s.keepRanges?.length) return s.keepRanges;
  if (typeof s.inPoint === 'number' && typeof s.outPoint === 'number' && s.outPoint > s.inPoint) {
    return [{ start: s.inPoint, end: s.outPoint }];
  }
  return [{ start: 0, end: takeLength(s) }];
}

function withKeep(s: Scene, ranges: KeepRange[]): Scene {
  const sorted = ranges.filter((r) => r.end - r.start >= 0.2).sort((a, b) => a.start - b.start);
  if (!sorted.length) return s;
  return {
    ...s,
    keepRanges: sorted,
    inPoint: sorted[0].start,
    outPoint: sorted[sorted.length - 1].end,
    userTrimLocked: true,
  };
}

/** Remove [start, end] from a set of kept ranges. */
export function subtractRange(ranges: KeepRange[], start: number, end: number): KeepRange[] {
  const out: KeepRange[] = [];
  for (const r of ranges) {
    if (end <= r.start || start >= r.end) {
      out.push(r);
      continue;
    }
    if (start > r.start) out.push({ start: r.start, end: start });
    if (end < r.end) out.push({ start: end, end: r.end });
  }
  return out.filter((r) => r.end - r.start >= 0.2);
}

export type TweakResult = {
  project: Project;
  /** Keys of image visuals that were added or re-prompted and still need generating. */
  newVisualKeys: Array<{ key: string; sceneId: string; prompt: string }>;
  applied: number;
};

export function applyTweakOps(project: Project, prefs: ProductionPrefs, ops: TweakOp[]): TweakResult {
  let next: Project = { ...project, prefs: { ...prefs, cleanup: { ...prefs.cleanup } } };
  const newVisualKeys: TweakResult['newVisualKeys'] = [];
  let applied = 0;
  const editScene = (id: string, fn: (s: Scene) => Scene) => {
    let hit = false;
    next = {
      ...next,
      scenes: next.scenes.map((s) => {
        if (s.id !== id) return s;
        hit = true;
        return fn(s);
      }),
    };
    if (hit) applied++;
  };
  // Remove ops refer to indexes in the original list: apply them highest-first so they stay valid.
  const ordered = [
    ...ops.filter((o) => o.op !== 'remove_visual' && o.op !== 'remove_punch_in'),
    ...ops
      .filter((o): o is Extract<TweakOp, { index: number }> => o.op === 'remove_visual' || o.op === 'remove_punch_in')
      .sort((a, b) => b.index - a.index),
  ];

  for (const op of ordered) {
    switch (op.op) {
      case 'restore_full':
        editScene(op.sceneId, (s) => ({
          ...s,
          keepRanges: undefined,
          inPoint: undefined,
          outPoint: undefined,
          userTrimLocked: false,
          // "Bring it all back" must reach the last spoken word even if the saved length was short.
          recordedDuration: Math.round(takeLength(s) * 100) / 100 || s.recordedDuration,
        }));
        break;
      case 'set_keep_ranges':
        editScene(op.sceneId, (s) => withKeep(s, op.ranges));
        break;
      case 'cut_range':
        editScene(op.sceneId, (s) => withKeep(s, subtractRange(currentKeep(s), op.start, op.end)));
        break;
      case 'add_visual': {
        const { project: p, key } = addAiVisual(next, {
          sceneId: op.sceneId,
          anchorPhrase: op.anchorPhrase,
          kind: op.kind,
          prompt: op.prompt,
          text: op.text,
        });
        if (key) {
          next = p;
          applied++;
          const look = lookForKind(op.kind);
          const prefsNow = next.prefs!;
          if (!prefsNow.looks.includes(look)) next = { ...next, prefs: { ...prefsNow, looks: [...prefsNow.looks, look] } };
          if (op.kind !== 'text_pop' && op.prompt?.trim()) {
            newVisualKeys.push({ key, sceneId: op.sceneId, prompt: op.prompt.trim() });
          }
        }
        break;
      }
      case 'remove_visual':
        editScene(op.sceneId, (s) =>
          s.recipe ? { ...s, recipe: { ...s.recipe, inserts: s.recipe.inserts.filter((_, i) => i !== op.index) } } : s
        );
        break;
      case 'add_punch_in':
        editScene(op.sceneId, (s) => {
          const recipe = s.recipe || { layout: 'talking_head' as const, inserts: [], punchIns: [], transitionOut: 'cut' as const };
          return { ...s, recipe: { ...recipe, punchIns: [...recipe.punchIns, { anchorPhrase: op.anchorPhrase, zoom: op.zoom }] } };
        });
        break;
      case 'remove_punch_in':
        editScene(op.sceneId, (s) =>
          s.recipe ? { ...s, recipe: { ...s.recipe, punchIns: s.recipe.punchIns.filter((_, i) => i !== op.index) } } : s
        );
        break;
      case 'set_captions':
        next = {
          ...next,
          prefs: {
            ...next.prefs!,
            ...(op.style ? { captions: op.style } : {}),
            ...(op.position ? { captionPosition: op.position } : {}),
            ...(op.size ? { captionSize: op.size } : {}),
          },
        };
        applied++;
        break;
      case 'set_visual':
        editScene(op.sceneId, (s) => {
          const ins = s.recipe?.inserts[op.index];
          if (!s.recipe || !ins) return s;
          const promptChanged = op.prompt != null && op.prompt.trim() && op.prompt.trim() !== (ins.prompt || '').trim();
          const updated = {
            ...ins,
            ...(op.duration != null ? { durationSec: Math.max(0.5, Math.min(15, op.duration)) } : {}),
            ...(op.nudge != null ? { offsetSec: Math.round(((ins.offsetSec || 0) + op.nudge) * 100) / 100 } : {}),
            ...(op.moveTo ? { anchorPhrase: op.moveTo, offsetSec: 0 } : {}),
            ...(op.layout && ins.kind !== 'text_pop' ? { layout: op.layout } : {}),
            ...(op.text != null ? { text: ins.kind === 'text_pop' ? op.text.toUpperCase().slice(0, 40) : op.text.slice(0, 40) } : {}),
            ...(promptChanged ? { prompt: op.prompt!.trim(), assetUrl: undefined } : {}),
          };
          if (promptChanged) {
            newVisualKeys.push({ key: `${s.id}:ins:${op.index}`, sceneId: s.id, prompt: op.prompt!.trim() });
          }
          return { ...s, recipe: { ...s.recipe, inserts: s.recipe.inserts.map((x, i) => (i === op.index ? updated : x)) } };
        });
        break;
      case 'set_overlay_scene':
        editScene(op.sceneId, (s) => {
          if (s.filmedBy !== 'ai') return s;
          const promptChanged = op.prompt != null && op.prompt.trim() && op.prompt.trim() !== (s.aiGenerationPrompt || '').trim();
          if (promptChanged) newVisualKeys.push({ key: `${s.id}:scene`, sceneId: s.id, prompt: op.prompt!.trim() });
          return {
            ...s,
            ...(op.duration != null ? { overlayDurationSeconds: Math.max(0.5, Math.min(15, op.duration)) } : {}),
            ...(op.nudge != null && typeof s.overlayStartSeconds === 'number'
              ? { overlayStartSeconds: Math.max(0, s.overlayStartSeconds + op.nudge) }
              : {}),
            ...(promptChanged
              ? { aiGenerationPrompt: op.prompt!.trim(), aiGeneratedImageUrl: undefined, aiGeneratedVideoUrl: undefined }
              : {}),
          };
        });
        break;
      case 'set_background':
        editScene(op.sceneId, (s) => {
          if (s.filmedBy !== 'user') return s;
          const recipe = s.recipe || { layout: 'talking_head' as const, inserts: [], punchIns: [], transitionOut: 'cut' as const };
          if (op.on === false) return { ...s, recipe: { ...recipe, layout: 'talking_head' } };
          const prompt = op.prompt?.trim() || recipe.background?.prompt || '';
          const changed = prompt !== (recipe.background?.prompt || '').trim();
          const background = changed ? { prompt } : recipe.background || { prompt };
          if (prompt && (changed || !background.assetUrl)) {
            newVisualKeys.push({ key: `${s.id}:bg`, sceneId: s.id, prompt });
          }
          return { ...s, recipe: { ...recipe, layout: 'virtual_background', background } };
        });
        break;
      case 'set_punch_in':
        editScene(op.sceneId, (s) => {
          const p = s.recipe?.punchIns[op.index];
          if (!s.recipe || !p) return s;
          const updated = {
            ...p,
            ...(op.zoom != null ? { zoom: Math.max(1.03, Math.min(1.35, op.zoom)) } : {}),
            ...(op.moveTo ? { anchorPhrase: op.moveTo } : {}),
          };
          return { ...s, recipe: { ...s.recipe, punchIns: s.recipe.punchIns.map((x, i) => (i === op.index ? updated : x)) } };
        });
        break;
      case 'reorder_takes': {
        const rank = new Map(op.order.map((id, i) => [id, i]));
        const known = next.scenes.filter((s) => rank.has(s.id));
        if (known.length >= 2) {
          // Reordered takes fill the slots the takes held before; everything else stays put.
          const slots = next.scenes.map((s, i) => (rank.has(s.id) ? i : -1)).filter((i) => i >= 0);
          const sorted = [...known].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
          const scenes = [...next.scenes];
          slots.forEach((slot, k) => (scenes[slot] = { ...sorted[k], sceneNumber: slot + 1 }));
          next = { ...next, scenes };
          applied++;
        }
        break;
      }
      case 'set_aspect':
        next = { ...next, aspectRatio: op.ratio };
        applied++;
        break;
      case 'set_cleanup':
        next = {
          ...next,
          prefs: {
            ...next.prefs!,
            cleanup: {
              silences: op.silences ?? next.prefs!.cleanup.silences,
              fillers: op.fillers ?? next.prefs!.cleanup.fillers,
            },
          },
        };
        applied++;
        break;
      case 'set_music':
        next = {
          ...next,
          prefs: { ...next.prefs!, music: op.on ?? next.prefs!.music },
          ...(op.volume != null ? { musicVolume: op.volume } : {}),
          ...(op.mood ? { musicMood: op.mood } : {}),
        };
        applied++;
        break;
      default:
        break;
    }
  }
  return { project: next, newVisualKeys, applied };
}
