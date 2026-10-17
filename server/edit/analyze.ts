/**
 * Stage A — OBSERVE
 * What objectively happens in this video, and when?
 * No keep/drop, hook scores, narrative importance, or EDL decisions.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type {
  AudioObservation,
  FootageIntelligence,
  FootageSegment,
  ObservedMoment,
  ObservedShot,
  TakeObservation,
} from '../../src/types/editorial';
import type { ObserveTimings } from './observeHelpers';
import {
  OBSERVE_CONCURRENCY,
  OBSERVE_MODEL,
  OBSERVE_VERTEX_MODEL,
  OBSERVE_PROMPT_VERSION,
  OBSERVE_MEDIA_RESOLUTION,
  buildObservePrompt,
  emptyTimings,
  getGcsGeneration,
  mapPool,
  observeWithVertexGs,
  readObserveCache,
  stripJsonFences,
  toGsUri,
  writeObserveCache,
} from './observeHelpers';
import {
  applyEnvelopeToIntel,
  envelopeForMedia,
} from './audioEnvelope';

type AiClient = {
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 90_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const finalArgs = cmd === 'ffmpeg' && !args.includes('-nostdin') ? ['-nostdin', ...args] : args;
    const child = spawn(cmd, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`${cmd} timed out`));
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
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

async function ffprobeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await runCmd('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/** All silence ranges inside a take (not just leading/trailing). */
export async function detectSilenceRanges(
  input: string
): Promise<Array<{ start: number; end: number }>> {
  try {
    let stderr = '';
    try {
      const result = await runCmd(
        'ffmpeg',
        ['-i', input, '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'],
        60_000
      );
      stderr = result.stderr || '';
    } catch (err: any) {
      stderr = String(err?.message || '');
    }

    const starts: number[] = [];
    const ends: number[] = [];
    const startRe = /silence_start:\s*([0-9.]+)/g;
    const endRe = /silence_end:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = startRe.exec(stderr))) starts.push(parseFloat(m[1]));
    while ((m = endRe.exec(stderr))) ends.push(parseFloat(m[1]));

    const ranges: Array<{ start: number; end: number }> = [];
    const total = await ffprobeDuration(input);
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = ends[i] ?? total;
      if (e > s + 0.3) ranges.push({ start: s, end: Math.min(e, total || e) });
    }
    return ranges;
  } catch {
    return [];
  }
}

async function downloadToLocal(urlOrPath: string, dest: string): Promise<void> {
  if (urlOrPath.startsWith('data:')) {
    const match = urlOrPath.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    await fs.writeFile(dest, Buffer.from(match[2], 'base64'));
    return;
  }
  const bucketName = process.env.GCS_BUCKET || '';
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
  // Bare object key (e.g. takes/proj/scene-1) → GCS download
  const looksLikeGcsKey =
    !urlOrPath.startsWith('http') &&
    !urlOrPath.startsWith('gs://') &&
    !urlOrPath.startsWith('/') &&
    !urlOrPath.startsWith('blob:') &&
    Boolean(bucketName) &&
    (urlOrPath.startsWith('takes/') ||
      urlOrPath.startsWith('renders/') ||
      urlOrPath.includes('/'));
  if (urlOrPath.startsWith('gs://') || looksLikeGcsKey) {
    const { Storage } = await import('@google-cloud/storage');
    const storage = new Storage(project ? { projectId: project } : undefined);
    let bucket = bucketName;
    let object = urlOrPath;
    if (urlOrPath.startsWith('gs://')) {
      const without = urlOrPath.slice(5);
      const slash = without.indexOf('/');
      bucket = without.slice(0, slash);
      object = without.slice(slash + 1);
    }
    await storage.bucket(bucket).file(object).download({ destination: dest });
    return;
  }
  if (urlOrPath.startsWith('/') && existsSync(urlOrPath)) {
    await fs.copyFile(urlOrPath, dest);
    return;
  }
  const fetchUrl = urlOrPath.startsWith('http')
    ? urlOrPath
    : urlOrPath.startsWith('/')
      ? `http://127.0.0.1:${process.env.PORT || 3000}${urlOrPath}`
      : urlOrPath;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function sampleFrames(
  videoPath: string,
  workDir: string,
  maxFrames = 6
): Promise<Array<{ path: string; time: number; base64: string }>> {
  const duration = await ffprobeDuration(videoPath);
  if (!duration || duration < 0.5) return [];

  const count = Math.min(maxFrames, Math.max(1, Math.ceil(duration)));
  const frames: Array<{ path: string; time: number; base64: string }> = [];

  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
    const out = path.join(workDir, `frame-${i}.jpg`);
    try {
      await runCmd(
        'ffmpeg',
        ['-y', '-ss', t.toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '5', out],
        30_000
      );
      if (existsSync(out)) {
        const buf = await fs.readFile(out);
        frames.push({ path: out, time: t, base64: buf.toString('base64') });
      }
    } catch {
      /* skip frame */
    }
  }
  return frames;
}

function isLongSilence(r: { start: number; end: number }, minSec = 2): boolean {
  return r.end - r.start >= minSec;
}

function unk(v: unknown, fallback = 'unknown'): string {
  if (v == null || v === '') return fallback;
  return String(v);
}

/** Project moments → FootageSegment for planner snap / critic (factual only). */
export function momentsToSegments(
  sourceId: string,
  moments: ObservedMoment[],
  shots: ObservedShot[],
  silenceRanges: Array<{ start: number; end: number }>
): FootageSegment[] {
  const shotById = new Map(shots.map((s) => [s.shotId, s]));
  return moments
    .filter((m) => m.end > m.start)
    .map((m) => {
      const shot = shotById.get(m.shotId);
      const mt = String(m.momentType || 'unknown');
      return {
        sourceId,
        start: m.start,
        end: m.end,
        transcript: m.transcript,
        speaker: 'unknown' as const,
        shotType: (shot?.shotType as FootageSegment['shotType']) || 'unknown',
        cameraMovement: (shot?.cameraMovement as FootageSegment['cameraMovement']) || 'unknown',
        framing: shot?.framing || 'unknown',
        subject: shot?.subject || 'unknown',
        objects: shot?.objects || [],
        locationScene: shot?.scene || 'unknown',
        visualQuality: 'unknown' as const,
        audioQuality: 'unknown' as const,
        containsMistake: Boolean(m.containsMistake),
        containsFiller: Boolean(m.containsFiller),
        containsSilence: Boolean(m.containsSilence),
        isRepetition: Boolean(m.repetitionObserved),
        naturalCutPoints: Array.isArray(m.naturalCutPoints) ? m.naturalCutPoints : [],
        someoneEntersFrame: mt === 'person_entering_frame',
        reactionMoment: mt === 'reaction',
        speakerLooksAway: mt === 'look_away',
        becomesShaky: shot ? /shaky|unstable/i.test(String(shot.stability)) : false,
        silenceRanges,
        momentType: m.momentType,
        shotId: m.shotId,
      } as FootageSegment;
    });
}

/** Heuristic observation seed — transcript phrases + silence as moments, not keep/drop. */
function buildHeuristicObservation(
  duration: number,
  transcript: string,
  transcriptSegments: Array<{ start: number; end: number; text: string }>,
  silenceRanges: Array<{ start: number; end: number }>
): TakeObservation {
  const shots: ObservedShot[] = [
    {
      shotId: 'shot-1',
      start: 0,
      end: duration,
      shotType: 'unknown',
      framing: 'unknown',
      cameraMovement: 'unknown',
      composition: 'unknown',
      subject: 'unknown',
      scene: 'unknown',
      objects: [],
      visualChanges: 'unknown',
      stability: 'unknown',
      focus: 'unknown',
      lighting: 'unknown',
    },
  ];

  const moments: ObservedMoment[] = [];

  if (transcriptSegments.length > 0) {
    for (const seg of transcriptSegments) {
      const text = seg.text.trim();
      const covering = silenceRanges.find(
        (r) => seg.start >= r.start - 0.1 && seg.end <= r.end + 0.1
      );
      const inLongSilence = Boolean(covering && isLongSilence(covering));
      const filler = /\b(um+|uh+|like|you know|basically|literally)\b/i.test(text);
      moments.push({
        start: seg.start,
        end: seg.end,
        shotId: 'shot-1',
        transcript: text,
        momentType: inLongSilence ? 'silence' : filler ? 'filler' : 'speech_beat',
        description: inLongSilence ? 'Long silence overlapping speech window' : text.slice(0, 120),
        containsSilence: inLongSilence,
        containsFiller: filler,
        containsMistake: false,
        repetitionObserved: false,
        naturalCutPoints: [seg.end],
      });
    }
  } else if (transcript) {
    moments.push({
      start: 0,
      end: duration,
      shotId: 'shot-1',
      transcript,
      momentType: 'speech_beat',
      description: transcript.slice(0, 120),
      containsSilence: silenceRanges.some((r) => isLongSilence(r)),
      containsFiller: false,
      containsMistake: false,
      repetitionObserved: false,
    });
  }

  for (const r of silenceRanges.filter((x) => isLongSilence(x))) {
    const overlapsSpeech = moments.some(
      (m) => m.start < r.end && m.end > r.start && m.momentType !== 'silence'
    );
    if (!overlapsSpeech) {
      moments.push({
        start: r.start,
        end: r.end,
        shotId: 'shot-1',
        momentType: 'silence',
        description: 'Detected silence',
        containsSilence: true,
        containsFiller: false,
        containsMistake: false,
        repetitionObserved: false,
      });
    }
  }

  if (!moments.length) {
    moments.push({
      start: 0,
      end: duration,
      shotId: 'shot-1',
      momentType: 'unknown',
      description: 'Full take — insufficient transcript',
      containsSilence: silenceRanges.length > 0,
      containsFiller: false,
      containsMistake: false,
      repetitionObserved: false,
    });
  }

  const audio: AudioObservation = {
    speechPresent: Boolean(transcript) || 'unknown',
    speakerCount: transcript ? 1 : 'unknown',
    dialogueClarity: transcript ? 'medium' : 'unknown',
    backgroundNoise: 'unknown',
    clipping: 'unknown',
    volumeConsistency: 'unknown',
    musicPresent: 'unknown',
    silenceRanges,
  };

  return { shots, moments, audio };
}

function normalizeObservation(
  raw: any,
  duration: number,
  silenceRanges: Array<{ start: number; end: number }>,
  fallback: TakeObservation
): TakeObservation {
  const shotsRaw = Array.isArray(raw?.shots) ? raw.shots : [];
  const momentsRaw = Array.isArray(raw?.moments) ? raw.moments : [];
  const audioRaw = raw?.audio || {};

  const shots: ObservedShot[] = shotsRaw
    .map((s: any, idx: number) => {
      const start = Math.max(0, Number(s.start) || 0);
      const end = Math.min(duration, Math.max(start + 0.2, Number(s.end) || start + 0.5));
      return {
        shotId: String(s.shotId || `shot-${idx + 1}`),
        start,
        end,
        shotType: unk(s.shotType),
        framing: unk(s.framing),
        cameraMovement: unk(s.cameraMovement),
        composition: unk(s.composition),
        subject: unk(s.subject),
        scene: unk(s.scene),
        objects: Array.isArray(s.objects) ? s.objects.map(String) : [],
        visualChanges: unk(s.visualChanges),
        stability: unk(s.stability),
        focus: unk(s.focus),
        lighting: unk(s.lighting),
      };
    })
    .filter((s: ObservedShot) => s.end > s.start);

  const defaultShotId = shots[0]?.shotId || 'shot-1';

  const moments: ObservedMoment[] = momentsRaw
    .map((m: any) => {
      const start = Math.max(0, Number(m.start) || 0);
      const end = Math.min(duration, Math.max(start + 0.15, Number(m.end) || start + 0.4));
      return {
        start,
        end,
        shotId: String(m.shotId || defaultShotId),
        transcript: m.transcript != null ? String(m.transcript) : undefined,
        momentType: unk(m.momentType),
        description: unk(m.description, 'observed moment'),
        naturalCutPoints: Array.isArray(m.naturalCutPoints)
          ? m.naturalCutPoints.map(Number).filter((n: number) => Number.isFinite(n))
          : [],
        containsSilence: Boolean(m.containsSilence),
        containsFiller: Boolean(m.containsFiller),
        containsMistake: Boolean(m.containsMistake),
        repetitionObserved: Boolean(m.repetitionObserved ?? m.isRepetition),
      };
    })
    .filter((m: ObservedMoment) => m.end > m.start);

  const audio: AudioObservation = {
    speechPresent:
      audioRaw.speechPresent === true || audioRaw.speechPresent === false
        ? audioRaw.speechPresent
        : fallback.audio.speechPresent,
    speakerCount:
      typeof audioRaw.speakerCount === 'number'
        ? audioRaw.speakerCount
        : audioRaw.speakerCount === 'unknown'
          ? 'unknown'
          : fallback.audio.speakerCount,
    dialogueClarity: (audioRaw.dialogueClarity as AudioObservation['dialogueClarity']) || 'unknown',
    backgroundNoise: unk(audioRaw.backgroundNoise),
    clipping:
      audioRaw.clipping === true || audioRaw.clipping === false
        ? audioRaw.clipping
        : 'unknown',
    volumeConsistency: unk(audioRaw.volumeConsistency),
    musicPresent:
      audioRaw.musicPresent === true || audioRaw.musicPresent === false
        ? audioRaw.musicPresent
        : 'unknown',
    silenceRanges:
      Array.isArray(audioRaw.silenceRanges) && audioRaw.silenceRanges.length
        ? audioRaw.silenceRanges
            .map((r: any) => ({
              start: Number(r.start) || 0,
              end: Number(r.end) || 0,
            }))
            .filter((r: { start: number; end: number }) => r.end > r.start)
        : silenceRanges,
  };

  return {
    shots: shots.length ? shots : fallback.shots,
    moments: moments.length ? moments : fallback.moments,
    audio,
  };
}

const OBSERVE_JSON_SCHEMA = `{
  "shots": [
    {
      "shotId": "shot-1",
      "start": 0.0,
      "end": 5.0,
      "shotType": "wide|medium|close_up|extreme_close_up|unknown",
      "framing": "string or unknown",
      "cameraMovement": "static|pan|tilt|zoom|handheld|unknown",
      "composition": "factual description or unknown",
      "subject": "what is in frame or unknown",
      "scene": "setting description or unknown",
      "objects": [],
      "visualChanges": "what changes during the shot or unknown",
      "stability": "stable|mild_shake|shaky|unknown",
      "focus": "sharp|soft|unknown",
      "lighting": "factual lighting note or unknown"
    }
  ],
  "moments": [
    {
      "start": 0.0,
      "end": 2.0,
      "shotId": "shot-1",
      "transcript": "words if audible",
      "momentType": "speech_beat|completed_thought|reaction|gesture|person_entering_frame|person_exiting_frame|look_away|visual_reveal|movement_peak|emotional_change|natural_cut_point|silence|filler|mistake|repetition|unknown",
      "description": "factual description of what happens",
      "naturalCutPoints": [],
      "containsSilence": false,
      "containsFiller": false,
      "containsMistake": false,
      "repetitionObserved": false
    }
  ],
  "audio": {
    "speechPresent": true,
    "speakerCount": 1,
    "dialogueClarity": "high|medium|low|unknown",
    "backgroundNoise": "low|medium|high|unknown",
    "clipping": false,
    "volumeConsistency": "high|medium|low|unknown",
    "musicPresent": false,
    "silenceRanges": [{"start": 0, "end": 0.5}]
  }
}`;

async function observeWithGeminiVideo(
  ai: any,
  videoLocalPath: string,
  title: string,
  fullTranscript: string,
  duration: number,
  silenceRanges: Array<{ start: number; end: number }>,
  seed: TakeObservation,
  recordedMime?: string
): Promise<{
  observation: TakeObservation;
  nativeVideoAnalyzed: boolean;
  timings: Partial<ObserveTimings>;
}> {
  const { uploadVideoForGemini, videoFilePart, mimeForVideoPath } = await import('./geminiVideo');

  let cleanup: (() => Promise<void>) | null = null;
  const timings: Partial<ObserveTimings> = {
    uploadMs: 0,
    waitActiveMs: 0,
    generateMs: 0,
    parseMs: 0,
    path: 'files',
    model: OBSERVE_MODEL,
  };
  try {
    const mime =
      (recordedMime || '').split(';')[0].trim() || mimeForVideoPath(videoLocalPath);
    const uploaded = await uploadVideoForGemini(
      ai,
      videoLocalPath,
      mime,
      `take-${title.slice(0, 40)}`
    );
    cleanup = uploaded.cleanup;
    timings.uploadMs = uploaded.uploadMs;
    timings.waitActiveMs = uploaded.waitActiveMs;

    const prompt = buildObservePrompt(
      title,
      duration,
      fullTranscript,
      silenceRanges,
      seed.moments.map((m) => ({
        start: m.start,
        end: m.end,
        transcript: m.transcript,
        momentType: m.momentType,
      })),
      OBSERVE_JSON_SCHEMA
    );

    const tGen = Date.now();
    const response = await ai.models.generateContent({
      model: OBSERVE_MODEL,
      contents: {
        parts: [
          videoFilePart(uploaded.uri, uploaded.mimeType, String(OBSERVE_MEDIA_RESOLUTION)),
          { text: prompt },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        mediaResolution: OBSERVE_MEDIA_RESOLUTION,
      },
    });
    timings.generateMs = Date.now() - tGen;

    const tParse = Date.now();
    const parsed = JSON.parse(response.text || '{}');
    timings.parseMs = Date.now() - tParse;
    return {
      observation: normalizeObservation(parsed, duration, silenceRanges, seed),
      nativeVideoAnalyzed: true,
      timings,
    };
  } catch (err) {
    console.warn(
      'Native video observe failed, falling back to still frames:',
      (err as Error).message
    );
    return { observation: seed, nativeVideoAnalyzed: false, timings };
  } finally {
    if (cleanup) await cleanup();
  }
}

async function observeWithGeminiFrames(
  ai: any,
  frames: Array<{ time: number; base64: string }>,
  title: string,
  fullTranscript: string,
  duration: number,
  silenceRanges: Array<{ start: number; end: number }>,
  seed: TakeObservation
): Promise<TakeObservation> {
  if (!frames.length) return seed;

  try {
    const parts: any[] = [];
    for (const f of frames.slice(0, 4)) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.base64 } });
      parts.push({ text: `Frame at t=${f.time.toFixed(2)}s` });
    }
    parts.push({
      text: `You are a video OBSERVER (not an editor) for take "${title}" (${duration.toFixed(1)}s). Report only factual shots/moments/audio. Do NOT keep/drop, score hooks, or recommend edits. Production words like cut/action are not mistakes. Use unknown when unsure. Transcript:\n"""${fullTranscript.slice(0, 3000)}"""\nSilence: ${JSON.stringify(silenceRanges).slice(0, 800)}\nReturn JSON: ${OBSERVE_JSON_SCHEMA}`,
    });

    const response = await ai.models.generateContent({
      model: OBSERVE_MODEL,
      contents: { parts },
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{}');
    return normalizeObservation(parsed, duration, silenceRanges, seed);
  } catch {
    return seed;
  }
}

function toFootageIntelligence(
  sourceId: string,
  duration: number,
  title: string | undefined,
  transcript: string,
  observation: TakeObservation,
  nativeVideoAnalyzed: boolean
): FootageIntelligence {
  return {
    sourceId,
    sourceDuration: duration,
    title,
    fullTranscript: transcript,
    observation,
    segments: momentsToSegments(
      sourceId,
      observation.moments,
      observation.shots,
      observation.audio.silenceRanges || []
    ),
    analyzedAt: Date.now(),
    nativeVideoAnalyzed,
  };
}

export interface AnalyzeSceneInput {
  id: string;
  title?: string;
  filmedBy?: string;
  userRecordedVideoUrl?: string;
  gcsObjectPath?: string;
  mimeType?: string;
  transcript?: string;
  transcriptSegments?: Array<{ start: number; end: number; text: string }>;
  recordedDuration?: number;
  footageIntel?: FootageIntelligence;
}

/** Attach ffmpeg speech envelope + retime segments/moments (even on observe cache hits). */
async function withAudioEnvelope(
  intel: FootageIntelligence,
  mediaUrl: string,
  scene: AnalyzeSceneInput
): Promise<FootageIntelligence> {
  if (intel.audioEnvelope?.source === 'ffmpeg' && intel.audioEnvelope.speechEnd > 0) {
    // Still retime if segments look compressed vs envelope
    const lastSeg = (scene.transcriptSegments || intel.retimedTranscriptSegments || []).slice(-1)[0];
    if (lastSeg && Math.abs(lastSeg.end - intel.audioEnvelope.speechEnd) <= 2) {
      return intel;
    }
  }
  try {
    const envelope = await envelopeForMedia(mediaUrl, scene.mimeType);
    if (!envelope) return intel;
    const segs = (scene.transcriptSegments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    }));
    return applyEnvelopeToIntel(intel, envelope, segs.length ? segs : undefined);
  } catch (err: any) {
    console.warn(`[ENVELOPE] enrich failed sourceId=${intel.sourceId}:`, err?.message || err);
    return intel;
  }
}

/**
 * Observe one user take. Prefer Vertex gs:// + cache; Files API is fallback.
 * Returns intel + timings so analyzeAllTakes can count cache hits accurately.
 */
export async function analyzeTake(
  ai: AiClient,
  scene: AnalyzeSceneInput
): Promise<{ intel: FootageIntelligence | null; timings: ObserveTimings } | null> {
  if (scene.filmedBy && scene.filmedBy !== 'user') return null;

  const tTotal = Date.now();
  const timings = emptyTimings();

  const tResolve = Date.now();
  const candidates = [scene.gcsObjectPath, scene.userRecordedVideoUrl].filter(Boolean) as string[];
  const mediaUrl = candidates.find(
    (u) => !u.startsWith('blob:') && !u.startsWith('data:')
  );
  timings.resolveMs = Date.now() - tResolve;

  if (!mediaUrl) {
    console.warn(
      `[OBSERVE] ${scene.id}: no durable media (gcsObjectPath required; blob: ignored)`
    );
    return { intel: null, timings };
  }

  // Reuse in-memory intel from a prior Director Edit in this session
  if (
    scene.footageIntel?.observation?.moments?.length &&
    scene.footageIntel.sourceId === scene.id &&
    scene.footageIntel.nativeVideoAnalyzed
  ) {
    timings.path = 'reuse';
    timings.cacheHit = true;
    timings.totalMs = Date.now() - tTotal;
    console.log(
      `[OBSERVE] cache hit sourceId=${scene.id} path=reuse totalMs=${timings.totalMs}`
    );
    const enriched = await withAudioEnvelope(scene.footageIntel, mediaUrl, scene);
    return { intel: enriched, timings };
  }

  const gsUri = toGsUri(mediaUrl);
  const mime =
    (scene.mimeType || '').split(';')[0].trim() ||
    (mediaUrl.includes('.mp4')
      ? 'video/mp4'
      : mediaUrl.includes('.webm')
        ? 'video/webm'
        : mediaUrl.includes('.mov')
          ? 'video/quicktime'
          : 'video/mp4');
  const transcript = (scene.transcript || '').trim();
  const transcriptSegments = scene.transcriptSegments || [];
  const durationHint =
    scene.recordedDuration && scene.recordedDuration > 0.5 ? scene.recordedDuration : 0;

  // --- GCS observation cache ---
  if (gsUri) {
    const tMeta = Date.now();
    const generation = await getGcsGeneration(gsUri);
    timings.gcsMetaMs = Date.now() - tMeta;
    const cached = await readObserveCache(gsUri, generation, OBSERVE_VERTEX_MODEL);
    if (cached?.observation) {
      timings.path = 'cache';
      timings.cacheHit = true;
      timings.model = cached.model || OBSERVE_VERTEX_MODEL;
      timings.totalMs = Date.now() - tTotal;
      console.log(
        `[OBSERVE] cache hit sourceId=${scene.id} path=cache totalMs=${timings.totalMs}`
      );
      const cachedIntel = toFootageIntelligence(
        scene.id,
        cached.duration || durationHint || 5,
        scene.title,
        transcript,
        cached.observation,
        Boolean(cached.nativeVideoAnalyzed)
      );
      return {
        intel: await withAudioEnvelope(cachedIntel, mediaUrl, scene),
        timings,
      };
    }
    console.log(`[OBSERVE] cache miss sourceId=${scene.id}`);

    // --- Vertex gs:// direct (no download) ---
    const seed = buildHeuristicObservation(
      durationHint || 5,
      transcript,
      transcriptSegments,
      []
    );
    const prompt = buildObservePrompt(
      scene.title || 'Take',
      durationHint || 5,
      transcript,
      [],
      seed.moments.map((m) => ({
        start: m.start,
        end: m.end,
        transcript: m.transcript,
        momentType: m.momentType,
      })),
      OBSERVE_JSON_SCHEMA
    );

    let vertexLastErr: any = null;
    for (let parseAttempt = 1; parseAttempt <= 2; parseAttempt++) {
      try {
        const vertexResult = await observeWithVertexGs(gsUri, mime, prompt);
        timings.generateMs = vertexResult.generateMs;
        timings.path = 'gcs-direct';
        timings.model = vertexResult.model;
        const tParse = Date.now();
        const parsed = JSON.parse(stripJsonFences(vertexResult.text || '{}'));
        timings.parseMs = Date.now() - tParse;
        const duration = durationHint || 5;
        const observation = normalizeObservation(parsed, duration, [], seed);
        const intel = toFootageIntelligence(
          scene.id,
          duration,
          scene.title,
          transcript,
          observation,
          true
        );
        timings.totalMs = Date.now() - tTotal;
        console.log(
          `[OBSERVE] end sourceId=${scene.id} ok=true path=gcs-direct totalMs=${timings.totalMs} resolveMs=${timings.resolveMs} gcsMetaMs=${timings.gcsMetaMs} uploadMs=0 waitActiveMs=0 generateMs=${timings.generateMs} parseMs=${timings.parseMs} model=${timings.model}`
        );
        void writeObserveCache({
          sourceId: scene.id,
          gsUri,
          generation,
          duration,
          model: OBSERVE_VERTEX_MODEL,
          promptVersion: OBSERVE_PROMPT_VERSION,
          mediaResolution: String(OBSERVE_MEDIA_RESOLUTION),
          nativeVideoAnalyzed: true,
          observation,
          cachedAt: Date.now(),
        });
        return { intel: await withAudioEnvelope(intel, mediaUrl, scene), timings };
      } catch (err: any) {
        vertexLastErr = err;
        const isParse =
          err instanceof SyntaxError ||
          String(err?.message || '').includes('JSON');
        if (isParse && parseAttempt < 2) {
          console.warn(
            `[OBSERVE] gcs-direct JSON parse retry sourceId=${scene.id}:`,
            err?.message || err
          );
          continue;
        }
        break;
      }
    }
    console.warn(
      `[OBSERVE] gcs-direct fail, files-fallback sourceId=${scene.id}:`,
      vertexLastErr?.message || vertexLastErr
    );
  }

  // --- Files API fallback (download → upload → wait ACTIVE) ---
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `takeone-intel-${scene.id}-`));
  try {
    const ext = mime.includes('mp4') || mime.includes('quicktime')
      ? 'mp4'
      : mime.includes('webm')
        ? 'webm'
        : mediaUrl.includes('.mp4')
          ? 'mp4'
          : 'webm';
    const local = path.join(workDir, `take.${ext}`);
    await downloadToLocal(mediaUrl, local);

    const duration = durationHint || (await ffprobeDuration(local)) || 5;

    const silenceRanges = await detectSilenceRanges(local);
    let observation = buildHeuristicObservation(
      duration,
      transcript,
      transcriptSegments,
      silenceRanges
    );

    let nativeVideoAnalyzed = false;
    const videoResult = await observeWithGeminiVideo(
      ai,
      local,
      scene.title || 'Take',
      transcript,
      duration,
      silenceRanges,
      observation,
      mime || undefined
    );
    observation = videoResult.observation;
    nativeVideoAnalyzed = videoResult.nativeVideoAnalyzed;
    Object.assign(timings, videoResult.timings);
    if (!timings.path || timings.path === 'heuristic') timings.path = 'files';

    if (!nativeVideoAnalyzed) {
      const frames = await sampleFrames(local, workDir, 5);
      if (frames.length) {
        observation = await observeWithGeminiFrames(
          ai,
          frames,
          scene.title || 'Take',
          transcript,
          duration,
          silenceRanges,
          observation
        );
        timings.path = 'frames';
      }
    }

    const intel = toFootageIntelligence(
      scene.id,
      duration,
      scene.title,
      transcript,
      observation,
      nativeVideoAnalyzed
    );
    timings.totalMs = Date.now() - tTotal;
    console.log(
      `[OBSERVE] end sourceId=${scene.id} ok=true path=${timings.path} totalMs=${timings.totalMs} resolveMs=${timings.resolveMs} gcsMetaMs=${timings.gcsMetaMs} uploadMs=${timings.uploadMs || 0} waitActiveMs=${timings.waitActiveMs || 0} generateMs=${timings.generateMs || 0} parseMs=${timings.parseMs || 0} model=${timings.model || OBSERVE_MODEL}`
    );

    if (gsUri && nativeVideoAnalyzed) {
      const generation = await getGcsGeneration(gsUri);
      // Cache under Files model key so Files-path successes are reusable too
      void writeObserveCache({
        sourceId: scene.id,
        gsUri,
        generation,
        duration,
        model: OBSERVE_MODEL,
        promptVersion: OBSERVE_PROMPT_VERSION,
        mediaResolution: String(OBSERVE_MEDIA_RESOLUTION),
        nativeVideoAnalyzed: true,
        observation,
        cachedAt: Date.now(),
      });
      // Also write Vertex key so next run prefers cache before Vertex call
      void writeObserveCache({
        sourceId: scene.id,
        gsUri,
        generation,
        duration,
        model: OBSERVE_VERTEX_MODEL,
        promptVersion: OBSERVE_PROMPT_VERSION,
        mediaResolution: String(OBSERVE_MEDIA_RESOLUTION),
        nativeVideoAnalyzed: true,
        observation,
        cachedAt: Date.now(),
      });
    }

    return { intel: await withAudioEnvelope(intel, mediaUrl, scene), timings };
  } catch (err) {
    console.warn(`[OBSERVE] end sourceId=${scene.id} ok=false:`, (err as Error).message);
    const duration = scene.recordedDuration || 5;
    const observation = buildHeuristicObservation(
      duration,
      scene.transcript || '',
      scene.transcriptSegments || [],
      []
    );
    timings.totalMs = Date.now() - tTotal;
    timings.path = 'heuristic';
    return {
      intel: toFootageIntelligence(
        scene.id,
        duration,
        scene.title,
        scene.transcript || '',
        observation,
        false
      ),
      timings,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function analyzeAllTakes(
  ai: AiClient,
  scenes: AnalyzeSceneInput[],
  onProgress?: (msg: string, pct: number) => void
): Promise<FootageIntelligence[]> {
  const userScenes = scenes.filter(
    (s) =>
      (!s.filmedBy || s.filmedBy === 'user') &&
      (s.gcsObjectPath ||
        (s.userRecordedVideoUrl &&
          !String(s.userRecordedVideoUrl).startsWith('blob:') &&
          !String(s.userRecordedVideoUrl).startsWith('data:')))
  );

  const wallStart = Date.now();

  onProgress?.(
    `OBSERVATION: analyzing ${userScenes.length} takes (concurrency ${OBSERVE_CONCURRENCY})…`,
    5
  );

  let completed = 0;
  const settled = await mapPool(userScenes, OBSERVE_CONCURRENCY, async (scene, i) => {
    console.log(
      `[OBSERVE] start sourceId=${scene.id} index=${i + 1}/${userScenes.length}`
    );
    const t0 = Date.now();
    const result = await analyzeTake(ai, scene);
    const elapsed = Date.now() - t0;
    completed += 1;
    onProgress?.(
      `OBSERVATION: take ${completed}/${userScenes.length}: ${scene.title || scene.id}`,
      Math.round((completed / Math.max(userScenes.length, 1)) * 100)
    );
    console.log(
      `[OBSERVE] end sourceId=${scene.id} elapsedMs=${elapsed} ok=${Boolean(result?.intel)} path=${result?.timings.path || 'none'}`
    );
    return { intel: result?.intel || null, timings: result?.timings, elapsed };
  });

  const results: FootageIntelligence[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let sumTakeMs = 0;
  for (const r of settled) {
    if (r.status !== 'fulfilled') {
      cacheMisses += 1;
      continue;
    }
    sumTakeMs += r.value.elapsed || 0;
    if (r.value.timings?.cacheHit) cacheHits += 1;
    else cacheMisses += 1;
    if (r.value.intel) results.push(r.value.intel);
  }

  const wallMs = Date.now() - wallStart;
  console.log(
    `[OBSERVE] takes=${userScenes.length} concurrency=${OBSERVE_CONCURRENCY} cacheHits=${cacheHits} cacheMisses=${cacheMisses} wallMs=${wallMs} sumTakeMs=${sumTakeMs} ok=${results.length}`
  );

  return results;
}
