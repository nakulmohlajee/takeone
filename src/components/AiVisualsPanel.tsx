import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import type { Project, ProductionPrefs } from '../types/director';
import {
  applyAssetResults,
  findMissingAssets,
  generateAssets,
  listAiVisuals,
  updateAiVisual,
  uploadOwnVisual,
  type AiVisual,
  addAiVisual,
  lookForKind,
  visualMoments,
  type NewVisualKind,
} from '../utils/aiVisuals';
import { mediaUrlFromGcs } from '../utils/mediaVault';

interface Props {
  project: Project;
  prefs: ProductionPrefs;
  aspectRatio: string;
  onUpdateProject: (updated: Project | ((prev: Project) => Project)) => void;
  /** True while an export is running. */
  disabled?: boolean;
  /** Switch a look on (a visual you add yourself must not be dropped by the cut). */
  onEnsureLook?: (look: ProductionPrefs['looks'][number]) => void;
}

function previewUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.startsWith('gs://') ? mediaUrlFromGcs(url) || undefined : url;
}

function isVideoUrl(url?: string): boolean {
  return Boolean(url && /\.(mp4|webm|mov)(\?|$)/i.test(url));
}

/** Visual shown in the project's own shape. */
const Thumb: React.FC<{ src: string; video: boolean; className?: string }> = ({ src, video, className }) =>
  video ? (
    <video src={src} muted playsInline loop autoPlay className={className} />
  ) : (
    <img src={src} alt="" className={className} />
  );

/**
 * Every AI visual in the plan (b-roll, overlays, memes, backgrounds, AI scenes) with its prompt:
 * edit the prompt, generate or regenerate it, upload your own image, or switch it off.
 * Anything still missing is generated automatically on export.
 */
export const AiVisualsPanel: React.FC<Props> = ({
  project,
  prefs,
  aspectRatio,
  onUpdateProject,
  disabled,
  onEnsureLook,
}) => {
  const visuals = useMemo(() => listAiVisuals(project, prefs), [project, prefs]);
  const missing = useMemo(() => findMissingAssets(project, prefs), [project, prefs]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Prompt each image was made from, to flag "prompt changed — regenerate". */
  const [madeFrom, setMadeFrom] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadKey = useRef<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const wide = aspectRatio === '16:9';

  const moments = useMemo(() => visualMoments(project), [project]);
  if (!visuals.length && !moments.length) return null;
  const styleBible = project.channelSettings?.styleBible || '';

  const setKeyBusy = (key: string, on: boolean) => setBusy((b) => ({ ...b, [key]: on }));
  const setKeyError = (key: string, msg?: string) =>
    setErrors((e) => {
      const next = { ...e };
      if (msg) next[key] = msg;
      else delete next[key];
      return next;
    });

  const generateOne = async (v: AiVisual) => {
    const prompt = v.prompt.trim();
    if (!prompt) {
      setKeyError(v.key, 'Write a prompt first.');
      return;
    }
    setKeyBusy(v.key, true);
    setKeyError(v.key);
    const { results } = await generateAssets(
      [{ key: v.key, sceneId: v.sceneId, sceneTitle: v.sceneTitle, prompt, kind: v.kind }],
      { aspectRatio, styleBible }
    );
    if (results.size) {
      onUpdateProject((prev) => applyAssetResults(updateAiVisual(prev, v.key, { clearAsset: true }), results));
      setMadeFrom((m) => ({ ...m, [v.key]: prompt }));
    } else {
      setKeyError(v.key, 'Generation failed — try again or upload your own.');
    }
    setKeyBusy(v.key, false);
  };

  const generateMissing = async () => {
    if (!missing.length) return;
    setBulk(`Generating 0/${missing.length}…`);
    const { results, failed } = await generateAssets(missing, { aspectRatio, styleBible }, (done, total) =>
      setBulk(`Generating ${done}/${total}…`)
    );
    if (results.size) onUpdateProject((prev) => applyAssetResults(prev, results));
    setMadeFrom((m) => {
      const next = { ...m };
      for (const item of missing) if (results.has(item.key)) next[item.key] = item.prompt;
      return next;
    });
    setBulk(failed ? `${results.size} ready, ${failed} failed.` : null);
  };

  const onUpload = async (file: File) => {
    const key = uploadKey.current;
    uploadKey.current = null;
    if (!key) return;
    if (!file.type.startsWith('image/')) {
      setKeyError(key, 'Please choose an image file.');
      return;
    }
    setKeyBusy(key, true);
    setKeyError(key);
    try {
      const uri = await uploadOwnVisual(file);
      onUpdateProject((prev) => applyAssetResults(updateAiVisual(prev, key, { clearAsset: true }), new Map([[key, uri]])));
      setMadeFrom((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
    } catch (e: any) {
      setKeyError(key, e?.message || 'Upload failed');
    } finally {
      setKeyBusy(key, false);
    }
  };

  return (
    <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-extrabold text-[#202124] flex items-center gap-2">
          <ImagePlus className="w-4 h-4 text-[#1A73E8]" />
          AI visuals
          <span className="text-xs font-semibold text-[#5F6368]">{visuals.length}</span>
        </h2>
        <p className="text-xs text-[#5F6368] leading-relaxed">
          Edit a prompt, generate it, or upload your own image. Anything left empty is generated when you export.
        </p>
      </div>

      {missing.length > 0 && (
        <button
          type="button"
          onClick={() => void generateMissing()}
          disabled={disabled || Boolean(bulk)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#E8F0FE] text-[#1A73E8] border border-[#D2E3FC] text-xs font-bold hover:bg-[#D2E3FC] disabled:opacity-60 cursor-pointer transition-colors"
        >
          {bulk ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {bulk || `Generate ${missing.length} missing`}
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onUpload(f);
        }}
      />

      <ul className="space-y-2.5">
        {visuals.map((v) => {
          const img = previewUrl(v.assetUrl);
          const isBusy = Boolean(busy[v.key]);
          const stale = Boolean(img && madeFrom[v.key] !== undefined && madeFrom[v.key] !== v.prompt.trim());
          const canToggle = v.kind !== 'background';
          return (
            <li
              key={v.key}
              className={`rounded-xl border p-2.5 space-y-2 transition-opacity ${
                v.enabled && v.inCut ? 'border-[#DADCE0]' : 'border-dashed border-[#DADCE0] opacity-60'
              }`}
            >
              <div className="flex gap-2.5">
                <button
                  type="button"
                  disabled={!img || isBusy}
                  onClick={() => setEnlarged(v.key)}
                  aria-label={img ? `View ${v.label} larger` : `${v.label} not generated yet`}
                  className={`${
                    wide ? 'w-28 aspect-video' : 'w-16 aspect-[9/16]'
                  } shrink-0 self-start rounded-lg bg-[#F1F3F4] overflow-hidden flex items-center justify-center enabled:cursor-zoom-in enabled:hover:ring-2 enabled:hover:ring-[#1A73E8]/40 transition-shadow`}
                >
                  {isBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin text-[#1A73E8]" />
                  ) : img ? (
                    <Thumb src={img} video={isVideoUrl(v.assetUrl)} className="w-full h-full object-cover" />
                  ) : (
                    <ImagePlus className="w-4 h-4 text-[#9AA0A6]" />
                  )}
                </button>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-[#9333EA]">{v.label}</span>
                    {canToggle && (
                      <label className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-[#5F6368] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          disabled={disabled}
                          onChange={(e) =>
                            onUpdateProject((prev) => updateAiVisual(prev, v.key, { enabled: e.target.checked }))
                          }
                          className="w-3.5 h-3.5 accent-[#1A73E8]"
                        />
                        Use in video
                      </label>
                    )}
                  </div>
                  <p className="text-xs text-[#5F6368] truncate">
                    {v.anchor ? <>on “{v.anchor}”</> : v.sceneTitle}
                  </p>
                  {!v.inCut && (
                    <p className="text-xs text-[#E37400]">
                      Off for this cut — turn on the {v.label === 'AI meme' ? 'Memes' : 'B-roll or Overlays'} look to use it.
                    </p>
                  )}
                </div>
              </div>
              <PromptField
                value={v.prompt}
                disabled={disabled || isBusy}
                onCommit={(prompt) => onUpdateProject((prev) => updateAiVisual(prev, v.key, { prompt }))}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void generateOne(v)}
                  disabled={disabled || isBusy || !v.enabled}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[#1A73E8] hover:underline disabled:opacity-50 disabled:no-underline cursor-pointer"
                >
                  {img ? <RefreshCw className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
                  {img ? 'Regenerate' : 'Generate'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    uploadKey.current = v.key;
                    fileRef.current?.click();
                  }}
                  disabled={disabled || isBusy || !v.enabled}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[#5F6368] hover:text-[#202124] disabled:opacity-50 cursor-pointer"
                >
                  <Upload className="w-3 h-3" />
                  Upload
                </button>
                {stale && <span className="text-xs font-semibold text-[#E37400]">Prompt changed — regenerate</span>}
              </div>
              {errors[v.key] && <p className="text-xs text-[#C5221F]">{errors[v.key]}</p>}
            </li>
          );
        })}
      </ul>

      {(() => {
        const v = enlarged ? visuals.find((x) => x.key === enlarged) : undefined;
        const src = previewUrl(v?.assetUrl);
        if (!v || !src) return null;
        return (
          <Lightbox
            src={src}
            video={isVideoUrl(v.assetUrl)}
            wide={wide}
            title={v.label}
            caption={v.prompt}
            busy={Boolean(busy[v.key])}
            onRegenerate={v.enabled && !disabled ? () => void generateOne(v) : undefined}
            onClose={() => setEnlarged(null)}
          />
        );
      })()}

      {moments.length > 0 && (
        <AddVisual
          moments={moments}
          disabled={disabled}
          onAdd={async (v, generate) => {
            onEnsureLook?.(lookForKind(v.kind));
            const { project: next, key } = addAiVisual(project, v);
            onUpdateProject(() => next);
            if (generate && v.kind !== 'text_pop' && v.prompt?.trim()) {
              setKeyBusy(key, true);
              const { results } = await generateAssets(
                [{ key, sceneId: v.sceneId, sceneTitle: '', prompt: v.prompt.trim(), kind: 'insert' }],
                { aspectRatio, styleBible }
              );
              if (results.size) {
                onUpdateProject((prev) => applyAssetResults(prev, results));
                setMadeFrom((m) => ({ ...m, [key]: v.prompt!.trim() }));
              } else {
                setKeyError(key, 'Generation failed — try Regenerate or upload your own.');
              }
              setKeyBusy(key, false);
            }
          }}
        />
      )}
    </div>
  );
};

const KIND_OPTIONS: Array<{ id: NewVisualKind; label: string; hint: string }> = [
  { id: 'broll', label: 'AI B-roll', hint: 'Full screen' },
  { id: 'overlay', label: 'AI overlay', hint: 'Beside you' },
  { id: 'meme', label: 'AI meme', hint: 'Reaction image' },
  { id: 'text_pop', label: 'Text pop', hint: 'Big words' },
];

/** Add one visual yourself: pick the type, the moment it lands on, and describe it. */
const AddVisual: React.FC<{
  moments: Array<{ sceneId: string; sceneTitle: string; sentence: string; anchor: string }>;
  disabled?: boolean;
  onAdd: (
    v: { sceneId: string; anchorPhrase: string; kind: NewVisualKind; prompt?: string; text?: string },
    generate: boolean
  ) => Promise<void>;
}> = ({ moments, disabled, onAdd }) => {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NewVisualKind>('broll');
  const [moment, setMoment] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const m = moments[Math.min(moment, moments.length - 1)];
  const isText = kind === 'text_pop';

  const submit = async (generate: boolean) => {
    if (!m || !text.trim()) return;
    setBusy(true);
    await onAdd(
      {
        sceneId: m.sceneId,
        anchorPhrase: m.anchor,
        kind,
        ...(isText ? { text } : { prompt: text }),
      },
      generate
    );
    setBusy(false);
    setText('');
    setNote(`${KIND_OPTIONS.find((k) => k.id === kind)?.label} added on “${m.anchor}”.`);
  };

  if (!open) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setNote(null);
          }}
          disabled={disabled}
          className="w-full px-4 py-2.5 rounded-xl bg-[#F1F3F4] hover:bg-[#E8EAED] text-sm font-bold text-[#202124] transition-colors cursor-pointer disabled:opacity-50"
        >
          + Add a visual
        </button>
        {note && <p className="text-xs text-[#137333]">{note}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-[#F8F9FA] p-3 space-y-3">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-[#5F6368]">Type</span>
        <div className="grid grid-cols-2 gap-1.5">
          {KIND_OPTIONS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={`text-left px-3 py-2 rounded-lg transition-colors cursor-pointer ${
                kind === k.id ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-white text-[#3C4043] hover:bg-[#F1F3F4]'
              }`}
            >
              <span className="block text-xs font-bold">{k.label}</span>
              <span className="block text-xs opacity-80">{k.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-semibold text-[#5F6368]">When it appears</span>
        <select
          value={moment}
          onChange={(e) => setMoment(Number(e.target.value))}
          className="w-full rounded-lg border border-[#DADCE0] bg-white px-2.5 py-2 text-xs text-[#202124]"
        >
          {moments.map((mo, i) => (
            <option key={`${mo.sceneId}-${i}`} value={i}>
              {mo.sentence.length > 70 ? `${mo.sentence.slice(0, 68)}…` : mo.sentence}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-semibold text-[#5F6368]">{isText ? 'Words on screen' : 'Describe the picture'}</span>
        {isText ? (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={40}
            placeholder="e.g. 36 HOURS WASTED"
            className="w-full rounded-lg border border-[#DADCE0] bg-white px-2.5 py-2 text-sm text-[#202124]"
          />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="e.g. A dense, flat sourdough loaf cut in half on a wooden board, warm kitchen light"
            className="w-full rounded-lg border border-[#DADCE0] bg-white px-2.5 py-2 text-xs leading-relaxed text-[#202124] resize-y"
          />
        )}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {!isText && (
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={busy || disabled || !text.trim()}
            className="px-3.5 py-2 rounded-lg bg-[#1A73E8] text-white text-xs font-bold hover:bg-[#1557B0] active:scale-[0.97] disabled:opacity-50 transition cursor-pointer"
          >
            {busy ? 'Adding…' : 'Add & generate'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={busy || disabled || !text.trim()}
          className={`px-3.5 py-2 rounded-lg text-xs font-bold active:scale-[0.97] disabled:opacity-50 transition cursor-pointer ${
            isText ? 'bg-[#1A73E8] text-white hover:bg-[#1557B0]' : 'bg-white text-[#1A73E8] hover:bg-[#E8F0FE]'
          }`}
        >
          {isText ? 'Add text pop' : 'Add without generating'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-2 text-xs font-semibold text-[#5F6368] hover:text-[#202124] cursor-pointer"
        >
          Close
        </button>
      </div>
      {note && <p className="text-xs text-[#137333]">{note}</p>}
    </div>
  );
};

/** One visual at full size, in the project's shape. Esc or a tap outside closes it. */
const Lightbox: React.FC<{
  src: string;
  video: boolean;
  wide: boolean;
  title: string;
  caption: string;
  busy: boolean;
  onRegenerate?: () => void;
  onClose: () => void;
}> = ({ src, video, wide, title, caption, busy, onRegenerate, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[min(960px,100%)] flex flex-col items-center gap-3">
        <div
          className={`relative rounded-xl overflow-hidden bg-black ${
            wide ? 'w-full aspect-video' : 'h-[min(78vh,720px)] aspect-[9/16] max-w-full'
          }`}
        >
          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-white" />
            </div>
          ) : (
            <Thumb src={src} video={video} className="w-full h-full object-cover" />
          )}
        </div>
        <div className="w-full max-w-[640px] flex items-start gap-3 text-white">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{title}</p>
            {caption && <p className="text-xs text-white/75 leading-relaxed line-clamp-3">{caption}</p>}
          </div>
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={busy}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-white text-[#202124] text-xs font-bold disabled:opacity-60 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Regenerate
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-2 rounded-lg bg-white/15 hover:bg-white/25 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

/** Prompt textarea that saves on blur (not on every keystroke). */
const PromptField: React.FC<{ value: string; disabled?: boolean; onCommit: (v: string) => void }> = ({
  value,
  disabled,
  onCommit,
}) => {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;
  return (
    <textarea
      value={shown}
      disabled={disabled}
      rows={2}
      placeholder="Describe the image…"
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft.trim() !== value.trim()) onCommit(draft.trim());
      }}
      className="w-full text-xs leading-relaxed text-[#202124] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2.5 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] disabled:opacity-60"
    />
  );
};
