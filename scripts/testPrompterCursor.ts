/**
 * Runnable unit test for advanceWordCursor fuzzy resync.
 * Usage: npx tsx scripts/testPrompterCursor.ts
 */
import {
  advanceWordCursor,
  editDistance,
  tokenizeSpeech,
  tokensMatch,
} from '../src/utils/teleprompter';

const VEDIC_SCRIPT =
  "I hit the weirdest, most random emotional dip yesterday. Total funk out of nowhere, until I actually checked my transits. Normally, I'd just spiral or blame it on bad coffee, but I opened this app called Vedic Journey. All you do is drop a quick, two-sentence vent about how you're feeling, and it maps your mood right onto where the planets are moving in your Vedic chart. It showed the moon was crossing my 8th house, which triggers that exact heavy feeling. Just knowing there was an actual reason stopped my spiral right in its tracks. If your emotions feel completely unhinged this week, grab Vedic Journey. It's free on the App Store and Google Play.";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function chunkWords(text: string, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(' '));
  }
  return chunks;
}

/** Spoken stream with brand mishear, dropped words, and laggy phrasing. */
function buildNoisySpoken(): string {
  return [
    'I hit the weirdest most random emotional dip yesterday',
    // dropped "Total"
    'funk out of nowhere until I actually checked my transits',
    "Normally I'd just spiral or blame it on bad coffee",
    // brand mishear: Vedic Journey -> medic journey; dropped "called"
    'but I opened this app medic journey',
    // lag / filler + dropped "All you do is"
    'um drop a quick two-sentence vent about how you are feeling',
    'and it maps your mood right onto where the planets are moving in your Vedic chart',
    // dropped "It showed the"
    'moon was crossing my 8th house which triggers that exact heavy feeling',
    'Just knowing there was an actual reason stopped my spiral right in its tracks',
    'If your emotions feel completely unhinged this week grab',
    // second brand mishear
    'medic journey',
    "It's free on the App Store and Google Play",
  ].join(' ');
}

function main(): void {
  // --- helpers ---
  assert(editDistance('vedic', 'medic') === 1, 'editDistance medic↔vedic');
  assert(tokensMatch('medic', 'vedic'), 'tokensMatch recovers brand mishear');
  assert(tokenizeSpeech("I'd on my").includes('on'), 'tokenizeSpeech keeps length>=2');
  assert(!tokenizeSpeech('a I').length, 'tokenizeSpeech drops length-1');

  const scriptTokens = tokenizeSpeech(VEDIC_SCRIPT);
  assert(scriptTokens.length > 80, `expected substantial script tokens, got ${scriptTokens.length}`);

  const trueSpoken = VEDIC_SCRIPT; // ideal recognition → true end position
  const trueEnd = tokenizeSpeech(trueSpoken).length;
  // True position after full correct speech should be ~all script tokens
  const idealCursor = advanceWordCursor(scriptTokens, trueSpoken, 0, { logStall: false });
  assert(
    idealCursor >= scriptTokens.length - 2,
    `ideal cursor should reach end: got ${idealCursor}/${scriptTokens.length}`
  );

  // --- noisy stream in chunks (simulates live STT) ---
  const noisy = buildNoisySpoken();
  const chunks = chunkWords(noisy, 6);
  let cursor = 0;
  let accum = '';
  let maxLagBehindTrue = 0;

  // Approximate "true position" as how far an ideal tokenizer would be
  // after the same fraction of the noisy stream (aligned by spoken token count).
  const noisyTokens = tokenizeSpeech(noisy);
  const idealTokens = tokenizeSpeech(trueSpoken);

  for (const chunk of chunks) {
    accum = `${accum} ${chunk}`.replace(/\s+/g, ' ').trim();
    const prev = cursor;
    cursor = advanceWordCursor(scriptTokens, accum, cursor, { logStall: false });
    assert(cursor >= prev, `cursor never moves backward (${prev} → ${cursor})`);

    const spokenCount = tokenizeSpeech(accum).length;
    // Map spoken progress onto ideal script progress
    const frac = Math.min(1, spokenCount / Math.max(1, noisyTokens.length));
    const truePos = Math.min(scriptTokens.length, Math.round(frac * idealTokens.length));
    const lag = truePos - cursor;
    if (lag > maxLagBehindTrue) maxLagBehindTrue = lag;
    assert(
      lag <= 2,
      `cursor stalled >2 behind true pos: cursor=${cursor} truePos=${truePos} lag=${lag} after "${chunk}"`
    );
  }

  assert(
    maxLagBehindTrue <= 2,
    `max lag behind true position was ${maxLagBehindTrue} (must be ≤ 2)`
  );
  assert(
    cursor >= trueEnd - 2,
    `final cursor=${cursor} more than 2 behind trueEnd=${trueEnd}`
  );

  // Late anchors still reachable after brand mishears / drops
  const lateAnchor = scriptTokens.lastIndexOf('google');
  assert(lateAnchor >= 0, 'script has Google Play tokens');
  assert(
    cursor >= lateAnchor - 2,
    `after full stream cursor=${cursor} should be within 2 of google@${lateAnchor}`
  );

  // Brand-local recovery: after only the first Vedic Journey mention (as medic)
  const upToBrand =
    "I hit the weirdest most random emotional dip yesterday Total funk out of nowhere until I actually checked my transits Normally I'd just spiral or blame it on bad coffee but I opened this app medic journey";
  const brandCursor = advanceWordCursor(scriptTokens, upToBrand, 0, { logStall: false });
  const journeyIdx = scriptTokens.findIndex(
    (t, i) => t === 'journey' && i > 20 && scriptTokens[i - 1] === 'vedic'
  );
  assert(journeyIdx >= 0, 'found first vedic journey in script');
  assert(
    brandCursor >= journeyIdx + 1 - 2,
    `after brand mishear cursor=${brandCursor} should be within 2 of journey@${journeyIdx}`
  );

  console.log('OK: prompter cursor tests passed');
  console.log(
    `  scriptTokens=${scriptTokens.length} finalCursor=${cursor} maxLag=${maxLagBehindTrue} brandCursor=${brandCursor}`
  );
}

main();
