/**
 * Matte jobs: cut the person out of a take with RVM and place them on the scene's background.
 * Status lives at mattes/<id>/status.json (polled by the browser); the result is
 * matted/<projectId>/<sceneId>-<id>.mp4 next to the original take, which is never changed.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { GCS_BUCKET, getStorage, loadJson, saveJson } from './store';

export type MatteJobStatus = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  sourceGcsUri: string;
  backgroundUrl: string;
  aspectRatio?: string;
  projectId: string;
  sceneId: string;
  progress?: number;
  fps?: number;
  outputGcsUri?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt?: number;
};

const statusPath = (id: string) => `mattes/${id}/status.json`;

export async function readMatteStatus(id: string): Promise<MatteJobStatus | null> {
  return loadJson<MatteJobStatus>(statusPath(id));
}

async function writeStatus(s: MatteJobStatus): Promise<void> {
  const now = Date.now();
  await saveJson(statusPath(s.id), { ...s, updatedAt: now, heartbeatAt: now }, 'temp');
}

export async function createMatteJob(input: {
  sourceGcsUri: string;
  backgroundUrl: string;
  aspectRatio?: string;
  projectId: string;
  sceneId: string;
}): Promise<MatteJobStatus> {
  const now = Date.now();
  const job: MatteJobStatus = { id: `m-${randomUUID().slice(0, 12)}`, status: 'queued', ...input, createdAt: now, updatedAt: now };
  await writeStatus(job);
  return job;
}

function parseGs(uri: string): { bucket: string; object: string } | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m ? { bucket: m[1], object: m[2] } : null;
}

/** Background image to a local file: gs://, http(s):// or a data: URL. */
async function fetchBackground(url: string, dest: string): Promise<void> {
  const gs = parseGs(url);
  if (gs) {
    await getStorage()!.bucket(gs.bucket).file(gs.object).download({ destination: dest });
    return;
  }
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    await fs.writeFile(dest, Buffer.from(url.slice(comma + 1), url.slice(0, comma).includes('base64') ? 'base64' : 'utf8'));
    return;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Background download failed (${res.status})`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function executeMatteJob(id: string): Promise<void> {
  const job = await readMatteStatus(id);
  if (!job) throw new Error(`matte job ${id} not found`);
  if (job.status === 'done') return;
  const storage = getStorage();
  if (!storage) throw new Error('GCS_BUCKET not configured');
  const src = parseGs(job.sourceGcsUri);
  if (!src) throw new Error('sourceGcsUri must be gs://');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-matte-'));
  try {
    await writeStatus({ ...job, status: 'running', progress: 0 });
    const input = path.join(dir, 'take');
    const bg = path.join(dir, 'background');
    const output = path.join(dir, 'matted.mp4');
    await Promise.all([
      storage.bucket(src.bucket).file(src.object).download({ destination: input }),
      fetchBackground(job.backgroundUrl, bg),
    ]);

    const { matteVideo } = await import('../matting/rvm');
    let lastSave = 0;
    const result = await matteVideo({
      inputPath: input,
      backgroundPath: bg,
      outputPath: output,
      aspectRatio: job.aspectRatio,
      onProgress: (progress, fps) => {
        if (Date.now() - lastSave < 3000) return;
        lastSave = Date.now();
        void writeStatus({ ...job, status: 'running', progress, fps }).catch(() => {});
      },
    });
    console.log(`[matte] ${id}: ${result.frames} frames ${result.width}x${result.height} at ${result.fps.toFixed(1)} fps`);

    const object = `matted/${job.projectId}/${job.sceneId}-${id}.mp4`;
    await storage.bucket(GCS_BUCKET).upload(output, {
      destination: object,
      resumable: false,
      metadata: { contentType: 'video/mp4', metadata: { 'takeone-role': 'source' } },
    });
    await writeStatus({ ...job, status: 'done', progress: 1, fps: result.fps, outputGcsUri: `gs://${GCS_BUCKET}/${object}` });
  } catch (err: any) {
    await writeStatus({ ...job, status: 'failed', error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
