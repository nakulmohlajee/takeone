/**
 * Warm matting service (Cloud Run service, min 1 instance, CPU always on): the RVM model is
 * loaded once, so a matte job starts in a second instead of waiting for a job container to boot.
 *   node dist-worker/worker.mjs --kind=serve
 * POST /matte {id} → runs the job, answering when done (429 when busy) (status in mattes/<id>/status.json as usual).
 * Private: only callers with run.invoker (the API service account) can reach it.
 */
import express from 'express';
import { executeMatteJob } from '../jobs/matte';
import { warmUp } from './rvm';

export async function serveMatte(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  let busy = 0;

  app.get('/', (_req, res) => res.json({ ok: true, busy }));

  app.post('/matte', (req, res) => {
    const id = String(req.body?.id || '').replace(/[^\w-]/g, '');
    if (!id) return res.status(400).json({ error: 'id required' });
    // One take at a time uses every core; a second one goes to a Cloud Run Job instead.
    if (busy > 0) return res.status(429).json({ error: 'busy' });
    busy++;
    // The request stays open until the job is done: Cloud Run gives an instance with an active
    // request its full CPU, and the caller only waits a few seconds for a 429 anyway.
    executeMatteJob(id)
      .then(() => res.json({ ok: true }))
      .catch((err) => {
        console.error(`[matte-service] ${id} failed:`, err?.message || err);
        res.status(500).json({ error: String(err?.message || err).slice(0, 200) });
      })
      .finally(() => busy--);
  });

  const port = Number(process.env.PORT) || 8080;
  await new Promise<void>((resolve) => app.listen(port, resolve));
  console.log(`[matte-service] listening on ${port}`);
  await warmUp().then(
    () => console.log('[matte-service] model loaded'),
    (e) => console.warn('[matte-service] warm-up failed:', e?.message || e)
  );
  await new Promise(() => {}); // serve until the instance is stopped
}
