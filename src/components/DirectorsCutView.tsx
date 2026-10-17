import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clapperboard,
  Download,
  Loader2,
  Music,
  Sparkles,
  Wand2,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  ImagePlus,
  Camera,
  ChevronLeft,
  Scissors,
  Trash2,
} from 'lucide-react';
import {
  Project,
  Scene,
  ProductionPrefs,
  DirectorCutReportSummary,
  ChannelSettings,
  AspectRatio,
  ProjectRender,
  defaultProductionPrefs,
  formatDuration,
} from '../types/director';
import { buildBasePlan } from '../utils/basePlan';
import {
  pollRenderJob,
  describeRenderProgress,
  uploadBlobToGcs,
  hydrateTakesForDirector,
  projectPayloadForDirector,
  resolveMediaForRender,
  resolveMasterPlayUrl,
  deleteRenderJob,
  savePendingJob,
  loadPendingJob,
  clearPendingJob,
  extensionForMime,
} from '../utils/renderClient';
import { mediaUrlFromGcs, playableTakeUrl } from '../utils/mediaVault';
import {
  applyAssetResults,
  findMissingAssets,
  generateAssets,
  sceneHasMedia,
} from '../utils/aiVisuals';
import { AiVisualsPanel } from './AiVisualsPanel';
import { LiveCutPlayer } from './LiveCutPlayer';
import { applyTweakOps, type TweakOp } from '../utils/tweaks';
import { VisualEditor } from './VisualEditor';
import { ApplyBackgroundCard } from './ApplyBackgroundCard';
import type { EditDecisionList } from '../utils/edl';

/**
 * Director's Cut — the single post-shoot screen.
 *
 *   prefs  →  Render (draft) / Final  →  /api/director-cut  →  "What I did" report + master player
 *
 * The server compiles ProductionPrefs + scene recipes + word timings into the EDL and starts the
 * render job; this view only prepares media (durable GCS paths), calls the endpoint, and polls.
 */

interface DirectorsCutViewProps {
  project: Project;
  onUpdateProject: (updated: Project | ((prev: Project) => Project)) => void;
  onRetakeScene: (sceneId: string) => void;
  onRegenerateAiScene: (sceneId: string) => void;
  onBackToShooting: () => void;
  /** Jump to the AI cutaway generator (for scenes that are filmedBy 'ai') */
  onGenerateAiScenes?: () => void;
}

type PlayerTab = 'live' | 'source' | 'draft' | 'final';

/** Hackathon demo: hide Draft/Preview so judges score Export only. Flip to true after. */
const SHOW_DRAFT_PREVIEW = false;

const CAPTION_OPTIONS: Array<{ id: ProductionPrefs['captions']; label: string }> = [
  { id: 'bold_pop', label: 'Bold pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'clean', label: 'Clean' },
  { id: 'off', label: 'Off' },
];

const MUSIC_MOODS = [
  'Warm Acoustic',
  'Lo-fi',
  'Upbeat Pop',
  'Cinematic',
  'Corporate',
  'Chill Electronic',
];

/** Survives DirectorsCutView remounts so tab switches don't start a second poll. */
const activeRenderPolls = new Set<string>();

const LOOK_OPTIONS: Array<{ id: ProductionPrefs['looks'][number]; label: string }> = [
  { id: 'broll', label: 'B-roll' },
  { id: 'virtual_background', label: 'Virtual background' },
  { id: 'text_pops', label: 'Text pops' },
  { id: 'overlays', label: 'Overlays' },
];


/* ───────────────────────── media helpers ───────────────────────── */

const durableUrlCache = new Map<string, string>();

/** blob:/data: → gs:// (cached); everything else passes through. */
async function durableUrl(url: unknown, folder: string): Promise<string | undefined> {
  if (typeof url !== 'string' || !url) return undefined;
  if (!url.startsWith('blob:') && !url.startsWith('data:')) return url;
  const hit = durableUrlCache.get(url);
  if (hit) return hit;
  const resolved = await resolveMediaForRender(url, folder);
  if (resolved) durableUrlCache.set(url, resolved);
  return resolved || undefined;
}

/** Copy of the project that the server can read: no blob:/data: URLs anywhere it looks. */
async function projectForServer(working: Project): Promise<Project> {
  const base = projectPayloadForDirector(working) as Project;
  const scenes = await Promise.all(
    (base.scenes || []).map(async (scene) => {
      const next: any = { ...scene };
      for (const key of ['aiGeneratedImageUrl', 'aiGeneratedVideoUrl', 'userInsertUrl'] as const) {
        if (typeof next[key] === 'string') next[key] = await durableUrl(next[key], 'cutaways');
      }
      if (next.recipe) {
        const recipe = { ...next.recipe };
        if (Array.isArray(recipe.inserts)) {
          recipe.inserts = await Promise.all(
            recipe.inserts.map(async (ins: any) =>
              ins?.assetUrl ? { ...ins, assetUrl: await durableUrl(ins.assetUrl, 'broll') } : ins
            )
          );
        }
        if (recipe.background?.assetUrl) {
          recipe.background = {
            ...recipe.background,
            assetUrl: await durableUrl(recipe.background.assetUrl, 'broll'),
          };
        }
        next.recipe = recipe;
      }
      return next as Scene;
    })
  );
  let channelSettings = base.channelSettings;
  if (channelSettings) {
    const cs: any = { ...channelSettings };
    for (const key of ['musicTrackUrl', 'introBackgroundUrl', 'introVideoUrl', 'logoUrl'] as const) {
      if (typeof cs[key] === 'string') cs[key] = await durableUrl(cs[key], 'intro');
    }
    channelSettings = cs as ChannelSettings;
  }
  return { ...base, scenes, channelSettings };
}

function sceneSourceUrl(scene: Scene): string | null {
  if (scene.filmedBy !== 'user') return null;
  return playableTakeUrl(scene);
}


/* ───────────────────────── component ───────────────────────── */

/** What a tweak just did, shown over the Live edit player. */
const TweakBanner: React.FC<{ text: string; onUndo?: () => void; onClose: () => void }> = ({ text, onUndo, onClose }) => (
  <div
    role="status"
    className="flex items-start gap-3 rounded-xl bg-white/95 px-3.5 py-2.5 text-sm text-[#202124] animate-[takeonePrompterIn_200ms_ease-out]"
  >
    <Wand2 className="w-4 h-4 text-[#1A73E8] shrink-0 mt-0.5" />
    <p className="flex-1 leading-snug">{text}</p>
    {onUndo && (
      <button type="button" onClick={onUndo} className="font-bold text-[#1A73E8] hover:underline cursor-pointer shrink-0">
        Undo
      </button>
    )}
    <button type="button" onClick={onClose} aria-label="Dismiss" className="text-[#5F6368] hover:text-[#202124] cursor-pointer shrink-0">
      ×
    </button>
  </div>
);

export const DirectorsCutView: React.FC<DirectorsCutViewProps> = ({
  project,
  onUpdateProject,
  onRetakeScene,
  onRegenerateAiScene,
  onBackToShooting,
  onGenerateAiScenes,
}) => {
  const prefs: ProductionPrefs = useMemo(
    () =>
      project.prefs ||
      project.creativeBrief?.prefs ||
      defaultProductionPrefs(project.videoFormat),
    [project.prefs, project.creativeBrief?.prefs, project.videoFormat]
  );
  const aspectRatio: AspectRatio =
    project.aspectRatio || (project.videoFormat === 'long-form' ? '16:9' : '9:16');
  const report = project.directorReport || null;

  const resolveInitialPending = () => {
    const fromProject = project.pendingRender;
    if (fromProject?.jobId) return fromProject;
    const fromLs = loadPendingJob(project.id);
    if (fromLs?.kind === 'render' && fromLs.jobId) {
      return {
        jobId: fromLs.jobId,
        quality: (fromLs.quality || 'draft') as 'draft' | 'standard' | 'high',
        startedAt: fromLs.startedAt || Date.now(),
      };
    }
    return null;
  };
  const initialPending = resolveInitialPending();

  const [tab, setTab] = useState<PlayerTab>(() => {
    if (initialPending) {
      if (initialPending.quality === 'draft' && !SHOW_DRAFT_PREVIEW) return 'source';
      return initialPending.quality === 'draft' ? 'draft' : 'final';
    }
    const r = project.renders || [];
    if (r.some((x) => x.kind === 'final') || project.masterVideoUrl) return 'final';
    if (SHOW_DRAFT_PREVIEW && r.some((x) => x.kind === 'draft')) return 'draft';
    return 'live';
  });
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [masterUrl, setMasterUrl] = useState<string | null>(project.masterVideoUrl || null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busyQuality, setBusyQuality] = useState<'draft' | 'standard' | 'high' | null>(
    () => initialPending?.quality ?? null
  );
  const [exportTier, setExportTier] = useState<'standard' | 'high'>('high');
  const [progress, setProgress] = useState({
    percent: initialPending ? 10 : 0,
    status: initialPending ? 'Resuming render…' : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const renderLock = useRef(false);
  const mountedRef = useRef(true);

  const [sourceIdx, setSourceIdx] = useState(0);

  const [prompt, setPrompt] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptSummary, setPromptSummary] = useState<string | null>(null);

  const [musicBusy, setMusicBusy] = useState(false);
  const [musicStatus, setMusicStatus] = useState<string | null>(null);
  const musicTrack = project.channelSettings?.musicTrackUrl || null;
  // The track is stored as gs:// for the renderer; the browser plays it through the media proxy.
  const musicPreviewUrl = musicTrack?.startsWith('gs://') ? mediaUrlFromGcs(musicTrack) : musicTrack;

  /* ── Live edit: recompile the cut (no render) whenever something that shapes it changes ── */
  const [liveEdl, setLiveEdl] = useState<EditDecisionList | null>(null);
  const [liveUpdating, setLiveUpdating] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveBanner, setLiveBanner] = useState<React.ReactNode>(null);
  const liveSeq = useRef(0);
  const cutKey = useMemo(
    () =>
      JSON.stringify({
        a: aspectRatio,
        p: prefs,
        s: project.scenes.map((sc) => [
          sc.id,
          sc.gcsObjectPath,
          sc.recordedDuration,
          sc.inPoint,
          sc.outPoint,
          sc.keepRanges,
          sc.userTrimLocked,
          sc.recipe,
          sc.words?.length,
          sc.wordsSource,
          sc.aiGeneratedImageUrl,
          sc.userInsertUrl,
          sc.aiVisualEnabled,
          sc.includeInExport,
          sc.mediaRole,
          sc.overlayLayout,
          sc.virtualBackgroundBaked,
          sc.virtualBackgroundMode,
        ]),
      }),
    [aspectRatio, prefs, project.scenes]
  );
  useEffect(() => {
    if (!project.scenes.some((sc) => sc.gcsObjectPath)) return;
    const seq = ++liveSeq.current;
    setLiveUpdating(true);
    const timer = window.setTimeout(async () => {
      try {
        const payload = await projectForServer({ ...projectRef.current, prefs });
        const res = await fetch('/api/director-cut/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: payload,
            prefs,
            options: { aspectRatio, musicEnabled: false },
          }),
        });
        const data = await res.json().catch(() => ({} as any));
        if (seq !== liveSeq.current) return;
        if (!res.ok || !data?.edl) throw new Error(data?.error || `HTTP ${res.status}`);
        setLiveEdl(data.edl);
        setLiveError(null);
        const updates: Record<string, Partial<Scene>> | undefined = data.wordUpdates;
        if (updates && Object.keys(updates).length) {
          onUpdateProject((prev) => ({
            ...prev,
            scenes: prev.scenes.map((sc) => (updates[sc.id] ? { ...sc, ...updates[sc.id] } : sc)),
          }));
        }
      } catch (e: any) {
        if (seq === liveSeq.current) setLiveError(e?.message || 'compile failed');
      } finally {
        if (seq === liveSeq.current) setLiveUpdating(false);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutKey]);


  const isBusy = busyQuality !== null;
  const projectRef = useRef(project);
  projectRef.current = project;
  const onUpdateRef = useRef(onUpdateProject);
  onUpdateRef.current = onUpdateProject;

  const finishRenderJob = useCallback(
    async (
      jobId: string,
      quality: 'draft' | 'standard' | 'high',
      job: { outputDurationSec?: number; outputGcsPath?: string; warnings?: string[] }
    ) => {
      const playUrl = await resolveMasterPlayUrl(jobId);
      clearPendingJob('render', projectRef.current.id);
      const entry: ProjectRender = {
        jobId,
        kind: quality === 'draft' ? 'draft' : 'final',
        quality,
        createdAt: Date.now(),
        durationSec: job.outputDurationSec,
        gcsPath: job.outputGcsPath,
      };
      onUpdateRef.current((prev) => ({
        ...prev,
        pendingRender: undefined,
        ...(quality === 'draft' ? {} : { masterVideoUrl: playUrl }),
        renders: [...(prev.renders || []).filter((r) => r.jobId !== entry.jobId), entry],
      }));
      if (mountedRef.current) {
        setProgress({
          percent: 100,
          status:
            quality === 'draft'
              ? 'Draft ready'
              : quality === 'high'
                ? 'High export ready'
                : 'Export ready',
        });
        if (quality === 'draft') {
          setDraftUrl(playUrl);
          if (SHOW_DRAFT_PREVIEW) setTab('draft');
        } else {
          setMasterUrl(playUrl);
          setTab('final');
        }
      }
      return playUrl;
    },
    []
  );

  useEffect(() => {
    setMasterUrl(project.masterVideoUrl || null);
  }, [project.masterVideoUrl]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const restoreUrls = async () => {
      const renders = projectRef.current.renders || [];
      const latestFinal = [...renders].reverse().find((r) => r.kind === 'final');
      const latestDraft = [...renders].reverse().find((r) => r.kind === 'draft');
      try {
        if (latestFinal) {
          const url = await resolveMasterPlayUrl(latestFinal.jobId);
          if (!cancelled && mountedRef.current) setMasterUrl(url);
        }
        if (latestDraft) {
          const url = await resolveMasterPlayUrl(latestDraft.jobId);
          if (!cancelled && mountedRef.current) setDraftUrl(url);
        }
        if (!cancelled && mountedRef.current && !projectRef.current.pendingRender) {
          const pendingLs = loadPendingJob(projectRef.current.id);
          if (!(pendingLs?.kind === 'render')) {
            if (latestFinal) setTab('final');
            else if (SHOW_DRAFT_PREVIEW && latestDraft) setTab('draft');
          }
        }
      } catch {
        /* job may have been deleted */
      }
    };

    const resumePending = async () => {
      const pending =
        projectRef.current.pendingRender ||
        (() => {
          const fromLs = loadPendingJob(projectRef.current.id);
          if (fromLs?.kind === 'render' && fromLs.jobId) {
            return {
              jobId: fromLs.jobId,
              quality: (fromLs.quality || 'draft') as 'draft' | 'standard' | 'high',
              startedAt: fromLs.startedAt || Date.now(),
            };
          }
          return null;
        })();
      if (!pending?.jobId) return;
      const q = pending.quality || 'draft';
      if (mountedRef.current) {
        setBusyQuality(q);
        setTab(q === 'draft' && !SHOW_DRAFT_PREVIEW ? 'source' : q === 'draft' ? 'draft' : 'final');
        setProgress({ percent: 10, status: 'Resuming render…' });
      }
      onUpdateRef.current((prev) => ({
        ...prev,
        pendingRender: {
          jobId: pending.jobId,
          quality: q,
          startedAt: pending.startedAt || Date.now(),
        },
      }));
      // Always poll on remount so progress UI updates; finishRenderJob is idempotent.
      activeRenderPolls.add(pending.jobId);
      renderLock.current = true;
      try {
        const pollStart = pending.startedAt || Date.now();
        const job = await pollRenderJob(pending.jobId, (j) => {
          if (!mountedRef.current) return;
          setProgress({
            percent: Math.max(10, j.percent || 0),
            status: describeRenderProgress(j, pollStart),
          });
        });
        if (job.status === 'error') throw new Error(job.error || 'Export failed');
        await finishRenderJob(pending.jobId, q, job);
        if (Array.isArray(job.warnings) && job.warnings.length && mountedRef.current) {
          onUpdateRef.current((prev) => {
            const prevReport = prev.directorReport;
            if (!prevReport) return prev;
            const merged = Array.from(
              new Set([...(prevReport.warnings || []), ...job.warnings!.map(String)])
            );
            return { ...prev, directorReport: { ...prevReport, warnings: merged } };
          });
        }
      } catch (e: any) {
        clearPendingJob('render', projectRef.current.id);
        onUpdateRef.current((prev) => ({ ...prev, pendingRender: undefined }));
        if (mountedRef.current) {
          setError(e?.message || 'Export failed');
        }
      } finally {
        activeRenderPolls.delete(pending.jobId);
        renderLock.current = false;
        if (mountedRef.current) setBusyQuality(null);
      }
    };

    void restoreUrls().then(() => resumePending());
    return () => {
      cancelled = true;
      mountedRef.current = false;
      // Keep pendingRender / localStorage so the next mount resumes; do not clear busy in storage.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, finishRenderJob]);

  /* ── derived ── */
  const sources = useMemo(
    () =>
      project.scenes
        .map((s) => ({ scene: s, url: sceneSourceUrl(s) }))
        .filter((x): x is { scene: Scene; url: string } => Boolean(x.url)),
    [project.scenes]
  );
  const activeSource = sources[Math.min(sourceIdx, Math.max(0, sources.length - 1))];


  const prefsChangedSinceRender = useMemo(() => {
    if (!report?.prefs) return false;
    return JSON.stringify(report.prefs) !== JSON.stringify(prefs);
  }, [report?.prefs, prefs]);

  /* ── prefs ── */
  const updatePrefs = useCallback(
    (next: ProductionPrefs) => {
      onUpdateProject((prev) => ({
        ...prev,
        prefs: next,
        creativeBrief: prev.creativeBrief ? { ...prev.creativeBrief, prefs: next } : prev.creativeBrief,
      }));
    },
    [onUpdateProject]
  );

  const toggleLook = (look: ProductionPrefs['looks'][number]) => {
    const has = prefs.looks.includes(look);
    let looks = has ? prefs.looks.filter((l) => l !== look) : [...prefs.looks, look];
    if (!looks.includes('talking_head')) looks = ['talking_head', ...looks];
    updatePrefs({ ...prefs, looks });
  };

  /* ── soundtrack ── */
  const generateMusic = useCallback(async (): Promise<string | null> => {
    const p = projectRef.current;
    setMusicBusy(true);
    setMusicStatus('Composing soundtrack…');
    try {
      const mood = p.musicMood || 'Warm Acoustic';
      const total = p.estimatedTotalSeconds || 30;
      const res = await fetch('/api/generate-music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Cinematic soundtrack in ${mood} style for video "${p.title}", balanced, harmonious`,
          durationSeconds: total <= 30 ? 30 : 60,
          mood,
        }),
      });
      const data = await res.json();
      if (!data?.audioBase64) {
        setMusicStatus(data?.error || data?.message || 'No soundtrack returned — render will use dialogue only.');
        return null;
      }
      const mime = data.mimeType || 'audio/mp3';
      const bin = atob(data.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      let url: string;
      try {
        url = (await uploadBlobToGcs(blob, 'music', extensionForMime(mime), mime)).gcsUri;
      } catch {
        url = URL.createObjectURL(blob); // uploaded lazily at render time
      }
      onUpdateProject((prev) => ({
        ...prev,
        channelSettings: { ...(prev.channelSettings as ChannelSettings), musicTrackUrl: url },
        renders: (prev.renders || []).map((r) => ({ ...r, outdated: true })),
      }));
      setMusicStatus('Soundtrack ready — it mixes under your voice. Export again to hear it in the cut.');
      return url;
    } catch (e: any) {
      setMusicStatus(e?.message || 'Soundtrack failed — render will use dialogue only.');
      return null;
    } finally {
      setMusicBusy(false);
    }
  }, [onUpdateProject]);


  /* ── render via /api/director-cut ── */
  const runRender = async (quality: 'draft' | 'standard' | 'high') => {
    if (renderLock.current) return;
    renderLock.current = true;
    setBusyQuality(quality);
    setError(null);
    setNotes([]);
    setProgress({ percent: 2, status: 'Saving takes to cloud…' });
    let startedJobId: string | null = null;

    try {
      let working: Project = { ...projectRef.current, prefs };

      // 1) Durable media: upload any local take blobs, keep gcs paths on the project.
      const hydrated = await hydrateTakesForDirector(working, (msg) =>
        setProgress({ percent: 4, status: msg })
      );
      const hydratedById = new Map(hydrated.scenes.map((s: any) => [s.id, s]));
      working = {
        ...working,
        scenes: working.scenes.map((s) => {
          const h: any = hydratedById.get(s.id);
          return h?.gcsObjectPath
            ? { ...s, gcsObjectPath: h.gcsObjectPath, mimeType: h.mimeType || s.mimeType }
            : s;
        }),
      };
      onUpdateProject((prev) => ({
        ...prev,
        scenes: prev.scenes.map((s) => {
          const h: any = hydratedById.get(s.id);
          return h?.gcsObjectPath && !s.gcsObjectPath
            ? { ...s, gcsObjectPath: h.gcsObjectPath, mimeType: h.mimeType || s.mimeType }
            : s;
        }),
      }));
      if (hydrated.errors.length) {
        setNotes([`Some takes stayed local and may be skipped: ${hydrated.errors.slice(0, 2).join('; ')}`]);
      }

      // 2) Soundtrack (best effort) when music is on and none exists yet.
      let track = working.channelSettings?.musicTrackUrl || null;
      if (prefs.music && !track) {
        setProgress({ percent: 6, status: 'Composing soundtrack…' });
        track = await generateMusic();
        if (track) {
          working = {
            ...working,
            channelSettings: { ...(working.channelSettings as ChannelSettings), musicTrackUrl: track },
          };
        }
      }

      // 3) Every AI visual in the plan (b-roll, overlays, memes, backgrounds, AI scenes) must
      //    have media before the cut is compiled — generate whatever is still missing.
      const missing = findMissingAssets(working, prefs);
      if (missing.length) {
        setProgress({ percent: 7, status: `Generating AI visuals 0/${missing.length}…` });
        const { results, failed } = await generateAssets(
          missing,
          { aspectRatio, styleBible: working.channelSettings?.styleBible || '' },
          (done, total) => setProgress({ percent: 7, status: `Generating AI visuals ${done}/${total}…` })
        );
        if (results.size) {
          working = applyAssetResults(working, results);
          onUpdateProject((prev) => applyAssetResults(prev, results));
        }
        if (failed) {
          setNotes((prev) => [
            ...prev,
            `${failed} AI visual${failed === 1 ? '' : 's'} could not be generated — exporting without ${failed === 1 ? 'it' : 'them'}.`,
          ]);
        }
      }

      // 4) Make the payload server-readable, then compile + start the render.
      setProgress({ percent: 8, status: 'Preparing media…' });
      const payload = await projectForServer(working);
      const musicPath = prefs.music && track ? await durableUrl(track, 'music') : undefined;

      setProgress({
        percent: 10,
        status:
          quality === 'draft'
            ? 'Checking word timings & directing your cut (draft)…'
            : quality === 'high'
              ? 'Checking word timings & directing your cut (1080p)…'
              : 'Checking word timings & directing your cut (720p)…',
      });
      const res = await fetch('/api/director-cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: payload,
          prefs: working.prefs,
          quality,
          startRender: true,
          options: {
            aspectRatio,
            musicEnabled: Boolean(musicPath),
            musicGcsPath: musicPath || null,
            musicVolume: working.musicVolume ?? 0.18,
          },
        }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({} as any));

      // Server re-transcribed takes with rough/missing word timings — keep them for next time.
      const wordUpdates: Record<string, Partial<Scene>> | undefined = data?.wordUpdates;
      if (wordUpdates && typeof wordUpdates === 'object') {
        onUpdateProject((prev) => ({
          ...prev,
          scenes: prev.scenes.map((s) => (wordUpdates[s.id] ? { ...s, ...wordUpdates[s.id] } : s)),
        }));
      }

      if (data?.report) {
        const r = data.report;
        const summary: DirectorCutReportSummary = {
          summary: String(r.summary || ''),
          fillersRemoved: Number(r.fillersRemoved) || 0,
          silenceRemovedSec: Number(r.silenceRemovedSec) || 0,
          punchIns: Number(r.punchIns) || 0,
          inserts: Number(r.inserts) || 0,
          insertsUnresolved: Number(r.insertsUnresolved) || 0,
          virtualBackgroundScenes: Number(r.virtualBackgroundScenes) || 0,
          captionStyle: String(r.captionStyle || prefs.captions),
          warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
          quality,
          at: Date.now(),
          prefs,
        };
        onUpdateProject((prev) => ({ ...prev, directorReport: summary }));
      }
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `Director's Cut failed (${res.status})`);
      }
      if (!data.jobId) throw new Error('Export did not start — no job id returned.');

      // 5) Poll the render job, then play the result.
      const startedAt = Date.now();
      savePendingJob({
        projectId: projectRef.current.id,
        jobId: data.jobId,
        kind: 'render',
        startedAt,
        quality,
      });
      onUpdateProject((prev) => ({
        ...prev,
        aspectRatio,
        pendingRender: { jobId: data.jobId, quality, startedAt },
      }));
      setTab(quality === 'draft' && !SHOW_DRAFT_PREVIEW ? 'source' : quality === 'draft' ? 'draft' : 'final');
      startedJobId = data.jobId;
      activeRenderPolls.add(data.jobId);
      const pollStart = startedAt;
      const job = await pollRenderJob(data.jobId, (j) => {
        if (!mountedRef.current) return;
        setProgress({
          percent: Math.max(10, j.percent || 0),
          status: describeRenderProgress(j, pollStart),
        });
      });
      if (job.status === 'error') throw new Error(job.error || 'Export failed');
      if (Array.isArray(job.warnings) && job.warnings.length) {
        onUpdateProject((prev) => {
          const prevReport = prev.directorReport;
          if (!prevReport) {
            return {
              ...prev,
              directorReport: {
                summary: 'Export completed with warnings.',
                fillersRemoved: 0,
                silenceRemovedSec: 0,
                punchIns: 0,
                inserts: 0,
                insertsUnresolved: 0,
                virtualBackgroundScenes: 0,
                captionStyle: String(prev.prefs?.captions || 'bold_pop'),
                warnings: job.warnings!.map(String),
                quality,
                at: Date.now(),
                prefs: prev.prefs,
              },
            };
          }
          const merged = Array.from(
            new Set([...(prevReport.warnings || []), ...job.warnings!.map(String)])
          );
          return { ...prev, directorReport: { ...prevReport, warnings: merged } };
        });
      }
      await finishRenderJob(data.jobId, quality, job);
    } catch (e: any) {
      console.error('[directors-cut] render failed:', e);
      if (mountedRef.current) setError(e?.message || 'Export failed');
      clearPendingJob('render', projectRef.current.id);
      onUpdateProject((prev) => ({ ...prev, pendingRender: undefined }));
    } finally {
      if (startedJobId) activeRenderPolls.delete(startedJobId);
      renderLock.current = false;
      if (mountedRef.current) setBusyQuality(null);
    }
  };

  /* ── edit with a prompt (recipe/plan mutation, then re-render) ── */
  /** Projects before each tweak, newest last — Undo pops one. */
  const historyRef = useRef<Project[]>([]);
  const kindForKey = (key: string) =>
    key.endsWith(':scene') ? ('scene' as const) : key.endsWith(':bg') ? ('background' as const) : ('insert' as const);

  const [editKey, setEditKey] = useState<string | null>(null);
  const lastEditRef = useRef<{ key: string; at: number } | null>(null);

  /**
   * Apply tweak ops from the visual editor: one undo step per burst of edits on the same item,
   * live edit updates right away, re-prompted pictures are regenerated.
   */
  const applyDirectOps = async (ops: TweakOp[], key: string) => {
    const before = projectRef.current;
    const { project: next, newVisualKeys, applied } = applyTweakOps(before, prefs, ops);
    if (!applied) return;
    const now = Date.now();
    const sameBurst = lastEditRef.current?.key === key && now - lastEditRef.current.at < 4000;
    if (!sameBurst) historyRef.current = [...historyRef.current.slice(-9), before];
    lastEditRef.current = { key, at: now };
    onUpdateProject(() => ({ ...next, renders: (next.renders || []).map((r) => ({ ...r, outdated: true })) }));
    setLiveBanner(<TweakBanner text="Edit applied." onUndo={undoTweak} onClose={() => setLiveBanner(null)} />);
    if (newVisualKeys.length) {
      setLiveBanner(<TweakBanner text="Making the new image…" onClose={() => setLiveBanner(null)} />);
      const { results } = await generateAssets(
        newVisualKeys.map((v) => ({
          key: v.key,
          sceneId: v.sceneId,
          sceneTitle: '',
          prompt: v.prompt,
          kind: kindForKey(v.key),
        })),
        { aspectRatio, styleBible: next.channelSettings?.styleBible || '' }
      );
      if (results.size) onUpdateProject((prev) => applyAssetResults(prev, results));
      setLiveBanner(
        <TweakBanner
          text={results.size ? 'New image is in.' : 'Couldn’t make that image — try another prompt.'}
          onUndo={undoTweak}
          onClose={() => setLiveBanner(null)}
        />
      );
    }
  };

  const undoTweak = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    onUpdateProject(() => prev);
    setLiveBanner(
      historyRef.current.length ? (
        <TweakBanner text="Undone." onUndo={undoTweak} onClose={() => setLiveBanner(null)} />
      ) : (
        <TweakBanner text="Undone." onClose={() => setLiveBanner(null)} />
      )
    );
  };

  const applyPrompt = async () => {
    const text = prompt.trim();
    if (!text || promptBusy || isBusy) return;
    setPromptBusy(true);
    setPromptSummary(null);
    try {
      const before = projectRef.current;
      const res = await fetch('/api/edit/tweak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: text,
          prefs,
          musicVolume: before.musicVolume ?? 0.18,
          project: {
            videoFormat: before.videoFormat,
            prefs,
            // Image data URLs are not needed to understand the cut.
            scenes: before.scenes.map((sc) => ({
              ...sc,
              aiGeneratedImageUrl: sc.aiGeneratedImageUrl?.startsWith('data:') ? undefined : sc.aiGeneratedImageUrl,
              userInsertUrl: sc.userInsertUrl?.startsWith('data:') ? undefined : sc.userInsertUrl,
            })),
          },
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `Edit failed (${res.status})`);
      const { project: next, newVisualKeys, applied } = applyTweakOps(before, prefs, data.ops || []);
      setTab('live');
      if (!applied) {
        setLiveBanner(<TweakBanner text={data.summary || 'Nothing to change.'} onClose={() => setLiveBanner(null)} />);
        setPromptSummary(data.summary || 'Nothing to change.');
        return;
      }
      historyRef.current = [...historyRef.current.slice(-9), before];
      onUpdateProject(() => ({
        ...next,
        renders: (next.renders || []).map((r) => ({ ...r, outdated: true })),
      }));
      setLiveBanner(
        <TweakBanner text={data.summary || 'Edit applied.'} onUndo={undoTweak} onClose={() => setLiveBanner(null)} />
      );
      setPromptSummary(null);
      setPrompt('');

      // New AI pictures the tweak asked for: generate them now, they drop into the live edit.
      if (newVisualKeys.length) {
        const { results } = await generateAssets(
          newVisualKeys.map((v) => ({ key: v.key, sceneId: v.sceneId, sceneTitle: '', prompt: v.prompt, kind: kindForKey(v.key) })),
          { aspectRatio, styleBible: next.channelSettings?.styleBible || '' }
        );
        if (results.size) onUpdateProject((prev) => applyAssetResults(prev, results));
      }
      // A new background is matted into the take automatically (useAutoMatte).
    } catch (e: any) {
      setPromptSummary(e?.message || 'Edit failed');
    } finally {
      setPromptBusy(false);
    }
  };

  /* ── download ── */
  const activeUrl = tab === 'final' ? masterUrl : tab === 'draft' ? draftUrl : null;
  const download = () => {
    const url = tab === 'draft' ? draftUrl : masterUrl || draftUrl;
    if (!url) return;
    const a = document.createElement('a');
    a.href = url.includes('inline=1') ? url.replace('inline=1', 'inline=0') : url;
    a.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-takeone-${
      tab === 'draft' ? 'draft' : 'master'
    }.mp4`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };
  const canDownload = Boolean(tab === 'draft' ? draftUrl : masterUrl || draftUrl);

  /* ── UI ── */
  const chip = (active: boolean, disabled = false) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
    } ${
      active
        ? 'bg-[#E8F0FE] text-[#1A73E8] border-[#1A73E8]'
        : 'bg-white text-[#5F6368] border-[#DADCE0] hover:bg-[#F8F9FA]'
    }`;

  const tabBtn = (
    id: PlayerTab,
    label: string,
    opts: { hasMedia: boolean; rendering?: boolean }
  ) => {
    const locked = Boolean(opts.rendering);
    const canSelect = opts.hasMedia || locked || id === 'source';
    return (
      <button
        key={id}
        type="button"
        onClick={() => {
          if (locked || !canSelect) return;
          setTab(id);
        }}
        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
          tab === id ? 'bg-white text-[#1A73E8] shadow-sm' : 'text-[#5F6368]'
        } ${
          locked
            ? 'opacity-55 pointer-events-none'
            : canSelect
              ? 'cursor-pointer'
              : 'opacity-40 cursor-not-allowed'
        }`}
      >
        {label}
        {locked ? ' · Exporting…' : ''}
      </button>
    );
  };

  const playerStyle: React.CSSProperties = {
    aspectRatio: aspectRatio === '16:9' ? '16 / 9' : '9 / 16',
    maxHeight: aspectRatio === '16:9' ? undefined : '68vh',
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 md:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-bold text-[#1A73E8]">
            <Clapperboard className="w-4 h-4" />
            Director&apos;s Cut
          </div>
          <h1 className="text-xl md:text-2xl font-extrabold text-[#202124] truncate">
            {project.title}
          </h1>
          <p className="text-xs text-[#5F6368] mt-0.5">
            {project.scenes.length} scenes · ~{formatDuration(project.estimatedTotalSeconds || 0)} · {aspectRatio}
          </p>
        </div>
        <button
          type="button"
          onClick={onBackToShooting}
          className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-xl border border-[#DADCE0] bg-white text-xs font-semibold text-[#5F6368] hover:bg-[#F8F9FA] cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to shoot
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
        {/* ───────── Left: player, render, report ───────── */}
        <div className="space-y-5 min-w-0">
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="inline-flex bg-[#F1F3F4] rounded-xl p-1">
                {tabBtn('live', 'Live edit', { hasMedia: sources.length > 0 })}
                {tabBtn('source', 'Source', { hasMedia: sources.length > 0 })}
                {SHOW_DRAFT_PREVIEW &&
                  tabBtn(
                    'draft',
                    `Draft${
                      (project.renders || []).some((r) => r.kind === 'draft' && r.outdated)
                        ? ' · Out of date'
                        : busyQuality === 'draft' && draftUrl
                          ? ' · Updating'
                          : ''
                    }`,
                    { hasMedia: Boolean(draftUrl), rendering: busyQuality === 'draft' }
                  )}
                {tabBtn(
                  'final',
                  `Final${
                    (project.renders || []).some((r) => r.kind === 'final' && r.outdated)
                      ? ' · Out of date'
                      : busyQuality && busyQuality !== 'draft' && masterUrl
                        ? ' · Updating'
                        : ''
                  }`,
                  {
                    hasMedia: Boolean(masterUrl),
                    rendering: Boolean(busyQuality && busyQuality !== 'draft'),
                  }
                )}
              </div>
              <button
                type="button"
                onClick={download}
                disabled={!canDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-[#DADCE0] text-[#1A73E8] bg-white hover:bg-[#E8F0FE] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            </div>

            <div className="mb-3 empty:hidden">
              <ApplyBackgroundCard
                project={project}
                aspectRatio={aspectRatio}
                onUpdateProject={onUpdateProject}
                disabled={isBusy}
              />
            </div>

            {tab === 'live' ? (
              <>
                <LiveCutPlayer
                  edl={liveEdl}
                  updating={liveUpdating}
                  aspectRatio={aspectRatio}
                  musicUrl={prefs.music ? musicPreviewUrl : null}
                  musicVolume={project.musicVolume ?? 0.18}
                  banner={liveBanner}
                  onSelect={(key) => setEditKey(key)}
                  selectedKey={editKey}
                />
                {editKey && (
                  <div className="mt-3">
                    <VisualEditor
                      project={project}
                      editKey={editKey}
                      onApply={(ops) => void applyDirectOps(ops, editKey)}
                      onRegenerate={(op) => void applyDirectOps([op], `${editKey}:prompt:${Date.now()}`)}
                      onClose={() => setEditKey(null)}
                    />
                  </div>
                )}
                <p className="mt-2 text-xs text-[#5F6368] text-center">
                  {liveError
                    ? `Couldn’t update the live edit: ${liveError}`
                    : 'Live edit — every change shows here right away. Export makes the final file.'}
                </p>
              </>
            ) : (
            <div
              className="mx-auto w-full max-w-full bg-[#121212] rounded-xl overflow-hidden flex items-center justify-center"
              style={{ ...playerStyle, maxWidth: aspectRatio === '16:9' ? '100%' : '380px' }}
            >
              {tab === 'source' ? (
                activeSource ? (
                  <video
                    key={activeSource.url}
                    // #t=0.1 makes the browser paint the first frame instead of an empty black box.
                    src={`${activeSource.url}#t=0.1`}
                    preload="metadata"
                    controls
                    playsInline
                    autoPlay={sourceIdx > 0}
                    onEnded={() => setSourceIdx((i) => (i + 1 < sources.length ? i + 1 : i))}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 px-6 text-center">
                    <Camera className="w-7 h-7 text-white/40" />
                    <p className="text-sm text-white/80 font-semibold">No takes yet</p>
                    <p className="text-xs text-white/55 max-w-[22ch]">Film or import your takes, then come back to cut them.</p>
                    <button
                      type="button"
                      onClick={onBackToShooting}
                      className="mt-1 px-4 py-2 rounded-lg bg-white text-[#202124] text-sm font-bold hover:bg-white/90 active:scale-[0.97] transition cursor-pointer"
                    >
                      Go to shoot
                    </button>
                  </div>
                )
              ) : activeUrl ? (
                <div className="relative w-full h-full">
                  <video
                    key={activeUrl}
                    src={activeUrl}
                    controls
                    playsInline
                    className="w-full h-full object-contain"
                  />
                  {isBusy &&
                    ((tab === 'draft' && busyQuality === 'draft') ||
                      (tab === 'final' && busyQuality && busyQuality !== 'draft')) && (
                      <div className="absolute top-2 left-2 right-2 flex justify-center pointer-events-none">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 text-white text-xs font-bold">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Updating…
                        </span>
                      </div>
                    )}
                </div>
              ) : isBusy &&
                ((tab === 'draft' && busyQuality === 'draft') ||
                  (tab === 'final' && busyQuality && busyQuality !== 'draft')) ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                  <Loader2 className="w-6 h-6 text-white animate-spin" />
                  <p className="text-sm text-white/80 font-semibold">{progress.status || 'Exporting…'}</p>
                  <p className="text-xs text-white/50">{Math.round(progress.percent)}%</p>
                </div>
              ) : (
                <div className="relative w-full h-full flex items-center justify-center">
                  {/* Before the first export, show your first take dimmed rather than an empty frame. */}
                  {sources[0] && (
                    <video
                      src={`${sources[0].url}#t=0.5`}
                      preload="metadata"
                      muted
                      playsInline
                      aria-hidden
                      className="absolute inset-0 w-full h-full object-cover opacity-35"
                    />
                  )}
                  <div className="relative flex flex-col items-center gap-2 px-6 text-center">
                    <Clapperboard className="w-7 h-7 text-white/70" />
                    <p className="text-sm text-white font-semibold">
                      {tab === 'draft' && SHOW_DRAFT_PREVIEW ? 'Hit Preview for a fast draft' : 'Your cut appears here'}
                    </p>
                    <p className="text-xs text-white/70 max-w-[24ch]">
                      Export below and I&apos;ll cut, caption and mix it.
                    </p>
                  </div>
                </div>
              )}
            </div>
            )}

            {tab === 'source' && sources.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
                {sources.map((s, i) => (
                  <button
                    key={s.scene.id}
                    type="button"
                    onClick={() => setSourceIdx(i)}
                    className={chip(i === sourceIdx)}
                  >
                    {s.scene.sceneNumber}. {s.scene.title.length > 18 ? `${s.scene.title.slice(0, 17)}…` : s.scene.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Render actions */}
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[#5F6368]">Export quality</p>
              <div className="inline-flex bg-[#F1F3F4] rounded-lg p-0.5">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setExportTier('standard')}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold cursor-pointer ${
                    exportTier === 'standard' ? 'bg-white text-[#202124] shadow-sm' : 'text-[#5F6368]'
                  }`}
                >
                  Standard 720p
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setExportTier('high')}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold cursor-pointer ${
                    exportTier === 'high' ? 'bg-white text-[#202124] shadow-sm' : 'text-[#5F6368]'
                  }`}
                >
                  High 1080p
                </button>
              </div>
            </div>
            <p className="text-xs text-[#80868B] -mt-1">
              {exportTier === 'high'
                ? 'High takes ~2–3× longer on Cloud Run but looks sharp.'
                : 'Standard is faster; good for most shares.'}
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              {SHOW_DRAFT_PREVIEW && (
                <button
                  type="button"
                  onClick={() => runRender('draft')}
                  disabled={isBusy}
                  className="flex-1 flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl font-bold bg-[#1A73E8] text-white hover:bg-[#1557B0] disabled:opacity-60 disabled:cursor-not-allowed shadow-sm active:scale-[0.99] transition text-sm cursor-pointer"
                >
                  {busyQuality === 'draft' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  {busyQuality === 'draft' ? 'Rendering preview…' : 'Preview (fast)'}
                </button>
              )}
              <button
                type="button"
                onClick={() => runRender(exportTier)}
                disabled={isBusy}
                className={`${
                  SHOW_DRAFT_PREVIEW ? 'sm:w-44' : 'flex-1'
                } flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl font-bold disabled:opacity-60 disabled:cursor-not-allowed text-sm cursor-pointer active:scale-[0.99] transition ${
                  SHOW_DRAFT_PREVIEW
                    ? 'bg-white text-[#1A73E8] border border-[#1A73E8] hover:bg-[#E8F0FE]'
                    : 'bg-[#1A73E8] text-white hover:bg-[#1557B0] shadow-sm'
                }`}
              >
                {busyQuality === 'standard' || busyQuality === 'high' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  !SHOW_DRAFT_PREVIEW && <Sparkles className="w-4 h-4" />
                )}
                {busyQuality === 'standard' || busyQuality === 'high'
                  ? 'Exporting…'
                  : `Export ${exportTier === 'high' ? '1080p' : '720p'}`}
              </button>
            </div>

            {isBusy && (
              <div className="space-y-1.5 rounded-xl border border-[#D2E3FC] bg-[#F8FBFF] px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[#174EA6] truncate">
                    {progress.status || 'Exporting…'}
                  </p>
                  <span className="text-xs font-bold tabular-nums text-[#1A73E8] shrink-0">
                    {Math.round(progress.percent)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[#E8F0FE] overflow-hidden">
                  <div
                    className="h-full bg-[#1A73E8] transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.min(100, Math.max(3, progress.percent))}%` }}
                  />
                </div>
                <p className="text-xs text-[#5F6368]">
                  {SHOW_DRAFT_PREVIEW
                    ? 'Draft/Final stay available while this runs — you can leave Master and come back.'
                    : 'You can leave Master and come back — progress keeps running.'}
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-xl bg-[#FCE8E6] border border-[#F5C6C2] text-[#C5221F] text-xs p-3">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}
            {notes.map((n) => (
              <p key={n} className="text-xs text-[#B06000]">
                {n}
              </p>
            ))}
          </div>

          {/* What I did */}
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-sm font-extrabold text-[#202124] flex items-center gap-2">
                <Scissors className="w-4 h-4 text-[#1A73E8]" />
                What I did
              </h2>
              {report?.quality && (
                <span className="text-xs font-bold text-[#5F6368] bg-[#F1F3F4] rounded-full px-2 py-0.5">
                  {report.quality}
                </span>
              )}
            </div>
            {report ? (
              <div className="space-y-3">
                <p className="text-sm text-[#3C4043] leading-relaxed">{report.summary}</p>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {[
                    ['Fillers cut', String(report.fillersRemoved)],
                    ['Dead air', `${report.silenceRemovedSec.toFixed(1)}s`],
                    ['Punch-ins', String(report.punchIns)],
                    ['Inserts', String(report.inserts)],
                    ['Backgrounds', String(report.virtualBackgroundScenes)],
                    ['Captions', report.captionStyle.replace('_', ' ')],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-[#F8F9FA] border border-[#E8EAED] px-2 py-2 text-center">
                      <div className="text-sm font-extrabold text-[#202124] capitalize">{value}</div>
                      <div className="text-xs text-[#5F6368]">{label}</div>
                    </div>
                  ))}
                </div>
                {prefsChangedSinceRender && (
                  <p className="text-xs text-[#B06000] bg-[#FEF7E0] border border-[#FEEFC3] rounded-lg px-3 py-2">
                    Settings changed since this render — hit Render to apply them.
                  </p>
                )}
                {(report.insertsUnresolved || 0) > 0 && (
                  <p className="text-xs text-[#5F6368]">
                    {report.insertsUnresolved} insert{report.insertsUnresolved === 1 ? '' : 's'} had no media yet — generate
                    b-roll on the right, then render again.
                  </p>
                )}
                {(report.warnings?.length || 0) > 0 && (
                  <ul className="text-xs text-[#5F6368] list-disc pl-4 space-y-0.5">
                    {report.warnings!.slice(0, 4).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-sm text-[#5F6368]">
                Hit <b>Export</b> and I&apos;ll cut fillers and dead air, punch in on key lines, add captions and
                inserts, then tell you exactly what changed.
              </p>
            )}
          </div>

          {/* Takes: retake / regenerate */}
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm">
            <h2 className="text-sm font-extrabold text-[#202124] mb-2">Scenes</h2>
            <div className="divide-y divide-[#F1F3F4]">
              {project.scenes.map((s) => {
                const has = sceneHasMedia(s);
                return (
                  <div key={s.id} className="flex items-center gap-3 py-2">
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                        has ? 'bg-[#E6F4EA] text-[#137333]' : 'bg-[#F1F3F4] text-[#9AA0A6]'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-[#202124] truncate">
                        {s.sceneNumber}. {s.title}
                      </div>
                      <div className="text-xs text-[#5F6368]">
                        {s.filmedBy === 'user' ? 'Your take' : 'AI cutaway'} · {formatDuration(s.durationSeconds)}
                      </div>
                    </div>
                    {s.filmedBy === 'user' ? (
                      <button
                        type="button"
                        onClick={() => onRetakeScene(s.id)}
                        className="flex items-center gap-1 text-xs font-bold text-[#1A73E8] hover:underline cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5" />
                        Retake
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRegenerateAiScene(s.id)}
                        className="flex items-center gap-1 text-xs font-bold text-[#1A73E8] hover:underline cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {has ? 'Regenerate' : 'Generate'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ───────── Right: prefs, assets, prompt ───────── */}
        <div className="space-y-5 min-w-0">
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-4" data-testid="prefs-panel">
            <h2 className="text-sm font-extrabold text-[#202124]">Your preferences</h2>

            <div className="space-y-2">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm text-[#3C4043]">Cut dead air &amp; silences</span>
                <input
                  type="checkbox"
                  checked={prefs.cleanup.silences}
                  onChange={(e) =>
                    updatePrefs({ ...prefs, cleanup: { ...prefs.cleanup, silences: e.target.checked } })
                  }
                  className="w-4 h-4 accent-[#1A73E8]"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm text-[#3C4043]">Remove filler words (um, uh…)</span>
                <input
                  type="checkbox"
                  checked={prefs.cleanup.fillers}
                  onChange={(e) =>
                    updatePrefs({ ...prefs, cleanup: { ...prefs.cleanup, fillers: e.target.checked } })
                  }
                  className="w-4 h-4 accent-[#1A73E8]"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm text-[#3C4043] flex items-center gap-1.5">
                  <Music className="w-3.5 h-3.5 text-[#5F6368]" />
                  Background music
                </span>
                <input
                  type="checkbox"
                  checked={prefs.music}
                  onChange={(e) => updatePrefs({ ...prefs, music: e.target.checked })}
                  className="w-4 h-4 accent-[#1A73E8]"
                />
              </label>
              {prefs.music && (
                <div className="pl-5 space-y-2.5">
                  <div className="flex flex-wrap gap-1">
                    {MUSIC_MOODS.map((mood) => (
                      <button
                        key={mood}
                        type="button"
                        onClick={() =>
                          onUpdateProject((prev) => ({
                            ...prev,
                            musicMood: mood,
                            renders: (prev.renders || []).map((r) => ({ ...r, outdated: true })),
                          }))
                        }
                        className={chip(project.musicMood === mood, musicBusy || isBusy)}
                      >
                        {mood}
                      </button>
                    ))}
                  </div>
                  {musicTrack ? (
                    <audio
                      key={musicPreviewUrl || ''}
                      controls
                      src={musicPreviewUrl || undefined}
                      className="w-full h-8"
                      preload="metadata"
                    />
                  ) : (
                    <p className="text-xs text-[#5F6368]">
                      Generate a soundtrack to preview it here.
                    </p>
                  )}
                  <label className="block">
                    <span className="text-xs font-semibold text-[#5F6368]">
                      Volume {Math.round((project.musicVolume ?? 0.18) * 100)}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={40}
                      step={1}
                      value={Math.round((project.musicVolume ?? 0.18) * 100)}
                      onChange={(e) =>
                        onUpdateProject((prev) => ({
                          ...prev,
                          musicVolume: Number(e.target.value) / 100,
                          renders: (prev.renders || []).map((r) => ({ ...r, outdated: true })),
                        }))
                      }
                      className="w-full accent-[#1A73E8]"
                    />
                  </label>
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => void generateMusic()}
                      disabled={musicBusy || isBusy}
                      className="text-xs font-bold text-[#1A73E8] hover:underline disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      {musicBusy ? 'Composing…' : musicTrack ? 'Regenerate' : 'Generate soundtrack'}
                    </button>
                    <p className="text-xs text-[#5F6368]">
                      {musicStatus ||
                        (musicTrack ? 'Preview above. Export again to mix it into the cut.' : 'Auto-generated on export if missing.')}
                    </p>
                  </div>
                  {(project.renders || []).some((r) => r.outdated) && (
                    <p className="text-xs font-semibold text-[#E37400]">
                      Music changed — export again to update the cut
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-bold text-[#5F6368] mb-1.5">Captions</div>
              <select
                value={prefs.captions}
                onChange={(e) =>
                  updatePrefs({ ...prefs, captions: e.target.value as ProductionPrefs['captions'] })
                }
                className="w-full rounded-xl border border-[#DADCE0] bg-white px-3 py-2 text-sm text-[#202124] focus:outline-none focus:border-[#1A73E8]"
              >
                {CAPTION_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-bold text-[#5F6368] mb-1.5">Looks</div>
              <div className="grid grid-cols-2 gap-1.5">
                {LOOK_OPTIONS.map((o) => {
                  const on = prefs.looks.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleLook(o.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border text-left transition-colors cursor-pointer ${
                        on
                          ? 'bg-[#E8F0FE] text-[#1A73E8] border-[#1A73E8]'
                          : 'bg-white text-[#3C4043] border-[#DADCE0] hover:bg-[#F8F9FA]'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                          on ? 'bg-[#1A73E8] border-[#1A73E8]' : 'border-[#BDC1C6]'
                        }`}
                      >
                        {on && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </span>
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <AiVisualsPanel
            project={project}
            prefs={prefs}
            aspectRatio={aspectRatio}
            onUpdateProject={onUpdateProject}
            disabled={isBusy}
            onEnsureLook={(look) => {
              if (!prefs.looks.includes(look)) updatePrefs({ ...prefs, looks: [...prefs.looks, look] });
            }}
          />

          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-2">
            <h2 className="text-sm font-extrabold text-[#202124] flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-[#1A73E8]" />
              Tweak with a prompt
            </h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyPrompt();
                }}
                placeholder="e.g. bring back the last lines, cut the first 3 seconds, add a text pop on the price"
                disabled={promptBusy || isBusy}
                className="min-w-0 flex-1 rounded-xl border border-[#DADCE0] px-3 py-2 text-sm focus:outline-none focus:border-[#1A73E8]"
              />
              <button
                type="button"
                onClick={applyPrompt}
                disabled={!prompt.trim() || promptBusy || isBusy}
                className="shrink-0 px-3.5 py-2 rounded-xl bg-[#202124] text-white text-xs font-bold disabled:opacity-50 cursor-pointer"
              >
                {promptBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
              </button>
            </div>
            {promptSummary && <p className="text-xs text-[#5F6368]">{promptSummary}</p>}
            <p className="text-xs text-[#80868B] leading-relaxed">
              Try: “make the second overlay last 5 seconds” · “move the text pop earlier” · “bring back the
              last lines” · “captions at the top, bigger” · “put the coffee take first” · “switch to 16:9”.
              Or tap any visual under the Live edit to change it directly.
            </p>
          </div>

          {(project.renders || []).filter((r) => SHOW_DRAFT_PREVIEW || r.kind !== 'draft').length >
            0 && (
            <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-2">
              <h2 className="text-sm font-extrabold text-[#202124]">Renders</h2>
              <ul className="space-y-1.5">
                {[...(project.renders || [])]
                  .filter((r) => SHOW_DRAFT_PREVIEW || r.kind !== 'draft')
                  .slice()
                  .reverse()
                  .map((r) => (
                  <li
                    key={r.jobId}
                    className="flex items-center justify-between gap-2 text-xs text-[#3C4043]"
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        const url = await resolveMasterPlayUrl(r.jobId);
                        if (r.kind === 'draft' && SHOW_DRAFT_PREVIEW) {
                          setDraftUrl(url);
                          setTab('draft');
                        } else {
                          setMasterUrl(url);
                          setTab('final');
                        }
                      }}
                      className="min-w-0 text-left truncate hover:underline cursor-pointer"
                    >
                      {r.kind === 'draft' ? 'Draft' : 'Final'} · {r.quality}
                      {r.durationSec ? ` · ${r.durationSec.toFixed(1)}s` : ''}
                      {r.outdated ? ' · Out of date' : ''}
                    </button>
                    {deleteId === r.jobId ? (
                      <span className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await deleteRenderJob(r.jobId);
                              onUpdateProject((prev) => {
                                const renders = (prev.renders || []).filter((x) => x.jobId !== r.jobId);
                                const nextFinal = [...renders].reverse().find((x) => x.kind === 'final');
                                return {
                                  ...prev,
                                  renders,
                                  masterVideoUrl: nextFinal ? prev.masterVideoUrl : undefined,
                                };
                              });
                              if (r.kind === 'draft') setDraftUrl(null);
                              else setMasterUrl(null);
                            } catch (e: any) {
                              setError(e?.message || 'Delete failed');
                            } finally {
                              setDeleteId(null);
                            }
                          }}
                          className="px-2 py-1 rounded-lg bg-[#C5221F] text-white font-bold cursor-pointer"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteId(null)}
                          className="px-2 py-1 rounded-lg border border-[#DADCE0] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteId(r.jobId)}
                        className="p-1 rounded-lg text-[#5F6368] hover:text-[#C5221F] hover:bg-[#FCE8E6] cursor-pointer"
                        title="Delete from storage"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
