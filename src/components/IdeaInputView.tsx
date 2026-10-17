import React, { useEffect, useRef, useState } from 'react';
import { HomeShowcase } from './HomeShowcase';
import { Sparkles, Video, Clock, Wand2, Compass, CheckCircle2, Film, Smartphone, Monitor, Youtube, Loader2, Upload } from 'lucide-react';
import {
  Project,
  VideoFormat,
  AspectRatio,
  ChannelSettings,
  ProductionPrefs,
  defaultProductionPrefs,
} from '../types/director';

interface IdeaInputViewProps {
  onScriptGenerated: (project: Project) => void;
  onImportFootage?: () => void;
  isLoading: boolean;
  setIsLoading: (val: boolean) => void;
  loadingMessage: string;
  setLoadingMessage: (msg: string) => void;
}

const SHORT_FORM_IDEAS = [
  {
    label: '3 study tips (45s)',
    idea: 'A 45-second vertical explainer: three study tips that actually work — hook with a bold claim, deliver each tip clearly to camera, end with a simple CTA to follow for more.',
    duration: '45 seconds',
    format: 'short-form' as VideoFormat,
    aspectRatio: '9:16' as AspectRatio,
    style: 'Educational & clear',
  },
  {
    label: 'Weather from Mars (60s)',
    idea: 'A 60-second comedy weather report as if I am broadcasting from Mars — virtual green-screen background of a Martian landscape, punchy delivery, one meme-style text pop.',
    duration: '60 seconds',
    format: 'short-form' as VideoFormat,
    aspectRatio: '9:16' as AspectRatio,
    style: 'Energetic & inspiring',
  },
  {
    label: 'Sourdough fail (60s)',
    idea: 'A 60-second vlog about why my sourdough failed: talking head plus b-roll of the flat loaf, flour mess, and starter jar — honest, funny, and useful.',
    duration: '60 seconds',
    format: 'short-form' as VideoFormat,
    aspectRatio: '9:16' as AspectRatio,
    style: 'Warm & authentic vlog',
  },
  {
    label: 'Headphones review (45s)',
    idea: 'A 45-second product review of wireless headphones: bold hook, three quick pros, one con, meme-style reaction text pops, and a clear CTA.',
    duration: '45 seconds',
    format: 'short-form' as VideoFormat,
    aspectRatio: '9:16' as AspectRatio,
    style: 'Energetic & inspiring',
  },
];

const LONG_FORM_IDEAS = [
  {
    label: '🎙️ Home Botanicals Masterclass (10 mins)',
    idea: 'A 10-minute long-form deep dive into living with plants, micro-climates, soil balance, and how creating an indoor sanctuary reduces creative burnout.',
    duration: '10 minutes',
    format: 'long-form' as VideoFormat,
    aspectRatio: '16:9' as AspectRatio,
    style: 'Educational & clear',
  },
  {
    label: '☕ The Specialty Coffee Journey (15 mins)',
    idea: 'A 15-minute documentary-style video exploring bean origins, grind consistency, water temperature science, and developing a sensory coffee palate.',
    duration: '15 minutes',
    format: 'long-form' as VideoFormat,
    aspectRatio: '16:9' as AspectRatio,
    style: 'Mindful & sensory',
  },
  {
    label: '💻 Creator Studio Walkthrough (5 mins)',
    idea: 'A 5-minute practical breakdown of setting up a minimalist video creation desk, lighting fundamentals, and audio acoustics on a modest budget.',
    duration: '5 minutes',
    format: 'long-form' as VideoFormat,
    aspectRatio: '16:9' as AspectRatio,
    style: 'Warm & authentic vlog',
  },
  {
    label: '🎬 The 60-Minute Creative Feature (60 mins)',
    idea: 'A 60-minute in-depth video essay and master documentary on finding creative purpose, building daily compounding habits, and overcoming creative roadblocks.',
    duration: '60 minutes',
    format: 'long-form' as VideoFormat,
    aspectRatio: '16:9' as AspectRatio,
    style: 'Educational & clear',
  },
];

const SHOT_OPTIONS: Array<{ id: ProductionPrefs['shots']; label: string; hint: string }> = [
  { id: 'one_take', label: 'One take', hint: 'Film once, we edit it' },
  { id: 'few', label: 'A few shots', hint: '2–3 setups' },
  { id: 'cinematic', label: 'Cinematic', hint: 'Up to 6 setups' },
];

const LOOK_OPTIONS: Array<{ id: ProductionPrefs['looks'][number]; label: string }> = [
  { id: 'talking_head', label: 'Talking head' },
  { id: 'virtual_background', label: 'Virtual background' },
  { id: 'broll', label: 'B-roll' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'memes', label: 'Memes' },
  { id: 'text_pops', label: 'Text pops' },
];

const CAPTION_OPTIONS: Array<{ id: ProductionPrefs['captions']; label: string }> = [
  { id: 'bold_pop', label: 'Bold pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'clean', label: 'Clean' },
  { id: 'off', label: 'Off' },
];

function prefsWantMedia(prefs: ProductionPrefs): boolean {
  return prefs.looks.some(
    (l) => l === 'overlays' || l === 'virtual_background' || l === 'broll' || l === 'memes'
  );
}

const PrefsPanel: React.FC<{
  prefs: ProductionPrefs;
  onChange: (next: ProductionPrefs) => void;
  disabled?: boolean;
}> = ({ prefs, onChange, disabled }) => {
  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-full border text-xs font-semibold transition disabled:opacity-60 ${
      active
        ? 'bg-[#E8F0FE] border-[#1A73E8] text-[#1A73E8]'
        : 'bg-white border-[#DADCE0] text-[#5F6368] hover:border-[#1A73E8]'
    }`;
  const toggleLook = (look: ProductionPrefs['looks'][number]) => {
    const has = prefs.looks.includes(look);
    const looks = has ? prefs.looks.filter((l) => l !== look) : [...prefs.looks, look];
    onChange({ ...prefs, looks: looks.length ? looks : ['talking_head'] });
  };
  return (
    <div className="rounded-xl border border-[#DADCE0] bg-[#F8F9FA] p-4 space-y-4" data-testid="prefs-panel">
      <div className="text-xs font-bold text-[#5F6368]">
        How should we make it?
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-[#3C4043]">Shots</div>
        <div className="flex flex-wrap gap-1.5">
          {SHOT_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              title={o.hint}
              onClick={() => onChange({ ...prefs, shots: o.id })}
              className={chip(prefs.shots === o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-[#3C4043]">Looks (pick any)</div>
        <div className="flex flex-wrap gap-1.5">
          {LOOK_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => toggleLook(o.id)}
              className={chip(prefs.looks.includes(o.id))}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-[#3C4043]">Captions</div>
        <div className="flex flex-wrap gap-1.5">
          {CAPTION_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...prefs, captions: o.id })}
              className={chip(prefs.captions === o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#3C4043]">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={prefs.cleanup.silences}
            onChange={(e) =>
              onChange({ ...prefs, cleanup: { ...prefs.cleanup, silences: e.target.checked } })
            }
          />
          Cut silences
        </label>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={prefs.cleanup.fillers}
            onChange={(e) =>
              onChange({ ...prefs, cleanup: { ...prefs.cleanup, fillers: e.target.checked } })
            }
          />
          Remove fillers (um, uh)
        </label>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={prefs.music}
            onChange={(e) => onChange({ ...prefs, music: e.target.checked })}
          />
          Background music
        </label>
      </div>
    </div>
  );
};


/** /api/generate-script answers as NDJSON progress lines + a final result line (or plain JSON). */
async function readScriptResponse(
  response: Response,
  onProgress: (stage: string, message: string) => void
): Promise<{ ok: boolean; data: any }> {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('ndjson') || !response.body) {
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: { ok: boolean; data: any } | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'progress') onProgress(String(msg.stage || ''), String(msg.message || ''));
      else if (msg.type === 'result') result = { ok: Number(msg.status) < 400, data: msg.body || {} };
    } catch {
      /* partial line */
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(handle);
  }
  handle(buffer);
  return result || { ok: false, data: { error: 'Script generation ended without a result. Please try again.' } };
}

const SCRIPT_STAGES: Array<{ id: string; label: string }> = [
  { id: 'script', label: 'Writing the script' },
  { id: 'structure', label: 'Planning shots & edits' },
  { id: 'repair', label: 'Checking your selections' },
];

export const IdeaInputView: React.FC<IdeaInputViewProps> = ({
  onScriptGenerated,
  onImportFootage,
  isLoading,
  setIsLoading,
  loadingMessage,
  setLoadingMessage,
}) => {
  const [videoFormat, setVideoFormat] = useState<VideoFormat>('short-form');
  const ideaRef = useRef<HTMLTextAreaElement | null>(null);
  const [idea, setIdea] = useState(
    'A 45-second vertical video with three study tips that actually work — hook hard, deliver each tip clearly, end with a follow CTA.'
  );
  const [duration, setDuration] = useState('45 seconds');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [style, setStyle] = useState('Warm & authentic vlog');
  const [error, setError] = useState<string | null>(null);
  const [hasExistingChannel, setHasExistingChannel] = useState(false);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelHandle, setChannelHandle] = useState('');
  const [channelNotes, setChannelNotes] = useState('');
  const [analyzingChannel, setAnalyzingChannel] = useState(false);
  const [channelKit, setChannelKit] = useState<Record<string, any> | null>(null);
  const [channelAnalysisMsg, setChannelAnalysisMsg] = useState<string | null>(null);
  const [clarifyQuestions, setClarifyQuestions] = useState<
    Array<{ id: string; prompt: string; choices?: string[] }>
  >([]);
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({});
  const [clarifyRound, setClarifyRound] = useState(0);
  const [briefHints, setBriefHints] = useState<Record<string, unknown> | null>(null);
  const [prefs, setPrefs] = useState<ProductionPrefs>(() => defaultProductionPrefs('short-form'));
  const [scriptStage, setScriptStage] = useState<string | null>(null);
  const [loadingSeconds, setLoadingSeconds] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setScriptStage(null);
      setLoadingSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setLoadingSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isLoading]);

  const analyzeExistingChannel = async () => {
    setAnalyzingChannel(true);
    setChannelAnalysisMsg(null);
    try {
      const res = await fetch('/api/analyze-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelUrl,
          channelHandle,
          notes: channelNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      setChannelKit(data);
      setChannelAnalysisMsg(
        `${data.channelAnalysisNotes || `Matched style for ${data.channelName || 'your channel'}.`} (${
          data.metaSource === 'youtube-data-api'
            ? 'YouTube Data API'
            : data.metaSource === 'youtube-public-html'
              ? 'public YouTube page'
              : data.metaSource === 'youtube-oembed'
                ? 'YouTube oEmbed'
                : 'Gemini + your notes'
        })`
      );
      if (data.styleBible && style === 'Warm & authentic vlog') {
        setStyle('Warm & authentic vlog');
      }
    } catch (err: any) {
      setChannelAnalysisMsg(err.message || 'Could not analyze channel');
    } finally {
      setAnalyzingChannel(false);
    }
  };

  const handleFormatChange = (newFormat: VideoFormat) => {
    setVideoFormat(newFormat);
    // Keep the shot default in step with format unless the creator picked something else.
    setPrefs((p) => ({
      ...p,
      shots:
        newFormat === 'long-form'
          ? p.shots === 'one_take'
            ? 'few'
            : p.shots
          : p.shots === 'few'
            ? 'one_take'
            : p.shots,
    }));
    if (newFormat === 'long-form') {
      setDuration('5 minutes');
      setAspectRatio('16:9');
      if (idea.includes('45-second') || idea.includes('60-second')) {
        setIdea('A 5-minute deep-dive video about how indoor plants transform mental clarity and daily focus.');
      }
    } else {
      setDuration('45 seconds');
      setAspectRatio('9:16');
      if (idea.includes('5-minute') || idea.includes('10-minute') || idea.includes('60-minute')) {
        setIdea('a 45-second video about my love of plants and why watering them is my morning calm');
      }
    }
  };

  const generateScript = async (hints?: Record<string, unknown> | null) => {
    setLoadingMessage(
      videoFormat === 'long-form'
        ? `Writing your ${duration} long-form shoot plan…`
        : 'Writing your shoot plan…'
    );

    setScriptStage('script');
    const response = await fetch('/api/generate-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idea,
        duration,
        style,
        format: videoFormat,
        aspectRatio,
        briefHints: hints || undefined,
        prefs,
        progress: true,
      }),
    });

    const { ok, data } = await readScriptResponse(response, (stage, message) => {
      setScriptStage(stage);
      setLoadingMessage(message);
    });
    if (!ok && !data.scenes && !data.fallback) {
      throw new Error(data.error || 'Failed to generate script');
    }

    const scriptData = data.scenes ? data : data.fallback;
    // Overlays only when Gemini/mediaPlan or clarify explicitly asked — never default-on
    const preferOverlays = hints?.preferOverlays === true;
    const scenesWithIds = (scriptData.scenes || []).map((s: any, idx: number) => {
      const isAiStill =
        s.filmedBy === 'ai' && (s.insertKind === 'broll' || s.editIntent === 'broll' || !s.insertKind);
      const roleFromPlan = s.mediaRole as string | undefined;
      const mediaRole =
        roleFromPlan === 'overlay' || roleFromPlan === 'cutaway' || roleFromPlan === 'capture'
          ? roleFromPlan
          : s.filmedBy === 'ai' && preferOverlays && isAiStill
            ? 'overlay'
            : s.filmedBy === 'ai'
              ? 'cutaway'
              : 'capture';
      const editZoom = Math.max(
        1,
        Math.min(1.15, Number(s.editZoom) || (s.editIntent === 'hook' || s.editIntent === 'product' ? 1.06 : 1))
      );
      return {
        ...s,
        id: `scene-${idx + 1}-${Date.now()}`,
        sceneNumber: idx + 1,
        includeInExport:
          s.filmedBy === 'ai'
            ? s.insertKind === 'title-card' ||
              s.insertKind === 'meme' ||
              mediaRole === 'overlay' ||
              (mediaRole === 'cutaway' && s.includeInExport === true)
            : true,
        mediaRole,
        overlayLayout:
          mediaRole === 'overlay' ? s.overlayLayout || 'pip_br' : s.overlayLayout,
        insertKind: s.insertKind,
        editZoom,
        transition: s.transition || (s.editIntent === 'hook' ? 'zoom-snap' : s.transition),
        transitionDuration: s.transitionDuration ?? 0.25,
        aiGenerationStatus: s.filmedBy === 'ai' ? 'ready' : 'idle',
        aiGeneratedImageUrl: undefined,
      };
    });

    // Attach overlay parents: resolve scene-ref:N from normalizer, else nearest prior user scene
    for (let i = 0; i < scenesWithIds.length; i++) {
      const s = scenesWithIds[i];
      if (s.mediaRole !== 'overlay' && s.mediaRole !== 'cutaway') continue;
      const ref = String(s.overlayParentSceneId || '');
      const refMatch = ref.match(/^scene-ref:(\d+)$/);
      if (refMatch) {
        const parentNum = Number(refMatch[1]);
        const parent = scenesWithIds.find(
          (p: any) => p.filmedBy === 'user' && Number(p.sceneNumber) === parentNum
        );
        if (parent) {
          s.overlayParentSceneId = parent.id;
          continue;
        }
      }
      if (!s.overlayParentSceneId || String(s.overlayParentSceneId).startsWith('scene-ref:')) {
        s.overlayParentSceneId = undefined;
        for (let j = i - 1; j >= 0; j--) {
          if (scenesWithIds[j].filmedBy === 'user') {
            s.overlayParentSceneId = scenesWithIds[j].id;
            break;
          }
        }
      }
    }

    const baseChannel: ChannelSettings = {
      channelName: channelKit?.channelName || 'My Channel',
      showWatermark: false,
      watermarkPosition: 'top-right',
      watermarkOpacity: 0.7,
      entryMusicEnabled: !!channelKit?.musicMood || !!hints?.musicMood,
      entryMusicStyle: 'signature-chime',
      noiseRemovalEnabled: true,
      captionsEnabled: false,
      captionStyle: 'modern-white',
      currentLanguage:
        scriptData.spokenLanguage ||
        scriptData.creativeBrief?.spokenLanguage ||
        'en',
      youtubeIntroEnabled: false,
      introMode: 'off',
      youtubeChannelHandle: channelKit?.youtubeChannelHandle || channelHandle || undefined,
      youtubeTagline: channelKit?.youtubeTagline,
      brandColor: channelKit?.brandColor || '#1A73E8',
      styleBible: channelKit?.styleBible,
      channelAnalysisNotes: [
        channelKit?.channelAnalysisNotes,
        channelKit?.visualLook ? `Look: ${channelKit.visualLook}` : null,
        Array.isArray(channelKit?.contentThemes) && channelKit.contentThemes.length
          ? `Themes: ${channelKit.contentThemes.join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join(' | ') || channelKit?.channelAnalysisNotes,
      aiEditingPreset:
        scriptData.creativeBrief?.editingStrategy === 'jump_cut_social'
          ? 'high_energy_social'
          : channelKit?.aiEditingPreset || 'high_energy_social',
      youtubeOutroEnabled: false,
      youtubeOutroCta: 'Thanks for watching',
    };

    const spokenLanguage =
      scriptData.spokenLanguage ||
      scriptData.creativeBrief?.spokenLanguage ||
      baseChannel.currentLanguage ||
      'en';

    const newProject: Project = {
      id: `proj-${Date.now()}`,
      title: scriptData.title || 'Untitled video',
      logline: scriptData.logline || idea,
      estimatedTotalSeconds:
        scriptData.estimatedTotalSeconds || (videoFormat === 'long-form' ? 300 : 45),
      musicMood:
        (hints?.musicMood as string) ||
        channelKit?.musicMood ||
        scriptData.musicMood ||
        'Warm Acoustic',
      scenes: scenesWithIds,
      createdAt: Date.now(),
      videoFormat: videoFormat,
      aspectRatio: aspectRatio,
      channelSettings: { ...baseChannel, currentLanguage: spokenLanguage },
      spokenLanguage,
      creativeBrief: scriptData.creativeBrief
        ? { ...scriptData.creativeBrief, spokenLanguage }
        : scriptData.creativeBrief,
      captureStrategy:
        scriptData.captureStrategy || scriptData.creativeBrief?.captureStrategy,
      prefs: scriptData.prefs || prefs,
      prefsUnmet: Array.isArray(scriptData.prefsUnmet) ? scriptData.prefsUnmet.map(String) : undefined,
      narrativeBeats: scriptData.narrativeBeats,
      captureUnits: scriptData.captureUnits || scriptData.capturePlan,
      capturePlan: scriptData.capturePlan || scriptData.captureUnits,
    };

    onScriptGenerated(newProject);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!idea.trim()) return;

    setError(null);
    setIsLoading(true);

    try {
      // If we already have answers / ready hints, generate
      if (briefHints && !clarifyQuestions.length) {
        await generateScript(briefHints);
        return;
      }

      setLoadingMessage('TakeOne is checking if anything needs clarifying…');
      const answerList = Object.entries(clarifyAnswers).map(([id, answer]) => ({
        id,
        answer,
      }));
      const clarifyRes = await fetch('/api/direction/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea,
          duration,
          style,
          format: videoFormat,
          aspectRatio,
          answers: answerList,
          round: clarifyRound,
          prefs,
        }),
      });
      const clarifyData = await clarifyRes.json();
      if (!clarifyRes.ok) throw new Error(clarifyData.error || 'Clarify failed');

      if (clarifyData.status === 'questions' && Array.isArray(clarifyData.questions)) {
        setClarifyQuestions(clarifyData.questions);
        setClarifyRound((r) => r + 1);
        setIsLoading(false);
        setLoadingMessage('');
        return;
      }

      const hints = clarifyData.briefHints || { preferOverlays: false };
      if (hints.preferOverlays !== true) hints.preferOverlays = prefsWantMedia(prefs);
      if (prefs.looks.includes('virtual_background')) hints.greenscreen = true;
      setBriefHints(hints);
      setClarifyQuestions([]);
      await generateScript(hints);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const submitClarifyAnswers = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const answerList = Object.entries(clarifyAnswers)
        .filter(([, a]) => String(a || '').trim())
        .map(([id, answer]) => ({ id, answer }));

      // After the user answered, skip a second clarify Gemini round — go straight to generate.
      if (answerList.length > 0 || clarifyRound >= 1) {
        const hints = {
          ...(briefHints || {}),
          answers: answerList,
          preferOverlays:
            briefHints?.preferOverlays === true ||
            prefsWantMedia(prefs) ||
            answerList.some((a) =>
              /\b(overlay|pip|meme|sticker|b-?roll insert)\b/i.test(String(a.answer))
            ),
          greenscreen:
            briefHints?.greenscreen === true ||
            prefs.looks.includes('virtual_background') ||
            answerList.some((a) => /green\s*screen/i.test(String(a.answer))),
          musicMood:
            answerList.find((a) => /music|mood|sound/i.test(a.id))?.answer ||
            briefHints?.musicMood,
        };
        setBriefHints(hints);
        setClarifyQuestions([]);
        setLoadingMessage('Writing your shoot plan…');
        await generateScript(hints);
        return;
      }

      setLoadingMessage('Applying your answers…');
      const clarifyRes = await fetch('/api/direction/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea,
          duration,
          style,
          format: videoFormat,
          aspectRatio,
          answers: answerList,
          round: clarifyRound,
          prefs,
        }),
      });
      const clarifyData = await clarifyRes.json();
      if (!clarifyRes.ok) throw new Error(clarifyData.error || 'Clarify failed');

      if (clarifyData.status === 'questions' && clarifyRound < 2) {
        setClarifyQuestions(clarifyData.questions);
        setClarifyRound((r) => r + 1);
        setIsLoading(false);
        return;
      }

      const hints = {
        ...(clarifyData.briefHints || {}),
        answers: answerList,
        preferOverlays: clarifyData.briefHints?.preferOverlays === true || prefsWantMedia(prefs),
        greenscreen:
          clarifyData.briefHints?.greenscreen === true || prefs.looks.includes('virtual_background'),
      };
      setBriefHints(hints);
      setClarifyQuestions([]);
      setLoadingMessage('Writing your shoot plan…');
      await generateScript(hints);
    } catch (err: any) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
    <div className="max-w-3xl mx-auto px-4 py-8 md:py-12">
      {/* Hero: the promise is the headline — the product name already sits in the nav. */}
      <div className="text-center space-y-4 mb-10">
        <h1 className="text-[1.85rem] sm:text-5xl md:text-6xl font-extrabold tracking-[-0.03em] text-[#202124] leading-[1.05] font-['Plus_Jakarta_Sans',sans-serif] [text-wrap:balance]">
          You&apos;re the talent.
          <br />
          <span className="text-[#1A73E8]">TakeOne is the director.</span>
        </h1>
        <p className="text-[#5F6368] text-base md:text-lg max-w-[34rem] mx-auto leading-relaxed [text-wrap:pretty]">
          Tell us the idea. We write the script, coach you through the shoot, clean up dead air, add
          captions and visuals, and hand you a ready-to-post cut — in your language.
        </p>
        {onImportFootage && (
          <p className="text-sm text-[#5F6368]">
            Already filmed it?{' '}
            <button
              type="button"
              onClick={onImportFootage}
              className="inline-flex items-center gap-1 font-semibold text-[#1A73E8] hover:underline underline-offset-4 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Import your footage
            </button>
          </p>
        )}
      </div>

      {/* Main Input Card: Pristine White Google Elevation */}
      <div className="bg-white border border-[#DADCE0] rounded-2xl md:rounded-3xl p-6 md:p-8 shadow-[0_1px_3px_rgba(60,64,67,0.12),0_4px_8px_rgba(60,64,67,0.06)] relative overflow-hidden">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Format Selector: Short Form vs Long Form (Material 3 Segmented Control) */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-[#5F6368]">
              Format
            </label>
            <div className="grid grid-cols-2 gap-2 p-1.5 bg-[#F1F3F4] rounded-2xl border border-[#DADCE0]">
              <button
                type="button"
                onClick={() => handleFormatChange('short-form')}
                className={`flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl text-xs md:text-sm font-semibold transition-all ${
                  videoFormat === 'short-form'
                    ? 'bg-white text-[#1A73E8] shadow-sm border border-[#DADCE0]'
                    : 'text-[#5F6368] hover:text-[#202124] hover:bg-white/50'
                }`}
              >
                <Smartphone className="w-4 h-4 shrink-0" />
                <div className="text-left leading-tight">
                  <div className="font-bold">Short form</div>
                  <div className={`text-xs ${videoFormat === 'short-form' ? 'text-[#1A73E8]' : 'text-[#80868B]'}`}>
                    15s to 90s • Reels / Shorts
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleFormatChange('long-form')}
                className={`flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl text-xs md:text-sm font-semibold transition-all ${
                  videoFormat === 'long-form'
                    ? 'bg-white text-[#1A73E8] shadow-sm border border-[#DADCE0]'
                    : 'text-[#5F6368] hover:text-[#202124] hover:bg-white/50'
                }`}
              >
                <Monitor className="w-4 h-4 shrink-0" />
                <div className="text-left leading-tight">
                  <div className="font-bold">Long form</div>
                  <div className={`text-xs ${videoFormat === 'long-form' ? 'text-[#1A73E8]' : 'text-[#80868B]'}`}>
                    3 mins to 60 mins • Chapters
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Idea Input */}
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-[#202124]">
              What do you want to make a video about?
            </label>
            <div className="relative">
              <textarea
                ref={ideaRef}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder={
                  videoFormat === 'long-form'
                    ? 'e.g., A 10-minute deep dive on how to start living with plants, build an indoor jungle, and overcome plant care mistakes...'
                    : 'e.g., A 45-second video about my love of plants and why watering them is my morning calm...'
                }
                rows={3}
                disabled={isLoading}
                className="w-full bg-[#F8F9FA] border border-[#DADCE0] focus:bg-white focus:border-[#1A73E8] focus:ring-4 focus:ring-[#1A73E8]/10 rounded-xl px-4 py-3.5 text-[#202124] placeholder-[#80868B] transition-all resize-none text-base font-normal leading-relaxed shadow-inner"
              />
            </div>
          </div>

          {/* Quick-Pick Demo Chips */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-[#5F6368]">
              {videoFormat === 'long-form'
                ? 'Try a longer story (optional):'
                : 'Try a short-form prompt:'}
            </span>
            <div className="flex flex-wrap gap-2">
              {(videoFormat === 'long-form' ? LONG_FORM_IDEAS : SHORT_FORM_IDEAS).map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setIdea(item.idea);
                    setDuration(item.duration);
                    setStyle(item.style);
                    setVideoFormat(item.format);
                    setAspectRatio(item.aspectRatio);
                  }}
                  disabled={isLoading}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#F1F3F4] hover:bg-[#E8EAED] text-[#3C4043] hover:text-[#1A73E8] border border-[#DADCE0] hover:border-[#1A73E8]/60 transition active:scale-95 text-left shadow-2xs"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Existing channel continuity */}
          <div className="space-y-3 pt-1 border-t border-[#E8EAED]">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hasExistingChannel}
                onChange={(e) => setHasExistingChannel(e.target.checked)}
                className="rounded border-[#DADCE0]"
              />
              <span className="text-sm font-semibold text-[#202124] flex items-center gap-1.5">
                <Youtube className="w-4 h-4 text-[#EA4335]" />
                Match my channel style (optional)
              </span>
            </label>
            {hasExistingChannel && (
              <div className="space-y-2.5 p-4 rounded-xl bg-[#F8F9FA] border border-[#DADCE0]">
                <p className="text-xs text-[#5F6368] leading-relaxed">
                  Paste your YouTube or @handle so we match your look, pacing, and tone. Optional —
                  skip if you are starting fresh.
                </p>
                <input
                  type="text"
                  value={channelUrl}
                  onChange={(e) => setChannelUrl(e.target.value)}
                  placeholder="https://youtube.com/@yourchannel"
                  className="w-full bg-white border border-[#DADCE0] rounded-lg px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  value={channelHandle}
                  onChange={(e) => setChannelHandle(e.target.value)}
                  placeholder="@handle (optional)"
                  className="w-full bg-white border border-[#DADCE0] rounded-lg px-3 py-2 text-xs"
                />
                <textarea
                  value={channelNotes}
                  onChange={(e) => setChannelNotes(e.target.value)}
                  placeholder="Describe your usual intro, music, clipping style… (helps when metadata is thin)"
                  rows={2}
                  className="w-full bg-white border border-[#DADCE0] rounded-lg px-3 py-2 text-xs resize-y"
                />
                <button
                  type="button"
                  disabled={analyzingChannel || (!channelUrl && !channelHandle && !channelNotes)}
                  onClick={analyzeExistingChannel}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#202124] text-white text-xs font-bold hover:bg-black disabled:opacity-50 cursor-pointer"
                >
                  {analyzingChannel ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="w-3.5 h-3.5" />
                  )}
                  Analyze my channel
                </button>
                {channelAnalysisMsg && (
                  <p className="text-xs text-[#137333] leading-relaxed">{channelAnalysisMsg}</p>
                )}
                {channelKit?.pulledTitle && (
                  <p className="text-xs text-[#202124] font-semibold border-t border-[#DADCE0] pt-2">
                    Pulled: {channelKit.pulledTitle}
                    {channelKit.usedYoutubeApiKey
                      ? ` · ${channelKit.recentVideoCount || 0} recent videos · ${channelKit.thumbnailsAnalyzed || 0} visuals`
                      : channelKit.needsYoutubeApiKey
                        ? ' · add YOUTUBE_API_KEY for subscriber counts'
                        : ''}
                  </p>
                )}
                {Array.isArray(channelKit?.contentThemes) && channelKit.contentThemes.length > 0 && (
                  <p className="text-xs text-[#3C4043] border-t border-[#DADCE0] pt-2">
                    Content: {channelKit.contentThemes.join(' · ')}
                  </p>
                )}
                {channelKit?.visualLook && (
                  <p className="text-xs text-[#3C4043] border-t border-[#DADCE0] pt-2">
                    Look: {channelKit.visualLook}
                  </p>
                )}
                {channelKit?.styleBible && (
                  <p className="text-xs text-[#5F6368] italic border-t border-[#DADCE0] pt-2">
                    Style bible: {channelKit.styleBible}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Controls: Target Duration, Aspect Ratio & Style */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            {/* Target Duration Dropdown */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-[#3C4043]">
                <Clock className="w-3.5 h-3.5 text-[#1A73E8]" />
                Length
              </label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={isLoading}
                className="w-full bg-white border border-[#DADCE0] focus:border-[#1A73E8] focus:ring-2 focus:ring-[#1A73E8]/20 rounded-xl px-3 py-2.5 text-xs md:text-sm text-[#202124] shadow-2xs"
              >
                {videoFormat === 'short-form' ? (
                  <>
                    <option value="15 seconds">15 seconds (Micro-Hook)</option>
                    <option value="30 seconds">30 seconds (Punchy Reel)</option>
                    <option value="45 seconds">45 seconds (Standard Short)</option>
                    <option value="60 seconds">60 seconds (1-Min Reel)</option>
                    <option value="90 seconds">90 seconds (Extended Short)</option>
                  </>
                ) : (
                  <>
                    <option value="3 minutes">3 minutes (Mini-Doc / Pitch)</option>
                    <option value="5 minutes">5 minutes (How-To / Tutorial)</option>
                    <option value="10 minutes">10 minutes (Deep Dive / Essay)</option>
                    <option value="15 minutes">15 minutes (Full Video Podcast)</option>
                    <option value="30 minutes">30 minutes (In-Depth Masterclass)</option>
                    <option value="45 minutes">45 minutes (Comprehensive Feature)</option>
                    <option value="60 minutes">60 minutes (Full Production / Film)</option>
                  </>
                )}
              </select>
            </div>

            {/* Aspect Ratio */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-[#3C4043]">
                <Film className="w-3.5 h-3.5 text-[#1A73E8]" />
                Aspect ratio
              </label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                disabled={isLoading}
                className="w-full bg-white border border-[#DADCE0] focus:border-[#1A73E8] focus:ring-2 focus:ring-[#1A73E8]/20 rounded-xl px-3 py-2.5 text-xs md:text-sm text-[#202124] shadow-2xs"
              >
                <option value="9:16">9:16 (Vertical Mobile)</option>
                <option value="16:9">16:9 (Horizontal Widescreen)</option>
              </select>
            </div>

            {/* Storytelling Tone */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-[#3C4043]">
                <Compass className="w-3.5 h-3.5 text-[#1A73E8]" />
                Tone & pace
              </label>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                disabled={isLoading}
                className="w-full bg-white border border-[#DADCE0] focus:border-[#1A73E8] focus:ring-2 focus:ring-[#1A73E8]/20 rounded-xl px-3 py-2.5 text-xs md:text-sm text-[#202124] shadow-2xs"
              >
                <option value="Warm & authentic vlog">Warm & authentic vlog</option>
                <option value="Educational & clear">Educational & clear</option>
                <option value="Mindful & sensory">Mindful & sensory</option>
                <option value="Energetic & inspiring">Energetic & inspiring</option>
                <option value="Cozy & informal">Cozy & informal</option>
              </select>
            </div>
          </div>

          <PrefsPanel prefs={prefs} onChange={setPrefs} disabled={isLoading} />

          {clarifyQuestions.length > 0 && (
            <div className="rounded-xl border border-[#D2E3FC] bg-[#E8F0FE]/40 p-4 space-y-3">
              <div className="text-sm font-bold text-[#202124]">
                Quick questions before we lock the shoot plan
              </div>
              <p className="text-xs text-[#5F6368]">
                Gemini wants a bit more direction (round {clarifyRound}/2).
              </p>
              {clarifyQuestions.map((q) => (
                <div key={q.id} className="space-y-1.5">
                  <label className="text-xs font-semibold text-[#3C4043]">{q.prompt}</label>
                  {Array.isArray(q.choices) && q.choices.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {q.choices.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() =>
                            setClarifyAnswers((prev) => ({ ...prev, [q.id]: c }))
                          }
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold border cursor-pointer ${
                            clarifyAnswers[q.id] === c
                              ? 'bg-[#1A73E8] text-white border-[#1A73E8]'
                              : 'bg-white text-[#3C4043] border-[#DADCE0] hover:border-[#1A73E8]'
                          }`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={clarifyAnswers[q.id] || ''}
                      onChange={(e) =>
                        setClarifyAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-lg border border-[#DADCE0] text-sm"
                      placeholder="Your answer…"
                    />
                  )}
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void submitClarifyAnswers()}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-xl bg-[#1A73E8] text-white text-sm font-bold hover:bg-[#1557B0] cursor-pointer"
                >
                  Continue with answers →
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const hints = { preferOverlays: false, answers: clarifyAnswers };
                    setClarifyQuestions([]);
                    setBriefHints(hints);
                    setIsLoading(true);
                    void generateScript(hints).finally(() => setIsLoading(false));
                  }}
                  className="px-4 py-2 rounded-xl bg-white border border-[#DADCE0] text-sm font-semibold text-[#3C4043] cursor-pointer"
                >
                  Skip & generate
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-[#FCE8E6] border border-[#F5C2C7] rounded-xl text-[#C5221F] text-xs">
              {error}
            </div>
          )}

          {/* Submit Button: Google Blue Primary */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoading || !idea.trim()}
              className="w-full py-3.5 px-6 rounded-xl font-bold text-white bg-[#1A73E8] hover:bg-[#1557B0] transition-all shadow-[0_1px_2px_rgba(60,64,67,0.3),0_1px_3px_1px_rgba(60,64,67,0.15)] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-base cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>
                    {videoFormat === 'long-form'
                      ? 'Directing your chapters...'
                      : 'Directing your scenes...'}
                  </span>
                </>
              ) : (
                <>
                  <Wand2 className="w-5 h-5" />
                  <span>
                    {videoFormat === 'long-form'
                      ? `Direct my ${duration.replace(/^(\d+)\s*(second|minute|hour)s?\b.*/i, '$1-$2')} video →`
                      : `Direct my ${duration.replace(/^(\d+)\s*(second|minute|hour)s?\b.*/i, '$1-$2')} video →`}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>

        {/* Loading overlay with Google styling */}
        {isLoading && (
          <div className="mt-6 p-4 rounded-xl bg-[#F8F9FA] border border-[#DADCE0] text-center space-y-2">
            <div className="flex items-center justify-center gap-2 text-[#1A73E8] text-sm font-semibold">
              <Sparkles className="w-4 h-4 animate-spin text-[#1A73E8]" />
              <span>TakeOne is composing your production sheet with Gemini...</span>
            </div>
            {scriptStage ? (
              <ol className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-semibold">
                {SCRIPT_STAGES.filter((st) => st.id !== 'repair' || scriptStage === 'repair').map((st) => {
                  const order = SCRIPT_STAGES.findIndex((x) => x.id === st.id);
                  const current = SCRIPT_STAGES.findIndex((x) => x.id === scriptStage);
                  const state = order < current ? 'done' : order === current ? 'active' : 'todo';
                  return (
                    <li
                      key={st.id}
                      className={
                        state === 'active'
                          ? 'text-[#1A73E8]'
                          : state === 'done'
                            ? 'text-[#188038]'
                            : 'text-[#9AA0A6]'
                      }
                    >
                      {state === 'done' ? '✓ ' : state === 'active' ? '● ' : '○ '}
                      {st.label}
                    </li>
                  );
                })}
              </ol>
            ) : null}
            <p className="text-xs text-[#5F6368]">
              {loadingMessage}
              {loadingSeconds >= 3 ? ` · ${loadingSeconds}s` : ''}
            </p>
          </div>
        )}
      </div>
    </div>

    <HomeShowcase
      onUseIdea={(next, seconds) => {
        setIdea(next);
        if (videoFormat === 'short-form') setDuration(`${seconds} seconds`);
        const el = ideaRef.current;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          window.setTimeout(() => el.focus({ preventScroll: true }), 450);
        }
      }}
    />
    </>
  );
};
