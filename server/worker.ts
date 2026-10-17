/**
 * Cloud Run Job / local worker entry.
 *   npx tsx server/worker.ts --kind=render --id=<jobId>
 *   npx tsx server/worker.ts --kind=director-edit --id=<jobId>
 *   npx tsx server/worker.ts --kind=matte --id=<jobId>
 *   npx tsx server/worker.ts --kind=reclaim
 */
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function getAiClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || '',
    httpOptions: { headers: { 'User-Agent': 'takeone-worker' } },
  });
}

async function main() {
  const kind = arg('kind') || '';
  const id = arg('id');
  console.log(`[worker] start kind=${kind} id=${id || '-'} pid=${process.pid}`);

  if (kind === 'reclaim') {
    const { reclaimOrphans } = await import('./jobs/reclaim');
    await reclaimOrphans();
    return;
  }

  if (kind === 'render') {
    if (!id) throw new Error('render worker requires --id');
    const { executePersistedRender } = await import('./render');
    await executePersistedRender(id);
    return;
  }

  if (kind === 'matte') {
    if (!id) throw new Error('matte worker requires --id');
    const { executeMatteJob } = await import('./jobs/matte');
    await executeMatteJob(id);
    return;
  }

  if (kind === 'director-edit') {
    if (!id) throw new Error('director-edit worker requires --id');
    const { executePersistedDirectorEdit } = await import('./edit/directorEditJobs');
    await executePersistedDirectorEdit(getAiClient(), id);
    return;
  }

  throw new Error(`Unknown worker kind: ${kind || '(missing)'}`);
}

main()
  .then(() => {
    console.log('[worker] done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[worker] failed:', err);
    process.exit(1);
  });
