/**
 * Per-job cost / usage log. Server-side only (edits/{jobId}/cost.jsonl).
 */
import { GCS_BUCKET, getStorage, editsPath } from './store';

export type CostEvent = {
  ts: number;
  jobId: string;
  kind: 'director-edit' | 'render';
  event: string;
  sourceGb?: number;
  proxyGb?: number;
  geminiCalls?: number;
  observeWallMs?: number;
  renderSeconds?: number;
  criticCalls?: number;
  extra?: Record<string, unknown>;
};

export async function appendCost(event: CostEvent): Promise<void> {
  const line = JSON.stringify(event);
  console.log(`[COST] ${line}`);
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return;
  const objectPath = editsPath(event.jobId, 'cost.jsonl');
  try {
    const file = storage.bucket(GCS_BUCKET).file(objectPath);
    let prev = '';
    try {
      const [buf] = await file.download();
      prev = buf.toString();
    } catch {
      prev = '';
    }
    await file.save(`${prev}${line}\n`, {
      contentType: 'application/x-ndjson',
      resumable: false,
      metadata: { metadata: { 'takeone-role': 'edit' } },
    });
  } catch (e: any) {
    console.warn('[COST] persist failed:', e?.message || e);
  }
}
