import { EditDecisionList } from './edl';

export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'uploading' | 'rendering' | 'done' | 'error';
  percent: number;
  message: string;
  stage?: string;
  heartbeatAt?: number;
  updatedAt?: number;
  outputGcsPath?: string;
  downloadUrl?: string;
  error?: string;
  edlSummary?: string;
  warnings?: string[];
  outputDurationSec?: number;
  quality?: 'draft' | 'standard' | 'high';
}

async function readJson<T = any>(res: Response): Promise<T> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    const snippet = text.replace(/\s+/g, ' ').slice(0, 80);
    throw new Error(
      `Server returned non-JSON (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`
    );
  }
  return (await res.json()) as T;
}

function assertJobId(jobId: string, label: string): string {
  const id = String(jobId || '').trim();
  if (!id) throw new Error(`${label}: missing job id`);
  return id;
}

function safeKeyPart(s: string): string {
  return String(s || 'x')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}

/** Deterministic GCS object key for a take — retries overwrite the same object. */
export function takeObjectKey(projectId: string, sceneId: string): string {
  return `source/${safeKeyPart(projectId)}/${safeKeyPart(sceneId)}`;
}

export function inferVideoMime(blob: Blob, filename?: string): string {
  const typed = (blob.type || '').split(';')[0].trim();
  if (typed && typed !== 'application/octet-stream') return typed;
  const name = filename || (blob as File).name || '';
  if (/\.mov$/i.test(name)) return 'video/quicktime';
  if (/\.(mp4|m4v)$/i.test(name)) return 'video/mp4';
  if (/\.webm$/i.test(name)) return 'video/webm';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image/jpeg';
  return typed || 'video/mp4';
}

export function extensionForMime(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('quicktime') || m.includes('x-m4v')) return 'mov';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.startsWith('image/')) return 'jpg';
  if (m.startsWith('audio/')) return 'm4a';
  return 'mp4';
}

/**
 * Upload a Blob to GCS via signed URL.
 * Pass objectPath for idempotent take uploads (overwrites same key).
 */
export async function uploadBlobToGcs(
  blob: Blob,
  folder: string,
  extension: string,
  contentType: string,
  opts?: { objectPath?: string }
): Promise<{ objectPath: string; gcsUri: string }> {
  const urlRes = await fetch('/api/render/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder,
      extension,
      contentType,
      objectPath: opts?.objectPath,
    }),
  });
  const urlData = await urlRes.json();
  if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL');

  const extraHeaders =
    urlData.headers && typeof urlData.headers === 'object' ? urlData.headers : {};
  // Only forward headers that are actually required by the signed URL.
  // Custom metadata headers often fail CORS preflight on mobile browsers.
  const putHeaders: Record<string, string> = { 'Content-Type': contentType };
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (typeof v === 'string' && v && k.toLowerCase() !== 'content-type') {
      // Skip custom meta headers — signed URL no longer requires them
      if (k.toLowerCase().startsWith('x-goog-meta-')) continue;
      putHeaders[k] = v;
    }
  }
  const put = await fetch(urlData.uploadUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: blob,
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => '');
    throw new Error(
      `GCS upload failed (${put.status})${detail ? `: ${detail.slice(0, 120)}` : ''}`
    );
  }

  return { objectPath: urlData.objectPath, gcsUri: urlData.gcsUri };
}

/** Persist a take with recorded MIME + deterministic key. */
export async function persistTakeBlob(
  blob: Blob,
  projectId: string,
  sceneId: string,
  mimeType?: string
): Promise<{ gcsUri: string; objectPath: string; mimeType: string }> {
  const mime =
    (mimeType || inferVideoMime(blob, (blob as File).name) || 'video/mp4').split(';')[0].trim() ||
    'video/mp4';
  const objectPath = takeObjectKey(projectId, sceneId);
  const { gcsUri } = await uploadBlobToGcs(
    blob,
    'source',
    extensionForMime(mime),
    mime,
    { objectPath }
  );
  return { gcsUri, objectPath, mimeType: mime };
}

/** Kick 480p proxy encode after capture/import (non-blocking). */
export function kickProxyBuild(opts: {
  gcsObjectPath: string;
  projectId: string;
  sceneId: string;
  durationSec?: number;
  onReady?: (proxyUrl: string) => void;
}): void {
  void fetch('/api/media/ensure-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gcsObjectPath: opts.gcsObjectPath,
      projectId: opts.projectId,
      sceneId: opts.sceneId,
      durationSec: opts.durationSec,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data?.proxyUrl && typeof opts.onReady === 'function') {
        opts.onReady(String(data.proxyUrl));
      }
    })
    .catch((err) => console.warn('[proxy] kick failed:', err));
}

/** Convert a blob:/http:/data: media URL into a GCS path (or leave http for server fetch). */
export async function resolveMediaForRender(
  mediaUrl: string | null | undefined,
  folder: string,
  opts?: { mimeType?: string; objectPath?: string }
): Promise<string | null> {
  if (!mediaUrl) return null;
  if (mediaUrl.startsWith('gs://') || mediaUrl.startsWith('/assets/')) return mediaUrl;
  if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) return mediaUrl;

  if (mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
    const res = await fetch(mediaUrl);
    const blob = await res.blob();
    const mime =
      (opts?.mimeType || blob.type || '').split(';')[0].trim() ||
      (blob.type.startsWith('image/')
        ? 'image/jpeg'
        : blob.type.startsWith('audio/')
          ? 'audio/mpeg'
          : 'video/webm');
    const { gcsUri } = await uploadBlobToGcs(
      blob,
      folder,
      extensionForMime(mime),
      mime,
      opts?.objectPath ? { objectPath: opts.objectPath } : undefined
    );
    return gcsUri;
  }

  return mediaUrl;
}

async function mapPoolLocal<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Ensure every user take has gcsObjectPath before Director Edit / Cloud Run.
 * Uploads leftover blob:/data: URLs with deterministic keys + recorded MIME.
 * Parallel (concurrency 4); skips scenes that already have durable GCS.
 */
export async function hydrateTakesForDirector(
  project: {
    id: string;
    scenes: Array<{
      id: string;
      filmedBy?: string;
      userRecordedVideoUrl?: string;
      gcsObjectPath?: string;
      mimeType?: string;
      recordedDuration?: number;
    }>;
  },
  onProgress?: (msg: string) => void
): Promise<{
  scenes: typeof project.scenes;
  uploaded: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let uploaded = 0;

  const scenes = await mapPoolLocal(project.scenes, 4, async (scene) => {
    if (scene.filmedBy && scene.filmedBy !== 'user') {
      return scene;
    }

    if (scene.gcsObjectPath && !String(scene.gcsObjectPath).startsWith('blob:')) {
      return scene;
    }

    const url = scene.userRecordedVideoUrl;
    if (!url || (!url.startsWith('blob:') && !url.startsWith('data:'))) {
      return scene;
    }

    try {
      onProgress?.(`Saving take ${scene.id} to cloud…`);
      const res = await fetch(url);
      const blob = await res.blob();
      const mime = scene.mimeType || inferVideoMime(blob, (blob as File).name);
      const persisted = await persistTakeBlob(blob, project.id, scene.id, mime);
      uploaded++;
      return {
        ...scene,
        gcsObjectPath: persisted.gcsUri,
        mimeType: persisted.mimeType,
      };
    } catch (err: any) {
      errors.push(`${scene.id}: ${err?.message || String(err)}`);
      return scene;
    }
  });

  return { scenes, uploaded, errors };
}

/** Strip blob:/data: playback URLs before posting project to Cloud Run. */
export function projectPayloadForDirector(project: any): any {
  return {
    ...project,
    scenes: (project.scenes || []).map((s: any) => {
      const next = { ...s };
      if (
        typeof next.userRecordedVideoUrl === 'string' &&
        (next.userRecordedVideoUrl.startsWith('blob:') ||
          next.userRecordedVideoUrl.startsWith('data:'))
      ) {
        // Prefer GCS for server; keep local blob only in client state
        if (next.gcsObjectPath) {
          next.userRecordedVideoUrl = next.gcsObjectPath;
        } else {
          delete next.userRecordedVideoUrl;
        }
      }
      return next;
    }),
  };
}

export async function prepareEdlForServer(edl: EditDecisionList): Promise<EditDecisionList> {
  const clips = await mapPoolLocal(edl.clips || [], 4, async (clip) => {
    const mediaUrl = await resolveMediaForRender(
      clip.mediaUrl,
      clip.filmedBy === 'user' ? 'takes' : 'cutaways'
    );
    const brollInserts = (
      await mapPoolLocal(clip.brollInserts || [], 4, async (b) => {
        const bUrl = await resolveMediaForRender(b.mediaUrl, 'broll');
        return bUrl ? { ...b, mediaUrl: bUrl } : null;
      })
    ).filter(Boolean) as NonNullable<(typeof clip.brollInserts)[number]>[];
    return { ...clip, mediaUrl, brollInserts };
  });

  let musicGcsPath = edl.musicGcsPath || null;
  if (musicGcsPath && (musicGcsPath.startsWith('blob:') || musicGcsPath.startsWith('data:'))) {
    musicGcsPath = await resolveMediaForRender(musicGcsPath, 'music');
  }

  let voiceoverGcsPath = edl.voiceoverGcsPath || null;
  if (voiceoverGcsPath && (voiceoverGcsPath.startsWith('blob:') || voiceoverGcsPath.startsWith('data:'))) {
    voiceoverGcsPath = await resolveMediaForRender(voiceoverGcsPath, 'voiceover');
  }

  const channel = { ...edl.channel };
  if (channel.introBackgroundUrl) {
    const resolved = await resolveMediaForRender(channel.introBackgroundUrl, 'intro');
    if (resolved) channel.introBackgroundUrl = resolved;
  }
  if (channel.introVideoUrl) {
    const resolved = await resolveMediaForRender(channel.introVideoUrl, 'intro');
    if (resolved) channel.introVideoUrl = resolved;
  }

  return { ...edl, clips, musicGcsPath, voiceoverGcsPath, channel };
}

export type PendingJobKind = 'director-edit' | 'render';

export type PendingJobRecord = {
  projectId: string;
  jobId: string;
  kind: PendingJobKind;
  startedAt: number;
  quality?: 'draft' | 'standard' | 'high';
};

const PENDING_JOB_KEY = 'takeone.pendingJob';

export function savePendingJob(rec: PendingJobRecord): void {
  try {
    localStorage.setItem(PENDING_JOB_KEY, JSON.stringify(rec));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearPendingJob(kind?: PendingJobKind, projectId?: string): void {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    if (!raw) return;
    if (!kind && !projectId) {
      localStorage.removeItem(PENDING_JOB_KEY);
      return;
    }
    const rec = JSON.parse(raw) as PendingJobRecord;
    if (kind && rec.kind !== kind) return;
    if (projectId && rec.projectId !== projectId) return;
    localStorage.removeItem(PENDING_JOB_KEY);
  } catch {
    localStorage.removeItem(PENDING_JOB_KEY);
  }
}

export function loadPendingJob(projectId: string): PendingJobRecord | null {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as PendingJobRecord;
    if (!rec?.jobId || !rec?.kind) return null;
    if (rec.projectId !== projectId) return null;
    // Drop stale records older than 6 hours
    if (Date.now() - (rec.startedAt || 0) > 6 * 60 * 60_000) {
      localStorage.removeItem(PENDING_JOB_KEY);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export type RenderQuality = 'draft' | 'standard' | 'high' | 'final';

export async function startServerRender(
  edl: EditDecisionList,
  opts?: { quality?: RenderQuality }
): Promise<string> {
  const prepared = await prepareEdlForServer(edl);
  const raw = opts?.quality;
  const quality: RenderQuality =
    raw === 'draft' ? 'draft' : raw === 'high' ? 'high' : 'standard';
  (prepared as any).renderQuality = quality;
  const res = await fetch('/api/render/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edl: prepared, quality }),
    cache: 'no-store',
  });
  const data = await readJson<{ jobId?: string; error?: string }>(res);
  if (!res.ok) throw new Error(data.error || 'Failed to start render');
  return assertJobId(data.jobId || '', 'Master render');
}

export async function deleteRenderJob(jobId: string): Promise<void> {
  const id = assertJobId(jobId, 'Delete render');
  const res = await fetch(`/api/render/${id}`, { method: 'DELETE', cache: 'no-store' });
  const data = await readJson<{ error?: string }>(res).catch(() => ({} as { error?: string }));
  if (!res.ok) throw new Error(data.error || 'Failed to delete render');
}

/** Resolve a playable/downloadable master URL (signed GCS redirect preferred). */
export async function resolveMasterPlayUrl(jobId: string): Promise<string> {
  const id = assertJobId(jobId, 'Master download');
  const res = await fetch(`/api/render/download/${id}?inline=1&json=1`, { cache: 'no-store' });
  const data = await readJson<{ url?: string }>(res).catch(() => ({} as { url?: string }));
  if (res.ok && data?.url) return data.url as string;
  // Fallback path (redirect endpoint) — browsers handle 302; video element may not.
  return `/api/render/download/${id}?inline=1`;
}

/** Human progress line with elapsed time; covers the Cloud Run cold start before the worker claims. */
export function describeRenderProgress(
  job: Pick<RenderJobStatus, 'status' | 'stage' | 'message'>,
  startedAtMs: number
): string {
  const secs = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
  const status = String(job.status || '').toLowerCase();
  const stage = String(job.stage || '').toLowerCase();
  if (status === 'queued' || stage === 'queued' || stage === 'claiming') {
    return `Starting render machine (about 1 min)… ${elapsed}`;
  }
  return `${job.message || job.stage || job.status} · ${elapsed}`;
}

export async function pollRenderJob(
  jobId: string,
  onProgress?: (job: RenderJobStatus) => void,
  signal?: AbortSignal
): Promise<RenderJobStatus> {
  const id = assertJobId(jobId, 'Master render');
  const started = Date.now();
  let lastPercent = -1;
  let lastChangeAt = Date.now();
  let lastHeartbeat = 0;
  let errorStreak = 0;
  const MAX_TOTAL_MS = 45 * 60_000;
  const MAX_STALL_MS = 8 * 60_000;
  /** Cloud Run Job cold start can take several minutes — do not give up at 90s. */
  const MAX_QUEUED_MS = 10 * 60_000;
  let pollBackoffMs = 500;
  let transientStreak = 0;

  while (true) {
    if (signal?.aborted) throw new Error('Render cancelled');
    if (Date.now() - started > MAX_TOTAL_MS) {
      throw new Error('Master render timed out after 45 minutes. Try again, or split a very long cut.');
    }
    let res: Response;
    try {
      res = await fetch(`/api/render/status/${id}`, { cache: 'no-store' });
    } catch (netErr: any) {
      transientStreak += 1;
      pollBackoffMs = Math.min(5_000, Math.max(1_000, pollBackoffMs * 2));
      if (transientStreak > 60) {
        throw new Error(netErr?.message || 'Master render status network failed');
      }
      await new Promise((r) => setTimeout(r, pollBackoffMs));
      continue;
    }
    if (res.status === 429 || res.status === 502 || res.status === 503) {
      transientStreak += 1;
      pollBackoffMs = Math.min(5_000, Math.max(1_000, pollBackoffMs * 2));
      if (transientStreak > 120) {
        throw new Error(`Master render status failed (${res.status})`);
      }
      await new Promise((r) => setTimeout(r, pollBackoffMs));
      continue;
    }
    const job = await readJson<RenderJobStatus>(res);
    if (!res.ok) throw new Error((job as any).error || 'Master render status failed');
    transientStreak = 0;
    pollBackoffMs = 500;
    onProgress?.(job);
    if (job.status === 'error') {
      errorStreak += 1;
      if (errorStreak >= 2) return job;
    } else {
      errorStreak = 0;
    }
    if (job.status === 'done') return job;
    const beat = Number(job.heartbeatAt || job.updatedAt || 0);
    if (beat > lastHeartbeat) {
      lastHeartbeat = beat;
      lastChangeAt = Date.now();
    }
    const status = String(job.status || job.stage || '').toLowerCase();
    // Prefer wall-clock since poll start when server clocks skew ahead of the client.
    if (status === 'queued' && Date.now() - started > MAX_QUEUED_MS) {
      const beatInPast = beat > 0 && beat <= Date.now();
      const heartbeatStale = beat <= 0 || (beatInPast && Date.now() - beat > MAX_QUEUED_MS);
      if (heartbeatStale) {
        throw new Error(
          'Master render worker never started. The job is still queued — tap Build Master Cut again to retry.'
        );
      }
    }
    if (beat > 0 && beat <= Date.now() && Date.now() - beat > MAX_STALL_MS) {
      throw new Error(
        `Render stalled (${job.message || job.stage || job.status}). Worker heartbeat stopped.`
      );
    } else if (beat > Date.now() || (beat > 0 && Date.now() - beat <= MAX_STALL_MS)) {
      if (job.percent !== lastPercent) {
        lastPercent = job.percent;
        lastChangeAt = Date.now();
      }
    } else if (job.percent !== lastPercent) {
      lastPercent = job.percent;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt > MAX_STALL_MS) {
      throw new Error(
        `Render stalled at ${job.percent}% (${job.message || job.status}). Cancel and retry — the server step hung.`
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export type DirectorEditJobStatus = {
  ok: boolean;
  jobId: string;
  projectId?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  percent: number;
  stage: string;
  message: string;
  heartbeatAt?: number;
  updatedAt?: number;
  error?: string;
  result?: any;
};

const DIRECTOR_STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  observe: 'Reading take',
  understand: 'Story notes',
  direct: 'Suggestions',
  plan: 'Suggestions',
  rough: 'Rendering preview',
  critic: 'Suggestions',
  revise: 'Refining',
  final: 'Locking edit',
  done: 'Complete',
  error: 'Failed',
};

export function formatDirectorStage(job: { stage?: string; message?: string }): string {
  const label = DIRECTOR_STAGE_LABELS[job.stage || ''] || job.stage || 'Working';
  const msg = (job.message || '').trim();
  if (!msg || msg === label || msg.startsWith(label)) return msg || label;
  return `${label} — ${msg}`;
}

export async function startDirectorEditJob(body: {
  project: unknown;
  preset?: string;
  maxCriticIterations?: number;
  mode?: 'analyze' | 'recut';
}): Promise<string> {
  const res = await fetch('/api/director-edit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await readJson<{ ok?: boolean; jobId?: string; error?: string }>(res);
  if (res.status === 409) {
    // Resume existing job when server reports one
    if (data.jobId) return assertJobId(data.jobId, 'Director Edit');
    throw new Error(data.error || 'Director Edit already running');
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || 'Failed to start Director Edit');
  }
  return assertJobId(data.jobId || '', 'Director Edit');
}

export async function pollDirectorEditJob(
  jobId: string,
  onProgress?: (job: DirectorEditJobStatus) => void
): Promise<DirectorEditJobStatus> {
  const id = assertJobId(jobId, 'Director Edit');
  const started = Date.now();
  const MAX_TOTAL_MS = 55 * 60_000;
  const MAX_STALL_MS = 8 * 60_000;
  const MAX_QUEUED_MS = 10 * 60_000;
  let errorStreak = 0;
  let pollBackoffMs = 500;
  let transientStreak = 0;
  while (true) {
    if (Date.now() - started > MAX_TOTAL_MS) {
      throw new Error('Director Edit timed out after 55 minutes.');
    }
    let res: Response;
    try {
      res = await fetch(`/api/director-edit/status/${id}`, { cache: 'no-store' });
    } catch (netErr: any) {
      transientStreak += 1;
      pollBackoffMs = Math.min(5_000, Math.max(1_000, pollBackoffMs * 2));
      if (transientStreak > 60) {
        throw new Error(netErr?.message || 'Director edit status network failed');
      }
      await new Promise((r) => setTimeout(r, pollBackoffMs));
      continue;
    }
    if (res.status === 429 || res.status === 502 || res.status === 503) {
      transientStreak += 1;
      pollBackoffMs = Math.min(5_000, Math.max(1_000, pollBackoffMs * 2));
      if (transientStreak > 120) {
        throw new Error(`Director edit status failed (${res.status})`);
      }
      await new Promise((r) => setTimeout(r, pollBackoffMs));
      continue;
    }
    const job = await readJson<DirectorEditJobStatus>(res);
    if (!res.ok) throw new Error((job as any).error || 'Director edit status failed');
    transientStreak = 0;
    pollBackoffMs = 500;
    onProgress?.(job);
    if (job.status === 'error') {
      errorStreak += 1;
      if (errorStreak >= 2) return job;
    } else {
      errorStreak = 0;
    }
    if (job.status === 'done') return job;
    const beat = Number(job.heartbeatAt || job.updatedAt || 0);
    if (job.status === 'queued' && Date.now() - started > MAX_QUEUED_MS) {
      const beatInPast = beat > 0 && beat <= Date.now();
      const heartbeatStale = beat <= 0 || (beatInPast && Date.now() - beat > MAX_QUEUED_MS);
      if (heartbeatStale) {
        throw new Error(
          'AI Director worker never started. The job is still queued — tap AI Director Edit again to retry.'
        );
      }
    }
    if (beat > 0 && beat <= Date.now() && Date.now() - beat > MAX_STALL_MS) {
      throw new Error(
        `Director Edit stalled (${job.message || job.stage}). Worker heartbeat stopped.`
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
