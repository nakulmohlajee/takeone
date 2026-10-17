/**
 * GCS JSON helpers for durable jobs, checkpoints, and locks.
 */
import { Storage } from '@google-cloud/storage';

export const GCS_BUCKET = process.env.GCS_BUCKET || '';
export const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';

export function getStorage() {
  if (!GCS_BUCKET) return null;
  return new Storage(GCP_PROJECT ? { projectId: GCP_PROJECT } : undefined);
}

export type MediaRole = 'source' | 'proxy' | 'analysis' | 'edit' | 'final' | 'temp';

export async function saveJson(
  objectPath: string,
  data: unknown,
  role: MediaRole = 'edit'
): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  await storage.bucket(GCS_BUCKET).file(objectPath).save(JSON.stringify(data), {
    contentType: 'application/json',
    resumable: false,
    metadata: {
      metadata: { 'takeone-role': role },
    },
  });
}

export async function loadJson<T>(objectPath: string): Promise<T | null> {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const [buf] = await storage.bucket(GCS_BUCKET).file(objectPath).download();
    return JSON.parse(buf.toString()) as T;
  } catch {
    return null;
  }
}

export async function saveText(
  objectPath: string,
  body: string,
  contentType: string,
  role: MediaRole = 'edit'
): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  await storage.bucket(GCS_BUCKET).file(objectPath).save(body, {
    contentType,
    resumable: false,
    metadata: {
      metadata: { 'takeone-role': role },
    },
  });
}

export async function existsObject(objectPath: string): Promise<boolean> {
  const storage = getStorage();
  if (!storage) return false;
  const [exists] = await storage.bucket(GCS_BUCKET).file(objectPath).exists();
  return exists;
}

export function editsPath(jobId: string, name: string): string {
  return `edits/${jobId}/${name}`;
}

export function rendersPath(jobId: string, name: string): string {
  return `renders/${jobId}/${name}`;
}

export function lockPath(kind: 'director-edit' | 'render', projectId: string): string {
  return `locks/${kind}/${projectId}.json`;
}

export type ProjectLock = {
  jobId: string;
  projectId: string;
  kind: 'director-edit' | 'render';
  createdAt: number;
};

export async function readProjectLock(
  kind: 'director-edit' | 'render',
  projectId: string
): Promise<ProjectLock | null> {
  return loadJson<ProjectLock>(lockPath(kind, projectId));
}

export async function writeProjectLock(
  kind: 'director-edit' | 'render',
  projectId: string,
  jobId: string
): Promise<void> {
  await saveJson(lockPath(kind, projectId), {
    jobId,
    projectId,
    kind,
    createdAt: Date.now(),
  } satisfies ProjectLock);
}

export async function clearProjectLock(
  kind: 'director-edit' | 'render',
  projectId: string,
  jobId?: string
): Promise<void> {
  const existing = await readProjectLock(kind, projectId);
  if (jobId && existing && existing.jobId !== jobId) return;
  const storage = getStorage();
  if (!storage) return;
  try {
    await storage.bucket(GCS_BUCKET).file(lockPath(kind, projectId)).delete({ ignoreNotFound: true });
  } catch {
    /* ignore */
  }
}
