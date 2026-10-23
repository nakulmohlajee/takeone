import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { retryMatte, wantsMatte } from '../utils/useAutoMatte';
import type { Project, Scene } from '../types/director';
import { applyBackgroundToTake, sampleGreenRatio } from '../utils/applyBackground';
import { applyAssetResults, generateAssets } from '../utils/aiVisuals';
import { extensionForMime, kickProxyBuild, uploadBlobToGcs } from '../utils/renderClient';
import { mediaUrlFromGcs, resolvePlayableTakeUrl, saveTakeMedia } from '../utils/mediaVault';
import {
  VIDEO_BG_KEY,
  videoBackground,
  matteIsCurrent,
  resolveSceneBackgroundPrompt,
  resolveSceneBackgroundUrl,
  sceneWantsVirtualBackground,
} from '../utils/virtualBackground';

function browserUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.startsWith('gs://') ? mediaUrlFromGcs(url) || undefined : url;
}

/**
 * Takes whose virtual background is missing from the video (recorded on plain camera, imported,
 * or baked with an older background). "Apply background" bakes the current one into the take.
 */
export function takesNeedingBackground(project: Project, greenTakes: Record<string, boolean>): Scene[] {
  return project.scenes.filter((s) => {
    if (s.filmedBy !== 'user' || s.includeInExport === false) return false;
    if (!(s.gcsObjectPath || s.userRecordedVideoUrl)) return false;
    if (!sceneWantsVirtualBackground(s, project) || s.recipe?.layout === 'talking_head') return false;
    if (s.virtualBackgroundMode === 'green') return false;
    const bgUrl = resolveSceneBackgroundUrl(s, project);
    if (s.virtualBackgroundBaked) {
      // Baked with a different background than the one chosen now.
      return Boolean(bgUrl && s.virtualBackgroundBakedUrl && s.virtualBackgroundBakedUrl !== bgUrl);
    }
    if (s.virtualBackgroundMode === 'none') return true;
    // Older takes don't say how they were recorded: a frame that isn't green means plain camera.
    return greenTakes[s.id] === false;
  });
}

export const ApplyBackgroundCard: React.FC<{
  project: Project;
  aspectRatio: string;
  onUpdateProject: (updated: Project | ((prev: Project) => Project)) => void;
  disabled?: boolean;
}> = ({ project, aspectRatio, onUpdateProject, disabled }) => {
  const [greenTakes, setGreenTakes] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, { progress: number; stage: string; error?: string }>>({});
  const projectRef = useRef(project);
  projectRef.current = project;
  const running = useRef(new Set<string>());

  // Check older takes (no recorded mode) once for green.
  useEffect(() => {
    for (const s of project.scenes) {
      if (s.id in greenTakes || s.virtualBackgroundMode || s.virtualBackgroundBaked) continue;
      if (s.filmedBy !== 'user' || !sceneWantsVirtualBackground(s, project) || !s.gcsObjectPath) continue;
      const url = mediaUrlFromGcs(s.gcsObjectPath);
      if (!url) continue;
      setGreenTakes((g) => ({ ...g, [s.id]: true })); // assume green until checked
      sampleGreenRatio(url)
        .then((ratio) => setGreenTakes((g) => ({ ...g, [s.id]: ratio >= 0.04 })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.scenes]);

  const pending = useMemo(() => takesNeedingBackground(project, greenTakes), [project, greenTakes]);

  const setJob = (id: string, patch: Partial<{ progress: number; stage: string; error?: string }>) =>
    setJobs((j) => ({ ...j, [id]: { ...(j[id] || { progress: 0, stage: '' }), ...patch } }));

  const run = async (sceneId: string) => {
    if (running.current.has(sceneId)) return;
    running.current.add(sceneId);
    setJob(sceneId, { progress: 0, stage: 'Preparing…', error: undefined });
    try {
      let scene = projectRef.current.scenes.find((s) => s.id === sceneId);
      if (!scene) throw new Error('Take not found');
      let bgUrl = resolveSceneBackgroundUrl(scene, projectRef.current);
      if (!bgUrl) {
        const prompt = videoBackground(projectRef.current.scenes)?.prompt || resolveSceneBackgroundPrompt(scene, projectRef.current);
        if (!prompt) throw new Error('Describe a background first (Shot Direction or the tweak box).');
        setJob(sceneId, { stage: 'Making the background…' });
        const key = VIDEO_BG_KEY;
        const { results } = await generateAssets(
          [{ key, sceneId: scene.id, sceneTitle: 'Virtual background', prompt, kind: 'background' }],
          { aspectRatio, styleBible: projectRef.current.channelSettings?.styleBible || '' }
        );
        bgUrl = results.get(key);
        if (!bgUrl) throw new Error('Couldn’t make the background — try again.');
        onUpdateProject((prev) => applyAssetResults(prev, results));
      }
      const videoUrl = await resolvePlayableTakeUrl(projectRef.current.id, scene);
      if (!videoUrl) throw new Error('This take’s video isn’t available.');
      setJob(sceneId, { stage: 'Adding the background…' });
      const { blob, mimeType } = await applyBackgroundToTake({
        videoUrl,
        backgroundUrl: browserUrl(bgUrl)!,
        aspectRatio,
        durationHint: Number(scene.recordedDuration) || undefined,
        onProgress: (f) => setJob(sceneId, { progress: f }),
      });
      setJob(sceneId, { stage: 'Saving…', progress: 1 });
      await saveTakeMedia(projectRef.current.id, sceneId, blob, mimeType).catch(() => {});
      const { gcsUri } = await uploadBlobToGcs(blob, 'source', extensionForMime(mimeType), mimeType);
      scene = projectRef.current.scenes.find((s) => s.id === sceneId) || scene;
      const bakedUrl = bgUrl.startsWith('data:') ? undefined : bgUrl;
      onUpdateProject((prev) => ({
        ...prev,
        scenes: prev.scenes.map((s) =>
          s.id === sceneId
            ? {
                ...s,
                gcsObjectPath: gcsUri,
                mimeType,
                userRecordedVideoUrl: URL.createObjectURL(blob),
                proxyUrl: undefined,
                virtualBackgroundBaked: true,
                virtualBackgroundBakedUrl: bakedUrl,
                virtualBackgroundMode: 'baked',
              }
            : s
        ),
      }));
      kickProxyBuild({
        gcsObjectPath: gcsUri,
        projectId: projectRef.current.id,
        sceneId,
        durationSec: Number(scene.recordedDuration) || undefined,
      });
      setJobs((j) => {
        const next = { ...j };
        delete next[sceneId];
        return next;
      });
    } catch (e: any) {
      setJob(sceneId, { error: e?.message || 'Couldn’t add the background — try again.', stage: '' });
    } finally {
      running.current.delete(sceneId);
    }
  };

  // Server matting (the normal path): one row per take that is waiting for its background.
  const serverRows = project.scenes.filter((s) => wantsMatte(s, project) && !matteIsCurrent(s, project));
  // In-browser fallback: takes the server can't do (not uploaded yet) or whose job failed.
  const browserIds = [
    ...pending.filter((s) => !wantsMatte(s, project)).map((s) => s.id),
    ...Object.keys(jobs),
  ].filter((v, i, a) => a.indexOf(v) === i);
  if (!serverRows.length && !browserIds.length) return null;

  return (
    <div className="rounded-xl border border-[#D2E3FC] bg-[#F8FAFF] p-3 space-y-2.5" role="region" aria-label="Virtual background">
      {serverRows.map((scene) => {
        const failed = scene.matteStatus === 'failed';
        const pct = Math.round((scene.matteProgress || 0) * 100);
        const job = jobs[scene.id];
        const browserBusy = Boolean(job && !job.error);
        return (
          <div key={scene.id} className="space-y-1.5">
            <div className="flex items-start gap-2">
              {failed ? (
                <ImageIcon className="w-4 h-4 mt-0.5 text-[#C5221F] shrink-0" />
              ) : (
                <Loader2 className="w-4 h-4 mt-0.5 text-[#1A73E8] animate-spin shrink-0" />
              )}
              <p className="text-xs text-[#3C4043] leading-snug flex-1">
                <span className="font-bold">“{scene.title}”</span>{' '}
                {failed
                  ? `— couldn’t add the virtual background (${scene.matteError || 'job failed'}).`
                  : scene.matteStatus === 'running'
                    ? `— adding your virtual background${pct ? ` · ${pct}%.` : '…'} It shows up here when it’s done.`
                    : '— getting the virtual background ready…'}
              </p>
              {failed && (
                <div className="shrink-0 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => retryMatte(onUpdateProject as any, scene.id)}
                    disabled={disabled || browserBusy}
                    className="px-3 py-1.5 rounded-lg bg-[#1A73E8] text-white text-xs font-bold disabled:opacity-60 cursor-pointer"
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={() => void run(scene.id)}
                    disabled={disabled || browserBusy}
                    className="px-3 py-1.5 rounded-lg bg-white border border-[#DADCE0] text-[#3C4043] text-xs font-bold disabled:opacity-60 cursor-pointer"
                  >
                    {browserBusy ? 'Working…' : 'Do it in this browser'}
                  </button>
                </div>
              )}
            </div>
            {scene.matteStatus === 'running' && (
              <div className="h-1.5 rounded-full bg-white overflow-hidden">
                <div className="h-full bg-[#1A73E8] transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
              </div>
            )}
            {browserBusy && (
              <p className="text-xs text-[#5F6368] tabular-nums">
                {job.stage} {job.progress > 0 && job.progress < 1 ? `${Math.round(job.progress * 100)}%` : ''}
              </p>
            )}
            {job?.error && <p className="text-xs font-semibold text-[#C5221F]">{job.error}</p>}
          </div>
        );
      })}
      {browserIds
        .filter((id) => !serverRows.some((s) => s.id === id))
        .map((id) => {
          const scene = project.scenes.find((s) => s.id === id);
          if (!scene) return null;
          const job = jobs[id];
          const busy = Boolean(job && !job.error);
          return (
            <div key={id} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <ImageIcon className="w-4 h-4 mt-0.5 text-[#B06000] shrink-0" />
                <p className="text-xs text-[#3C4043] leading-snug flex-1">
                  <span className="font-bold">“{scene.title}”</span> doesn’t have its virtual background yet. Add it in this
                  browser — it plays the take once; keep this tab open.
                </p>
                <button
                  type="button"
                  onClick={() => void run(id)}
                  disabled={busy || disabled}
                  className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#1A73E8] text-white text-xs font-bold disabled:opacity-60 cursor-pointer"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {busy ? 'Working…' : job?.error ? 'Try again' : 'Apply background'}
                </button>
              </div>
              {busy && (
                <p className="text-xs text-[#5F6368] tabular-nums">
                  {job.stage} {job.progress > 0 && job.progress < 1 ? `${Math.round(job.progress * 100)}%` : ''}
                </p>
              )}
              {job?.error && <p className="text-xs font-semibold text-[#C5221F]">{job.error}</p>}
            </div>
          );
        })}
    </div>
  );
};
