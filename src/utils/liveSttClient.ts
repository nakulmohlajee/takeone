export type LiveSttStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'reconnecting'
  | 'error'
  | 'unsupported';

export type LiveTranscriptWord = { w: string; start: number; end: number; conf?: number };

export type LiveTranscriptSegment = {
  start: number;
  end: number;
  text: string;
  /** Word timings (take-relative seconds) when the server sends them on finals */
  words?: LiveTranscriptWord[];
};

export type LiveSttHandlers = {
  onInterim?: (text: string) => void;
  onFinal?: (seg: LiveTranscriptSegment) => void;
  onStatus?: (status: LiveSttStatus, detail?: string) => void;
  onError?: (message: string) => void;
  /** Optional level meter callback (0–100) — share one AudioContext with PCM tap */
  onLevel?: (level: number) => void;
};

export type LiveSttOptions = {
  /** BCP-47 language for Google STT (default en-US) */
  language?: string;
};

const TARGET_RATE = 16000;
const RESTART_MS = 4 * 60_000;
const PCM_WATCHDOG_MS = 2200;

/** Map Google STT protocol errors to short, actionable UI copy. */
function friendlySttError(raw: string): string {
  const msg = String(raw || '').trim();
  if (!msg) return 'Live captions failed — tap Record again';
  if (/malordered|audio content|exactly one config|buffer expected/i.test(msg)) {
    return 'Live captions hit a mic stream glitch — stop and tap Record again';
  }
  if (/quota|resource.?exhausted|429/i.test(msg)) {
    return 'Live captions temporarily unavailable (speech quota)';
  }
  if (/permission|unauthenticated|403/i.test(msg)) {
    return 'Live captions unavailable — speech service auth failed';
  }
  if (msg.length > 120) return `${msg.slice(0, 117)}…`;
  return msg;
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/live-stt`;
}

function downsampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  if (!input.length) return new Int16Array(0);
  const ratio = fromRate / TARGET_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function createLiveSttClient(handlers: LiveSttHandlers = {}, opts: LiveSttOptions = {}) {
  let language = opts.language || 'en-US';
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let analyser: AnalyserNode | null = null;
  let muteGain: GainNode | null = null;
  let socket: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let running = false;
  let reconnectTimer: number | null = null;
  let restartTimer: number | null = null;
  let pcmWatchdog: number | null = null;
  let levelRaf: number | null = null;
  let attempt = 0;
  let takeOffset = 0;
  let lastStatus: LiveSttStatus = 'idle';
  let pcmSentAt = 0;
  let workletLoaded = false;
  let startInFlight: Promise<boolean> | null = null;

  const setStatus = (status: LiveSttStatus, detail?: string) => {
    lastStatus = status;
    handlers.onStatus?.(status, detail);
  };

  const stopLevelMeter = () => {
    if (levelRaf != null) {
      cancelAnimationFrame(levelRaf);
      levelRaf = null;
    }
  };

  const startLevelMeter = () => {
    stopLevelMeter();
    if (!analyser || !handlers.onLevel) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyser) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / Math.max(1, data.length);
      handlers.onLevel?.(Math.min(100, Math.round((avg / 128) * 100)));
      levelRaf = requestAnimationFrame(tick);
    };
    tick();
  };

  const clearPcmWatchdog = () => {
    if (pcmWatchdog != null) {
      window.clearTimeout(pcmWatchdog);
      pcmWatchdog = null;
    }
  };

  const armPcmWatchdog = () => {
    clearPcmWatchdog();
    pcmWatchdog = window.setTimeout(() => {
      if (!running) return;
      if (pcmSentAt > 0) return;
      setStatus('error', 'Tap Record again to enable microphone audio');
      handlers.onError?.('No microphone PCM — tap Record again');
    }, PCM_WATCHDOG_MS);
  };

  const cleanupGraph = () => {
    stopLevelMeter();
    try {
      workletNode?.disconnect();
    } catch (_) {}
    try {
      processor?.disconnect();
    } catch (_) {}
    try {
      analyser?.disconnect();
    } catch (_) {}
    try {
      muteGain?.disconnect();
    } catch (_) {}
    try {
      source?.disconnect();
    } catch (_) {}
    workletNode = null;
    processor = null;
    analyser = null;
    muteGain = null;
    source = null;
  };

  const closeSocket = () => {
    if (restartTimer) {
      window.clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'stop' }));
        }
        socket.close();
      } catch (_) {}
      socket = null;
    }
  };

  const sendPcm = (pcm: Int16Array) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !pcm.length) return;
    try {
      const copy = new Uint8Array(pcm.byteLength);
      copy.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      socket.send(copy.buffer);
      if (pcmSentAt === 0) pcmSentAt = Date.now();
      clearPcmWatchdog();
    } catch (_) {}
  };

  const handleMessage = (ev: MessageEvent) => {
    let data: any = ev.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'interim' && data.transcript) {
      setStatus('transcribing');
      handlers.onInterim?.(String(data.transcript));
      return;
    }
    if (data.type === 'final' && data.transcript) {
      const start = takeOffset + (Number(data.start) || 0);
      const end = takeOffset + (Number(data.end) || start);
      const words: LiveTranscriptWord[] = Array.isArray(data.words)
        ? data.words
            .map((w: any) => ({
              w: String(w?.w ?? w?.word ?? '').trim(),
              start: takeOffset + (Number(w?.start) || 0),
              end: takeOffset + (Number(w?.end) || Number(w?.start) || 0),
              ...(typeof w?.conf === 'number' ? { conf: w.conf } : {}),
            }))
            .filter((w: LiveTranscriptWord) => w.w)
        : [];
      handlers.onFinal?.({
        start,
        end: end > start ? end : start + 0.4,
        text: String(data.transcript).trim(),
        ...(words.length ? { words } : {}),
      });
      setStatus('listening');
      return;
    }
    if (data.type === 'listening') {
      setStatus('listening');
      return;
    }
    if (data.type === 'error') {
      const message = String(data.message || 'Speech recognition error');
      if (/write after a stream was destroyed/i.test(message)) {
        setStatus('reconnecting', 'Captions reconnecting…');
        return;
      }
      handlers.onError?.(friendlySttError(message));
    }
  };

  const openSocket = () => {
    closeSocket();
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch (err: any) {
      setStatus('error', err?.message || 'WebSocket failed');
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      attempt = 0;
      try {
        ws.send(
          JSON.stringify({ type: 'start', sampleRate: TARGET_RATE, language })
        );
      } catch (_) {}
      setStatus('listening');
      armPcmWatchdog();
      restartTimer = window.setTimeout(() => {
        takeOffset += RESTART_MS / 1000;
        if (running) openSocket();
      }, RESTART_MS);
    };
    ws.onmessage = handleMessage;
    ws.onerror = () => {
      handlers.onError?.('Live captions connection error');
    };
    ws.onclose = () => {
      socket = null;
      if (running) scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (!running || reconnectTimer != null) return;
    attempt += 1;
    const delay = Math.min(8000, 400 * 2 ** Math.min(attempt, 4));
    setStatus('reconnecting', 'Live captions reconnecting…');
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (running) openSocket();
    }, delay);
  };

  const ensureRunningContext = async (): Promise<boolean> => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) {
      setStatus('unsupported', 'Web Audio is not available in this browser');
      return false;
    }
    if (!audioCtx || audioCtx.state === 'closed') {
      // Use hardware default rate — hard-coding 48000 fails on some Android devices
      audioCtx = new AudioCtx();
      workletLoaded = false;
    }
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (_) {}
    }
    if (audioCtx.state !== 'running') {
      setStatus('error', 'Tap Record to unlock the microphone');
      handlers.onError?.('AudioContext still suspended — tap Record');
      return false;
    }
    return true;
  };

  const attachGraph = async (media: MediaStream) => {
    const ok = await ensureRunningContext();
    if (!ok || !audioCtx) return;
    cleanupGraph();
    const tracks = media.getAudioTracks();
    if (!tracks.length) {
      setStatus('error', 'No microphone track on this camera stream');
      return;
    }
    const audioOnly = new MediaStream(tracks);
    source = audioCtx.createMediaStreamSource(audioOnly);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    startLevelMeter();

    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;

    try {
      if (!workletLoaded) {
        await audioCtx.audioWorklet.addModule('/pcm-tap-processor.js');
        workletLoaded = true;
      }
      workletNode = new AudioWorkletNode(audioCtx, 'pcm-tap');
      workletNode.port.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          sendPcm(new Int16Array(ev.data));
        }
      };
      source.connect(workletNode);
      workletNode.connect(muteGain);
      muteGain.connect(audioCtx.destination);
    } catch {
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        sendPcm(downsampleTo16k(input, audioCtx?.sampleRate || 48000));
      };
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioCtx.destination);
    }
  };

  return {
    status: () => lastStatus,
    audioContext: () => audioCtx,
    start: async (media: MediaStream) => {
      if (startInFlight) return startInFlight;
      const run = (async () => {
        if (!media.getAudioTracks().length) {
          setStatus('error', 'Microphone permission is required for live captions');
          return false;
        }
        const socketOpen =
          !!socket &&
          (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
        if (running && socketOpen) {
          const needGraph = !source || media !== stream;
          stream = media;
          const resumed = await ensureRunningContext();
          if (!resumed) return false;
          if (needGraph) await attachGraph(media);
          return !!source;
        }
        running = true;
        stream = media;
        takeOffset = 0;
        attempt = 0;
        pcmSentAt = 0;
        await attachGraph(media);
        if (lastStatus === 'unsupported' || lastStatus === 'error') {
          if (lastStatus === 'error' && !source) return false;
        }
        if (!source) return false;
        openSocket();
        return true;
      })();
      startInFlight = run;
      try {
        return await run;
      } finally {
        if (startInFlight === run) startInFlight = null;
      }
    },
    replaceStream: async (media: MediaStream) => {
      stream = media;
      if (!running) return;
      await attachGraph(media);
    },
    /** New take on the same socket — drop prior offset so captions do not inherit the last take. */
    beginTake: () => {
      takeOffset = 0;
      pcmSentAt = Date.now();
      clearPcmWatchdog();
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'beginTake' }));
        } catch (_) {}
      }
    },
    resume: async () => {
      return ensureRunningContext();
    },
    setLanguage: (next: string) => {
      if (next && next !== language) language = next;
    },
    stop: () => {
      running = false;
      clearPcmWatchdog();
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeSocket();
      cleanupGraph();
      if (audioCtx) {
        try {
          audioCtx.close();
        } catch (_) {}
        audioCtx = null;
        workletLoaded = false;
      }
      stream = null;
      pcmSentAt = 0;
      setStatus('idle');
    },
  };
}

export type LiveSttClient = ReturnType<typeof createLiveSttClient>;

export function isStablePhrase(text: string): boolean {
  const t = (text || '').trim();
  if (t.length < 8) return false;
  if (/[.?!]["']?$/.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length >= 4;
}
