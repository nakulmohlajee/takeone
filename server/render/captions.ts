/**
 * Word-by-word ASS caption builder for the Master Cut renderer.
 *
 * Styles (ProductionPrefs.captions):
 *   - bold_pop : white UPPERCASE 3–4 word chunks, active word flashes #FFE566 with a quick scale pop,
 *                thick black outline, bottom-center. One ASS event per word (chunk stays on screen).
 *   - karaoke  : one event per chunk with {\kN} tags (centiseconds). Not-yet-sung words are white
 *                (SecondaryColour), sung words switch to #FFE566 (PrimaryColour).
 *   - clean    : plain white, soft outline, no animation, one event per chunk.
 *   - off      : no captions. (Director text overlays are still emitted — they are separate
 *                inserts, not captions. Returns null only when there is nothing to draw.)
 *
 * Fonts: DejaVu Sans (Bold) from `fonts-dejavu-core`, already installed in the Docker image
 * (/usr/share/fonts/truetype/dejavu). Pass `captionFontsDir()` as `fontsdir=` to the ffmpeg
 * `subtitles` filter. To ship a custom face (e.g. Montserrat ExtraBold) drop the .ttf into
 * `public/fonts/` and set CAPTION_FONTS_DIR=public/fonts + CAPTION_FONT_NAME="Montserrat ExtraBold".
 *
 * Timing: the master-timeline cursor mirrors `assembleWithXfade` in server/render.ts
 * (xfade overlap, J/L cuts, optional after-hook intro sting inserted after clip 0).
 */
import { existsSync } from 'fs';
import path from 'path';

export type WordCaptionStyle = 'bold_pop' | 'karaoke' | 'clean' | 'off';

export interface CaptionWordIn {
  w: string;
  start: number;
  end: number;
}

export interface CaptionPhraseIn {
  start: number;
  end: number;
  text: string;
}

/** Accepts both `{start,end}` and the EDL shape `{startOffsetSeconds,durationSeconds}`. */
export interface CaptionTextOverlayIn {
  start?: number;
  end?: number;
  startOffsetSeconds?: number;
  durationSeconds?: number;
  text: string;
  style?: string;
  kind?: string;
}

export interface CaptionClipIn {
  durationSeconds: number;
  captionWords?: CaptionWordIn[];
  captions?: CaptionPhraseIn[];
  textOverlays?: CaptionTextOverlayIn[];
  transition?: string;
  transitionDuration?: number;
}

export interface BuildWordAssOptions {
  clips: CaptionClipIn[];
  width: number;
  height: number;
  style: WordCaptionStyle;
  introDur?: number;
  afterHookIntroDur?: number;
  /** Where captions sit (default bottom) and how big (default medium). */
  position?: 'bottom' | 'middle' | 'top';
  size?: 'small' | 'medium' | 'large';
}

export interface SfxCue {
  t: number;
  kind: 'whoosh' | 'pop';
}

/* ───────────────────────── fonts ───────────────────────── */

const DEJAVU_DIR = '/usr/share/fonts/truetype/dejavu';

/** Directory to pass as `fontsdir=` to ffmpeg's subtitles filter (null → rely on fontconfig). */
export function captionFontsDir(): string | null {
  const env = process.env.CAPTION_FONTS_DIR;
  if (env) {
    const abs = path.isAbsolute(env) ? env : path.join(process.cwd(), env);
    if (existsSync(abs)) return abs;
  }
  return existsSync(DEJAVU_DIR) ? DEJAVU_DIR : null;
}

function captionFontName(): string {
  return process.env.CAPTION_FONT_NAME || 'DejaVu Sans';
}

/* ───────────────────────── helpers ───────────────────────── */

const ACTIVE_BGR = '&H0066E5FF'; // #FFE566 in ASS &HAABBGGRR
const ACTIVE_INLINE = '&H66E5FF&';
const WHITE = '&H00FFFFFF';
const BLACK = '&H00000000';

/** Strip/neutralise characters that ASS treats as override syntax. */
export function escapeAssText(text: string): string {
  return String(text ?? '')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTs(sec: number): string {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function normTransition(t?: string): string {
  return (t || 'hard_cut').toLowerCase().replace(/_/g, '-');
}

const HARD_CUT_NAMES = new Set([
  'cut',
  'hard-cut',
  'cutaway',
  'match-cut',
  'j-cut',
  'l-cut',
]);

/** Same hard-cut set as `xfadeName` in render.ts: true → xfade overlap on that boundary. */
function isXfade(t?: string): boolean {
  return !HARD_CUT_NAMES.has(normTransition(t));
}

function isJl(t?: string): boolean {
  const n = normTransition(t);
  return n === 'j-cut' || n === 'l-cut';
}

/**
 * Master-timeline start of every clip, mirroring assembleWithXfade.
 * When afterHookIntroDur > 0 a 0.3s-fade sting segment sits between clip 0 and clip 1.
 */
function layoutClipStarts(
  clips: CaptionClipIn[],
  introDur: number,
  afterHookIntroDur: number
): number[] {
  type Seg = { clipIdx: number; dur: number; xf: boolean; jl: boolean; td: number };
  const segs: Seg[] = [];
  clips.forEach((c, i) => {
    segs.push({
      clipIdx: i,
      dur: Math.max(0.01, c.durationSeconds || 0),
      xf: i > 0 && isXfade(c.transition),
      jl: i > 0 && isJl(c.transition),
      td: c.transitionDuration || 0.35,
    });
    if (i === 0 && afterHookIntroDur > 0 && clips.length > 0) {
      segs.push({ clipIdx: -1, dur: afterHookIntroDur, xf: true, jl: false, td: 0.3 });
    }
  });

  const starts: number[] = new Array(clips.length).fill(0);
  if (!segs.length) return starts;
  let timeline = segs[0].dur;
  starts[0] = 0;
  for (let k = 1; k < segs.length; k++) {
    const s = segs[k];
    const prev = segs[k - 1];
    const td = Math.min(Math.max(s.td || 0.5, 0.25), Math.min(s.dur, prev.dur) * 0.28);
    let segStart: number;
    if (s.xf) {
      segStart = Math.max(0, timeline - td);
      timeline = segStart + s.dur;
    } else if (s.jl) {
      segStart = timeline;
      timeline = timeline + s.dur - 0.15;
    } else {
      segStart = timeline;
      timeline += s.dur;
    }
    if (s.clipIdx >= 0) starts[s.clipIdx] = segStart;
  }
  const pre = Math.max(0, introDur);
  return starts.map((t) => t + pre);
}

interface Word {
  w: string;
  start: number;
  end: number;
}

/** Clip-local word list: prefer word timings, else spread phrase text across its window. */
function clipWordList(clip: CaptionClipIn): Word[] {
  const dur = Math.max(0.01, clip.durationSeconds || 0);
  const out: Word[] = [];

  if (clip.captionWords?.length) {
    for (const cw of clip.captionWords) {
      const w = escapeAssText(cw.w);
      if (!w) continue;
      const start = Math.min(dur, Math.max(0, Number(cw.start) || 0));
      const end = Math.min(dur, Math.max(start + 0.08, Number(cw.end) || start + 0.2));
      if (start >= dur) continue;
      out.push({ w, start, end });
    }
    out.sort((a, b) => a.start - b.start);
    // De-overlap so each word ends before the next begins
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.04, out[i + 1].start);
    }
    return out;
  }

  for (const cap of clip.captions || []) {
    const tokens = escapeAssText(cap.text || '').split(' ').filter(Boolean);
    if (!tokens.length) continue;
    const s = Math.min(dur, Math.max(0, Number(cap.start) || 0));
    const e = Math.min(dur, Math.max(s + 0.2, Number(cap.end) || dur));
    if (e <= s) continue;
    const weights = tokens.map((t) => t.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = s;
    tokens.forEach((tok, i) => {
      const span = ((e - s) * weights[i]) / total;
      out.push({ w: tok, start: cursor, end: cursor + span });
      cursor += span;
    });
  }
  return out;
}

function chunkWords(words: Word[], maxChars: number): Word[][] {
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    chars = 0;
  };
  for (const word of words) {
    const gap = cur.length ? word.start - cur[cur.length - 1].end : 0;
    if (cur.length && (gap > 0.7 || cur.length >= 4 || chars + 1 + word.w.length > maxChars)) flush();
    cur.push(word);
    chars += (chars ? 1 : 0) + word.w.length;
    if (/[.!?]["')\]]*$/.test(word.w) && cur.length >= 2) flush();
    else if (/[,;:]$/.test(word.w) && cur.length >= 3) flush();
  }
  flush();
  return chunks;
}

function overlayWindow(o: CaptionTextOverlayIn, clipDur: number): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (typeof o.start === 'number' || typeof o.end === 'number') {
    start = Math.max(0, o.start ?? 0);
    end = o.end ?? start + 1.8;
  } else {
    start = Math.max(0, o.startOffsetSeconds ?? 0);
    end = start + Math.max(0.6, o.durationSeconds ?? 1.8);
  }
  end = Math.min(clipDur, end);
  if (end - start < 0.2) return null;
  return { start, end };
}

/* ───────────────────────── public: ASS ───────────────────────── */

export function buildWordAssFile(opts: BuildWordAssOptions): string | null {
  const { clips, width, height, style } = opts;
  const introDur = opts.introDur ?? 0;
  const afterHookIntroDur = opts.afterHookIntroDur ?? 0;
  if (!clips?.length) return null;

  const portrait = height >= width;
  const base = portrait ? width : height;
  const sizeMul = opts.size === 'small' ? 0.8 : opts.size === 'large' ? 1.22 : 1;
  const fs = Math.round(base * (portrait ? 0.088 : 0.1) * sizeMul);
  // ASS numpad alignment: 2 bottom-centre, 5 middle-centre, 8 top-centre.
  const align = opts.position === 'top' ? 8 : opts.position === 'middle' ? 5 : 2;
  const marginV = Math.round(height * (portrait ? 0.16 : 0.09));
  const maxChars = portrait ? 24 : 36;
  const font = captionFontName();
  const outlinePop = Math.max(3, Math.round(fs * 0.13));

  const styleLines = [
    // Name, Font, Size, Primary, Secondary, Outline, Back, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, ML, MR, MV, Encoding
    `Style: Pop,${font},${fs},${WHITE},&H000000FF,${BLACK},&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePop},2,${align},50,50,${marginV},1`,
    `Style: Karaoke,${font},${fs},${ACTIVE_BGR},${WHITE},${BLACK},&H80000000,-1,0,0,0,100,100,0,0,1,${outlinePop},2,${align},50,50,${marginV},1`,
    `Style: Clean,${font},${Math.round(fs * 0.78)},${WHITE},&H000000FF,&H60000000,&H60000000,0,0,0,0,100,100,0,0,1,2,1,${align},60,60,${Math.round(marginV * 0.85)},1`,
    `Style: TextPop,${font},${Math.round(fs * 1.5)},${WHITE},&H000000FF,${BLACK},&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(outlinePop * 1.4)},3,8,60,60,${Math.round(height * 0.2)},1`,
    `Style: Meme,${font},${Math.round(fs * 1.35)},${WHITE},&H000000FF,${BLACK},&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(outlinePop * 1.5)},0,8,50,50,${Math.round(height * 0.07)},1`,
  ];

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const starts = layoutClipStarts(clips, introDur, afterHookIntroDur);
  const events: string[] = [];

  for (let ci = 0; ci < clips.length; ci++) {
    const clip = clips[ci];
    const clipStart = starts[ci];
    const clipDur = Math.max(0.01, clip.durationSeconds || 0);

    /* captions */
    if (style !== 'off') {
      const words = clipWordList(clip);
      const chunks = chunkWords(words, maxChars);
      for (let k = 0; k < chunks.length; k++) {
        const chunk = chunks[k];
        const nextStart = chunks[k + 1]?.[0].start ?? clipDur;
        const lastEnd = chunk[chunk.length - 1].end;
        const chunkEnd = Math.min(clipDur, nextStart, Math.max(lastEnd + 0.12, chunk[0].start + 0.3));

        if (style === 'bold_pop') {
          const upper = chunk.map((x) => x.w.toUpperCase());
          for (let j = 0; j < chunk.length; j++) {
            const s = chunk[j].start;
            const e = j + 1 < chunk.length ? chunk[j + 1].start : chunkEnd;
            if (e - s < 0.03) continue;
            const text = upper
              .map((tok, idx) =>
                idx === j
                  ? `{\\1c${ACTIVE_INLINE}\\fscx122\\fscy122\\t(0,90,\\fscx100\\fscy100)}${tok}{\\r}`
                  : tok
              )
              .join(' ');
            events.push(
              `Dialogue: 0,${toTs(clipStart + s)},${toTs(clipStart + e)},Pop,,0,0,0,,${text}`
            );
          }
        } else if (style === 'karaoke') {
          const text = chunk
            .map((x, j) => {
              const nextS = j + 1 < chunk.length ? chunk[j + 1].start : chunkEnd;
              const cs = Math.max(1, Math.round((nextS - x.start) * 100));
              return `{\\k${cs}}${x.w}`;
            })
            .join(' ');
          const s = chunk[0].start;
          if (chunkEnd - s < 0.05) continue;
          events.push(
            `Dialogue: 0,${toTs(clipStart + s)},${toTs(clipStart + chunkEnd)},Karaoke,,0,0,0,,${text}`
          );
        } else {
          const text = chunk.map((x) => x.w).join(' ');
          const s = chunk[0].start;
          if (chunkEnd - s < 0.05) continue;
          events.push(
            `Dialogue: 0,${toTs(clipStart + s)},${toTs(clipStart + chunkEnd)},Clean,,0,0,0,,${text}`
          );
        }
      }
    }

    /* text overlays (text_pop / meme) — larger, upper third, bold */
    for (const o of clip.textOverlays || []) {
      const raw = escapeAssText(o.text || '');
      if (!raw) continue;
      const win = overlayWindow(o, clipDur);
      if (!win) continue;
      const isMeme = (o.style || o.kind || '').toLowerCase().includes('meme');
      const text = (raw.length > 70 ? raw.slice(0, 67) + '…' : raw).toUpperCase();
      const anim = isMeme ? '{\\fad(80,120)}' : '{\\fad(110,140)\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)}';
      events.push(
        `Dialogue: 1,${toTs(clipStart + win.start)},${toTs(clipStart + win.end)},${isMeme ? 'Meme' : 'TextPop'},,0,0,0,,${anim}${text}`
      );
    }
  }

  if (!events.length) return null;
  return header + events.join('\n') + '\n';
}

/* ───────────────────────── public: SFX cues ───────────────────────── */

/**
 * Master-timeline cue points for optional SFX: whoosh on xfade transitions, pop on text overlays.
 * Same timeline math as buildWordAssFile.
 */
export function buildSfxCues(opts: {
  clips: CaptionClipIn[];
  introDur?: number;
  afterHookIntroDur?: number;
  max?: number;
}): SfxCue[] {
  const { clips } = opts;
  if (!clips?.length) return [];
  const starts = layoutClipStarts(clips, opts.introDur ?? 0, opts.afterHookIntroDur ?? 0);
  const cues: SfxCue[] = [];
  clips.forEach((clip, i) => {
    if (i > 0 && isXfade(clip.transition)) cues.push({ t: Math.max(0, starts[i]), kind: 'whoosh' });
    const dur = Math.max(0.01, clip.durationSeconds || 0);
    for (const o of clip.textOverlays || []) {
      const win = overlayWindow(o, dur);
      if (win) cues.push({ t: starts[i] + win.start, kind: 'pop' });
    }
  });
  cues.sort((a, b) => a.t - b.t);
  return cues.slice(0, opts.max ?? 16);
}
