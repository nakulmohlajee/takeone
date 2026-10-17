/**
 * Smart teleprompter helpers — phrase units, pause markers, speech pace.
 */

export type PrompterUnit = {
  text: string;
  /** Intentional pause after this unit (seconds) */
  pauseAfter: number;
  isPauseOnly: boolean;
};

/** Split script into speakable phrases; honor [pause], [pause:2s], ellipses, newlines. */
export function splitIntoPhraseUnits(text: string): PrompterUnit[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // Replace pause markers with a sentinel the splitter can see
  let work = raw
    .replace(/\[pause\s*:?\s*(\d+(?:\.\d+)?)\s*s?\]/gi, '\n<<PAUSE:$1>>\n')
    .replace(/\[pause\]/gi, '\n<<PAUSE:0.8>>\n')
    .replace(/\.\.\.|…/g, '\n<<PAUSE:0.6>>\n');

  // Split on newlines and sentence boundaries
  const pieces = work
    .split(/\n+|(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: PrompterUnit[] = [];
  for (const piece of pieces) {
    const pauseMatch = piece.match(/^<<PAUSE:(\d+(?:\.\d+)?)>>$/);
    if (pauseMatch) {
      const sec = parseFloat(pauseMatch[1]) || 0.8;
      if (units.length) {
        units[units.length - 1].pauseAfter = Math.max(units[units.length - 1].pauseAfter, sec);
      } else {
        units.push({ text: '…', pauseAfter: sec, isPauseOnly: true });
      }
      continue;
    }

    // Further split long clauses on commas when long
    const clauses =
      piece.length > 70
        ? piece.split(/(?<=[,;:])\s+/).map((c) => c.trim()).filter(Boolean)
        : [piece];

    for (const clause of clauses) {
      const cleaned = clause.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      const pauseAfter = /[.!?]$/.test(cleaned) ? 0.5 : /[,;:]$/.test(cleaned) ? 0.35 : 0.25;
      units.push({ text: cleaned, pauseAfter, isPauseOnly: false });
    }
  }

  return units;
}

export type PaceStatus = 'behind' | 'on_pace' | 'ahead';

/** Keep short function words (I'd, on, my, it) — length >= 2. */
export function tokenizeSpeech(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/** Levenshtein distance — exported for cursor tests / brand-mishear checks. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export function tokensMatch(spoken: string, expected: string): boolean {
  if (spoken === expected) return true;
  if (expected.length > 4 && spoken.startsWith(expected.slice(0, 4))) return true;
  if (spoken.length > 4 && expected.startsWith(spoken.slice(0, 4))) return true;
  // Brand / STT mishears: "medic"↔"vedic", "journey" still exact
  const maxLen = Math.max(spoken.length, expected.length);
  if (spoken.length >= 4 && expected.length >= 4) {
    const dist = editDistance(spoken, expected);
    if (dist <= 1) return true;
    if (maxLen >= 6 && dist <= 2) return true;
  }
  return false;
}

/** Flatten speakable phrase units into ordered script tokens for the word cursor. */
export function scriptTokensFromUnits(units: PrompterUnit[]): string[] {
  return units.filter((u) => !u.isPauseOnly).flatMap((u) => tokenizeSpeech(u.text));
}

export const PROMPTER_RESYNC_SPOKEN = 5;
export const PROMPTER_SCRIPT_WINDOW = 25;
export const PROMPTER_STALL_SPOKEN_TOKENS = 5;

/**
 * Align the last few spoken tokens against a ~25-word script window starting at `cursor`.
 * Returns a new cursor (end of best match) or `cursor` if no confident forward sync.
 * Never moves backward.
 */
export function fuzzyResyncCursor(
  scriptTokens: string[],
  spokenTokens: string[],
  cursor: number,
  spokenWindow = PROMPTER_RESYNC_SPOKEN,
  scriptWindow = PROMPTER_SCRIPT_WINDOW
): number {
  if (!scriptTokens.length || !spokenTokens.length) return cursor;
  const c = Math.max(0, Math.min(cursor, scriptTokens.length));
  if (c >= scriptTokens.length) return c;

  const needleLen = Math.min(Math.max(4, spokenWindow), 6, spokenTokens.length);
  const needle = spokenTokens.slice(-needleLen);
  if (needle.length < 3) return c;

  const windowEnd = Math.min(scriptTokens.length, c + scriptWindow);
  const haystack = scriptTokens.slice(c, windowEnd);
  if (!haystack.length) return c;

  let bestHits = 0;
  let bestEnd = c;
  const minHits = Math.max(2, Math.ceil(needle.length * 0.6));

  for (let start = 0; start < haystack.length; start++) {
    let hi = start;
    let hits = 0;
    for (const sp of needle) {
      let found = -1;
      const gapLimit = Math.min(haystack.length, hi + 3);
      for (let j = hi; j < gapLimit; j++) {
        if (tokensMatch(sp, haystack[j])) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        hits += 1;
        hi = found + 1;
      }
    }
    if (hits > bestHits && hits >= minHits) {
      bestHits = hits;
      bestEnd = c + hi;
    }
  }

  return Math.max(c, Math.min(scriptTokens.length, bestEnd));
}

/** Max single-token skip during the greedy walk (larger skips use fuzzyResync). */
export const PROMPTER_GREEDY_LOOKAHEAD = 4;

/**
 * Incremental word-cursor advance with fuzzy resync.
 * Rematches the full spoken stream from the start, then clamps so the cursor
 * never moves backward from `prevCursor`. Allows forward jumps when the speaker
 * skips ahead. Logs stall telemetry when speech continues without progress.
 */
export function advanceWordCursor(
  scriptTokens: string[],
  spokenText: string,
  prevCursor = 0,
  opts?: { stallThreshold?: number; logStall?: boolean }
): number {
  if (!scriptTokens.length) return 0;
  const spokenTokens = tokenizeSpeech(spokenText);
  const floor = Math.max(0, Math.min(prevCursor, scriptTokens.length));
  if (!spokenTokens.length) return floor;

  let c = 0;
  let lastAdvanceAt = -1;
  let consecutiveMisses = 0;
  const stallThreshold = opts?.stallThreshold ?? PROMPTER_STALL_SPOKEN_TOKENS;
  const shouldLog = opts?.logStall !== false;

  for (let si = 0; si < spokenTokens.length; si++) {
    if (c >= scriptTokens.length) break;
    const spoken = spokenTokens[si];

    if (tokensMatch(spoken, scriptTokens[c])) {
      c += 1;
      lastAdvanceAt = si;
      consecutiveMisses = 0;
      continue;
    }

    // Small forward jump (dropped / skipped words)
    let jump = -1;
    const lookLimit = Math.min(PROMPTER_GREEDY_LOOKAHEAD, scriptTokens.length - c);
    for (let look = 1; look <= lookLimit; look++) {
      if (tokensMatch(spoken, scriptTokens[c + look])) {
        jump = look;
        break;
      }
    }
    if (jump >= 0) {
      c += jump + 1;
      lastAdvanceAt = si;
      consecutiveMisses = 0;
      continue;
    }

    consecutiveMisses += 1;

    // Fuzzy resync: last 4–6 spoken tokens vs ~25-word script window
    if (consecutiveMisses >= 2 && si >= 3) {
      const resynced = fuzzyResyncCursor(
        scriptTokens,
        spokenTokens.slice(0, si + 1),
        c
      );
      if (resynced > c) {
        c = resynced;
        lastAdvanceAt = si;
        consecutiveMisses = 0;
      }
    }
  }

  const afterResync = fuzzyResyncCursor(scriptTokens, spokenTokens, c);
  if (afterResync > c) {
    c = afterResync;
    lastAdvanceAt = spokenTokens.length - 1;
    consecutiveMisses = 0;
  }

  c = Math.max(floor, Math.min(scriptTokens.length, c));

  const spokenSinceAdvance =
    lastAdvanceAt < 0 ? spokenTokens.length : spokenTokens.length - 1 - lastAdvanceAt;
  if (
    shouldLog &&
    spokenTokens.length >= stallThreshold &&
    spokenSinceAdvance >= stallThreshold &&
    c < scriptTokens.length
  ) {
    console.log(`[PROMPTER] stall cursor=${c} spokenTokens=${spokenTokens.length}`);
  }

  return c;
}

/** Phrase index whose tokens contain `wordCursor` (cursor = count of matched script tokens). */
export function phraseIndexFromWordCursor(units: PrompterUnit[], wordCursor: number): number {
  if (!units.length) return 0;
  let tokenPos = 0;
  let lastSpeakable = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.isPauseOnly) {
      if (wordCursor >= tokenPos) lastSpeakable = i;
      continue;
    }
    const n = tokenizeSpeech(u.text).length;
    if (wordCursor < tokenPos + n) return i;
    tokenPos += n;
    lastSpeakable = i;
    // Finished this phrase — next unit is the derived target (soft dwell may delay UI)
    if (wordCursor >= tokenPos && i + 1 < units.length) {
      lastSpeakable = i + 1;
    }
  }
  return Math.min(lastSpeakable, units.length - 1);
}

/** Word-cursor position at the start of phrase `phraseIndex`. */
export function wordCursorAtPhraseStart(units: PrompterUnit[], phraseIndex: number): number {
  let c = 0;
  const limit = Math.max(0, Math.min(phraseIndex, units.length));
  for (let i = 0; i < limit; i++) {
    if (!units[i].isPauseOnly) c += tokenizeSpeech(units[i].text).length;
  }
  return c;
}

/** Trailing spoken window so earlier sentences cannot unlock later lines. */
export function recentSpokenWindow(spokenText: string, phraseWordCount: number): string {
  const tokens = tokenizeSpeech(spokenText);
  const size = Math.max(phraseWordCount + 8, 18);
  return tokens.slice(-size).join(' ');
}

/** Minimum dwell for a phrase at ~130 WPM (speech-first; no timer-only advance). */
export function phraseDwellMs(unit: PrompterUnit | undefined, speakingPace?: string): number {
  const words = (unit?.text || '')
    .split(/\s+/)
    .filter(Boolean).length;
  const paceHint = String(speakingPace || 'natural');
  const wpm = paceHint === 'slow' ? 105 : paceHint === 'brisk' ? 145 : 125;
  const speakMs = (Math.max(1, words) / wpm) * 60_000;
  const pauseMs = ((unit?.pauseAfter || 0.25) + 0.45) * 1000;
  return Math.max(3200, Math.round(speakMs + pauseMs));
}

/**
 * Estimate whether the speaker is ahead/behind the script given cumulative spoken text
 * and the current phrase index.
 */
export function estimateSpeechPace(opts: {
  units: PrompterUnit[];
  currentIndex: number;
  spokenText: string;
  recordingElapsedSec: number;
  speakingPace?: 'slow' | 'natural' | 'brisk' | string;
}): { status: PaceStatus; matchRatio: number; suggestedDwellMs: number } {
  const { units, currentIndex, spokenText, recordingElapsedSec } = opts;
  if (!units.length) {
    return { status: 'on_pace', matchRatio: 0, suggestedDwellMs: 4000 };
  }

  const spokenWords = tokenizeSpeech(spokenText);
  const windowTokens = tokenizeSpeech(recentSpokenWindow(spokenText, 12));
  const spokenSet = new Set(windowTokens);

  const expectedThrough = units
    .slice(0, currentIndex + 1)
    .filter((u) => !u.isPauseOnly)
    .map((u) => u.text)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const hits = expectedThrough.filter((w) => spokenSet.has(w)).length;
  const matchRatio = expectedThrough.length ? hits / expectedThrough.length : 0;

  const futureWords = units
    .slice(currentIndex + 1, currentIndex + 3)
    .flatMap((u) =>
      u.text
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const futureHits = futureWords.filter((w) => spokenSet.has(w)).length;
  const aheadSignal = futureWords.length > 0 && futureHits / futureWords.length >= 0.5;

  const current = units[currentIndex];
  const currentDone = phraseIsMatched(current?.text || '', spokenText);

  const paceHint = String(opts.speakingPace || 'natural');
  const targetWpm = paceHint === 'slow' ? 115 : paceHint === 'brisk' ? 165 : 140;
  const expectedWordsByTime = (recordingElapsedSec / 60) * targetWpm;
  const paceByTime =
    expectedWordsByTime <= 2 ? 1 : spokenWords.length / Math.max(1, expectedWordsByTime);

  let status: PaceStatus = 'on_pace';
  if (aheadSignal || (currentDone && paceByTime > 1.35)) {
    status = 'ahead';
  } else if (matchRatio < 0.35 && recordingElapsedSec > 3 && paceByTime < 0.7) {
    status = 'behind';
  } else if (!currentDone && recordingElapsedSec > 4 && paceByTime < 0.75) {
    status = 'behind';
  }

  const suggestedDwellMs = phraseDwellMs(current, opts.speakingPace);

  return { status, matchRatio, suggestedDwellMs };
}

/** True when the current phrase was just spoken — ordered match on a trailing window. */
export function phraseIsMatched(phrase: string, spokenText: string): boolean {
  const words = tokenizeSpeech(phrase);
  if (!words.length) return true;
  const window = tokenizeSpeech(recentSpokenWindow(spokenText, words.length));
  if (!window.length) return false;

  let cursor = 0;
  let hits = 0;
  for (const word of words) {
    const found = window.findIndex((token, i) => i >= cursor && tokensMatch(token, word));
    if (found >= 0) {
      hits += 1;
      cursor = found + 1;
    }
  }
  if (hits / words.length < 0.75) return false;

  const last = words[words.length - 1];
  const tail = window.slice(-Math.max(4, words.length));
  return tail.some((token) => tokensMatch(token, last));
}

export const DIRECTOR_CUE_LABELS: Record<string, string> = {
  LOOK_AT_CAMERA: 'LOOK AT CAMERA',
  PAUSE: 'PAUSE',
  SHOW_PRODUCT: 'SHOW PRODUCT',
  SMILE: 'SMILE',
  TURN_TO_SIDE: 'TURN TO SIDE',
  START_ACTION: 'START ACTION',
  HOLD: 'HOLD',
  CONTINUE: 'CONTINUE',
  GET_CLOSEUP: 'GET CLOSE-UP',
  WIDEN_FRAME: 'WIDEN FRAME',
};

export function cueLabel(kind: string): string {
  const key = String(kind || '').toUpperCase().replace(/\s+/g, '_');
  return DIRECTOR_CUE_LABELS[key] || String(kind || '').replace(/_/g, ' ');
}

export type BeatPrompterUnit = PrompterUnit & { beatLabel: string; beatId: string };

export function narrativeBeatLabel(beat: {
  title?: string;
  purpose?: string;
  editIntent?: string;
}): string {
  const intent = String(beat.editIntent || '').toLowerCase();
  if (intent === 'hook') return 'HOOK';
  if (intent === 'problem') return 'PROBLEM';
  if (intent === 'product') return 'PRODUCT';
  if (intent === 'benefit' || intent === 'payoff') return 'BENEFIT';
  if (intent === 'cta' || intent === 'ending') return 'CTA';
  const t = `${beat.title || ''} ${beat.purpose || ''}`.toLowerCase();
  if (/hook|open/.test(t)) return 'HOOK';
  if (/problem|pain|struggle|frustrat/.test(t)) return 'PROBLEM';
  if (/product|found|app|solution/.test(t)) return 'PRODUCT';
  if (/benefit|result|now i|changed/.test(t)) return 'BENEFIT';
  if (/cta|close|try it|ask/.test(t)) return 'CTA';
  return String(beat.title || 'BEAT').toUpperCase();
}

export function unitsFromNarrativeBeats(
  beats: Array<{ id: string; title?: string; purpose?: string; editIntent?: string; dialogue?: string }>
): BeatPrompterUnit[] {
  const out: BeatPrompterUnit[] = [];
  for (const b of beats) {
    const label = narrativeBeatLabel(b);
    const units = splitIntoPhraseUnits(b.dialogue || '');
    for (const u of units) {
      out.push({ ...u, beatLabel: label, beatId: b.id });
    }
  }
  return out;
}
