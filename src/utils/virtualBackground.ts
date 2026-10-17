import type { Project, Scene } from '../types/director';

/** Fallback when a virtual-background scene has no generated/uploaded background yet. */
export const PLACEHOLDER_BACKGROUND_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2b0f0a"/>
          <stop offset="0.45" stop-color="#8a3a1c"/>
          <stop offset="1" stop-color="#c8693a"/>
        </linearGradient>
      </defs>
      <rect width="720" height="1280" fill="url(#g)"/>
      <circle cx="560" cy="260" r="70" fill="#f3b184" opacity="0.55"/>
    </svg>`
  );

type SceneWithPlan = Scene & { mediaPlan?: { kind?: string } };

/** Overlay scenes (AI-filmed) that composite behind this user scene as a green screen. */
export function greenscreenOverlaysFor(project: Project, scene: Scene): Scene[] {
  return project.scenes.filter(
    (s) =>
      s.id !== scene.id &&
      s.overlayParentSceneId === scene.id &&
      (s.overlayLayout === 'greenscreen' || (s as SceneWithPlan).mediaPlan?.kind === 'greenscreen')
  );
}

/** True if this scene should use the virtual green screen while shooting. */
export function sceneWantsVirtualBackground(scene: Scene | undefined, project?: Project): boolean {
  if (!scene) return false;
  if (scene.recipe?.layout === 'virtual_background') return true;
  if (scene.overlayLayout === 'greenscreen') return true;
  if ((scene as SceneWithPlan).mediaPlan?.kind === 'greenscreen') return true;
  // overlayLayout greenscreen without a recipe on a *sibling* overlay → parent shoots virtual
  if (project && !scene.recipe && greenscreenOverlaysFor(project, scene).length > 0) return true;
  return false;
}

/** Best available background image for a virtual-background scene (may be undefined). */
export function resolveSceneBackgroundUrl(scene: Scene | undefined, project?: Project): string | undefined {
  if (!scene) return undefined;
  const direct = scene.recipe?.background?.assetUrl || scene.aiGeneratedImageUrl;
  if (direct) return direct;
  if (project) {
    for (const o of greenscreenOverlaysFor(project, scene)) {
      if (o.aiGeneratedImageUrl) return o.aiGeneratedImageUrl;
    }
  }
  return undefined;
}

/** Prompt to generate a background for this scene. */
export function resolveSceneBackgroundPrompt(scene: Scene | undefined, project?: Project): string {
  if (!scene) return '';
  const fromRecipe = scene.recipe?.background?.prompt?.trim();
  if (fromRecipe) return fromRecipe;
  if (scene.aiGenerationPrompt?.trim()) return scene.aiGenerationPrompt.trim();
  if (project) {
    for (const o of greenscreenOverlaysFor(project, scene)) {
      if (o.aiGenerationPrompt?.trim()) return o.aiGenerationPrompt.trim();
    }
  }
  return '';
}

/** The scene's current background as a durable URL (gs:// or http), if it has one. */
export function sceneBackgroundForMatte(scene: Scene | undefined, project?: Project): string | undefined {
  const url = resolveSceneBackgroundUrl(scene, project);
  return url && !url.startsWith('blob:') ? url : undefined;
}

/** True when the server-matted take matches the current take and background, so it can be used. */
export function matteIsCurrent(scene: Scene | undefined, project?: Project): boolean {
  if (!scene || scene.matteStatus !== 'ready' || !scene.mattedGcsPath) return false;
  if (scene.recipe?.layout !== 'virtual_background') return false;
  if (!scene.gcsObjectPath || scene.mattedSourcePath !== scene.gcsObjectPath) return false;
  const bg = sceneBackgroundForMatte(scene, project);
  return Boolean(bg && bg === scene.mattedBackgroundUrl);
}
