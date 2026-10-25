/**
 * Director compiler: ProductionPrefs + per-scene SceneRecipe + word timings → render-ready EDL.
 *
 * Starts from the deterministic master-cut EDL (so channel, intro/outro, music, aspect, AI-disclosure,
 * and non-A-roll clips behave exactly as before) and then rewrites every user-filmed scene into
 * directed pieces:
 *   cleanup (fillers / dead air) → punch-in splits → inserts / text pops → captions → virtual background
 *
 * Pure (no I/O). Safe to call from server routes or tests.
 */
import type { Project, ProductionPrefs, Scene, SceneRecipe, ChannelSettings } from '../../src/types/director';
import type { TransitionPrimitive } from '../../src/types/editorial';
import { matteIsCurrent } from '../../src/utils/virtualBackground';
import {
  buildEditDecisionList,
  collectOverlaysForClip,
  primitiveToLegacyTransition,
  type BrollInsert,
  type EdlCaptionWord,
  type EdlClip,
  type EdlTextOverlay,
  type EditDecisionList,
  type TimedCaption,
} from '../../src/utils/edl';
import {
  buildCleanupKeepRanges,
  normalizeWordToken,
  sourceToCleanTime,
  type KeepRange,
  type Word,
} from './cleanup';

export type DirectorCutReport = {
  fillersRemoved: number;
  silenceRemovedSec: number;
  punchIns: number;
  inserts: number;
  virtualBackgroundScenes: number;
  captionStyle: string;
  summary: string;
  /** Extra detail for UI / debugging */
  insertsUnresolved: number;
  warnings: string[];
  scenes: Array<{
    sceneId: string;
    title: string;
    wordSource: 'words' | 'segments' | 'none';
    fillersRemoved: number;
    silenceRemovedSec: number;
    punchIns: number;
    inserts: number;
    pieces: number;
    keptSeconds: number;
  }>;
};

export type CompileDirectorCutInput = {
  project: Project;
  prefs: ProductionPrefs;
  /** Pass-through to the master EDL builder (player aspect, music / voiceover paths). */
  options?: {
    aspectRatio?: Project['aspectRatio'];
    musicEnabled?: boolean;
    musicGcsPath?: string | null;
    musicVolume?: number;
    voiceoverEnabled?: boolean;
    voiceoverGcsPath?: string | null;
  };
};

export type CompileDirectorCutResult = {
  edl: EditDecisionList;
  report: DirectorCutReport;
};

const MAX_PUNCH_ZOOM = 1.15; // render clamps to 1.15 as well
const MIN_PUNCH_ZOOM = 1.12; // deliberate punch — never a subtle wobble
const MIN_PIECE_SEC = 0.15;
const MIN_PUNCH_PIECE_SEC = 1.5; // punch holds must read as intentional
const MIN_PUNCH_SPACING_SEC = 5; // at most one punch every 5s

/* ───────────────────────── phrase matching ───────────────────────── */

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function tokensClose(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false;
  return 1 - lev(a, b) / maxLen >= 0.75;
}

export type PhraseMatch = { start: number; end: number; score: number; startIndex: number; endIndex: number };

/** Fuzzy-locate `phrase` in word timings. Returns null when nothing reaches the score floor. */
export function findPhraseInWords(words: Word[], phrase: string, minScore = 0.6): PhraseMatch | null {
  const target = String(phrase || '')
    .split(/\s+/)
    .map(normalizeWordToken)
    .filter(Boolean);
  if (!target.length || !words.length) return null;
  const toks = words.map((w) => normalizeWordToken(w.w));

  let best: PhraseMatch | null = null;
  const n = target.length;
  const winLen = Math.min(words.length, n + Math.max(1, Math.ceil(n * 0.4)));

  for (let i = 0; i < words.length; i++) {
    const window = toks.slice(i, i + winLen);
    // LCS with fuzzy equality
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(window.length + 1).fill(0));
    for (let a = 1; a <= n; a++) {
      for (let b = 1; b <= window.length; b++) {
        dp[a][b] = tokensClose(target[a - 1], window[b - 1])
          ? dp[a - 1][b - 1] + 1
          : Math.max(dp[a - 1][b], dp[a][b - 1]);
      }
    }
    const score = dp[n][window.length] / n;
    if (score < minScore) continue;
    if (best && score <= best.score + 1e-9) continue;

    // first / last matched word inside the window
    let first = -1;
    let last = -1;
    for (let b = 0; b < window.length; b++) {
      if (target.some((t) => tokensClose(t, window[b]))) {
        if (first < 0) first = b;
        last = b;
      }
    }
    if (first < 0) continue;
    const si = i + first;
    const ei = i + last;
    best = { start: words[si].start, end: words[ei].end, score, startIndex: si, endIndex: ei };
    if (score >= 0.999) break;
  }
  return best;
}

/** Looser anchor match: the best 3-word slice of the anchor that the creator actually said. */
function findAnchorLoose(words: Word[], phrase: string): PhraseMatch | null {
  const toks = String(phrase || '').split(/\s+/).filter(Boolean);
  if (toks.length <= 3 || !words.length) return null;
  let best: PhraseMatch | null = null;
  for (let i = 0; i + 3 <= toks.length; i++) {
    const m = findPhraseInWords(words, toks.slice(i, i + 3).join(' '), 0.67);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

/** Evenly spaced fallback anchor at `slot` (0–1) of the spoken words. */
function spreadAnchor(words: Word[], slot: number): PhraseMatch | null {
  if (!words.length) return null;
  const si = Math.min(words.length - 1, Math.max(0, Math.floor(slot * words.length)));
  const ei = Math.min(words.length - 1, si + 3);
  return { start: words[si].start, end: words[ei].end, score: 0, startIndex: si, endIndex: ei };
}

function clockLabel(t: number): string {
  const sec = Math.max(0, Math.round(t));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ───────────────────────── word sources ───────────────────────── */

function wordsFromSegments(segs: Array<{ start: number; end: number; text: string }>): Word[] {
  const out: Word[] = [];
  for (const seg of segs) {
    const toks = String(seg.text || '')
      .split(/\s+/)
      .filter(Boolean);
    if (!toks.length || !(seg.end > seg.start)) continue;
    const weights = toks.map((t) => Math.max(1, t.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = seg.start;
    toks.forEach((t, i) => {
      const dur = ((seg.end - seg.start) * weights[i]) / total;
      out.push({ w: t, start: cursor, end: cursor + dur });
      cursor += dur;
    });
  }
  return out;
}

/* ───────────────────────── helpers ───────────────────────── */

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function intersectRanges(a: KeepRange[], b: KeepRange[]): KeepRange[] {
  const out: KeepRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start, y.start);
      const e = Math.min(x.end, y.end);
      if (e - s > 0.04) out.push({ start: round3(s), end: round3(e) });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

function recipeTransitionToPrimitive(t?: SceneRecipe['transitionOut']): TransitionPrimitive {
  switch (t) {
    case 'zoom_snap':
      return 'zoom';
    case 'whip':
      return 'whip';
    case 'crossfade':
      return 'cross_dissolve';
    default:
      return 'hard_cut';
  }
}

function transitionDurationFor(p: TransitionPrimitive): number {
  if (p === 'cross_dissolve') return 0.35;
  if (p === 'zoom' || p === 'whip') return 0.25;
  return 0.35;
}

function captionStyleToChannel(style: ProductionPrefs['captions']): ChannelSettings['captionStyle'] {
  switch (style) {
    case 'bold_pop':
    case 'karaoke':
      return 'tiktok-yellow';
    case 'clean':
    default:
      return 'modern-white';
  }
}

function groupCaptionChunks(words: EdlCaptionWord[], style: ProductionPrefs['captions']): TimedCaption[] {
  const maxWords = style === 'bold_pop' ? 3 : style === 'karaoke' ? 6 : 8;
  const maxDur = style === 'clean' ? 3.2 : style === 'karaoke' ? 2.8 : 1.6;
  const out: TimedCaption[] = [];
  let cur: EdlCaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      start: round3(cur[0].start),
      end: round3(Math.max(cur[cur.length - 1].end, cur[0].start + 0.2)),
      text: cur
        .map((w) => w.w)
        .join(' ')
        .trim(),
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.5) flush();
    cur.push(w);
    const dur = w.end - cur[0].start;
    if (cur.length >= maxWords || dur >= maxDur || /[.!?]["')\]]?$/.test(w.w)) flush();
  }
  flush();
  return out;
}

function inferMediaType(url: string): 'image' | 'video' {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) ? 'video' : 'image';
}

type Piece = { start: number; end: number; zoom: number };

type SceneStats = DirectorCutReport['scenes'][number];

/* ───────────────────────── per-scene compile ───────────────────────── */

function compileScene(args: {
  project: Project;
  scene: Scene;
  baseClips: EdlClip[];
  prefs: ProductionPrefs;
  warnings: string[];
}): {
  clips: EdlClip[];
  stats: SceneStats;
  virtualBg: boolean;
  aiMedia: boolean;
  unresolved: number;
  recipeTransition: TransitionPrimitive;
} {
  const { project, scene, baseClips, prefs, warnings } = args;
  const recipe = scene.recipe;
  const template = baseClips[0];
  const stats: SceneStats = {
    sceneId: scene.id,
    title: scene.title,
    wordSource: 'none',
    fillersRemoved: 0,
    silenceRemovedSec: 0,
    punchIns: 0,
    inserts: 0,
    pieces: 0,
    keptSeconds: 0,
  };

  // Source windows from the master EDL (envelope trims / locked keep ranges)
  const windows: KeepRange[] = baseClips
    .map((c) => ({ start: c.inPoint ?? 0, end: c.outPoint ?? (c.inPoint ?? 0) + c.durationSeconds }))
    .filter((r) => r.end - r.start >= MIN_PIECE_SEC);

  // Words (prefer real word timings; fall back to phrase segments with interpolated words)
  let words: Word[] = [];
  let synthesized = false;
  if (scene.words?.length) {
    words = scene.words.map((w) => ({ w: w.w, start: w.start, end: w.end, conf: w.conf }));
    stats.wordSource = 'words';
  } else if (scene.transcriptSegments?.length) {
    words = wordsFromSegments(scene.transcriptSegments);
    synthesized = words.length > 0;
    if (synthesized) stats.wordSource = 'segments';
  }
  const inWindow = (w: Word) => {
    const mid = (w.start + w.end) / 2;
    return windows.some((r) => mid >= r.start - 0.01 && mid <= r.end + 0.01);
  };
  words = words.filter(inWindow).sort((a, b) => a.start - b.start);
  if (!words.length && prefs.captions !== 'off') {
    warnings.push(`No transcript for "${scene.title}" — captions skipped for this take.`);
  }

  // 1) Cleanup
  let ranges: KeepRange[] = windows;
  const wantCleanup = (prefs.cleanup?.silences || prefs.cleanup?.fillers) && words.length > 0;
  // Only full speech-to-text timings are precise enough to cut between words. Live-caption or
  // interpolated timings drift by hundreds of ms, so cutting on them chops words: trim the
  // dead air before the first word and after the last one, and leave the speech intact.
  const preciseWords = !synthesized && scene.wordsSource === 'stt';
  if (wantCleanup && !preciseWords) {
    const head = Math.max(0, words[0].start - 0.35);
    const tail = words[words.length - 1].end + 0.5;
    const trimmed = intersectRanges([{ start: head, end: tail }], windows);
    if (trimmed.length) ranges = trimmed;
    warnings.push(
      `Kept "${scene.title}" uncut between words — its word timings weren't precise enough to remove pauses safely.`
    );
  } else if (wantCleanup) {
    const cleaned = buildCleanupKeepRanges(words, {
      removeSilences: Boolean(prefs.cleanup.silences),
      // Interpolated word times are too coarse to cut individual fillers safely
      removeFillers: Boolean(prefs.cleanup.fillers) && !synthesized,
      language: project.spokenLanguage || project.creativeBrief?.spokenLanguage,
      durationSec: synthesized ? undefined : Math.max(...windows.map((w) => w.end)),
    });
    const intersected = intersectRanges(cleaned.keepRanges, windows);
    if (intersected.length) {
      ranges = intersected;
      stats.fillersRemoved = cleaned.fillersRemoved;
      stats.silenceRemovedSec = cleaned.silenceRemovedSec;
    }
  }

  // 2) Punch-ins → zoom windows in source time
  // Base zoom is always 1.0. editZoom / template.zoom never apply to every piece
  // (that caused a constant 1.1 crop + wobble across jump cuts).
  type PunchWin = { start: number; end: number; zoom: number };
  const punchWins: PunchWin[] = [];
  const recipePunches = recipe?.punchIns?.length ? recipe.punchIns : [];
  if (recipePunches.length && words.length) {
    const resolved: PunchWin[] = [];
    recipePunches.forEach((p, pIdx) => {
      let m = findPhraseInWords(words, p.anchorPhrase) || findAnchorLoose(words, p.anchorPhrase);
      if (!m) {
        m = spreadAnchor(words, (pIdx + 1) / (recipePunches.length + 1));
        if (!m) return;
        warnings.push(
          `Zoom moved in "${scene.title}": you didn't say "${p.anchorPhrase}" in the take, so the punch-in lands at ${clockLabel(m.start - (ranges[0]?.start || 0))} instead.`
        );
      }
      const mid = (m.start + m.end) / 2;
      if (sourceToCleanTime(mid, ranges) == null) {
        warnings.push(
          `Zoom skipped in "${scene.title}": the line "${p.anchorPhrase}" was trimmed as a pause or filler.`
        );
        return;
      }
      // Snap punch start to the keep-range that contains the anchor (never cross a cleanup cut)
      const host = ranges.find((r) => mid >= r.start && mid <= r.end);
      if (!host) return;
      const zoom = Math.min(MAX_PUNCH_ZOOM, Math.max(MIN_PUNCH_ZOOM, Number(p.zoom) || MIN_PUNCH_ZOOM));
      const hold = Math.min(4, Math.max(MIN_PUNCH_PIECE_SEC, m.end - m.start + 0.4));
      const start = Math.max(host.start, m.start);
      const end = Math.min(host.end, start + hold);
      if (end - start >= MIN_PUNCH_PIECE_SEC) resolved.push({ start, end, zoom });
    });
    resolved.sort((a, b) => a.start - b.start);
    let lastEnd = -Infinity;
    for (const cur of resolved) {
      if (cur.start < lastEnd + MIN_PUNCH_SPACING_SEC) continue; // max one punch / 5s
      if (cur.end > lastEnd && cur.start < lastEnd) cur.start = lastEnd;
      if (cur.end - cur.start >= MIN_PUNCH_PIECE_SEC) {
        punchWins.push(cur);
        lastEnd = cur.end;
      }
    }
  } else if ((template.zoom || 0) > 1.001 && words.length) {
    // editZoom with no recipe punches → one punch on the first sentence (never constant zoom)
    const first = words[0];
    const host = ranges.find((r) => first.start >= r.start - 0.05 && first.start <= r.end);
    if (host) {
      const zoom = Math.min(MAX_PUNCH_ZOOM, Math.max(MIN_PUNCH_ZOOM, Number(template.zoom) || MIN_PUNCH_ZOOM));
      const start = Math.max(host.start, first.start);
      const end = Math.min(host.end, start + Math.max(MIN_PUNCH_PIECE_SEC, 2));
      if (end - start >= MIN_PUNCH_PIECE_SEC) punchWins.push({ start, end, zoom });
    }
  }
  stats.punchIns = punchWins.length;

  // Split keep ranges at punch boundaries. Non-punch pieces are always zoom 1.0.
  // Punch boundaries only land inside a keep range (never across a cleanup jump cut).
  const pieces: Piece[] = [];
  for (const r of ranges) {
    const bounds = new Set<number>();
    for (const pw of punchWins) {
      for (const t of [pw.start, pw.end]) {
        if (t > r.start + MIN_PIECE_SEC && t < r.end - MIN_PIECE_SEC) bounds.add(round3(t));
      }
    }
    const cuts = [r.start, ...Array.from(bounds).sort((a, b) => a - b), r.end];
    const spaced: number[] = [cuts[0]];
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - spaced[spaced.length - 1] >= MIN_PIECE_SEC || i === cuts.length - 1) {
        if (
          i === cuts.length - 1 &&
          cuts[i] - spaced[spaced.length - 1] < MIN_PIECE_SEC &&
          spaced.length > 1
        ) {
          spaced.pop();
        }
        spaced.push(cuts[i]);
      }
    }
    for (let i = 0; i < spaced.length - 1; i++) {
      const s = spaced[i];
      const e = spaced[i + 1];
      if (e - s < MIN_PIECE_SEC) continue;
      const mid = (s + e) / 2;
      const win = punchWins.find((pw) => mid >= pw.start && mid <= pw.end);
      pieces.push({
        start: round3(s),
        end: round3(e),
        zoom: win ? win.zoom : 1,
      });
    }
  }
  if (!pieces.length) {
    // Never drop a take: fall back to the master windows at zoom 1
    for (const w of windows) pieces.push({ start: w.start, end: w.end, zoom: 1 });
  }

  // 3) Inserts → resolve to source time → scene-clean-timeline offsets (one clip per scene)
  const looks = new Set(prefs.looks || []);
  const sceneInserts: BrollInsert[] = [];
  const sceneText: EdlTextOverlay[] = [];
  const scenePending: NonNullable<EdlClip['pendingInserts']> = [];
  const consumedBrollIds = new Set<string>();
  let aiMedia = false;
  let unresolved = 0;

  const sceneDur = pieces.reduce((a, p) => a + (p.end - p.start), 0);
  const sourceToSceneClean = (t: number): number | null => {
    let acc = 0;
    for (const p of pieces) {
      if (t >= p.start - 1e-6 && t <= p.end + 1e-6) return acc + Math.max(0, t - p.start);
      if (t < p.start) return acc; // snap to next piece start
      acc += p.end - p.start;
    }
    return acc;
  };

  if (recipe?.inserts?.length) {
    const sceneBroll = (scene.brollInserts || []).filter((b) => b.accepted !== false && b.mediaUrl);
    recipe.inserts.forEach((ins, idx) => {
      if (ins.enabled === false) return; // creator switched it off
      const isBroll = ins.kind === 'broll_image' || ins.kind === 'broll_video';
      if (isBroll && !(looks.has('broll') || looks.has('overlays'))) return;
      if (ins.kind === 'meme' && !looks.has('memes')) return;
      if (ins.kind === 'text_pop' && !looks.has('text_pops')) return;

      const slot = (idx + 1) / (recipe.inserts!.length + 1);
      const m = words.length
        ? findPhraseInWords(words, ins.anchorPhrase) || findAnchorLoose(words, ins.anchorPhrase)
        : null;
      let cleanStart: number | null;
      if (m) {
        cleanStart = sourceToSceneClean(m.start);
      } else {
        // Never drop a look the creator asked for: space unmatched inserts evenly through the take.
        const spread = spreadAnchor(words, slot);
        cleanStart = spread ? sourceToSceneClean(spread.start) : sceneDur * slot;
        const what =
          ins.kind === 'text_pop'
            ? `text pop "${(ins.text || ins.anchorPhrase || '').trim()}"`
            : ins.kind === 'meme'
              ? 'meme'
              : 'b-roll';
        warnings.push(
          `${what.charAt(0).toUpperCase()}${what.slice(1)} in "${scene.title}" placed at ${clockLabel(cleanStart ?? 0)} — ${
            words.length
              ? `you didn't say "${ins.anchorPhrase}" in the take, so I spaced it evenly.`
              : 'no transcript for this take, so I spaced it evenly.'
          }`
        );
      }
      if (cleanStart == null) {
        unresolved += 1;
        return;
      }
      const dur = Math.max(0.4, Math.min(Number(ins.durationSec) || 2, sceneDur));
      // The creator can nudge a visual earlier/later than its phrase.
      const nudged = cleanStart + (Number((ins as any).offsetSec) || 0);
      const startLocal = Math.max(0, Math.min(Math.max(0, sceneDur - Math.max(0.4, dur)), nudged));
      const durLocal = Math.max(0.4, Math.min(dur, sceneDur - startLocal));

      if (isBroll || ins.kind === 'meme') {
        const assetUrl: string | undefined =
          (ins as any).assetUrl ||
          (ins as any).mediaUrl ||
          (() => {
            const byPrompt = sceneBroll.find(
              (b) =>
                !consumedBrollIds.has(b.id) &&
                ins.prompt &&
                b.prompt &&
                b.prompt.trim() === ins.prompt.trim(),
            );
            const pick = byPrompt || sceneBroll.find((b) => !consumedBrollIds.has(b.id));
            if (pick) {
              consumedBrollIds.add(pick.id);
              return pick.mediaUrl;
            }
            return undefined;
          })();

        if (assetUrl) {
          const type: 'image' | 'video' =
            ins.kind === 'broll_video'
              ? 'video'
              : ins.kind === 'broll_image'
                ? 'image'
                : inferMediaType(assetUrl);
          sceneInserts.push({
            id: `dir-${scene.id}-ins-${idx}`,
            mediaUrl: assetUrl,
            mediaType: type,
            startOffsetSeconds: round3(startLocal),
            durationSeconds: round3(durLocal),
            layout: ins.layout === 'pip' ? 'pip_br' : 'full',
            source: type === 'video' ? 'ai_video' : 'ai_still',
            accepted: true,
            prompt: ins.prompt,
            disclosureLabel: ins.kind === 'meme' ? undefined : 'AI generated',
          });
          if (ins.kind !== 'meme') aiMedia = true;
          stats.inserts += 1;
          return;
        }
        if (ins.kind === 'meme' && ins.text?.trim()) {
          sceneText.push({
            id: `dir-${scene.id}-txt-${idx}`,
            kind: 'meme',
            text: ins.text.trim(),
            startOffsetSeconds: round3(startLocal),
            durationSeconds: round3(durLocal),
          });
          stats.inserts += 1;
          return;
        }
        scenePending.push({
          anchorPhrase: ins.anchorPhrase,
          kind: ins.kind,
          prompt: ins.prompt,
          startOffsetSeconds: round3(startLocal),
        });
        warnings.push(
          `Insert has no media yet in "${scene.title}": ${ins.kind} "${ins.prompt || ins.anchorPhrase}"`,
        );
        unresolved += 1;
        return;
      }

      const text = (ins.text || ins.anchorPhrase || '').trim();
      if (!text) return;
      sceneText.push({
        id: `dir-${scene.id}-txt-${idx}`,
        kind: 'text_pop',
        text,
        startOffsetSeconds: round3(startLocal),
        durationSeconds: round3(durLocal),
      });
      stats.inserts += 1;
    });
  }

  // 4) Virtual background plate — one plate spanning the whole scene
  // A baked take already has the background composited in while recording — no plate, no key.
  // A plain-camera take has no green to key, so a plate would do nothing.
  // A server-matted take already has the background in it, like a baked one.
  const baked = Boolean(scene.virtualBackgroundBaked) || matteIsCurrent(scene, project);
  // Plain camera: recorded without the in-browser composite, or imported footage.
  const rawCamera =
    !baked &&
    (scene.virtualBackgroundMode === 'none' || (!scene.virtualBackgroundMode && scene.mediaSource === 'imported'));
  const bgUrl =
    recipe?.layout === 'virtual_background' && !baked && !rawCamera ? recipe.background?.assetUrl : undefined;
  // Export never waits for the background job: a plain-camera take that isn't matted yet is
  // matted by the export itself (no green plate needed).
  const matteBackgroundUrl =
    recipe?.layout === 'virtual_background' && rawCamera ? recipe.background?.assetUrl : undefined;
  let virtualBg = baked || Boolean(matteBackgroundUrl);
  if (recipe?.layout === 'virtual_background' && rawCamera && !matteBackgroundUrl) {
    warnings.push(`"${scene.title}": the virtual background picture isn't ready yet — generate it, then export again.`);
  } else if (recipe?.layout === 'virtual_background' && !bgUrl && !baked && !rawCamera) {
    warnings.push(`Virtual background requested for "${scene.title}" but no background asset is ready yet.`);
  }

  // 5) Emit ONE clip per scene with segments (cleanup + punch zooms)
  const captionsOn = prefs.captions !== 'off';
  const sceneWords: EdlCaptionWord[] = captionsOn
    ? words
        .map((w) => {
          const mid = (w.start + w.end) / 2;
          const cs = sourceToSceneClean(mid);
          if (cs == null) return null;
          const s = sourceToSceneClean(w.start) ?? cs;
          const e = sourceToSceneClean(w.end) ?? cs + 0.04;
          return {
            w: w.w,
            start: round3(Math.max(0, s)),
            end: round3(Math.min(sceneDur, Math.max(e, s + 0.04))),
            conf: w.conf,
          } as EdlCaptionWord;
        })
        .filter((w): w is EdlCaptionWord => Boolean(w))
    : [];

  const inherited = collectOverlaysForClip(
    project,
    scene,
    pieces[0].start,
    pieces[pieces.length - 1].end,
  )
    .filter((b) => !consumedBrollIds.has(b.id))
    // The take's own virtual background wins; a second green-screen plate would key twice.
    .filter((b) => !((bgUrl || baked) && b.layout === 'greenscreen'));
  // Remap inherited overlays (source-local) onto scene-clean time when possible
  const remappedInherited = inherited.map((b) => {
    const cs = sourceToSceneClean(pieces[0].start + (b.startOffsetSeconds || 0));
    return {
      ...b,
      startOffsetSeconds: round3(cs ?? b.startOffsetSeconds),
      durationSeconds: round3(Math.min(b.durationSeconds, sceneDur)),
    };
  });
  const brollInserts: BrollInsert[] = [...remappedInherited, ...sceneInserts];
  if (bgUrl) {
    virtualBg = true;
    brollInserts.unshift({
      id: `dir-${scene.id}-bg`,
      mediaUrl: bgUrl,
      mediaType: inferMediaType(bgUrl),
      startOffsetSeconds: 0,
      durationSeconds: round3(sceneDur),
      layout: 'greenscreen',
      source: inferMediaType(bgUrl) === 'video' ? 'ai_video' : 'ai_still',
      accepted: true,
      prompt: recipe?.background?.prompt,
      disclosureLabel: 'AI generated background',
    });
    aiMedia = true;
  }

  const clip: EdlClip = {
    ...template,
    ...(matteBackgroundUrl ? { matteBackgroundUrl, proxyUrl: undefined } : {}),
    title: scene.title,
    durationSeconds: round3(sceneDur),
    inPoint: pieces[0].start,
    outPoint: pieces[pieces.length - 1].end,
    zoom: 1,
    fadeOutSeconds: undefined,
    transcript: scene.transcript,
    captions: captionsOn ? groupCaptionChunks(sceneWords, prefs.captions) : [],
    captionWords: captionsOn ? sceneWords : undefined,
    brollInserts,
    textOverlays: sceneText.length ? sceneText : undefined,
    pendingInserts: scenePending.length ? scenePending : undefined,
    transitionIn: 'hard_cut',
    transitionOut: 'hard_cut',
    transition: 'cut',
    transitionDuration: 0.35,
    segments: pieces.map((p) => ({
      inPoint: p.start,
      outPoint: p.end,
      zoom: p.zoom,
    })),
  };

  stats.pieces = pieces.length;
  stats.keptSeconds = round3(sceneDur);

  return {
    clips: [clip],
    stats,
    virtualBg,
    aiMedia,
    unresolved,
    recipeTransition: recipeTransitionToPrimitive(recipe?.transitionOut),
  };
}

/* ───────────────────────── project compile ───────────────────────── */

const HARD_CUTS = new Set(['cut', 'hard_cut', 'cutaway', 'match_cut', 'j_cut', 'l_cut']);

export function compileDirectorCut(input: CompileDirectorCutInput): CompileDirectorCutResult {
  const { project, prefs, options } = input;
  const warnings: string[] = [];

  const captionsOn = prefs.captions !== 'off';
  const base = buildEditDecisionList(project, {
    mode: 'master',
    aspectRatio: options?.aspectRatio,
    musicEnabled: prefs.music ? options?.musicEnabled : false,
    musicGcsPath: options?.musicGcsPath,
    musicVolume: options?.musicVolume ?? project.musicVolume,
    voiceoverEnabled: options?.voiceoverEnabled,
    voiceoverGcsPath: options?.voiceoverGcsPath,
    channelOverrides: {
      captionsEnabled: captionsOn,
      captionStyle: captionStyleToChannel(prefs.captions),
    },
  });

  const sceneById = new Map(project.scenes.map((s) => [s.id, s]));
  const groups = new Map<string, EdlClip[]>();
  for (const c of base.clips) {
    const id = c.sourceId || c.sceneId;
    const scene = sceneById.get(id);
    if (!scene || scene.filmedBy !== 'user' || c.isBroll || c.mediaKind !== 'video') continue;
    groups.set(id, [...(groups.get(id) || []), c]);
  }

  const outClips: EdlClip[] = [];
  const emitted = new Set<string>();
  const sceneTransitionOut = new Map<string, TransitionPrimitive>();
  const directedScenes = new Set<string>();
  const sceneStats: DirectorCutReport['scenes'] = [];
  let fillersRemoved = 0;
  let silenceRemovedSec = 0;
  let punchIns = 0;
  let inserts = 0;
  let insertsUnresolved = 0;
  let virtualBackgroundScenes = 0;
  let aiDisclosure = base.aiDisclosureRequired;

  for (const clip of base.clips) {
    const id = clip.sourceId || clip.sceneId;
    const group = groups.get(id);
    if (!group) {
      outClips.push(clip);
      continue;
    }
    if (emitted.has(id)) continue;
    emitted.add(id);

    const scene = sceneById.get(id)!;
    const compiled = compileScene({ project, scene, baseClips: group, prefs, warnings });
    outClips.push(...compiled.clips);
    directedScenes.add(id);
    sceneTransitionOut.set(id, compiled.recipeTransition);
    sceneStats.push(compiled.stats);
    fillersRemoved += compiled.stats.fillersRemoved;
    silenceRemovedSec += compiled.stats.silenceRemovedSec;
    punchIns += compiled.stats.punchIns;
    inserts += compiled.stats.inserts;
    insertsUnresolved += compiled.unresolved;
    if (compiled.virtualBg) virtualBackgroundScenes += 1;
    if (compiled.aiMedia) aiDisclosure = true;
  }

  // Transition into clip i (this codebase's renderer reads clip[i].transitionOut for the i-1 → i boundary)
  for (let i = 1; i < outClips.length; i++) {
    const cur = outClips[i];
    const prev = outClips[i - 1];
    const curId = cur.sourceId || cur.sceneId;
    const prevId = prev.sourceId || prev.sceneId;
    if (!directedScenes.has(curId)) continue;
    const prim: TransitionPrimitive =
      prevId === curId ? 'hard_cut' : sceneTransitionOut.get(prevId) || 'hard_cut';
    cur.transitionIn = prim;
    cur.transitionOut = prim;
    cur.transition = primitiveToLegacyTransition(prim);
    cur.transitionDuration = transitionDurationFor(prim);
  }

  // Soft fade-out on the final talking-head clip
  for (const c of outClips) c.fadeOutSeconds = undefined;
  for (let i = outClips.length - 1; i >= 0; i--) {
    if (!outClips[i].isBroll && outClips[i].mediaKind === 'video') {
      outClips[i].fadeOutSeconds = 0.2;
      break;
    }
  }

  // Duration math (same rules as buildEditDecisionListFromPlan)
  const scenesTotal = outClips.reduce((a, c) => a + c.durationSeconds, 0);
  let overlap = 0;
  for (let i = 1; i < outClips.length; i++) {
    const t = String(outClips[i].transitionOut || outClips[i].transition || 'cut');
    if (!HARD_CUTS.has(t)) overlap += (outClips[i].transitionDuration || 0.35) * 0.5;
  }
  const totalDurationSeconds = Math.max(
    0,
    base.introDurationSeconds + scenesTotal - overlap + base.outroSafeSeconds,
  );

  const silRounded = Math.round(silenceRemovedSec * 10) / 10;
  const parts: string[] = [];
  if (prefs.cleanup?.fillers || prefs.cleanup?.silences) {
    parts.push(
      `Removed ${fillersRemoved} filler${fillersRemoved === 1 ? '' : 's'} and ${silRounded.toFixed(1)}s of dead air`,
    );
  }
  if (punchIns) parts.push(`added ${punchIns} punch-in${punchIns === 1 ? '' : 's'}`);
  if (inserts) parts.push(`placed ${inserts} insert${inserts === 1 ? '' : 's'}`);
  if (virtualBackgroundScenes) {
    parts.push(
      `virtual background on ${virtualBackgroundScenes} scene${virtualBackgroundScenes === 1 ? '' : 's'}`,
    );
  }
  if (captionsOn) parts.push(`${prefs.captions.replace('_', ' ')} captions`);
  let summary = parts.length ? parts.join(', ') : 'No automatic edits applied';
  summary = `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`;

  const report: DirectorCutReport = {
    fillersRemoved,
    silenceRemovedSec: Math.round(silenceRemovedSec * 1000) / 1000,
    punchIns,
    inserts,
    virtualBackgroundScenes,
    captionStyle: prefs.captions,
    summary,
    insertsUnresolved,
    warnings,
    scenes: sceneStats,
  };

  const edl: EditDecisionList = {
    ...base,
    clips: outClips,
    totalDurationSeconds,
    aiDisclosureRequired: aiDisclosure,
    warnings: [...(base.warnings || []), ...warnings],
    captionStyle: prefs.captions,
    captionPosition: prefs.captionPosition,
    captionSize: prefs.captionSize,
    cleanup: prefs.cleanup,
    directorReport: report as unknown as Record<string, unknown>,
    musicVolume: options?.musicVolume ?? project.musicVolume ?? 0.18,
  };

  return { edl, report };
}
