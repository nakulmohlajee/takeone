/**
 * Async Director Edit jobs — persist request, enqueue a worker, poll GCS.
 */
import { randomUUID } from 'crypto';
import { runDirectorEditPipeline } from './orchestrate';
import { enqueueWorker } from '../jobs/enqueue';
import { appendCost } from '../jobs/cost';
import { formatStageMessage } from '../jobs/stages';
import { ensureProxyForSource } from '../jobs/media';
import {
  clearProjectLock,
  editsPath,
  loadJson,
  readProjectLock,
  saveJson,
  writeProjectLock,
} from '../jobs/store';

export type DirectorEditJobStatus = 'queued' | 'running' | 'done' | 'error';
export type DirectorEditJobState = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type DirectorEditJob = {
  id: string;
  projectId: string;
  status: DirectorEditJobStatus;
  state: DirectorEditJobState;
  percent: number;
  stage: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  attempt?: number;
  error?: string;
  result?: Record<string, unknown>;
};

type AiClient = {
  files?: any;
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

export type DirectorEditRequest = {
  project: any;
  preset?: string;
  style?: string;
  maxCriticIterations?: number;
  mode?: 'analyze' | 'recut';
};

const jobs = new Map<string, DirectorEditJob>();
const projectLocks = new Map<string, string>();
const persistFlushAt = new Map<string, number>();
const persistStageKey = new Map<string, string>();
const persistTimer = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_MIN_MS = 2000;

function statusToState(status: DirectorEditJobStatus): DirectorEditJobState {
  if (status === 'done') return 'COMPLETED';
  if (status === 'error') return 'FAILED';
  if (status === 'queued') return 'QUEUED';
  return 'PROCESSING';
}

async function writeStatus(job: DirectorEditJob): Promise<void> {
  try {
    await saveJson(editsPath(job.id, 'status.json'), job, 'edit');
    persistFlushAt.set(job.id, Date.now());
  } catch (e: any) {
    console.warn('[director-edit-job] persist failed:', e?.message || e);
  }
}

async function persistJob(job: DirectorEditJob, opts?: { flush?: boolean }) {
  job.updatedAt = Date.now();
  job.heartbeatAt = Date.now();
  job.state = statusToState(job.status);
  jobs.set(job.id, job);

  const terminal = job.status === 'done' || job.status === 'error';
  const stageKey = `${job.status}:${job.stage}`;
  const stageChanged = persistStageKey.get(job.id) !== stageKey;
  persistStageKey.set(job.id, stageKey);
  const last = persistFlushAt.get(job.id) || 0;
  const due = Date.now() - last >= PERSIST_MIN_MS;

  if (terminal || opts?.flush || stageChanged || due) {
    const t = persistTimer.get(job.id);
    if (t) {
      clearTimeout(t);
      persistTimer.delete(job.id);
    }
    await writeStatus(job);
    return;
  }

  if (!persistTimer.has(job.id)) {
    persistTimer.set(
      job.id,
      setTimeout(() => {
        persistTimer.delete(job.id);
        const latest = jobs.get(job.id);
        if (latest) void writeStatus(latest);
      }, PERSIST_MIN_MS)
    );
  }
}

function pickFresherJob<T extends { status?: string; updatedAt?: number }>(
  fromGcs: T | null,
  cached: T | undefined
): T | null {
  if (fromGcs && cached) {
    const gcsDone = fromGcs.status === 'done' || fromGcs.status === 'error';
    const cacheDone = cached.status === 'done' || cached.status === 'error';
    if (gcsDone && !cacheDone) return fromGcs;
    if (cacheDone && !gcsDone) return cached;
    return (cached.updatedAt || 0) > (fromGcs.updatedAt || 0) ? cached : fromGcs;
  }
  return fromGcs || cached || null;
}

export async function loadDirectorEditJob(id: string): Promise<DirectorEditJob | null> {
  // GCS is source of truth — workers run in a separate Cloud Run Job instance.
  const fromGcs =
    (await loadJson<DirectorEditJob>(editsPath(id, 'status.json'))) ||
    (await loadJson<DirectorEditJob>(`director-edit/${id}/status.json`));
  const job = pickFresherJob(fromGcs, jobs.get(id));
  if (!job) return null;
  job.state = job.state || statusToState(job.status);
  job.heartbeatAt = job.heartbeatAt || job.updatedAt || job.createdAt;
  jobs.set(id, job);
  return job;
}

export async function persistDirectorEditFailure(id: string, error: string): Promise<void> {
  const job = (await loadDirectorEditJob(id)) || {
    id,
    projectId: 'unknown',
    status: 'error' as DirectorEditJobStatus,
    state: 'FAILED' as DirectorEditJobState,
    percent: 0,
    stage: 'error',
    message: error,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  job.status = 'error';
  job.state = 'FAILED';
  job.error = error;
  job.message = error;
  job.stage = 'error';
  await persistJob(job, { flush: true });
  if (job.projectId && job.projectId !== 'unknown') {
    await clearProjectLock('director-edit', job.projectId, id);
    if (projectLocks.get(job.projectId) === id) projectLocks.delete(job.projectId);
  }
}

function shapeSuccessResult(result: any, stages: Array<{ stage: string; message: string; percent: number }>) {
  const analyze = result.mode === 'analyze';
  return {
    ok: true,
    mode: result.mode || 'recut',
    editingStyleSummary: result.editingStyleSummary,
    scenes: (result.scenes || []).map((s: any) => {
      if (analyze) {
        // Analyze: intel + retimed transcripts only — never mutate in/out
        return {
          id: s.id,
          footageIntel: s.footageIntel,
          transcriptSegments: s.transcriptSegments,
        };
      }
      return {
        id: s.id,
        transition: s.transition || 'cut',
        transitionDuration: s.transitionDuration ?? 0.35,
        lowerThird: s.lowerThird,
        motionGraphic: s.motionGraphic || 'none',
        audioDenoise: true,
        voiceBoost: true,
        inPoint: s.inPoint,
        outPoint: s.outPoint,
        userTrimLocked: Boolean(s.userTrimLocked),
        editRole: s.editRole,
        editZoom: s.editZoom,
        footageIntel: s.footageIntel,
        transcript: s.transcript,
        transcriptSegments: s.transcriptSegments,
      };
    }),
    channelSettings: result.channelSettings,
    editPlan: analyze ? undefined : result.editPlan,
    story: result.story,
    brief: result.brief,
    observation: result.observation,
    projectUnderstanding: result.projectUnderstanding,
    critic: result.critic
      ? {
          summary: result.critic.summary,
          approve: result.critic.approve,
          issueCount: result.critic.issues?.length ?? 0,
          issues: result.critic.issues?.slice(0, 12),
        }
      : undefined,
    insights: result.insights || [],
    iterations: result.iterations,
    stages,
    criticSummary: result.critic?.summary,
    criticIssueCount: result.critic?.issues?.length ?? 0,
    directorLog: result.directorLog || [],
    criticWatchedRoughCut: Boolean(result.criticWatchedRoughCut),
  };
}

function prepareProject(project: any): { ok: true; project: any } | { ok: false; error: string; stage?: string; status: number } {
  if (!project || !project.scenes || project.scenes.length === 0) {
    return { ok: false, error: 'Valid project with scenes is required', status: 400 };
  }

  const hasTakes = (project.scenes || []).some(
    (s: any) => s.filmedBy === 'user' && (s.userRecordedVideoUrl || s.gcsObjectPath)
  );
  if (!hasTakes) {
    return {
      ok: false,
      error:
        'No recorded or imported takes found. Film scenes or import footage before running the AI director edit.',
      status: 400,
    };
  }

  const blobTakes = (project.scenes || []).filter((s: any) => {
    if (s.filmedBy && s.filmedBy !== 'user') return false;
    const path = String(s.gcsObjectPath || '');
    const url = String(s.userRecordedVideoUrl || '');
    const hasDurable =
      path.startsWith('gs://') || (path && !path.startsWith('blob:') && !path.startsWith('data:'));
    if (hasDurable) return false;
    return (
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      path.startsWith('blob:') ||
      path.startsWith('data:')
    );
  });
  if (blobTakes.length) {
    return {
      ok: false,
      error: `${blobTakes.length} take(s) are still browser-only (blob:). Save takes to cloud storage before Director Edit.`,
      stage: 'observe',
      status: 400,
    };
  }

  project.scenes = (project.scenes || []).map((s: any) => {
    if (s.filmedBy && s.filmedBy !== 'user') return s;
    if (s.gcsObjectPath) {
      return {
        ...s,
        userRecordedVideoUrl:
          typeof s.userRecordedVideoUrl === 'string' &&
          !s.userRecordedVideoUrl.startsWith('blob:') &&
          !s.userRecordedVideoUrl.startsWith('data:')
            ? s.userRecordedVideoUrl
            : s.gcsObjectPath,
      };
    }
    return s;
  });

  return { ok: true, project };
}

export type StartDirectorEditResult =
  | { ok: true; jobId: string; status: DirectorEditJobStatus; resumed?: boolean }
  | { ok: false; error: string; status: number; stage?: string; existingJobId?: string };

async function findExistingJob(projectId: string): Promise<DirectorEditJob | null> {
  const memId = projectLocks.get(projectId);
  const gcsLock = await readProjectLock('director-edit', projectId);
  const jobId = memId || gcsLock?.jobId;
  if (!jobId) return null;
  const existing = await loadDirectorEditJob(jobId);
  const beat = Number(existing?.heartbeatAt || existing?.updatedAt || 0);
  const activelyRunning =
    existing?.status === 'running' &&
    beat > 0 &&
    Date.now() - beat < 60_000;
  if (activelyRunning) {
    return existing;
  }
  // Queued / error / done / stale — do not resume; start a new job.
  projectLocks.delete(projectId);
  await clearProjectLock('director-edit', projectId, jobId);
  return null;
}

export async function startDirectorEditJob(
  _ai: AiClient,
  body: {
    project: any;
    preset?: string;
    style?: string;
    maxCriticIterations?: number;
    mode?: 'analyze' | 'recut';
  }
): Promise<StartDirectorEditResult> {
  const prepared = prepareProject(body.project);
  if (!prepared.ok) {
    return {
      ok: false,
      error: prepared.error,
      status: prepared.status,
      stage: prepared.stage,
    };
  }
  const project = prepared.project;
  const projectId = String(project.id || project.projectId || 'anonymous');

  const existing = await findExistingJob(projectId);
  if (existing) {
    projectLocks.set(projectId, existing.id);
    return { ok: true, jobId: existing.id, status: existing.status, resumed: true };
  }

  const strategy =
    project?.captureStrategy || project?.creativeBrief?.captureStrategy || '';
  const mode: 'analyze' | 'recut' =
    body.mode === 'analyze' || body.mode === 'recut'
      ? body.mode
      : strategy === 'single_take'
        ? 'analyze'
        : 'recut';

  const id = randomUUID();
  const job: DirectorEditJob = {
    id,
    projectId,
    status: 'queued',
    state: 'QUEUED',
    percent: 0,
    stage: 'queued',
    message: mode === 'analyze' ? 'Queued (Analyze)' : 'Queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeatAt: Date.now(),
    attempt: 0,
  };
  projectLocks.set(projectId, id);
  await persistJob(job);
  await writeProjectLock('director-edit', projectId, id);
  await saveJson(
    editsPath(id, 'request.json'),
    {
      project,
      preset: body.preset,
      style: body.style,
      maxCriticIterations: Math.min(3, Math.max(1, Number(body.maxCriticIterations) || 2)),
      mode,
    } satisfies DirectorEditRequest,
    'edit'
  );
  await enqueueWorker('director-edit', id);
  return { ok: true, jobId: id, status: job.status };
}

export async function executePersistedDirectorEdit(ai: AiClient, jobId: string): Promise<void> {
  const job = await loadDirectorEditJob(jobId);
  if (!job) throw new Error(`Director edit job ${jobId} not found`);
  if (job.status === 'done' || job.status === 'error') return;

  const beat = Number(job.heartbeatAt || job.updatedAt || 0);
  const status = String(job.status || '').toLowerCase();
  if (
    (status === 'running' || status === 'uploading') &&
    beat > 0 &&
    Date.now() - beat < 60_000 &&
    job.percent > 0
  ) {
    console.log(`[director-edit] skip ${jobId} — already claimed (status=${job.status})`);
    return;
  }

  const request = await loadJson<DirectorEditRequest>(editsPath(jobId, 'request.json'));
  if (!request?.project) throw new Error(`Director edit request missing for ${jobId}`);

  const projectId = job.projectId;
  job.attempt = (job.attempt || 0) + 1;
  job.status = 'running';
  job.state = 'PROCESSING';
  job.stage = 'uploading';
  job.message = formatStageMessage('uploading', 'Preparing footage…');
  job.percent = 2;
  job.heartbeatAt = Date.now();
  job.updatedAt = Date.now();
  await persistJob(job);
  projectLocks.set(projectId, jobId);

  const stages: Array<{ stage: string; message: string; percent: number }> = [];

  try {
    for (const scene of request.project.scenes || []) {
      if (scene.filmedBy && scene.filmedBy !== 'user') continue;
      const source = scene.gcsObjectPath || scene.userRecordedVideoUrl;
      if (!source) continue;
      const proxy = await ensureProxyForSource(source, {
        projectId,
        sceneId: scene.id,
        durationSec: scene.recordedDuration || scene.durationSeconds,
      });
      if (proxy) scene.proxyUrl = proxy;
    }

    const result = await runDirectorEditPipeline(ai, request.project, {
      preset: request.preset,
      style: request.style,
      maxCriticIterations: request.maxCriticIterations,
      mode: request.mode,
      jobId,
      onProgress: (stage, message, percent) => {
        stages.push({ stage, message, percent });
        job.status = 'running';
        job.stage = stage;
        job.message = formatStageMessage(stage, message);
        job.percent = percent;
        console.log(`[director-edit] ${percent}% ${stage}: ${message}`);
        void persistJob(job);
      },
    });

    if (!result.ok) {
      job.status = 'error';
      job.error = result.error || 'Director edit failed';
      job.stage = result.stage || job.stage;
      job.message = job.error;
      job.result = { ok: false, error: job.error, stage: job.stage, stages };
      await persistJob(job);
      return;
    }

    job.status = 'done';
    job.percent = 100;
    job.stage = 'final';
    job.message = result.editingStyleSummary || 'Director edit ready';
    job.result = shapeSuccessResult(result, stages);
    await persistJob(job);
    await appendCost({
      ts: Date.now(),
      jobId,
      kind: 'director-edit',
      event: 'complete',
      criticCalls: result.iterations,
      extra: { watchedRough: result.criticWatchedRoughCut },
    });
  } catch (err: any) {
    console.error('Director edit job error:', err);
    const errMsg = String(err?.message || 'Director edit failed');
    job.status = 'error';
    job.error = errMsg;
    job.message = errMsg;
    job.result = { ok: false, error: errMsg, stages };
    await persistJob(job);
  } finally {
    if (projectLocks.get(projectId) === jobId) projectLocks.delete(projectId);
    await clearProjectLock('director-edit', projectId, jobId);
  }
}

/** Wait for a job to finish (legacy sync alias). */
export async function waitForDirectorEditJob(
  jobId: string,
  timeoutMs = 55 * 60_000
): Promise<DirectorEditJob> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await loadDirectorEditJob(jobId);
    if (!job) throw new Error('Director edit job not found');
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Director edit timed out');
}
