import React, { useRef, useState } from 'react';
import { GripHorizontal, Type } from 'lucide-react';
import type { DirectorCue } from '../types/director';
import { cueLabel, type PrompterUnit } from '../utils/teleprompter';

type Props = {
  units: PrompterUnit[];
  currentIndex: number;
  nextText: string | null;
  farType: boolean;
  opacity: number;
  onOpacity: (n: number) => void;
  onToggleType: () => void;
  visualCue?: { capture: string; action?: string } | null;
  liveCue: DirectorCue | null;
  offsetY: number;
  onOffsetY: (n: number) => void;
  /** Manual skip — advance when speech match is unavailable */
  onSkip?: () => void;
  waitingForSpeech?: boolean;
  compact?: boolean;
  beatLabel?: string | null;
};

export const SmartTeleprompter: React.FC<Props> = ({
  units,
  currentIndex,
  nextText,
  farType,
  opacity,
  onOpacity,
  onToggleType,
  visualCue,
  liveCue,
  offsetY,
  onOffsetY,
  onSkip,
  waitingForSpeech,
  compact,
  beatLabel,
}) => {
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const current = units[currentIndex];

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startOffset: offsetY };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startY - e.clientY;
    onOffsetY(Math.max(0, Math.min(120, dragRef.current.startOffset + delta)));
  };
  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      className="pointer-events-auto w-full max-w-lg mx-auto min-w-0 overflow-hidden"
      style={{ transform: `translateY(-${offsetY}px)` }}
    >
      {liveCue && (
        <div className="mb-1.5 flex justify-center">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-400 text-black text-[10px] font-black tracking-wide shadow-lg">
            <span aria-hidden>🎥</span>
            {cueLabel(String(liveCue.kind))}
            {liveCue.label ? ` · ${liveCue.label}` : ''}
          </div>
        </div>
      )}

      <div
        className={`rounded-2xl border border-white/20 shadow-xl backdrop-blur-md ${
          compact ? 'px-2.5 pt-0.5 pb-2' : 'px-3 pt-1 pb-3'
        }`}
        style={{ backgroundColor: `rgba(0,0,0,${opacity})` }}
      >
        <div
          className={`flex items-center justify-center py-0.5 text-white/50 ${
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <GripHorizontal className="w-3.5 h-3.5" />
        </div>

        {visualCue && !current?.text ? (
          <div className="text-center space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-emerald-300 font-bold">
              Director cue
            </p>
            <p
              className={`font-black text-white leading-snug break-words ${
                farType ? 'text-xl sm:text-2xl' : 'text-base sm:text-lg'
              }`}
            >
              {visualCue.capture}
            </p>
            {visualCue.action && (
              <p className="text-xs text-white/55 line-clamp-2">{visualCue.action}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSkip?.()}
            className="w-full text-center space-y-1 cursor-pointer"
            title="Tap to skip to next line"
          >
            <p className="text-[10px] uppercase tracking-wider text-amber-300/90 font-bold">
              {beatLabel || 'Current'}
              {waitingForSpeech ? ' · waiting' : ''}
            </p>
            <p
              // Re-keyed per line so each new line slides up — the hand-off reads as movement, not a swap.
              key={currentIndex}
              className={`font-black text-white leading-tight drop-shadow-md break-words px-1 animate-[takeonePrompterIn_180ms_cubic-bezier(0.23,1,0.32,1)] ${
                compact
                  ? farType
                    ? 'text-lg sm:text-xl'
                    : 'text-base sm:text-lg'
                  : farType
                    ? 'text-xl sm:text-2xl md:text-3xl'
                    : 'text-lg sm:text-xl md:text-2xl'
              }`}
            >
              {current?.isPauseOnly ? '… take a breath' : current?.text || '—'}
            </p>
            {nextText && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">
                  Next
                </p>
                <p className="text-xs sm:text-sm text-white/45 leading-snug line-clamp-2">
                  {nextText}
                </p>
              </div>
            )}
            {waitingForSpeech && (
              <p className="text-[10px] text-amber-200/90 font-semibold">
                Waiting for this line… tap to skip
              </p>
            )}
          </button>
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-white/55">
          <button
            type="button"
            onClick={onToggleType}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/10 cursor-pointer"
          >
            <Type className="w-3 h-3" />
            {farType ? 'Huge' : 'Readable'}
          </button>
          <label className="inline-flex items-center gap-1.5">
            Opacity
            <input
              type="range"
              min={0.35}
              max={0.92}
              step={0.05}
              value={opacity}
              onChange={(e) => onOpacity(Number(e.target.value))}
              className="w-14 sm:w-16 accent-amber-300"
            />
          </label>
        </div>
      </div>
    </div>
  );
};
