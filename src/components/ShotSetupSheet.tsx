import React from 'react';
import { Camera, Clock, Footprints, Lightbulb, MonitorSmartphone, Sparkles, X } from 'lucide-react';
import { formatDuration, type Scene } from '../types/director';

interface Props {
  scene: Scene;
  /** "Shot 2 of 3" / "Main take". */
  heading: string;
  isSingleTake: boolean;
  wantsVirtualBg: boolean;
  /** Record button is blocked (virtual background still loading). */
  recordBlocked?: boolean;
  onStart: () => void;
  onHide: () => void;
}

/**
 * Shown over the camera before each shot is recorded, so the setup from the shot list is in
 * front of you at the moment you need it — the camera overlay only has room for two lines.
 */
export const ShotSetupSheet: React.FC<Props> = ({
  scene,
  heading,
  isSingleTake,
  wantsVirtualBg,
  recordBlocked,
  onStart,
  onHide,
}) => {
  const v = scene.visual || {};
  const rows: Array<{ icon: React.ReactNode; label: string; text: string }> = [];
  const phone = [v.camera, v.framing].filter(Boolean).join(' · ');
  if (phone) rows.push({ icon: <Camera className="w-4 h-4" />, label: 'Phone', text: phone });
  const action = v.action || v.movement;
  if (action) rows.push({ icon: <Footprints className="w-4 h-4" />, label: 'Action', text: action });
  if (v.environment) rows.push({ icon: <MonitorSmartphone className="w-4 h-4" />, label: 'Where', text: v.environment });
  rows.push({
    icon: <Clock className="w-4 h-4" />,
    label: 'Length',
    text: isSingleTake
      ? `About ${formatDuration(scene.durationSeconds || 30)} — keep rolling through every beat`
      : `About ${formatDuration(scene.durationSeconds || 5)} — keep recording ~2s after you finish`,
  });
  if (wantsVirtualBg) {
    rows.push({
      icon: <Sparkles className="w-4 h-4" />,
      label: 'Background',
      text: 'Virtual background is on — stand about an arm’s length back with your head and shoulders in frame, and avoid backlight.',
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="shot-setup-title"
      className="absolute inset-x-0 bottom-0 z-40 max-h-[88%] overflow-y-auto rounded-t-3xl bg-white text-[#202124] shadow-[0_-12px_40px_rgba(0,0,0,0.35)] animate-[sheet-in_260ms_cubic-bezier(0.32,0.72,0,1)]"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-[#DADCE0]" aria-hidden />
      <div className="p-5 pt-3 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#1A73E8]">{heading} · set up</p>
            <h2 id="shot-setup-title" className="text-xl font-extrabold tracking-[-0.01em] leading-tight [text-wrap:balance]">
              {scene.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide setup"
            className="w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-[#5F6368] hover:bg-[#F1F3F4] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {scene.plainInstruction && (
          <p className="text-[15px] leading-relaxed text-[#202124] [text-wrap:pretty]">{scene.plainInstruction}</p>
        )}

        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.label} className="flex gap-3 text-sm">
              <span className="w-8 h-8 rounded-lg bg-[#F1F3F4] text-[#5F6368] flex items-center justify-center shrink-0">
                {r.icon}
              </span>
              <span className="pt-1.5 leading-snug">
                <span className="font-semibold">{r.label}: </span>
                <span className="text-[#3C4043]">{r.text}</span>
              </span>
            </li>
          ))}
        </ul>

        {(scene.directorTip || '').trim() && (
          <p className="flex gap-2 text-sm text-[#3C4043] bg-[#FEF7E0] rounded-xl px-3.5 py-3 leading-relaxed">
            <Lightbulb className="w-4 h-4 text-[#F29900] shrink-0 mt-0.5" />
            {scene.directorTip}
          </p>
        )}

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={onStart}
            disabled={recordBlocked}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-[#EA4335] text-white text-sm font-bold hover:bg-[#D33B2E] active:scale-[0.98] disabled:opacity-60 transition cursor-pointer"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-white" />
            {recordBlocked ? 'Loading virtual background…' : 'I’m set — start recording'}
          </button>
          <button
            type="button"
            onClick={onHide}
            className="w-full py-2.5 text-sm font-semibold text-[#5F6368] hover:text-[#202124] cursor-pointer"
          >
            Hide — I’ll tap record myself
          </button>
        </div>
      </div>
    </div>
  );
};
