/**
 * "Apply background" for a take that was recorded without the virtual background (plain camera,
 * imported footage, or baked with an older background): play the take once, cut the person out
 * of every frame with the same segmentation the live shoot uses, draw them over the background
 * and record the result with the take's own audio. Runs in real time in the browser.
 */
import {
  aspectRatioValue,
  coverCrop,
  drawPersonOverBackground,
  ensureSegmenter,
  segmentPerson,
} from './segmentation';

export type ApplyBackgroundResult = { blob: Blob; mimeType: string };

function pickMime(): string {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error('Background image is empty')));
    img.onerror = () => reject(new Error('Could not load the background image'));
    img.src = src;
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('Could not open the take'));
    v.src = src;
  });
}

/** Share of near-pure-green pixels in one frame (a take recorded on virtual green is mostly green). */
export async function sampleGreenRatio(videoUrl: string, atSec = 1): Promise<number> {
  const v = await loadVideo(videoUrl);
  await new Promise<void>((resolve) => {
    v.onseeked = () => resolve();
    v.currentTime = Math.min(atSec, Number.isFinite(v.duration) ? v.duration / 2 : atSec);
  });
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(v, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  let green = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 180 && d[i] < 90 && d[i + 2] < 90) green++;
  v.removeAttribute('src');
  return green / (64 * 64);
}

export async function applyBackgroundToTake(opts: {
  videoUrl: string;
  backgroundUrl: string;
  aspectRatio?: string;
  /** Length to use when the file does not report one (some recorded webm files). */
  durationHint?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<ApplyBackgroundResult> {
  await ensureSegmenter();
  const [video, bg] = await Promise.all([loadVideo(opts.videoUrl), loadImage(opts.backgroundUrl)]);
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : opts.durationHint || 0;

  const crop = coverCrop(video.videoWidth, video.videoHeight, aspectRatioValue(opts.aspectRatio));
  const scale = Math.min(1, 1920 / Math.max(crop.sw, crop.sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(crop.sw * scale));
  canvas.height = Math.max(2, Math.round(crop.sh * scale));
  const ctx = canvas.getContext('2d')!;

  // The take's sound goes into the recording only, not out of the speakers.
  const audioCtx = new AudioContext();
  await audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaElementSource(video);
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const draw = () => {
    const mask = segmentPerson(video, { crop });
    if (mask) drawPersonOverBackground(ctx, video, mask, bg, 2, crop);
    if (duration) opts.onProgress?.(Math.min(1, video.currentTime / duration));
  };
  // requestVideoFrameCallback fires once per decoded frame; rAF is the fallback.
  const rvfc = (video as any).requestVideoFrameCallback?.bind(video) as
    | ((cb: () => void) => number)
    | undefined;
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    draw();
    if (rvfc) rvfc(loop);
    else requestAnimationFrame(loop);
  };

  // A hidden tab stops drawing frames: pause both the take and the recording until it's back.
  const onVisibility = () => {
    if (document.hidden) {
      video.pause();
      if (recorder.state === 'recording') recorder.pause();
    } else if (!stopped) {
      if (recorder.state === 'paused') recorder.resume();
      void video.play().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  try {
    draw();
    const done = new Promise<void>((resolve, reject) => {
      video.onended = () => resolve();
      video.onerror = () => reject(new Error('The take stopped playing'));
      opts.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    });
    recorder.start(1000);
    await video.play();
    loop();
    await done;
  } finally {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    video.pause();
    await new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve();
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx.close().catch(() => {});
  }
  if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  opts.onProgress?.(1);
  const type = (mimeType || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  if (blob.size < 1024) throw new Error('The new take came out empty — try again.');
  return { blob, mimeType: type };
}
