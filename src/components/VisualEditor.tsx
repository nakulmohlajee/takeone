import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Trash2, X } from 'lucide-react';
import type { Project } from '../types/director';
import type { TweakOp } from '../utils/tweaks';

/**
 * Direct controls for one visual or text pop picked from the Live edit list: timing, length,
 * size, text / image prompt, delete. Every change is a tweak op, so it updates the live edit
 * immediately and can be undone like a prompt tweak.
 */
export const VisualEditor: React.FC<{
  project: Project;
  editKey: string;
  onApply: (ops: TweakOp[]) => void;
  /** Change the image prompt and regenerate the picture. */
  onRegenerate: (op: TweakOp) => void;
  onClose: () => void;
}> = ({ project, editKey, onApply, onRegenerate, onClose }) => {
  const [sceneId, type, idxRaw] = editKey.split(':');
  const scene = project.scenes.find((s) => s.id === sceneId);
  const index = Number(idxRaw);
  const ins = type === 'ins' ? scene?.recipe?.inserts[index] : undefined;
  const isScene = type === 'scene' && scene?.filmedBy === 'ai';

  const isText = ins?.kind === 'text_pop';
  const duration = isScene ? scene?.overlayDurationSeconds || 2.5 : Number(ins?.durationSec) || 2;
  const [text, setText] = useState('');
  useEffect(() => {
    setText(isText ? ins?.text || '' : isScene ? scene?.aiGenerationPrompt || '' : ins?.prompt || '');
    // reset the field when a different item is picked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);

  if (!scene || (!ins && !isScene)) return null;

  const label = isScene
    ? 'AI overlay'
    : ins!.kind === 'meme'
      ? 'Meme'
      : isText
        ? 'Text pop'
        : ins!.layout === 'pip'
          ? 'Overlay'
          : 'B-roll';

  const set = (patch: { duration?: number; nudge?: number; layout?: 'full' | 'pip'; text?: string }) =>
    onApply([
      isScene
        ? { op: 'set_overlay_scene', sceneId, duration: patch.duration, nudge: patch.nudge }
        : { op: 'set_visual', sceneId, index, ...patch },
    ]);

  const btn =
    'inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer active:scale-[0.97]';

  return (
    <div className="max-w-[560px] mx-auto rounded-xl bg-[#F8F9FA] p-3.5 space-y-3" role="group" aria-label={`Edit ${label}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-[#202124]">{label}</span>
        {!isScene && <span className="text-xs text-[#5F6368] truncate">on “{ins!.anchorPhrase}”</span>}
        <button type="button" onClick={onClose} aria-label="Close editor" className="ml-auto p-1 text-[#5F6368] hover:text-[#202124] cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <span className="text-xs font-semibold text-[#5F6368]">Timing</span>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => set({ nudge: -0.5 })} className={`${btn} bg-white text-[#3C4043] hover:bg-[#F1F3F4]`}>
              <ChevronLeft className="w-3.5 h-3.5" /> Earlier
            </button>
            <button type="button" onClick={() => set({ nudge: 0.5 })} className={`${btn} bg-white text-[#3C4043] hover:bg-[#F1F3F4]`}>
              Later <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <label className="space-y-1 block">
          <span className="text-xs font-semibold text-[#5F6368] tabular-nums">On screen for {duration.toFixed(1)}s</span>
          <input
            type="range"
            min={0.5}
            max={10}
            step={0.5}
            value={duration}
            onChange={(e) => set({ duration: Number(e.target.value) })}
            className="w-full accent-[#1A73E8] cursor-pointer"
          />
        </label>
      </div>

      {!isText && !isScene && ins!.kind !== 'meme' && (
        <div className="flex gap-1.5">
          {(['full', 'pip'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={ins!.layout === l}
              onClick={() => set({ layout: l })}
              className={`${btn} ${ins!.layout === l ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-white text-[#3C4043] hover:bg-[#F1F3F4]'}`}
            >
              {l === 'full' ? 'Full screen' : 'Beside you'}
            </button>
          ))}
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-semibold text-[#5F6368]">{isText ? 'Words on screen' : 'Image prompt'}</span>
        {isText ? (
          <input
            value={text}
            maxLength={40}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text.trim() !== (ins!.text || '') && set({ text: text.trim() })}
            className="w-full rounded-lg border border-[#DADCE0] bg-white px-2.5 py-2 text-sm"
          />
        ) : (
          <textarea
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-[#DADCE0] bg-white px-2.5 py-2 text-xs leading-relaxed resize-y"
          />
        )}
      </label>

      <div className="flex flex-wrap gap-1.5">
        {!isText && (
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() =>
              onRegenerate(
                isScene
                  ? { op: 'set_overlay_scene', sceneId, prompt: text.trim() }
                  : { op: 'set_visual', sceneId, index, prompt: text.trim() }
              )
            }
            className={`${btn} bg-[#1A73E8] text-white hover:bg-[#1557B0] disabled:opacity-50`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Regenerate image
          </button>
        )}
        {!isScene && (
          <button
            type="button"
            onClick={() => {
              onApply([{ op: 'remove_visual', sceneId, index }]);
              onClose();
            }}
            className={`${btn} bg-white text-[#C5221F] hover:bg-[#FCE8E6]`}
          >
            <Trash2 className="w-3.5 h-3.5" /> Remove
          </button>
        )}
      </div>
    </div>
  );
};
