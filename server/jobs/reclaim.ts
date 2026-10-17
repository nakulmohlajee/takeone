/**
 * Fail stale QUEUED tickets. Do not kill a live cook from a stale twin file or clock skew.
 */
import { loadJson, GCS_BUCKET, getStorage } from './store';

/** QUEUED jobs that never left the counter. */
const QUEUED_STALE_MS = Number(process.env.WORKER_QUEUED_STALE_MS || 90_000);
/** Align with render cap so a live Cloud Run Job is not reclaimed mid-cook. */
const MAX_RENDER_SECONDS = Number(process.env.MAX_RENDER_SECONDS || 2400);
const RENDER_GRACE_MS = 5 * 60_000;
const DEFAULT_PROCESSING_DEAD_MS = Math.max(
  20 * 60_000,
  MAX_RENDER_SECONDS * 1000 + RENDER_GRACE_MS
);
/** PROCESSING only if heartbeat is in the past by this long (instance died). */
const PROCESSING_DEAD_MS = Number(
  process.env.WORKER_PROCESSING_DEAD_MS || DEFAULT_PROCESSING_DEAD_MS
);
const NEWBORN_MS = 3 * 60_000;
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

type HeartbeatJob = {
  id: string;
  status?: string;
  state?: string;
  heartbeatAt?: number;
  updatedAt?: number;
  createdAt?: number;
  /** Set when a Cloud Run Job execution was successfully launched. */
  launchedAt?: number;
  executionName?: string;
};

/** Queued jobs with a recent Cloud Run Job launch must not be reclaimed during cold start. */
const LAUNCHED_GRACE_MS = Number(process.env.WORKER_LAUNCHED_GRACE_MS || 10 * 60_000);

function statusOf(job: HeartbeatJob): string {
  return String(job.status || job.state || '').toLowerCase();
}

function isQueued(job: HeartbeatJob): boolean {
  return statusOf(job) === 'queued';
}

function isProcessing(job: HeartbeatJob): boolean {
  const s = statusOf(job);
  return (
    s === 'processing' ||
    s === 'running' ||
    s === 'rendering' ||
    s === 'uploading'
  );
}

function lastBeat(job: HeartbeatJob): number {
  return Number(job.heartbeatAt || job.updatedAt || job.createdAt || 0);
}

function isFresh(beat: number, now: number, windowMs: number): boolean {
  if (beat <= 0) return false;
  // Future / clock skew = alive.
  return beat >= now - windowMs;
}

async function listRecentStatusFiles(prefix: string): Promise<string[]> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return [];
  const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix, autoPaginate: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  return files
    .filter((f) => {
      if (!f.name.endsWith('/status.json')) return false;
      const updated = f.metadata?.updated ? Date.parse(String(f.metadata.updated)) : 0;
      if (updated && updated < cutoff) return false;
      return true;
    })
    .map((f) => f.name);
}

function jobIdFromPath(objectPath: string): string {
  const parts = objectPath.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

export async function reclaimOrphans(): Promise<void> {
  const now = Date.now();
  const renderFiles = await listRecentStatusFiles('renders/');
  const editFiles = await listRecentStatusFiles('edits/');
  const directorFiles = await listRecentStatusFiles('director-edit/');

  const renderById = new Map<string, HeartbeatJob>();
  for (const objectPath of renderFiles) {
    const job = await loadJson<HeartbeatJob>(objectPath);
    if (!job?.id) continue;
    const prev = renderById.get(job.id);
    if (!prev || (job.updatedAt || 0) >= (prev.updatedAt || 0)) renderById.set(job.id, job);
  }

  for (const job of renderById.values()) {
    if (isQueued(job)) {
      const launched = Number(job.launchedAt || 0);
      if (launched > 0 && now - launched < LAUNCHED_GRACE_MS) continue;
      const beat = lastBeat(job);
      const created = Number(job.createdAt || 0);
      if (created > 0 && now - created < NEWBORN_MS && beat <= 0) continue;
      if (isFresh(beat, now, QUEUED_STALE_MS)) continue;
      console.warn(`[reclaim] failing stale queued render ${job.id}`);
      const { persistRenderFailure } = await import('../render');
      await persistRenderFailure(job.id, 'Worker never started — tap Build Master Cut again');
      continue;
    }
    if (isProcessing(job)) {
      const beat = lastBeat(job);
      const created = Number(job.createdAt || 0);
      if (created > 0 && now - created < NEWBORN_MS) continue;
      if (beat >= now) continue;
      if (beat > 0 && now - beat < PROCESSING_DEAD_MS) continue;
      if (beat <= 0) continue;
      console.warn(`[reclaim] failing dead processing render ${job.id}`);
      const { persistRenderFailure } = await import('../render');
      await persistRenderFailure(job.id, 'Render worker stalled — tap Build Master Cut again');
    }
  }

  const editById = new Map<string, HeartbeatJob>();
  for (const objectPath of [...editFiles, ...directorFiles]) {
    const job = await loadJson<HeartbeatJob>(objectPath);
    const id = job?.id || jobIdFromPath(objectPath);
    if (!job || !id) continue;
    job.id = id;
    const prev = editById.get(id);
    if (!prev || (job.updatedAt || 0) >= (prev.updatedAt || 0)) editById.set(id, job);
  }

  for (const job of editById.values()) {
    if (isQueued(job)) {
      const launched = Number(job.launchedAt || 0);
      if (launched > 0 && now - launched < LAUNCHED_GRACE_MS) continue;
      const beat = lastBeat(job);
      const created = Number(job.createdAt || 0);
      if (created > 0 && now - created < NEWBORN_MS && beat <= 0) continue;
      if (isFresh(beat, now, QUEUED_STALE_MS)) continue;
      console.warn(`[reclaim] failing stale queued director-edit ${job.id}`);
      const { persistDirectorEditFailure } = await import('../edit/directorEditJobs');
      await persistDirectorEditFailure(
        job.id,
        'Worker never started — tap AI Director Edit again'
      );
      continue;
    }
    if (isProcessing(job)) {
      const beat = lastBeat(job);
      const created = Number(job.createdAt || 0);
      if (created > 0 && now - created < NEWBORN_MS) continue;
      if (beat >= now) continue;
      if (beat > 0 && now - beat < PROCESSING_DEAD_MS) continue;
      if (beat <= 0) continue;
      console.warn(`[reclaim] failing dead processing director-edit ${job.id}`);
      const { persistDirectorEditFailure } = await import('../edit/directorEditJobs');
      await persistDirectorEditFailure(
        job.id,
        'Director Edit worker stalled — tap AI Director Edit again'
      );
    }
  }
}
