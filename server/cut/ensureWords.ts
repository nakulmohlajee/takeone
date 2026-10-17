/**
 * Make sure every filmed take has real word timings before the Director Cut compiles.
 *
 * Cleanup cuts, captions, text pops and inserts are all placed on word timestamps. Takes whose
 * words came from live captions (rough, shifted) or that have no words at all are re-transcribed
 * from their durable gs:// copy with Cloud Speech (Chirp), which has no request-size limit.
 */
import type { Project, Scene } from '../../src/types/director';
import { transcribeWithWords, type SpeechSegment, type SpeechWord } from '../speech/chirp';

export type RetranscribedTake = {
  words?: SpeechWord[];
  transcriptSegments?: SpeechSegment[];
  transcript?: string;
  wordsSource?: 'stt';
  /** Corrected take length when the saved one was shorter than the speech in it. */
  recordedDuration?: number;
};

/** Seconds kept after the last spoken word when the saved take length was too short. */
const TAIL_AFTER_LAST_WORD = 0.6;

const CONCURRENCY = 3;
const PER_TAKE_TIMEOUT_MS = 120_000;

/** True when this take's word timings can't be trusted for cutting. */
export function needsRetranscription(scene: Scene): boolean {
  if (scene.filmedBy !== 'user') return false;
  const uri = scene.gcsObjectPath || '';
  if (!uri.startsWith('gs://')) return false;
  if (!scene.words?.length) return true;
  return scene.wordsSource !== 'stt';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Re-transcribe untrusted takes. Returns the patched project plus a map of what changed
 * (so the client can store it and skip this next time).
 */
export async function ensureTakeWords(project: Project): Promise<{
  project: Project;
  updates: Record<string, RetranscribedTake>;
}> {
  const todo = (project.scenes || []).filter(needsRetranscription);
  const updates: Record<string, RetranscribedTake> = {};
  if (!todo.length) return fixTakeLengths(project, updates);

  const languageCode = project.spokenLanguage || project.creativeBrief?.spokenLanguage;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const scene = queue.shift()!;
      try {
        const r = await withTimeout(
          transcribeWithWords({
            gcsUri: scene.gcsObjectPath!,
            languageCode,
            durationSec: scene.recordedDuration || undefined,
          }),
          PER_TAKE_TIMEOUT_MS
        );
        if (r.words.length) {
          updates[scene.id] = {
            words: r.words,
            transcriptSegments: r.segments,
            transcript: r.transcript,
            wordsSource: 'stt',
          };
        }
      } catch (err: any) {
        // compile warns about takes left without words; keep the reason in the logs.
        console.warn(`[ensure-words] ${scene.id} failed:`, err?.message || err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  console.log(`[ensure-words] re-transcribed ${Object.keys(updates).length}/${todo.length} take(s)`);

  return fixTakeLengths(project, updates);
}

/**
 * A take's saved length can be wrong (an old recorder counted 1s ticks, which a busy page delays —
 * a 46s take was saved as 29s and its last 16s were cut). The speech itself is the proof: the take
 * is at least as long as its last spoken word. Applies pending word updates first.
 */
function fixTakeLengths(
  project: Project,
  updates: Record<string, RetranscribedTake>
): { project: Project; updates: Record<string, RetranscribedTake> } {
  const scenes = project.scenes.map((s) => {
    const merged = updates[s.id] ? { ...s, ...updates[s.id] } : s;
    if (merged.filmedBy !== 'user' || !merged.words?.length) return merged;
    const lastEnd = Math.max(...merged.words.map((w) => w.end || 0));
    const saved = Number(merged.recordedDuration) || 0;
    if (lastEnd + 0.05 <= saved) return merged;
    const fixed = Math.round((lastEnd + TAIL_AFTER_LAST_WORD) * 100) / 100;
    console.warn(`[ensure-words] ${merged.id}: saved length ${saved}s < last word ${lastEnd}s — using ${fixed}s`);
    updates[s.id] = { ...(updates[s.id] || {}), recordedDuration: fixed };
    return { ...merged, recordedDuration: fixed };
  });
  return { project: { ...project, scenes }, updates };
}
