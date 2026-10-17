/**
 * Virtual background with Robust Video Matting (RVM, mobilenetv3, ONNX).
 *
 *   ffmpeg decode (crop to the project's shape, constant fps, rgb24)
 *     → RVM (keeps recurrent state across frames, so edges don't flicker)
 *     → keep only the main person (drops photo frames / posters the model also calls "person")
 *     → composite RVM's colour-cleaned foreground over the background
 *     → ffmpeg encode (H.264 + the take's own audio)
 *
 * Runs on CPU (or GPU where onnxruntime has one); no clean plate or first-frame mask needed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

type Ort = typeof import('onnxruntime-node');

const MODEL_FILE = 'rvm_mobilenetv3_fp32.onnx';
/** Long side of the matting resolution. The export upsizes to 1080p; hair detail holds at 1280. */
const MAX_SIDE = Number(process.env.MATTE_MAX_SIDE) || 1280;
/** Talking-head video at 24 fps looks the same and is 20% less work than 30. */
const FPS = Number(process.env.MATTE_FPS) || 24;

export type MatteOptions = {
  inputPath: string;
  backgroundPath: string;
  outputPath: string;
  /** Project shape, e.g. '9:16'. The output is cropped to it (centre crop, like the export). */
  aspectRatio?: string;
  onProgress?: (fraction: number, fps: number) => void;
};

export type MatteResult = { frames: number; seconds: number; fps: number; width: number; height: number };

function modelPath(): string {
  const candidates = [
    process.env.RVM_MODEL_PATH,
    path.resolve('server/matting/models', MODEL_FILE),
    path.resolve('models', MODEL_FILE),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'models', MODEL_FILE),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', MODEL_FILE),
  ].filter(Boolean) as string[];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`RVM model not found (looked in ${candidates.join(', ')})`);
  return hit;
}

type Session = import('onnxruntime-node').InferenceSession;
const sessions: Array<Promise<Session>> = [];
let ortPromise: Promise<Ort> | null = null;

/** CPU threads per RVM run: past ~4 the matmuls stop scaling. */
function threadsPerLane(): number {
  return Number(process.env.MATTE_THREADS) || Math.max(1, Math.min(4, os.cpus().length));
}

/**
 * Parallel lanes: each one mattes its own stretch of the take on its own threads. Helps on
 * machines with real cores; on Cloud Run (vCPUs are hyperthreads) one lane measured fastest,
 * so the service sets MATTE_LANES=1.
 */
export function laneCount(): number {
  if (process.env.MATTE_LANES) return Math.max(1, Number(process.env.MATTE_LANES) || 1);
  return Math.max(1, Math.floor(os.cpus().length / threadsPerLane()));
}

function getOrt(): Promise<Ort> {
  if (!ortPromise) ortPromise = import('onnxruntime-node');
  return ortPromise;
}

function getSession(lane: number): Promise<Session> {
  if (!sessions[lane]) {
    sessions[lane] = getOrt().then((ort) =>
      ort.InferenceSession.create(modelPath(), {
        intraOpNumThreads: threadsPerLane(),
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      })
    );
    sessions[lane].catch(() => delete sessions[lane]);
  }
  return sessions[lane];
}

/** Load the model ahead of the first job (warm service). */
export async function warmUp(): Promise<void> {
  await Promise.all(Array.from({ length: laneCount() }, (_, i) => getSession(i)));
}

function probe(file: string): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
        if (!v) return reject(new Error('No video stream in the take'));
        resolve({
          width: Number(v.width),
          height: Number(v.height),
          duration: Number(j.format?.duration) || 0,
          hasAudio: (j.streams || []).some((s: any) => s.codec_type === 'audio'),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Even-sized centre crop of w×h to `aspect`, then scaled so the long side ≤ MAX_SIDE. */
export function planGeometry(w: number, h: number, aspectRatio?: string) {
  const m = String(aspectRatio || '').match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
  const aspect = m ? Number(m[1]) / Number(m[2]) : w / h;
  let cw = w;
  let ch = h;
  if (w / h > aspect) cw = Math.round(h * aspect);
  else ch = Math.round(w / aspect);
  const scale = Math.min(1, MAX_SIDE / Math.max(cw, ch));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return {
    crop: { w: even(cw), h: even(ch), x: Math.floor((w - even(cw)) / 2), y: Math.floor((h - even(ch)) / 2) },
    out: { w: even(cw * scale), h: even(ch * scale) },
  };
}

function readBackground(file: string, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', file,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length !== w * h * 3) return reject(new Error(`Could not read the background image: ${err.slice(-200)}`));
      resolve(buf);
    });
  });
}

/**
 * Keep the main person: connected regions of the matte (at 1/4 size) much smaller than the
 * largest one are removed, with a little margin so hair and fingers stay attached.
 * Pure; exported for tests.
 */
export function keepMainPerson(pha: Float32Array, w: number, h: number, minShare = 0.3): Float32Array {
  const s = 4;
  const sw = Math.ceil(w / s);
  const sh = Math.ceil(h / s);
  const solid = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      // A small cell counts as person if any of its pixels is fairly opaque.
      let on = 0;
      for (let yy = y * s; yy < Math.min(h, y * s + s) && !on; yy++) {
        for (let xx = x * s; xx < Math.min(w, x * s + s); xx++) {
          if (pha[yy * w + xx] > 0.3) {
            on = 1;
            break;
          }
        }
      }
      solid[y * sw + x] = on;
    }
  }
  const label = new Int32Array(sw * sh);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || label[i]) continue;
    const id = sizes.length;
    let size = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % sw;
      const y = (j / sw) | 0;
      if (x > 0 && solid[j - 1] && !label[j - 1]) (label[j - 1] = id), stack.push(j - 1);
      if (x < sw - 1 && solid[j + 1] && !label[j + 1]) (label[j + 1] = id), stack.push(j + 1);
      if (y > 0 && solid[j - sw] && !label[j - sw]) (label[j - sw] = id), stack.push(j - sw);
      if (y < sh - 1 && solid[j + sw] && !label[j + sw]) (label[j + sw] = id), stack.push(j + sw);
    }
    sizes.push(size);
  }
  if (sizes.length <= 2) return pha; // nothing or one region: nothing to drop
  const largest = Math.max(...sizes);
  const keepId = sizes.map((n) => n >= largest * minShare);
  // Kept cells, grown by 2 cells (~8px) so soft hair edges next to the body survive.
  const keep = new Uint8Array(sw * sh);
  const R = 2;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!keepId[label[y * sw + x]] || !label[y * sw + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= sh) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < sw) keep[yy * sw + xx] = 1;
        }
      }
    }
  }
  const out = new Float32Array(pha.length);
  for (let y = 0; y < h; y++) {
    const row = ((y / s) | 0) * sw;
    for (let x = 0; x < w; x++) {
      if (keep[row + ((x / s) | 0)]) out[y * w + x] = pha[y * w + x];
    }
  }
  return out;
}

/** Pull exactly `n` bytes at a time from a readable stream. */
function frameReader(stream: NodeJS.ReadableStream, n: number) {
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  let waiting: (() => void) | null = null;
  stream.on('data', (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (buf.length >= n * 3) stream.pause?.();
    waiting?.();
  });
  stream.on('end', () => {
    ended = true;
    waiting?.();
  });
  return async (): Promise<Buffer | null> => {
    while (buf.length < n && !ended) {
      stream.resume?.();
      await new Promise<void>((r) => (waiting = r));
      waiting = null;
    }
    if (buf.length < n) return null;
    const frame = buf.subarray(0, n);
    buf = buf.subarray(n);
    if (buf.length < n * 3) stream.resume?.();
    return Buffer.from(frame);
  };
}

function write(proc: ChildProcessWithoutNullStreams, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.stdin.write(data)) return resolve();
    const onErr = (e: Error) => reject(e);
    proc.stdin.once('error', onErr);
    proc.stdin.once('drain', () => {
      proc.stdin.off('error', onErr);
      resolve();
    });
  });
}

type Lane = { from: number; len: number; file: string };

/** Matte one stretch of the take (video only) into `lane.file`; returns frames written. */
async function matteLane(
  lane: Lane,
  laneIdx: number,
  g: { crop: ReturnType<typeof planGeometry>['crop']; W: number; H: number; bg: Buffer; input: string },
  onFrame: () => void
): Promise<number> {
  const ort = await getOrt();
  const session = await getSession(laneIdx);
  const { crop, W, H, bg } = g;
  const decoder = spawn('ffmpeg', [
    '-nostdin', '-v', 'error',
    ...(lane.from > 0 ? ['-ss', lane.from.toFixed(3)] : []),
    '-i', g.input,
    ...(Number.isFinite(lane.len) ? ['-t', lane.len.toFixed(3)] : []),
    '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${H}:flags=bicubic,fps=${FPS}`,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]) as ChildProcessWithoutNullStreams;
  const encoder = spawn('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', lane.file,
  ]) as ChildProcessWithoutNullStreams;
  let encErr = '';
  encoder.stderr.on('data', (d) => (encErr += d));
  const encDone = new Promise<void>((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`encode failed: ${encErr.slice(-300)}`))));
  });

  const nextFrame = frameReader(decoder.stdout, W * H * 3);
  const plane = W * H;
  const src = new Float32Array(3 * plane);
  const outFrame = Buffer.alloc(plane * 3);
  // Recurrent state starts empty; RVM grows it on the first frame.
  let rec: Record<string, import('onnxruntime-node').Tensor> = {};
  for (const k of ['r1i', 'r2i', 'r3i', 'r4i']) rec[k] = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  // RVM's encoder sees ~320px (0.25 at 1280, the recommended ratio); its refiner restores full-res edges.
  const ratio = new ort.Tensor('float32', new Float32Array([Math.min(1, 320 / Math.max(W, H))]), [1]);

  let frames = 0;
  try {
    for (;;) {
      const f = await nextFrame();
      if (!f) break;
      for (let i = 0, j = 0; i < plane; i++, j += 3) {
        src[i] = f[j] / 255;
        src[plane + i] = f[j + 1] / 255;
        src[2 * plane + i] = f[j + 2] / 255;
      }
      const res = await session.run({ src: new ort.Tensor('float32', src, [1, 3, H, W]), ...rec, downsample_ratio: ratio });
      rec = { r1i: res.r1o, r2i: res.r2o, r3i: res.r3o, r4i: res.r4o };
      const fgr = res.fgr.data as Float32Array;
      const pha = keepMainPerson(res.pha.data as Float32Array, W, H);
      for (let i = 0, j = 0; i < plane; i++, j += 3) {
        const a = pha[i];
        const b = 1 - a;
        outFrame[j] = Math.max(0, Math.min(255, fgr[i] * 255 * a + bg[j] * b));
        outFrame[j + 1] = Math.max(0, Math.min(255, fgr[plane + i] * 255 * a + bg[j + 1] * b));
        outFrame[j + 2] = Math.max(0, Math.min(255, fgr[2 * plane + i] * 255 * a + bg[j + 2] * b));
      }
      await write(encoder, outFrame);
      frames++;
      onFrame();
    }
  } finally {
    encoder.stdin.end();
    decoder.kill('SIGKILL');
  }
  await encDone;
  return frames;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

/**
 * The take is split into one stretch per lane, matted in parallel, then joined (no re-encode)
 * and given the take's own audio. RVM restarts its memory at each join; with ≥8 s stretches
 * that settles within a few frames.
 */
export async function matteVideo(opts: MatteOptions): Promise<MatteResult> {
  const t0 = Date.now();
  const info = await probe(opts.inputPath);
  const { crop, out } = planGeometry(info.width, info.height, opts.aspectRatio);
  const W = out.w;
  const H = out.h;
  const bg = await readBackground(opts.backgroundPath, W, H);
  const totalFrames = Math.max(1, Math.round(info.duration * FPS));

  const lanesWanted = info.duration > 0 ? Math.min(laneCount(), Math.max(1, Math.floor(info.duration / 8))) : 1;
  const base = path.join(path.dirname(opts.outputPath), `lane-${Date.now()}`);
  // Stretch boundaries on whole frames so the joined video keeps its exact length.
  const step = Math.ceil((info.duration * FPS) / lanesWanted) / FPS;
  const lanes: Lane[] = Array.from({ length: lanesWanted }, (_, i) => ({
    from: i * step,
    len: i === lanesWanted - 1 ? Infinity : step,
    file: `${base}-${i}.mp4`,
  }));

  let frames = 0;
  const onFrame = () => {
    frames++;
    if (frames % 15 === 0) opts.onProgress?.(Math.min(0.99, frames / totalFrames), frames / ((Date.now() - t0) / 1000));
  };
  try {
    const counts = await Promise.all(lanes.map((l, i) => matteLane(l, i, { crop, W, H, bg, input: opts.inputPath }, onFrame)));
    if (!counts.some(Boolean)) throw new Error('No frames decoded from the take');
    const list = `${base}.txt`;
    await fs.promises.writeFile(list, lanes.filter((_, i) => counts[i]).map((l) => `file '${l.file}'`).join('\n'));
    await run([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', opts.inputPath,
      '-map', '0:v:0', ...(info.hasAudio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '160k'] : []),
      '-c:v', 'copy', '-movflags', '+faststart', '-shortest', opts.outputPath,
    ]);
  } finally {
    for (const l of lanes) await fs.promises.rm(l.file, { force: true }).catch(() => {});
    await fs.promises.rm(`${base}.txt`, { force: true }).catch(() => {});
  }
  const seconds = (Date.now() - t0) / 1000;
  opts.onProgress?.(1, frames / seconds);
  return { frames, seconds, fps: frames / seconds, width: W, height: H };
}
