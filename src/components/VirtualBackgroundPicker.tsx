import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Sparkles, Upload } from 'lucide-react';
import type { Project } from '../types/director';
import { setVideoBackground, spreadVirtualBackground, videoBackground } from '../utils/virtualBackground';
import { mediaUrlFromGcs } from '../utils/mediaVault';

interface Props {
  project: Project;
  onUpdateProject: (updated: Project | ((prev: Project) => Project)) => void;
}

/** Downscale uploads so the data URL stays small enough to persist with the project. */
async function fileToDataUrl(file: File, maxSide = 1280): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Not a valid image'));
      i.src = raw;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } catch {
    return raw;
  }
}

/**
 * The ONE virtual background for the whole video: describe it, generate it or upload a picture.
 * Every shot the creator films is placed on this same background.
 */
export const VirtualBackgroundPicker: React.FC<Props> = ({ project, onUpdateProject }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const bg = videoBackground(project.scenes);
  const url = bg?.assetUrl;
  const shownUrl = url?.startsWith('gs://') ? mediaUrlFromGcs(url) || undefined : url;
  const savedPrompt = bg?.prompt || '';
  const [draft, setDraft] = useState(savedPrompt);
  const [edited, setEdited] = useState(false);
  useEffect(() => setDraft(savedPrompt), [savedPrompt]);
  const prompt = draft.trim();
  const shotCount = project.scenes.filter(
    (s) => s.filmedBy === 'user' && s.recipe?.layout === 'virtual_background'
  ).length;

  /** Write the background to every shot (switching it on for shots that don't have it yet). */
  const persist = (patch: { prompt?: string; assetUrl?: string }) =>
    onUpdateProject((prev) => {
      const fallbackPrompt = patch.prompt ?? (videoBackground(prev.scenes)?.prompt || prompt);
      const withLayout = { ...prev, scenes: spreadVirtualBackground(prev.scenes, { lookChosen: true, fallbackPrompt }) };
      return setVideoBackground(withLayout, patch);
    });

  const savePrompt = () => {
    if (prompt === savedPrompt) return;
    persist({ prompt });
    setEdited(Boolean(url));
  };

  const generate = async () => {
    if (!prompt) {
      setError('Describe the background first, or upload an image.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/generate-cutaway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Empty background plate with NO people, no text, wide environment shot for a talking-head video: ${prompt}`,
          sceneTitle: project.title,
          aspectRatio: project.aspectRatio || '9:16',
          kind: 'background',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.imageUrl) throw new Error(data.error || 'Background generation failed');
      persist({ prompt, assetUrl: data.imageUrl });
      setEdited(false);
    } catch (e: any) {
      setError(e?.message || 'Background generation failed');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      persist({ prompt: prompt || 'My own background', assetUrl: await fileToDataUrl(file) });
      setEdited(false);
    } catch (e: any) {
      setError(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border border-[#DADCE0] rounded-2xl p-4 space-y-3" aria-label="Virtual background">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-extrabold text-[#202124] flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-[#0F9D58]" />
          Virtual background
        </h2>
        <span className="text-xs text-[#5F6368]">
          One background for the whole video{shotCount ? ` · used in all ${shotCount} shot${shotCount === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
        {shownUrl ? (
          <img src={shownUrl} alt="Virtual background" className="w-full aspect-video object-cover rounded-xl bg-[#F8F9FA]" />
        ) : (
          <div className="w-full aspect-video rounded-xl bg-[#F1F3F4] flex items-center justify-center text-xs text-[#5F6368] text-center px-3">
            No picture yet — generate one or upload your own.
          </div>
        )}
        <div className="space-y-2 min-w-0">
          <label className="block">
            <span className="sr-only">Describe the background</span>
            <textarea
              value={draft}
              rows={3}
              disabled={busy}
              placeholder="Describe the place, e.g. a warm cricket stadium at night, floodlights, soft bokeh"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={savePrompt}
              className="w-full text-xs leading-relaxed text-[#202124] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2.5 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] disabled:opacity-60"
            />
          </label>
          {edited && url && !busy && (
            <p className="text-xs font-semibold text-[#E37400]">Description changed — regenerate to see it.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#9333EA] text-white text-xs font-bold disabled:opacity-50 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {busy ? 'Working…' : url ? 'Regenerate' : 'Generate'}
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#DADCE0] text-[#202124] text-xs font-bold disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
            />
          </div>
          {error && <p className="text-xs text-rose-600 font-semibold">{error}</p>}
        </div>
      </div>
    </section>
  );
};
