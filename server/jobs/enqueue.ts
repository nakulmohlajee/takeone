/**
 * Production: enqueue Cloud Run Job executions (scale-to-zero API, full CPU on workers).
 * Local / fallback: run workers in-process (npm run dev).
 */
import { GoogleGenAI } from '@google/genai';
import { configuredWorkerJobName, launchWorkerJob } from './cloudRunJobLaunch';
import { loadJson, saveJson } from './store';

export type WorkerKind = 'render' | 'director-edit' | 'reclaim' | 'matte';

function getAiClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || '',
    httpOptions: { headers: { 'User-Agent': 'takeone-worker-inline' } },
  });
}

/** Mark a queued job as launched so reclaim does not kill it during Cloud Run Job cold start. */
async function markJobLaunched(
  kind: WorkerKind,
  id: string | undefined,
  executionName: string
): Promise<void> {
  if (!id || kind === 'reclaim') return;
  const now = Date.now();
  const objectPath =
    kind === 'render'
      ? `renders/${id}/status.json`
      : kind === 'matte'
        ? `mattes/${id}/status.json`
        : `edits/${id}/status.json`;
  try {
    const existing = (await loadJson<Record<string, unknown>>(objectPath)) || { id };
    await saveJson(
      objectPath,
      {
        ...existing,
        id,
        launchedAt: now,
        executionName: executionName || undefined,
        heartbeatAt: now,
        updatedAt: now,
      },
      kind === 'render' || kind === 'matte' ? 'temp' : 'edit'
    );
  } catch (e: any) {
    console.warn(`[worker] failed to stamp launchedAt for ${kind}/${id}:`, e?.message || e);
  }
}

/** Run the worker on this API instance (local dev or fallback). */
export async function runInProcess(kind: WorkerKind, id?: string): Promise<void> {
  console.log(`[worker] in-process start kind=${kind} id=${id || '-'} pid=${process.pid}`);
  try {
    if (kind === 'render') {
      if (!id) throw new Error('render worker requires --id');
      const { executePersistedRender } = await import('../render');
      await executePersistedRender(id);
    } else if (kind === 'director-edit') {
      if (!id) throw new Error('director-edit worker requires --id');
      const { executePersistedDirectorEdit } = await import('../edit/directorEditJobs');
      await executePersistedDirectorEdit(getAiClient(), id);
    } else if (kind === 'matte') {
      if (!id) throw new Error('matte worker requires --id');
      const { executeMatteJob } = await import('./matte');
      await executeMatteJob(id);
    } else if (kind === 'reclaim') {
      const { reclaimOrphans } = await import('./reclaim');
      await reclaimOrphans();
    } else {
      throw new Error(`Unknown worker kind: ${kind}`);
    }
    console.log(`[worker] in-process done kind=${kind} id=${id || '-'}`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error(`[worker] in-process failed kind=${kind} id=${id || '-'}:`, msg);
    try {
      if (kind === 'render' && id) {
        const { persistRenderFailure } = await import('../render');
        await persistRenderFailure(id, msg || 'Worker failed');
      } else if (kind === 'director-edit' && id) {
        const { persistDirectorEditFailure } = await import('../edit/directorEditJobs');
        await persistDirectorEditFailure(id, msg || 'Worker failed');
      }
    } catch (persistErr: any) {
      console.error('[worker] failed to persist error status:', persistErr?.message || persistErr);
    }
  }
}

function shouldTryCloudRunJob(): boolean {
  if (process.env.TAKEONE_WORKER_INLINE === '1') return false;
  if (process.env.NODE_ENV !== 'production') return false;
  return configuredWorkerJobName() !== null;
}

async function enqueueCloudRunJob(kind: WorkerKind, id?: string): Promise<boolean> {
  const jobName = configuredWorkerJobName();
  const result = await launchWorkerJob(kind, id);
  if (result.ok) {
    console.log(
      `[worker] Cloud Run Job started job=${jobName} kind=${kind} id=${id || '-'} execution=${result.executionName || '(pending)'}`
    );
    await markJobLaunched(kind, id, result.executionName);
    return true;
  }
  console.warn(
    `[worker] Cloud Run Job launch failed job=${jobName} kind=${kind} id=${id || '-'}: ${result.error}`
  );
  return false;
}

/** Start background work (Cloud Run Job in production, in-process locally). */
export async function enqueueWorker(kind: WorkerKind, id?: string): Promise<void> {
  if (shouldTryCloudRunJob()) {
    const started = await enqueueCloudRunJob(kind, id);
    if (started) return;
    console.log(`[worker] falling back to in-process kind=${kind} id=${id || '-'}`);
  } else {
    const reason =
      process.env.TAKEONE_WORKER_INLINE === '1'
        ? 'TAKEONE_WORKER_INLINE=1'
        : process.env.NODE_ENV !== 'production'
          ? 'non-production'
          : 'TAKEONE_WORKER_JOB/CLOUD_RUN_JOB unset';
    console.log(`[worker] in-process enqueue (${reason}) kind=${kind} id=${id || '-'}`);
  }
  void runInProcess(kind, id);
}
