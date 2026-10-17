/**
 * Stage A Observe helpers: Vertex gs:// path, LOW media resolution,
 * GCS observation cache, and timing instrumentation.
 */
import { createHash } from 'crypto';
import { GoogleGenAI, MediaResolution } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import type { TakeObservation } from '../../src/types/editorial';

export const OBSERVE_PROMPT_VERSION = 'a1';
/** Gemini API (Files) model — matches prior Stage A. */
export const OBSERVE_MODEL = 'gemini-3.1-flash-lite';
/**
 * Vertex AI model for gs:// Observe. gemini-3.1-flash-lite is not published on
 * Vertex in us-central1; closest Flash-Lite available is gemini-2.5-flash-lite.
 */
export const OBSERVE_VERTEX_MODEL = 'gemini-2.5-flash-lite';
export const OBSERVE_CONCURRENCY = 3;
export const OBSERVE_MEDIA_RESOLUTION = MediaResolution.MEDIA_RESOLUTION_LOW;

const GCS_BUCKET = process.env.GCS_BUCKET || '';
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

export type ObservePath = 'cache' | 'gcs-direct' | 'files' | 'frames' | 'reuse' | 'heuristic';

export type ObserveTimings = {
  resolveMs: number;
  gcsMetaMs: number;
  uploadMs: number;
  waitActiveMs: number;
  generateMs: number;
  parseMs: number;
  totalMs: number;
  path: ObservePath;
  model: string;
  cacheHit: boolean;
};

export function emptyTimings(path: ObservePath = 'heuristic'): ObserveTimings {
  return {
    resolveMs: 0,
    gcsMetaMs: 0,
    uploadMs: 0,
    waitActiveMs: 0,
    generateMs: 0,
    parseMs: 0,
    totalMs: 0,
    path,
    model: OBSERVE_MODEL,
    cacheHit: false,
  };
}

let vertexClient: GoogleGenAI | null | undefined;

/** Vertex AI client for Stage A only (ADC). Lazy-init; null if unavailable. */
export function getVertexObserveClient(): GoogleGenAI | null {
  if (vertexClient !== undefined) return vertexClient;
  if (!GCP_PROJECT) {
    console.warn('[OBSERVE] VERTEX skip: GOOGLE_CLOUD_PROJECT not set');
    vertexClient = null;
    return null;
  }
  try {
    vertexClient = new GoogleGenAI({
      vertexai: true,
      project: GCP_PROJECT,
      location: VERTEX_LOCATION,
    });
    console.log(`[OBSERVE] Vertex client ready project=${GCP_PROJECT} location=${VERTEX_LOCATION}`);
    return vertexClient;
  } catch (err: any) {
    console.warn('[OBSERVE] Vertex client init failed:', err?.message || err);
    vertexClient = null;
    return null;
  }
}

function getStorage(): Storage | null {
  if (!GCS_BUCKET && !GCP_PROJECT) return null;
  return new Storage(GCP_PROJECT ? { projectId: GCP_PROJECT } : undefined);
}

/** Normalize scene path to gs://bucket/object */
export function toGsUri(pathOrUri: string): string | null {
  const s = String(pathOrUri || '').trim();
  if (!s || s.startsWith('blob:') || s.startsWith('data:')) return null;
  if (s.startsWith('gs://')) return s;
  if (s.startsWith('http://') || s.startsWith('https://')) return null;
  if (!GCS_BUCKET) return null;
  return `gs://${GCS_BUCKET}/${s.replace(/^\//, '')}`;
}

export function parseGsUri(gsUri: string): { bucket: string; object: string } | null {
  if (!gsUri.startsWith('gs://')) return null;
  const without = gsUri.slice(5);
  const slash = without.indexOf('/');
  if (slash < 0) return null;
  return { bucket: without.slice(0, slash), object: without.slice(slash + 1) };
}

export async function getGcsGeneration(gsUri: string): Promise<string> {
  const parsed = parseGsUri(gsUri);
  const storage = getStorage();
  if (!parsed || !storage) return '0';
  try {
    const [meta] = await storage.bucket(parsed.bucket).file(parsed.object).getMetadata();
    return String(meta.generation || meta.metageneration || '0');
  } catch {
    return '0';
  }
}

function cacheObjectKey(
  gsUri: string,
  generation: string,
  model: string
): string {
  const raw = [
    gsUri,
    generation,
    OBSERVE_PROMPT_VERSION,
    model,
    OBSERVE_MEDIA_RESOLUTION,
  ].join('|');
  const hash = createHash('sha256').update(raw).digest('hex');
  return `observe-cache/${hash}.json`;
}

export type ObserveCachePayload = {
  sourceId: string;
  gsUri: string;
  generation: string;
  duration: number;
  model: string;
  promptVersion: string;
  mediaResolution: string;
  nativeVideoAnalyzed: boolean;
  observation: TakeObservation;
  cachedAt: number;
};

export async function readObserveCache(
  gsUri: string,
  generation: string,
  model: string
): Promise<ObserveCachePayload | null> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return null;
  const key = cacheObjectKey(gsUri, generation, model);
  try {
    const [buf] = await storage.bucket(GCS_BUCKET).file(key).download();
    const parsed = JSON.parse(buf.toString('utf8')) as ObserveCachePayload;
    if (!parsed?.observation?.moments) return null;
    if (parsed.promptVersion !== OBSERVE_PROMPT_VERSION) return null;
    if (parsed.model !== model) return null;
    if (parsed.mediaResolution !== OBSERVE_MEDIA_RESOLUTION) return null;
    if (parsed.generation !== generation) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeObserveCache(payload: ObserveCachePayload): Promise<void> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return;
  const key = cacheObjectKey(payload.gsUri, payload.generation, payload.model);
  try {
    await storage.bucket(GCS_BUCKET).file(key).save(JSON.stringify(payload), {
      contentType: 'application/json',
      resumable: false,
      metadata: { cacheControl: 'private, max-age=86400' },
    });
  } catch (err: any) {
    console.warn('[OBSERVE] cache write failed:', err?.message || err);
  }
}

export function buildObservePrompt(
  title: string,
  duration: number,
  fullTranscript: string,
  silenceRanges: Array<{ start: number; end: number }>,
  seedMoments: Array<{ start: number; end: number; transcript?: string; momentType?: string }>,
  schema: string
): string {
  return `You are a video OBSERVER (not an editor). Watch this creator take titled "${title}" (${duration.toFixed(1)}s).

Your ONLY job: "What objectively happens in this video, and when?"

You are watching the ACTUAL VIDEO — use temporal understanding for shots and moments.

DO NOT:
- create an edit, keep/drop decisions, or EDL
- judge narrative importance, hook value, or project-wide usefulness
- recommend transitions, B-roll, sequence order, or a final hook
- use vague subjective labels like "beautiful" or "great"
- invent identities, locations, objects, dialogue, or events

DO:
- identify distinct visual shots with factual framing/camera/subject
- identify meaningful moments (speech beats, reactions, silence, filler, true mistakes, natural cut points, etc.)
- capture factual audio observations
- use "unknown" when evidence is insufficient
- Prefer a short accurate observation over a huge speculative JSON

IMPORTANT: Words like "cut", "action", "retake", "hold on" are production commands — do NOT mark them as mistakes.

Supporting transcript (may be incomplete — refine timing from video/audio):
"""${fullTranscript.slice(0, 4000)}"""

Seed silence ranges from FFmpeg (verify against audio):
${JSON.stringify(silenceRanges).slice(0, 1500)}

Seed moments (refine/split using what you SEE and HEAR — still observation only):
${JSON.stringify(seedMoments, null, 0).slice(0, 4000)}

Return JSON only matching this shape:
${schema}`;
}

/**
 * Observe via Vertex AI with gs:// URI + LOW media resolution.
 * Does not download the video to Cloud Run.
 */
function isRetryableVertexError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Resource exhausted') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('503')
  );
}

/** Cap concurrent Vertex video generates to reduce 429s (take pool stays at 3). */
let vertexInFlight = 0;
const vertexWaiters: Array<() => void> = [];
async function withVertexSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (vertexInFlight >= 2) {
    await new Promise<void>((resolve) => vertexWaiters.push(resolve));
  }
  vertexInFlight += 1;
  try {
    return await fn();
  } finally {
    vertexInFlight -= 1;
    const next = vertexWaiters.shift();
    if (next) next();
  }
}

export function stripJsonFences(text: string): string {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

export async function observeWithVertexGs(
  gsUri: string,
  mimeType: string,
  prompt: string
): Promise<{ text: string; model: string; generateMs: number }> {
  const vertex = getVertexObserveClient();
  if (!vertex) throw new Error('Vertex Observe client unavailable');

  const model = OBSERVE_VERTEX_MODEL;
  console.log(`[OBSERVE] vertex model=${model} mediaResolution=${OBSERVE_MEDIA_RESOLUTION}`);
  const t0 = Date.now();
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await withVertexSlot(() =>
        // Vertex requires Content.role = user|model (bare {parts} fails with INVALID_ARGUMENT).
        vertex.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: gsUri,
                    mimeType,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            mediaResolution: OBSERVE_MEDIA_RESOLUTION,
          },
        })
      );
      return {
        text: response.text || '',
        model,
        generateMs: Date.now() - t0,
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryableVertexError(err) || attempt === maxAttempts) break;
      const delayMs = Math.min(20_000, 1500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
      console.warn(
        `[OBSERVE] vertex retry attempt=${attempt}/${maxAttempts} delayMs=${delayMs}:`,
        (err as Error)?.message || err
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Simple async pool — concurrency limit, allSettled semantics. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try {
        const value = await worker(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => runOne()));
  return results;
}
