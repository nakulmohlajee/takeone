/**
 * FFmpeg-grounded speech envelope + transcript retime.
 * Authority for last spoken word / CTA protection — not Gemini timestamps.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type {
  FootageIntelligence,
  ObservedMoment,
  TakeObservation,
} from '../../src/types/editorial';

export type AudioEnvelope = {
  speechStart: number;
  speechEnd: number;
  pauses: Array<{ start: number; end: number }>;
  duration: number;
  source: 'ffmpeg';
};

export type TimedSegment = { start: number; end: number; text: string };

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
      // silencedetect dumps to stderr and often exits 0; tolerate non-zero if we got ranges
      if (code === 0 || stderr.includes('silence_')) resolve({ stdout, stderr });
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

/** Fine silence pass (d=0.2) for pause-aware cut snapping. */
export async function detectSilenceRangesFine(
  input: string,
  noiseDb = -35,
  minDur = 0.2
): Promise<Array<{ start: number; end: number }>> {
  try {
    let stderr = '';
    try {
      const result = await runCmd(
        'ffmpeg',
        [
          '-i',
          input,
          '-af',
          `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
          '-f',
          'null',
          '-',
        ],
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
      if (e > s + 0.15) ranges.push({ start: s, end: Math.min(e, total || e) });
    }
    return ranges;
  } catch {
    return [];
  }
}

/**
 * Speech envelope from ffmpeg silence gaps.
 * speechEnd = start of the trailing silence that reaches the end (or duration).
 */
export async function computeAudioEnvelope(localPath: string): Promise<AudioEnvelope | null> {
  if (!localPath || !existsSync(localPath)) return null;
  const duration = await ffprobeDuration(localPath);
  if (!(duration > 0.5)) return null;

  const pauses = await detectSilenceRangesFine(localPath);
  if (!pauses.length) {
    return {
      speechStart: 0,
      speechEnd: duration,
      pauses: [],
      duration,
      source: 'ffmpeg',
    };
  }

  // Leading silence → first speech
  let speechStart = 0;
  const first = pauses[0];
  if (first.start <= 0.35) {
    speechStart = Math.min(duration - 0.1, first.end);
  }

  // Trailing silence that reaches (or nearly reaches) end → speechEnd = its start
  let speechEnd = duration;
  const last = pauses[pauses.length - 1];
  if (last.end >= duration - 0.6) {
    speechEnd = Math.max(speechStart + 0.3, last.start);
  } else {
    // No trailing silence detected — look for last substantial pause near the end
    for (let i = pauses.length - 1; i >= 0; i--) {
      const p = pauses[i];
      if (p.end - p.start >= 0.5 && p.start >= duration * 0.5) {
        // If there's content after this pause, keep speechEnd at duration
        break;
      }
    }
  }

  // Ensure speechEnd is after the last non-trailing pause's end when speech continues
  // Prefer: last silence that starts after mid-file and extends to end
  const trailing = [...pauses]
    .reverse()
    .find((p) => p.end >= duration - 0.6 && p.end - p.start >= 0.25);
  if (trailing) {
    speechEnd = Math.max(speechStart + 0.3, trailing.start);
  }

  console.log(
    `[ENVELOPE] duration=${duration.toFixed(2)} speech=${speechStart.toFixed(2)}–${speechEnd.toFixed(2)} pauses=${pauses.length}`
  );

  return {
    speechStart: Math.round(speechStart * 1000) / 1000,
    speechEnd: Math.round(speechEnd * 1000) / 1000,
    pauses,
    duration,
    source: 'ffmpeg',
  };
}

function wordCount(text: string): number {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Snap a time to nearest pause boundary within maxDist (prefer pause start for out, end for in). */
export function snapCutToPause(
  t: number,
  envelope: AudioEnvelope | null | undefined,
  side: 'in' | 'out' = 'out',
  maxDist = 0.6
): number {
  if (!envelope?.pauses?.length) return t;
  let best = t;
  let bestDist = maxDist + 0.001;
  for (const p of envelope.pauses) {
    const candidates =
      side === 'out'
        ? [p.start, (p.start + p.end) / 2]
        : [p.end, (p.start + p.end) / 2];
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    // Also accept any point already inside a pause
    if (t >= p.start - 0.02 && t <= p.end + 0.02) {
      return side === 'out' ? Math.max(p.start, Math.min(t, p.end)) : Math.min(p.end, Math.max(t, p.start));
    }
  }
  return best;
}

/**
 * First pause at or after speechEnd, plus pad — the safe Polish out-point.
 */
export function tailOutAfterSpeech(
  envelope: AudioEnvelope,
  pad = 0.35
): number {
  const base = envelope.speechEnd;
  const trailing = envelope.pauses.find(
    (p) => p.start >= base - 0.15 && p.end >= envelope.duration - 0.6
  );
  const out = (trailing ? trailing.start : base) + pad;
  return Math.min(envelope.duration, Math.max(base, out));
}

/**
 * Retime Gemini/STT segments onto the real speech window using word-share + pause snap.
 * Triggers when last segment end differs from speechEnd by > 2s.
 */
export function retimeSegmentsToAudio(
  segments: TimedSegment[],
  envelope: AudioEnvelope
): TimedSegment[] {
  if (!segments.length) return segments;
  const sorted = [...segments]
    .filter((s) => (s.text || '').trim())
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return segments;

  const lastEnd = sorted[sorted.length - 1].end;
  if (Math.abs(lastEnd - envelope.speechEnd) <= 2) {
    return sorted.map((s) => ({ ...s }));
  }

  const totalWords = sorted.reduce((a, s) => a + Math.max(1, wordCount(s.text)), 0);
  const span = Math.max(0.5, envelope.speechEnd - envelope.speechStart);
  let cursor = envelope.speechStart;
  const out: TimedSegment[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const w = Math.max(1, wordCount(s.text));
    const share = w / totalWords;
    let end = envelope.speechStart + span * sorted.slice(0, i + 1).reduce(
      (a, x, idx) => a + Math.max(1, wordCount(x.text)) / totalWords,
      0
    );
    // Snap end to nearest pause within 1.5s (except last → speechEnd)
    if (i < sorted.length - 1) {
      end = snapCutToPause(end, envelope, 'out', 1.5);
      end = Math.max(cursor + 0.25, Math.min(end, envelope.speechEnd - 0.2));
    } else {
      end = envelope.speechEnd;
    }
    // Monotonic
    if (end <= cursor) end = Math.min(envelope.speechEnd, cursor + Math.max(0.3, share * span));
    out.push({
      start: Math.round(cursor * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text: s.text,
    });
    cursor = end;
  }

  console.log(
    `[RETIME] segments=${out.length} wasLast=${lastEnd.toFixed(2)} → speechEnd=${envelope.speechEnd.toFixed(2)}`
  );
  return out;
}

/** Apply envelope + retime onto FootageIntelligence (moments, segments, silence). */
export function applyEnvelopeToIntel(
  intel: FootageIntelligence,
  envelope: AudioEnvelope,
  transcriptSegments?: TimedSegment[]
): FootageIntelligence {
  const segsIn =
    transcriptSegments?.length
      ? transcriptSegments
      : (intel.segments || [])
          .filter((s) => (s.transcript || '').trim())
          .map((s) => ({ start: s.start, end: s.end, text: s.transcript || '' }));

  const retimed = retimeSegmentsToAudio(segsIn, envelope);
  const needRetime =
    segsIn.length > 0 &&
    Math.abs((segsIn[segsIn.length - 1]?.end || 0) - envelope.speechEnd) > 2;

  let observation: TakeObservation | undefined = intel.observation
    ? { ...intel.observation }
    : undefined;

  if (observation) {
    const silenceRanges = [
      ...(envelope.speechStart > 0.2
        ? [{ start: 0, end: envelope.speechStart }]
        : []),
      ...envelope.pauses.filter(
        (p) => !(p.start <= 0.2 && p.end <= envelope.speechStart + 0.1)
      ),
    ];
    // Ensure trailing silence is present
    if (
      !silenceRanges.some((r) => r.start >= envelope.speechEnd - 0.2 && r.end >= envelope.duration - 0.5)
    ) {
      silenceRanges.push({ start: envelope.speechEnd, end: envelope.duration });
    }

    observation = {
      ...observation,
      audio: {
        ...observation.audio,
        silenceRanges,
        speechPresent: true,
      },
    };

    if (needRetime && retimed.length) {
      const moments: ObservedMoment[] = (observation.moments || []).map((m, idx) => {
        // Map by index into speech moments if counts match, else by proportional index
        const speechMoments = (observation!.moments || []).filter((x) => {
          const t = String(x.momentType || '').toLowerCase();
          return t !== 'silence' && (x.transcript || '').trim();
        });
        const speechIdx = speechMoments.indexOf(m);
        if (speechIdx >= 0 && speechIdx < retimed.length) {
          const r = retimed[speechIdx];
          return { ...m, start: r.start, end: r.end, transcript: r.text || m.transcript };
        }
        if (String(m.momentType || '').toLowerCase() === 'silence' || (!(m.transcript || '').trim() && m.containsSilence)) {
          // Rebuild trailing silence moment
          if (m.start >= (segsIn[segsIn.length - 1]?.end || 0) - 1) {
            return {
              ...m,
              start: envelope.speechEnd,
              end: envelope.duration,
              momentType: 'silence',
              containsSilence: true,
              transcript: '',
            };
          }
        }
        return m;
      });

      // Replace silence-only trailing moments
      const cleaned = moments.filter((m) => {
        const t = String(m.momentType || '').toLowerCase();
        if (t === 'silence' && m.start < envelope.speechEnd - 0.5 && m.end > envelope.speechStart) {
          // Drop bogus mid-take silence that covers speech after retime
          if (!(m.transcript || '').trim() && m.end - m.start > 5) return false;
        }
        return true;
      });

      // Ensure speech moments cover retimed segments
      const hasSpeech = cleaned.some((m) => (m.transcript || '').trim());
      if (!hasSpeech || needRetime) {
        const rebuilt: ObservedMoment[] = retimed.map((r, i) => ({
          start: r.start,
          end: r.end,
          shotId: 'shot-1',
          transcript: r.text,
          momentType: i === retimed.length - 1 ? 'completed_thought' : 'speech_beat',
          description: r.text.slice(0, 120),
          containsSilence: false,
          containsFiller: false,
          containsMistake: false,
          repetitionObserved: false,
          naturalCutPoints: i === retimed.length - 1 ? [r.end] : [],
        }));
        rebuilt.push({
          start: envelope.speechEnd,
          end: envelope.duration,
          shotId: 'shot-1',
          transcript: '',
          momentType: 'silence',
          description: 'Trailing silence after speech (ffmpeg)',
          containsSilence: true,
          containsFiller: false,
          containsMistake: false,
          repetitionObserved: false,
          naturalCutPoints: [],
        });
        observation = { ...observation, moments: rebuilt };
      } else {
        observation = { ...observation, moments: cleaned };
      }
    }
  }

  const segments = (observation?.moments || []).map((m, i) => ({
    id: `${intel.sourceId}-seg-${i}`,
    sourceId: intel.sourceId,
    start: m.start,
    end: m.end,
    transcript: m.transcript || '',
    momentType: m.momentType,
    containsSilence: Boolean(m.containsSilence),
    containsFiller: Boolean(m.containsFiller),
    containsMistake: Boolean(m.containsMistake),
  }));

  return {
    ...intel,
    sourceDuration: envelope.duration || intel.sourceDuration,
    audioEnvelope: envelope,
    observation,
    segments: segments.length ? segments : intel.segments,
    retimedTranscriptSegments: retimed,
  };
}

/** Download media URL/gs path to a temp file for envelope computation. */
export async function downloadForEnvelope(
  urlOrPath: string,
  dest: string
): Promise<void> {
  if (urlOrPath.startsWith('data:')) {
    const match = urlOrPath.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    await fs.writeFile(dest, Buffer.from(match[2], 'base64'));
    return;
  }
  const bucketName = process.env.GCS_BUCKET || '';
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
  const looksLikeGcsKey =
    !urlOrPath.startsWith('http') &&
    !urlOrPath.startsWith('gs://') &&
    !urlOrPath.startsWith('/') &&
    !urlOrPath.startsWith('blob:') &&
    Boolean(bucketName);

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
  const res = await fetch(urlOrPath);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Compute envelope for a scene media reference; returns null on failure.
 */
export async function envelopeForMedia(
  mediaUrl: string,
  mimeHint?: string
): Promise<AudioEnvelope | null> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-env-'));
  try {
    const ext =
      (mimeHint || '').includes('webm')
        ? 'webm'
        : (mimeHint || '').includes('quicktime')
          ? 'mov'
          : 'mp4';
    const local = path.join(workDir, `take.${ext}`);
    await downloadForEnvelope(mediaUrl, local);
    return await computeAudioEnvelope(local);
  } catch (err: any) {
    console.warn('[ENVELOPE] failed:', err?.message || err);
    return null;
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
