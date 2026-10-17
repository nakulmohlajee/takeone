/**
 * Media roles: source (immutable original), proxy (~480p), analysis, edits, final.
 * Legacy takes/{project}/{scene} remains readable.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { GCS_BUCKET, getStorage } from './store';

export const PROXY_PROFILE = 'p480';

export function sourceObjectKey(projectId: string, sceneId: string): string {
  return `source/${safe(projectId)}/${safe(sceneId)}`;
}

export function legacyTakeKey(projectId: string, sceneId: string): string {
  return `takes/${safe(projectId)}/${safe(sceneId)}`;
}

export function proxyObjectKey(projectId: string, sceneId: string, generation: string): string {
  return `proxy/${safe(projectId)}/${safe(sceneId)}/${safe(generation)}-${PROXY_PROFILE}.mp4`;
}

function safe(s: string): string {
  return String(s || 'x')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}

export function parseTakeKey(objectPath: string): { projectId: string; sceneId: string } | null {
  const cleaned = String(objectPath || '')
    .replace(/^gs:\/\/[^/]+\//, '')
    .replace(/^\/+/, '');
  const m = cleaned.match(/^(?:source|takes)\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { projectId: m[1], sceneId: m[2] };
}

export async function resolveSourceKey(projectId: string, sceneId: string): Promise<string | null> {
  const storage = getStorage();
  const preferred = sourceObjectKey(projectId, sceneId);
  const legacy = legacyTakeKey(projectId, sceneId);
  if (!storage || !GCS_BUCKET) return preferred;
  const [hasSource] = await storage.bucket(GCS_BUCKET).file(preferred).exists();
  if (hasSource) return preferred;
  const [hasLegacy] = await storage.bucket(GCS_BUCKET).file(legacy).exists();
  if (hasLegacy) return legacy;
  return preferred;
}

export async function getGeneration(objectPath: string): Promise<string> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return '0';
  try {
    const [meta] = await storage.bucket(GCS_BUCKET).file(objectPath).getMetadata();
    return String(meta.generation || '0');
  } catch {
    return '0';
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`ffmpeg proxy timed out: ${stderr.slice(-300)}`));
    }, timeoutMs);
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg proxy exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Build (or reuse) a 480p proxy for a source object. Returns gs:// URI.
 */
export async function ensureProxyForSource(
  sourcePathOrUri: string,
  opts?: { projectId?: string; sceneId?: string; durationSec?: number }
): Promise<string | null> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return null;
  const sourceKey = String(sourcePathOrUri || '')
    .replace(/^gs:\/\/[^/]+\//, '')
    .replace(/^\/+/, '');
  if (!sourceKey) return null;

  const parsed = parseTakeKey(sourceKey);
  const projectId = opts?.projectId || parsed?.projectId || 'anon';
  const sceneId = opts?.sceneId || parsed?.sceneId || 'scene';
  const generation = await getGeneration(sourceKey);
  const proxyKey = proxyObjectKey(projectId, sceneId, generation);
  const [exists] = await storage.bucket(GCS_BUCKET).file(proxyKey).exists();
  if (exists) return `gs://${GCS_BUCKET}/${proxyKey}`;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-proxy-'));
  const rawPath = path.join(workDir, 'src.bin');
  const outPath = path.join(workDir, 'proxy.mp4');
  try {
    await storage.bucket(GCS_BUCKET).file(sourceKey).download({ destination: rawPath });
    const timeoutMs = Math.max(180_000, Math.round(((opts?.durationSec || 60) * 4 + 60) * 1000));
    await runFfmpeg(
      [
        '-y',
        '-i',
        rawPath,
        '-vf',
        // Short-side 480 so landscape stays ~854x480 and portrait ~480x854 (analysis only).
        'scale=w=if(gt(iw\\,ih)\\,-2\\,480):h=if(gt(iw\\,ih)\\,480\\,-2)',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        outPath,
      ],
      timeoutMs
    );
    await storage.bucket(GCS_BUCKET).file(proxyKey).save(await fs.readFile(outPath), {
      contentType: 'video/mp4',
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=86400',
        metadata: { 'takeone-role': 'proxy', 'takeone-source': sourceKey },
      },
    });
    console.log(`[proxy] wrote gs://${GCS_BUCKET}/${proxyKey} from ${sourceKey}`);
    return `gs://${GCS_BUCKET}/${proxyKey}`;
  } catch (e: any) {
    console.warn('[proxy] failed:', e?.message || e);
    return null;
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function gsUri(objectPath: string): string {
  if (objectPath.startsWith('gs://')) return objectPath;
  return `gs://${GCS_BUCKET}/${objectPath}`;
}
