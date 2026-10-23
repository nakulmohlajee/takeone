import React, { useEffect, useState } from 'react';
import {
  Camera,
  Sparkles,
  Clock,
  ArrowRight,
  User,
  RefreshCw,
  Music,
  Smile,
  MessageSquare,
  Globe,
  Monitor,
  Smartphone,
  Plus,
  Trash2,
  Wand2,
  Upload,
  Pencil,
  Layers,
  ZoomIn,
  ChevronDown,
  Lightbulb,
} from 'lucide-react';
import { Project, Scene, formatDuration } from '../types/director';
import { TakeTrimEditor } from './TakeTrimEditor';
import { VirtualBackgroundPicker } from './VirtualBackgroundPicker';
import { sceneWantsVirtualBackground } from '../utils/virtualBackground';
import { applyAssetResults, generateAssets, updateAiVisual, type MissingAsset } from '../utils/aiVisuals';
import { ShotTakeAnalysis } from './ShotTakeAnalysis';
import {
  inferVideoMime,
  kickProxyBuild,
  persistTakeBlob,
  uploadBlobToGcs,
  extensionForMime,
} from '../utils/renderClient';
import { analyzeTakeClaims, sceneHasTake, sceneHasDurableMedia } from '../utils/takeAnalysis';
import { saveTakeMedia, mediaUrlFromGcs, playableTakeUrl, saveProjectLocally } from '../utils/mediaVault';

interface ScriptOverviewViewProps {
  project: Project;
  onUpdateProject: (updated: Project | ((prev: Project) => Project)) => void;
  onStartShooting: () => void;
  onGoToAiGeneration: () => void;
}

const LANGUAGES = [
  { code: 'en', name: 'English (Original)' },
  { code: 'es', name: 'Spanish (Español)' },
  { code: 'fr', name: 'French (Français)' },
  { code: 'de', name: 'German (Deutsch)' },
  { code: 'ja', name: 'Japanese (日本語)' },
  { code: 'hi', name: 'Hindi (हिन्दी)' },
  { code: 'pt', name: 'Portuguese (Português)' },
];

/** A take's analysis is worth showing up front only when something was flagged. */
function takeNeedsAttention(scene: Scene): boolean {
  const flagged = (scene.factCheckClaims || []).some(
    (c) => c.kind === 'factual_claim' || c.verdict === 'disputed'
  );
  const live = scene.liveFactCheck?.status;
  return flagged || live === 'alert' || live === 'warning';
}

export const ScriptOverviewView: React.FC<ScriptOverviewViewProps> = ({
  project,
  onUpdateProject,
  onStartShooting,
  onGoToAiGeneration,
}) => {
  const [selectedLang, setSelectedLang] = useState(
    () => project.spokenLanguage || project.channelSettings?.currentLanguage || 'en'
  );
  const [isTranslating, setIsTranslating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revisePrompt, setRevisePrompt] = useState<Record<string, string>>({});
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const [reviseNote, setReviseNote] = useState<
    Record<string, { tone: 'ok' | 'warn' | 'error'; text: string } | null>
  >({});
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [masterPrompt, setMasterPrompt] = useState('');
  const [masterPromptBusy, setMasterPromptBusy] = useState(false);
  const [masterPromptSummary, setMasterPromptSummary] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [masterOpen, setMasterOpen] = useState(false);
  /** Per-card "More" drawer (revise, uploads, transcript, routine analysis). */
  const [moreOpen, setMoreOpen] = useState<Record<string, boolean>>({});

  const userScenes = project.scenes.filter((s) => s.filmedBy === 'user');
  const aiScenes = project.scenes.filter((s) => s.filmedBy === 'ai');

  const editPlanItems = (scene: Scene) => {
    const recipe = scene.recipe;
    const items: Array<{ key: string; kind: string; trigger?: string; detail?: string; index?: number }> = [];
    if (!recipe) return items;
    if (recipe.layout === 'virtual_background') {
      items.push({
        key: `${scene.id}-bg`,
        kind: 'Virtual BG',
        detail: recipe.background?.prompt,
      });
    }
    (recipe.inserts || []).forEach((ins, i) => {
      const kind =
        ins.kind === 'text_pop'
          ? 'Text pop'
          : ins.kind === 'meme'
            ? 'AI meme'
            : ins.layout === 'pip'
              ? 'AI overlay'
              : 'AI B-roll';
      items.push({
        key: `${scene.id}-ins-${i}`,
        kind,
        trigger: ins.anchorPhrase,
        detail: ins.text || ins.prompt,
        index: i,
      });
    });
    (recipe.punchIns || []).forEach((p, i) => {
      items.push({
        key: `${scene.id}-punch-${i}`,
        kind: 'Punch-in',
        trigger: p.anchorPhrase,
        detail: `${Number(p.zoom || 1.1).toFixed(2)}×`,
      });
    });
    return items;
  };

  const regenerateWithSelections = async () => {
    if (regenBusy) return;
    setRegenBusy(true);
    setRegenError(null);
    try {
      const secs = project.estimatedTotalSeconds || 45;
      const duration = secs >= 90 ? `${Math.round(secs / 60)} minutes` : `${secs} seconds`;
      const res = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: project.logline || project.title,
          duration,
          style: project.creativeBrief?.tone || 'Warm & authentic vlog',
          format: project.videoFormat || 'short-form',
          aspectRatio: project.aspectRatio || '9:16',
          prefs: project.prefs,
        }),
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data?.scenes) || !data.scenes.length) {
        throw new Error(data?.error || 'Regenerate failed');
      }
      const scenes = data.scenes.map((s: any, idx: number) => ({
        ...s,
        id: `scene-${idx + 1}-${Date.now()}`,
        sceneNumber: idx + 1,
      }));
      onUpdateProject((prev) => ({
        ...prev,
        title: data.title || prev.title,
        logline: data.logline || prev.logline,
        scenes,
        prefs: data.prefs || prev.prefs,
        prefsUnmet: Array.isArray(data.prefsUnmet) ? data.prefsUnmet.map(String) : undefined,
        narrativeBeats: data.narrativeBeats,
        captureUnits: data.captureUnits || data.capturePlan,
        capturePlan: data.capturePlan || data.captureUnits,
        captureStrategy: data.captureStrategy || prev.captureStrategy,
        creativeBrief: data.creativeBrief || prev.creativeBrief,
      }));
    } catch (e: any) {
      setRegenError(e?.message || 'Regenerate failed');
    } finally {
      setRegenBusy(false);
    }
  };

  useEffect(() => {
    const onTrimExtracted = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        sceneId?: string;
        gcsObjectPath?: string;
        durationSeconds?: number;
      };
      if (!detail?.sceneId || !detail.gcsObjectPath) return;
      updateScene(detail.sceneId, {
        gcsObjectPath: detail.gcsObjectPath,
        inPoint: 0,
        outPoint: detail.durationSeconds,
        recordedDuration: detail.durationSeconds,
        userTrimLocked: true,
        userRecordedVideoUrl: mediaUrlFromGcs(detail.gcsObjectPath) || undefined,
      });
    };
    window.addEventListener('takeone:trim-extracted', onTrimExtracted);
    return () => window.removeEventListener('takeone:trim-extracted', onTrimExtracted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const updateScene = (sceneId: string, patch: Partial<Scene>) => {
    onUpdateProject((prev) => {
      const p = prev || project;
      const updated = p.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s));
      const nextProj = { ...p, scenes: updated };
      void saveProjectLocally(nextProj, 'script-overview');
      return nextProj;
    });
  };

  const handleLanguageChange = async (targetLang: string) => {
    setSelectedLang(targetLang);
    if (targetLang === 'en') return;

    setIsTranslating(true);
    try {
      const res = await fetch('/api/translate-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetLanguage: targetLang, project }),
      });
      const data = await res.json();
      if (data.translation && data.translation.scenes) {
        const translatedMap = new Map<string, any>();
        data.translation.scenes.forEach((ts: any) => {
          translatedMap.set(ts.id, ts);
        });

        const updatedScenes = project.scenes.map((s) => {
          const match = translatedMap.get(s.id);
          if (match) {
            return {
              ...s,
              title: match.title || s.title,
              plainInstruction: match.plainInstruction || s.plainInstruction,
              directorTip: match.directorTip || s.directorTip,
              teleprompterPrompt: match.teleprompterPrompt || s.teleprompterPrompt,
            };
          }
          return s;
        });

        onUpdateProject((prev) => {
          const p = prev || project;
          const byId = new Map(updatedScenes.map((s: Scene) => [s.id, s]));
          return {
            ...p,
            title: data.translation.translatedTitle || p.title,
            logline: data.translation.translatedLogline || p.logline,
            scenes: p.scenes.map((s) => byId.get(s.id) || s),
          };
        });
      }
    } catch (err) {
      console.error('Translation error:', err);
    } finally {
      setIsTranslating(false);
    }
  };

  const toggleSceneType = (sceneId: string) => {
    onUpdateProject((prev) => {
      const p = prev || project;
      const updated = p.scenes.map((s) => {
        if (s.id === sceneId) {
          const newType = s.filmedBy === 'user' ? 'ai' : 'user';
          return {
            ...s,
            filmedBy: newType as 'user' | 'ai',
            includeInExport: newType === 'ai' ? false : s.includeInExport,
            aiGenerationPrompt:
              newType === 'ai'
                ? s.aiGenerationPrompt ||
                  `Cinematic photorealistic 4k shot of ${s.title}, beautiful lighting.`
                : undefined,
            aiGenerationStatus: newType === 'ai' ? ('ready' as const) : ('idle' as const),
          };
        }
        return s;
      });
      return { ...p, scenes: updated };
    });
  };

  const addScene = (filmedBy: 'user' | 'ai' = 'user') => {
    const sceneId = `scene-${Date.now()}`;
    const scene: Scene = {
      id: sceneId,
      sceneNumber: 0,
      title: filmedBy === 'user' ? `New chapter` : `Insert`,
      chapterTitle: `Chapter`,
      filmedBy,
      durationSeconds: filmedBy === 'user' ? 20 : 2,
      insertKind: filmedBy === 'ai' ? 'title-card' : undefined,
      plainInstruction:
        filmedBy === 'user'
          ? 'Hold your phone at eye level. Speak naturally to the camera.'
          : 'This is an insert between talking-head takes (title card, meme, or B-roll).',
      directorTip: 'Keep it natural — authenticity beats perfection.',
      teleprompterPrompt:
        filmedBy === 'user' ? 'Write what you want to say here…' : undefined,
      aiGenerationPrompt:
        filmedBy === 'ai' ? `On-screen title matching: ${project.title}` : undefined,
      aiGenerationStatus: filmedBy === 'ai' ? 'ready' : 'idle',
      includeInExport: filmedBy === 'ai' ? true : undefined,
      captureStatus: filmedBy === 'user' ? 'shoot' : undefined,
    };
    onUpdateProject((prev) => {
      const p = prev || project;
      const n = p.scenes.length + 1;
      const nextScene: Scene = {
        ...scene,
        sceneNumber: n,
        title: filmedBy === 'user' ? `New chapter ${n}` : `Insert ${n}`,
        chapterTitle: `Chapter ${n}`,
      };
      return {
        ...p,
        scenes: [...p.scenes, nextScene],
        estimatedTotalSeconds: (p.estimatedTotalSeconds || 0) + nextScene.durationSeconds,
      };
    });
    setEditingId(sceneId);
  };

  const deleteScene = (sceneId: string) => {
    onUpdateProject((prev) => {
      const p = prev || project;
      if (p.scenes.length <= 1) return p;
      const updated = p.scenes
        .filter((s) => s.id !== sceneId)
        .map((s, i) => ({ ...s, sceneNumber: i + 1 }));
      return { ...p, scenes: updated };
    });
    if (editingId === sceneId) setEditingId(null);
  };

  const reviseWithGemini = async (scene: Scene) => {
    const instruction = (revisePrompt[scene.id] || '').trim();
    if (!instruction || revisingId) return;
    setRevisingId(scene.id);
    setReviseNote((prev) => ({ ...prev, [scene.id]: null }));
    try {
      const res = await fetch('/api/revise-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene,
          instruction,
          projectTitle: project.title,
          projectLogline: project.logline,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.scene) {
        const raw = String(data.error || '');
        // Raw API errors (JSON blobs) mean Gemini couldn't be reached, not that the request was wrong.
        throw new Error(raw && !raw.trim().startsWith('{') ? raw : 'Gemini couldn’t be reached — try again in a moment.');
      }
      const patch = { ...data.scene } as Partial<Scene>;
      // Overlay stills sit on a parent take — not hard-cut export scenes
      if (patch.mediaRole === 'overlay') {
        patch.includeInExport = false;
        if (!patch.overlayParentSceneId) {
          const parent = project.scenes.find(
            (s) => s.filmedBy === 'user' && s.id !== scene.id
          );
          if (parent) patch.overlayParentSceneId = parent.id;
        }
        if (!patch.overlayLayout) patch.overlayLayout = 'pip_br';
      }

      // Background and AI visuals live on the recipe; a new prompt drops the old picture.
      const rc = data.recipeChanges || {};
      const toGenerate: MissingAsset[] = [];
      const base = scene.recipe || { layout: 'talking_head' as const, inserts: [], punchIns: [], transitionOut: 'cut' as const };
      let recipe = base;
      if (rc.virtualBackground === false && recipe.layout === 'virtual_background') {
        recipe = { ...recipe, layout: 'talking_head' };
      }
      if (rc.virtualBackground === true || rc.backgroundPrompt) {
        const bgPrompt = rc.backgroundPrompt || recipe.background?.prompt || '';
        const changed = bgPrompt.trim() !== (base.background?.prompt || '').trim();
        recipe = {
          ...recipe,
          layout: 'virtual_background',
          background: changed ? { prompt: bgPrompt } : recipe.background || { prompt: bgPrompt },
        };
        if (bgPrompt && (changed || !recipe.background?.assetUrl)) {
          toGenerate.push({ key: `${scene.id}:bg`, sceneId: scene.id, sceneTitle: scene.title, prompt: bgPrompt, kind: 'background' });
        }
      }
      for (const v of (rc.visuals || []) as Array<{ index: number; prompt?: string; text?: string }>) {
        const ins = recipe.inserts[v.index];
        if (!ins) continue;
        const promptChanged = v.prompt && v.prompt !== (ins.prompt || '').trim() && ins.kind !== 'text_pop';
        const updatedIns = {
          ...ins,
          ...(ins.kind === 'text_pop' && v.text ? { text: v.text } : {}),
          ...(promptChanged ? { prompt: v.prompt, assetUrl: undefined } : {}),
        };
        recipe = { ...recipe, inserts: recipe.inserts.map((x, i) => (i === v.index ? updatedIns : x)) };
        if (promptChanged) {
          toGenerate.push({ key: `${scene.id}:ins:${v.index}`, sceneId: scene.id, sceneTitle: scene.title, prompt: v.prompt!, kind: 'insert' });
        }
      }
      if (recipe !== base) patch.recipe = recipe;

      const changedKeys = Object.keys(patch).filter(
        (k) => JSON.stringify((patch as any)[k]) !== JSON.stringify((scene as any)[k])
      );
      if (!changedKeys.length) {
        setReviseNote((prev) => ({
          ...prev,
          [scene.id]: { tone: 'warn', text: 'Gemini didn’t change anything — try saying exactly what should be different.' },
        }));
        return;
      }
      updateScene(scene.id, patch);
      setRevisePrompt((prev) => ({ ...prev, [scene.id]: '' }));
      const summary = String(data.summary || '').trim() || 'Scene updated.';
      setReviseNote((prev) => ({
        ...prev,
        [scene.id]: { tone: 'ok', text: toGenerate.length ? `${summary} Making the new picture…` : summary },
      }));

      if (toGenerate.length) {
        const { results, failed } = await generateAssets(toGenerate, {
          aspectRatio: project.aspectRatio || '9:16',
          styleBible: project.channelSettings?.styleBible || '',
        });
        if (results.size) onUpdateProject((prev) => applyAssetResults(prev, results));
        setReviseNote((prev) => ({
          ...prev,
          [scene.id]: failed
            ? { tone: 'warn', text: `${summary} The new picture didn’t generate — tap Generate to try again.` }
            : { tone: 'ok', text: summary },
        }));
      }
    } catch (err: any) {
      setReviseNote((prev) => ({
        ...prev,
        [scene.id]: { tone: 'error', text: err?.message || 'Could not revise this scene — try again.' },
      }));
    } finally {
      setRevisingId(null);
    }
  };

  const applyMasterPrompt = async () => {
    const instruction = masterPrompt.trim();
    if (!instruction || masterPromptBusy) return;
    setMasterPromptBusy(true);
    setMasterPromptSummary(null);
    try {
      const res = await fetch('/api/direction/master-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, instruction }),
      });
      const data = await res.json();
      if (!res.ok || !data.scenes) throw new Error(data.error || 'Master prompt failed');
      onUpdateProject((prev) => {
        const p = prev || project;
        return {
          ...p,
          scenes: data.scenes,
          narrativeBeats: data.narrativeBeats ?? p.narrativeBeats,
          captureStrategy: data.captureStrategy ?? p.captureStrategy,
          creativeBrief: p.creativeBrief
            ? {
                ...p.creativeBrief,
                captureStrategy: data.captureStrategy || p.creativeBrief.captureStrategy,
              }
            : p.creativeBrief,
        };
      });
      setMasterPromptSummary(data.summary || 'Plan updated');
      setMasterPrompt('');
    } catch (err: any) {
      alert(err.message || 'Could not apply master prompt');
    } finally {
      setMasterPromptBusy(false);
    }
  };

  useEffect(() => {
    const pending = userScenes.find(
      (s) => sceneHasTake(s) && s.factCheckClaims == null && (s.transcript || s.gcsObjectPath)
    );
    if (!pending || analyzingId) return;
    let cancelled = false;
    setAnalyzingId(pending.id);
    void analyzeTakeClaims({
      projectTitle: project.title,
      gcsUri: pending.gcsObjectPath,
      mimeType: pending.mimeType,
      transcript: pending.transcript,
      segments: pending.transcriptSegments,
      words: pending.words,
    })
      .then((analysis) => {
        if (cancelled) return;
        updateScene(pending.id, {
          transcript: analysis.transcript || pending.transcript,
          transcriptSegments: analysis.segments.length
            ? analysis.segments
            : pending.transcriptSegments,
          words: analysis.words?.length ? analysis.words : pending.words,
          factCheckClaims: analysis.claims,
        });
      })
      .finally(() => {
        setAnalyzingId((id) => (id === pending.id ? null : id));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userScenes.map((s) => s.id + (s.gcsObjectPath || '') + (s.transcript || '')).join('|'), analyzingId]);

  const uploadFootageToScene = async (sceneId: string, file: File) => {
    const mime = inferVideoMime(file, file.name);
    // 1. Immediately store binary in IndexedDB media vault
    const liveUrl = await saveTakeMedia(project.id, sceneId, file, mime);

    const duration = await new Promise<number>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        resolve(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 10);
      };
      v.onerror = () => resolve(10);
      v.src = liveUrl;
    });

    updateScene(sceneId, {
      filmedBy: 'user',
      userRecordedVideoUrl: liveUrl,
      mimeType: mime,
      recordedDuration: duration,
      durationSeconds: Math.round(duration),
      includeInExport: true,
      mediaSource: 'imported',
      inPoint: 0,
      outPoint: Math.round(duration),
      userTrimLocked: false,
    });

    try {
      // 2. Persist to GCS
      const persisted = await persistTakeBlob(file, project.id, sceneId, mime);
      updateScene(sceneId, {
        filmedBy: 'user',
        userRecordedVideoUrl: liveUrl,
        mimeType: persisted.mimeType,
        recordedDuration: duration,
        durationSeconds: Math.round(duration),
        gcsObjectPath: persisted.gcsUri,
        includeInExport: true,
        mediaSource: 'imported',
      });
      kickProxyBuild({
        gcsObjectPath: persisted.gcsUri,
        projectId: project.id,
        sceneId,
        durationSec: duration,
        onReady: (proxyUrl) => updateScene(sceneId, { proxyUrl }),
      });
      setAnalyzingId(sceneId);
      try {
        const analysis = await analyzeTakeClaims({
          projectTitle: project.title,
          gcsUri: persisted.gcsUri,
          mimeType: persisted.mimeType,
          blob: file,
        });
        updateScene(sceneId, {
          transcript: analysis.transcript || undefined,
          transcriptSegments: analysis.segments.length ? analysis.segments : undefined,
          words: analysis.words?.length ? analysis.words : undefined,
          factCheckClaims: analysis.claims,
        });
      } finally {
        setAnalyzingId(null);
      }
    } catch (err: any) {
      console.warn('Script overview take upload failed:', err);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 sm:py-8 overflow-x-hidden">
      <header className="mb-8 space-y-5">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-[#5F6368]">
              <span className="font-semibold text-[#1A73E8]">Shooting script</span>
              <span className="inline-flex items-center gap-1">
                {project.videoFormat === 'long-form' ? (
                  <Monitor className="w-3.5 h-3.5" />
                ) : (
                  <Smartphone className="w-3.5 h-3.5" />
                )}
                {project.videoFormat === 'long-form' ? 'Long form' : 'Short form'} ·{' '}
                {project.aspectRatio || (project.videoFormat === 'long-form' ? '16:9' : '9:16')}
              </span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock className="w-3.5 h-3.5" />~{formatDuration(project.estimatedTotalSeconds || 45)}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-[#202124] tracking-[-0.02em] leading-[1.1] font-['Plus_Jakarta_Sans',sans-serif] break-words [text-wrap:balance]">
              {project.title}
            </h1>
            <p className="text-[#5F6368] text-base leading-relaxed max-w-[60ch] break-words [text-wrap:pretty]">
              {project.logline}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="flex items-center gap-2 bg-white border border-[#DADCE0] rounded-xl px-3 py-2 hover:border-[#BDC1C6] transition-colors">
              <Globe className="w-4 h-4 text-[#5F6368] shrink-0" />
              <span className="sr-only">Spoken language</span>
              <select
                value={selectedLang}
                onChange={(e) => handleLanguageChange(e.target.value)}
                disabled={isTranslating}
                className="bg-transparent text-sm text-[#202124] focus:outline-none cursor-pointer"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-white text-[#202124]">
                    {l.name}
                  </option>
                ))}
              </select>
              {isTranslating && (
                <div className="w-3.5 h-3.5 border-2 border-[#1A73E8] border-t-transparent rounded-full animate-spin" />
              )}
            </label>
            {/* Phones: the bottom tab bar has no room for a second fixed bar, so the CTA lives here. */}
            <button
              onClick={onStartShooting}
              className="md:hidden flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl font-bold bg-[#1A73E8] text-white hover:bg-[#1557B0] active:scale-[0.97] transition text-sm cursor-pointer"
            >
              <Camera className="w-4 h-4 shrink-0" />
              Start shooting
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[#3C4043] border-y border-[#E8EAED] py-3">
          <span className="inline-flex items-center gap-1.5">
            <User className="w-4 h-4 text-[#1A73E8]" />
            <span className="font-semibold tabular-nums">
              {(project.captureStrategy || project.creativeBrief?.captureStrategy) === 'single_take'
                ? '1 take'
                : `${userScenes.filter((s) => !s.optionalInsert).length} shots`}
            </span>
            <span className="text-[#5F6368]">you film</span>
          </span>
          {aiScenes.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[#9333EA]" />
              <span className="font-semibold tabular-nums">{aiScenes.length}</span>
              <span className="text-[#5F6368]">AI {aiScenes.length === 1 ? 'scene' : 'scenes'}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Music className="w-4 h-4 text-[#5F6368]" />
            <span className="font-semibold">{project.musicMood || 'Warm Acoustic'}</span>
          </span>
          {(project.captureStrategy || project.creativeBrief?.captureStrategy) && (
            <span className="text-[#5F6368] basis-full md:basis-auto md:ml-auto">
              {(project.captureStrategy || project.creativeBrief?.captureStrategy) === 'single_take'
                ? 'One continuous recording — the beats play in order inside it.'
                : 'Each card is one camera setup to film.'}
            </span>
          )}
        </div>

        <div className="rounded-xl border border-[#E8EAED] bg-white">
          <button
            type="button"
            onClick={() => setMasterOpen((o) => !o)}
            aria-expanded={masterOpen}
            className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-[#202124] hover:bg-[#F8F9FA] rounded-xl transition-colors cursor-pointer"
          >
            <Wand2 className="w-4 h-4 text-[#1A73E8]" />
            Change the whole plan with a prompt
            <ChevronDown
              className={`w-4 h-4 ml-auto text-[#5F6368] transition-transform duration-200 ${masterOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {masterOpen && (
            <div className="px-4 pb-4 space-y-2">
              <p className="text-xs text-[#5F6368]">
                e.g. “Add a CTA scene”, “Make scene 2 a continuous take”, “Use AI food overlays instead of cutaways”.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={masterPrompt}
                  onChange={(e) => setMasterPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void applyMasterPrompt();
                  }}
                  placeholder="Tell Gemini how to change the shoot plan…"
                  className="flex-1 px-3 py-2.5 rounded-xl border border-[#DADCE0] bg-white text-sm text-[#202124] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25 focus:border-[#1A73E8]"
                />
                <button
                  type="button"
                  disabled={masterPromptBusy || !masterPrompt.trim()}
                  onClick={() => void applyMasterPrompt()}
                  className="px-4 py-2.5 rounded-xl bg-[#1A73E8] text-white text-sm font-bold hover:bg-[#1557B0] active:scale-[0.97] disabled:opacity-50 transition cursor-pointer shrink-0"
                >
                  {masterPromptBusy ? 'Updating…' : 'Apply to plan'}
                </button>
              </div>
            </div>
          )}
          {masterPromptSummary && (
            <div className="mx-4 mb-4 text-xs font-semibold text-[#137333] bg-[#E6F4EA] px-3 py-2 rounded-lg">
              {masterPromptSummary}
            </div>
          )}
        </div>
      </header>

      {!!project.narrativeBeats?.length && (
        <div className="mb-8 space-y-3">
          <p className="text-sm font-semibold text-[#202124]">
            Story beats ({project.narrativeBeats.length}) — the story, not the shot list
            {project.creativeBrief?.contentType === 'ugc_ad' && (
              <span className="ml-1">
                <span className="font-normal text-[#5F6368]">· filmed as one continuous take</span>
              </span>
            )}
          </p>
          <ol className="grid sm:grid-cols-2 gap-2">
            {project.narrativeBeats.map((beat, i) => (
              <li
                key={beat.id}
                className="text-sm bg-[#F8F9FA] rounded-xl px-3.5 py-2.5"
              >
                <span className="font-bold text-[#1A73E8] mr-1 tabular-nums">{i + 1}.</span>
                <span className="font-semibold text-[#202124]">{beat.title}</span>
                {beat.dialogue ? (
                  <p className="mt-1 text-[#5F6368] text-xs leading-relaxed line-clamp-2">“{beat.dialogue}”</p>
                ) : (
                  <p className="mt-1 text-[#80868B] text-xs italic">Visual beat</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {!!project.prefsUnmet?.length && (
        <div className="mb-6 p-4 rounded-xl border border-[#F9AB00] bg-[#FEF7E0] space-y-2">
          <p className="text-xs font-bold text-[#5C3800]">
            Some of your Idea-page selections didn’t land in this plan
          </p>
          <ul className="text-xs text-[#7F4E00] list-disc pl-4 space-y-0.5">
            {project.prefsUnmet.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={regenBusy}
            onClick={() => void regenerateWithSelections()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1A73E8] text-white text-xs font-bold hover:bg-[#1557B0] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${regenBusy ? 'animate-spin' : ''}`} />
            {regenBusy ? 'Regenerating…' : 'Regenerate with my selections'}
          </button>
          {regenError ? <p className="text-xs text-[#C5221F]">{regenError}</p> : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => addScene('user')}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1A73E8] text-white text-xs font-bold hover:bg-[#1557B0] transition cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> Add chapter
        </button>
        <button
          type="button"
          onClick={() => addScene('ai')}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-[#DADCE0] text-[#9333EA] text-xs font-bold hover:bg-[#F8F9FA] transition cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" /> Add AI cutaway
        </button>
      </div>

      <div className="space-y-4 mb-8 pb-8 md:pb-8">
        {project.scenes.map((scene, idx) => {
          const isUser = scene.filmedBy === 'user';
          const isEditing = editingId === scene.id;

          return (
            <div
              key={scene.id}
              className={`rounded-2xl border p-4 sm:p-6 transition-colors bg-white overflow-hidden min-w-0 border-l-4 ${
                isUser
                  ? 'border-[#E8EAED] border-l-[#1A73E8] hover:border-[#D2E3FC]'
                  : 'border-[#E8EAED] border-l-[#9333EA] hover:border-[#E9D5FF]'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4 min-w-0">
                <div className="space-y-1 flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      value={scene.chapterTitle || ''}
                      onChange={(e) => updateScene(scene.id, { chapterTitle: e.target.value })}
                      placeholder="Chapter title"
                      className="w-full text-xs font-semibold text-[#1A73E8] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2 py-1 mb-1"
                    />
                  ) : (
                    scene.chapterTitle && (
                      <div className="text-xs font-semibold text-[#1A73E8]">{scene.chapterTitle}</div>
                    )
                  )}
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-bold text-[#80868B] tabular-nums shrink-0">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    {isEditing ? (
                      <input
                        value={scene.title}
                        onChange={(e) => updateScene(scene.id, { title: e.target.value })}
                        className="flex-1 font-bold text-base text-[#202124] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2 py-1"
                      />
                    ) : (
                      <h3 className="font-bold text-base md:text-lg text-[#202124] min-w-0 break-words">
                        {scene.title}
                        {scene.optionalInsert && (
                          <span className="ml-2 text-xs font-semibold text-[#9333EA]">· optional</span>
                        )}
                      </h3>
                    )}
                    {isEditing ? (
                      <input
                        type="number"
                        min={1}
                        max={600}
                        value={scene.durationSeconds || 5}
                        onChange={(e) =>
                          updateScene(scene.id, {
                            durationSeconds: Math.max(1, Number(e.target.value) || 5),
                          })
                        }
                        className="w-16 text-xs bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2 py-1"
                      />
                    ) : (
                      <span className="text-sm text-[#80868B] tabular-nums">
                        {formatDuration(scene.durationSeconds || 5)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold ${
                      isUser ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-[#F3E8FD] text-[#9333EA]'
                    }`}
                  >
                    {isUser ? <Camera className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
                    <span>
                      {isUser
                        ? 'You film'
                        : scene.overlayLayout === 'greenscreen'
                          ? 'Virtual background'
                          : scene.mediaRole === 'overlay'
                            ? 'AI overlay'
                            : 'AI cutaway'}
                    </span>
                  </span>
                  <button
                    onClick={() => toggleSceneType(scene.id)}
                    className="p-1.5 rounded-lg text-[#5F6368] hover:text-[#202124] hover:bg-[#F1F3F4] transition cursor-pointer"
                    title="Switch between You film and AI cutaway"
                    aria-label="Switch between You film and AI cutaway"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  {isUser && (
                    <button
                      type="button"
                      onClick={() => {
                        // Film this shot now, in any order; the shoot opens on it.
                        onUpdateProject((prev) => ({ ...prev, shootFromSceneId: scene.id }));
                        onStartShooting();
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#1A73E8] text-white hover:bg-[#1557B0] transition cursor-pointer"
                      title={scene.gcsObjectPath || scene.userRecordedVideoUrl ? 'Retake this shot' : 'Film this shot now'}
                    >
                      <Camera className="w-3 h-3" />
                      {scene.gcsObjectPath || scene.userRecordedVideoUrl ? 'Retake' : 'Shoot this'}
                    </button>
                  )}
                  <button
                    onClick={() => setEditingId(isEditing ? null : scene.id)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                      isEditing
                        ? 'bg-[#E6F4EA] text-[#137333] border border-[#CEEAD6]'
                        : 'bg-[#F1F3F4] text-[#3C4043] hover:bg-[#E8F0FE]'
                    }`}
                  >
                    <Pencil className="w-3 h-3" />
                    {isEditing ? 'Done' : 'Edit'}
                  </button>
                  <button
                    onClick={() => deleteScene(scene.id)}
                    className="p-1.5 rounded-lg text-[#5F6368] hover:text-[#C5221F] hover:bg-[#FCE8E6] transition cursor-pointer"
                    title="Delete scene"
                    aria-label="Delete scene"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <span className="text-xs font-semibold text-[#5F6368]">
                    {isUser
                      ? 'Camera guidance'
                      : scene.overlayLayout === 'greenscreen'
                        ? 'Background plate'
                        : scene.mediaRole === 'overlay'
                          ? 'AI overlay visual'
                          : 'AI cutaway visual'}
                  </span>
                  {isEditing ? (
                    <textarea
                      value={scene.plainInstruction}
                      onChange={(e) => updateScene(scene.id, { plainInstruction: e.target.value })}
                      rows={2}
                      className="w-full text-sm text-[#202124] bg-white border border-[#DADCE0] rounded-lg px-3 py-2 resize-y"
                    />
                  ) : (
                    <p className="text-base text-[#202124] leading-relaxed max-w-[70ch] [text-wrap:pretty]">
                      {scene.plainInstruction}
                    </p>
                  )}
                </div>

                {isUser && (scene.teleprompterPrompt || '').trim() ? (
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-[#5F6368] flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5 text-[#1A73E8]" />
                      Lines to speak
                    </span>
                    {isEditing ? (
                      <textarea
                        value={scene.teleprompterPrompt || ''}
                        onChange={(e) =>
                          updateScene(scene.id, { teleprompterPrompt: e.target.value })
                        }
                        rows={3}
                        placeholder="What to say on camera…"
                        className="w-full text-sm text-[#202124] bg-white border border-[#DADCE0] rounded-lg px-3 py-2 resize-y"
                      />
                    ) : (
                      <blockquote className="border-l-2 border-[#1A73E8]/40 pl-3.5 text-[15px] leading-relaxed text-[#202124] whitespace-pre-line max-w-[70ch]">
                        {scene.teleprompterPrompt}
                      </blockquote>
                    )}
                  </div>
                ) : null}

                {isUser && editPlanItems(scene).length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-[#5F6368] flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-[#1A73E8]" />
                      Edit plan
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {editPlanItems(scene).map((item) => (
                        <span
                          key={item.key}
                          title={[item.trigger ? `When you say “${item.trigger}”` : '', item.detail || '']
                            .filter(Boolean)
                            .join(' — ')}
                          className="inline-flex max-w-full items-center gap-1 px-2 py-1 rounded-lg bg-[#F8F9FA] text-xs font-medium text-[#3C4043]"
                        >
                          {item.kind === 'Punch-in' ? (
                            <ZoomIn className="w-3 h-3 text-[#1A73E8] shrink-0" />
                          ) : (
                            <Sparkles className="w-3 h-3 text-[#9333EA] shrink-0" />
                          )}
                          <span className="font-semibold text-[#202124]">{item.kind}</span>
                          {item.trigger ? (
                            <span className="font-medium text-[#5F6368] truncate">
                              “{item.trigger}”
                            </span>
                          ) : item.detail ? (
                            <span className="font-medium text-[#5F6368] truncate">{item.detail}</span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                    {editPlanItems(scene).some((i) => i.kind.startsWith('AI') || i.kind === 'Text pop') && (
                      <ul className="space-y-1 pt-1">
                        {editPlanItems(scene)
                          .filter((i) => i.kind.startsWith('AI') || (i.kind === 'Text pop' && i.detail))
                          .map((item) =>
                            item.kind === 'Text pop' ? (
                              <li key={`${item.key}-detail`} className="text-xs leading-relaxed text-[#3C4043]">
                                <span className="font-semibold text-[#9333EA]">{item.kind}</span>
                                {item.trigger ? (
                                  <span className="text-[#5F6368]"> on “{item.trigger}”</span>
                                ) : null}
                                <span className="text-[#5F6368]"> shows </span>
                                <span className="font-bold">{item.detail}</span>
                              </li>
                            ) : (
                              <li key={`${item.key}-detail`} className="text-xs leading-relaxed text-[#3C4043] space-y-1">
                                <div>
                                  <span className="font-semibold text-[#9333EA]">{item.kind}</span>
                                  {item.trigger ? (
                                    <span className="text-[#5F6368]"> on “{item.trigger}”</span>
                                  ) : null}
                                </div>
                                <PlanPromptField
                                  value={item.detail || ''}
                                  onCommit={(prompt) =>
                                    // A new prompt drops the old picture so it is made again from the new one.
                                    onUpdateProject((prev) =>
                                      updateAiVisual(prev, `${scene.id}:ins:${item.index}`, { prompt, clearAsset: true })
                                    )
                                  }
                                />
                              </li>
                            )
                          )}
                      </ul>
                    )}
                  </div>
                )}

                {isUser && !(scene.teleprompterPrompt || '').trim() && (
                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-[#5F6368]">Visual take — no dialogue</span>
                    {scene.onScreenText ? (
                      <p className="text-xs text-[#3C4043]">
                        On-screen text: <span className="font-bold">{scene.onScreenText}</span>
                      </p>
                    ) : null}
                    {scene.purpose ? (
                      <p className="text-xs text-[#5F6368]">{scene.purpose}</p>
                    ) : (
                      <p className="text-xs text-[#5F6368]">
                        Follow camera guidance above. Teleprompter stays off for this shot.
                      </p>
                    )}
                    {isEditing && (
                      <textarea
                        value={scene.teleprompterPrompt || ''}
                        onChange={(e) =>
                          updateScene(scene.id, { teleprompterPrompt: e.target.value || undefined })
                        }
                        rows={2}
                        placeholder="Optional: add spoken lines…"
                        className="w-full text-sm text-[#202124] bg-white border border-[#DADCE0] rounded-lg px-3 py-2 resize-y"
                      />
                    )}
                  </div>
                )}

                {isUser && (scene.userRecordedVideoUrl || scene.gcsObjectPath) && (
                  <div className="space-y-2 min-w-0">
                    <span className="text-xs font-semibold text-[#137333]">Your take — trim it here</span>
                    <TakeTrimEditor
                      videoUrl={playableTakeUrl(scene) || ''}
                      inPoint={scene.inPoint}
                      outPoint={scene.outPoint}
                      keepRanges={scene.keepRanges}
                      userTrimLocked={scene.userTrimLocked}
                      gcsObjectPath={scene.gcsObjectPath}
                      projectId={project.id}
                      sceneId={scene.id}
                      onSaveTrim={(inPoint, outPoint, opts) => {
                        const keepRanges =
                          opts?.keepRanges?.length
                            ? opts.keepRanges
                            : [{ start: inPoint, end: outPoint }];
                        if (opts?.cleanupExtract) {
                          // gcs path updated via takeone:trim-extracted event
                          updateScene(scene.id, {
                            inPoint: 0,
                            outPoint,
                            userTrimLocked: true,
                            keepRanges: [{ start: 0, end: outPoint }],
                          });
                          return;
                        }
                        updateScene(scene.id, {
                          inPoint,
                          outPoint,
                          userTrimLocked: true,
                          keepRanges,
                        });
                      }}
                      onResetTrim={() =>
                        updateScene(scene.id, {
                          inPoint: undefined,
                          outPoint: undefined,
                          keepRanges: undefined,
                          userTrimLocked: false,
                        })
                      }
                    />
                    {scene.userTrimLocked &&
                      typeof scene.inPoint === 'number' &&
                      typeof scene.outPoint === 'number' && (
                        <p className="text-xs text-[#137333] font-semibold tabular-nums">
                          Your keep:{' '}
                          {scene.keepRanges && scene.keepRanges.length > 1
                            ? scene.keepRanges
                                .map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`)
                                .join(', ')
                            : `${scene.inPoint.toFixed(1)}s – ${scene.outPoint.toFixed(1)}s`}
                        </p>
                      )}
                    {!scene.userTrimLocked &&
                      typeof scene.inPoint === 'number' &&
                      typeof scene.outPoint === 'number' && (
                        <p className="text-xs text-[#1A73E8] font-semibold tabular-nums">
                          Director keep: {scene.inPoint.toFixed(1)}s – {scene.outPoint.toFixed(1)}s
                          {scene.editRole ? ` · ${scene.editRole}` : ''}
                        </p>
                      )}
                  </div>
                )}
                {isUser && !(scene.userRecordedVideoUrl || scene.gcsObjectPath) && sceneHasTake(scene) && (
                  <p className="text-xs text-[#5F6368]">Take saved to this scene. Re-open Shoot to review the camera file.</p>
                )}
                {/* Claims worth a look stay visible; routine "nothing flagged" analysis lives in More. */}
                {isUser && takeNeedsAttention(scene) && (
                  <ShotTakeAnalysis scene={scene} analyzing={analyzingId === scene.id} />
                )}

                {!isUser && (scene.userInsertUrl || scene.aiGeneratedImageUrl) && (
                  <div className="space-y-2">
                    {scene.userInsertUrl?.match(/\.(mp4|webm|mov)/i) ? (
                      <video
                        src={scene.userInsertUrl}
                        controls
                        playsInline
                        className="w-full max-h-64 rounded-xl bg-black"
                      />
                    ) : (
                      <img
                        src={scene.userInsertUrl || scene.aiGeneratedImageUrl}
                        alt={scene.title}
                        className="max-h-64 max-w-full rounded-xl object-contain bg-[#F8F9FA]"
                      />
                    )}
                  </div>
                )}

                {!isUser && (
                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-[#5F6368] flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#9333EA]" />
                      Image prompt
                    </span>
                    {isEditing ? (
                      <textarea
                        value={scene.aiGenerationPrompt || ''}
                        onChange={(e) =>
                          updateScene(scene.id, { aiGenerationPrompt: e.target.value })
                        }
                        rows={3}
                        className="w-full text-sm text-[#202124] bg-white border border-[#DADCE0] rounded-lg px-3 py-2 resize-y"
                      />
                    ) : (
                      <p className="text-sm text-[#3C4043] leading-relaxed max-w-[70ch]">
                        {scene.aiGenerationPrompt}
                      </p>
                    )}
                  </div>
                )}

                {sceneWantsVirtualBackground(scene, project) && (
                  <VirtualBackgroundPicker
                    scene={scene}
                    project={project}
                    onChange={(patch) => updateScene(scene.id, patch)}
                  />
                )}

                {(isEditing || (scene.directorTip || '').trim()) && (
                  <div className="flex items-start gap-2 text-sm text-[#3C4043]">
                    <Lightbulb className="w-4 h-4 text-[#F29900] shrink-0 mt-0.5" />
                    {isEditing ? (
                      <input
                        value={scene.directorTip || ''}
                        onChange={(e) => updateScene(scene.id, { directorTip: e.target.value })}
                        placeholder="Director's tip"
                        className="flex-1 text-sm text-[#3C4043] bg-white border border-[#DADCE0] rounded-lg px-3 py-2"
                      />
                    ) : (
                      <p className="leading-relaxed">{scene.directorTip}</p>
                    )}
                  </div>
                )}

                <div className="border-t border-[#F1F3F4] pt-3">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((m) => ({ ...m, [scene.id]: !m[scene.id] }))}
                    aria-expanded={Boolean(moreOpen[scene.id])}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#5F6368] hover:text-[#202124] transition-colors cursor-pointer"
                  >
                    More
                    {isUser && scene.transcript ? ' · transcript' : ''} · revise · upload
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform duration-200 ${moreOpen[scene.id] ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>

                {moreOpen[scene.id] && (
                  <div className="space-y-4 rounded-xl bg-[#F8F9FA] p-4">
                    {isUser && scene.transcript && (
                      <div className="space-y-1">
                        <span className="text-xs font-semibold text-[#5F6368]">What you said</span>
                        <p className="text-sm text-[#3C4043] leading-relaxed break-words">{scene.transcript}</p>
                      </div>
                    )}
                    {isUser && !takeNeedsAttention(scene) && (
                      <ShotTakeAnalysis scene={scene} analyzing={analyzingId === scene.id} />
                    )}

                    <div className="space-y-2">
                      <span className="text-xs font-semibold text-[#5F6368] flex items-center gap-1.5">
                        <Wand2 className="w-3.5 h-3.5 text-[#1A73E8]" />
                        Ask Gemini to revise this scene
                      </span>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          value={revisePrompt[scene.id] || ''}
                          onChange={(e) =>
                            setRevisePrompt((prev) => ({ ...prev, [scene.id]: e.target.value }))
                          }
                          onKeyDown={(e) => e.key === 'Enter' && void reviseWithGemini(scene)}
                          placeholder='e.g. "Make the lines warmer" or "Put me on a beach at sunset"'
                          className="flex-1 text-sm bg-white border border-[#DADCE0] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25 focus:border-[#1A73E8]"
                        />
                        <button
                          type="button"
                          disabled={revisingId === scene.id || !(revisePrompt[scene.id] || '').trim()}
                          onClick={() => reviseWithGemini(scene)}
                          className="px-3.5 py-2 rounded-lg bg-[#1A73E8] text-white text-sm font-bold hover:bg-[#1557B0] active:scale-[0.97] disabled:opacity-50 transition cursor-pointer whitespace-nowrap"
                        >
                          {revisingId === scene.id ? 'Revising…' : 'Revise'}
                        </button>
                      </div>
                      {reviseNote[scene.id] && (
                        <p
                          role="status"
                          className={`text-xs font-semibold ${
                            reviseNote[scene.id]!.tone === 'ok'
                              ? 'text-[#137333]'
                              : reviseNote[scene.id]!.tone === 'warn'
                                ? 'text-[#E37400]'
                                : 'text-[#C5221F]'
                          }`}
                        >
                          {reviseNote[scene.id]!.text}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      {!isUser && (
                        <label className="block space-y-1">
                          <span className="text-xs font-semibold text-[#5F6368]">Insert type</span>
                          <select
                            value={scene.insertKind || 'broll'}
                            onChange={(e) =>
                              updateScene(scene.id, {
                                insertKind: e.target.value as Scene['insertKind'],
                                includeInExport: true,
                              })
                            }
                            className="w-full text-sm bg-white border border-[#DADCE0] rounded-lg px-2.5 py-2"
                          >
                            <option value="title-card">Title card (on-screen label)</option>
                            <option value="broll">B-roll cutaway</option>
                            <option value="meme">Meme / reaction image</option>
                            <option value="reference">Reference clip or screenshot</option>
                          </select>
                        </label>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-[#DADCE0] text-[#3C4043] text-xs font-semibold cursor-pointer hover:bg-[#F1F3F4] transition">
                          <Upload className="w-3.5 h-3.5 text-[#1A73E8]" />
                          {isUser
                            ? scene.userRecordedVideoUrl
                              ? 'Replace footage'
                              : 'Upload footage'
                            : scene.userInsertUrl
                              ? 'Replace image or clip'
                              : 'Upload your own image or clip'}
                          <input
                            type="file"
                            accept={isUser ? 'video/*' : 'video/*,image/*'}
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              if (isUser) {
                                uploadFootageToScene(scene.id, f);
                              } else {
                                void (async () => {
                                  const liveUrl = await saveTakeMedia(project.id, `${scene.id}_insert`, f, f.type);
                                  updateScene(scene.id, {
                                    userInsertUrl: liveUrl,
                                    includeInExport: true,
                                    insertKind:
                                      scene.insertKind ||
                                      (f.type.startsWith('image/') ? 'meme' : 'reference'),
                                  });
                                  try {
                                    const mime = f.type || 'image/jpeg';
                                    const ext = extensionForMime(mime);
                                    const { gcsUri } = await uploadBlobToGcs(f, 'cutaways', ext, mime);
                                    updateScene(scene.id, {
                                      userInsertUrl: liveUrl,
                                      gcsObjectPath: gcsUri,
                                    });
                                  } catch (err) {
                                    console.warn('Insert cloud upload failed:', err);
                                  }
                                })();
                              }
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {sceneHasDurableMedia(scene) && (
                          <span className="text-xs text-[#137333] font-medium">
                            {isUser ? 'Footage attached' : 'Insert attached'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Phones: one inline CTA after the last card (the tab bar already owns the bottom edge). */}
      <div className="md:hidden flex flex-col gap-2 pb-6">
        <button
          onClick={onStartShooting}
          className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl font-bold bg-[#1A73E8] hover:bg-[#1557B0] text-white active:scale-[0.98] transition text-sm cursor-pointer"
        >
          <Camera className="w-4 h-4" />
          Start shooting
        </button>
        {project.scenes.some((s) => s.filmedBy === 'ai') && (
          <button
            type="button"
            onClick={onGoToAiGeneration}
            className="w-full py-2 text-sm font-semibold text-[#1A73E8] cursor-pointer"
          >
            Generate AI visuals first
          </button>
        )}
      </div>

      <div className="hidden md:flex sticky bottom-4 z-40 bg-white/95 border border-[#E8EAED] rounded-2xl p-3 pl-5 backdrop-blur-md shadow-[0_8px_30px_rgba(32,33,36,0.10)] items-center justify-between gap-4">
        <p className="text-sm text-[#5F6368] min-w-0">
          Happy with the plan? TakeOne directs you live while you film.
        </p>
        <div className="flex items-center gap-4 shrink-0">
          {project.scenes.some((s) => s.filmedBy === 'ai') && (
            <button
              type="button"
              onClick={onGoToAiGeneration}
              className="text-sm font-semibold text-[#1A73E8] hover:underline cursor-pointer"
            >
              Generate AI visuals
            </button>
          )}
          <button
            onClick={onStartShooting}
            className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold bg-[#1A73E8] hover:bg-[#1557B0] text-white active:scale-[0.97] transition text-sm cursor-pointer"
          >
            <Camera className="w-4 h-4" />
            Start shooting
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

/** Image prompt for one planned visual; saves on blur. */
const PlanPromptField: React.FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      value={draft}
      rows={2}
      aria-label="Image prompt"
      placeholder="Describe the picture…"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft.trim() !== value.trim() && onCommit(draft.trim())}
      className="w-full text-xs leading-relaxed text-[#202124] bg-[#F8F9FA] border border-[#DADCE0] rounded-lg px-2.5 py-1.5 resize-y focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]"
    />
  );
};
