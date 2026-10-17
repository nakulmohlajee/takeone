/**
 * Stage-keyed caches. Changing Stage C prompt does not bust Observe or Understand.
 */
import { createHash } from 'crypto';
import { loadJson, saveJson } from './store';

export const UNDERSTAND_PROMPT_VERSION = 'b2';
export const DIRECT_PROMPT_VERSION = 'c2';

function hashKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function understandCacheKey(opts: {
  observeHash: string;
  style: string;
  targetDuration: number;
  aspectRatio: string;
  editPolicy?: string;
}): string {
  return hashKey([
    'understand',
    UNDERSTAND_PROMPT_VERSION,
    opts.observeHash,
    opts.style,
    opts.targetDuration,
    opts.aspectRatio,
    opts.editPolicy || 'directed',
  ]);
}

export function directCacheKey(opts: {
  observeHash: string;
  understandHash: string;
  style: string;
  editPolicy?: string;
}): string {
  return hashKey([
    'direct',
    DIRECT_PROMPT_VERSION,
    opts.observeHash,
    opts.understandHash,
    opts.style,
    opts.editPolicy || 'directed',
  ]);
}

export function observeOutputsHash(footageIntel: unknown): string {
  return hashKey(['observe-out', footageIntel]);
}

export function understandingHash(understanding: unknown): string {
  return hashKey(['understand-out', understanding]);
}

export async function readStageCache<T>(kind: 'understand' | 'direct', key: string): Promise<T | null> {
  return loadJson<T>(`analysis/${kind}/${key}.json`);
}

export async function writeStageCache(kind: 'understand' | 'direct', key: string, data: unknown): Promise<void> {
  await saveJson(`analysis/${kind}/${key}.json`, data, 'analysis');
}
