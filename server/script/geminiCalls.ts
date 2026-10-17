import type { GoogleGenAI } from '@google/genai';

export type StreamLimits = {
  label: string;
  /** Abort if no text arrives within this window (covers queueing + thinking). */
  firstChunkMs: number;
  /** Abort if the stream goes quiet this long after it started producing text. */
  idleMs: number;
  /** Hard ceiling for the whole call. */
  totalMs: number;
  signal?: AbortSignal;
  onFirstChunk?: () => void;
};

/**
 * generateContentStream with inactivity timeouts instead of one fixed deadline, so a long
 * structured plan that is still streaming is never killed just because it is long.
 */
export async function streamGeminiText(
  ai: GoogleGenAI,
  params: { model: string; contents: string; config?: Record<string, unknown> },
  limits: StreamLimits
): Promise<string> {
  const ctrl = new AbortController();
  let reason = '';
  const abort = (why: string) => {
    if (ctrl.signal.aborted) return;
    reason = why;
    ctrl.abort();
  };
  const onOuterAbort = () => abort('cancelled');
  if (limits.signal?.aborted) throw new Error(`${limits.label} cancelled`);
  limits.signal?.addEventListener('abort', onOuterAbort);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, why: string) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort(why), ms);
  };
  const totalTimer = setTimeout(() => abort(`exceeded ${limits.totalMs}ms`), limits.totalMs);
  arm(limits.firstChunkMs, `no response in ${limits.firstChunkMs}ms`);

  let text = '';
  let started = false;
  try {
    const stream = await ai.models.generateContentStream({
      model: params.model,
      contents: params.contents,
      config: { ...(params.config || {}), abortSignal: ctrl.signal },
    });
    for await (const chunk of stream) {
      if (ctrl.signal.aborted) break;
      const piece = chunk?.text;
      if (piece) {
        text += piece;
        if (!started) {
          started = true;
          limits.onFirstChunk?.();
        }
      }
      arm(limits.idleMs, `stalled for ${limits.idleMs}ms`);
    }
    if (ctrl.signal.aborted) throw new Error(`${limits.label} ${reason || 'aborted'}`);
    return text;
  } catch (err: any) {
    if (ctrl.signal.aborted) throw new Error(`${limits.label} ${reason || 'aborted'}`);
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    limits.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Run `call` on models[0]; if it has not started responding after `hedgeAfterMs` (or fails),
 * start the next model in parallel. First success wins and the others are aborted.
 */
export function hedgedCall<T>(
  models: string[],
  call: (model: string, signal: AbortSignal, onFirstChunk: () => void) => Promise<T>,
  opts: { hedgeAfterMs: number; label: string }
): Promise<{ value: T; model: string }> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const errors: string[] = [];
    let nextIdx = 0;
    let active = 0;
    let settled = false;

    const launchNext = (): boolean => {
      if (settled || nextIdx >= models.length) return false;
      const model = models[nextIdx++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      active++;
      let hedged = false;
      const hedgeTimer = setTimeout(() => {
        if (settled || hedged) return;
        hedged = true;
        if (nextIdx < models.length) {
          console.log(`[gemini] ${opts.label}: ${model} slow to respond — hedging with ${models[nextIdx]}`);
          launchNext();
        }
      }, opts.hedgeAfterMs);
      const responded = () => {
        hedged = true;
        clearTimeout(hedgeTimer);
      };
      call(model, ctrl.signal, responded).then(
        (value) => {
          clearTimeout(hedgeTimer);
          active--;
          if (settled) return;
          settled = true;
          controllers.forEach((c) => c !== ctrl && c.abort());
          resolve({ value, model });
        },
        (err: any) => {
          clearTimeout(hedgeTimer);
          active--;
          if (settled) return;
          errors.push(`${model}: ${err?.message || err}`);
          console.warn(`[gemini] ${opts.label} failed on ${model}:`, err?.message || err);
          if (active === 0 && !launchNext()) {
            settled = true;
            reject(new Error(errors.join(' | ')));
          }
        }
      );
      return true;
    };

    launchNext();
  });
}
