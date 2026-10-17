import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Sparkles, Upload } from 'lucide-react';
import type { Project, Scene, SceneRecipe } from '../types/director';
import { resolveSceneBackgroundPrompt, resolveSceneBackgroundUrl } from '../utils/virtualBackground';

interface Props {
  scene: Scene;
  project: Project;
  onChange: (patch: Partial<Scene>) => void;
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

export const VirtualBackgroundPicker: React.FC<Props> = ({ scene, project, onChange }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const url = resolveSceneBackgroundUrl(scene, project);
  const savedPrompt = resolveSceneBackgroundPrompt(scene, project);
  const isUserScene = scene.filmedBy === 'user';
  /** Editable background prompt; follows the saved one when it changes elsewhere (e.g. a revise). */
  const [draft, setDraft] = useState(savedPrompt);
  const [edited, setEdited] = useState(false);
  useEffect(() => setDraft(savedPrompt), [savedPrompt]);
  const prompt = draft.trim();

  const baseRecipe = (): SceneRecipe =>
    scene.recipe || { layout: 'virtual_background', inserts: [], punchIns: [], transitionOut: 'cut' };

  /** Save the prompt text only; the current image stays until you regenerate. */
  const savePrompt = () => {
    if (prompt === savedPrompt) return;
    const base = baseRecipe();
    onChange({
      recipe: {
        ...base,
        layout: base.layout === 'talking_head' ? 'virtual_background' : base.layout,
        background: { ...(base.background || {}), prompt },
      },
    });
    setEdited(Boolean(url));
  };

  const persist = (assetUrl: string, usedPrompt: string) => {
    const base = baseRecipe();
    setEdited(false);
    const patch: Partial<Scene> = {
      recipe: {
        ...base,
        layout: base.layout === 'talking_head' ? 'virtual_background' : base.layout,
        background: { prompt: usedPrompt || base.background?.prompt || '', assetUrl },
      },
    };
    // AI overlay scenes also keep the image where the cutaway pipeline expects it.
    if (!isUserScene) {
      patch.aiGeneratedImageUrl = assetUrl;
      patch.mediaType = 'image';
      patch.aiGenerationStatus = 'ready';
    }
    onChange(patch);
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
          sceneTitle: scene.title,
          aspectRatio: project.aspectRatio || '9:16',
          kind: 'background',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.imageUrl) {
        throw new Error(data.error || 'Background generation failed');
      }
      persist(data.imageUrl, prompt);
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
      persist(await fileToDataUrl(file), prompt);
    } catch (e: any) {
      setError(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-2 border-t border-[#DADCE0] space-y-2">
      <span className="text-xs font-semibold text-[#0F9D58] flex items-center gap-1">
        <ImageIcon className="w-3.5 h-3.5" />
        Background (virtual green screen)
      </span>
      <label className="block space-y-1">
        <span className="sr-only">Background prompt</span>
        <textarea
          value={draft}
          rows={2}
          disabled={busy}
          placeholder="Describe the background, e.g. a warm cricket stadium at night, floodlights, soft bokeh"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={savePrompt}
          className="w-full text-xs leading-relaxed text-[#202124] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2.5 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] disabled:opacity-60"
        />
      </label>
      {edited && url && !busy && (
        <p className="text-xs font-semibold text-[#E37400]">Prompt changed — regenerate to see it.</p>
      )}
      {url ? (
        <img src={url} alt="Virtual background" className="w-full max-h-48 object-cover rounded-xl bg-[#F8F9FA]" />
      ) : (
        <p className="text-xs text-[#5F6368]">
          No background yet — a placeholder gradient is used while shooting.
        </p>
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
  );
};
