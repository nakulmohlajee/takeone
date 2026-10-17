import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  RefreshCw,
  Film,
  Video,
  Play,
  Pause,
  Wand2,
  CheckCircle2,
  AlertTriangle,
  Maximize2,
  X,
  Sliders,
  Layers,
} from 'lucide-react';
import { Project, Scene } from '../types/director';
import {
  generateVeoVideoCutaway,
  VeoQuotaError,
  VeoProgressUpdate,
} from '../utils/veoVideoGenerator';
import { grabVideoFrame } from '../utils/takeFrame';

interface AiGenerationViewProps {
  project: Project;
  onUpdateProject: (proj: Project | ((prev: Project) => Project)) => void;
  onProceedToAssembly: () => void;
  /** Scene to scroll to and highlight (from Director's Cut "Regenerate") */
  focusSceneId?: string | null;
}

export const AiGenerationView: React.FC<AiGenerationViewProps> = ({
  project,
  onUpdateProject,
  onProceedToAssembly,
  focusSceneId,
}) => {
  const aiScenes = project.scenes.filter((s) => s.filmedBy === 'ai');
  const [generatingSceneId, setGeneratingSceneId] = useState<string | null>(null);
  const [progressState, setProgressState] = useState<Record<string, VeoProgressUpdate>>({});
  const [modelChoice, setModelChoice] = useState<Record<string, 'imagen' | 'veo'>>({});
  const [resolutionChoice, setResolutionChoice] = useState<Record<string, '720p' | '1080p'>>({});
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [customPrompts, setCustomPrompts] = useState<Record<string, string>>({});
  const [sceneErrors, setSceneErrors] = useState<
    Record<string, { message: string; requiresPaidKey?: boolean }>
  >({});
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [videoPlaying, setVideoPlaying] = useState<Record<string, boolean>>({});
  const [analysisPhase, setAnalysisPhase] = useState<'idle' | 'analyzing' | 'ready' | 'failed'>(
    'idle'
  );
  const [analysisNote, setAnalysisNote] = useState('');
  const [lookFrame, setLookFrame] = useState<{
    base64: string;
    mimeType: string;
    dataUrl: string;
  } | null>(null);
  const analyzedRef = useRef(false);

  useEffect(() => {
    if (!focusSceneId) return;
    const t = window.setTimeout(() => {
      document
        .getElementById(`ai-scene-${focusSceneId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    return () => window.clearTimeout(t);
  }, [focusSceneId]);

  useEffect(() => {
    if (analyzedRef.current) return;
    analyzedRef.current = true;
    void analyzeTakesForLook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyzeTakesForLook = async () => {
    setAnalysisPhase('analyzing');
    setAnalysisNote('Reading your recorded scenes — lighting, color, and framing…');
    const userTake = project.scenes.find((s) => s.filmedBy === 'user' && s.userRecordedVideoUrl);
    if (!userTake?.userRecordedVideoUrl) {
      setAnalysisPhase('ready');
      setAnalysisNote('No talking-head take yet. Cutaways will use the script prompt only.');
      return;
    }
    try {
      const frame = await grabVideoFrame(userTake.userRecordedVideoUrl);
      if (!frame?.base64) {
        setAnalysisPhase('ready');
        setAnalysisNote('Could not sample a frame from your take. You can still generate cutaways.');
        return;
      }
      setLookFrame(frame);
      const res = await fetch('/api/style-bible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: frame?.base64 || '',
          mimeType: frame?.mimeType || 'image/jpeg',
          projectTitle: project.title,
        }),
      });
      const data = await res.json();
      const bible = data.styleBible || '';
      onUpdateProject((prev) => ({
        ...prev,
        channelSettings: {
          ...(prev.channelSettings || {
            channelName: 'My Channel',
            showWatermark: false,
            watermarkPosition: 'top-right',
            watermarkOpacity: 0.7,
            entryMusicEnabled: false,
            entryMusicStyle: 'signature-chime',
            noiseRemovalEnabled: true,
            captionsEnabled: false,
            captionStyle: 'modern-white',
            currentLanguage: 'en',
          }),
          styleBible: bible || prev.channelSettings?.styleBible,
        },
      }));
      setAnalysisPhase('ready');
      setAnalysisNote(
        bible
          ? `Look locked from your take. Cutaways will merge into that world.\n${bible}`
          : 'Look analysis finished. Generate a still or Veo clip to merge into the master.'
      );
    } catch (err: any) {
      setAnalysisPhase('failed');
      setAnalysisNote(err.message || 'Could not analyze takes. You can still generate cutaways.');
    }
  };

  const handleRegenerateCutaway = async (scene: Scene) => {
    const chosenModel =
      modelChoice[scene.id] || (scene.mediaType === 'video' ? 'veo' : 'imagen');
    const styleBible = project.channelSettings?.styleBible || '';
    const basePrompt =
      customPrompts[scene.id] || scene.aiGenerationPrompt || `Cinematic cutaway of ${scene.title}`;
    const activePrompt = styleBible
      ? `${basePrompt}. Visual continuity: ${styleBible}. Must match the attached reference frame of the real footage so it can dissolve/merge into the talking-head.`
      : basePrompt;
    const chosenRes = resolutionChoice[scene.id] || '720p';

    setGeneratingSceneId(scene.id);
    setSceneErrors((prev) => {
      const next = { ...prev };
      delete next[scene.id];
      return next;
    });

    try {
      if (chosenModel === 'veo') {
        setProgressState((prev) => ({
          ...prev,
          [scene.id]: {
            phase: 'starting',
            message: 'Initializing Google Cloud Veo 3.1 neural video diffusion model...',
            elapsedSeconds: 0,
          },
        }));

        const result = await generateVeoVideoCutaway(
          {
            prompt: activePrompt,
            aspectRatio: project.aspectRatio || '9:16',
            resolution: chosenRes,
            startingImageUrl: scene.referenceImageUrl || scene.aiGeneratedImageUrl,
          },
          (progress) => {
            setProgressState((prev) => ({ ...prev, [scene.id]: progress }));
          }
        );

        const updated = project.scenes.map((s) => {
          if (s.id === scene.id) {
            const asOverlay = s.mediaRole === 'overlay' || scene.mediaRole === 'overlay';
            let parentId = s.overlayParentSceneId;
            if (asOverlay && !parentId) {
              parentId = project.scenes.find((p) => p.filmedBy === 'user')?.id;
            }
            return {
              ...s,
              aiGeneratedVideoUrl: result.videoUrl,
              mediaType: 'video' as const,
              aiGenerationPrompt: activePrompt,
              aiGenerationStatus: 'ready' as const,
              includeInExport: asOverlay ? false : true,
              mediaRole: asOverlay ? ('overlay' as const) : s.mediaRole || 'cutaway',
              overlayParentSceneId: parentId,
              overlayLayout: s.overlayLayout || (asOverlay ? 'pip_br' : undefined),
              aiGenerationMessage: asOverlay
                ? `Generated via Veo — overlays on talking-head (${s.overlayLayout || 'pip_br'})`
                : `Generated via Google Cloud Veo 3.1 (${chosenRes}) — will merge into master`,
            };
          }
          return s;
        });

        onUpdateProject((prev) => {
                          const patched = updated.find((s) => s.id === scene.id);
                          if (!patched) return prev;
                          return {
                            ...prev,
                            scenes: prev.scenes.map((s) => (s.id === scene.id ? patched : s)),
                          };
                        });
      } else {
        setProgressState((prev) => ({
          ...prev,
          [scene.id]: {
            phase: 'starting',
            message: 'Directing Gemini Image to craft a continuity-matched cutaway...',
            elapsedSeconds: 0,
          },
        }));

        let referenceImageBase64 = lookFrame?.base64;
        let referenceMimeType = lookFrame?.mimeType || 'image/jpeg';
        const refUrl = scene.referenceImageUrl || lookFrame?.dataUrl;
        if (refUrl?.startsWith('data:')) {
          const m = refUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (m) {
            referenceMimeType = m[1];
            referenceImageBase64 = m[2];
          }
        }

        const res = await fetch('/api/generate-cutaway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: activePrompt,
            sceneTitle: scene.title,
            aspectRatio: project.aspectRatio || '9:16',
            styleBible,
            referenceImageBase64,
            referenceMimeType,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.imageUrl || data.fallbackUsed) {
          throw new Error(
            data.error ||
              data.message ||
              (data.errors?.length
                ? `Image generation failed: ${data.errors.slice(0, 2).join('; ')}`
                : 'Gemini Image could not generate this cutaway. No stock placeholder was used.')
          );
        }
        const updated = project.scenes.map((s) => {
          if (s.id === scene.id) {
            const asOverlay = s.mediaRole === 'overlay' || scene.mediaRole === 'overlay';
            let parentId = s.overlayParentSceneId;
            if (asOverlay && !parentId) {
              parentId = project.scenes.find((p) => p.filmedBy === 'user')?.id;
            }
            return {
              ...s,
              aiGeneratedImageUrl: data.imageUrl,
              mediaType: 'image' as const,
              aiGenerationPrompt: activePrompt,
              aiGenerationStatus: 'ready' as const,
              includeInExport: asOverlay ? false : true,
              mediaRole: asOverlay ? ('overlay' as const) : s.mediaRole || 'cutaway',
              overlayParentSceneId: parentId,
              overlayLayout: s.overlayLayout || (asOverlay ? 'pip_br' : undefined),
              aiGenerationMessage: asOverlay
                ? `Generated via ${data.source || 'Gemini Image'} — timed overlay on talking-head`
                : `Generated via ${data.source || 'Gemini Image'} — will merge into master`,
            };
          }
          return s;
        });

        onUpdateProject((prev) => {
                          const patched = updated.find((s) => s.id === scene.id);
                          if (!patched) return prev;
                          return {
                            ...prev,
                            scenes: prev.scenes.map((s) => (s.id === scene.id ? patched : s)),
                          };
                        });
      }
    } catch (e: any) {
      console.error('Failed to regenerate cutaway:', e);
      const isQuota =
        e instanceof VeoQuotaError ||
        e.requiresPaidKey ||
        e.message?.includes('paid') ||
        e.message?.includes('quota') ||
        e.message?.includes('429');

      setSceneErrors((prev) => ({
        ...prev,
        [scene.id]: {
          message:
            e.message ||
            'Veo video generation requires a paid Gemini API key with Veo quota enabled in AI Studio.',
          requiresPaidKey: isQuota,
        },
      }));
    } finally {
      setGeneratingSceneId(null);
      setEditingPromptId(null);
      setProgressState((prev) => {
        const next = { ...prev };
        delete next[scene.id];
        return next;
      });
    }
  };

  const toggleVideoPlayback = (sceneId: string, videoEl: HTMLVideoElement | null) => {
    if (!videoEl) return;
    if (videoEl.paused) {
      videoEl.play();
      setVideoPlaying((prev) => ({ ...prev, [sceneId]: true }));
    } else {
      videoEl.pause();
      setVideoPlaying((prev) => ({ ...prev, [sceneId]: false }));
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center space-y-2 mb-8">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#E8F0FE] border border-[#D2E3FC] text-[#1A73E8] text-xs font-semibold shadow-2xs">
          <Sparkles className="w-3.5 h-3.5 text-[#1A73E8]" />
          <span>Google Cloud Veo 3.1 Neural Video & Gemini Image Engine</span>
        </div>
        <h1 className="text-2xl md:text-4xl font-extrabold text-[#202124] font-['Plus_Jakarta_Sans',sans-serif]">
          AI Cutaways
        </h1>
        <p className="text-sm text-[#5F6368] max-w-xl mx-auto">
          We analyze your recorded scenes first, then generate a still or Veo clip that matches that
          look and merges into the talking-head — not a random stock still.
        </p>
        <div className="max-w-xl mx-auto mt-4 p-4 rounded-2xl border border-[#D2E3FC] bg-[#E8F0FE] text-left text-xs text-[#174EA6] space-y-2">
          {analysisPhase === 'analyzing' && (
            <p className="font-semibold animate-pulse">Processing your takes… {analysisNote}</p>
          )}
          {analysisPhase !== 'analyzing' && (
            <p className="whitespace-pre-line leading-relaxed">{analysisNote}</p>
          )}
          {lookFrame && (
            <img
              src={lookFrame.dataUrl}
              alt="Look reference from your take"
              className="w-full h-28 object-cover rounded-xl border border-[#D2E3FC]"
            />
          )}
        </div>
      </div>

      {/* Grid of AI Cutaways */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {aiScenes.map((scene) => {
          const isGenerating = generatingSceneId === scene.id;
          const isVideo = scene.mediaType === 'video' || !!scene.aiGeneratedVideoUrl;
          const activeChoice = modelChoice[scene.id] || (isVideo ? 'veo' : 'imagen');
          const currentProgress = progressState[scene.id];
          const errorInfo = sceneErrors[scene.id];
          const activeRes = resolutionChoice[scene.id] || '720p';

          return (
            <div
              key={scene.id}
              id={`ai-scene-${scene.id}`}
              className={`bg-white border rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between ${
                focusSceneId === scene.id ? 'border-[#1A73E8] ring-2 ring-[#D2E3FC]' : 'border-[#DADCE0]'
              }`}
            >
              {/* Media Preview Frame (Video or Image) */}
              <div className="relative aspect-[4/3] sm:aspect-[16/10] bg-neutral-950 overflow-hidden group">
                {isVideo && scene.aiGeneratedVideoUrl ? (
                  <>
                    <video
                      id={`video-${scene.id}`}
                      src={scene.aiGeneratedVideoUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className={`w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 ${
                        isGenerating ? 'blur-sm grayscale' : ''
                      }`}
                    />
                    {/* Hover controls for video */}
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          const el = document.getElementById(
                            `video-${scene.id}`
                          ) as HTMLVideoElement | null;
                          toggleVideoPlayback(scene.id, el);
                        }}
                        className="p-3 rounded-full bg-black/70 hover:bg-black/90 text-white backdrop-blur-md transition cursor-pointer shadow-lg active:scale-95"
                        title={videoPlaying[scene.id] === false ? 'Play video' : 'Pause video'}
                      >
                        {videoPlaying[scene.id] === false ? (
                          <Play className="w-5 h-5 fill-white" />
                        ) : (
                          <Pause className="w-5 h-5 fill-white" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewVideoUrl(scene.aiGeneratedVideoUrl!)}
                        className="p-3 rounded-full bg-black/70 hover:bg-black/90 text-white backdrop-blur-md transition cursor-pointer shadow-lg active:scale-95"
                        title="Expand to Fullscreen"
                      >
                        <Maximize2 className="w-5 h-5" />
                      </button>
                    </div>
                  </>
                ) : scene.aiGeneratedImageUrl || scene.userInsertUrl ? (
                  <img
                    src={scene.aiGeneratedImageUrl || scene.userInsertUrl}
                    alt={scene.title}
                    className={`w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 ${
                      isGenerating ? 'blur-sm grayscale' : ''
                    }`}
                  />
                ) : scene.insertKind === 'title-card' ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#111827] to-[#05070a] px-6 text-center">
                    <div className="w-16 h-1 rounded-full bg-[#1A73E8] mb-4" />
                    <p className="text-white font-extrabold text-lg md:text-xl leading-tight">
                      {scene.title}
                    </p>
                    <p className="text-[11px] text-neutral-400 mt-2 uppercase tracking-wider font-semibold">
                      Title card · no image needed
                    </p>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 px-6 text-center gap-2">
                    <Sparkles className="w-8 h-8 text-[#9333EA]/70" />
                    <p className="text-white font-bold text-sm leading-snug">{scene.title}</p>
                    <p className="text-[11px] text-neutral-400 uppercase tracking-wider font-semibold">
                      {(scene.insertKind || 'broll').replace('-', ' ')} · not generated yet
                    </p>
                    <p className="text-[10px] text-neutral-500 max-w-[220px] leading-relaxed">
                      Tap Generate still or Veo below — no stock plant placeholder.
                    </p>
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30 pointer-events-none" />

                {/* Top Badge */}
                <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs font-semibold text-white">
                  {isVideo ? (
                    <Video className="w-3 h-3 text-[#38bdf8]" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-[#C084FC]" />
                  )}
                  <span>
                    Scene #{scene.sceneNumber} •{' '}
                    {isVideo ? 'Veo 3.1 Motion' : 'Gemini Image Still'}
                  </span>
                </div>

                {/* Duration */}
                <div className="absolute top-3 right-3 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-md text-[11px] font-mono text-neutral-200 border border-white/10">
                  {scene.durationSeconds || 5}s
                </div>

                {/* Generating Loading State with Live Reassurance */}
                {isGenerating && (
                  <div className="absolute inset-0 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center space-y-3 z-10 animate-in fade-in">
                    <div className="relative">
                      <div className="w-12 h-12 border-3 border-[#1A73E8] border-t-transparent rounded-full animate-spin" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Video className="w-4 h-4 text-[#1A73E8] animate-pulse" />
                      </div>
                    </div>
                    <div className="space-y-1 max-w-xs">
                      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#1A73E8]/20 border border-[#1A73E8]/40 text-[#8AB4F8] text-[10px] font-mono">
                        <span>
                          {activeChoice === 'veo'
                            ? `Google Cloud Veo 3.1 (${activeRes})`
                            : 'Gemini Image'}
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-white leading-snug">
                        {currentProgress?.message || 'Synthesizing cinematic cutaway...'}
                      </p>
                      {currentProgress?.elapsedSeconds !== undefined && (
                        <p className="text-[11px] font-mono text-[#9AA0A6]">
                          Elapsed: {currentProgress.elapsedSeconds}s{' '}
                          {activeChoice === 'veo' ? '(typically 30–60s)' : ''}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Card Details */}
              <div className="p-5 space-y-3 flex-1 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-lg text-[#202124]">
                      {scene.title}
                    </h3>
                    {isVideo && (
                      <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-[#E0F2FE] text-[#0284C7] border border-[#BAE6FD]">
                        Veo 60fps MP4
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#5F6368] font-medium">
                    {scene.plainInstruction}
                  </p>

                  {/* Overlay vs hard cutaway */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const parent = project.scenes.find((p) => p.filmedBy === 'user');
                        const next = project.scenes.map((s) =>
                          s.id === scene.id
                            ? {
                                ...s,
                                mediaRole: 'overlay' as const,
                                includeInExport: false,
                                overlayParentSceneId: s.overlayParentSceneId || parent?.id,
                                overlayLayout: s.overlayLayout || 'pip_br',
                              }
                            : s
                        );
                        onUpdateProject((prev) => {
                          const patched = next.find((s) => s.id === scene.id);
                          if (!patched) return prev;
                          return {
                            ...prev,
                            scenes: prev.scenes.map((s) => (s.id === scene.id ? patched : s)),
                          };
                        });
                      }}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold border cursor-pointer ${
                        scene.mediaRole === 'overlay'
                          ? 'bg-[#E8F0FE] border-[#D2E3FC] text-[#1A73E8]'
                          : 'bg-white border-[#DADCE0] text-[#5F6368]'
                      }`}
                    >
                      <Layers className="w-3 h-3 inline mr-1" />
                      Overlay on take
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const next = project.scenes.map((s) =>
                          s.id === scene.id
                            ? {
                                ...s,
                                mediaRole: 'cutaway' as const,
                                includeInExport: true,
                                overlayParentSceneId: undefined,
                              }
                            : s
                        );
                        onUpdateProject((prev) => {
                          const patched = next.find((s) => s.id === scene.id);
                          if (!patched) return prev;
                          return {
                            ...prev,
                            scenes: prev.scenes.map((s) => (s.id === scene.id ? patched : s)),
                          };
                        });
                      }}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold border cursor-pointer ${
                        scene.mediaRole !== 'overlay'
                          ? 'bg-[#F3E8FD] border-[#E9D5FF] text-[#7C3AED]'
                          : 'bg-white border-[#DADCE0] text-[#5F6368]'
                      }`}
                    >
                      Hard cutaway
                    </button>
                    {scene.mediaRole === 'overlay' && (
                      <select
                        value={scene.overlayLayout || 'pip_br'}
                        onChange={(e) => {
                          const layout = e.target.value as 'full' | 'pip_br' | 'pip_bl';
                          const next = project.scenes.map((s) =>
                            s.id === scene.id ? { ...s, overlayLayout: layout } : s
                          );
                          onUpdateProject((prev) => {
                          const patched = next.find((s) => s.id === scene.id);
                          if (!patched) return prev;
                          return {
                            ...prev,
                            scenes: prev.scenes.map((s) => (s.id === scene.id ? patched : s)),
                          };
                        });
                        }}
                        className="text-[10px] font-semibold border border-[#DADCE0] rounded-lg px-2 py-1 bg-white cursor-pointer"
                      >
                        <option value="pip_br">PiP bottom-right</option>
                        <option value="pip_bl">PiP bottom-left</option>
                        <option value="full">Full-frame overlay</option>
                      </select>
                    )}
                  </div>

                  {/* Quota / Error Alert Banner */}
                  {errorInfo && (
                    <div className="p-3 bg-[#FEF3C7] border border-[#FCD34D] rounded-xl text-[#92400E] text-xs space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-[#D97706] mt-0.5" />
                        <div className="space-y-1">
                          <p className="font-semibold text-[#78350F]">
                            {errorInfo.requiresPaidKey
                              ? 'Veo Flagship Model (Paid Tier Required)'
                              : 'Cutaway Generation Notice'}
                          </p>
                          <p className="text-[11px] text-[#92400E] leading-relaxed">
                            {errorInfo.message}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1 border-t border-[#FCD34D]/60">
                        <button
                          type="button"
                          onClick={() => {
                            setModelChoice((prev) => ({ ...prev, [scene.id]: 'imagen' }));
                            handleRegenerateCutaway({ ...scene, mediaType: 'image' });
                          }}
                          className="px-2.5 py-1 rounded bg-[#B45309] hover:bg-[#92400E] text-white text-[10px] font-bold transition shadow-2xs cursor-pointer"
                        >
                          Generate AI Still Photo Instead
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRegenerateCutaway(scene)}
                          className="px-2.5 py-1 rounded bg-white hover:bg-neutral-50 text-[#78350F] border border-[#FCD34D] text-[10px] font-semibold transition cursor-pointer"
                        >
                          Retry Veo
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Editable AI Prompt */}
                  <div className="bg-[#F8F9FA] p-2.5 rounded-lg border border-[#DADCE0] text-[11px] text-[#5F6368]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[#1A73E8] font-semibold flex items-center gap-1">
                        <Wand2 className="w-3 h-3 text-[#1A73E8]" />
                        Director Prompt:
                      </span>
                      <button
                        onClick={() =>
                          setEditingPromptId(editingPromptId === scene.id ? null : scene.id)
                        }
                        className="text-[10px] text-[#1A73E8] hover:underline font-medium cursor-pointer"
                      >
                        {editingPromptId === scene.id ? 'Cancel' : 'Edit Prompt'}
                      </button>
                    </div>

                    {editingPromptId === scene.id ? (
                      <textarea
                        value={
                          customPrompts[scene.id] !== undefined
                            ? customPrompts[scene.id]
                            : scene.aiGenerationPrompt || ''
                        }
                        onChange={(e) =>
                          setCustomPrompts((prev) => ({
                            ...prev,
                            [scene.id]: e.target.value,
                          }))
                        }
                        rows={2}
                        className="w-full bg-white border border-[#DADCE0] rounded p-1.5 text-xs text-[#202124] focus:outline-none focus:border-[#1A73E8]"
                      />
                    ) : (
                      <p className="font-mono line-clamp-2">
                        {customPrompts[scene.id] || scene.aiGenerationPrompt}
                      </p>
                    )}
                  </div>
                </div>

                {/* Generator Selection and Trigger */}
                <div className="pt-3 border-t border-[#DADCE0] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-[#5F6368]">Engine:</span>
                    <div className="flex items-center bg-[#F1F3F4] p-0.5 rounded-lg border border-[#DADCE0]">
                      <button
                        type="button"
                        onClick={() =>
                          setModelChoice((prev) => ({ ...prev, [scene.id]: 'veo' }))
                        }
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer flex items-center gap-1 ${
                          activeChoice === 'veo'
                            ? 'bg-[#1A73E8] text-white shadow-2xs'
                            : 'text-[#5F6368] hover:text-[#202124]'
                        }`}
                      >
                        <Video className="w-3 h-3" />
                        <span>Veo 3.1</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setModelChoice((prev) => ({ ...prev, [scene.id]: 'imagen' }))
                        }
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer flex items-center gap-1 ${
                          activeChoice === 'imagen'
                            ? 'bg-[#1A73E8] text-white shadow-2xs'
                            : 'text-[#5F6368] hover:text-[#202124]'
                        }`}
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>Gemini Image</span>
                      </button>
                    </div>

                    {/* Resolution Choice for Veo */}
                    {activeChoice === 'veo' && (
                      <select
                        value={activeRes}
                        onChange={(e) =>
                          setResolutionChoice((prev) => ({
                            ...prev,
                            [scene.id]: e.target.value as '720p' | '1080p',
                          }))
                        }
                        className="text-[10px] font-mono bg-white border border-[#DADCE0] rounded px-1.5 py-0.5 text-[#3C4043] focus:outline-none focus:border-[#1A73E8]"
                        title="Veo Video Resolution"
                      >
                        <option value="720p">720p HD</option>
                        <option value="1080p">1080p FHD</option>
                      </select>
                    )}
                  </div>

                  {/* Opt-in: include in master export (off by default — no random stills in cut) */}
                  <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#F8F9FA] border border-[#DADCE0] text-xs cursor-pointer">
                    <span className="font-semibold text-[#202124]">
                      Include in master export
                      <span className="block text-[10px] font-normal text-[#5F6368]">
                        Off by default — only approved cutaways go into the final cut
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={scene.includeInExport === true}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        onUpdateProject((prev) => ({
                          ...prev,
                          scenes: prev.scenes.map((s) =>
                            s.id === scene.id ? { ...s, includeInExport: checked } : s
                          ),
                        }));
                      }}
                    />
                  </label>

                  {/* One-Tap Action */}
                  <button
                    onClick={() => handleRegenerateCutaway(scene)}
                    disabled={isGenerating || analysisPhase === 'analyzing'}
                    className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1A73E8] hover:bg-[#1557B0] text-white transition active:scale-95 disabled:opacity-50 cursor-pointer shadow-2xs"
                    title="Generate this specific cutaway"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`}
                    />
                    <span>
                      {activeChoice === 'veo'
                        ? 'Generate Veo Cutaway'
                        : 'Generate AI Photo'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Assembly Action Banner */}
      <div className="bg-white border border-[#DADCE0] rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm">
        <div className="space-y-1 text-center sm:text-left">
          <h3 className="font-bold text-[#202124] text-base">
            All Shots & Cutaways Directed
          </h3>
          <p className="text-xs text-[#5F6368]">
            Only cutaways you toggle “Include in master export” will appear in the final cut.
            Unapproved AI stills are skipped.
          </p>
        </div>

        <button
          onClick={onProceedToAssembly}
          className="w-full sm:w-auto px-6 py-3.5 rounded-xl font-bold bg-[#1A73E8] hover:bg-[#1557B0] text-white shadow-sm active:scale-95 transition flex items-center justify-center gap-2 text-sm whitespace-nowrap cursor-pointer"
        >
          <Film className="w-4 h-4" />
          <span>Assemble Master Video →</span>
        </button>
      </div>

      {/* Fullscreen Video Modal Preview */}
      {previewVideoUrl && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative max-w-4xl w-full bg-black rounded-2xl overflow-hidden border border-white/20 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-3 bg-neutral-900 border-b border-white/10 text-white">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Video className="w-4 h-4 text-[#38bdf8]" />
                <span>Google Cloud Veo 3.1 Cinematic Master Preview</span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewVideoUrl(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-neutral-300 hover:text-white transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="relative aspect-video max-h-[75vh] flex items-center justify-center bg-black">
              <video
                src={previewVideoUrl}
                controls
                autoPlay
                className="w-full h-full object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
