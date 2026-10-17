/**
 * mediaVault.ts
 * Robust persistent storage for TakeOne project state and video Blobs.
 * Backed by IndexedDB + localStorage, ensuring uploaded raw footage,
 * trims, and project state survive view navigation, browser reloads, and tab switches.
 */

import type { Project, Scene } from '../types/director';

const DB_NAME = 'takeone_vault_db';
const DB_VERSION = 1;
const STORE_TAKES = 'takes';
const STORE_PROJECTS = 'projects';
const LOCAL_STORAGE_KEY = 'takeone_active_project_v2';
const SESSION_KEY = 'takeone-session-v1';

// In-memory cache for live blob URLs to prevent redundant createObjectURL calls
const activeBlobUrlCache = new Map<string, string>();

function openVaultDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TAKES)) {
          db.createObjectStore(STORE_TAKES, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn('Failed to open IndexedDB media vault:', req.error);
        resolve(null);
      };
    } catch (e) {
      console.warn('IndexedDB unavailable:', e);
      resolve(null);
    }
  });
}

/** Store a take or raw footage Blob in IndexedDB. */
export async function saveTakeMedia(
  projectId: string,
  sceneId: string,
  blob: Blob,
  mimeType?: string
): Promise<string> {
  const key = `${projectId}:${sceneId}`;
  const mime = mimeType || blob.type || 'video/mp4';

  // Revoke previous blob URL if any
  const prevUrl = activeBlobUrlCache.get(key);
  if (prevUrl && prevUrl.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(prevUrl);
    } catch {
      /* ignore */
    }
  }

  const liveUrl = URL.createObjectURL(blob);
  activeBlobUrlCache.set(key, liveUrl);

  const db = await openVaultDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_TAKES, 'readwrite');
        const store = tx.objectStore(STORE_TAKES);
        store.put({
          key,
          projectId,
          sceneId,
          blob,
          mimeType: mime,
          updatedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return liveUrl;
}

/** Retrieve a take Blob from IndexedDB. */
export async function getTakeMedia(projectId: string, sceneId: string): Promise<Blob | null> {
  const db = await openVaultDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const key = `${projectId}:${sceneId}`;
      const tx = db.transaction(STORE_TAKES, 'readonly');
      const store = tx.objectStore(STORE_TAKES);
      const req = store.get(key);
      req.onsuccess = () => {
        const item = req.result;
        resolve(item?.blob || null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Remove a take from IndexedDB. */
export async function deleteTakeMedia(projectId: string, sceneId: string): Promise<void> {
  const key = `${projectId}:${sceneId}`;
  const prevUrl = activeBlobUrlCache.get(key);
  if (prevUrl && prevUrl.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(prevUrl);
    } catch {
      /* ignore */
    }
    activeBlobUrlCache.delete(key);
  }

  const db = await openVaultDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_TAKES, 'readwrite');
      const store = tx.objectStore(STORE_TAKES);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Convert GCS URI (gs://bucket/object) to a browser-playable server URL (/api/render/media?path=...).
 */
export function mediaUrlFromGcs(gcsPath?: string | null): string | null {
  if (!gcsPath) return null;
  const s = String(gcsPath).trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/api/')) {
    return s;
  }
  const clean = s.replace(/^gs:\/\/[^/]+\//, '').replace(/^\/+/, '');
  if (!clean) return null;
  return `/api/render/media?path=${encodeURIComponent(clean)}`;
}

/**
 * Browser-playable URL for a scene's take, synchronously: the durable cloud copy (via the media
 * proxy) first, then a local URL. Never returns a raw gs:// address, which no browser can open.
 */
export function playableTakeUrl(scene: {
  userRecordedVideoUrl?: string;
  gcsObjectPath?: string;
}): string | null {
  const fromGcs = mediaUrlFromGcs(scene.gcsObjectPath);
  if (fromGcs) return fromGcs;
  const rec = String(scene.userRecordedVideoUrl || '').trim();
  if (!rec) return null;
  return rec.startsWith('gs://') ? mediaUrlFromGcs(rec) : rec;
}

/**
 * Resolve a working, browser-playable URL for a scene's take.
 * Canonical order: mediaUrlFromGcs → vault blob → in-session blob.
 */
export async function resolvePlayableTakeUrl(
  projectId: string,
  scene: { id: string; userRecordedVideoUrl?: string; gcsObjectPath?: string; userInsertUrl?: string }
): Promise<string | null> {
  const key = `${projectId}:${scene.id}`;

  // 1. Durable GCS stream (survives reload)
  if (scene.gcsObjectPath) {
    const streamUrl = mediaUrlFromGcs(scene.gcsObjectPath);
    if (streamUrl) return streamUrl;
  }

  // 2. IndexedDB vault blob
  const blob = await getTakeMedia(projectId, scene.id);
  if (blob) {
    const liveUrl = URL.createObjectURL(blob);
    activeBlobUrlCache.set(key, liveUrl);
    return liveUrl;
  }

  // 3. In-session blob / cached URL
  const cached = activeBlobUrlCache.get(key);
  if (cached) return cached;

  // 4. Non-blob userRecordedVideoUrl (http/https/server endpoint)
  const recUrl = scene.userRecordedVideoUrl;
  if (recUrl && !recUrl.startsWith('blob:') && !recUrl.startsWith('gs://')) {
    return recUrl;
  }

  // 5. userInsertUrl
  if (scene.userInsertUrl && !scene.userInsertUrl.startsWith('blob:') && !scene.userInsertUrl.startsWith('gs://')) {
    return scene.userInsertUrl;
  }

  return null;
}

/** Strip blob:/data: URLs so they are never persisted as canonical media. */
function stripEphemeralMediaUrls<T extends Record<string, any>>(scene: T): T {
  const next = { ...scene };
  for (const key of [
    'userRecordedVideoUrl',
    'userInsertUrl',
    'aiGeneratedVideoUrl',
    'aiGeneratedImageUrl',
    'proxyUrl',
    'gcsObjectPath',
  ] as const) {
    const v = next[key];
    if (typeof v === 'string' && (v.startsWith('blob:') || v.startsWith('data:'))) {
      (next as any)[key] = undefined;
    }
  }
  return next;
}

/**
 * Rehydrate all scenes in a project with active playable URLs from IndexedDB or GCS.
 * Call this when loading a project or when navigating views to ensure no footage is lost.
 */
export async function hydrateProjectMedia(project: Project): Promise<Project> {
  if (!project || !Array.isArray(project.scenes)) return project;

  let changed = false;
  const updatedScenes = await Promise.all(
    project.scenes.map(async (scene) => {
      const next: Scene = { ...scene };

      // Ensure user takes have playable URL
      if (scene.filmedBy === 'user' || scene.mediaSource === 'imported' || scene.userRecordedVideoUrl || scene.gcsObjectPath) {
        const playable = await resolvePlayableTakeUrl(project.id, scene);
        if (playable && playable !== scene.userRecordedVideoUrl) {
          next.userRecordedVideoUrl = playable;
          changed = true;
        }
      }

      // Ensure insert uploads have playable URL
      if (scene.userInsertUrl && (scene.userInsertUrl.startsWith('blob:') || scene.userInsertUrl.startsWith('gs://'))) {
        const playableInsert = await resolvePlayableTakeUrl(project.id, {
          id: `${scene.id}_insert`,
          userRecordedVideoUrl: scene.userInsertUrl,
          gcsObjectPath: scene.gcsObjectPath,
        });
        if (playableInsert) {
          next.userInsertUrl = playableInsert;
          changed = true;
        }
      }

      return next;
    })
  );

  return changed ? { ...project, scenes: updatedScenes } : project;
}

/**
 * Save project permanently across IndexedDB + localStorage + sessionStorage.
 */
export async function saveProjectLocally(project: Project, currentScreen = 'script-overview'): Promise<void> {
  if (!project) return;

  // Never persist blob:/data: as media — canonical media is gcsObjectPath (+ vault Blobs by scene id)
  const durableProject: Project = {
    ...project,
    scenes: (project.scenes || []).map((s) => stripEphemeralMediaUrls(s)),
  };

  // 1. Save to IndexedDB (no 5MB quota limit)
  try {
    const db = await openVaultDb();
    if (db) {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      tx.objectStore(STORE_PROJECTS).put({
        id: durableProject.id || 'default_project',
        project: durableProject,
        updatedAt: Date.now(),
      });
    }
  } catch (err) {
    console.warn('Failed saving project to IndexedDB:', err);
  }

  // 2. Save sanitized lightweight state in localStorage and sessionStorage
  try {
    const lightweight = {
      project: durableProject,
      screen: currentScreen,
      savedAt: Date.now(),
    };
    const json = JSON.stringify(lightweight);
    localStorage.setItem(LOCAL_STORAGE_KEY, json);
    sessionStorage.setItem(SESSION_KEY, json);
  } catch {
    /* quota exceeded in localStorage fallback */
  }
}

/**
 * Load project locally from IndexedDB, falling back to localStorage / sessionStorage.
 */
export async function loadProjectLocally(): Promise<{ project: Project | null; screen: string }> {
  // Try IndexedDB first
  try {
    const db = await openVaultDb();
    if (db) {
      const projectFromDb = await new Promise<Project | null>((resolve) => {
        try {
          const tx = db.transaction(STORE_PROJECTS, 'readonly');
          const store = tx.objectStore(STORE_PROJECTS);
          const req = store.getAll();
          req.onsuccess = () => {
            const list = req.result || [];
            if (!list.length) return resolve(null);
            // Sort by most recently updated
            list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            resolve(list[0]?.project || null);
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });

      if (projectFromDb) {
        const hydrated = await hydrateProjectMedia(projectFromDb);
        const storedScreen = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(LOCAL_STORAGE_KEY);
        let screen = 'script-overview';
        if (storedScreen) {
          try {
            screen = JSON.parse(storedScreen).screen || 'script-overview';
          } catch {
            /* ignore */
          }
        }
        return { project: hydrated, screen };
      }
    }
  } catch (err) {
    console.warn('Error reading from IndexedDB:', err);
  }

  // Fallback to storage
  try {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return { project: null, screen: 'idea' };
    const parsed = JSON.parse(raw);
    const proj = parsed.project || null;
    const screen = parsed.screen || 'idea';
    if (proj) {
      const hydrated = await hydrateProjectMedia(proj);
      return { project: hydrated, screen };
    }
    return { project: null, screen };
  } catch {
    return { project: null, screen: 'idea' };
  }
}

/**
 * Clear saved project and cached media blobs from vault and local storage.
 */
export async function clearProjectLocally(projectId?: string): Promise<void> {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    activeBlobUrlCache.clear();
    const db = await openVaultDb();
    if (db) {
      const tx = db.transaction([STORE_PROJECTS, STORE_TAKES], 'readwrite');
      const projStore = tx.objectStore(STORE_PROJECTS);
      if (projectId) {
        projStore.delete(projectId);
      } else {
        projStore.clear();
      }
      if (!projectId) {
        const takeStore = tx.objectStore(STORE_TAKES);
        takeStore.clear();
      }
    }
  } catch (err) {
    console.warn('Failed clearing project from vault:', err);
  }
}
