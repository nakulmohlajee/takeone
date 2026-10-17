/**
 * 14-day lifecycle on temporary prefixes only. Never deletes source/.
 */
import { GCS_BUCKET, getStorage } from './store';

const TEMP_PREFIXES = ['edits/', 'renders/', 'tmp/'];

export async function ensureTempLifecycle(): Promise<void> {
  const storage = getStorage();
  if (!storage || !GCS_BUCKET) return;
  try {
    const bucket = storage.bucket(GCS_BUCKET);
    const [meta] = await bucket.getMetadata();
    const existing = Array.isArray(meta.lifecycle?.rule) ? meta.lifecycle.rule : [];
    const prefixOf = (r: any): string => {
      const raw = r?.condition?.matchesPrefix;
      if (Array.isArray(raw)) return String(raw[0] || '');
      return String(raw || '');
    };
    const already = TEMP_PREFIXES.every((prefix) =>
      existing.some(
        (r: any) => r?.action?.type === 'Delete' && r?.condition?.age === 14 && prefixOf(r) === prefix
      )
    );
    if (already) {
      console.log('[lifecycle] 14-day delete already set on edits/ renders/ tmp/');
      return;
    }
    const kept = existing.filter((r: any) => !TEMP_PREFIXES.includes(prefixOf(r)));
    const next = [
      ...kept,
      ...TEMP_PREFIXES.map((prefix) => ({
        action: { type: 'Delete' as const },
        condition: { age: 14, matchesPrefix: [prefix] },
      })),
    ];
    await bucket.setMetadata({ lifecycle: { rule: next } });
    console.log('[lifecycle] applied 14-day delete on edits/ renders/ tmp/ (source/ kept)');
  } catch (e: any) {
    console.warn('[lifecycle] skipped:', e?.message || e);
  }
}
