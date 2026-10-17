/**
 * Server-side Master Cut renderer (FFmpeg).
 * Upload → normalize → xfade assemble → captions → channel kit → MP4 in GCS.
 */
import { Router, Request, Response } from 'express';
import { Storage } from '@google-cloud/storage';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { enqueueWorker } from './jobs/enqueue';
import { appendCost } from './jobs/cost';
import { labelForRenderStage } from './jobs/stages';
import {
  clearProjectLock,
  loadJson,
  readProjectLock,
  saveJson,
  writeProjectLock,
} from './jobs/store';
import { runEdlPreflight } from './edit/edlPreflight';
import {
  buildSfxCues,
  buildWordAssFile,
  captionFontsDir,
  type WordCaptionStyle,
} from './render/captions';

const GCS_BUCKET = process.env.GCS_BUCKET || '';
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
const MAX_RENDER_SECONDS = Number(process.env.MAX_RENDER_SECONDS || 2400);

type JobStatus = 'queued' | 'uploading' | 'rendering' | 'done' | 'error';
type JobState = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

interface RenderJob {
  id: string;
  status: JobStatus;
  state: JobState;
  percent: number;
  stage: string;
  message: string;
  outputGcsPath?: string;
  downloadUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  attempt?: number;
  projectId?: string;
  edlSummary?: string;
  /** Non-fatal issues (e.g. virtual background skipped). */
  warnings?: string[];
  quality?: RenderQualityTier;
  /** When the worker claimed the job (cold start = startedAt - createdAt). */
  startedAt?: number;
  /** Seconds since startedAt when each stage began. */
  stageTimings?: Record<string, number>;
  outputDurationSec?: number;
}

function statusToState(status: JobStatus): JobState {
  if (status === 'done') return 'COMPLETED';
  if (status === 'error') return 'FAILED';
  if (status === 'queued') return 'QUEUED';
  return 'PROCESSING';
}

export function ffmpegTimeoutMs(durationSec: number): number {
  return Math.max(180_000, Math.round((Math.max(1, durationSec) * 4 + 60) * 1000));
}

export type RenderQualityTier = 'draft' | 'standard' | 'high';

export type QualityProfile = {
  tier: RenderQualityTier;
  width: number;
  height: number;
  crf: number;
  preset: string;
  audioBitrate: string;
  /** Near-lossless intermediates so only the final encode decides quality. */
  intermediateCrf: number;
  intermediatePreset: string;
  useProxy: boolean;
  burnCaptions: boolean;
  applyLoudnorm: boolean;
};

/** Resolve draft | standard | high (final → standard). Widescreen swaps axes. */
export function qualityProfile(
  quality: string | undefined,
  aspectRatio: string | undefined
): QualityProfile {
  const raw = String(quality || 'standard').toLowerCase();
  const tier: RenderQualityTier =
    raw === 'draft' ? 'draft' : raw === 'high' ? 'high' : 'standard';
  const widescreen = aspectRatio === '16:9';
  const dims =
    tier === 'draft'
      ? widescreen
        ? { width: 960, height: 540 }
        : { width: 540, height: 960 }
      : tier === 'high'
        ? widescreen
          ? { width: 1920, height: 1080 }
          : { width: 1080, height: 1920 }
        : widescreen
          ? { width: 1280, height: 720 }
          : { width: 720, height: 1280 };
  if (tier === 'draft') {
    return {
      tier,
      ...dims,
      crf: 26,
      preset: 'veryfast',
      audioBitrate: '160k',
      intermediateCrf: 23,
      intermediatePreset: 'veryfast',
      useProxy: false, // never upscale the 480-short-side analysis proxy
      burnCaptions: false,
      applyLoudnorm: true,
    };
  }
  if (tier === 'high') {
    return {
      tier,
      ...dims,
      crf: 18,
      preset: 'medium',
      audioBitrate: '256k',
      intermediateCrf: 14,
      intermediatePreset: 'veryfast',
      useProxy: false,
      burnCaptions: true,
      applyLoudnorm: true,
    };
  }
  return {
    tier: 'standard',
    ...dims,
    crf: 20,
    preset: 'faster',
    audioBitrate: '192k',
    intermediateCrf: 14,
    intermediatePreset: 'veryfast',
    useProxy: false,
    burnCaptions: true,
    applyLoudnorm: true,
  };
}

// In-memory + GCS status.json for multi-instance Cloud Run
const jobs = new Map<string, RenderJob>();
const persistFlushAt = new Map<string, number>();
const persistStageKey = new Map<string, string>();
const persistTimer = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_MIN_MS = 2000;

function getStorage() {
  if (!GCS_BUCKET) return null;
  return new Storage(GCP_PROJECT ? { projectId: GCP_PROJECT } : undefined);
}

let renderHeartbeat: (() => void) | null = null;
/** Max bytes per /media range response (Cloud Run caps responses at 32 MiB). */
const MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;
/** Receives ffmpeg output seconds for whichever render stage is running (see stageProgress). */
let ffmpegProgressSink: ((seconds: number) => void) | null = null;

async function writeRenderStatus(job: RenderJob): Promise<void> {
  try {
    await saveJson(`renders/${job.id}/status.json`, job, 'temp');
    persistFlushAt.set(job.id, Date.now());
  } catch (e: any) {
    console.warn('persistJob failed:', e?.message);
  }
}

async function persistJob(job: RenderJob, opts?: { flush?: boolean }) {
  job.updatedAt = Date.now();
  job.heartbeatAt = Date.now();
  job.state = statusToState(job.status);
  jobs.set(job.id, job);

  const terminal = job.status === 'done' || job.status === 'error';
  const stageChanged = persistStageKey.get(job.id) !== `${job.status}:${job.stage}`;
  if (stageChanged && job.startedAt && job.stage) {
    const t = Math.round((Date.now() - job.startedAt) / 100) / 10;
    job.stageTimings = { ...(job.stageTimings || {}) };
    if (job.stageTimings[job.stage] === undefined) {
      job.stageTimings[job.stage] = t;
      console.log(`[stage] ${job.id.slice(0, 8)} ${job.stage} at +${t.toFixed(1)}s`);
    }
  }
  persistStageKey.set(job.id, `${job.status}:${job.stage}`);
  const last = persistFlushAt.get(job.id) || 0;
  const due = Date.now() - last >= PERSIST_MIN_MS;

  if (terminal || opts?.flush || stageChanged || due) {
    const t = persistTimer.get(job.id);
    if (t) {
      clearTimeout(t);
      persistTimer.delete(job.id);
    }
    await writeRenderStatus(job);
    return;
  }

  if (!persistTimer.has(job.id)) {
    persistTimer.set(
      job.id,
      setTimeout(() => {
        persistTimer.delete(job.id);
        const latest = jobs.get(job.id);
        if (latest) void writeRenderStatus(latest);
      }, PERSIST_MIN_MS)
    );
  }
}

export async function persistRenderFailure(id: string, error: string): Promise<void> {
  const job = (await loadJob(id)) || {
    id,
    status: 'error' as JobStatus,
    state: 'FAILED' as JobState,
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
  if (job.projectId) await clearProjectLock('render', job.projectId, id);
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

export async function loadJob(id: string): Promise<RenderJob | null> {
  // GCS is source of truth — workers run in a separate Cloud Run Job instance.
  const fromGcs = await loadJson<RenderJob>(`renders/${id}/status.json`);
  const job = pickFresherJob(fromGcs, jobs.get(id));
  if (!job) return null;
  job.state = job.state || statusToState(job.status);
  job.heartbeatAt = job.heartbeatAt || job.updatedAt || job.createdAt;
  job.stage = job.stage || (job.status === 'rendering' ? 'normalizing' : job.status);
  jobs.set(id, job);
  return job;
}

/** Last `time=HH:MM:SS.xx` ffmpeg printed in this stderr chunk, in seconds (null if none). */
function ffmpegProgressSeconds(chunk: string): number | null {
  const all = [...chunk.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runCmd(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 180_000,
  /** ffmpeg only: called with output seconds encoded so far. */
  onProgress?: (seconds: number) => void
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Always ignore stdin — ffmpeg otherwise can hang forever waiting for input on Cloud Run
    const finalArgs = cmd === 'ffmpeg' && !args.includes('-nostdin') ? ['-nostdin', ...args] : args;
    const child = spawn(cmd, finalArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const beat = setInterval(() => {
      try {
        renderHeartbeat?.();
      } catch {
        /* ignore */
      }
    }, 10_000);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(
        new Error(
          `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s: ${stderr.slice(-400) || args.slice(0, 6).join(' ')}`
        )
      );
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      clearInterval(beat);
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      const sink = onProgress || (cmd === 'ffmpeg' ? ffmpegProgressSink : null);
      if (sink) {
        const t = ffmpegProgressSeconds(text);
        if (t != null) {
          try {
            sink(t);
          } catch {
            /* progress is best-effort */
          }
        }
      }
    });
    child.on('error', (err) => {
      finish();
      reject(err);
    });
    child.on('close', (code) => {
      finish();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`));
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

/** Display dimensions (rotation applied — ffmpeg autorotates on decode). */
async function ffprobeVideoDims(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await runCmd('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:stream_side_data=rotation:stream_tags=rotate',
      '-of',
      'json',
      file,
    ]);
    const j = JSON.parse(stdout || '{}');
    const s = j?.streams?.[0];
    if (!s?.width || !s?.height) return null;
    const rot = Math.abs(
      Number(s.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0)
    );
    const swap = rot % 180 === 90;
    return swap ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
  } catch {
    return null;
  }
}

/**
 * cover: fill + crop (orientation matches, or a landscape take into 9:16 — only the sides go).
 * blur: fit the whole frame, blurred copy fills the sides (portrait take → 16:9, where a
 *   cover crop would cut the top of the head and the chin).
 * pad_green: fit on chroma green so a greenscreen key replaces the bars with the plate.
 */
export type FrameFitMode = 'cover' | 'blur' | 'pad_green';

export function frameFitModeFor(
  src: { width: number; height: number } | null,
  width: number,
  height: number,
  greenscreen = false
): FrameFitMode {
  if (!src) return 'cover';
  const srcRatio = src.width / src.height;
  const outRatio = width / height;
  const portraitIntoLandscape = srcRatio < 0.95 && outRatio > 1.05;
  if (!portraitIntoLandscape) return 'cover';
  return greenscreen ? 'pad_green' : 'blur';
}

/**
 * Filter chain that maps one video stream to width×height.
 * Single input / single output, so it works inside -vf and inline in -filter_complex.
 */
function frameFitChain(width: number, height: number, zoom: number, mode: FrameFitMode, tag: string): string {
  const z = Math.max(1, Math.min(1.15, zoom || 1));
  const zw = Math.round(width * z);
  const zh = Math.round(height * z);
  if (mode === 'cover') {
    return `scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  const fg =
    `scale=${zw}:${zh}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `crop=w='min(iw\\,${width})':h='min(ih\\,${height})'`;
  if (mode === 'pad_green') {
    return `${fg},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00FF00`;
  }
  const bw = Math.max(2, Math.round(width / 8) * 2);
  const bh = Math.max(2, Math.round(height / 8) * 2);
  return (
    `split[${tag}a][${tag}b];` +
    `[${tag}a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=8:2,` +
    `scale=${width}:${height},eq=brightness=-0.06[${tag}bg];` +
    `[${tag}b]${fg}[${tag}fg];` +
    `[${tag}bg][${tag}fg]overlay=(W-w)/2:(H-h)/2`
  );
}

async function ffprobeHasAudio(file: string): Promise<boolean> {
  try {
    const { stdout } = await runCmd('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      file,
    ]);
    return /audio/i.test(stdout);
  } catch {
    return false;
  }
}

/**
 * Pre-render hard gate: every clip must resolve to durable media with valid range.
 * When a project is available, runs shared EDL preflight (pause snap / overlay checks).
 * Throws with the full unresolved list — never soft-continue.
 */
export function assertRenderableEdl(
  edl: any,
  project?: any
): { expectedDuration: number } {
  const proj = project || edl?.project || null;
  if (proj?.scenes) {
    try {
      const pf = runEdlPreflight({
        project: proj,
        edl,
        plan: edl?.editPlan || proj.editPlan || null,
        autoRepair: true,
      });
      if (pf.edl) {
        edl.clips = pf.edl.clips;
        edl.overlayEvents = pf.edl.overlayEvents;
        edl.warnings = pf.edl.warnings;
        edl.totalDurationSeconds = pf.edl.totalDurationSeconds;
      }
      if (!pf.ok && pf.errors.length) {
        console.warn('[PREFLIGHT] assertRenderableEdl issues:', pf.errors.join('; '));
      }
    } catch (e: any) {
      console.warn('[PREFLIGHT] skipped:', e?.message || e);
    }
  }

  const clips: any[] = edl?.clips || [];
  if (!clips.length) throw new Error('EDL has no clips with media');

  const unresolved: string[] = [];
  let expected = 0;

  for (const clip of clips) {
    if (clip.mediaKind === 'title-card') {
      expected += Math.max(0.25, Number(clip.durationSeconds) || 2);
      continue;
    }
    const url = String(clip.mediaUrl || '');
    const title = String(clip.title || clip.id || 'untitled');
    if (!url || clip.mediaKind === 'missing' || url.startsWith('blob:') || url.startsWith('data:')) {
      unresolved.push(`${title}: missing/blob media`);
      continue;
    }
    const inP = typeof clip.inPoint === 'number' ? clip.inPoint : 0;
    const outP =
      typeof clip.outPoint === 'number'
        ? clip.outPoint
        : inP + Math.max(0.25, Number(clip.durationSeconds) || 0);
    if (!(outP > inP + 0.24)) {
      unresolved.push(`${title}: invalid range ${inP.toFixed(2)}–${outP.toFixed(2)}`);
      continue;
    }
    const segs: Array<{ inPoint: number; outPoint: number }> = Array.isArray(clip.segments)
      ? clip.segments.filter(
          (s: any) => Number.isFinite(s?.inPoint) && Number.isFinite(s?.outPoint) && s.outPoint > s.inPoint + 0.05
        )
      : [];
    expected += segs.length
      ? segs.reduce((a, s) => a + (s.outPoint - s.inPoint), 0)
      : outP - inP;
  }

  if (unresolved.length) {
    throw new Error(
      `Render blocked — ${unresolved.length} unresolved clip(s):\n${unresolved.join('\n')}`
    );
  }

  if (edl.introMode && edl.introMode !== 'none' && edl.introMode !== 'off') {
    expected += Number(edl.introDurationSeconds) || 2.5;
  }
  if (Number(edl.outroSafeSeconds) > 0) {
    expected += Number(edl.outroSafeSeconds);
  }

  return { expectedDuration: expected };
}

/**
 * Post-render hard gate: duration ±0.5s, audio present + not silent, black ≤ bumpers.
 */
export async function verifyMaster(
  output: string,
  expectedDuration: number,
  opts?: { bumperSeconds?: number }
): Promise<void> {
  if (!existsSync(output)) {
    throw new Error('verifyMaster: output file missing');
  }
  const dur = await ffprobeDuration(output);
  if (!dur || Math.abs(dur - expectedDuration) > Math.max(0.5, expectedDuration * 0.08)) {
    throw new Error(
      `verifyMaster: duration ${dur.toFixed(2)}s vs expected ${expectedDuration.toFixed(2)}s`
    );
  }

  const hasAudio = await ffprobeHasAudio(output);
  if (!hasAudio) {
    throw new Error('verifyMaster: master has no audio stream');
  }

  // Mean volume must be louder than -60 dB (not all-silent)
  try {
    const { stderr } = await runCmd(
      'ffmpeg',
      ['-i', output, '-af', 'volumedetect', '-f', 'null', '-'],
      undefined,
      90_000
    );
    const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    const mean = meanMatch ? parseFloat(meanMatch[1]) : NaN;
    if (Number.isFinite(mean) && mean < -60) {
      throw new Error(`verifyMaster: audio essentially silent (mean_volume ${mean} dB)`);
    }
  } catch (e: any) {
    if (String(e?.message || '').includes('verifyMaster:')) throw e;
    console.warn('volumedetect failed:', e?.message);
  }

  // Blackdetect — total black must not exceed intentional bumpers
  const bumper = opts?.bumperSeconds ?? 5;
  try {
    const { stderr } = await runCmd(
      'ffmpeg',
      ['-i', output, '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-an', '-f', 'null', '-'],
      undefined,
      90_000
    );
    let blackTotal = 0;
    const re = /black_duration:(\d+(?:\.\d+)?)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr))) {
      blackTotal += parseFloat(m[1]);
    }
    if (blackTotal > bumper + 0.75) {
      throw new Error(
        `verifyMaster: excessive black frames (${blackTotal.toFixed(2)}s > ${bumper}s bumpers)`
      );
    }
  } catch (e: any) {
    if (String(e?.message || '').includes('verifyMaster:')) throw e;
    console.warn('blackdetect failed:', e?.message);
  }
}

/** Detect non-silent window via silencedetect — trims wave/Action dead air from takes. */
async function detectSpeechWindow(
  input: string
): Promise<{ start: number; end: number } | null> {
  try {
    const total = await ffprobeDuration(input);
    if (!total || total < 1.2) return null;

    let stderr = '';
    try {
      const result = await runCmd(
        'ffmpeg',
        ['-i', input, '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'],
        undefined,
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

    if (!starts.length && !ends.length) return null;

    let speechStart = 0;
    let speechEnd = total;

    // Leading silence: first silence begins near 0
    if (starts.length && starts[0] <= 0.35 && ends.length) {
      speechStart = Math.max(0, ends[0] - 0.15);
    }

    // Trailing silence: last silence_start near end
    if (starts.length) {
      const lastStart = starts[starts.length - 1];
      if (lastStart < total - 0.2 && lastStart > speechStart + 0.5) {
        speechEnd = Math.min(total, lastStart + 0.25);
      }
    }

    speechStart = Math.max(0, speechStart);
    speechEnd = Math.min(total, Math.max(speechStart + 0.8, speechEnd));

    if (speechEnd - speechStart < 0.8) return null;
    if (speechStart < 0.05 && speechEnd > total - 0.1) return null;
    return { start: speechStart, end: speechEnd };
  } catch {
    return null;
  }
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Map editorial transition primitives (+ legacy names) → FFmpeg xfade name.
 * hard_cut / j_cut / l_cut / cutaway → null (concat / audio-only handling).
 */
function xfadeName(transition: string): string | null {
  const t = (transition || 'hard_cut').toLowerCase().replace(/_/g, '-');
  if (
    t === 'cut' ||
    t === 'hard-cut' ||
    t === 'hard_cut' ||
    t === 'cutaway' ||
    t === 'match-cut' ||
    t === 'match_cut' ||
    t === 'j-cut' ||
    t === 'j_cut' ||
    t === 'l-cut' ||
    t === 'l_cut'
  ) {
    return null;
  }
  if (t === 'cross-dissolve' || t === 'crossfade' || t === 'dissolve' || t === 'cross_dissolve') {
    return 'fade';
  }
  if (t === 'dip-black' || t === 'dip_black' || t === 'fade-to-black') return 'fadeblack';
  if (t === 'dip-white' || t === 'dip_white') return 'fadewhite';
  if (t === 'push') return 'slideleft';
  if (t === 'whip' || t === 'whip-pan') return 'wiperight';
  if (t === 'zoom' || t === 'zoom-snap') return 'fade'; // punch-in handled in normalize; dissolve as fallback
  if (t === 'light-leak') return 'fade';
  return 'fade';
}

function isJlCut(transition?: string): 'j' | 'l' | null {
  const t = (transition || '').toLowerCase().replace(/-/g, '_');
  if (t === 'j_cut') return 'j';
  if (t === 'l_cut') return 'l';
  return null;
}

function captionStyleAss(style: string): string {
  // PrimaryColour & Outline in ASS &HAABBGGRR
  if (style === 'tiktok-yellow') {
    return 'Fontsize=48,PrimaryColour=&H0000FCFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=3,Shadow=0,Alignment=2,MarginV=80';
  }
  if (style === 'studio-box') {
    return 'Fontsize=42,PrimaryColour=&H00000000&,BackColour=&H00FFFFFF&,BorderStyle=4,Outline=0,Shadow=0,Alignment=2,MarginV=80';
  }
  if (style === 'subtle-sub') {
    return 'Fontsize=36,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70';
  }
  return 'Fontsize=44,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=80';
}

function rawExtensionForClip(clip: { mediaKind?: string; mimeType?: string; mediaUrl?: string | null }): string {
  if (clip.mediaKind === 'image') return 'jpg';
  const mime = String(clip.mimeType || '').toLowerCase();
  const url = String(clip.mediaUrl || '').toLowerCase();
  if (mime.includes('quicktime') || url.includes('.mov')) return 'mov';
  if (mime.includes('mp4') || url.includes('.mp4') || url.includes('.m4v')) return 'mp4';
  if (mime.includes('webm') || url.includes('.webm')) return 'webm';
  return 'mp4';
}

async function downloadToFile(urlOrPath: string, dest: string): Promise<void> {
  if (urlOrPath.startsWith('blob:')) {
    throw new Error('Clip still has a local preview URL — save the take to cloud first.');
  }
  if (urlOrPath.startsWith('data:')) {
    const match = urlOrPath.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL');
    await fs.writeFile(dest, Buffer.from(match[2], 'base64'));
    return;
  }

  if (urlOrPath.startsWith('gs://')) {
    const storage = getStorage();
    if (!storage) throw new Error('GCS not configured');
    const without = urlOrPath.slice(5);
    const slash = without.indexOf('/');
    const bucket = without.slice(0, slash);
    const object = without.slice(slash + 1);
    await storage.bucket(bucket).file(object).download({ destination: dest });
    return;
  }

  if (urlOrPath.startsWith('/') && existsSync(urlOrPath)) {
    await fs.copyFile(urlOrPath, dest);
    return;
  }

  // Relative public asset
  const publicPath = path.resolve('public', urlOrPath.replace(/^\//, ''));
  const distPath = path.resolve('dist', urlOrPath.replace(/^\//, ''));
  if (existsSync(publicPath)) {
    await fs.copyFile(publicPath, dest);
    return;
  }
  if (existsSync(distPath)) {
    await fs.copyFile(distPath, dest);
    return;
  }

  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    const res = await fetch(urlOrPath);
    if (!res.ok) throw new Error(`Failed to fetch ${urlOrPath}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    return;
  }

  // Treat as GCS object key inside configured bucket
  const storage = getStorage();
  if (storage && GCS_BUCKET) {
    try {
      await storage.bucket(GCS_BUCKET).file(urlOrPath.replace(/^\//, '')).download({ destination: dest });
      return;
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Unable to resolve media: ${urlOrPath.slice(0, 80)}`);
}

async function normalizeClip(
  input: string,
  output: string,
  width: number,
  height: number,
  isImage: boolean,
  durationHint: number,
  opts?: {
    inPoint?: number;
    outPoint?: number;
    zoom?: number;
    skipSilenceDetect?: boolean;
    /** Soft A/V fade-out at end of clip (seconds) */
    fadeOutSeconds?: number;
    /** Proxy / rough-cut path: skip heavy denoise */
    fast?: boolean;
    /** Cleanup toggle: false skips highpass+afftdn. Default true. */
    denoise?: boolean;
    /** Intermediate encode quality (defaults: veryfast / crf 14). */
    crf?: number;
    preset?: string;
    audioBitrate?: string;
    fit?: FrameFitMode;
    /** Output seconds encoded so far (main encode only). */
    onProgress?: (seconds: number) => void;
  }
): Promise<number> {
  const encCrf = String(opts?.crf ?? 14);
  const encPreset = opts?.preset || 'veryfast';
  const encAudioBr = opts?.audioBitrate || '192k';
  const zoom = Math.max(1, Math.min(1.15, opts?.zoom || 1));
  const fit: FrameFitMode = opts?.fit || 'cover';
  const fadeOut = Math.max(0, Math.min(1.2, opts?.fadeOutSeconds || 0));
  const trimDurHint =
    typeof opts?.inPoint === 'number' &&
    typeof opts?.outPoint === 'number' &&
    opts.outPoint > opts.inPoint
      ? opts.outPoint - opts.inPoint
      : durationHint || 0;
  const ffTimeout = ffmpegTimeoutMs(trimDurHint || durationHint || 60);
  const fadeAt =
    fadeOut > 0 && trimDurHint > fadeOut + 0.15 ? Math.max(0, trimDurHint - fadeOut) : -1;
  const fadeVf = fadeAt >= 0 ? `,fade=t=out:st=${fadeAt.toFixed(3)}:d=${fadeOut.toFixed(3)}` : '';
  // Audio should never mute spoken dialogue or CTA words prematurely.
  // Use a subtle 0.05s anti-pop tail fade at the very boundary edge.
  const audioFadeDur = Math.min(0.05, fadeOut > 0 ? fadeOut : 0.05);
  const audioFadeAt = trimDurHint > audioFadeDur + 0.1 ? Math.max(0, trimDurHint - audioFadeDur) : -1;
  const fadeAf = audioFadeAt >= 0 ? `,afade=t=out:st=${audioFadeAt.toFixed(3)}:d=${audioFadeDur.toFixed(3)}` : '';
  // Fill the frame (cover + crop) when orientation matches; blurred side fill when it doesn't.
  const vf = `${frameFitChain(width, height, zoom, fit, 'nf')},setsar=1,fps=30,format=yuv420p,settb=1/30,setpts=N/(30*TB)${fadeVf}`;

  if (isImage) {
    const dur = Math.max(1.5, Math.min(durationHint || 2.5, 4));
    const frames = Math.round(dur * 30);
    await runCmd('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-i',
      input,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+0.0008,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=30,format=yuv420p,settb=1/30,setpts=N/(30*TB)`,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      String(dur),
      '-r',
      '30',
      '-video_track_timescale',
      '30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      '-preset',
      encPreset,
      '-crf',
      encCrf,
      output,
    ], undefined, ffTimeout);
    return dur;
  }

  // Get actual duration of the input file before applying in/out trims
  const actualSrcDur = await ffprobeDuration(input);
  let effectiveIn = opts?.inPoint;
  let effectiveOut = opts?.outPoint;
  if (actualSrcDur > 0) {
    if (typeof effectiveIn === 'number') {
      if (effectiveIn >= actualSrcDur - 0.15) {
        console.warn(`[NORMALIZE] inPoint ${effectiveIn.toFixed(2)}s is at or beyond source duration ${actualSrcDur.toFixed(2)}s — clamping`);
        effectiveIn = Math.max(0, actualSrcDur - 0.5);
      }
    }
    if (typeof effectiveOut === 'number') {
      if (effectiveOut > actualSrcDur) {
        console.log(`[NORMALIZE] clamped outPoint ${effectiveOut.toFixed(2)}s to source duration ${actualSrcDur.toFixed(2)}s`);
        effectiveOut = actualSrcDur;
      }
    }
  }

  // Prefer EDL in/out points; otherwise silence-detect leading/trailing dead air
  const trimArgs: string[] = [];
  const hasInOut =
    typeof effectiveIn === 'number' &&
    typeof effectiveOut === 'number' &&
    effectiveOut > effectiveIn + 0.15;

  if (hasInOut) {
    const cutDur = Math.max(0.2, effectiveOut! - effectiveIn!);
    trimArgs.push('-ss', effectiveIn!.toFixed(3), '-t', cutDur.toFixed(3));
    console.log(
      `normalizeClip EDL trim ${effectiveIn!.toFixed(2)}s → ${effectiveOut!.toFixed(2)}s (dur=${cutDur.toFixed(2)}s) zoom=${zoom}` +
        (fadeAt >= 0 ? ` fadeOut=${fadeOut}s` : '')
    );
  } else if (!opts?.skipSilenceDetect) {
    const window = await detectSpeechWindow(input);
    if (window) {
      const cutDur = Math.max(0.2, window.end - window.start);
      trimArgs.push('-ss', window.start.toFixed(3), '-t', cutDur.toFixed(3));
      console.log(
        `normalizeClip silence-trim ${window.start.toFixed(2)}s → ${window.end.toFixed(2)}s (dur=${cutDur.toFixed(2)}s)`
      );
    }
  }

  // Loudnorm is applied once on the final master — never per-clip (that caused volume pumping).
  const afBase = opts?.fast
    ? 'aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS' + fadeAf
    : 'aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,' +
      (opts?.denoise === false ? '' : 'highpass=f=80,afftdn=nr=12:nf=-25,') +
      'equalizer=f=3000:t=q:w=1.2:g=2.5,asetpts=PTS-STARTPTS' +
      fadeAf;

  try {
    await runCmd('ffmpeg', [
      '-y',
      '-i',
      input,
      ...trimArgs,
      '-vf',
      vf,
      '-af',
      afBase,
      '-r',
      '30',
      '-video_track_timescale',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      encPreset,
      '-crf',
      encCrf,
      '-c:a',
      'aac',
      '-b:a',
      encAudioBr,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      output,
    ], undefined, ffTimeout, opts?.onProgress);
  } catch (normErr: any) {
    // anullsrc is ONLY allowed for images/title cards (handled above).
    // Video with an audio stream must not silently become mute.
    const hasAudio = await ffprobeHasAudio(input);
    if (hasAudio) {
      throw new Error(
        `normalizeClip audio failed for video with audio stream: ${normErr?.message || normErr}`
      );
    }
    // Video without audio stream — synthesize silent track so concat stays stereo
    await runCmd('ffmpeg', [
      '-y',
      '-i',
      input,
      ...trimArgs,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-vf',
      vf,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-r',
      '30',
      '-video_track_timescale',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      encPreset,
      '-crf',
      encCrf,
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      output,
    ], undefined, ffTimeout);
  }

  const dur = await ffprobeDuration(output);
  return dur || durationHint || 3;
}

/**
 * Render one scene take as a continuous clip from `segments` (cleanup + punch zooms).
 * Single video encode: trim per segment straight from the source, fit/zoom, concat, and
 * (optionally) chroma-key over a static background plate in the same filtergraph.
 * Audio is denoised once over the whole take (audio-only pass, so afftdn doesn't restart
 * per piece); 10 ms afade only where source time is discontinuous (real cleanup cuts).
 */
export async function renderSceneSegments(
  input: string,
  output: string,
  width: number,
  height: number,
  segments: Array<{ inPoint: number; outPoint: number; zoom?: number }>,
  opts?: {
    denoise?: boolean;
    fast?: boolean;
    fadeOutSeconds?: number;
    crf?: number;
    preset?: string;
    audioBitrate?: string;
    fit?: FrameFitMode;
    /** Key virtual green against this plate in the same encode (whole-scene background). */
    greenscreen?: { platePath: string; plateIsVideo?: boolean; despill?: boolean };
    /** Output seconds encoded so far (main encode only). */
    onProgress?: (seconds: number) => void;
  }
): Promise<number> {
  const segs = (segments || []).filter((s) => s.outPoint > s.inPoint + 0.05);
  if (!segs.length) {
    throw new Error('renderSceneSegments: no valid segments');
  }

  const totalHint = segs.reduce((a, s) => a + (s.outPoint - s.inPoint), 0);
  const ffTimeout = ffmpegTimeoutMs(totalHint || 60);
  const encCrf = String(opts?.crf ?? 14);
  const encPreset = opts?.preset || 'veryfast';
  const encAudioBr = opts?.audioBitrate || '192k';
  const fit: FrameFitMode = opts?.fit || 'cover';

  const denoiseChain =
    opts?.fast || opts?.denoise === false
      ? 'aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo'
      : 'aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=80,afftdn=nr=12:nf=-25,equalizer=f=3000:t=q:w=1.2:g=2.5';

  // Audio-only denoise pass (no video re-encode); segments then trim from this WAV.
  const workDir = path.dirname(output);
  const voiceWav = path.join(workDir, `scene-voice-${path.basename(output)}.wav`);
  const hasAudio = await ffprobeHasAudio(input);
  if (hasAudio) {
    await runCmd(
      'ffmpeg',
      ['-y', '-i', input, '-vn', '-af', denoiseChain, '-c:a', 'pcm_s16le', voiceWav],
      undefined,
      ffTimeout
    );
  }

  const inputArgs: string[] = ['-y', '-i', input];
  if (hasAudio) inputArgs.push('-i', voiceWav);
  else inputArgs.push('-f', 'lavfi', '-t', (totalHint + 1).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const gs = opts?.greenscreen;
  if (gs) {
    if (gs.plateIsVideo) inputArgs.push('-stream_loop', '-1', '-t', (totalHint + 1).toFixed(3), '-i', gs.platePath);
    else inputArgs.push('-loop', '1', '-framerate', '30', '-t', (totalHint + 1).toFixed(3), '-i', gs.platePath);
  }

  let filter = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dur = s.outPoint - s.inPoint;
    const fitChain = frameFitChain(width, height, s.zoom || 1, fit, `f${i}`);
    // Micro-fade only at real cleanup cuts (source discontinuity)
    const prevContiguous = i > 0 && Math.abs(segs[i - 1].outPoint - s.inPoint) < 0.02;
    const nextContiguous =
      i < segs.length - 1 && Math.abs(s.outPoint - segs[i + 1].inPoint) < 0.02;
    let aFade = '';
    if (i > 0 && !prevContiguous) aFade += `,afade=t=in:st=0:d=0.01`;
    if (i < segs.length - 1 && !nextContiguous) {
      aFade += `,afade=t=out:st=${Math.max(0, dur - 0.01).toFixed(3)}:d=0.01`;
    }
    let vFade = '';
    if (i === segs.length - 1 && (opts?.fadeOutSeconds || 0) > 0) {
      const fo = Math.min(1.2, opts!.fadeOutSeconds!);
      const at = Math.max(0, dur - fo);
      vFade = `,fade=t=out:st=${at.toFixed(3)}:d=${fo.toFixed(3)}`;
      aFade += `,afade=t=out:st=${at.toFixed(3)}:d=${fo.toFixed(3)}`;
    }

    filter +=
      `[0:v]trim=start=${s.inPoint.toFixed(3)}:end=${s.outPoint.toFixed(3)},setpts=PTS-STARTPTS,${fitChain},setsar=1,fps=30,format=yuv420p${vFade}[v${i}];` +
      `[1:a]atrim=start=${s.inPoint.toFixed(3)}:end=${s.outPoint.toFixed(3)},asetpts=PTS-STARTPTS${aFade}[a${i}];`;
  }
  const vInputs = segs.map((_, i) => `[v${i}]`).join('');
  const aInputs = segs.map((_, i) => `[a${i}]`).join('');
  const vCat = gs ? '[vcat]' : '[vout]';
  filter += `${vInputs}concat=n=${segs.length}:v=1:a=0${vCat};${aInputs}concat=n=${segs.length}:v=0:a=1[aout]`;
  if (gs) {
    if (despillSupported === null) despillSupported = await ffmpegHasFilter('despill');
    const despill =
      gs.despill && despillSupported ? ',format=gbrap,despill=type=green:mix=0.6:expand=0.1' : '';
    filter +=
      `;[2:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,format=yuv420p,setsar=1[plate];` +
      `[vcat]chromakey=color=0x00FF00:similarity=0.2:blend=0.08${despill},format=yuva420p[fg];` +
      `[plate][fg]overlay=0:0:format=auto:shortest=1,format=yuv420p[vout]`;
  }

  await runCmd(
    'ffmpeg',
    [
      ...inputArgs,
      '-filter_complex',
      filter,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      encPreset,
      '-crf',
      encCrf,
      '-c:a',
      'aac',
      '-b:a',
      encAudioBr,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-r',
      '30',
      output,
    ],
    undefined,
    ffTimeout,
    opts?.onProgress
  );

  await fs.unlink(voiceWav).catch(() => undefined);

  const dur = await ffprobeDuration(output);
  console.log(
    `renderSceneSegments ${segs.length} segments → ${dur.toFixed(2)}s (source spans ${segs[0].inPoint.toFixed(2)}–${segs[segs.length - 1].outPoint.toFixed(2)}) fit=${fit}${gs ? ' +greenscreen' : ''}`
  );
  return dur || totalHint;
}

/** Two-pass loudnorm on the final master (linear=true). */
async function applyLoudnormPass(input: string, output: string, timeoutMs: number): Promise<void> {
  let measured: { I?: string; TP?: string; LRA?: string; thresh?: string; offset?: string } = {};
  try {
    const probe = await runCmd(
      'ffmpeg',
      ['-i', input, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
      undefined,
      timeoutMs
    );
    const blob = (probe.stderr || '') + (probe.stdout || '');
    const m = blob.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      measured = {
        I: String(j.input_i),
        TP: String(j.input_tp),
        LRA: String(j.input_lra),
        thresh: String(j.input_thresh),
        offset: String(j.target_offset),
      };
    }
  } catch (err) {
    console.warn('loudnorm measure failed, using single-pass:', (err as Error).message?.slice(0, 160));
  }

  const af =
    measured.I && measured.TP && measured.LRA && measured.thresh && measured.offset
      ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.I}:measured_TP=${measured.TP}:measured_LRA=${measured.LRA}:measured_thresh=${measured.thresh}:offset=${measured.offset}:linear=true:print_format=summary`
      : 'loudnorm=I=-16:TP=-1.5:LRA=11';

  await runCmd(
    'ffmpeg',
    [
      '-y',
      '-i',
      input,
      '-af',
      af,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      output,
    ],
    undefined,
    timeoutMs
  );
}

/**
 * Compare speech-window RMS of master vs a reference (assembled voice before music).
 * Returns a warning string when speech appears to have dropped >10 dB, or when the
 * pre-music bed itself is suspiciously quiet (voice already lost at concat).
 */
async function checkSpeechIntegrity(
  voiceRef: string,
  master: string
): Promise<string | null> {
  const rmsOf = async (file: string): Promise<number | null> => {
    try {
      const { stderr } = await runCmd(
        'ffmpeg',
        ['-i', file, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'],
        undefined,
        90_000
      );
      const m = stderr.match(/RMS level dB:\s*([-\d.]+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };
  const ref = await rmsOf(voiceRef);
  const out = await rmsOf(master);
  if (ref == null || !Number.isFinite(ref)) return null;
  // Pre-music bed should carry speech. Typical talking-head sits above -35 dB RMS.
  if (ref < -42) {
    return `Speech audio missing before music mix (voice bed RMS ${ref.toFixed(1)} dB). Check cleanup / concat.`;
  }
  if (out == null || !Number.isFinite(out)) return null;
  // Music mix can legitimately lower average a few dB; >10 dB means voice is gone.
  if (out < ref - 10) {
    return `Speech audio dropped ~${(ref - out).toFixed(1)} dB vs pre-music mix (ref ${ref.toFixed(1)} → ${out.toFixed(1)} dB). Voice may be missing.`;
  }
  return null;
}

/** Sample a few frames from base video; return fraction of chroma-green pixels (0–1). */
async function sampleChromaGreenRatio(videoPath: string, workDir: string): Promise<number> {
  const sampleW = 160;
  const sampleH = 90;
  const frameCount = 3;
  const dur = await ffprobeDuration(videoPath);
  if (dur < 0.05) return 0;

  let green = 0;
  let total = 0;
  const fracs = [0.15, 0.45, 0.75];

  for (let i = 0; i < frameCount; i++) {
    const t = Math.min(dur * 0.95, Math.max(0, dur * (fracs[i] ?? 0.5)));
    const rawPath = path.join(workDir, `gs-sample-${i}.rgb`);
    try {
      await runCmd(
        'ffmpeg',
        [
          '-ss',
          t.toFixed(3),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale=${sampleW}:${sampleH}:force_original_aspect_ratio=decrease,pad=${sampleW}:${sampleH}:(ow-iw)/2:(oh-ih)/2`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-y',
          rawPath,
        ],
        undefined,
        30_000
      );
      const buf = await fs.readFile(rawPath);
      for (let p = 0; p + 2 < buf.length; p += 3) {
        const r = buf[p];
        const g = buf[p + 1];
        const b = buf[p + 2];
        total += 1;
        // Chroma green: G dominant, not too dark
        if (g > 80 && g > r * 1.35 && g > b * 1.35) green += 1;
      }
      await fs.unlink(rawPath).catch(() => undefined);
    } catch {
      /* skip failed sample */
    }
  }

  return total > 0 ? green / total : 0;
}

let despillSupported: boolean | null = null;
async function ffmpegHasFilter(name: string): Promise<boolean> {
  try {
    const { stdout } = await runCmd('ffmpeg', ['-hide_banner', '-filters'], undefined, 15_000);
    return new RegExp(`\\s${name}\\s`).test(stdout);
  } catch {
    return false;
  }
}

async function overlayBrollInserts(
  basePath: string,
  outPath: string,
  inserts: Array<{
    mediaUrl?: string;
    mediaType?: string;
    startOffsetSeconds?: number;
    durationSeconds?: number;
    accepted?: boolean;
    layout?: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
  }>,
  workDir: string,
  width: number,
  height: number,
  index: number,
  enc?: { crf?: number; preset?: string; despill?: boolean }
): Promise<string[]> {
  const warnings: string[] = [];
  const accepted = (inserts || []).filter((b) => b.mediaUrl && b.accepted !== false);
  if (!accepted.length) {
    await fs.copyFile(basePath, outPath);
    return warnings;
  }

  const baseDur = Math.max(0.3, await ffprobeDuration(basePath));
  const hasGreenscreen = accepted.some((b) => b.layout === 'greenscreen');
  let greenscreenChecked = false;
  /** When base lacks virtual green, skip all greenscreen inserts for this clip. */
  let skipGreenscreenKey = false;
  if (hasGreenscreen && despillSupported === null) {
    despillSupported = await ffmpegHasFilter('despill');
  }

  const inputArgs: string[] = ['-y', '-i', basePath];
  let filter = '';
  let last = '[0:v]';
  let inIdx = 1;
  let overlays = 0;

  for (let i = 0; i < accepted.length; i++) {
    const ins = accepted[i];
    const isImage = ins.mediaType !== 'video';
    const layout = ins.layout || 'pip_br';
    const raw = path.join(workDir, `broll-${index}-${i}${isImage ? '.jpg' : '.mp4'}`);
    try {
      await downloadToFile(ins.mediaUrl!, raw);
    } catch (dlErr: any) {
      const msg = (dlErr?.message || dlErr || '').toString().slice(0, 160);
      // A required greenscreen plate must never be silently dropped.
      if (layout === 'greenscreen') {
        throw new Error(`Greenscreen background could not be downloaded: ${msg}`);
      }
      console.warn(`[OVERLAY] skipped download for insert ${i}: ${msg}`);
      continue;
    }
    const start = Math.max(0, Math.min(baseDur - 0.2, ins.startOffsetSeconds || 0));
    const hold = Math.max(1.4, ins.durationSeconds || 2.2);
    const end = Math.min(baseDur, start + hold);
    const window = Math.max(0.5, end - start);
    // Plate is re-timed to begin at `start`, so it only needs to cover the visible window.
    const plateHold = window + 0.5;
    if (isImage) {
      inputArgs.push('-loop', '1', '-framerate', '30', '-t', plateHold.toFixed(3), '-i', raw);
    } else {
      // Loop short video plates to cover the window
      inputArgs.push('-stream_loop', '-1', '-t', plateHold.toFixed(3), '-i', raw);
    }
    const shift = `setpts=PTS-STARTPTS+${start.toFixed(3)}/TB`;
    const fadeInSt = start;
    const fadeOutSt = Math.max(start, end - 0.28);
    const frames = Math.max(2, Math.ceil(plateHold * 30));
    /** Cover-fit plate. Greenscreen stays static (Ken Burns + zoompan pixel rounding caused shake). */
    const coverPlate = (forGreenscreen: boolean): string => {
      if (isImage && !forGreenscreen) {
        // Upscale 4× before zoompan so pixel-rounding jitter disappears on b-roll stills.
        const w2 = Math.round(width * 4);
        const h2 = Math.round(height * 4);
        return (
          `scale=${w2}:${h2}:force_original_aspect_ratio=increase,crop=${w2}:${h2},trim=end_frame=1,` +
          `zoompan=z='min(1+0.0007*on,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=30`
        );
      }
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30`;
    };

    if (layout === 'greenscreen') {
      if (!greenscreenChecked) {
        greenscreenChecked = true;
        // MediaPipe virtual green is near-pure #00FF00. Raw camera takes are typically <20%.
        const ratio = await sampleChromaGreenRatio(basePath, workDir);
        // Close-up talking heads often show only ~8–15% pure #00FF00. Skip only when
        // essentially no green is present (raw camera / failed segmenter).
        if (ratio < 0.04) {
          skipGreenscreenKey = true;
          const msg = `Virtual background skipped on clip ${index + 1}: take was not recorded with virtual green (${(ratio * 100).toFixed(1)}% green). Re-shoot with Virtual background ON.`;
          warnings.push(msg);
          console.warn(`[greenscreen] ${msg}`);
        } else if (ratio < 0.15) {
          console.warn(
            `[greenscreen] low green ratio ${(ratio * 100).toFixed(1)}% on clip ${index + 1} — keying anyway (close-up OK)`
          );
        }
      }
      if (skipGreenscreenKey) {
        // Drop this plate input — leave talking head untouched (no hole-punch keying).
        inIdx += 1;
        continue;
      }
      // Base [0] stays timeline primary. Plate is BG only during enable window.
      // Key green FROM base → person with alpha; composite over plate; swap in over original.
      const n = overlays;
      filter += `[${inIdx}:v]${coverPlate(true)},format=yuv420p,${shift}[bg${n}];`;
      filter += `${last}split[orig${n}][tokey${n}];`;
      const despill =
        despillSupported && enc?.despill !== false
          ? ',format=gbrap,despill=type=green:mix=0.6:expand=0.1'
          : '';
      filter += `[tokey${n}]chromakey=color=0x00FF00:similarity=0.2:blend=0.08${despill},format=yuva420p[fg${n}];`;
      filter += `[bg${n}][fg${n}]overlay=0:0:format=auto[keyed${n}];`;
      filter += `[orig${n}][keyed${n}]overlay=0:0:format=auto:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[gs${n}];`;
      last = `[gs${n}]`;
      inIdx += 1;
      overlays += 1;
      continue;
    }

    let scaleFilter: string;
    let overlayXY: string;
    const alphaFade = `format=yuva420p,${shift},fade=t=in:st=${fadeInSt.toFixed(2)}:d=0.22:alpha=1,fade=t=out:st=${fadeOutSt.toFixed(2)}:d=0.25:alpha=1`;
    if (layout === 'pip_br' || layout === 'pip_bl') {
      const pipW = Math.max(160, Math.round(width * 0.35));
      const pipH = Math.max(120, Math.round(height * 0.35));
      const margin = Math.max(12, Math.round(Math.min(width, height) * 0.03));
      scaleFilter = `[${inIdx}:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=decrease,pad=${pipW}:${pipH}:(ow-iw)/2:(oh-ih)/2:black,fps=30,${alphaFade}[ov${overlays}]`;
      overlayXY =
        layout === 'pip_br' ? `W-w-${margin}:H-h-${margin}` : `${margin}:H-h-${margin}`;
    } else {
      // full: plate ON TOP of base during enable window (never replaces whole clip timeline)
      scaleFilter = `[${inIdx}:v]${coverPlate(false)},${alphaFade}[ov${overlays}]`;
      overlayXY = '0:0';
    }
    filter += `${scaleFilter};`;
    const nextLabel = `[mix${overlays}]`;
    filter += `${last}[ov${overlays}]overlay=${overlayXY}:format=auto:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'${nextLabel};`;
    last = nextLabel;
    inIdx += 1;
    overlays += 1;
  }

  if (!overlays) {
    await fs.copyFile(basePath, outPath);
    return warnings;
  }

  try {
    await runCmd('ffmpeg', [
      ...inputArgs,
      '-filter_complex',
      `${filter}${last}format=yuv420p[vout]`,
      '-map',
      '[vout]',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      enc?.preset || 'veryfast',
      '-crf',
      String(enc?.crf ?? 14),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      // Force output duration from base — never let a short plate truncate the take
      '-t',
      baseDur.toFixed(3),
      outPath,
    ], undefined, ffmpegTimeoutMs(baseDur || 60));
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 400);
    if (hasGreenscreen && !skipGreenscreenKey) {
      // Greenscreen / virtual background is a required look: surface it in the job status.
      throw new Error(`Greenscreen compositing failed: ${msg}`);
    }
    // Optional PiP / full cutaways (or skipped virtual BG): soft-fail to the untouched base clip.
    console.warn('b-roll overlay failed, using base clip:', msg?.slice(0, 200));
    await fs.copyFile(basePath, outPath);
  }
  return warnings;
}

function buildAssFile(
  clips: Array<{
    durationSeconds: number;
    captions: Array<{ start: number; end: number; text: string }>;
    transition: string;
    transitionDuration: number;
  }>,
  /** Seconds of intro BEFORE clip 0 (legacy; usually 0 for after-hook) */
  introDur: number,
  captionStyle: string,
  width: number,
  height: number,
  /** After-hook sting duration — inserted AFTER clip 0 on the assembled timeline */
  afterHookIntroDur = 0
): string {
  const style = captionStyleAss(captionStyle);
  let body = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${style.includes('Fontsize=') ? '' : '44,'}${style},0,0,0,0,100,100,0,0,1,2,0,2,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Fix style line properly
  body = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,44,&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const toTs = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.floor((sec % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // Assembled timeline: [optional pre-intro] → clip0 → [after-hook sting] → rest
  let cursor = Math.max(0, introDur);
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipStartOnMaster = cursor;
    for (const cap of clip.captions || []) {
      if (!cap.text?.trim()) continue;
      // Never start a caption before this clip's assembled in-point or at t<0
      const start = Math.max(clipStartOnMaster, cursor + Math.max(0, cap.start));
      const end = Math.max(start, cursor + Math.min(clip.durationSeconds, Math.max(0, cap.end || clip.durationSeconds)));
      if (end <= start) continue;
      const text = escapeAss(cap.text.length > 110 ? cap.text.slice(0, 107) + '…' : cap.text);
      body += `Dialogue: 0,${toTs(start)},${toTs(end)},Default,,0,0,0,,${text}\n`;
    }
    cursor += clip.durationSeconds;
    // After hook (clip 0), shift residual captions past the brand sting
    if (i === 0 && afterHookIntroDur > 0) {
      cursor += afterHookIntroDur;
    }
    if (i < clips.length - 1 && xfadeName(clip.transition || clips[i + 1]?.transition || 'cut')) {
      const td = clips[i + 1]?.transitionDuration || 0.35;
      if (xfadeName(clips[i + 1]?.transition || 'cut')) cursor -= td;
    }
  }
  return body;
}

async function renderIntroBumper(
  outPath: string,
  width: number,
  height: number,
  duration: number,
  channel: any,
  workDir: string
): Promise<void> {
  const name = escapeDrawtext(channel.channelName || 'My Channel');
  const handle = escapeDrawtext(channel.youtubeChannelHandle || '');
  const tagline = escapeDrawtext(channel.youtubeTagline || '');
  const color = (channel.brandColor || '#1A73E8').replace('#', '');
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontRegular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  // Prefer an uploaded/existing intro video clip
  if (channel.introVideoUrl) {
    try {
      const videoLocal = path.join(workDir, 'intro-src.mp4');
      await downloadToFile(channel.introVideoUrl, videoLocal);
      await runCmd('ffmpeg', [
        '-y',
        '-i',
        videoLocal,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-vf',
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,settb=1/30,setpts=N/(30*TB)`,
        '-t',
        String(duration),
        '-r',
        '30',
        '-video_track_timescale',
        '30',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-shortest',
        '-preset',
        'veryfast',
        outPath,
      ]);
      return;
    } catch (err) {
      console.warn('Intro video normalize failed, falling back to still:', (err as Error).message);
    }
  }

  let bgPath: string | null = null;
  const bgUrl = channel.introBackgroundUrl || channel.logoUrl;
  if (bgUrl) {
    try {
      bgPath = path.join(workDir, 'intro-bg.jpg');
      await downloadToFile(bgUrl, bgPath);
    } catch {
      bgPath = null;
    }
  }

  // Light Ken Burns zoom on still plates
  const kenBurns = bgPath
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(1.12,1+0.0015*on)':d=${Math.max(30, Math.round(duration * 30))}:s=${width}x${height}:fps=30`
    : null;

  const textFilters = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill`,
    `drawbox=x=(w-180)/2:y=h*0.38:w=180:h=4:color=0x${color}:t=fill`,
    `drawtext=fontfile=${font}:text='${name}':fontsize=${Math.round(height * 0.045)}:fontcolor=white:x=(w-text_w)/2:y=(h*0.42)`,
    `drawtext=fontfile=${fontRegular}:text='${handle}':fontsize=${Math.round(height * 0.028)}:fontcolor=0xE8EAED:x=(w-text_w)/2:y=(h*0.50)`,
    tagline
      ? `drawtext=fontfile=${fontRegular}:text='${tagline}':fontsize=${Math.round(height * 0.022)}:fontcolor=0xDADCE0:x=(w-text_w)/2:y=(h*0.56)`
      : null,
    'settb=1/30',
    'setpts=N/(30*TB)',
  ]
    .filter(Boolean)
    .join(',');

  if (bgPath) {
    await runCmd('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-i',
      bgPath,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-vf',
      `${kenBurns},${textFilters}`,
      '-t',
      String(duration),
      '-r',
      '30',
      '-video_track_timescale',
      '30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      '-preset',
      'veryfast',
      outPath,
    ]);
    return;
  }

  await runCmd('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x0d1117:s=${width}x${height}:d=${duration}:r=30`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-vf',
    textFilters,
    '-t',
    String(duration),
    '-r',
    '30',
    '-video_track_timescale',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    '-preset',
    'veryfast',
    outPath,
  ]);
}

async function renderOutroSafe(
  outPath: string,
  width: number,
  height: number,
  duration: number,
  channel: any
): Promise<void> {
  const cta = escapeDrawtext(channel.youtubeOutroCta || 'Thanks for watching');
  const handle = escapeDrawtext(channel.youtubeChannelHandle || '');
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontRegular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  await runCmd('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x090d16:s=${width}x${height}:d=${duration}:r=30`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-vf',
    [
      `drawtext=fontfile=${font}:text='${cta}':fontsize=${Math.round(height * 0.035)}:fontcolor=white:x=(w-text_w)/2:y=(h*0.42)`,
      `drawtext=fontfile=${fontRegular}:text='${handle}':fontsize=${Math.round(height * 0.025)}:fontcolor=0x9AA0A6:x=(w-text_w)/2:y=(h*0.50)`,
      `drawtext=fontfile=${fontRegular}:text='Add end screen in YouTube Studio':fontsize=${Math.round(height * 0.02)}:fontcolor=0x5F6368:x=(w-text_w)/2:y=(h*0.58)`,
      'settb=1/30',
      'setpts=N/(30*TB)',
    ].join(','),
    '-t',
    String(duration),
    '-r',
    '30',
    '-video_track_timescale',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    '-preset',
    'veryfast',
    outPath,
  ]);
}

async function assembleWithXfade(
  clipPaths: string[],
  transitions: Array<{ name: string | null; duration: number; jl?: 'j' | 'l' }>,
  durations: number[],
  outPath: string
): Promise<void> {
  if (clipPaths.length === 0) throw new Error('No clips to assemble');
  if (clipPaths.length === 1) {
    await fs.copyFile(clipPaths[0], outPath);
    return;
  }

  // Prefer concat demuxer for reliability (identical normalized clips).
  // Flashy xfade is best-effort; fall back to hard cuts if filter graph fails.
  const listFile = outPath + '.txt';
  const listBody = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listFile, listBody);

  const useXfade = transitions.slice(1).some((t) => t.name);
  const useJl = transitions.slice(1).some((t) => t.jl);

  if (!useXfade && !useJl) {
    // Never `-c copy` AAC pieces — edit-list / priming offsets drop voice after the first few clips.
    // Re-encode through the concat demuxer so timestamps reset cleanly.
    const totalDur = durations.reduce((a, d) => a + d, 0);
    await runCmd(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '14',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        outPath,
      ],
      undefined,
      ffmpegTimeoutMs(totalDur || 60)
    );
    return;
  }

  try {
    const inputs: string[] = [];
    clipPaths.forEach((p) => {
      inputs.push('-i', p);
    });

    let filter = '';
    for (let i = 0; i < clipPaths.length; i++) {
      filter += `[${i}:v]fps=30,settb=1/30,setpts=PTS-STARTPTS[vprep${i}];`;
      filter += `[${i}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[aprep${i}];`;
    }

    let lastV = '[vprep0]';
    let lastA = '[aprep0]';
    let timeline = durations[0];

    for (let i = 1; i < clipPaths.length; i++) {
      const xf = transitions[i]?.name;
      const jl = transitions[i]?.jl;
      const td = Math.min(
        Math.max(transitions[i]?.duration || 0.5, 0.25),
        Math.min(durations[i], durations[i - 1]) * 0.28
      );
      const vOut = `[v${i}]`;
      const aOut = `[a${i}]`;

      if (xf) {
        const offset = Math.max(0, timeline - td);
        filter += `${lastV}[vprep${i}]xfade=transition=${xf}:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}${vOut};`;
        filter += `${lastA}[aprep${i}]acrossfade=d=${Math.min(td, 0.4).toFixed(3)}${aOut};`;
        timeline = offset + durations[i];
      } else if (jl) {
        // J-cut: next audio leads (~0.3s); L-cut: previous audio lags.
        // Video hard-cuts via concat; audio uses short acrossfade for continuity.
        const overlap = 0.3;
        filter += `${lastV}[vprep${i}]concat=n=2:v=1:a=0${vOut};`;
        filter += `${lastA}[aprep${i}]acrossfade=d=${overlap.toFixed(3)}${aOut};`;
        timeline = timeline + durations[i] - overlap * 0.5;
      } else {
        // Hard cut
        filter += `${lastV}[vprep${i}]concat=n=2:v=1:a=0${vOut};`;
        filter += `${lastA}[aprep${i}]concat=n=2:v=0:a=1${aOut};`;
        timeline = timeline + durations[i];
      }
      lastV = vOut;
      lastA = aOut;
    }

    filter += `${lastV}format=yuv420p[vout];${lastA}[aout]`;

    await runCmd(
      'ffmpeg',
      [
        '-y',
        ...inputs,
        '-filter_complex',
        filter,
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-r',
        '30',
        '-video_track_timescale',
        '30',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outPath,
      ],
      undefined,
      180_000
    );
  } catch (err) {
    console.warn('xfade assemble failed, falling back to concat:', (err as Error).message?.slice(0, 200));
    const totalDur = durations.reduce((a, d) => a + d, 0);
    await runCmd(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '14',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        outPath,
      ],
      undefined,
      ffmpegTimeoutMs(totalDur || 60)
    );
  }
}

async function burnCaptionsAndOverlays(
  input: string,
  output: string,
  assPath: string | null,
  channel: any,
  width: number,
  height: number,
  encode?: { crf?: number; preset?: string; audioBitrate?: string }
): Promise<void> {
  const needsWatermark = Boolean(channel.showWatermark && channel.channelName);
  // Skip full re-encode when there is nothing to burn — copy is fast and avoids hangs
  if (!assPath && !needsWatermark) {
    await fs.copyFile(input, output);
    return;
  }

  const filters: string[] = [];
  filters.push('eq=contrast=1.05:saturation=1.08:brightness=0.01');

  if (assPath) {
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fontsDir = captionFontsDir();
    const fontsOpt = fontsDir
      ? `:fontsdir='${fontsDir.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`
      : '';
    filters.push(`subtitles='${escaped}'${fontsOpt}`);
  }

  if (needsWatermark) {
    const name = escapeDrawtext(channel.channelName);
    const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const x = channel.watermarkPosition?.includes('left') ? '40' : `w-text_w-40`;
    const y = channel.watermarkPosition?.includes('bottom') ? 'h-text_h-40' : '40';
    const opacity = channel.watermarkOpacity ?? 0.7;
    filters.push(
      `drawtext=fontfile=${font}:text='${name}':fontsize=22:fontcolor=white@${opacity}:x=${x}:y=${y}`
    );
  }

  const vf = filters.join(',');
  const dur = await ffprobeDuration(input);
  try {
    await runCmd(
      'ffmpeg',
      [
        '-y',
        '-i',
        input,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        encode?.preset || 'veryfast',
        '-crf',
        String(encode?.crf ?? 20),
        '-c:a',
        'aac',
        '-b:a',
        encode?.audioBitrate || '192k',
        '-movflags',
        '+faststart',
        output,
      ],
      undefined,
      ffmpegTimeoutMs((dur || 60) * (encode?.preset === 'medium' ? 3 : 1.5))
    );
  } catch (err) {
    console.warn('Caption/overlay burn failed, using assembled cut:', (err as Error).message?.slice(0, 240));
    await fs.copyFile(input, output);
  }
}

/**
 * Optional lightweight SFX: quiet whoosh on xfade transitions, pop on text overlays.
 * Looks for public/sfx/whoosh.wav and public/sfx/pop.wav (or SFX_DIR). Missing files /
 * failures are skipped silently — SFX must never fail a render.
 */
async function mixSfx(
  videoIn: string,
  videoOut: string,
  cues: Array<{ t: number; kind: 'whoosh' | 'pop' }>
): Promise<void> {
  try {
    const dir = process.env.SFX_DIR || path.join(process.cwd(), 'public', 'sfx');
    const files: Record<string, string | null> = {
      whoosh: existsSync(path.join(dir, 'whoosh.wav')) ? path.join(dir, 'whoosh.wav') : null,
      pop: existsSync(path.join(dir, 'pop.wav')) ? path.join(dir, 'pop.wav') : null,
    };
    const usable = cues.filter((c) => files[c.kind]);
    if (!usable.length) {
      await fs.copyFile(videoIn, videoOut);
      return;
    }
    const args: string[] = ['-y', '-i', videoIn];
    let filter = '';
    const labels: string[] = ['[0:a]'];
    usable.forEach((c, i) => {
      args.push('-i', files[c.kind]!);
      const ms = Math.max(0, Math.round(c.t * 1000));
      const vol = c.kind === 'whoosh' ? 0.22 : 0.16;
      filter += `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol},adelay=${ms}|${ms}[s${i}];`;
      labels.push(`[s${i}]`);
    });
    // amix attenuates each input by 1/N; restore level then protect against clipping
    filter += `${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0,volume=${labels.length},alimiter=limit=0.97[aout]`;
    await runCmd(
      'ffmpeg',
      [
        ...args,
        '-filter_complex',
        filter,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        videoOut,
      ],
      undefined,
      90_000
    );
  } catch (err) {
    console.warn('SFX mix skipped:', (err as Error).message?.slice(0, 160));
    await fs.copyFile(videoIn, videoOut).catch(() => undefined);
  }
}

async function mixVoiceover(
  videoIn: string,
  voicePath: string | null,
  videoOut: string
): Promise<void> {
  if (!voicePath) {
    await fs.copyFile(videoIn, videoOut);
    return;
  }
  try {
    const dur = await ffprobeDuration(videoIn);
    await runCmd(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoIn,
        '-i',
        voicePath,
        '-filter_complex',
        '[1:a]aresample=48000,apad[vo];[vo]atrim=0:' + dur.toFixed(3) + '[aout]',
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-t',
        dur.toFixed(3),
        videoOut,
      ],
      undefined,
      90_000
    );
  } catch (err) {
    console.warn('Voiceover mix failed, keeping original audio:', (err as Error).message?.slice(0, 200));
    await fs.copyFile(videoIn, videoOut);
  }
}

async function mixMusic(
  videoIn: string,
  musicPath: string | null,
  videoOut: string,
  musicCues?: Array<{ start: number; end: number; level: string }>,
  bedLevel = 0.18
): Promise<void> {
  if (!musicPath) {
    await fs.copyFile(videoIn, videoOut);
    return;
  }

  const bed = Math.max(0, Math.min(0.4, Number.isFinite(bedLevel) ? bedLevel : 0.18));
  const lift = Math.min(0.4, bed * 1.33);
  const hold = Math.min(0.4, bed * 0.78);
  const ducked = Math.min(0.4, bed * 0.55);
  // Build a volume envelope from cues when present; otherwise constant ducked bed
  let musicFilter = `volume=${bed.toFixed(3)}`;
  if (musicCues && musicCues.length > 0) {
    const parts: string[] = [];
    for (const c of musicCues) {
      const vol =
        c.level === 'mute' ? 0 : c.level === 'lift' ? lift : c.level === 'hold' ? hold : ducked;
      parts.push(`between(t\\,${c.start.toFixed(3)}\\,${c.end.toFixed(3)})*${vol}`);
    }
    musicFilter = `volume='${parts.join('+')}+${(bed * 0.33).toFixed(3)}':eval=frame`;
  }

  try {
    const dur = await ffprobeDuration(videoIn);
    // normalize=0 keeps voice at full level (default amix halves each input).
    // Gentler sidechain (ratio=4, release=800) stops the bed pumping in micro-gaps.
    await runCmd(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoIn,
        '-stream_loop',
        '8',
        '-i',
        musicPath,
        '-filter_complex',
        `[1:a]${musicFilter}[music];[0:a]asplit=2[voice][sc];[music][sc]sidechaincompress=threshold=0.03:ratio=4:attack=80:release=800[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-t',
        (dur > 0 ? dur : 1).toFixed(3),
        videoOut,
      ],
      undefined,
      ffmpegTimeoutMs(dur || 60)
    );
  } catch (err) {
    console.warn('Music mix failed, keeping video without bed:', (err as Error).message?.slice(0, 200));
    await fs.copyFile(videoIn, videoOut);
  }
}

async function renderListicleTitle(
  outPath: string,
  width: number,
  height: number,
  duration: number,
  title: string,
  brandColor = '#1A73E8'
): Promise<void> {
  const label = escapeDrawtext((title || 'NEXT').slice(0, 48));
  const color = brandColor.replace('#', '');
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fsSize = Math.round(height * 0.055);
  await runCmd('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x111827:s=${width}x${height}:r=30:d=${duration}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-vf',
    `drawbox=x=0:y=${Math.round(height * 0.46)}:w=iw:h=6:color=0x${color}:t=fill,drawtext=fontfile=${font}:text='${label}':fontsize=${fsSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-t',
    String(duration),
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    outPath,
  ]);
}

type CaptionPlan =
  | { mode: 'none' }
  | { mode: 'legacy' }
  | { mode: 'word'; style: WordCaptionStyle };

const WORD_STYLES = new Set(['bold_pop', 'karaoke', 'clean', 'off']);

/**
 * How captions flow: ProductionPrefs.captions (edl.captionStyle, or channel.captionStyle when it
 * already holds a prefs value) wins; otherwise captionWords force the word renderer with the
 * legacy channel style mapped (tiktok-yellow → bold_pop, others → clean); otherwise legacy phrases.
 * 'off' disables captions but text overlays are still burned (word ASS with style 'off').
 */
function resolveCaptionPlan(edl: any, clips: any[]): CaptionPlan {
  const hasWords = clips.some((c) => (c.captionWords || []).length > 0);
  const hasPhrases = clips.some((c) => (c.captions || []).length > 0);
  const hasOverlays = clips.some((c) => (c.textOverlays || []).length > 0);
  const prefsStyle = [edl.captionStyle, edl.channel?.captionStyle].find(
    (s) => typeof s === 'string' && WORD_STYLES.has(s)
  ) as WordCaptionStyle | undefined;

  if (prefsStyle === 'off') return hasOverlays ? { mode: 'word', style: 'off' } : { mode: 'none' };
  if (prefsStyle) {
    return hasWords || hasPhrases || hasOverlays ? { mode: 'word', style: prefsStyle } : { mode: 'none' };
  }

  const channelOn = edl.channel?.captionsEnabled === true;
  if (!channelOn) return hasOverlays ? { mode: 'word', style: 'off' } : { mode: 'none' };
  if (hasWords) {
    return {
      mode: 'word',
      style: edl.channel?.captionStyle === 'tiktok-yellow' ? 'bold_pop' : 'clean',
    };
  }
  if (hasPhrases) return { mode: 'legacy' };
  return hasOverlays ? { mode: 'word', style: 'off' } : { mode: 'none' };
}

async function executeRender(jobId: string, edl: any) {
  const job = (await loadJob(jobId))!;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `takeone-${jobId}-`));
  job.attempt = (job.attempt || 0) + 1;
  job.projectId = job.projectId || edl.projectId || edl.project?.id;
  renderHeartbeat = () => {
    job.heartbeatAt = Date.now();
    job.updatedAt = Date.now();
    void persistJob(job);
  };
  /** Advance job.percent from `lo` toward `hi` as ffmpeg encodes `totalSec` of output. */
  const stageProgress = (lo: number, hi: number, totalSec: number, label: string) => {
    let lastSave = 0;
    ffmpegProgressSink = (t) => {
      const frac = Math.max(0, Math.min(1, t / Math.max(0.5, totalSec)));
      const pct = lo + Math.round(frac * (hi - lo));
      if (pct <= job.percent) return;
      job.percent = pct;
      job.message = `${label} · ${Math.round(frac * 100)}%`;
      const now = Date.now();
      if (now - lastSave >= 3000) {
        lastSave = now;
        job.updatedAt = now;
        void persistJob(job);
      }
    };
  };

  try {
    const qp = qualityProfile(edl.renderQuality, edl.aspectRatio);
    const isDraft = qp.tier === 'draft';
    const width = qp.width;
    const height = qp.height;
    console.log(
      `[quality] tier=${qp.tier} ${width}x${height} crf=${qp.crf} preset=${qp.preset} proxy=${qp.useProxy}`
    );

    if (edl.totalDurationSeconds > MAX_RENDER_SECONDS) {
      throw new Error(
        `This cut is ${(edl.totalDurationSeconds / 60).toFixed(1)} minutes. This pass can render up to ~${Math.round(MAX_RENDER_SECONDS / 60)} minutes.`
      );
    }

    job.status = 'rendering';
    job.state = 'PROCESSING';
    job.stage = 'normalizing';
    job.percent = 5;
    job.message = isDraft
      ? 'Draft: normalizing clips…'
      : qp.tier === 'high'
        ? 'High quality: normalizing clips…'
        : labelForRenderStage('normalizing');
    await persistJob(job);

    const { expectedDuration } = assertRenderableEdl(edl);
    const clips = edl.clips || [];

    // Cleanup-driven audio chain: UI noise toggle (channel.noiseRemovalEnabled) or an explicit
    // prefs.cleanup that turns both silence + filler cleanup off → skip afftdn (keep loudnorm).
    const cleanupPrefs = edl.cleanup ?? edl.prefs?.cleanup;
    const denoise =
      edl.channel?.noiseRemovalEnabled !== false &&
      !(cleanupPrefs && cleanupPrefs.silences === false && cleanupPrefs.fillers === false);

    const normalized: string[] = [];
    const durations: number[] = [];
    const transitionKeys: string[] = [];
    const transitions: Array<{ name: string | null; duration: number; jl?: 'j' | 'l' }> = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      job.percent = 5 + Math.round((i / clips.length) * 40);
      job.stage = 'normalizing';
      job.message = `Normalizing clip ${i + 1}/${clips.length}: ${clip.title}`;
      await persistJob(job);

      const normPath = path.join(workDir, `norm-${i}.mp4`);
      let dur = clip.durationSeconds || 2.2;

      if (clip.mediaKind === 'title-card') {
        await renderListicleTitle(
          normPath,
          width,
          height,
          dur,
          clip.title || 'Next',
          edl.channel?.brandColor || '#1A73E8'
        );
      } else {
        // Always prefer original source — proxy is analysis-only (was 480x270 and destroyed drafts).
        const mediaSrc =
          (qp.useProxy && clip.proxyUrl) || clip.mediaUrl;
        if (!mediaSrc || clip.mediaKind === 'missing' || String(mediaSrc).startsWith('blob:')) {
          throw new Error(
            `Clip "${clip.title}" has no durable media (blob/missing). Save takes to cloud, then export again.`
          );
        }
        const rawExt = rawExtensionForClip({ ...clip, mediaUrl: mediaSrc });
        const rawPath = path.join(workDir, `raw-${i}.${rawExt}`);
        await downloadToFile(mediaSrc, rawPath);
        const clipDurHint =
          typeof clip.inPoint === 'number' &&
          typeof clip.outPoint === 'number' &&
          clip.outPoint > clip.inPoint
            ? clip.outPoint - clip.inPoint
            : clip.durationSeconds;
        // Move the bar while a clip encodes (a one-clip cut used to sit at one % for minutes).
        const clipSecs = Math.max(0.5, Number(clip.durationSeconds) || 1);
        let lastProgressSave = 0;
        const onProgress = (t: number) => {
          const frac = Math.max(0, Math.min(1, t / clipSecs));
          job.percent = 5 + Math.round(((i + frac) / clips.length) * 40);
          job.message = `Rendering clip ${i + 1}/${clips.length} · ${Math.round(frac * 100)}%`;
          const now = Date.now();
          if (now - lastProgressSave >= 3000) {
            lastProgressSave = now;
            job.updatedAt = now;
            void persistJob(job);
          }
        };
        const encOpts = {
          crf: qp.intermediateCrf,
          preset: qp.intermediatePreset,
          audioBitrate: qp.audioBitrate,
          onProgress,
        };
        const sceneSegs: Array<{ inPoint: number; outPoint: number; zoom?: number }> | undefined =
          Array.isArray(clip.segments) && clip.segments.length
            ? clip.segments
            : undefined;

        // Whole-scene virtual background → key it inside the segment pass (one encode).
        const segTotal = sceneSegs
          ? sceneSegs.reduce((a, s) => a + Math.max(0, s.outPoint - s.inPoint), 0)
          : 0;
        const plateIns =
          sceneSegs && clip.mediaKind !== 'image'
            ? (clip.brollInserts || []).find(
                (b: any) =>
                  b?.layout === 'greenscreen' &&
                  b.mediaUrl &&
                  b.accepted !== false &&
                  (b.startOffsetSeconds || 0) <= 0.15 &&
                  (b.startOffsetSeconds || 0) + (b.durationSeconds || 0) >= segTotal - 0.6
              )
            : undefined;
        let inlineGreenscreen:
          | { platePath: string; plateIsVideo?: boolean; despill?: boolean }
          | undefined;
        if (plateIns) {
          const plateIsVideo = plateIns.mediaType === 'video';
          const platePath = path.join(workDir, `plate-${i}${plateIsVideo ? '.mp4' : '.jpg'}`);
          try {
            await downloadToFile(plateIns.mediaUrl, platePath);
          } catch (dlErr: any) {
            throw new Error(
              `Greenscreen background could not be downloaded: ${String(dlErr?.message || dlErr).slice(0, 160)}`
            );
          }
          const ratio = await sampleChromaGreenRatio(rawPath, workDir);
          if (ratio < 0.04) {
            const msg = `Virtual background skipped on clip ${i + 1}: take was not recorded with virtual green (${(ratio * 100).toFixed(1)}% green). Re-shoot with Virtual background ON.`;
            console.warn(`[greenscreen] ${msg}`);
            job.warnings = [...(job.warnings || []), msg];
          } else {
            if (ratio < 0.15) {
              console.warn(
                `[greenscreen] low green ratio ${(ratio * 100).toFixed(1)}% on clip ${i + 1} — keying anyway (close-up OK)`
              );
            }
            inlineGreenscreen = { platePath, plateIsVideo, despill: !isDraft };
          }
        }
        const restInserts = plateIns
          ? (clip.brollInserts || []).filter((b: any) => b !== plateIns)
          : clip.brollInserts || [];

        const srcDims = clip.mediaKind === 'image' ? null : await ffprobeVideoDims(rawPath);
        const fit = frameFitModeFor(srcDims, width, height, Boolean(inlineGreenscreen));
        if (fit !== 'cover' && srcDims) {
          const takeOrient = srcDims.width > srcDims.height ? 'landscape' : 'portrait';
          const note = `"${clip.title}" was filmed in ${takeOrient} but the output is ${edl.aspectRatio || (width > height ? '16:9' : '9:16')} — fit the whole frame${fit === 'blur' ? ' with a blurred side fill' : ''} instead of cropping your face.`;
          console.log(`[fit] ${note}`);
          job.warnings = [...(job.warnings || []), note];
        }
        try {
          if (sceneSegs && clip.mediaKind !== 'image') {
            dur = await renderSceneSegments(rawPath, normPath, width, height, sceneSegs, {
              fadeOutSeconds: isDraft ? 0 : clip.fadeOutSeconds || 0,
              fast: isDraft,
              denoise,
              fit,
              greenscreen: inlineGreenscreen,
              ...encOpts,
            });
          } else {
            dur = await normalizeClip(
              rawPath,
              normPath,
              width,
              height,
              clip.mediaKind === 'image',
              clipDurHint,
              {
                inPoint: clip.inPoint,
                outPoint: clip.outPoint,
                zoom: clip.zoom || 1,
                skipSilenceDetect: true,
                fadeOutSeconds: isDraft ? 0 : clip.fadeOutSeconds || 0,
                fast: isDraft,
                denoise,
                fit,
                ...encOpts,
              }
            );
          }
        } catch (trimErr) {
          if (inlineGreenscreen) throw trimErr;
          console.warn(`Retrying "${clip.title}" without trim`, trimErr);
          dur = await normalizeClip(
            rawPath,
            normPath,
            width,
            height,
            clip.mediaKind === 'image',
            clip.durationSeconds || clipDurHint,
            {
              zoom: clip.zoom || 1,
              skipSilenceDetect: true,
              fadeOutSeconds: isDraft ? 0 : clip.fadeOutSeconds || 0,
              fast: isDraft,
              denoise,
              fit,
              ...encOpts,
            }
          );
        }
        clip.brollInserts = restInserts;
      }
      let assemblePath = normPath;
      if (clip.brollInserts?.length) {
        const overPath = path.join(workDir, `over-${i}.mp4`);
        job.message = `Merging AI cutaways into clip ${i + 1}…`;
        await persistJob(job);
        const overlayWarnings = await overlayBrollInserts(
          normPath,
          overPath,
          clip.brollInserts,
          workDir,
          width,
          height,
          i,
          { crf: qp.intermediateCrf, preset: qp.intermediatePreset, despill: !isDraft }
        );
        if (overlayWarnings.length) {
          job.warnings = [...(job.warnings || []), ...overlayWarnings];
          await persistJob(job, { flush: true });
        }
        assemblePath = overPath;
      }
      normalized.push(assemblePath);
      durations.push(dur);
      const transitionKey =
        clip.transitionOut || clip.transitionIn || clip.transition || 'hard_cut';
      transitionKeys.push(transitionKey);
      transitions.push({
        name: xfadeName(transitionKey),
        duration: clip.transitionDuration || 0.35,
        jl: isJlCut(transitionKey) || isJlCut(clip.transitionIn) || undefined,
      });
    }

    if (!normalized.length) {
      throw new Error('No clips could be normalized. Save takes to cloud, then export again.');
    }

    // Intro after hook (optional) — only when EDL says after-hook (requires complete hook)
    const segments: string[] = [];
    const segDurations: number[] = [];
    const segTransitions: Array<{ name: string | null; duration: number; jl?: 'j' | 'l' }> = [];
    let introDur = 0;
    let afterHookIntroDur = 0;

    const wantAfterHookIntro =
      edl.introMode === 'after-hook' &&
      edl.introDurationSeconds > 0 &&
      normalized.length > 0 &&
      (clips[0]?.role === 'hook' || !clips[0]?.role);

    if (wantAfterHookIntro) {
      // Cold open: first clip, then sting, then rest
      segments.push(normalized[0]);
      segDurations.push(durations[0]);
      segTransitions.push({ name: null, duration: 0 });

      const introPath = path.join(workDir, 'intro.mp4');
      introDur = edl.introDurationSeconds;
      afterHookIntroDur = introDur;
      await renderIntroBumper(introPath, width, height, introDur, edl.channel || {}, workDir);
      segments.push(introPath);
      segDurations.push(introDur);
      segTransitions.push({ name: 'fade', duration: 0.3 });

      for (let i = 1; i < normalized.length; i++) {
        segments.push(normalized[i]);
        segDurations.push(durations[i]);
        segTransitions.push(transitions[i] || { name: null, duration: 0 });
      }
    } else {
      if (edl.introMode === 'after-hook' && edl.introDurationSeconds > 0) {
        console.log('[INTRO skipped: hook incomplete or missing]');
      }
      for (let i = 0; i < normalized.length; i++) {
        segments.push(normalized[i]);
        segDurations.push(durations[i]);
        segTransitions.push(transitions[i] || { name: null, duration: 0 });
      }
    }

    if (edl.outroSafeSeconds > 0) {
      const outroPath = path.join(workDir, 'outro.mp4');
      await renderOutroSafe(outroPath, width, height, edl.outroSafeSeconds, edl.channel || {});
      segments.push(outroPath);
      segDurations.push(edl.outroSafeSeconds);
      segTransitions.push({ name: 'fade', duration: 0.4 });
    }

    job.percent = 55;
    job.stage = 'assembling';
    job.message = labelForRenderStage('assembling');
    await persistJob(job);

    const assembled = path.join(workDir, 'assembled.mp4');
    const timelineSec = segDurations.reduce((a, d) => a + (Number(d) || 0), 0);
    stageProgress(55, 69, timelineSec, labelForRenderStage('assembling'));
    await assembleWithXfade(segments, segTransitions, segDurations, assembled);

    // Captions ASS — word-level (bold_pop / karaoke / clean) when prefs or captionWords say so,
    // legacy phrase ASS otherwise. Text overlays (text_pop / meme) ride the same ASS file.
    // Draft skips watermark/caption burn for speed.
    const capPlan = resolveCaptionPlan(edl, clips);
    const burnCaptions = qp.burnCaptions && capPlan.mode !== 'none';
    const needsWatermark =
      qp.burnCaptions && Boolean(edl.channel?.showWatermark && edl.channel?.channelName);
    job.percent = 70;
    job.stage = 'overlays';
    job.message = isDraft
      ? 'Draft: skipping caption burn…'
      : burnCaptions || needsWatermark
        ? 'Burning captions and channel overlays…'
        : 'Finalizing color pass…';
    await persistJob(job);
    stageProgress(70, 84, timelineSec, burnCaptions ? 'Burning captions' : 'Finalizing');

    const assPath = path.join(workDir, 'captions.ass');
    const captionClips = clips.map((c: any, idx: number) => ({
      durationSeconds: durations[idx],
      captionWords: c.captionWords || [],
      captions: c.captions || [],
      textOverlays: c.textOverlays || [],
      transition: transitionKeys[idx] || c.transition,
      transitionDuration: c.transitionDuration,
    }));
    let assBody: string | null = null;
    if (burnCaptions) {
      if (capPlan.mode === 'word') {
        assBody = buildWordAssFile({
          clips: captionClips,
          width,
          height,
          style: capPlan.style,
          introDur: 0, // no pre-roll intro; after-hook sting is handled via afterHookIntroDur
          afterHookIntroDur,
          position: edl.captionPosition,
          size: edl.captionSize,
        });
        console.log(
          `[captions] word ASS style=${capPlan.style} words=${clips.reduce((n: number, c: any) => n + (c.captionWords?.length || 0), 0)} overlays=${clips.reduce((n: number, c: any) => n + (c.textOverlays?.length || 0), 0)}`
        );
      } else {
        assBody = buildAssFile(
          clips.map((c: any, idx: number) => ({
            durationSeconds: durations[idx],
            captions: c.captions || [],
            transition: c.transition,
            transitionDuration: c.transitionDuration,
          })),
          0,
          edl.channel?.captionStyle || 'modern-white',
          width,
          height,
          afterHookIntroDur
        );
      }
    }
    const hasAss = Boolean(assBody);
    if (assBody) {
      await fs.writeFile(assPath, assBody, 'utf8');
    }

    const captioned = path.join(workDir, 'captioned.mp4');
    if (isDraft && !hasAss && !needsWatermark) {
      await fs.copyFile(assembled, captioned);
    } else {
      await burnCaptionsAndOverlays(
        assembled,
        captioned,
        hasAss ? assPath : null,
        isDraft ? { ...(edl.channel || {}), showWatermark: false } : edl.channel || {},
        width,
        height,
        { crf: qp.crf, preset: qp.preset, audioBitrate: qp.audioBitrate }
      );
    }

    // Music
    job.percent = 85;
    job.stage = 'mixing';
    job.message = labelForRenderStage('mixing');
    await persistJob(job);
    stageProgress(85, 91, timelineSec, labelForRenderStage('mixing'));

    // Optional SFX (whoosh on transitions, pop on text overlays) — silently skipped if no assets
    let withSfx = captioned;
    if (!isDraft) {
      const cues = buildSfxCues({ clips: captionClips, introDur: 0, afterHookIntroDur });
      if (cues.length) {
        withSfx = path.join(workDir, 'sfx.mp4');
        await mixSfx(captioned, withSfx, cues);
      }
    }

    let voiced = withSfx;
    if (edl.voiceoverEnabled && edl.voiceoverGcsPath) {
      job.message = 'Mixing AI dub…';
      await persistJob(job);
      const voiceLocal = path.join(workDir, 'voiceover.wav');
      try {
        await downloadToFile(edl.voiceoverGcsPath, voiceLocal);
        voiced = path.join(workDir, 'dubbed.mp4');
        await mixVoiceover(withSfx, voiceLocal, voiced);
      } catch (voErr) {
        console.warn('Voiceover download failed:', (voErr as Error).message);
        voiced = withSfx;
      }
    }

    let musicLocal: string | null = null;
    if (edl.musicEnabled && edl.musicGcsPath) {
      musicLocal = path.join(workDir, 'music.mp3');
      try {
        await downloadToFile(edl.musicGcsPath, musicLocal);
      } catch {
        musicLocal = null;
      }
    }

    const mixedLocal = path.join(workDir, 'mixed.mp4');
    await mixMusic(voiced, musicLocal, mixedLocal, edl.musicCues, Number(edl.musicVolume));

    // Speech integrity: compare pre-music voice bed vs mixed master
    const speechWarn = await checkSpeechIntegrity(voiced, mixedLocal);
    if (speechWarn) {
      console.warn(`[audio] ${speechWarn}`);
      job.warnings = [...(job.warnings || []), speechWarn];
      // Hard-fail non-draft when voice clearly vanished (music-only master).
      if (!isDraft) {
        throw new Error(speechWarn);
      }
      await persistJob(job, { flush: true });
    }

    // Single loudnorm pass on the whole master (never per-clip).
    let finalLocal = mixedLocal;
    if (qp.applyLoudnorm) {
      job.message = 'Normalizing loudness…';
      await persistJob(job);
      const loudPath = path.join(workDir, 'loud.mp4');
      const mixDur = await ffprobeDuration(mixedLocal);
      await applyLoudnormPass(mixedLocal, loudPath, ffmpegTimeoutMs(mixDur || 60));
      finalLocal = loudPath;
    }

    // Upload
    ffmpegProgressSink = null;
    job.percent = 92;
    job.stage = 'uploading';
    job.message = labelForRenderStage('uploading');
    await persistJob(job);

    const objectPath =
      isDraft
        ? `draft/${jobId}/preview.mp4`
        : qp.tier === 'high'
          ? `final/${jobId}/master-high.mp4`
          : `final/${jobId}/master.mp4`;
    const storage = getStorage();
    if (storage && GCS_BUCKET) {
      await storage.bucket(GCS_BUCKET).file(objectPath).save(await fs.readFile(finalLocal), {
        contentType: 'video/mp4',
        resumable: false,
        metadata: {
          cacheControl: 'private, max-age=3600',
          metadata: {
            'takeone-role': isDraft ? 'draft' : 'final',
            'takeone-quality': qp.tier,
          },
        },
      });
      job.outputGcsPath = `gs://${GCS_BUCKET}/${objectPath}`;
      job.downloadUrl = `/api/render/download/${jobId}`;
    } else {
      // Persist locally under /tmp for download handler
      const localKeep = path.join(os.tmpdir(), `takeone-${isDraft ? 'draft' : 'master'}-${jobId}.mp4`);
      await fs.copyFile(finalLocal, localKeep);
      job.outputGcsPath = localKeep;
      job.downloadUrl = `/api/render/download/${jobId}`;
    }

    const finalDur = await ffprobeDuration(finalLocal);
    if (!isDraft) {
      job.stage = 'verifying';
      job.message = 'Verifying master duration/audio/black…';
      await persistJob(job);
      const bumperSeconds =
        (edl.introMode && edl.introMode !== 'none' && edl.introMode !== 'off'
          ? Number(edl.introDurationSeconds) || 2.5
          : 0) + (Number(edl.outroSafeSeconds) || 0);
      await verifyMaster(finalLocal, expectedDuration || finalDur, { bumperSeconds });
    }

    job.status = 'done';
    job.state = 'COMPLETED';
    job.stage = 'done';
    job.percent = 100;
    const qualityLabel =
      qp.tier === 'draft' ? 'draft' : qp.tier === 'high' ? 'high' : 'standard';
    job.message = isDraft
      ? `Draft ready (${finalDur.toFixed(1)}s)`
      : `Master ready (${finalDur.toFixed(1)}s · ${qualityLabel})`;
    job.edlSummary = `${clips.length} clips · ${finalDur.toFixed(1)}s · ${qualityLabel}`;
    job.outputDurationSec = Math.round(finalDur * 10) / 10;
    if (job.startedAt) {
      console.log(
        `[render] ${jobId.slice(0, 8)} ${qualityLabel} done in ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s (+${((job.startedAt - job.createdAt) / 1000).toFixed(1)}s cold start) stages=${JSON.stringify(job.stageTimings || {})}`
      );
    }
    await persistJob(job);
    await appendCost({
      ts: Date.now(),
      jobId,
      kind: 'render',
      event: isDraft ? 'draft-complete' : 'master-complete',
      renderSeconds: finalDur,
    });
    if (job.projectId) await clearProjectLock('render', job.projectId, jobId);
  } catch (err: any) {
    job.status = 'error';
    job.state = 'FAILED';
    job.stage = 'error';
    const raw = err?.message || String(err);
    job.error = raw.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1200);
    job.message = 'Render failed';
    await persistJob(job);
    if (job.projectId) await clearProjectLock('render', job.projectId, jobId);
    console.error('Render error:', err);
  } finally {
    renderHeartbeat = null;
    ffmpegProgressSink = null;
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const CLAIM_HEARTBEAT_MS = 60_000;

/** Claim a render job so a late Cloud Run Job backup is a no-op. */
async function claimRenderJob(job: RenderJob): Promise<boolean> {
  if (job.status === 'done' || job.status === 'error') return false;
  const status = String(job.status || '').toLowerCase();
  const beat = Number(job.heartbeatAt || job.updatedAt || 0);
  if (
    (status === 'rendering' || status === 'uploading') &&
    beat > 0 &&
    Date.now() - beat < CLAIM_HEARTBEAT_MS
  ) {
    console.log(`[render] skip ${job.id} — already claimed (status=${job.status})`);
    return false;
  }
  job.status = 'rendering';
  job.state = 'PROCESSING';
  job.stage = job.stage === 'queued' ? 'claiming' : job.stage;
  job.message = job.message === 'Queued' ? 'Starting render…' : job.message;
  job.startedAt = job.startedAt || Date.now();
  console.log(
    `[render] ${job.id.slice(0, 8)} claimed ${((job.startedAt - job.createdAt) / 1000).toFixed(1)}s after enqueue`
  );
  job.heartbeatAt = Date.now();
  job.updatedAt = Date.now();
  await persistJob(job);
  return true;
}

export async function executePersistedRender(jobId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (!job) throw new Error(`Render job ${jobId} not found`);
  if (job.status === 'done' || job.status === 'error') return;
  if (!(await claimRenderJob(job))) return;
  const request = await loadJson<{ edl: any }>(`renders/${jobId}/request.json`);
  if (!request?.edl) throw new Error(`Render request missing for ${jobId}`);
  await executeRender(jobId, request.edl);
}

/**
 * Fast local rough cut for the AI Critic — honors in/out, zoom, transitions.
 * Skips captions/music/upload to stay within Cloud Run time budgets.
 * Returns absolute path to a temporary MP4 (caller must delete).
 */
export async function renderRoughCutLocal(edl: any): Promise<{ path: string; workDir: string }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-rough-'));
  const clips = edl.clips || [];
  if (!clips.length) throw new Error('EDL has no clips for rough cut');

  const isWidescreen = edl.aspectRatio === '16:9';
  const width = isWidescreen ? 1280 : 720;
  const height = isWidescreen ? 720 : 1280;

  const normalized: string[] = [];
  const durations: number[] = [];
  const transitions: Array<{ name: string | null; duration: number; jl?: 'j' | 'l' }> = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const normPath = path.join(workDir, `norm-${i}.mp4`);
    let dur = clip.durationSeconds || 2;

    if (clip.mediaKind === 'title-card') {
      await renderListicleTitle(
        normPath,
        width,
        height,
        dur,
        clip.title || 'Next',
        edl.channel?.brandColor || '#1A73E8'
      );
    } else {
      if (!clip.mediaUrl || clip.mediaKind === 'missing') {
        throw new Error(`Rough cut: clip "${clip.title}" has no media`);
      }
      const media = clip.proxyUrl || clip.mediaUrl;
      const usingProxy = Boolean(clip.proxyUrl);
      const rawExt = usingProxy ? 'mp4' : rawExtensionForClip(clip);
      const rawPath = path.join(workDir, `raw-${i}.${rawExt}`);
      await downloadToFile(media, rawPath);
      const hint =
        typeof clip.inPoint === 'number' &&
        typeof clip.outPoint === 'number' &&
        clip.outPoint > clip.inPoint
          ? clip.outPoint - clip.inPoint
          : clip.durationSeconds;
      dur = await normalizeClip(rawPath, normPath, width, height, clip.mediaKind === 'image', hint, {
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        zoom: clip.zoom || 1,
        skipSilenceDetect: typeof clip.inPoint === 'number',
        fadeOutSeconds: clip.fadeOutSeconds || 0,
        fast: usingProxy,
      });
    }
    normalized.push(normPath);
    durations.push(dur);
    const transitionKey = clip.transitionOut || clip.transitionIn || clip.transition || 'hard_cut';
    transitions.push({
      name: xfadeName(transitionKey),
      duration: clip.transitionDuration || 0.35,
      jl: isJlCut(transitionKey) || undefined,
    });
  }

  const outPath = path.join(workDir, 'rough.mp4');
  await assembleWithXfade(normalized, transitions, durations, outPath);
  return { path: outPath, workDir };
}

export function createRenderRouter(): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const { stdout } = await runCmd('ffmpeg', ['-version']);
      const first = (stdout || '').split('\n')[0] || 'ffmpeg present';
      res.json({
        ok: true,
        ffmpeg: first,
        gcsBucket: Boolean(GCS_BUCKET),
        maxRenderSeconds: MAX_RENDER_SECONDS,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'ffmpeg missing' });
    }
  });

  router.post('/upload-url', async (req: Request, res: Response) => {
    try {
      const {
        contentType = 'video/webm',
        extension = 'webm',
        folder = 'source',
        objectPath: requestedPath,
      } = req.body || {};
      const storage = getStorage();
      if (!storage || !GCS_BUCKET) {
        return res.status(503).json({ error: 'GCS_BUCKET not configured' });
      }
      // Deterministic keys for take retries: takes/{projectId}/{sceneId}
      // Random keys for one-off render assets when objectPath omitted.
      let objectPath: string;
      if (typeof requestedPath === 'string' && requestedPath.trim()) {
        const cleaned = requestedPath
          .replace(/^gs:\/\/[^/]+\//, '')
          .replace(/\.\./g, '')
          .replace(/^\/+/, '')
          .slice(0, 240);
        if (!cleaned || cleaned.includes('://')) {
          return res.status(400).json({ error: 'Invalid objectPath' });
        }
        objectPath = cleaned;
      } else {
        objectPath = `${folder}/${Date.now()}-${randomUUID().slice(0, 8)}.${String(extension).replace('.', '')}`;
      }
      const file = storage.bucket(GCS_BUCKET).file(objectPath);
      // Sign with Content-Type only — custom x-goog-meta-* headers break browser CORS PUTs
      // when the bucket CORS config does not allow them (mobile + desktop upload failures).
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 15 * 60 * 1000,
        contentType,
      });
      res.json({
        uploadUrl: url,
        objectPath,
        gcsUri: `gs://${GCS_BUCKET}/${objectPath}`,
        publicPath: objectPath,
        headers: {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to create signed URL' });
    }
  });

  router.post('/start', async (req: Request, res: Response) => {
    try {
      const { edl, quality } = req.body || {};
      if (!edl || !Array.isArray(edl.clips) || edl.clips.length === 0) {
        return res.status(400).json({ error: 'edl with clips is required' });
      }
      if (edl.totalDurationSeconds > MAX_RENDER_SECONDS) {
        const mins = (edl.totalDurationSeconds / 60).toFixed(1);
        const capMins = Math.round(MAX_RENDER_SECONDS / 60);
        return res.status(400).json({
          error: `This cut is ${mins} minutes. This pass can render up to ~${capMins} minutes — split the project or wait for the long-form job renderer.`,
        });
      }

      const qRaw = String(quality || edl.renderQuality || 'standard').toLowerCase();
      const renderQuality =
        qRaw === 'draft' ? 'draft' : qRaw === 'high' ? 'high' : qRaw === 'final' ? 'standard' : 'standard';
      edl.renderQuality = renderQuality;

      const projectId = String(edl.projectId || edl.project?.id || '').trim();
      if (projectId) {
        const lock = await readProjectLock('render', projectId);
        if (lock?.jobId) {
          const existing = await loadJob(lock.jobId);
          const beat = Number(existing?.heartbeatAt || existing?.updatedAt || 0);
          const sameQuality = !existing?.quality || existing.quality === renderQuality;
          const activelyRendering =
            existing?.status === 'rendering' &&
            beat > 0 &&
            Date.now() - beat < 60_000;
          // Cold start can take ~2 min before the worker claims the job: a second click
          // must reuse that ticket instead of launching another machine.
          const stillQueued =
            existing?.status === 'queued' && Date.now() - Number(existing.createdAt || 0) < 4 * 60_000;
          if (existing && sameQuality && (activelyRendering || stillQueued)) {
            return res.json({
              jobId: existing.id,
              status: existing.status,
              quality: renderQuality,
              resumed: true,
            });
          }
          // Queued / error / done / stale lock → start a new job, do not resume dead tickets.
          await clearProjectLock('render', projectId, lock.jobId);
        }
      }

      const id = randomUUID();
      const job: RenderJob = {
        id,
        status: 'queued',
        state: 'QUEUED',
        percent: 0,
        stage: 'queued',
        message:
          renderQuality === 'draft'
            ? 'Queued draft preview'
            : renderQuality === 'high'
              ? 'Queued high (1080p) export'
              : 'Queued standard export',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        heartbeatAt: Date.now(),
        projectId: projectId || undefined,
        attempt: 0,
        quality: renderQuality,
      };
      await persistJob(job);
      await saveJson(`renders/${id}/request.json`, { edl }, 'temp');
      if (projectId) await writeProjectLock('render', projectId, id);
      await enqueueWorker('render', id);

      res.json({ jobId: id, status: job.status, quality: renderQuality });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to start render' });
    }
  });

  router.get('/status/:id', async (req: Request, res: Response) => {
    const job = await loadJob(req.params.id);
    if (!job) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Job not found' });
    }
    // Bypass Express ETag so polls never get empty 304 bodies.
    const body = JSON.stringify(job);
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  });

  router.get('/download/:id', async (req: Request, res: Response) => {
    try {
      const job = await loadJob(req.params.id);
      if (!job || job.status !== 'done' || !job.outputGcsPath) {
        return res.status(404).json({ error: 'Master not ready' });
      }

      const inline = String(req.query.inline || '') === '1';
      const wantJson = String(req.query.json || '') === '1';

      // Prefer short-lived GCS signed URL (avoids proxy-streaming large MP4s through Cloud Run).
      if (job.outputGcsPath.startsWith('gs://')) {
        const storage = getStorage();
        if (!storage) return res.status(503).json({ error: 'GCS unavailable' });
        const without = job.outputGcsPath.slice(5);
        const slash = without.indexOf('/');
        const bucket = without.slice(0, slash);
        const object = without.slice(slash + 1);
        const file = storage.bucket(bucket).file(object);
        const [url] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 60 * 60 * 1000,
          responseDisposition: inline
            ? 'inline'
            : `attachment; filename="takeone-master-${job.id}.mp4"`,
          responseType: 'video/mp4',
        });
        if (wantJson) {
          return res.json({ ok: true, url, jobId: job.id, expiresInSec: 3600 });
        }
        return res.redirect(302, url);
      }

      // Local fallback (dev without GCS)
      const disposition = inline
        ? 'inline'
        : `attachment; filename="takeone-master-${job.id}.mp4"`;
      const { createReadStream, statSync } = await import('fs');
      const size = statSync(job.outputGcsPath).size;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', disposition);
      createReadStream(job.outputGcsPath).pipe(res);
    } catch (err: any) {
      console.error('Download failed:', err);
      res.status(500).json({ error: err?.message || 'Download failed' });
    }
  });

  router.get('/media', async (req: Request, res: Response) => {
    try {
      const rawPath = String(req.query.path || '').trim();
      if (!rawPath) {
        return res.status(400).json({ error: 'path is required' });
      }
      const cleaned = rawPath
        .replace(/^gs:\/\/[^/]+\//, '')
        .replace(/\.\./g, '')
        .replace(/^\/+/, '');
      if (!cleaned || cleaned.includes('://')) {
        return res.status(400).json({ error: 'Invalid media path' });
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

      const storage = getStorage();
      if (storage && GCS_BUCKET) {
        const file = storage.bucket(GCS_BUCKET).file(cleaned);
        const [exists] = await file.exists();
        if (exists) {
          const [meta] = await file.getMetadata().catch(() => [{} as any]);
          const contentType =
            meta?.contentType || (cleaned.endsWith('.webm') ? 'video/webm' : 'video/mp4');
          const totalSize = Number(meta?.size || 0);

          if (req.query.json === '1') {
            const [url] = await file.getSignedUrl({
              version: 'v4',
              action: 'read',
              expires: Date.now() + 2 * 3600 * 1000,
              responseDisposition: 'inline',
              responseType: contentType,
            });
            return res.json({ ok: true, url });
          }

          // Handle HTTP Range header for video seeking & smooth streaming
          const range = req.headers.range;
          res.setHeader('Accept-Ranges', 'bytes');

          if (range && totalSize > 0) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = Math.max(0, parseInt(parts[0], 10) || 0);
            // Cloud Run rejects (500) any response over 32 MiB, and browsers open videos with an
            // open-ended "bytes=0-". Serve bounded chunks; the player asks for the next range.
            const requestedEnd = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
            const end = Math.min(requestedEnd, totalSize - 1, start + MEDIA_CHUNK_BYTES - 1);
            if (start >= totalSize || end < start) {
              res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
              return res.end();
            }
            const chunkSize = end - start + 1;

            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'Content-Length': chunkSize,
              'Content-Type': contentType,
            });
            return file.createReadStream({ start, end }).pipe(res);
          }

          // Without Content-Length the body is sent chunked, which Cloud Run streams without the
          // 32 MiB cap (downloads of long masters / takes).
          if (totalSize > 0 && totalSize <= MEDIA_CHUNK_BYTES) {
            res.setHeader('Content-Length', totalSize);
          }
          res.setHeader('Content-Type', contentType);
          return file.createReadStream().pipe(res);
        }
      }

      // Local fallback if file exists on disk
      const { createReadStream, statSync, existsSync } = await import('fs');
      if (existsSync(cleaned)) {
        const size = statSync(cleaned).size;
        res.setHeader('Content-Type', cleaned.endsWith('.webm') ? 'video/webm' : 'video/mp4');
        res.setHeader('Content-Length', size);
        return createReadStream(cleaned).pipe(res);
      }

      return res.status(404).json({ error: 'Media not found' });
    } catch (err: any) {
      console.error('Media proxy error:', err);
      res.status(500).json({ error: err?.message || 'Media proxy failed' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id || id.includes('/') || id.includes('..')) {
        return res.status(400).json({ error: 'Invalid job id' });
      }
      const job = await loadJob(id);
      const storage = getStorage();
      if (!storage || !GCS_BUCKET) return res.status(503).json({ error: 'GCS unavailable' });
      const bucket = storage.bucket(GCS_BUCKET);
      const prefixes = [`draft/${id}/`, `final/${id}/`, `renders/${id}/`];
      for (const prefix of prefixes) {
        await bucket.deleteFiles({ prefix, force: true }).catch(() => undefined);
      }
      res.json({ ok: true, jobId: id, projectId: job?.projectId || null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to delete render' });
    }
  });

  return router;
}
