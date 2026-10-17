/**
 * Word-level speech-to-text via Google Cloud Speech.
 *
 * Preference order:
 *   1. Speech v2 `chirp_3` in the `us` multi-region — inline for ≤60s, batchRecognize via GCS for longer.
 *      Language is auto-detected (it handles Hindi, Indian English and Hinglish, and gives accurate word
 *      timings — an explicit English locale shifts timings early on clips with leading silence). If the
 *      detected language disagrees with the one the creator chose, it retries with that locale.
 *      (chirp_2 was withdrawn from us-central1; chirp rejects word-confidence — both failed silently.)
 *   2. Speech v1 `latest_long` with enableWordTimeOffsets + automatic punctuation
 *
 * Words are never discarded — every engine path returns them when the API provided them.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { v1 as speechV1, v2 as speechV2 } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import { toSttLanguageCode } from '../../src/utils/spokenLanguage';

export type SpeechWord = { w: string; start: number; end: number; conf?: number };
export type SpeechSegment = { start: number; end: number; text: string };

export type TranscribeWithWordsResult = {
  transcript: string;
  words: SpeechWord[];
  segments: SpeechSegment[];
  engine: string;
};

export type TranscribeWithWordsOpts = {
  gcsUri?: string;
  localPath?: string;
  languageCode?: string;
  durationSec?: number;
};

const CHIRP_LOCATION = process.env.SPEECH_V2_LOCATION || 'us';
const CHIRP_MODELS = (process.env.CHIRP_MODELS || 'chirp_3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SYNC_MAX_SEC = 60;
const INLINE_MAX_BYTES = 9 * 1024 * 1024;
/** Long takes are cut into pieces this long and recognised in parallel (batch can take minutes). */
const CHUNK_SEC = 50;
/** Each piece reaches this far into its neighbours so a word on the cut is heard whole. */
const CHUNK_PAD_SEC = 1;
const CHUNK_MAX_COUNT = 24;
const CHUNK_CONCURRENCY = 4;
/** A sync Chirp call normally answers in a few seconds; past this, fall back instead of hanging. */
const SYNC_CALL_TIMEOUT_MS = 40_000;
const BATCH_TIMEOUT_MS = 150_000;

function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* ───────────────────────── ffmpeg helpers ───────────────────────── */

function runFfmpeg(args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Extract 16 kHz mono FLAC from any audio/video file. Rejects when no audio stream exists. */
export async function extractAudioFlac(inputPath: string, outPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'flac',
    outPath,
  ]);
}

async function probeDurationSec(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) ? d : 0);
    });
  });
}

/* ───────────────────────── generic helpers ───────────────────────── */

function durToSec(d: any): number {
  if (d == null) return 0;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d) || 0;
  const rawSec = d.seconds;
  let sec = 0;
  if (rawSec != null) {
    if (typeof rawSec === 'object' && typeof rawSec.toNumber === 'function') sec = rawSec.toNumber();
    else sec = Number(rawSec) || 0;
  }
  return sec + (Number(d.nanos) || 0) / 1e9;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function parseGcsUri(uri: string): { bucket: string; object: string } | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m ? { bucket: m[1], object: m[2] } : null;
}

function getStorage(): Storage {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
  return new Storage(projectId ? { projectId } : undefined);
}

function sttLang(languageCode?: string): string {
  return toSttLanguageCode(languageCode || 'en');
}

/** Convert a Speech alternative's words (v1 or v2 shapes) to SpeechWord. */
function mapWords(rawWords: any[] | undefined | null): SpeechWord[] {
  if (!Array.isArray(rawWords)) return [];
  const out: SpeechWord[] = [];
  for (const w of rawWords) {
    const text = String(w?.word ?? '').trim();
    if (!text) continue;
    const start = durToSec(w.startOffset ?? w.startTime);
    const end = durToSec(w.endOffset ?? w.endTime);
    const word: SpeechWord = {
      w: text,
      start: round3(start),
      end: round3(end > start ? end : start + 0.05),
    };
    if (typeof w.confidence === 'number' && w.confidence > 0) word.conf = round3(w.confidence);
    out.push(word);
  }
  return out;
}

/** Collect transcript + words from Speech results (v1 / v2 both use results[].alternatives[]). */
function collectResults(results: any[] | undefined | null): {
  transcript: string;
  words: SpeechWord[];
  language?: string;
} {
  const parts: string[] = [];
  const words: SpeechWord[] = [];
  const langCount = new Map<string, number>();
  for (const r of results || []) {
    const lc = String(r?.languageCode || '').toLowerCase();
    if (lc) langCount.set(lc, (langCount.get(lc) || 0) + 1);
    const alt = r?.alternatives?.[0];
    if (!alt) continue;
    const t = String(alt.transcript || '').trim();
    if (t) parts.push(t);
    words.push(...mapWords(alt.words));
  }
  words.sort((a, b) => a.start - b.start);
  const language = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { transcript: parts.join(' ').replace(/\s+/g, ' ').trim(), words, language };
}

/** Group words into ~2–4 s phrases, breaking on sentence punctuation or long pauses. */
export function buildSegmentsFromWords(words: SpeechWord[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let cur: SpeechWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    segments.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur
        .map((x) => x.w)
        .join(' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .trim(),
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.8) flush();
    cur.push(w);
    const dur = w.end - cur[0].start;
    const sentenceEnd = /[.!?…。！？]["')\]]?$/.test(w.w);
    const clauseEnd = /[,;:，、]$/.test(w.w);
    if ((sentenceEnd && dur >= 1.2) || dur >= 4 || (clauseEnd && dur >= 2.8)) flush();
  }
  flush();
  return segments;
}

function emptyResult(engine: string): TranscribeWithWordsResult {
  return { transcript: '', words: [], segments: [], engine };
}

function finalize(transcript: string, words: SpeechWord[], engine: string): TranscribeWithWordsResult {
  const text = transcript || words.map((w) => w.w).join(' ');
  return { transcript: text.trim(), words, segments: buildSegmentsFromWords(words), engine };
}

async function resolveProjectId(client: { getProjectId(): Promise<string> }): Promise<string> {
  const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  if (env) return env;
  return client.getProjectId();
}

/* ───────────────────────── GCS staging ───────────────────────── */

async function stageFlacToGcs(
  flacPath: string,
  preferredBucket?: string,
): Promise<{ uri: string; cleanup: () => Promise<void> } | null> {
  const bucket = preferredBucket || process.env.GCS_BUCKET || '';
  if (!bucket) return null;
  const object = `tmp/stt/${Date.now()}-${randomUUID().slice(0, 8)}.flac`;
  const storage = getStorage();
  await storage.bucket(bucket).upload(flacPath, { destination: object, contentType: 'audio/flac' });
  return {
    uri: `gs://${bucket}/${object}`,
    cleanup: async () => {
      try {
        await storage.bucket(bucket).file(object).delete({ ignoreNotFound: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Generated gapic clients re-throw initialize() failures as unhandled rejections when credentials are
 * missing, which would crash the process. Verify ADC first (negative result cached briefly).
 */
let credsCheck: { ok: boolean; error?: string; at: number } | null = null;
async function assertSpeechCredentials(): Promise<void> {
  const now = Date.now();
  if (credsCheck && (credsCheck.ok || now - credsCheck.at < 30_000)) {
    if (credsCheck.ok) return;
    throw new Error(credsCheck.error || 'Google Cloud credentials unavailable');
  }
  try {
    await getStorage().authClient.getClient();
    credsCheck = { ok: true, at: now };
  } catch (err: any) {
    credsCheck = { ok: false, error: String(err?.message || err).slice(0, 200), at: now };
    throw new Error(`Google Cloud credentials unavailable: ${credsCheck.error}`);
  }
}

/* ───────────────────────── Speech v2 (Chirp) ───────────────────────── */

/**
 * Pieces of a long FLAC recognised with the fast sync API. Each piece keeps the words that start
 * in its own window, so the padded overlaps never double a word. Null when too long to chunk.
 */
export async function recognizeInChunks(
  client: any,
  recognizer: string,
  config: any,
  flacPath: string,
): Promise<{ transcript: string; words: SpeechWord[]; language?: string } | null> {
  const total = await probeDurationSec(flacPath);
  if (!total) return null;
  const count = Math.ceil(total / CHUNK_SEC);
  if (count < 2 || count > CHUNK_MAX_COUNT) return null;
  const dir = path.dirname(flacPath);
  const pieces = Array.from({ length: count }, (_, i) => ({
    i,
    from: i * CHUNK_SEC,
    to: i === count - 1 ? Infinity : (i + 1) * CHUNK_SEC,
    start: Math.max(0, i * CHUNK_SEC - CHUNK_PAD_SEC),
  }));
  const out: Array<{ words: SpeechWord[]; language?: string }> = new Array(count);
  const queue = [...pieces];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()!;
      const file = path.join(dir, `chunk-${p.i}.flac`);
      await runFfmpeg([
        '-y',
        '-ss',
        String(p.start),
        '-t',
        String(CHUNK_SEC + 2 * CHUNK_PAD_SEC),
        '-i',
        flacPath,
        '-c:a',
        'flac',
        file,
      ]);
      const content = await fs.readFile(file);
      if (content.length > INLINE_MAX_BYTES) throw new Error('chunk too large for sync recognize');
      const [resp] = await timed<any>(client.recognize({ recognizer, config, content } as any), SYNC_CALL_TIMEOUT_MS, 'Chirp');
      const { words, language } = collectResults(resp.results as any[]);
      out[p.i] = {
        language,
        words: words
          .map((w) => ({ ...w, start: round3(w.start + p.start), end: round3(w.end + p.start) }))
          .filter((w) => w.start >= p.from && w.start < p.to),
      };
      await fs.rm(file, { force: true }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, count) }, worker));
  const words = out.flatMap((o) => o.words).sort((a, b) => a.start - b.start);
  const langCount = new Map<string, number>();
  for (const o of out) if (o.language) langCount.set(o.language, (langCount.get(o.language) || 0) + 1);
  const language = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { transcript: words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim(), words, language };
}

async function chirpV2(
  flacPath: string,
  durationSec: number,
  languageCode: string,
  gcsBucketHint?: string,
): Promise<TranscribeWithWordsResult> {
  const client = new speechV2.SpeechClient({
    apiEndpoint: `${CHIRP_LOCATION}-speech.googleapis.com`,
  });
  const projectId = await resolveProjectId(client as any);
  const recognizer = `projects/${projectId}/locations/${CHIRP_LOCATION}/recognizers/_`;
  const lang = sttLang(languageCode);
  let lastErr: any;

  try {
    const expectedBase = lang.split('-')[0].toLowerCase();
    for (const model of CHIRP_MODELS) {
      const attempt = async (languageCodes: string[]): Promise<TranscribeWithWordsResult & { detected?: string }> => {
        const config = {
          autoDecodingConfig: {},
          languageCodes,
          model,
          features: {
            enableWordTimeOffsets: true,
            enableAutomaticPunctuation: true,
          },
        };
        const tag = `chirp:${model}:${languageCodes[0]}`;
        const size = (await fs.stat(flacPath)).size;
        if (durationSec <= SYNC_MAX_SEC && size <= INLINE_MAX_BYTES) {
          const content = await fs.readFile(flacPath);
          const [resp] = await timed<any>(client.recognize({ recognizer, config, content } as any), SYNC_CALL_TIMEOUT_MS, 'Chirp');
          const { transcript, words, language } = collectResults(resp.results as any[]);
          if (!words.length && !transcript) return { ...emptyResult(tag), detected: language };
          if (!words.length) throw new Error(`${model} returned transcript without word offsets`);
          return { ...finalize(transcript, words, tag), detected: language };
        }

        // Long audio → recognise ~50 s pieces in parallel (seconds), batch only as a fallback.
        try {
          const chunked = await recognizeInChunks(client, recognizer, config, flacPath);
          if (chunked) {
            if (!chunked.words.length && !chunked.transcript) return { ...emptyResult(tag), detected: chunked.language };
            if (chunked.words.length) return { ...finalize(chunked.transcript, chunked.words, `${tag}:chunked`), detected: chunked.language };
          }
        } catch (err: any) {
          console.warn(`[chirp] chunked recognize failed, using batch:`, String(err?.message || err).slice(0, 200));
        }

        // Batch from GCS with inline results
        const staged = await stageFlacToGcs(flacPath, gcsBucketHint);
        if (!staged) throw new Error('GCS_BUCKET not configured for long-running Chirp batch');
        try {
          const [op] = await client.batchRecognize({
            recognizer,
            config,
            files: [{ uri: staged.uri }],
            recognitionOutputConfig: { inlineResponseConfig: {} },
          } as any);
          const [resp] = await timed<any>(op.promise(), BATCH_TIMEOUT_MS, 'Chirp batch');
          const fileResult: any = Object.values((resp as any).results || {})[0];
          if (fileResult?.error?.message) throw new Error(fileResult.error.message);
          const inline = fileResult?.inlineResult?.transcript || fileResult?.transcript;
          const { transcript, words, language } = collectResults(inline?.results);
          if (!words.length && !transcript) return { ...emptyResult(tag), detected: language };
          if (!words.length) throw new Error(`${model} batch returned transcript without word offsets`);
          return { ...finalize(transcript, words, tag), detected: language };
        } finally {
          await staged.cleanup();
        }
      };

      try {
        const auto = await attempt(['auto']);
        const detectedBase = (auto.detected || '').split('-')[0];
        // A non-English language is a deliberate choice (English is just the default, and people
        // often type the idea in English but speak Hindi). If auto heard something else, trust
        // the creator's choice.
        if (detectedBase && expectedBase && expectedBase !== 'en' && detectedBase !== expectedBase) {
          console.warn(`[chirp] auto detected "${auto.detected}" but expected "${lang}" — retrying with ${lang}`);
          try {
            const forced = await attempt([lang]);
            if (forced.words.length) return forced;
          } catch (err: any) {
            console.warn(`[chirp] ${model} ${lang} retry failed:`, String(err?.message || err).slice(0, 200));
          }
        }
        return auto;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[chirp] ${model} failed:`, String(err?.message || err).slice(0, 240));
      }
    }
    throw lastErr || new Error('Chirp unavailable');
  } finally {
    try {
      await (client as any).close?.();
    } catch {
      /* ignore */
    }
  }
}

/* ───────────────────────── Speech v1 fallback ───────────────────────── */

async function speechV1Latest(
  flacPath: string,
  durationSec: number,
  languageCode: string,
  gcsBucketHint?: string,
): Promise<TranscribeWithWordsResult> {
  const client = new speechV1.SpeechClient();
  const config = {
    encoding: 'FLAC' as const,
    sampleRateHertz: 16000,
    audioChannelCount: 1,
    languageCode: sttLang(languageCode),
    model: 'latest_long',
    enableWordTimeOffsets: true,
    enableWordConfidence: true,
    enableAutomaticPunctuation: true,
  };
  const size = (await fs.stat(flacPath)).size;

  if (durationSec <= SYNC_MAX_SEC && size <= INLINE_MAX_BYTES) {
    const content = (await fs.readFile(flacPath)).toString('base64');
    const [resp] = await timed<any>(client.recognize({ config, audio: { content } } as any), SYNC_CALL_TIMEOUT_MS, 'Speech v1');
    const { transcript, words } = collectResults(resp.results as any[]);
    return finalize(transcript, words, 'speech-v1:latest_long');
  }

  const staged = await stageFlacToGcs(flacPath, gcsBucketHint);
  let audio: any;
  if (staged) audio = { uri: staged.uri };
  else if (size <= INLINE_MAX_BYTES) audio = { content: (await fs.readFile(flacPath)).toString('base64') };
  else throw new Error('Audio too long for inline recognition and GCS_BUCKET is not configured');

  try {
    const [op] = await client.longRunningRecognize({ config, audio } as any);
    const [resp] = await op.promise();
    const { transcript, words } = collectResults(resp.results as any[]);
    return finalize(transcript, words, 'speech-v1:latest_long');
  } finally {
    await staged?.cleanup();
  }
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Transcribe with word timestamps. Throws only when every Speech engine fails
 * (callers should then fall back to Gemini). Silence returns an empty result.
 */
/**
 * The same take is often transcribed twice at once (the shoot's own request and the cut's word
 * check): share one run per file + language, and reuse the result for a few minutes.
 */
const inFlight = new Map<string, { at: number; p: Promise<TranscribeWithWordsResult> }>();
const SHARE_MS = 10 * 60_000;

export async function transcribeWithWords(opts: TranscribeWithWordsOpts): Promise<TranscribeWithWordsResult> {
  const parsed = opts.gcsUri ? parseGcsUri(opts.gcsUri) : null;
  if (!parsed) return transcribeWithWordsOnce(opts);
  // A redo is uploaded to the same path: the object's generation tells the two apart.
  let generation = '';
  try {
    const [meta] = await getStorage().bucket(parsed.bucket).file(parsed.object).getMetadata();
    generation = String(meta?.generation || '');
  } catch {
    return transcribeWithWordsOnce(opts);
  }
  const key = `${opts.gcsUri}|${generation}|${opts.languageCode || ''}`;
  const now = Date.now();
  for (const [k, v] of inFlight) if (now - v.at > SHARE_MS) inFlight.delete(k);
  const hit = inFlight.get(key);
  if (hit) return hit.p;
  const p = transcribeWithWordsOnce(opts);
  inFlight.set(key, { at: now, p });
  p.catch(() => inFlight.delete(key));
  return p;
}

async function transcribeWithWordsOnce(opts: TranscribeWithWordsOpts): Promise<TranscribeWithWordsResult> {
  if (!opts.localPath && !opts.gcsUri) throw new Error('localPath or gcsUri is required');
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-chirp-'));
  try {
    let local = opts.localPath || '';
    let bucketHint: string | undefined;
    const parsed = opts.gcsUri ? parseGcsUri(opts.gcsUri) : null;
    if (parsed) bucketHint = parsed.bucket;

    if (!local) {
      if (!parsed) throw new Error('gcsUri must look like gs://bucket/object');
      local = path.join(workDir, `source${path.extname(parsed.object) || '.mp4'}`);
      await getStorage().bucket(parsed.bucket).file(parsed.object).download({ destination: local });
    }

    const flacPath = path.join(workDir, 'audio.flac');
    try {
      await extractAudioFlac(local, flacPath);
    } catch (err: any) {
      // No audio stream → treat as silence, not an engine failure
      if (/does not contain any stream|matches no streams|Stream map/i.test(String(err?.message))) {
        return emptyResult('none');
      }
      throw err;
    }

    const durationSec =
      opts.durationSec && opts.durationSec > 0 ? opts.durationSec : await probeDurationSec(flacPath);

    await assertSpeechCredentials();

    let chirpErr: any;
    try {
      const res = await chirpV2(flacPath, durationSec, opts.languageCode || 'en', bucketHint);
      return res;
    } catch (err: any) {
      chirpErr = err;
      console.warn(
        '[chirp] falling back to Speech v1 latest_long:',
        String(err?.message || err).slice(0, 200),
      );
    }

    try {
      return await speechV1Latest(flacPath, durationSec, opts.languageCode || 'en', bucketHint);
    } catch (err: any) {
      throw new Error(
        `Speech engines failed — chirp: ${String(chirpErr?.message || chirpErr).slice(0, 120)}; v1: ${String(
          err?.message || err,
        ).slice(0, 160)}`,
      );
    }
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
