import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Film,
  Loader2,
  Monitor,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  FactCheckedClaim,
  Project,
  ProductionPrefs,
  Scene,
  SceneRecipe,
  formatDuration,
} from '../types/director';
import { inferVideoMime, kickProxyBuild, persistTakeBlob } from '../utils/renderClient';
import { mediaUrlFromGcs, saveTakeMedia } from '../utils/mediaVault';
import { TakeTrimEditor } from './TakeTrimEditor';

interface ImportFootageViewProps {
  onProjectReady: (project: Project) => void;
  onCancel: () => void;
}

type KeepRange = { start: number; end: number };
type Word = { w: string; start: number; end: number; conf?: number };

type ImportRow = {
  id: string;
  sceneId: string;
  file: File;
  localUrl: string;
  status: 'queued' | 'uploading' | 'transcribing' | 'factchecking' | 'done' | 'error';
  message?: string;
  gcsUri?: string;
  mimeType?: string;
  duration?: number;
  orientation?: 'portrait' | 'landscape';
  transcript?: string;
  transcriptSegments?: Array<{ start: number; end: number; text: string }>;
  words?: Word[];
  claims?: FactCheckedClaim[];
  inPoint?: number;
  outPoint?: number;
  keepRanges?: KeepRange[];
  trimLocked?: boolean;
};

/** Languages offered for speech recognition. "auto" lets Chirp detect it (handles Hindi + Indian English). */
const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi / Hinglish' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'ja', label: 'Japanese' },
];

const LOOKS: Array<{ id: ProductionPrefs['looks'][number]; label: string; hint: string }> = [
  { id: 'broll', label: 'B-roll', hint: 'Full-screen AI pictures between your lines' },
  { id: 'overlays', label: 'Overlays', hint: 'AI pictures beside you while you talk' },
  { id: 'memes', label: 'Memes', hint: 'A reaction image on the funny moment' },
  { id: 'text_pops', label: 'Text pops', hint: 'Big words on your key points' },
];

const CAPTIONS: Array<{ id: ProductionPrefs['captions']; label: string }> = [
  { id: 'bold_pop', label: 'Bold pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'clean', label: 'Clean' },
  { id: 'off', label: 'Off' },
];

async function probeVideo(url: string): Promise<{ duration: number; orientation?: 'portrait' | 'landscape' }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 5;
      resolve({
        duration: Math.max(1, d),
        orientation: v.videoWidth && v.videoHeight ? (v.videoHeight >= v.videoWidth ? 'portrait' : 'landscape') : undefined,
      });
    };
    v.onerror = () => resolve({ duration: 5 });
    v.src = url;
  });
}

/** Words inside the kept part of a clip, joined — what the planner should anchor visuals to. */
function keptTranscript(row: ImportRow): string {
  const words = row.words || [];
  if (!words.length) return row.transcript || '';
  const ranges: KeepRange[] =
    row.keepRanges?.length
      ? row.keepRanges
      : typeof row.inPoint === 'number' && typeof row.outPoint === 'number'
        ? [{ start: row.inPoint, end: row.outPoint }]
        : [];
  if (!ranges.length) return row.transcript || words.map((w) => w.w).join(' ');
  return words
    .filter((w) => ranges.some((r) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 <= r.end))
    .map((w) => w.w)
    .join(' ');
}

export const ImportFootageView: React.FC<ImportFootageViewProps> = ({ onProjectReady, onCancel }) => {
  const projectId = useMemo(() => `proj-import-${Date.now()}`, []);
  const [goal, setGoal] = useState('');
  const [request, setRequest] = useState('');
  const [language, setLanguage] = useState('auto');
  const [format, setFormat] = useState<'9:16' | '16:9' | null>(null);
  const [prefs, setPrefs] = useState<ProductionPrefs>({
    shots: 'one_take',
    looks: ['talking_head', 'text_pops'],
    captions: 'bold_pop',
    cleanup: { silences: true, fillers: true },
    music: true,
  });
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowsRef = useRef<ImportRow[]>([]);
  rowsRef.current = rows;
  const processing = useRef(false);

  const updateRow = (id: string, patch: Partial<ImportRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const busyUploading = rows.some((r) => r.status !== 'done' && r.status !== 'error');
  const languageLocked = rows.some((r) => r.status !== 'queued');
  const ready = rows.length > 0 && rows.every((r) => r.status === 'done' || r.status === 'error') && rows.some((r) => r.status === 'done');
  const effectiveFormat = format || (rows.find((r) => r.orientation)?.orientation === 'landscape' ? '16:9' : '9:16');

  // A server trim-extract replaces the clip file: point the row at the new file and drop the old
  // word timings (Export re-transcribes it).
  useEffect(() => {
    const onExtracted = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const row = rowsRef.current.find((r) => r.sceneId === d?.sceneId);
      if (!row || !d?.gcsObjectPath) return;
      updateRow(row.id, {
        gcsUri: d.gcsObjectPath,
        duration: d.durationSeconds || row.duration,
        localUrl: mediaUrlFromGcs(d.gcsObjectPath) || row.localUrl,
        inPoint: 0,
        outPoint: d.durationSeconds,
        keepRanges: undefined,
        trimLocked: true,
        words: undefined,
      });
    };
    window.addEventListener('takeone:trim-extracted', onExtracted);
    return () => window.removeEventListener('takeone:trim-extracted', onExtracted);
  }, []);

  /** Upload → transcribe → fact-check each queued clip, one at a time, as soon as it is added. */
  const processQueue = async () => {
    if (processing.current) return;
    processing.current = true;
    try {
      for (;;) {
        const row = rowsRef.current.find((r) => r.status === 'queued');
        if (!row) break;
        try {
          updateRow(row.id, { status: 'uploading', message: 'Uploading…' });
          const mime = inferVideoMime(row.file, row.file.name);
          const probe = await probeVideo(row.localUrl);
          const liveUrl = await saveTakeMedia(projectId, row.sceneId, row.file, mime);
          const persisted = await persistTakeBlob(row.file, projectId, row.sceneId, mime);
          updateRow(row.id, {
            gcsUri: persisted.gcsUri,
            mimeType: persisted.mimeType,
            duration: probe.duration,
            orientation: probe.orientation,
            localUrl: liveUrl || row.localUrl,
            status: 'transcribing',
            message: 'Listening to what you said…',
          });
          kickProxyBuild({ gcsObjectPath: persisted.gcsUri, projectId, sceneId: row.sceneId, durationSec: probe.duration });

          let transcript = '';
          let transcriptSegments: ImportRow['transcriptSegments'] = [];
          let words: Word[] = [];
          try {
            const txRes = await fetch('/api/transcribe-gcs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                gcsUri: persisted.gcsUri,
                mimeType: persisted.mimeType,
                durationSec: probe.duration,
                ...(language !== 'auto' ? { languageCode: language } : {}),
              }),
            });
            const tx = await txRes.json();
            transcript = tx.transcript || tx.fullTranscript || '';
            transcriptSegments = tx.segments || tx.transcriptSegments || [];
            words = Array.isArray(tx.words) ? tx.words : [];
          } catch {
            /* the export step re-transcribes takes without words */
          }

          let claims: FactCheckedClaim[] = [];
          if (transcript.trim()) {
            updateRow(row.id, { status: 'factchecking', message: 'Checking facts…', transcript, transcriptSegments, words });
            try {
              const fcRes = await fetch('/api/fact-check-claims', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ segments: transcriptSegments, fullTranscript: transcript, projectTitle: goal }),
              });
              claims = (await fcRes.json()).claims || [];
            } catch {
              claims = [];
            }
          }
          updateRow(row.id, {
            transcript,
            transcriptSegments,
            words,
            claims,
            status: 'done',
            message: transcript ? 'Ready' : 'Ready — no speech found (fine for visual footage)',
          });
        } catch (err: any) {
          console.warn('[import] clip failed', err);
          updateRow(row.id, {
            status: 'error',
            message: 'Couldn’t upload this clip. Remove it and try again — check your connection if it keeps failing.',
          });
        }
      }
    } finally {
      processing.current = false;
    }
  };

  const onPickFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const next: ImportRow[] = Array.from(files)
      .filter((f) => f.type.startsWith('video/') || f.type.startsWith('audio/'))
      .map((file, i) => ({
        id: `import-${Date.now()}-${i}`,
        sceneId: `scene-import-${Date.now()}-${i}`,
        file,
        localUrl: URL.createObjectURL(file),
        status: 'queued' as const,
      }));
    if (!next.length) return;
    rowsRef.current = [...rowsRef.current, ...next];
    setRows(rowsRef.current);
    void processQueue();
  };

  const toggleLook = (look: ProductionPrefs['looks'][number]) => {
    const has = prefs.looks.includes(look);
    const looks = has ? prefs.looks.filter((l) => l !== look) : [...prefs.looks, look];
    setPrefs({ ...prefs, looks: looks.length ? looks : ['talking_head'] });
  };

  const planEdit = async () => {
    const done = rows.filter((r) => r.status === 'done' && r.gcsUri);
    if (!done.length) return;
    setPlanning(true);
    setError(null);
    try {
      const keptSeconds = (r: ImportRow) =>
        r.keepRanges?.length
          ? r.keepRanges.reduce((a, k) => a + (k.end - k.start), 0)
          : typeof r.inPoint === 'number' && typeof r.outPoint === 'number'
            ? r.outPoint - r.inPoint
            : r.duration || 5;
      const total = done.reduce((a, r) => a + keptSeconds(r), 0);
      const videoFormat = total > 180 ? 'long-form' : 'short-form';

      let plan: any = null;
      try {
        const res = await fetch('/api/plan-import-edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            goal,
            request,
            prefs,
            format: videoFormat,
            language: language === 'auto' ? undefined : language,
            clips: done.map((r) => ({
              sceneId: r.sceneId,
              title: r.file.name.replace(/\.[^.]+$/, ''),
              durationSeconds: keptSeconds(r),
              transcript: keptTranscript(r),
            })),
          }),
        });
        plan = await res.json();
        if (!res.ok || !plan?.ok) throw new Error(plan?.error || 'Planning failed');
      } catch (err: any) {
        // The cut still works without a plan — it just has no AI visuals yet.
        console.warn('[import] plan failed, continuing without visuals', err);
        plan = null;
      }
      const planned = new Map<string, { title: string; recipe: SceneRecipe }>(
        (plan?.scenes || []).map((s: any) => [s.sceneId, { title: s.title, recipe: s.recipe }])
      );

      const scenes: Scene[] = done.map((r, i) => {
        const p = planned.get(r.sceneId);
        const transcript = r.transcript || '';
        return {
          id: r.sceneId,
          sceneNumber: i + 1,
          title: p?.title || r.file.name.replace(/\.[^.]+$/, '') || `Clip ${i + 1}`,
          filmedBy: 'user',
          durationSeconds: Math.round(r.duration || 5),
          recordedDuration: r.duration,
          plainInstruction: 'Your own footage — trim it here or in Master Cut.',
          directorTip: '',
          contentMode: transcript ? 'dialogue' : 'visual_only',
          editIntent: i === 0 ? 'hook' : i === done.length - 1 ? 'cta' : 'context',
          userRecordedVideoUrl: r.localUrl || undefined,
          gcsObjectPath: r.gcsUri,
          mimeType: r.mimeType,
          transcript: transcript || undefined,
          transcriptSegments: r.transcriptSegments?.length ? r.transcriptSegments : undefined,
          words: r.words?.length ? r.words : undefined,
          wordsSource: r.words?.length ? 'stt' : undefined,
          // What was said, so AI visuals and text pops can be anchored to it (no teleprompter).
          dialogue: { required: false, teleprompterText: transcript || null },
          factCheckClaims: r.claims?.length ? r.claims : undefined,
          inPoint: r.inPoint,
          outPoint: r.outPoint,
          keepRanges: r.keepRanges,
          userTrimLocked: r.trimLocked,
          recipe: p?.recipe,
          mediaSource: 'imported',
          includeInExport: true,
          captureStatus: 'upload',
        } as Scene;
      });

      const spoken = language === 'auto' ? undefined : language;
      const project: Project = {
        id: projectId,
        title: plan?.title || goal.trim().slice(0, 60) || 'My video',
        logline: plan?.logline || goal.trim() || `Edited from ${scenes.length} clip(s) of your own footage`,
        estimatedTotalSeconds: Math.round(total) || 45,
        musicMood: plan?.musicMood || 'Warm Acoustic',
        scenes,
        createdAt: Date.now(),
        videoFormat,
        aspectRatio: effectiveFormat,
        entryPath: 'import',
        prefs,
        ...(spoken ? { spokenLanguage: spoken } : {}),
        channelSettings: {
          channelName: 'My Channel',
          showWatermark: false,
          watermarkPosition: 'top-right',
          watermarkOpacity: 0.7,
          entryMusicEnabled: false,
          entryMusicStyle: 'signature-chime',
          noiseRemovalEnabled: true,
          captionsEnabled: prefs.captions !== 'off',
          captionStyle: 'modern-white',
          currentLanguage: spoken || 'en',
          youtubeIntroEnabled: false,
          introMode: 'off',
          youtubeOutroEnabled: false,
          aiEditingPreset: 'viral-creator',
        },
      } as Project;
      onProjectReady(project);
    } catch (err: any) {
      setError(err?.message || 'Could not build the project');
    } finally {
      setPlanning(false);
    }
  };

  const disputed = rows.flatMap((r) => r.claims || []).filter((c) => c.verdict === 'disputed');
  const chip = (on: boolean) =>
    `px-3.5 py-2 rounded-xl text-sm font-semibold transition-colors cursor-pointer active:scale-[0.98] ${
      on ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-[#F1F3F4] text-[#3C4043] hover:bg-[#E8EAED]'
    }`;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 pb-28 md:pb-12 space-y-10">
      <header className="space-y-3">
        <h1 className="text-3xl md:text-5xl font-extrabold tracking-[-0.03em] leading-[1.05] text-[#202124] font-['Plus_Jakarta_Sans',sans-serif] [text-wrap:balance]">
          Edit footage you already shot.
        </h1>
        <p className="text-base md:text-lg text-[#3C4043] leading-relaxed max-w-[56ch]">
          Tell TakeOne what the video is for, drop your clips and trim them. It plans the cut, the captions and
          any AI visuals — you can change every one before exporting.
        </p>
      </header>

      {/* 1. Context */}
      <section aria-labelledby="ctx" className="space-y-5">
        <h2 id="ctx" className="text-xl font-bold text-[#202124]">
          What’s this video?
        </h2>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-[#3C4043]">What is it about, and who is it for?</span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            disabled={planning}
            placeholder="e.g. A 45-second Instagram reel about my first sourdough fail, funny, for home bakers"
            className="w-full rounded-xl border border-[#DADCE0] bg-white px-3.5 py-3 text-base text-[#202124] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25 focus:border-[#1A73E8]"
          />
        </label>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-[#3C4043]">Language spoken</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={languageLocked}
              className="w-full rounded-xl border border-[#DADCE0] bg-white px-3 py-2.5 text-base text-[#202124] disabled:opacity-60"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-[#5F6368]">
              {languageLocked
                ? 'Set before uploading — remove the clips to change it.'
                : 'Pick it if you know it; auto works for Hindi, Indian English and most others.'}
            </span>
          </label>
          <div className="space-y-1.5">
            <span className="text-sm font-semibold text-[#3C4043]">Shape</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setFormat('9:16')} className={chip(effectiveFormat === '9:16')}>
                <span className="inline-flex items-center gap-1.5">
                  <Smartphone className="w-4 h-4" /> Vertical 9:16
                </span>
              </button>
              <button type="button" onClick={() => setFormat('16:9')} className={chip(effectiveFormat === '16:9')}>
                <span className="inline-flex items-center gap-1.5">
                  <Monitor className="w-4 h-4" /> Wide 16:9
                </span>
              </button>
            </div>
            {!format && rows.some((r) => r.orientation) && (
              <span className="text-xs text-[#5F6368]">Matched to your footage.</span>
            )}
          </div>
        </div>
      </section>

      {/* 2. Footage */}
      <section aria-labelledby="footage" className="space-y-4">
        <h2 id="footage" className="text-xl font-bold text-[#202124]">
          Your footage
        </h2>
        <label className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-[#F1F3F4] hover:bg-[#E8EAED] px-4 py-10 cursor-pointer transition-colors">
          <Film className="w-8 h-8 text-[#1A73E8]" />
          <span className="text-base font-bold text-[#202124]">Choose or drop video files</span>
          <span className="text-sm text-[#5F6368]">Several clips are fine · MP4, MOV, WebM</span>
          <input
            type="file"
            accept="video/*,audio/*"
            multiple
            className="hidden"
            disabled={planning}
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        {rows.map((r, i) => (
          <article key={r.id} className="rounded-2xl bg-white border border-[#E8EAED] p-4 sm:p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold text-[#202124] truncate">
                  <span className="text-[#80868B] tabular-nums mr-2">{String(i + 1).padStart(2, '0')}</span>
                  {r.file.name}
                </p>
                <p className="text-sm text-[#5F6368] flex items-center gap-1.5 mt-0.5">
                  {r.status === 'done' ? (
                    <CheckCircle2 className="w-4 h-4 text-[#137333]" />
                  ) : r.status === 'error' ? (
                    <AlertTriangle className="w-4 h-4 text-[#C5221F]" />
                  ) : (
                    <Loader2 className="w-4 h-4 animate-spin text-[#1A73E8]" />
                  )}
                  {r.message || (r.status === 'queued' ? 'Waiting…' : r.status)}
                  {r.duration ? <span className="tabular-nums">· {formatDuration(r.duration)}</span> : null}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Remove ${r.file.name}`}
                disabled={r.status !== 'done' && r.status !== 'error'}
                onClick={() => {
                  rowsRef.current = rowsRef.current.filter((x) => x.id !== r.id);
                  setRows(rowsRef.current);
                }}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#5F6368] hover:bg-[#FCE8E6] hover:text-[#C5221F] disabled:opacity-40 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {r.status === 'done' && (
              <TakeTrimEditor
                videoUrl={mediaUrlFromGcs(r.gcsUri) || r.localUrl}
                inPoint={r.inPoint}
                outPoint={r.outPoint}
                keepRanges={r.keepRanges}
                userTrimLocked={r.trimLocked}
                gcsObjectPath={r.gcsUri}
                projectId={projectId}
                sceneId={r.sceneId}
                onSaveTrim={(inPoint, outPoint, opts) => {
                  if (opts?.cleanupExtract) return; // handled by the trim-extracted listener
                  updateRow(r.id, {
                    inPoint,
                    outPoint,
                    keepRanges: opts?.keepRanges?.length ? opts.keepRanges : [{ start: inPoint, end: outPoint }],
                    trimLocked: true,
                  });
                }}
                onResetTrim={() =>
                  updateRow(r.id, { inPoint: undefined, outPoint: undefined, keepRanges: undefined, trimLocked: false })
                }
              />
            )}

            {r.transcript && (
              <details className="group">
                <summary className="text-sm font-semibold text-[#1A73E8] cursor-pointer list-none">
                  What you said
                </summary>
                <p className="mt-2 text-sm text-[#3C4043] leading-relaxed whitespace-pre-line">{r.transcript}</p>
              </details>
            )}
            {(r.claims || []).some((c) => c.verdict === 'disputed') && (
              <p className="text-sm text-[#C5221F] flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                {(r.claims || []).filter((c) => c.verdict === 'disputed').length} claim(s) worth double-checking
              </p>
            )}
          </article>
        ))}

        {disputed.length > 0 && (
          <div className="rounded-xl bg-[#FCE8E6] p-4 space-y-2">
            <p className="text-sm font-bold text-[#C5221F]">Claims worth double-checking</p>
            {disputed.slice(0, 4).map((c, i) => (
              <p key={i} className="text-sm text-[#3C4043]">
                <span className="tabular-nums text-[#5F6368]">
                  {c.start.toFixed(1)}–{c.end.toFixed(1)}s
                </span>{' '}
                “{c.text}”{c.explanation ? <span className="block text-[#5F6368]">{c.explanation}</span> : null}
              </p>
            ))}
          </div>
        )}
      </section>

      {/* 3. Request + looks */}
      <section aria-labelledby="request" className="space-y-5">
        <h2 id="request" className="text-xl font-bold text-[#202124]">
          What should TakeOne do with it?
        </h2>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-[#3C4043]">Your request (optional)</span>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={3}
            disabled={planning}
            placeholder="e.g. Keep it under 40 seconds, add a picture of the burnt loaf when I say “brick”, punch in on the lesson"
            className="w-full rounded-xl border border-[#DADCE0] bg-white px-3.5 py-3 text-base text-[#202124] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25 focus:border-[#1A73E8]"
          />
        </label>

        <div className="space-y-2">
          <span className="text-sm font-semibold text-[#3C4043]">AI visuals to add</span>
          <div className="grid sm:grid-cols-2 gap-2">
            {LOOKS.map((l) => {
              const on = prefs.looks.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleLook(l.id)}
                  className={`text-left rounded-xl px-4 py-3 transition-colors cursor-pointer active:scale-[0.99] ${
                    on ? 'bg-[#E8F0FE]' : 'bg-[#F1F3F4] hover:bg-[#E8EAED]'
                  }`}
                >
                  <span className={`flex items-center gap-1.5 text-sm font-bold ${on ? 'text-[#1A73E8]' : 'text-[#202124]'}`}>
                    {on && <Check className="w-4 h-4" />}
                    {l.label}
                  </span>
                  <span className="block text-sm text-[#5F6368]">{l.hint}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-[#5F6368]">You can edit, regenerate or add visuals one by one in Master Cut.</p>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-semibold text-[#3C4043]">Captions</span>
          <div className="flex flex-wrap gap-2">
            {CAPTIONS.map((c) => (
              <button key={c.id} type="button" onClick={() => setPrefs({ ...prefs, captions: c.id })} className={chip(prefs.captions === c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#3C4043]">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.cleanup.silences}
              onChange={(e) => setPrefs({ ...prefs, cleanup: { ...prefs.cleanup, silences: e.target.checked } })}
              className="w-4 h-4 accent-[#1A73E8]"
            />
            Cut pauses
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.cleanup.fillers}
              onChange={(e) => setPrefs({ ...prefs, cleanup: { ...prefs.cleanup, fillers: e.target.checked } })}
              className="w-4 h-4 accent-[#1A73E8]"
            />
            Remove fillers (um, uh)
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.music}
              onChange={(e) => setPrefs({ ...prefs, music: e.target.checked })}
              className="w-4 h-4 accent-[#1A73E8]"
            />
            Background music
          </label>
        </div>
      </section>

      {error && <p className="text-sm text-[#C5221F] bg-[#FCE8E6] rounded-lg px-3 py-2">{error}</p>}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={planning}
          className="px-5 py-3 rounded-xl text-sm font-semibold text-[#3C4043] bg-[#F1F3F4] hover:bg-[#E8EAED] cursor-pointer"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void planEdit()}
          disabled={!ready || planning || busyUploading}
          className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-[#1A73E8] text-white text-base font-bold hover:bg-[#1557B0] active:scale-[0.98] disabled:opacity-50 transition cursor-pointer"
        >
          {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          {planning ? 'Planning your edit…' : busyUploading ? 'Processing your clips…' : 'Plan my edit'}
          {!planning && !busyUploading && <ArrowRight className="w-4 h-4" />}
        </button>
        {!rows.length && <span className="text-sm text-[#5F6368]">Add at least one clip to continue.</span>}
      </div>
    </div>
  );
};
