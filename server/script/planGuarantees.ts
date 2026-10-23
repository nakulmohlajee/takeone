/**
 * Deterministic guarantees applied after the model passes.
 *
 * The structuring model (and its fallbacks) sometimes returns a plan that dropped the approved
 * script's spoken lines or ignored a look the creator picked. Pass 1's creative script is the
 * source of truth for speech, and every picked look must be in the plan — so instead of only
 * reporting "didn't land", these helpers restore the lines and place the missing looks on
 * phrases the creator actually says.
 */
import { spreadVirtualBackground } from '../../src/utils/virtualBackground';
import type { ProductionPrefs } from '../../src/types/director';

const STOPWORDS = new Set(
  'a an the and or but so to of in on for with at by from is are was were be been it its this that these those i im you youre we they he she my your our their me us them do does did not no yes just very really like get got have has had will would can could if then than when what who how all one into out up about over its'.split(
    ' '
  )
);

type Para = { text: string; note?: string };

/** Spoken paragraphs from the pass-1 script: TITLE / LOGLINE and [VISUAL/EDIT NOTE] lines removed. */
export function spokenParagraphsFromScript(script: string): Para[] {
  const out: Para[] = [];
  for (const block of String(script || '').split(/\n\s*\n/)) {
    const spoken: string[] = [];
    const notes: string[] = [];
    for (const raw of block.split('\n')) {
      const line = raw.trim().replace(/^\*+|\*+$/g, '').trim();
      if (!line) continue;
      if (/^\W*(title|logline|script)\s*[:\-–]/i.test(line) || /^\W*(title|logline|script)\W*$/i.test(line)) {
        continue;
      }
      const note = line.match(/^\[(.*)\]$/);
      if (note) {
        notes.push(note[1].replace(/^\s*(visual|edit|visual\/edit)\s*(note)?\s*[:\-–]\s*/i, '').trim());
        continue;
      }
      // Drop beat labels like "HOOK:" / "(beat 2)" that sometimes prefix a paragraph.
      spoken.push(line.replace(/^\(?[A-Z][A-Z &/]{1,24}\)?\s*[:\-–]\s+/, ''));
    }
    const text = spoken.join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push({ text, ...(notes.length ? { note: notes.join(' ') } : {}) });
    else if (notes.length && out.length) {
      const last = out[out.length - 1];
      last.note = [last.note, ...notes].filter(Boolean).join(' ');
    }
  }
  return out;
}

const words = (t: string) => String(t || '').split(/\s+/).filter(Boolean);

function spokenOf(s: any): string {
  return String(s?.teleprompterPrompt || s?.dialogue?.teleprompterText || '').trim();
}

function isCreatorTake(s: any): boolean {
  return s?.filmedBy !== 'ai' && s?.mediaRole !== 'overlay' && s?.mediaRole !== 'cutaway' && !s?.optionalInsert;
}

export function planSpokenWordCount(plan: { scenes?: any[] }): number {
  return (plan.scenes || []).filter(isCreatorTake).reduce((a, s) => a + words(spokenOf(s)).length, 0);
}

/**
 * If the plan lost most of the approved script's speech, put the script's paragraphs back on the
 * creator takes (in order, balanced by length). Returns the plan unchanged when speech is intact.
 */
export function restoreSpokenLines<T extends { scenes?: any[] }>(plan: T, creativeScript: string): T {
  const paras = spokenParagraphsFromScript(creativeScript);
  const scriptWords = paras.reduce((a, p) => a + words(p.text).length, 0);
  const untouched = () => ({
    ...plan,
    scenes: (plan.scenes || []).map(({ _autoPrompt, ...rest }: any) => rest),
  });
  if (!paras.length || scriptWords < 8) return untouched();
  if (planSpokenWordCount(plan) >= scriptWords * 0.7) return untouched();

  const scenes = [...(plan.scenes || [])];
  let takes = scenes.map((s, i) => (isCreatorTake(s) ? i : -1)).filter((i) => i >= 0);
  if (!takes.length) {
    scenes.unshift({
      sceneNumber: 1,
      title: 'Main take',
      filmedBy: 'user',
      mediaRole: 'capture',
      contentMode: 'dialogue',
      durationSeconds: Math.max(8, Math.round(scriptWords / 2.5)),
      plainInstruction: 'Phone at eye level, chest-up. Speak the whole script in one take.',
      directorTip: 'Keep it natural — authenticity beats perfection.',
      includeInExport: true,
      recipe: { layout: 'talking_head', inserts: [], punchIns: [], transitionOut: 'cut' },
    });
    takes = [0];
  }

  // Contiguous, length-balanced groups of paragraphs — one group per take.
  const groups: Para[][] = takes.map(() => []);
  let acc = 0;
  let g = 0;
  for (const p of paras) {
    groups[g].push(p);
    acc += words(p.text).length;
    const remainingParas = paras.length - paras.indexOf(p) - 1;
    const remainingTakes = takes.length - g - 1;
    if (remainingTakes > 0 && (acc >= (scriptWords * (g + 1)) / takes.length || remainingParas === remainingTakes)) {
      g++;
    }
  }

  takes.forEach((sceneIdx, k) => {
    const text = groups[k].map((p) => p.text).join('\n\n');
    if (!text) return;
    const s = scenes[sceneIdx];
    scenes[sceneIdx] = {
      ...s,
      teleprompterPrompt: text,
      dialogue: { ...(s.dialogue || {}), required: true, teleprompterText: text },
      contentMode: s.contentMode === 'visual_only' ? 'mixed' : s.contentMode || 'dialogue',
      durationSeconds: Math.max(Number(s.durationSeconds) || 0, Math.round(words(text).length / 2.5)),
      _scriptNotes: groups[k].map((p) => p.note).filter(Boolean),
    };
  });
  // AI visuals were timed (and, if the model gave no prompt, described) against the lost lines:
  // re-anchor them to the restored script.
  const restoredSentences = takes.flatMap((i) => sentencesOf(spokenOf(scenes[i])));
  const sceneWords = (t: string) =>
    new Set(words(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')).filter((w) => w.length > 3 && !STOPWORDS.has(w)));
  scenes.forEach((s, i) => {
    if (s?.filmedBy !== 'ai') return;
    const hint = String(s.mediaTimingHint || '').toLowerCase();
    const allSpoken = takes.map((t) => spokenOf(scenes[t])).join(' ').toLowerCase();
    if (hint && allSpoken.includes(hint) && !s._autoPrompt) return;
    const want = sceneWords(`${s.title || ''} ${s._autoPrompt ? '' : s.aiGenerationPrompt || ''}`);
    let best = restoredSentences[Math.floor(restoredSentences.length / 2)] || '';
    let bestScore = 0;
    for (const sentence of restoredSentences) {
      const score = [...sceneWords(sentence)].filter((w) => want.has(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
    if (!best) return;
    const next = { ...s, mediaTimingHint: anchorFor(best) };
    if (s._autoPrompt) {
      next.aiGenerationPrompt = String(s.aiGenerationPrompt).replace(/illustrating: ".*?"\./, `illustrating: "${best}".`);
    }
    scenes[i] = next;
  });

  console.warn(
    `[plan] restored ${scriptWords} spoken words from the approved script (plan had ${planSpokenWordCount(plan)})`
  );
  return { ...plan, scenes: scenes.map(({ _autoPrompt, ...rest }: any) => rest) };
}

/** Sentences of a take, each with its first words as a verbatim anchor. */
function sentencesOf(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 4);
}

function anchorFor(sentence: string): string {
  return words(sentence)
    .slice(0, 6)
    .join(' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** 2–3 strongest words of a sentence, uppercase, in order — a text-pop caption. */
function popTextFor(sentence: string): string {
  const toks = words(sentence).map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, ''));
  const scored = toks
    .map((w, i) => ({ w, i, score: STOPWORDS.has(w.toLowerCase()) || w.length < 3 ? 0 : w.length + (/\d/.test(w) ? 6 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i);
  return (scored.map((x) => x.w).join(' ') || toks.slice(0, 3).join(' ')).toUpperCase().slice(0, 32);
}

function visualPrompt(sentence: string, note: string | undefined, idea: string, kind: 'broll' | 'overlay' | 'meme'): string {
  const topic = String(idea || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (kind === 'meme') {
    return `Funny reaction meme image (no text) for the moment: "${sentence}". Topic: ${topic}.`;
  }
  const framing =
    kind === 'overlay'
      ? 'Clean, simple photo that reads at small size beside the speaker'
      : 'Cinematic, photorealistic vertical b-roll photo, no people facing camera, no text';
  const hint = note ? ` Director note: ${note}.` : '';
  return `${framing}, illustrating: "${sentence}".${hint} Topic: ${topic}.`;
}

/**
 * Add whatever looks the creator picked but the plan is missing, anchored to spoken sentences.
 * Looks already present are left alone; only the shortfall is filled.
 */
export function fillMissingLooks<T extends { scenes?: any[]; estimatedTotalSeconds?: number }>(
  plan: T,
  prefs: ProductionPrefs | null | undefined,
  idea: string
): T {
  const looks = new Set(prefs?.looks || []);
  const scenes = (plan.scenes || []).map((s) => ({ ...s }));
  const takes = scenes.filter((s) => isCreatorTake(s) && spokenOf(s));
  const strip = () => ({
    ...plan,
    scenes: scenes.map(({ _scriptNotes, ...rest }) => rest),
  });
  if (!looks.size || !takes.length) return strip();

  // Virtual background is one look for the whole video: every creator take gets it.
  if (looks.has('virtual_background')) {
    const spread = spreadVirtualBackground(scenes, {
      lookChosen: true,
      fallbackPrompt: `A clean, cinematic background plate (no people, no text) that suits: ${String(idea).slice(0, 160)}`,
    });
    if (spread !== scenes) scenes.splice(0, scenes.length, ...spread);
  }

  const all = scenes.flatMap((s) => (Array.isArray(s?.recipe?.inserts) ? s.recipe.inserts : []));
  const hasPrompt = (i: any) => Boolean(String(i?.prompt || '').trim());
  const aiScenes = scenes.filter((s) => s?.filmedBy === 'ai' && s?.aiGenerationPrompt);
  const total =
    Number(plan.estimatedTotalSeconds) || scenes.reduce((a, s) => a + (Number(s?.durationSeconds) || 0), 0) || 45;

  const have = {
    broll:
      all.filter((i: any) => (i?.kind === 'broll_image' || i?.kind === 'broll_video') && i?.layout !== 'pip' && hasPrompt(i))
        .length + aiScenes.filter((s) => s.mediaRole === 'cutaway').length,
    overlays:
      all.filter((i: any) => (i?.kind === 'broll_image' || i?.kind === 'broll_video') && i?.layout === 'pip' && hasPrompt(i))
        .length + aiScenes.filter((s) => s.mediaRole === 'overlay' && s.overlayLayout !== 'greenscreen').length,
    memes: all.filter((i: any) => i?.kind === 'meme' && (hasPrompt(i) || String(i?.text || '').trim())).length,
    text_pops:
      all.filter((i: any) => i?.kind === 'text_pop').length +
      scenes.filter((s) => String(s?.onScreenText || '').trim()).length,
  };
  const need = {
    broll: looks.has('broll') ? Math.max(0, Math.max(1, Math.min(6, Math.round(total / 20))) - have.broll) : 0,
    overlays: looks.has('overlays') && have.overlays === 0 ? Math.max(1, Math.min(3, Math.round(total / 20))) : 0,
    memes: looks.has('memes') && have.memes === 0 ? 1 : 0,
    text_pops: looks.has('text_pops') && have.text_pops === 0 ? Math.max(1, Math.min(4, Math.round(total / 12))) : 0,
  };
  const wanted = need.broll + need.overlays + need.memes + need.text_pops;

  // Free sentences across all takes (not already anchoring an insert), in script order.
  type Slot = { scene: any; sentence: string; note?: string };
  const slots: Slot[] = [];
  for (const s of takes) {
    const used = new Set<string>(
      (s.recipe?.inserts || []).map((i: any) => String(i?.anchorPhrase || '').toLowerCase())
    );
    const notes: string[] = Array.isArray(s._scriptNotes) ? s._scriptNotes : [];
    sentencesOf(spokenOf(s)).forEach((sentence, idx, arr) => {
      const anchor = anchorFor(sentence).toLowerCase();
      if ([...used].some((u) => u && (anchor.includes(u) || u.includes(anchor)))) return;
      const note = notes.length ? notes[Math.min(notes.length - 1, Math.floor((idx / arr.length) * notes.length))] : undefined;
      slots.push({ scene: s, sentence, note });
    });
  }

  if (wanted && slots.length) {
    // Spread picks evenly through the video; visuals first, then pops on what's left.
    const order: Array<'broll' | 'overlays' | 'memes' | 'text_pops'> = [];
    for (const k of ['overlays', 'broll', 'memes', 'text_pops'] as const) for (let n = 0; n < need[k]; n++) order.push(k);
    const taken = new Set<number>();
    order.forEach((kind, n) => {
      let idx = Math.min(slots.length - 1, Math.floor(((n + 0.5) / order.length) * slots.length));
      for (let step = 0; taken.has(idx) && step < slots.length; step++) idx = (idx + 1) % slots.length;
      if (taken.has(idx)) return;
      taken.add(idx);
      const { scene, sentence, note } = slots[idx];
      const recipe = scene.recipe || { layout: 'talking_head', inserts: [], punchIns: [], transitionOut: 'cut' };
      const anchorPhrase = anchorFor(sentence);
      const add =
        kind === 'text_pops'
          ? { anchorPhrase, kind: 'text_pop', text: popTextFor(sentence), layout: 'full', durationSec: 2 }
          : kind === 'memes'
            ? { anchorPhrase, kind: 'meme', prompt: visualPrompt(sentence, note, idea, 'meme'), layout: 'pip', durationSec: 2 }
            : {
                anchorPhrase,
                kind: 'broll_image',
                prompt: visualPrompt(sentence, note, idea, kind === 'overlays' ? 'overlay' : 'broll'),
                layout: kind === 'overlays' ? 'pip' : 'full',
                durationSec: kind === 'overlays' ? 2.5 : 3,
              };
      scene.recipe = { ...recipe, inserts: [...(recipe.inserts || []), add] };
    });
    console.warn(`[plan] added missing looks: ${JSON.stringify(need)}`);
  }

  return strip();
}
