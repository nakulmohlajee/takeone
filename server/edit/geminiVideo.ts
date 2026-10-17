/**
 * Gemini Files API helpers for native video understanding.
 * Upload → wait ACTIVE → use as fileData part → optional delete.
 */
import fs from 'fs/promises';

export type GeminiAi = {
  files?: {
    upload: (params: { file: string | Blob; config?: { mimeType?: string; displayName?: string } }) => Promise<{
      name?: string;
      uri?: string;
      mimeType?: string;
      state?: string;
    }>;
    get: (params: { name: string }) => Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }>;
    delete: (params: { name: string }) => Promise<unknown>;
  };
  models: {
    generateContent: (opts: any) => Promise<{ text?: string }>;
  };
};

export async function waitForFileActive(
  ai: GeminiAi,
  fileName: string,
  timeoutMs = 120_000
): Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }> {
  if (!ai.files?.get) throw new Error('Gemini files API unavailable');
  const start = Date.now();
  let file = await ai.files.get({ name: fileName });
  while (file.state === 'PROCESSING' || file.state === 'STATE_PROCESSING') {
    if (Date.now() - start > timeoutMs) throw new Error(`File ${fileName} still PROCESSING after timeout`);
    await new Promise((r) => setTimeout(r, 1500));
    file = await ai.files.get({ name: fileName });
  }
  if (file.state && file.state !== 'ACTIVE' && file.state !== 'STATE_ACTIVE') {
    throw new Error(`File ${fileName} ended in state ${file.state}`);
  }
  return file;
}

export async function uploadVideoForGemini(
  ai: GeminiAi,
  localPath: string,
  mimeType: string,
  displayName: string
): Promise<{
  name: string;
  uri: string;
  mimeType: string;
  cleanup: () => Promise<void>;
  uploadMs: number;
  waitActiveMs: number;
}> {
  if (!ai.files?.upload) throw new Error('Gemini files.upload not available');

  // Ensure file exists and is non-empty
  const stat = await fs.stat(localPath);
  if (!stat.size) throw new Error('Empty video file');

  const tUpload = Date.now();
  const uploaded = await ai.files.upload({
    file: localPath,
    config: { mimeType, displayName },
  });
  const uploadMs = Date.now() - tUpload;
  if (!uploaded?.name) throw new Error('Upload returned no file name');

  const tWait = Date.now();
  const ready = await waitForFileActive(ai, uploaded.name);
  const waitActiveMs = Date.now() - tWait;
  const uri = ready.uri || uploaded.uri;
  if (!uri) throw new Error('Uploaded file has no uri');

  const name = ready.name || uploaded.name;
  return {
    name,
    uri,
    mimeType: ready.mimeType || uploaded.mimeType || mimeType,
    uploadMs,
    waitActiveMs,
    cleanup: async () => {
      try {
        if (ai.files?.delete && name) await ai.files.delete({ name });
      } catch {
        /* ignore */
      }
    },
  };
}

export function videoFilePart(
  uri: string,
  mimeType: string,
  mediaResolution?: string
) {
  const part: {
    fileData: { fileUri: string; mimeType: string };
    mediaResolution?: { level: string };
  } = {
    fileData: {
      fileUri: uri,
      mimeType,
    },
  };
  if (mediaResolution) {
    part.mediaResolution = { level: mediaResolution };
  }
  return part;
}

/** Prefer video/* from path extension */
export function mimeForVideoPath(p: string): string {
  if (/\.mp4$/i.test(p)) return 'video/mp4';
  if (/\.webm$/i.test(p)) return 'video/webm';
  if (/\.mov$/i.test(p)) return 'video/quicktime';
  return 'video/mp4';
}
