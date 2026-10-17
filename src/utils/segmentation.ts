/**
 * Virtual green screen — MediaPipe person segmentation (no physical screen needed).
 *
 * - Works on the part of the camera frame the video actually uses (`coverCrop` of the frame to
 *   the output aspect ratio), so no model resolution is spent on pixels that get cropped away.
 * - That crop is split into up to two square tiles, each segmented at the model's native 256px
 *   and merged — roughly double the mask resolution of squashing a whole frame into one square.
 *   Slow devices fall back to one tile automatically so the preview stays real-time.
 * - `drawPersonOverBackground` / `drawPersonOverGreen` upscale the mask with colour-guided (joint
 *   bilateral) edges on the GPU, falling back to a canvas feather, and composite.
 *
 * If MediaPipe cannot load, `segmentationAvailable()` becomes false and callers should
 * fall back to a normal camera record.
 */
import type { ImageSegmenter } from '@mediapipe/tasks-vision';

const TASKS_VISION_VERSION = '1.1.0';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
/** Native input size of selfie_multiclass_256x256. */
const MODEL_PX = 256;

/** Pure chroma green used behind the person on the record canvas. */
export const CHROMA_GREEN = '#00FF00';

/** Region of the camera frame (source pixels) that the output video uses. */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface PersonMask {
  /** Person probability per pixel, 0..1, row-major (width * height). */
  mask: Float32Array;
  width: number;
  height: number;
  /** Camera region the mask covers (whole frame when absent). */
  crop?: CropRect;
}

/** '9:16' → 0.5625. Unknown values return undefined (= use the whole frame). */
export function aspectRatioValue(ratio: string | undefined): number | undefined {
  const m = String(ratio || '').match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const v = Number(m[1]) / Number(m[2]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Centre crop of a vw×vh frame to `aspect` (w/h) — what a "cover" fit keeps. */
export function coverCrop(vw: number, vh: number, aspect?: number): CropRect {
  if (!aspect || !vw || !vh) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const frame = vw / vh;
  if (Math.abs(frame - aspect) < 0.01) return { sx: 0, sy: 0, sw: vw, sh: vh };
  if (frame > aspect) {
    const sw = Math.round(vh * aspect);
    return { sx: Math.round((vw - sw) / 2), sy: 0, sw, sh: vh };
  }
  const sh = Math.round(vw / aspect);
  return { sx: 0, sy: Math.round((vh - sh) / 2), sw: vw, sh };
}

type SegState = 'idle' | 'loading' | 'ready' | 'failed';

/** segmenters[k] handles tile k (separate instances so VIDEO-mode state never mixes tiles). */
let segmenters: ImageSegmenter[] = [];
let state: SegState = 'idle';
let initPromise: Promise<ImageSegmenter> | null = null;
let makeSegmenter: (() => Promise<ImageSegmenter>) | null = null;
let secondTilePromise: Promise<void> | null = null;
let lastTimestampMs = 0;
let lastVideoTime = -1;
let lastResult: PersonMask | null = null;
let lastSegmentAt = 0;
/**
 * Motion-adaptive temporal smoothing of the person mask. Steady pixels are averaged to stop
 * edge flicker; pixels that changed a lot (the creator moved) follow the new frame at once,
 * so the mask never trails behind and reveals the real room.
 */
let emaMask: Float32Array | null = null;
const EMA_PREV_STEADY = 0.35;
const MOTION_DELTA = 0.25;
/** Minimum gap between segmentations (one per displayed frame, not one per rAF on 120Hz). */
const MIN_SEGMENT_GAP_MS = 14;
/** Average per-frame cost above which two tiles are dropped for one (keeps the preview live). */
const TWO_TILE_BUDGET_MS = 28;
const TWO_TILE_WARMUP_FRAMES = 15;
let avgSegmentMs = 0;
let segmentSamples = 0;
let singleTileOnly = false;

/** True unless MediaPipe has definitively failed to load (optimistic before first init). */
export function segmentationAvailable(): boolean {
  return state !== 'failed';
}

/** True once the model is loaded and ready for per-frame work. */
export function segmentationReady(): boolean {
  return state === 'ready' && segmenters.length > 0;
}

/** Lazy-init singleton. Rejects (and marks unavailable) if the WASM/model fail to load. */
export function ensureSegmenter(): Promise<ImageSegmenter> {
  if (segmenters[0]) return Promise.resolve(segmenters[0]);
  if (state === 'failed') return Promise.reject(new Error('Segmentation unavailable'));
  if (initPromise) return initPromise;

  state = 'loading';
  initPromise = (async () => {
    try {
      const { FilesetResolver, ImageSegmenter: Segmenter } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const make = (delegate: 'GPU' | 'CPU') =>
        Segmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      let created: ImageSegmenter;
      let delegate: 'GPU' | 'CPU' = 'GPU';
      try {
        created = await make('GPU');
      } catch (gpuErr) {
        console.warn('[segmentation] GPU delegate failed, using CPU', gpuErr);
        delegate = 'CPU';
        created = await make('CPU');
      }
      makeSegmenter = () => make(delegate);
      segmenters = [created];
      state = 'ready';
      return created;
    } catch (err) {
      console.warn('[segmentation] MediaPipe failed to load', err);
      state = 'failed';
      initPromise = null;
      throw err;
    }
  })();
  return initPromise;
}

/** Diagnostics: how many tile segmenters are live and whether the device fell back to one. */
export function segmentationStats(): { segmenters: number; singleTileOnly: boolean; avgTwoTileMs: number } {
  return { segmenters: segmenters.length, singleTileOnly, avgTwoTileMs: Math.round(avgSegmentMs * 10) / 10 };
}

/** Second segmenter for the second tile, created in the background on first need. */
function ensureSecondTile(): void {
  if (segmenters[1] || secondTilePromise || !makeSegmenter || singleTileOnly) return;
  secondTilePromise = makeSegmenter()
    .then((s) => {
      if (state === 'ready') segmenters[1] = s;
      else s.close();
    })
    .catch((err) => {
      console.warn('[segmentation] second tile unavailable, using one tile', err);
      singleTileOnly = true;
    });
}

/** Release the segmenter (e.g. on app teardown). Next ensureSegmenter() re-initialises. */
export function disposeSegmenter(): void {
  for (const s of segmenters) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  segmenters = [];
  initPromise = null;
  secondTilePromise = null;
  makeSegmenter = null;
  lastResult = null;
  emaMask = null;
  lastVideoTime = -1;
  avgSegmentMs = 0;
  segmentSamples = 0;
  for (const r of refiners.values()) r.gl.getExtension('WEBGL_lose_context')?.loseContext();
  refiners.clear();
  if (state !== 'failed') state = 'idle';
}

// ── Tiling ──────────────────────────────────────────────────────────────────

export interface Tile {
  /** Tile rect in source pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One tile covering the crop, or two overlapping squares along its long side. (Exported for tests.) */
export function tilesFor(crop: CropRect, maxTiles: number): Tile[] {
  const long = Math.max(crop.sw, crop.sh);
  const short = Math.min(crop.sw, crop.sh);
  if (maxTiles < 2 || long / short < 1.15) {
    return [{ x: crop.sx, y: crop.sy, w: crop.sw, h: crop.sh }];
  }
  // Two tiles; square unless the crop is wider than 2:1 (then each covers half the long side).
  const tileLong = Math.max(short, Math.ceil(long / 2));
  const portrait = crop.sh >= crop.sw;
  const tw = portrait ? crop.sw : tileLong;
  const th = portrait ? tileLong : crop.sh;
  return [
    { x: crop.sx, y: crop.sy, w: tw, h: th },
    portrait
      ? { x: crop.sx, y: crop.sy + crop.sh - th, w: tw, h: th }
      : { x: crop.sx + crop.sw - tw, y: crop.sy, w: tw, h: th },
  ];
}

const tileCanvases: HTMLCanvasElement[] = [];
function tileCanvas(k: number): HTMLCanvasElement {
  if (!tileCanvases[k]) tileCanvases[k] = makeCanvas(MODEL_PX, MODEL_PX);
  return tileCanvases[k];
}

function sameCrop(a?: CropRect, b?: CropRect): boolean {
  if (!a || !b) return a === b;
  return a.sx === b.sx && a.sy === b.sy && a.sw === b.sw && a.sh === b.sh;
}

/**
 * Segment the current video frame. Synchronous — call after `ensureSegmenter()` resolved.
 * Returns null if not ready / no new frame data. Re-uses the previous mask when the video
 * has not advanced so callers can run on rAF.
 *
 * `opts.crop` limits segmentation to the part of the frame the output uses (see `coverCrop`).
 */
export function segmentPerson(
  video: HTMLVideoElement,
  opts?: { crop?: CropRect; width?: number }
): PersonMask | null {
  const first = segmenters[0];
  if (!first || state !== 'ready') return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (video.readyState < 2 || !vw || !vh) return null;
  const crop = clampCrop(opts?.crop || { sx: 0, sy: 0, sw: vw, sh: vh }, vw, vh);

  const now = performance.now();
  const cropChanged = !sameCrop(lastResult?.crop, crop);
  // Segment every new camera frame: a stale mask on a fresh frame is what shows the room.
  if (lastResult && !cropChanged && now - lastSegmentAt < MIN_SEGMENT_GAP_MS) return lastResult;
  if (lastResult && !cropChanged && video.currentTime === lastVideoTime) return lastResult;

  const wantTiles = singleTileOnly ? 1 : 2;
  let tiles = tilesFor(crop, wantTiles);
  if (tiles.length > 1) {
    ensureSecondTile();
    if (!segmenters[1]) tiles = tilesFor(crop, 1);
  }

  try {
    const t0 = performance.now();
    // All tiles share a size, so the merged mask has one scale.
    const scaleX = MODEL_PX / tiles[0].w;
    const scaleY = MODEL_PX / tiles[0].h;
    const width = Math.max(1, Math.round(crop.sw * scaleX));
    const height = Math.max(1, Math.round(crop.sh * scaleY));
    const person = new Float32Array(width * height);

    for (let k = 0; k < tiles.length; k++) {
      const tile = tiles[k];
      const canvas = tileCanvas(k);
      const tctx = canvas.getContext('2d')!;
      tctx.drawImage(video, tile.x, tile.y, tile.w, tile.h, 0, 0, MODEL_PX, MODEL_PX);
      // Timestamps must be strictly increasing (per instance; shared counter keeps it simple).
      const ts = Math.max(now, lastTimestampMs + 1);
      lastTimestampMs = ts;
      const result = segmenters[k].segmentForVideo(canvas, ts);
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) {
        result.close();
        continue;
      }
      // selfie_multiclass: confidence mask 0 = background; person = 1 - background.
      const bg = masks[0];
      const bgData = bg.getAsFloat32Array();
      const mw = bg.width;
      const mh = bg.height;
      const ox = Math.round((tile.x - crop.sx) * scaleX);
      const oy = Math.round((tile.y - crop.sy) * scaleY);
      for (let y = 0; y < mh; y++) {
        const ty = oy + Math.round((y * MODEL_PX) / mh);
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < mw; x++) {
          const tx = ox + Math.round((x * MODEL_PX) / mw);
          if (tx < 0 || tx >= width) continue;
          let v = 1 - bgData[y * mw + x];
          v = v < 0 ? 0 : v > 1 ? 1 : v;
          const idx = ty * width + tx;
          if (v > person[idx]) person[idx] = v;
        }
      }
      result.close();
    }

    // Motion-adaptive EMA: smooth steady edges, snap where the body moved.
    if (!emaMask || emaMask.length !== person.length || cropChanged) {
      emaMask = person;
    } else {
      for (let i = 0; i < person.length; i++) {
        const cur = person[i];
        const prev = emaMask[i];
        const delta = cur > prev ? cur - prev : prev - cur;
        emaMask[i] = delta > MOTION_DELTA ? cur : cur + (prev - cur) * EMA_PREV_STEADY;
      }
    }

    // Too slow for two tiles on this device → one tile from now on. The first frames of a new
    // model instance are slow while it warms up, so they don't count.
    const cost = performance.now() - t0;
    if (tiles.length > 1) {
      segmentSamples++;
      const steady = segmentSamples - TWO_TILE_WARMUP_FRAMES;
      if (steady === 1) avgSegmentMs = cost;
      else if (steady > 1) avgSegmentMs = avgSegmentMs * 0.9 + cost * 0.1;
      if (steady > 30 && avgSegmentMs > TWO_TILE_BUDGET_MS) {
        console.warn(`[segmentation] ${avgSegmentMs.toFixed(1)}ms/frame with 2 tiles — switching to 1`);
        singleTileOnly = true;
      }
    }

    lastResult = { mask: new Float32Array(emaMask), width, height, crop };
    lastSegmentAt = now;
    lastVideoTime = video.currentTime;
    return lastResult;
  } catch (err) {
    console.warn('[segmentation] segmentForVideo failed', err);
    return lastResult;
  }
}

function clampCrop(c: CropRect, vw: number, vh: number): CropRect {
  const sx = Math.max(0, Math.min(vw - 1, Math.round(c.sx)));
  const sy = Math.max(0, Math.min(vh - 1, Math.round(c.sy)));
  return {
    sx,
    sy,
    sw: Math.max(1, Math.min(vw - sx, Math.round(c.sw))),
    sh: Math.max(1, Math.min(vh - sy, Math.round(c.sh))),
  };
}

// ── Compositing ─────────────────────────────────────────────────────────────

/** Alpha edge: mask probability range mapped to 0..1 (centre below 0.5 so edges aren't shaved). */
const EDGE_LO = 0.22;
const EDGE_HI = 0.58;

let maskCanvas: HTMLCanvasElement | null = null;
let maskCanvasFor: PersonMask | null = null;
/** One scratch cutout canvas per output size (preview + record run at different sizes). */
const personCanvases = new Map<string, HTMLCanvasElement>();

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Person probability → alpha channel on a small canvas (cached per mask object). */
function getMaskCanvas(mask: PersonMask): HTMLCanvasElement {
  if (maskCanvas && maskCanvasFor === mask) return maskCanvas;
  if (!maskCanvas || maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
    maskCanvas = makeCanvas(mask.width, mask.height);
  }
  const mctx = maskCanvas.getContext('2d')!;
  const img = mctx.createImageData(mask.width, mask.height);
  const d = img.data;
  const m = mask.mask;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const p = m[i];
    const t = p <= EDGE_LO ? 0 : p >= EDGE_HI ? 1 : (p - EDGE_LO) / (EDGE_HI - EDGE_LO);
    const a = t * t * (3 - 2 * t);
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = Math.round(a * 255);
  }
  mctx.putImageData(img, 0, 0);
  maskCanvasFor = mask;
  return maskCanvas;
}

// ── GPU edge refinement ─────────────────────────────────────────────────────
//
// The model mask is low-res; stretching it to the output makes a soft halo. Instead upsample it
// with a joint bilateral filter guided by the full-res camera frame: each output pixel averages
// nearby mask samples weighted by how similar their colour is to this pixel, so the alpha edge
// snaps to the real edge of hair/shoulders. One WebGL context per output size.

const REFINE_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const REFINE_FS = `
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform vec2 uMaskTexel;
uniform vec4 uCrop;
varying vec2 vUv;
const float SIGMA_S2 = 2.0 * 1.3 * 1.3;
const float SIGMA_R2 = 2.0 * 0.14 * 0.14;
vec3 cam(vec2 uv) { return texture2D(uVideo, uCrop.xy + uv * uCrop.zw).rgb; }
void main() {
  vec3 c = cam(vUv);
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 uv = vUv + o * uMaskTexel;
      vec3 d = c - cam(uv);
      float w = exp(-dot(o, o) / SIGMA_S2 - dot(d, d) / SIGMA_R2);
      sum += texture2D(uMask, uv).r * w;
      wsum += w;
    }
  }
  float a = smoothstep(${EDGE_LO.toFixed(2)}, ${EDGE_HI.toFixed(2)}, sum / max(wsum, 1e-4));
  gl_FragColor = vec4(c * a, a);
}`;

interface Refiner {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  videoTex: WebGLTexture;
  maskTex: WebGLTexture;
  uMaskTexel: WebGLUniformLocation | null;
  uCrop: WebGLUniformLocation | null;
  maskBytes: Uint8Array | null;
  uploadedMask: PersonMask | null;
}

const refiners = new Map<string, Refiner>();
let refineUnavailable = false;

function makeTexture(gl: WebGLRenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

function createRefiner(w: number, h: number): Refiner | null {
  const canvas = makeCanvas(w, h);
  const gl = canvas.getContext('webgl', {
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    antialias: false,
  }) as WebGLRenderingContext | null;
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, REFINE_VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, REFINE_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  const videoTex = makeTexture(gl);
  gl.activeTexture(gl.TEXTURE1);
  const maskTex = makeTexture(gl);
  gl.uniform1i(gl.getUniformLocation(prog, 'uVideo'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'uMask'), 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return {
    canvas,
    gl,
    videoTex,
    maskTex,
    uMaskTexel: gl.getUniformLocation(prog, 'uMaskTexel'),
    uCrop: gl.getUniformLocation(prog, 'uCrop'),
    maskBytes: null,
    uploadedMask: null,
  };
}

function getRefiner(w: number, h: number): Refiner | null {
  if (refineUnavailable) return null;
  const key = `${w}x${h}`;
  const hit = refiners.get(key);
  if (hit && !hit.gl.isContextLost()) return hit;
  if (refiners.size >= 3) {
    for (const r of refiners.values()) r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    refiners.clear();
  }
  try {
    const r = createRefiner(w, h);
    if (!r) {
      refineUnavailable = true;
      return null;
    }
    refiners.set(key, r);
    return r;
  } catch (err) {
    console.warn('[segmentation] GPU edge refine unavailable, using canvas feather', err);
    refineUnavailable = true;
    return null;
  }
}

/** Person cut out of `video` with colour-guided edges (premultiplied RGBA), or null if no WebGL. */
function refinePersonCutout(
  video: HTMLVideoElement,
  mask: PersonMask,
  crop: CropRect,
  w: number,
  h: number
): HTMLCanvasElement | null {
  const r = getRefiner(w, h);
  if (!r) return null;
  const { gl } = r;
  try {
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    if (r.uploadedMask !== mask) {
      const n = mask.width * mask.height;
      if (!r.maskBytes || r.maskBytes.length !== n) r.maskBytes = new Uint8Array(n);
      const bytes = r.maskBytes;
      const m = mask.mask;
      for (let i = 0; i < n; i++) bytes[i] = (m[i] * 255 + 0.5) | 0;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, r.maskTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        mask.width,
        mask.height,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        bytes
      );
      r.uploadedMask = mask;
    }
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    gl.uniform2f(r.uMaskTexel, 1 / mask.width, 1 / mask.height);
    gl.uniform4f(r.uCrop, crop.sx / vw, crop.sy / vh, crop.sw / vw, crop.sh / vh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return r.canvas;
  } catch (err) {
    console.warn('[segmentation] GPU edge refine failed, using canvas feather', err);
    refineUnavailable = true;
    return null;
  }
}

/** Video crop cut out by the (upscaled + feathered) mask, on a scratch canvas. */
function renderPersonCutout(
  video: HTMLVideoElement,
  mask: PersonMask,
  crop: CropRect,
  w: number,
  h: number,
  featherPx: number
): HTMLCanvasElement {
  const key = `${w}x${h}`;
  let personCanvas = personCanvases.get(key);
  if (!personCanvas) {
    if (personCanvases.size > 4) personCanvases.clear();
    personCanvas = makeCanvas(w, h);
    personCanvases.set(key, personCanvas);
  }
  const pctx = personCanvas.getContext('2d')!;
  pctx.globalCompositeOperation = 'source-over';
  pctx.clearRect(0, 0, w, h);
  pctx.filter = 'none';
  pctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);

  // Keep only person pixels: destination-in with the upscaled, blurred mask.
  pctx.globalCompositeOperation = 'destination-in';
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  const feather = Math.max(0, featherPx);
  if (feather > 0) {
    // ctx.filter is unsupported on some Safari versions — bilinear upscale still softens the edge.
    pctx.filter = `blur(${feather}px)`;
  }
  pctx.drawImage(getMaskCanvas(mask), 0, 0, w, h);
  pctx.filter = 'none';
  pctx.globalCompositeOperation = 'source-over';
  return personCanvas;
}

/**
 * Draw the person (cut out of `video`) over `background` on `ctx`.
 * `background` may be a CSS colour string (e.g. '#00FF00') or any CanvasImageSource
 * (image/video/canvas) which is cover-fitted to the canvas.
 * The camera region drawn is the mask's crop (pass the same crop as `segmentPerson`); size the
 * canvas to that crop's aspect ratio.
 */
export function drawPersonOverBackground(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  mask: PersonMask | ImageData | Float32Array | null,
  background: CanvasImageSource | string,
  featherPx = 2,
  crop?: CropRect
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';

  if (typeof background === 'string') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  } else {
    drawCover(ctx, background, w, h);
  }

  const pm = toPersonMask(mask);
  const region =
    pm?.crop || crop || { sx: 0, sy: 0, sw: video.videoWidth || w, sh: video.videoHeight || h };
  if (pm) {
    const cutout =
      refinePersonCutout(video, pm, region, w, h) || renderPersonCutout(video, pm, region, w, h, featherPx);
    ctx.drawImage(cutout, 0, 0, w, h);
  } else if (region.sw && region.sh) {
    // No mask yet: show the raw camera so the preview never goes black.
    try {
      ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, w, h);
    } catch {
      /* frame not ready */
    }
  }
  ctx.restore();
}

/** Pure #00FF00 behind the person with feathered edges (the recorded/chroma-key canvas). */
export function drawPersonOverGreen(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  mask: PersonMask | ImageData | Float32Array | null,
  featherPx = 2,
  crop?: CropRect
): void {
  drawPersonOverBackground(ctx, video, mask, CHROMA_GREEN, featherPx, crop);
}

/** Cover-fit any image source into a w×h canvas. */
function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number): void {
  const { sw, sh } = sourceSize(src);
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  try {
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } catch {
    /* image not decoded yet */
  }
}

function sourceSize(src: CanvasImageSource): { sw: number; sh: number } {
  if (src instanceof HTMLVideoElement) return { sw: src.videoWidth, sh: src.videoHeight };
  if (src instanceof HTMLImageElement) return { sw: src.naturalWidth, sh: src.naturalHeight };
  const any = src as { width?: number; height?: number };
  return { sw: Number(any.width) || 0, sh: Number(any.height) || 0 };
}

/** Accept PersonMask (preferred), ImageData (alpha or red channel), or a bare Float32Array (square). */
function toPersonMask(mask: PersonMask | ImageData | Float32Array | null): PersonMask | null {
  if (!mask) return null;
  if (mask instanceof Float32Array) {
    const side = Math.round(Math.sqrt(mask.length));
    return side * side === mask.length ? { mask, width: side, height: side } : null;
  }
  if ('mask' in mask) return mask;
  const out = new Float32Array(mask.width * mask.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = mask.data[j + 3] / 255;
  return { mask: out, width: mask.width, height: mask.height };
}
