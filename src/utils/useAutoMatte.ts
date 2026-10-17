/**
 * Keeps every virtual-background take matted on the server (RVM): starts a matte job as soon as
 * a take is uploaded (or its background changes), polls it, and stores the result on the scene.
 * Mounted once at the app root so it keeps going across screens.
 */
import { useEffect, useRef } from 'react';
import type { Project, Scene } from '../types/director';
import { applyAssetResults, dataUrlToBlob, generateAssets } from './aiVisuals';
import { extensionForMime, uploadBlobToGcs } from './renderClient';
import { matteIsCurrent, resolveSceneBackgroundPrompt, sceneBackgroundForMatte } from './virtualBackground';

type Update = (next: (prev: Project) => Project) => void;

/** Takes that want the background and can be matted (the camera file is in the bucket). */
export function wantsMatte(scene: Scene, project?: Project): boolean {
  if (
    scene.filmedBy !== 'user' ||
    scene.includeInExport === false ||
    scene.recipe?.layout !== 'virtual_background' ||
    !String(scene.gcsObjectPath || '').startsWith('gs://')
  ) {
    return false;
  }
  // Older takes recorded with the background baked in only need redoing when it was changed.
  if (scene.virtualBackgroundBaked) {
    const bg = sceneBackgroundForMatte(scene, project);
    return Boolean(bg && scene.virtualBackgroundBakedUrl && scene.virtualBackgroundBakedUrl !== bg);
  }
  return true;
}

/** The matte job for this take + background is already running or has failed (wait for Retry). */
function alreadyHandled(scene: Scene, bg: string | undefined): boolean {
  if (matteIsCurrent(scene)) return true;
  const sameTarget = scene.mattedSourcePath === scene.gcsObjectPath && (!bg || scene.mattedBackgroundUrl === bg);
  return sameTarget && (scene.matteStatus === 'running' || scene.matteStatus === 'failed');
}

function patchScene(update: Update, sceneId: string, patch: Partial<Scene>) {
  update((prev) => ({ ...prev, scenes: prev.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)) }));
}

export function useAutoMatte(project: Project | null, onUpdateProject: Update): void {
  const projectRef = useRef(project);
  projectRef.current = project;
  const starting = useRef(new Set<string>());

  // Start jobs for takes that need one.
  useEffect(() => {
    if (!project) return;
    for (const scene of project.scenes) {
      if (!wantsMatte(scene, project)) continue;
      const bg = sceneBackgroundForMatte(scene, project);
      if (alreadyHandled(scene, bg)) continue;
      const key = `${scene.id}|${scene.gcsObjectPath}|${bg || ''}`;
      if (starting.current.has(key)) continue;
      starting.current.add(key);
      void startMatte(scene.id).finally(() => starting.current.delete(key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.scenes]);

  const startMatte = async (sceneId: string) => {
    const p = projectRef.current;
    let scene = p?.scenes.find((s) => s.id === sceneId);
    if (!p || !scene) return;
    try {
      let bg = sceneBackgroundForMatte(scene, p);
      // No picture yet: make it from the scene's background prompt.
      if (!bg) {
        const prompt = resolveSceneBackgroundPrompt(scene, p);
        if (!prompt) return;
        const key = `${scene.id}:bg`;
        const { results } = await generateAssets([{ key, sceneId: scene.id, sceneTitle: scene.title, prompt, kind: 'background' }], {
          aspectRatio: p.aspectRatio || '9:16',
          styleBible: p.channelSettings?.styleBible || '',
        });
        bg = results.get(key);
        if (!bg) throw new Error('Couldn’t make the background picture');
        onUpdateProject((prev) => applyAssetResults(prev, results));
      }
      // Uploaded backgrounds live in the project as data: URLs; the worker needs a bucket copy.
      if (bg.startsWith('data:')) {
        const blob = await dataUrlToBlob(bg);
        const mime = blob.type || 'image/jpeg';
        const { gcsUri } = await uploadBlobToGcs(blob, 'broll', extensionForMime(mime), mime);
        const dataUrl = bg;
        bg = gcsUri;
        onUpdateProject((prev) => ({
          ...prev,
          scenes: prev.scenes.map((s) =>
            s.recipe?.background?.assetUrl === dataUrl
              ? { ...s, recipe: { ...s.recipe!, background: { ...s.recipe!.background!, assetUrl: gcsUri } } }
              : s
          ),
        }));
      }
      scene = projectRef.current?.scenes.find((s) => s.id === sceneId) || scene;
      const res = await fetch('/api/matte/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gcsUri: scene.gcsObjectPath,
          backgroundUrl: bg,
          aspectRatio: p.aspectRatio || '9:16',
          projectId: p.id,
          sceneId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Couldn’t start adding the background');
      patchScene(onUpdateProject, sceneId, {
        matteStatus: 'running',
        matteJobId: data.jobId,
        matteProgress: 0,
        matteError: undefined,
        mattedSourcePath: scene.gcsObjectPath,
        mattedBackgroundUrl: bg,
        mattedGcsPath: undefined,
      });
    } catch (e: any) {
      patchScene(onUpdateProject, sceneId, {
        matteStatus: 'failed',
        matteError: e?.message || 'Couldn’t add the background',
        mattedSourcePath: scene.gcsObjectPath,
        mattedBackgroundUrl: sceneBackgroundForMatte(scene, p),
      });
    }
  };

  // Poll running jobs.
  const running = (project?.scenes || [])
    .filter((s) => s.matteStatus === 'running' && s.matteJobId)
    .map((s) => `${s.id}:${s.matteJobId}`)
    .join(',');
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const tick = async () => {
      const scenes = (projectRef.current?.scenes || []).filter((s) => s.matteStatus === 'running' && s.matteJobId);
      for (const s of scenes) {
        try {
          const res = await fetch(`/api/matte/status/${encodeURIComponent(s.matteJobId!)}`);
          if (stopped) return;
          if (res.status === 404) continue; // status not written yet
          const d = await res.json();
          // Only apply to the job this scene is still waiting for.
          const still = (cur: Scene) => cur.matteJobId === s.matteJobId;
          if (d.status === 'done' && d.outputGcsUri) {
            onUpdateProject((prev) => ({
              ...prev,
              scenes: prev.scenes.map((c) =>
                c.id === s.id && still(c) ? { ...c, matteStatus: 'ready', matteProgress: 1, mattedGcsPath: d.outputGcsUri } : c
              ),
            }));
          } else if (d.status === 'failed' || d.stale) {
            onUpdateProject((prev) => ({
              ...prev,
              scenes: prev.scenes.map((c) =>
                c.id === s.id && still(c)
                  ? { ...c, matteStatus: 'failed', matteError: d.error || 'The background job stopped — try again.' }
                  : c
              ),
            }));
          } else if (typeof d.progress === 'number' && Math.abs((s.matteProgress || 0) - d.progress) >= 0.02) {
            onUpdateProject((prev) => ({
              ...prev,
              scenes: prev.scenes.map((c) => (c.id === s.id && still(c) ? { ...c, matteProgress: d.progress } : c)),
            }));
          }
        } catch {
          /* offline for a moment — next tick */
        }
      }
    };
    const iv = window.setInterval(() => void tick(), 4000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
}

/** Clear a failed job so useAutoMatte starts it again. */
export function retryMatte(onUpdateProject: Update, sceneId: string) {
  patchScene(onUpdateProject, sceneId, { matteStatus: undefined, matteError: undefined, matteJobId: undefined });
}
