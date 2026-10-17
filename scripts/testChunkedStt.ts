/**
 * recognizeInChunks: pieces overlap, but every word appears once and in order.
 * Usage: npx tsx scripts/testChunkedStt.ts <long.flac>
 */
import { recognizeInChunks } from '../server/speech/chirp';

// Fake recognizer: one "word" at every whole second of the piece it is given (pieces are ≤52 s).
let calls = 0;
const fake = {
  recognize: async () => {
    calls++;
    const words = Array.from({ length: 52 }, (_, i) => ({
      word: `w${i}`,
      startOffset: { seconds: i },
      endOffset: { seconds: i, nanos: 400_000_000 },
    }));
    return [{ results: [{ alternatives: [{ transcript: 'x', words }], languageCode: 'en-us' }] }];
  },
};

(async () => {
  const r = await recognizeInChunks(fake, 'rec', {}, process.argv[2]);
  if (!r) throw new Error('FAIL: expected chunking');
  const starts = r.words.map((w) => w.start);
  const dupes = starts.filter((v, i) => i && Math.abs(v - starts[i - 1]) < 0.5).length;
  const sorted = starts.every((v, i) => !i || v >= starts[i - 1]);
  console.log({ calls, words: r.words.length, first: starts[0], last: starts.at(-1), dupes, sorted });
  if (dupes || !sorted || starts[0] !== 0) throw new Error('FAIL: overlap produced duplicates or gaps');
  console.log('PASS chunked STT merge');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
