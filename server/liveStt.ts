import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SpeechClient } from '@google-cloud/speech';

const SAMPLE_RATE = 16000;
const STT_RESTART_MS = 4 * 60_000;
const REOPEN_DELAY_MS = 250;

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (_) {}
}

function isDestroyedWriteError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '');
  return /write after a stream was destroyed/i.test(msg);
}

function canWriteRecognize(stream: { destroyed?: boolean; writableEnded?: boolean } | null): boolean {
  return Boolean(stream && !stream.destroyed && !stream.writableEnded);
}

function startRecognizeStream(
  speech: SpeechClient,
  ws: WebSocket,
  languageCode: string,
  sampleRate: number
) {
  return speech
    .streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
        languageCode,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
        model: 'latest_long',
        useEnhanced: true,
      },
      interimResults: true,
    })
    .on('data', (data: any) => {
      const result = data?.results?.[0];
      const alt = result?.alternatives?.[0];
      if (!alt?.transcript) return;
      const words = Array.isArray(alt.words)
        ? alt.words.map((w: any) => ({
            word: String(w.word || ''),
            start: Number(w.startTime?.seconds || 0) + Number(w.startTime?.nanos || 0) / 1e9,
            end: Number(w.endTime?.seconds || 0) + Number(w.endTime?.nanos || 0) / 1e9,
          }))
        : [];
      const start = words.length ? words[0].start : 0;
      const end = words.length ? words[words.length - 1].end : start;
      sendJson(ws, {
        type: result.isFinal ? 'final' : 'interim',
        transcript: String(alt.transcript),
        stability: result.stability ?? (result.isFinal ? 1 : 0.5),
        start,
        end,
        words,
      });
    });
}

export function attachLiveStt(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  let speech: SpeechClient | null = null;
  try {
    speech = new SpeechClient();
  } catch (err: any) {
    console.warn('[live-stt] SpeechClient init failed:', err?.message || err);
  }

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/api/live-stt') return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    if (!speech) {
      sendJson(ws, { type: 'error', message: 'Cloud Speech is not configured on this server' });
      ws.close();
      return;
    }

    let recognize: ReturnType<typeof startRecognizeStream> | null = null;
    let language = 'en-US';
    let sampleRate = SAMPLE_RATE;
    let restartTimer: NodeJS.Timeout | null = null;
    let reopenTimer: NodeJS.Timeout | null = null;
    let started = false;
    let opening = false;

    const clearRecognize = () => {
      if (!recognize) return;
      try {
        recognize.removeAllListeners('error');
        recognize.end();
      } catch (_) {}
      recognize = null;
    };

    const scheduleReopen = () => {
      if (!started || ws.readyState !== WebSocket.OPEN || reopenTimer) return;
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        if (started && ws.readyState === WebSocket.OPEN) openRecognize();
      }, REOPEN_DELAY_MS);
    };

    const openRecognize = (force = false) => {
      if (opening) return;
      if (!force && canWriteRecognize(recognize)) {
        sendJson(ws, { type: 'listening' });
        return;
      }
      opening = true;
      clearRecognize();
      try {
        const stream = startRecognizeStream(speech!, ws, language, sampleRate);
        stream.on('error', (err) => {
          const msg = err?.message || 'Speech recognition error';
          console.warn('[live-stt] recognize error:', msg);
          if (recognize === stream) recognize = null;
          if (isDestroyedWriteError(err)) {
            scheduleReopen();
            return;
          }
          sendJson(ws, { type: 'error', message: msg });
          if (started && ws.readyState === WebSocket.OPEN) scheduleReopen();
        });
        recognize = stream;
        sendJson(ws, { type: 'listening' });
      } finally {
        opening = false;
      }
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN && started) openRecognize(true);
      }, STT_RESTART_MS);
    };

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) {
        let msg: any = {};
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'start') {
          language = typeof msg.language === 'string' ? msg.language : 'en-US';
          sampleRate = Number(msg.sampleRate) || SAMPLE_RATE;
          started = true;
          if (canWriteRecognize(recognize)) {
            sendJson(ws, { type: 'listening' });
            return;
          }
          openRecognize();
          return;
        }
        if (msg.type === 'beginTake' || msg.type === 'reset') {
          // Reset speech recognition stream so word offsets are 0.0-indexed for the new take
          openRecognize(true);
          return;
        }
        if (msg.type === 'stop') {
          started = false;
          if (reopenTimer) {
            clearTimeout(reopenTimer);
            reopenTimer = null;
          }
          clearRecognize();
          return;
        }
        return;
      }

      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (!started) {
        started = true;
        openRecognize();
      } else if (!canWriteRecognize(recognize) && ws.readyState === WebSocket.OPEN) {
        scheduleReopen();
      }
      if (canWriteRecognize(recognize) && buf.length) {
        try {
          // @google-cloud/speech streaming helper already wraps Buffer as { audioContent }.
          // Passing { audioContent: buf } double-wraps and Google returns Malordered Data.
          recognize!.write(buf);
        } catch (err: any) {
          if (isDestroyedWriteError(err)) {
            recognize = null;
            scheduleReopen();
            return;
          }
          console.warn('[live-stt] write failed:', err?.message || err);
        }
      }
    });

    ws.on('close', () => {
      started = false;
      if (restartTimer) clearTimeout(restartTimer);
      if (reopenTimer) clearTimeout(reopenTimer);
      clearRecognize();
    });

    ws.on('error', (err) => {
      console.warn('[live-stt] socket error:', err?.message || err);
    });
  });

  console.log('[live-stt] WebSocket attached at /api/live-stt');
}
