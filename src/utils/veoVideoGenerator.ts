/**
 * Google Cloud Veo 3.1 Neural Video Integration Client
 * Handles full long-running operation lifecycle:
 * 1. Start generation (POST /api/generate-video)
 * 2. Poll progress (POST /api/video-status)
 * 3. Stream/Download master video (POST/GET /api/video-download)
 */

export interface VeoGenerationParams {
  prompt: string;
  aspectRatio?: '9:16' | '16:9';
  resolution?: '720p' | '1080p';
  model?: 'veo-3.1-generate-preview' | 'veo-3.1-lite-generate-preview';
  startingImageUrl?: string;
}

export interface VeoProgressUpdate {
  phase: 'starting' | 'polling' | 'downloading' | 'completed' | 'error';
  message: string;
  elapsedSeconds: number;
  operationName?: string;
}

export interface VeoGenerationResult {
  videoUrl: string;
  operationName: string;
  model: string;
}

export class VeoQuotaError extends Error {
  requiresPaidKey: boolean;
  constructor(message: string, requiresPaidKey = true) {
    super(message);
    this.name = 'VeoQuotaError';
    this.requiresPaidKey = requiresPaidKey;
  }
}

/**
 * 1. Start Veo Video Generation operation on backend
 */
export async function startVeoVideoGeneration(
  params: VeoGenerationParams
): Promise<{ operationName: string; model: string }> {
  const response = await fetch('/api/generate-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: params.prompt,
      aspectRatio: params.aspectRatio || '9:16',
      resolution: params.resolution || '720p',
      model: params.model || 'veo-3.1-generate-preview',
      startingImageUrl: params.startingImageUrl,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 429 || data.requiresPaidKey || data.error === 'QUOTA_EXHAUSTED') {
      throw new VeoQuotaError(
        data.message || 'Veo video generation requires a paid Gemini API key with Veo quota enabled in AI Studio.',
        true
      );
    }
    throw new Error(data.message || data.error || 'Failed to start Veo video generation');
  }

  if (!data.operationName) {
    throw new Error('No operationName returned from Veo video service');
  }

  return {
    operationName: data.operationName,
    model: data.model || 'veo-3.1-generate-preview',
  };
}

/**
 * 2. Check long-running operation status
 */
export async function checkVeoVideoStatus(
  operationName: string
): Promise<{ done: boolean; error?: any; hasVideo?: boolean; downloadUrl?: string | null }> {
  const response = await fetch('/api/video-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Failed to check video status (HTTP ${response.status})`);
  }

  return await response.json();
}

/**
 * 3. Download the finished MP4 video blob
 */
export async function downloadVeoVideoBlob(operationName: string): Promise<Blob> {
  const response = await fetch('/api/video-download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video download failed (${response.status}): ${errorText}`);
  }

  return await response.blob();
}

/**
 * End-to-End Veo Video Generator Orchestrator
 * Connects to Veo 3.1 API, handles polling with reassuring messages, and downloads the video.
 */
export async function generateVeoVideoCutaway(
  params: VeoGenerationParams,
  onProgress?: (update: VeoProgressUpdate) => void,
  abortSignal?: AbortSignal
): Promise<VeoGenerationResult> {
  const startTime = Date.now();

  const getElapsed = () => Math.round((Date.now() - startTime) / 1000);

  // Phase 1: Initialize
  onProgress?.({
    phase: 'starting',
    message: 'Connecting to Google Cloud Veo 3.1 neural video diffusion model...',
    elapsedSeconds: 0,
  });

  const { operationName, model } = await startVeoVideoGeneration(params);

  // Progressive reassurance messages for long-running generation
  const reassuranceMessages = [
    'Synthesizing dynamic 60fps camera motion and cinematic composition...',
    'Rendering temporal consistency, physics, and volumetric lighting...',
    'Veo 3.1 is synthesizing photorealistic b-roll cutaway frames...',
    'Applying cinema-grade color science & depth of field...',
    'Encoding high-definition MP4 cutaway clip...',
  ];

  let pollCount = 0;
  let isDone = false;

  // Phase 2: Poll operation until completed
  while (!isDone) {
    if (abortSignal?.aborted) {
      throw new Error('Video generation was cancelled');
    }

    // Wait 4 seconds between poll checks
    await new Promise((resolve) => setTimeout(resolve, 4000));
    pollCount++;

    const elapsed = getElapsed();
    const messageIndex = Math.min(pollCount - 1, reassuranceMessages.length - 1);
    const message = reassuranceMessages[messageIndex];

    onProgress?.({
      phase: 'polling',
      message: `${message} (${elapsed}s elapsed)`,
      elapsedSeconds: elapsed,
      operationName,
    });

    const status = await checkVeoVideoStatus(operationName);

    if (status.error) {
      const errMsg = typeof status.error === 'object' ? JSON.stringify(status.error) : String(status.error);
      throw new Error(`Veo generation failed: ${errMsg}`);
    }

    if (status.done) {
      isDone = true;
    }
  }

  // Phase 3: Download video
  onProgress?.({
    phase: 'downloading',
    message: 'Downloading generated Veo MP4 video cutaway...',
    elapsedSeconds: getElapsed(),
    operationName,
  });

  const blob = await downloadVeoVideoBlob(operationName);
  const videoUrl = URL.createObjectURL(blob);

  onProgress?.({
    phase: 'completed',
    message: 'Veo 3.1 cutaway video ready!',
    elapsedSeconds: getElapsed(),
    operationName,
  });

  return {
    videoUrl,
    operationName,
    model,
  };
}

/**
 * Backward compatibility fallback function (if needed)
 */
export async function createVeoMotionVideoBlob(
  prompt: string,
  aspectRatio: '9:16' | '16:9' = '9:16',
  baseImageUrl?: string
): Promise<string> {
  const result = await generateVeoVideoCutaway({
    prompt,
    aspectRatio,
    startingImageUrl: baseImageUrl,
  });
  return result.videoUrl;
}
