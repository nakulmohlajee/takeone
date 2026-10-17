import type { FactCheckedClaim } from '../types/director';

export type TakeWord = { w: string; start: number; end: number; conf?: number };

export function sceneHasTake(scene: {
  gcsObjectPath?: string;
  userRecordedVideoUrl?: string;
  recordedDuration?: number;
  captureStatus?: string;
}): boolean {
  if (!scene) return false;
  if (scene.captureStatus === 'skipped') return false;
  // Durable cloud media is the source of truth
  const gcs = String(scene.gcsObjectPath || '').trim();
  if (gcs && !gcs.startsWith('blob:') && !gcs.startsWith('data:')) return true;
  // In-session: recordedDuration marks a kept take before GCS upload finishes
  if (typeof scene.recordedDuration === 'number' && scene.recordedDuration > 0) return true;
  const rec = String(scene.userRecordedVideoUrl || '').trim();
  if (rec && !rec.startsWith('blob:') && !rec.startsWith('data:')) return true;
  return false;
}

/** True when durable cloud media is attached (badge / export gate). */
export function sceneHasDurableMedia(scene: { gcsObjectPath?: string }): boolean {
  const gcs = String(scene?.gcsObjectPath || '').trim();
  return Boolean(gcs && !gcs.startsWith('blob:') && !gcs.startsWith('data:'));
}

export async function analyzeTakeClaims(opts: {
  projectTitle?: string;
  gcsUri?: string;
  mimeType?: string;
  transcript?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  /** Word timings already known for this take (kept when no re-transcription happens) */
  words?: TakeWord[];
  /** BCP-47 / short language code for Chirp (e.g. en-US, hi) */
  languageCode?: string;
  blob?: Blob;
}): Promise<{
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: TakeWord[];
  claims: FactCheckedClaim[];
}> {
  let transcript = (opts.transcript || '').trim();
  let segments = opts.segments?.filter((s) => s.text?.trim()) || [];
  let words: TakeWord[] = opts.words?.filter((w) => w?.w) || [];

  if (!transcript && opts.gcsUri) {
    try {
      const txRes = await fetch('/api/transcribe-gcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gcsUri: opts.gcsUri,
          mimeType: opts.mimeType,
          languageCode: opts.languageCode,
        }),
      });
      const tx = await txRes.json();
      transcript = tx.transcript || tx.fullTranscript || '';
      segments = tx.segments || tx.transcriptSegments || [];
      words = Array.isArray(tx.words) ? tx.words : [];
    } catch {
      /* fall through */
    }
  }

  // Inline base64 only for small takes — Cloud Run rejects requests over 32 MB.
  if (!transcript && opts.blob && opts.blob.size <= 20 * 1024 * 1024) {
    try {
      const reader = new FileReader();
      const audioBase64 = await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string)?.split(',')[1] || '');
        reader.readAsDataURL(opts.blob!);
      });
      if (audioBase64) {
        const res = await fetch('/api/transcribe-audio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64,
            mimeType: opts.blob.type || opts.mimeType || 'audio/webm',
            languageCode: opts.languageCode,
          }),
        });
        const data = await res.json();
        if (data?.transcript || data?.fullTranscript) {
          transcript = data.transcript || data.fullTranscript;
          segments = data.segments || data.transcriptSegments || [];
          words = Array.isArray(data.words) ? data.words : [];
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!transcript) {
    return { transcript: '', segments: [], words: [], claims: [] };
  }

  try {
    const fcRes = await fetch('/api/fact-check-claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments,
        fullTranscript: transcript,
        projectTitle: opts.projectTitle || '',
      }),
    });
    const fc = await fcRes.json();
    return { transcript, segments, words, claims: fc.claims || [] };
  } catch {
    return { transcript, segments, words, claims: [] };
  }
}
