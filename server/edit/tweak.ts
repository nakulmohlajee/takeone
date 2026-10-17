/**
 * "Tweak with a prompt" for Master Cut.
 *
 * Turns a plain request ("bring back the last lines", "add a text pop on the price", "cut the
 * first 3 seconds") into operations on the fields the export actually reads — each take's kept
 * ranges, its recipe (AI visuals, text pops, punch-ins) and the production prefs. The browser
 * applies them (src/utils/tweaks.ts) and the Live Cut player shows the result immediately.
 */
import type { ProductionPrefs, Scene } from '../../src/types/director';
import { buildSegmentsFromWords } from '../speech/chirp';

import type { TweakOp } from '../../src/utils/tweaks';
export type { TweakOp };

type Ai = { models: { generateContent: (req: any) => Promise<{ text?: string }> } };

const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'];
const KINDS = new Set(['broll', 'overlay', 'meme', 'text_pop']);
const CAPTIONS = new Set(['bold_pop', 'karaoke', 'clean', 'off']);
const MOODS = ['Warm Acoustic', 'Lo-fi', 'Upbeat Pop', 'Cinematic', 'Corporate', 'Chill Electronic'];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Compact, timed description of the cut for the model. */
function describeCut(scenes: Scene[], prefs: ProductionPrefs, musicVolume?: number): string {
  const lines: string[] = [];
  for (const s of scenes) {
    if (s.filmedBy !== 'user') continue;
    const length = Number(s.recordedDuration) || Number(s.durationSeconds) || 0;
    const keep =
      s.keepRanges?.length
        ? s.keepRanges
        : typeof s.inPoint === 'number' && typeof s.outPoint === 'number'
          ? [{ start: s.inPoint, end: s.outPoint }]
          : null;
    lines.push(`TAKE sceneId=${s.id} "${s.title}" length=${r2(length)}s kept=${keep ? JSON.stringify(keep.map((k) => [r2(k.start), r2(k.end)])) : 'whole take (pauses auto-trimmed)'}`);
    const vb = s.recipe?.layout === 'virtual_background';
    lines.push(
      `  virtual background: ${vb ? `on, "${String(s.recipe?.background?.prompt || '').slice(0, 80)}"` : 'off'}${
        s.virtualBackgroundBaked ? ' (baked into the take)' : s.matteStatus === 'running' ? ' (being added to the take now)' : ''
      }`
    );
    const segs =
      s.words?.length ? buildSegmentsFromWords(s.words as any) : (s.transcriptSegments || []);
    for (const seg of segs.slice(0, 120)) lines.push(`  [${r2(seg.start)}–${r2(seg.end)}] ${seg.text}`);
    (s.recipe?.inserts || []).forEach((ins, i) =>
      lines.push(
        `  visual #${i}: ${ins.kind}${ins.kind === 'broll_image' ? (ins.layout === 'pip' ? ' (overlay)' : ' (b-roll)') : ''} on "${ins.anchorPhrase}" for ${r2(Number(ins.durationSec) || 2)}s${ins.offsetSec ? ` shifted ${r2(ins.offsetSec)}s` : ''}${ins.text ? ` text="${ins.text}"` : ''}${ins.prompt ? ` prompt="${String(ins.prompt).slice(0, 80)}"` : ''}${ins.enabled === false ? ' [off]' : ''}`
      )
    );
    (s.recipe?.punchIns || []).forEach((p, i) => lines.push(`  punch-in #${i}: zoom ${p.zoom} on "${p.anchorPhrase}"`));
  }
  for (const s of scenes) {
    if (s.filmedBy !== 'ai' || s.overlayLayout === 'greenscreen') continue;
    lines.push(
      `AI ${s.mediaRole === 'overlay' ? 'OVERLAY' : 'CUTAWAY'} SCENE sceneId=${s.id} "${s.title}"${s.overlayDurationSeconds ? ` for ${r2(s.overlayDurationSeconds)}s` : ' (default ~2.5s)'} prompt="${String(s.aiGenerationPrompt || '').slice(0, 80)}"`
    );
  }
  lines.push(
    `SETTINGS captions=${prefs.captions} captionPosition=${prefs.captionPosition || 'bottom'} captionSize=${prefs.captionSize || 'medium'} cutPauses=${prefs.cleanup.silences} removeFillers=${prefs.cleanup.fillers} music=${prefs.music}${musicVolume != null ? ` musicVolume=${r2(musicVolume)}` : ''} looks=${prefs.looks.join(',')}`
  );
  return lines.join('\n');
}

function prompt(request: string, cut: string): string {
  return `You edit a short video. The current cut is below: each take with its spoken lines and their times (seconds in the take), what is kept, its AI visuals and punch-ins, and the settings.

${cut}

Creator's request: "${request}"

Return JSON {"summary": "one short sentence, past tense, saying exactly what changed (mention times like 0:29–0:46 when relevant)", "ops": [...]} using only these ops:
- {"op":"restore_full","sceneId"} — keep the whole take again (undo trims; pauses are still auto-trimmed)
- {"op":"set_keep_ranges","sceneId","ranges":[{"start","end"}]} — keep exactly these parts of the take
- {"op":"cut_range","sceneId","start","end"} — remove one part of the take
- {"op":"add_visual","sceneId","anchorPhrase","kind":"broll|overlay|meme|text_pop","prompt"?,"text"?} — anchorPhrase = 3–8 words copied VERBATIM from that take's lines; prompt (image description, no text, no logos) for broll/overlay/meme; text (1–4 words, uppercase) for text_pop
- {"op":"remove_visual","sceneId","index"} — index = the visual # above
- {"op":"add_punch_in","sceneId","anchorPhrase","zoom":1.08-1.25}
- {"op":"remove_punch_in","sceneId","index"}
- {"op":"set_visual","sceneId","index","duration"? (seconds, 0.5–15),"nudge"? (seconds, negative = earlier),"moveTo"? (3–8 verbatim words),"layout"? ("full" | "pip"),"prompt"? (new image description → regenerated),"text"?} — change an existing visual #index
- {"op":"set_overlay_scene","sceneId","duration"?,"nudge"?,"prompt"?} — change an AI OVERLAY/CUTAWAY SCENE listed above
- {"op":"set_punch_in","sceneId","index","zoom"? (1.03–1.35),"moveTo"?}
- {"op":"set_background","sceneId","on"? (false = remove it),"prompt"? (describe the place: no people, no text)} — add, change or remove a take's virtual background. It works on every take: the app cuts the person out of the take automatically, so never say it needs a green screen.
- {"op":"set_captions","style"? "bold_pop|karaoke|clean|off","position"? "bottom|middle|top","size"? "small|medium|large"}
- {"op":"reorder_takes","order":[sceneIds in the new order]}
- {"op":"set_aspect","ratio":"9:16|16:9"}
- {"op":"set_cleanup","silences"?,"fillers"?}
- {"op":"set_music","on"?,"volume"? (0–0.4),"mood"? one of ${JSON.stringify(MOODS)}}
Use times from the lines above. Do the smallest set of ops that does what was asked. Prefer changing an existing visual (set_visual) over removing and re-adding it.
If the request truly can't be done with these ops, return no ops and use the summary to offer the closest things you CAN do (e.g. "I can't add a transition effect, but I can cut there, add a punch-in, or put a b-roll over the join.") — never a bare refusal.`;
}

function sanitize(raw: any, scenes: Scene[]): TweakOp[] {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const out: TweakOp[] = [];
  for (const o of Array.isArray(raw) ? raw.slice(0, 20) : []) {
    const scene = o?.sceneId ? byId.get(String(o.sceneId)) : undefined;
    const length = scene ? Number(scene.recordedDuration) || Number(scene.durationSeconds) || 0 : 0;
    const clampT = (t: any) => Math.max(0, Math.min(length || 1e6, Number(t) || 0));
    switch (o?.op) {
      case 'restore_full':
        if (scene) out.push({ op: 'restore_full', sceneId: scene.id });
        break;
      case 'set_keep_ranges': {
        if (!scene || !Array.isArray(o.ranges)) break;
        const ranges = o.ranges
          .map((r: any) => ({ start: r2(clampT(r?.start)), end: r2(clampT(r?.end)) }))
          .filter((r: any) => r.end - r.start >= 0.2)
          .sort((a: any, b: any) => a.start - b.start);
        if (ranges.length) out.push({ op: 'set_keep_ranges', sceneId: scene.id, ranges });
        break;
      }
      case 'cut_range': {
        if (!scene) break;
        const start = r2(clampT(o.start));
        const end = r2(clampT(o.end));
        if (end - start >= 0.1) out.push({ op: 'cut_range', sceneId: scene.id, start, end });
        break;
      }
      case 'add_visual': {
        if (!scene || !KINDS.has(o.kind) || !String(o.anchorPhrase || '').trim()) break;
        out.push({
          op: 'add_visual',
          sceneId: scene.id,
          anchorPhrase: String(o.anchorPhrase).trim().slice(0, 120),
          kind: o.kind,
          ...(o.prompt ? { prompt: String(o.prompt).slice(0, 600) } : {}),
          ...(o.text ? { text: String(o.text).slice(0, 40) } : {}),
        });
        break;
      }
      case 'remove_visual':
      case 'remove_punch_in': {
        const i = Number(o.index);
        const list = o.op === 'remove_visual' ? scene?.recipe?.inserts : scene?.recipe?.punchIns;
        if (scene && Number.isInteger(i) && list && i >= 0 && i < list.length) out.push({ op: o.op, sceneId: scene.id, index: i });
        break;
      }
      case 'add_punch_in':
        if (scene && String(o.anchorPhrase || '').trim()) {
          out.push({
            op: 'add_punch_in',
            sceneId: scene.id,
            anchorPhrase: String(o.anchorPhrase).trim().slice(0, 120),
            zoom: Math.max(1.05, Math.min(1.3, Number(o.zoom) || 1.12)),
          });
        }
        break;
      case 'set_captions': {
        const op: any = { op: 'set_captions' };
        if (CAPTIONS.has(o.style)) op.style = o.style;
        if (['bottom', 'middle', 'top'].includes(o.position)) op.position = o.position;
        if (['small', 'medium', 'large'].includes(o.size)) op.size = o.size;
        if (Object.keys(op).length > 1) out.push(op);
        break;
      }
      case 'set_visual': {
        const i = Number(o.index);
        const ins = scene?.recipe?.inserts?.[i];
        if (!scene || !Number.isInteger(i) || !ins) break;
        const op: any = { op: 'set_visual', sceneId: scene.id, index: i };
        if (o.duration != null && Number(o.duration) > 0) op.duration = Math.max(0.5, Math.min(15, Number(o.duration)));
        if (o.nudge != null && Number.isFinite(Number(o.nudge))) op.nudge = Math.max(-20, Math.min(20, Number(o.nudge)));
        if (String(o.moveTo || '').trim()) op.moveTo = String(o.moveTo).trim().slice(0, 120);
        if (o.layout === 'full' || o.layout === 'pip') op.layout = o.layout;
        if (String(o.prompt || '').trim()) op.prompt = String(o.prompt).slice(0, 600);
        if (o.text != null) op.text = String(o.text).slice(0, 40);
        if (Object.keys(op).length > 3) out.push(op);
        break;
      }
      case 'set_overlay_scene': {
        if (!scene || scene.filmedBy !== 'ai') break;
        const op: any = { op: 'set_overlay_scene', sceneId: scene.id };
        if (o.duration != null && Number(o.duration) > 0) op.duration = Math.max(0.5, Math.min(15, Number(o.duration)));
        if (o.nudge != null && Number.isFinite(Number(o.nudge))) op.nudge = Number(o.nudge);
        if (String(o.prompt || '').trim()) op.prompt = String(o.prompt).slice(0, 600);
        if (Object.keys(op).length > 2) out.push(op);
        break;
      }
      case 'set_punch_in': {
        const i = Number(o.index);
        if (!scene || !Number.isInteger(i) || !scene.recipe?.punchIns?.[i]) break;
        const op: any = { op: 'set_punch_in', sceneId: scene.id, index: i };
        if (o.zoom != null) op.zoom = Math.max(1.03, Math.min(1.35, Number(o.zoom) || 1.12));
        if (String(o.moveTo || '').trim()) op.moveTo = String(o.moveTo).trim().slice(0, 120);
        if (Object.keys(op).length > 3) out.push(op);
        break;
      }
      case 'set_background': {
        if (!scene || scene.filmedBy !== 'user') break;
        const op: any = { op: 'set_background', sceneId: scene.id };
        if (typeof o.on === 'boolean') op.on = o.on;
        if (String(o.prompt || '').trim()) op.prompt = String(o.prompt).trim().slice(0, 600);
        if (op.on === false || op.prompt || op.on === true) out.push(op);
        break;
      }
      case 'reorder_takes': {
        const order = (Array.isArray(o.order) ? o.order : []).map(String).filter((id: string) => byId.has(id));
        if (order.length >= 2) out.push({ op: 'reorder_takes', order });
        break;
      }
      case 'set_aspect':
        if (o.ratio === '9:16' || o.ratio === '16:9') out.push({ op: 'set_aspect', ratio: o.ratio });
        break;
      case 'set_cleanup':
        out.push({
          op: 'set_cleanup',
          ...(typeof o.silences === 'boolean' ? { silences: o.silences } : {}),
          ...(typeof o.fillers === 'boolean' ? { fillers: o.fillers } : {}),
        });
        break;
      case 'set_music':
        out.push({
          op: 'set_music',
          ...(typeof o.on === 'boolean' ? { on: o.on } : {}),
          ...(o.volume != null ? { volume: Math.max(0, Math.min(0.4, Number(o.volume) || 0)) } : {}),
          ...(MOODS.includes(o.mood) ? { mood: o.mood } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export async function planTweak(
  ai: Ai,
  input: { request: string; scenes: Scene[]; prefs: ProductionPrefs; musicVolume?: number }
): Promise<{ summary: string; ops: TweakOp[] }> {
  const cut = describeCut(input.scenes, input.prefs, input.musicVolume);
  let lastErr: any;
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: prompt(input.request, cut),
        config: { responseMimeType: 'application/json', temperature: 0.2 },
      });
      const parsed = JSON.parse(String(res.text || '').replace(/^```(?:json)?\s*|```\s*$/g, ''));
      return {
        summary: String(parsed?.summary || '').trim().slice(0, 240) || 'Done.',
        ops: sanitize(parsed?.ops, input.scenes),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[tweak] ${model} failed:`, String((err as any)?.message || err).slice(0, 200));
    }
  }
  throw lastErr || new Error('Could not understand the request');
}
