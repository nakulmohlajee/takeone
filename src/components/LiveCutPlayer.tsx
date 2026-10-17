import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import type { EditDecisionList, EdlClip } from '../utils/edl';
import { mediaUrlFromGcs } from '../utils/mediaVault';

/**
 * Live Cut player — plays the compiled edit (EDL) straight from the source takes, in real time,
 * with no render: jumps over cut pauses/fillers, scales for punch-ins, and draws captions, text
 * pops and AI visuals on top at their times. Every edit shows up as soon as the EDL recompiles;
 * Export makes the final file once.
 */

type Piece = {
  clip: number;
  tStart: number;
  dur: number;
  kind: 'video' | 'image' | 'missing';
  url: string | null;
  inPoint: number;
  outPoint: number;
  zoom: number;
};

type CaptionStyle = 'bold_pop' | 'karaoke' | 'clean' | 'off';

function playable(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('gs://')) return mediaUrlFromGcs(url);
  return url;
}

function buildPieces(clips: EdlClip[]): { pieces: Piece[]; clipStart: number[]; total: number } {
  const pieces: Piece[] = [];
  const clipStart: number[] = [];
  let t = 0;
  clips.forEach((c, ci) => {
    clipStart[ci] = t;
    const url = playable(c.proxyUrl || c.mediaUrl);
    if (c.mediaKind === 'video' && url) {
      const segs =
        c.segments?.length
          ? c.segments
          : [{ inPoint: c.inPoint ?? 0, outPoint: c.outPoint ?? (c.inPoint ?? 0) + c.durationSeconds, zoom: c.zoom }];
      for (const s of segs) {
        const dur = Math.max(0.05, s.outPoint - s.inPoint);
        pieces.push({ clip: ci, tStart: t, dur, kind: 'video', url, inPoint: s.inPoint, outPoint: s.outPoint, zoom: s.zoom || 1 });
        t += dur;
      }
    } else {
      const dur = Math.max(0.5, c.durationSeconds || 2);
      pieces.push({
        clip: ci,
        tStart: t,
        dur,
        kind: c.mediaKind === 'image' && url ? 'image' : 'missing',
        url,
        inPoint: 0,
        outPoint: dur,
        zoom: 1,
      });
      t += dur;
    }
  });
  return { pieces, clipStart, total: t };
}

function pieceAt(pieces: Piece[], t: number): number {
  for (let i = 0; i < pieces.length; i++) if (t < pieces[i].tStart + pieces[i].dur) return i;
  return Math.max(0, pieces.length - 1);
}

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** EDL item id → the project item it came from ("sceneId:ins:N" or "sceneId:scene"). */
export function editKeyForEdlId(id: string): string | null {
  const m = String(id || '').match(/^dir-(.+)-(?:ins|txt)-(\d+)$/);
  if (m) return `${m[1]}:ins:${m[2]}`;
  const o = String(id || '').match(/^overlay-(.+)$/);
  if (o) return `${o[1]}:scene`;
  return null;
}

const stroke: React.CSSProperties = { WebkitTextStroke: '0.14em #000', paintOrder: 'stroke fill' };

export const LiveCutPlayer: React.FC<{
  edl: EditDecisionList | null;
  /** A compile is in flight (the edit just changed). */
  updating?: boolean;
  aspectRatio: string;
  musicUrl?: string | null;
  musicVolume?: number;
  /** Shown over the video when set (e.g. what a tweak just did). */
  banner?: React.ReactNode;
  /** Tap a visual / text pop in the list to edit it. */
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
}> = ({ edl, updating, aspectRatio, musicUrl, musicVolume = 0.18, banner, onSelect, selectedKey }) => {
  const clips = edl?.clips || [];
  const { pieces, clipStart, total } = useMemo(() => buildPieces(clips), [clips]);
  const urls = useMemo(() => [...new Set(pieces.filter((p) => p.kind === 'video').map((p) => p.url!))], [pieces]);
  const captionStyle = ((edl as any)?.captionStyle || 'bold_pop') as CaptionStyle;
  const captionPos = edl?.captionPosition || 'bottom';
  const captionScale = edl?.captionSize === 'small' ? 0.8 : edl?.captionSize === 'large' ? 1.22 : 1;

  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const idxRef = useRef(0);
  const seekingRef = useRef(false);
  const lastFrame = useRef(0);
  const [buffering, setBuffering] = useState(false);

  const setTime = (v: number) => {
    tRef.current = v;
    setT(v);
  };

  const pauseAll = () => {
    videos.current.forEach((v) => v.pause());
    audioRef.current?.pause();
  };

  /** Put the playhead at `time`: pick the piece, seek its video, (re)start playback if playing. */
  const goTo = useCallback(
    (time: number, play: boolean) => {
      if (!pieces.length) return;
      const clamped = Math.max(0, Math.min(total - 0.01, time));
      const i = pieceAt(pieces, clamped);
      idxRef.current = i;
      setTime(clamped);
      const p = pieces[i];
      videos.current.forEach((v, u) => {
        if (p.kind !== 'video' || u !== p.url) v.pause();
      });
      if (p.kind === 'video') {
        const v = videos.current.get(p.url!);
        if (v) {
          const target = p.inPoint + (clamped - p.tStart);
          if (Math.abs(v.currentTime - target) > 0.08) {
            seekingRef.current = true;
            v.currentTime = target;
          }
          if (play) void v.play().catch(() => setPlaying(false));
        }
      }
      const a = audioRef.current;
      if (a && musicUrl) {
        if (a.duration && Number.isFinite(a.duration)) a.currentTime = clamped % a.duration;
        if (play) void a.play().catch(() => undefined);
      }
    },
    [pieces, total, musicUrl]
  );

  // New edit: keep the playhead where it was (within the new length), paused.
  useEffect(() => {
    pauseAll();
    setPlaying(false);
    setTime(Math.min(tRef.current, Math.max(0, total - 0.05)));
    idxRef.current = pieceAt(pieces, tRef.current);
    const p = pieces[idxRef.current];
    if (p?.kind === 'video') {
      const v = videos.current.get(p.url!);
      if (v) v.currentTime = p.inPoint + (tRef.current - p.tStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, musicVolume * 1.6));
  }, [musicVolume, musicUrl]);

  // Playback clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    lastFrame.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastFrame.current) / 1000;
      lastFrame.current = now;
      const i = idxRef.current;
      const p = pieces[i];
      if (!p) return;
      let local: number;
      if (p.kind === 'video') {
        const v = videos.current.get(p.url!);
        if (!v || seekingRef.current) return;
        local = v.currentTime - p.inPoint;
        if (v.ended || local >= p.dur - 0.02) {
          advance(i + 1);
          return;
        }
      } else {
        local = tRef.current - p.tStart + dt;
        if (local >= p.dur) {
          advance(i + 1);
          return;
        }
      }
      setTime(p.tStart + Math.max(0, local));
    };
    const advance = (n: number) => {
      if (n >= pieces.length) {
        pauseAll();
        setPlaying(false);
        setTime(total);
        return;
      }
      const prev = pieces[idxRef.current];
      const next = pieces[n];
      idxRef.current = n;
      setTime(next.tStart);
      if (prev?.kind === 'video' && (next.kind !== 'video' || next.url !== prev.url)) {
        videos.current.get(prev.url!)?.pause();
      }
      if (next.kind === 'video') {
        const v = videos.current.get(next.url!);
        if (!v) return;
        // Pieces that touch (a punch-in boundary) keep playing — the video may already be a frame
        // past the join. Only a real cut, or a different take, seeks.
        const sameTake = prev?.kind === 'video' && prev.url === next.url;
        const touching = sameTake && Math.abs(prev.outPoint - next.inPoint) < 0.05;
        const inside = v.currentTime >= next.inPoint - 0.05 && v.currentTime < next.outPoint;
        if (!(touching && inside) && Math.abs(v.currentTime - next.inPoint) > 0.08) {
          seekingRef.current = true;
          v.currentTime = next.inPoint;
        }
        void v.play().catch(() => undefined);
      }
    };
    // Animation frames drive the clock; a slower interval takes over when they stop (background
    // tab), so the cut keeps being applied — skipped pauses never play.
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      tick(now);
    };
    raf = requestAnimationFrame(frame);
    const backup = window.setInterval(() => {
      const now = performance.now();
      if (now - lastFrame.current > 120) tick(now);
    }, 100);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(backup);
    };
  }, [playing, pieces, total]);

  const toggle = () => {
    if (!pieces.length) return;
    if (playing) {
      pauseAll();
      setPlaying(false);
      return;
    }
    const start = tRef.current >= total - 0.05 ? 0 : tRef.current;
    setPlaying(true);
    goTo(start, true);
  };

  // What is on screen at the playhead.
  const idx = pieceAt(pieces, t);
  const piece = pieces[idx];
  const clip = piece ? clips[piece.clip] : undefined;
  const lt = piece ? t - clipStart[piece.clip] : 0;
  const words = clip?.captionWords || [];
  const activeWord = (() => {
    let k = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start <= lt) k = i;
      else break;
    }
    return k >= 0 && lt <= words[k].end + 0.6 ? k : -1;
  })();
  const chunkSize = captionStyle === 'bold_pop' ? 3 : 6;
  const chunkStart = activeWord >= 0 ? Math.floor(activeWord / chunkSize) * chunkSize : -1;
  const chunk = chunkStart >= 0 ? words.slice(chunkStart, chunkStart + chunkSize) : [];
  const phrase =
    !words.length && captionStyle !== 'off'
      ? clip?.captions?.find((c) => c.start <= lt && lt < c.end)?.text
      : undefined;
  const pops = (clip?.textOverlays || []).filter((o) => o.startOffsetSeconds <= lt && lt < o.startOffsetSeconds + o.durationSeconds);
  const visuals = (clip?.brollInserts || []).filter(
    (b) => b.accepted !== false && b.layout !== 'greenscreen' && b.startOffsetSeconds <= lt && lt < b.startOffsetSeconds + b.durationSeconds
  );

  const markers = useMemo(() => {
    const out: Array<{ at: number; kind: 'visual' | 'pop'; key: string | null; label: string }> = [];
    clips.forEach((c, ci) => {
      for (const b of c.brollInserts || []) {
        if (b.layout === 'greenscreen') continue;
        out.push({
          at: clipStart[ci] + b.startOffsetSeconds,
          kind: 'visual',
          key: editKeyForEdlId(b.id),
          label: b.layout === 'full' || !b.layout ? 'B-roll' : 'Overlay',
        });
      }
      for (const o of c.textOverlays || []) {
        out.push({
          at: clipStart[ci] + o.startOffsetSeconds,
          kind: 'pop',
          key: editKeyForEdlId(o.id),
          label: o.kind === 'meme' ? `Meme “${o.text}”` : `“${o.text}”`,
        });
      }
    });
    out.sort((a, b) => a.at - b.at);
    return out;
  }, [clips, clipStart]);

  const portrait = aspectRatio !== '16:9';

  return (
    <div className="space-y-3">
      <div
        className={`relative mx-auto bg-[#121212] rounded-xl overflow-hidden ${portrait ? 'aspect-[9/16] max-w-[380px]' : 'aspect-video'} w-full`}
        data-ui
      >
        {urls.map((u) => (
          <video
            key={u}
            ref={(el) => {
              if (el) videos.current.set(u, el);
              else videos.current.delete(u);
            }}
            src={u}
            preload="auto"
            playsInline
            onSeeked={() => {
              seekingRef.current = false;
              setBuffering(false);
            }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-150"
            style={{
              opacity: piece?.kind === 'video' && piece.url === u ? 1 : 0,
              transform: piece?.kind === 'video' && piece.url === u ? `scale(${piece.zoom})` : undefined,
            }}
          />
        ))}
        {piece?.kind === 'image' && piece.url && (
          <img src={piece.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
        )}

        {visuals.map((b) => {
          const src = playable(b.mediaUrl);
          if (!src) return null;
          const full = b.layout === 'full' || !b.layout;
          return (
            <img
              key={b.id}
              src={src}
              alt=""
              className={
                full
                  ? 'absolute inset-0 w-full h-full object-cover'
                  : `absolute bottom-[22%] ${b.layout === 'pip_bl' ? 'left-3' : 'right-3'} w-[38%] aspect-[9/16] object-cover rounded-lg`
              }
            />
          );
        })}

        {pops.map((o) => (
          <p
            key={o.id}
            className="absolute inset-x-4 top-[16%] text-center text-[1.6rem] leading-[1.05] font-black text-white"
            style={stroke}
          >
            {o.text}
          </p>
        ))}

        {captionStyle !== 'off' && (chunk.length > 0 || phrase) && (
          <p
            className={`absolute inset-x-3 flex flex-wrap justify-center gap-x-[0.3em] text-center leading-tight text-white ${
              captionPos === 'top' ? 'top-[11%]' : captionPos === 'middle' ? 'top-1/2 -translate-y-1/2' : 'bottom-[11%]'
            } ${captionStyle === 'clean' ? 'font-semibold' : 'font-black uppercase'}`}
            style={{
              ...(captionStyle === 'clean' ? { textShadow: '0 1px 3px rgba(0,0,0,0.8)' } : stroke),
              fontSize: `${(captionStyle === 'clean' ? 1 : 1.15) * captionScale}rem`,
            }}
          >
            {phrase
              ? phrase
              : chunk.map((w, i) => {
                  const k = chunkStart + i;
                  const lit = captionStyle === 'karaoke' ? k <= activeWord : k === activeWord;
                  return (
                    <span key={`${k}-${w.w}`} style={lit && captionStyle !== 'clean' ? { color: '#FFE566' } : undefined}>
                      {w.w}
                    </span>
                  );
                })}
          </p>
        )}

        {(updating || buffering) && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/65 text-white text-xs font-semibold">
            <Loader2 className="w-3 h-3 animate-spin" />
            {updating ? 'Updating edit…' : 'Loading…'}
          </span>
        )}
        {banner && <div className="absolute inset-x-2 top-2">{banner}</div>}

        {!pieces.length && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/70">
            {updating ? 'Building your edit…' : 'No takes to play yet.'}
          </div>
        )}
        {pieces.length > 0 && !playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Play the edit"
            className="absolute inset-0 flex items-center justify-center bg-black/10 hover:bg-black/20 transition-colors cursor-pointer"
          >
            <span className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center">
              <Play className="w-7 h-7 text-[#202124] ml-1" />
            </span>
          </button>
        )}
      </div>

      {musicUrl && <audio ref={audioRef} src={musicUrl} preload="auto" loop />}

      {pieces.length > 0 && (
        <div className="flex items-center gap-3 max-w-[560px] mx-auto">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="w-9 h-9 rounded-full bg-[#1A73E8] text-white flex items-center justify-center shrink-0 hover:bg-[#1557B0] active:scale-95 transition cursor-pointer"
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <div className="relative flex-1 h-9 flex items-center">
            <input
              type="range"
              min={0}
              max={Math.max(0.1, total)}
              step={0.05}
              value={Math.min(t, total)}
              onChange={(e) => goTo(Number(e.target.value), playing)}
              aria-label="Scrub the edit"
              className="w-full accent-[#1A73E8] cursor-pointer"
            />
            {markers.map((m, i) => (
              <span
                key={i}
                aria-hidden
                className={`absolute top-0 w-1 h-1.5 rounded-full pointer-events-none ${m.kind === 'pop' ? 'bg-[#F29900]' : 'bg-[#9333EA]'}`}
                style={{ left: `calc(${(m.at / Math.max(0.1, total)) * 100}% - 2px)` }}
              />
            ))}
          </div>
          <span className="text-xs tabular-nums text-[#5F6368] shrink-0">
            {fmt(t)} / {fmt(total)}
          </span>
        </div>
      )}

      {onSelect && markers.some((m) => m.key) && (
        <div className="max-w-[560px] mx-auto">
          <p className="text-xs font-semibold text-[#5F6368] mb-1.5">Tap one to change it</p>
          <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {markers
              .filter((m) => m.key)
              .map((m) => (
                <button
                  key={`${m.key}-${m.at}`}
                  type="button"
                  aria-pressed={selectedKey === m.key}
                  onClick={() => {
                    goTo(m.at + 0.05, false);
                    onSelect(m.key!);
                  }}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    selectedKey === m.key ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-[#F1F3F4] text-[#3C4043] hover:bg-[#E8EAED]'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${m.kind === 'pop' ? 'bg-[#F29900]' : 'bg-[#9333EA]'}`} />
                  <span className="tabular-nums">{fmt(m.at)}</span>
                  <span className="max-w-[12rem] truncate">{m.label}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};
