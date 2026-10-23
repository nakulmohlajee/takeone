import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Camera,
  RotateCcw,
  Check,
  SwitchCamera,
  Smile,
  ShieldCheck,
  AlertTriangle,
  Zap,
  CheckCircle2,
  TrendingUp,
  Mic,
  Upload,
  Play,
  Pause,
  Monitor,
  Smartphone,
  Radio,
  MessageSquare,
} from 'lucide-react';
import {
  Project,
  Scene,
  formatDuration,
  AspectRatio,
  type CaptureStrategy,
  type DirectorCue,
} from '../types/director';
import { createDemoVideoBlob } from '../utils/videoStitcher';
import {
  CHROMA_GREEN,
  aspectRatioValue,
  coverCrop,
  drawPersonOverBackground,
  drawPersonOverGreen,
  ensureSegmenter,
  segmentPerson,
  segmentationAvailable,
} from '../utils/segmentation';
import {
  PLACEHOLDER_BACKGROUND_URL,
  resolveSceneBackgroundUrl,
  sceneWantsVirtualBackground,
} from '../utils/virtualBackground';
import { inferVideoMime, kickProxyBuild, persistTakeBlob } from '../utils/renderClient';
import { analyzeTakeClaims, sceneHasTake } from '../utils/takeAnalysis';
import { mediaUrlFromGcs, saveTakeMedia, resolvePlayableTakeUrl, saveProjectLocally } from '../utils/mediaVault';
import {
  createLiveSttClient,
  isStablePhrase,
  type LiveSttClient,
  type LiveSttStatus,
} from '../utils/liveSttClient';
import { liveSttLanguageCode } from '../utils/spokenLanguage';
import {
  advanceWordCursor,
  estimateSpeechPace,
  phraseDwellMs,
  phraseIndexFromWordCursor,
  phraseIsMatched,
  scriptTokensFromUnits,
  splitIntoPhraseUnits,
  tokenizeSpeech,
  unitsFromNarrativeBeats,
  wordCursorAtPhraseStart,
  type PaceStatus,
} from '../utils/teleprompter';
import { SmartTeleprompter } from './SmartTeleprompter';
import { ShotSetupSheet } from './ShotSetupSheet';

interface GuidedShootingViewProps {
  project: Project;
  onUpdateProject: (proj: Project | ((prev: Project) => Project)) => void;
  onFinishShooting: () => void;
}

type ShootingState = 'permission' | 'ready' | 'countdown' | 'recording' | 'reviewing';

export interface LiveFactCheckResult {
  status: 'listening' | 'verified' | 'warning' | 'alert';
  isFactual: boolean;
  issueType?: 'factual_error' | 'audience_disconnect' | 'jargon_overload' | 'off_track' | 'none';
  alertTitle: string;
  factCheckMessage: string;
  audienceConnectionScore: number | null;
  connectionFeedback?: string;
  actionableTip?: string;
  timestamp?: number;
}

/** Real duration of a recorded blob from its metadata (null when the container doesn't say). */
function probeBlobDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const t = window.setTimeout(() => done(null), 4000);
    v.onloadedmetadata = () => {
      clearTimeout(t);
      done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    };
    v.onerror = () => {
      clearTimeout(t);
      done(null);
    };
    v.src = url;
  });
}

/** How long transcription waits for the take's cloud upload before giving up on the GCS path. */
const TAKE_UPLOAD_WAIT_MS = 90_000;
/** Inline (base64) transcription only for small takes — Cloud Run rejects requests over 32 MB. */
const INLINE_TRANSCRIBE_MAX_BYTES = 20 * 1024 * 1024;

/** Record the in-browser composite instead of the plain camera (server matting replaces this). */
const BROWSER_BAKE = false;

export const GuidedShootingView: React.FC<GuidedShootingViewProps> = ({
  project,
  onUpdateProject,
  onFinishShooting,
}) => {
  const userScenes = project.scenes.filter((s) => s.filmedBy === 'user');
  const [currentUserSceneIndex, setCurrentUserSceneIndex] = useState(() => {
    // "Shoot this shot" from Shot Direction wins.
    const picked = project.shootFromSceneId
      ? userScenes.findIndex((s) => s.id === project.shootFromSceneId)
      : -1;
    if (picked >= 0) return picked;
    // Prefer first incomplete take so remount/tab switch never restarts at scene 1
    // when later scenes are already saved.
    const needsCapture = (s: (typeof userScenes)[number]) =>
      !sceneHasTake(s) && s.captureStatus !== 'upload' && s.captureStatus !== 'skipped';
    const firstRequiredOpen = userScenes.findIndex((s) => !s.optionalInsert && needsCapture(s));
    if (firstRequiredOpen >= 0) return firstRequiredOpen;
    const firstOpen = userScenes.findIndex((s) => needsCapture(s));
    if (firstOpen >= 0) return firstOpen;
    const saved = project.lastShootingSceneId
      ? userScenes.findIndex((s) => s.id === project.lastShootingSceneId)
      : -1;
    if (saved >= 0) return saved;
    return Math.max(0, userScenes.length - 1);
  });
  const captureStrategy: CaptureStrategy = (project.captureStrategy ||
    project.creativeBrief?.captureStrategy ||
    (userScenes.length <= 1 ? 'single_take' : 'multi_shot')) as CaptureStrategy;
  const currentScene = userScenes[currentUserSceneIndex] || userScenes[0];
  const totalUserScenes = userScenes.length;
  const wantsVirtualBg = sceneWantsVirtualBackground(currentScene, project);
  const sceneBgUrl = resolveSceneBackgroundUrl(currentScene, project);
  // gs:// assets (generated on Master Cut) load through the same-origin media proxy so the
  // canvas stays untainted and can be recorded.
  const virtualBgUrl =
    (sceneBgUrl?.startsWith('gs://') ? mediaUrlFromGcs(sceneBgUrl) : sceneBgUrl) || PLACEHOLDER_BACKGROUND_URL;
  const isOptionalInsert = Boolean(currentScene?.optionalInsert);
  // A single-take plan reads the whole story from the beats; once the plan has several shots,
  // each shot must prompt only its own lines.
  const mainShotCount = userScenes.filter((s) => !s.optionalInsert).length;
  const isSingleTake = captureStrategy === 'single_take' && !isOptionalInsert && mainShotCount <= 1;
  const narrativeBeats = project.narrativeBeats || [];
  const remainingOptional = userScenes
    .slice(currentUserSceneIndex + 1)
    .some((s) => s.optionalInsert);

  const [shootingState, setShootingState] = useState<ShootingState>('ready');
  // "Shoot this shot" is a one-time request: clear it once the shoot has opened on that shot.
  useEffect(() => {
    if (project.shootFromSceneId) onUpdateProject((prev) => ({ ...prev, shootFromSceneId: undefined }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [countdownNum, setCountdownNum] = useState(3);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const recordingPausedRef = useRef(false);
  /** What had been heard when the take was paused — speech during the pause is dropped on resume. */
  const spokenAtPauseRef = useRef<string | null>(null);
  /** Wall-clock recording time (ms) — a 1s interval drifts badly when the page is busy. */
  const recActiveMsRef = useRef(0);
  const recSegmentStartRef = useRef<number | null>(null);
  const recordingElapsedSec = () =>
    (recActiveMsRef.current +
      (recSegmentStartRef.current != null ? performance.now() - recSegmentStartRef.current : 0)) /
    1000;
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [takeSaveStatus, setTakeSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [takeSaveError, setTakeSaveError] = useState<string | null>(null);
  const takePersistGenRef = useRef(0);
  const savedTakeRef = useRef<{ gcsObjectPath: string; mimeType: string } | null>(null);
  /** Background image composited into the take being recorded (null = recorded on green / raw). */
  const bakedBackgroundRef = useRef<string | null>(null);
  /** How the current take is being captured when the scene wants a virtual background. */
  const vbModeRef = useRef<'baked' | 'green' | 'none' | undefined>(undefined);
  /** Creator chose to record without the virtual background for this take. */
  const vbOverrideRef = useRef(false);
  const [vbGate, setVbGate] = useState<null | 'waiting' | 'unavailable'>(null);
  /** Resolves with this take's gs:// path once its upload finishes (null if the upload failed). */
  const takeUploadRef = useRef<{ promise: Promise<string | null>; resolve: (uri: string | null) => void } | null>(
    null
  );
  const beginTakeUpload = () => {
    let resolve!: (uri: string | null) => void;
    const promise = new Promise<string | null>((r) => (resolve = r));
    takeUploadRef.current = { promise, resolve };
  };
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [viewAspectRatio, setViewAspectRatio] = useState<AspectRatio>(
    project.aspectRatio || (project.videoFormat === 'long-form' ? '16:9' : '9:16')
  );
  /** Read by the compositor loop without restarting it when the aspect toggles. */
  const viewAspectRef = useRef<AspectRatio>(viewAspectRatio);
  viewAspectRef.current = viewAspectRatio;
  /** Loaded background image for this scene (null until loaded, or for the placeholder). */
  const virtualBgImageRef = useRef<HTMLImageElement | null>(null);
  const [devicePortrait, setDevicePortrait] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(orientation: portrait)').matches : true
  );
  const [showOutputSheet, setShowOutputSheet] = useState(!project.outputFormatConfirmed);
  const recommendedAspect: AspectRatio = devicePortrait ? '9:16' : '16:9';

  const persistAspect = useCallback(
    (next: AspectRatio, confirmed = true) => {
      setViewAspectRatio(next);
      onUpdateProject((prev) => ({
        ...prev,
        aspectRatio: next,
        ...(confirmed ? { outputFormatConfirmed: true } : {}),
      }));
    },
    [onUpdateProject]
  );

  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const sync = () => setDevicePortrait(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (project.aspectRatio && project.aspectRatio !== viewAspectRatio) {
      setViewAspectRatio(project.aspectRatio);
    }
  }, [project.aspectRatio]); // eslint-disable-line react-hooks/exhaustive-deps

  const filmingMismatch =
    !showOutputSheet &&
    ((devicePortrait && viewAspectRatio === '16:9') || (!devicePortrait && viewAspectRatio === '9:16'));
  const [farPrompter, setFarPrompter] = useState(true);
  const [prompterOpacity, setPrompterOpacity] = useState(0.62);
  const [prompterOffsetY, setPrompterOffsetY] = useState(8);
  const [liveDirectorCue, setLiveDirectorCue] = useState<DirectorCue | null>(null);
  const [prompterLineIdx, setPrompterLineIdx] = useState(0);
  const [handsFreeMode, setHandsFreeMode] = useState(true);
  const [voiceStatus, setVoiceStatus] = useState<'off' | 'ready' | 'unavailable' | 'needs-gesture'>('off');
  const [handsFreeHint, setHandsFreeHint] = useState('Tap record or say Action');
  const [reviewPlaying, setReviewPlaying] = useState(true);
  const [lineDwellAt, setLineDwellAt] = useState(0);
  const [paceStatus, setPaceStatus] = useState<PaceStatus>('on_pace');
  const paceDwellRef = useRef(1500);
  const [wordCursor, setWordCursor] = useState(0);
  const [showCutCue, setShowCutCue] = useState(false);

  // Gemini Live Fact-Checker & Connection Radar State
  /** Display + match string = finals.join(' ') + ' ' + interim (never replaced by interim alone). */
  const [liveSpokenText, setLiveSpokenText] = useState('');
  const [factCheckResult, setFactCheckResult] = useState<LiveFactCheckResult>({
    status: 'listening',
    isFactual: true,
    issueType: 'none',
    alertTitle: 'Gemini Radar Active',
    factCheckMessage: 'Listening — score appears after you speak…',
    audienceConnectionScore: null,
    connectionFeedback: 'Speak naturally into your microphone.',
    actionableTip: 'Keep eye contact with the camera lens.',
  });
  const [isCheckingFact, setIsCheckingFact] = useState(false);
  const [hudDismissed, setHudDismissed] = useState(false);
  const [hudAlertsEnabled, setHudAlertsEnabled] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [directorLog, setDirectorLog] = useState<
    Array<{ t: number; title: string; message: string; status: string }>
  >([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Virtual green screen: visible preview canvas (person over background) + offscreen
  // record canvas (person over #00FF00) that feeds MediaRecorder via captureStream.
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordCanvasStreamRef = useRef<MediaStream | null>(null);
  const virtualBgActiveRef = useRef(false);
  const [virtualBgStatus, setVirtualBgStatus] = useState<'off' | 'loading' | 'on' | 'unavailable'>('off');
  /** Escape hatch: record raw camera even though scene wants virtual background. */
  const [forceRecordWithoutVb, setForceRecordWithoutVb] = useState(false);
  const reviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraLockRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioOnlyRecorderRef = useRef<MediaRecorder | null>(null);
  const audioOnlyChunksRef = useRef<Blob[]>([]);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null);
  const lastEvaluatedTextRef = useRef<string>('');
  const debounceTimerRef = useRef<any>(null);
  const isRecordingRef = useRef<boolean>(false);
  const shootingStateRef = useRef<ShootingState>('ready');
  const handsFreeModeRef = useRef(true);
  const lastSpokenTimestampRef = useRef<number>(0);
  const recordingSecondsRef = useRef<number>(0);
  const cameraReadyAtRef = useRef<number>(0);
  const initiateCountdownRef = useRef<() => void>(() => {});
  const stopRecordingRef = useRef<() => void>(() => {});
  const queueSpeechRef = useRef<(s: string) => void>(() => {});
  const liveAudioPollerRef = useRef<number | null>(null);
  const lastCommandAtRef = useRef<number>(0);
  const recordingStartedAtRef = useRef<number>(0);
  const factCheckSceneIdRef = useRef<string | null>(null);
  const currentSceneIdRef = useRef<string | null>(null);
  const [noAudioWarning, setNoAudioWarning] = useState(false);
  const [liveSttStatus, setLiveSttStatus] = useState<LiveSttStatus>('idle');
  const [liveCaptionHint, setLiveCaptionHint] = useState('');
  const liveSttRef = useRef<LiveSttClient | null>(null);
  const takeEpochRef = useRef(0);
  /** Append-only timed finals for the take (captions / preview only — not canonical transcript). */
  const transcriptSegmentsRef = useRef<
    Array<{
      start: number;
      end: number;
      text: string;
      words?: Array<{ w: string; start: number; end: number; conf?: number }>;
    }>
  >([]);
  /** Append-only final utterance texts for spokenForMatch. */
  const finalsTextRef = useRef<string[]>([]);
  /** Current interim utterance only — never replaces finals. */
  const interimTextRef = useRef('');
  const wordCursorRef = useRef(0);
  const cutAutoStopArmedRef = useRef(false);
  const prompterUnitsRef = useRef<ReturnType<typeof splitIntoPhraseUnits>>([]);
  const expectedScriptRef = useRef('');
  const handleVoiceCommandTranscriptRef = useRef<(raw: string) => void>(() => {});

  const DEFAULT_FACT_CHECK: LiveFactCheckResult = {
    status: 'listening',
    isFactual: true,
    issueType: 'none',
    alertTitle: 'Gemini Radar Active',
    factCheckMessage: 'Listening — score appears after you speak…',
    audienceConnectionScore: null,
    connectionFeedback: 'Speak naturally into your microphone.',
    actionableTip: 'Keep eye contact with the camera lens.',
  };

  const beatUnits = isSingleTake ? unitsFromNarrativeBeats(narrativeBeats) : [];
  const hasSpokenLines =
    Boolean(currentScene?.teleprompterPrompt?.trim()) || beatUnits.length > 0;
  const prompterSource = hasSpokenLines
    ? currentScene?.teleprompterPrompt?.trim() ||
      narrativeBeats.map((b) => b.dialogue || '').filter(Boolean).join('\n\n')
    : '';
  const prompterUnits = beatUnits.length
    ? beatUnits
    : hasSpokenLines
      ? splitIntoPhraseUnits(prompterSource)
      : [];
  const currentBeatLabel =
    (prompterUnits[prompterLineIdx] && 'beatLabel' in prompterUnits[prompterLineIdx]
      ? (prompterUnits[prompterLineIdx] as { beatLabel?: string }).beatLabel
      : null) || (isSingleTake && narrativeBeats[0] ? String(narrativeBeats[0].title).toUpperCase() : null);
  const prompterLines = prompterUnits.map((u) => u.text);

  useEffect(() => {
    prompterUnitsRef.current = prompterUnits;
  }, [prompterUnits]);

  useEffect(() => {
    expectedScriptRef.current = prompterSource;
  }, [prompterSource]);

  const syncSpokenForMatch = useCallback(() => {
    const spokenForMatch = `${finalsTextRef.current.join(' ')} ${interimTextRef.current}`
      .replace(/\s+/g, ' ')
      .trim();
    setLiveSpokenText(spokenForMatch);
    return spokenForMatch;
  }, []);

  const applySpokenToCursor = useCallback(
    (spokenForMatch: string) => {
      const units = prompterUnitsRef.current;
      const scriptTokens = scriptTokensFromUnits(units);
      const next = advanceWordCursor(scriptTokens, spokenForMatch, wordCursorRef.current);
      if (next !== wordCursorRef.current) {
        wordCursorRef.current = next;
        setWordCursor(next);
      }
    },
    []
  );

  const directorCue = {
    capture:
      currentScene?.visual?.action ||
      currentScene?.purpose ||
      currentScene?.title ||
      'Capture this shot',
    camera:
      [currentScene?.visual?.camera, currentScene?.visual?.framing]
        .filter(Boolean)
        .join(' · ') ||
      currentScene?.plainInstruction ||
      'Hold phone steady at chest height',
    action: currentScene?.visual?.movement || currentScene?.visual?.action || 'Perform the action once',
    durationSec: currentScene?.durationSeconds || 5,
    stopHint: isSingleTake
      ? 'Keep rolling through every beat. Restart the whole take if you need a clean open.'
      : 'Keep recording ~2s after the action finishes, then stop.',
    onScreen: currentScene?.onScreenText || null,
    naturalAudio: currentScene?.naturalAudio || null,
  };
  const takeNumber = currentUserSceneIndex + 1;
  /** Scenes whose setup reminder the creator has dismissed (it reopens from the camera chip). */
  const [setupHiddenFor, setSetupHiddenFor] = useState<Record<string, boolean>>({});

  useEffect(() => {
    shootingStateRef.current = shootingState;
  }, [shootingState]);

  useEffect(() => {
    handsFreeModeRef.current = handsFreeMode;
  }, [handsFreeMode]);

  useEffect(() => {
    currentSceneIdRef.current = currentScene?.id || null;
    setForceRecordWithoutVb(false);
  }, [currentScene?.id]);

  const stopSpeechRecognition = useCallback(() => {
    const rec = speechRecognitionRef.current;
    if (!rec) return;
    try {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.stop();
    } catch (_) {}
    speechRecognitionRef.current = null;
  }, []);

  const resetLiveDirector = useCallback(
    (opts?: { restartSpeech?: boolean }) => {
      setLiveSpokenText('');
      finalsTextRef.current = [];
      interimTextRef.current = '';
      transcriptSegmentsRef.current = [];
      wordCursorRef.current = 0;
      setWordCursor(0);
      setShowCutCue(false);
      cutAutoStopArmedRef.current = false;
      setDirectorLog([]);
      setFactCheckResult({ ...DEFAULT_FACT_CHECK });
      setIsCheckingFact(false);
      setHudDismissed(false);
      lastEvaluatedTextRef.current = '';
      lastSpokenTimestampRef.current = Date.now();
      audioOnlyChunksRef.current = [];
      recordedChunksRef.current = [];
      factCheckSceneIdRef.current = currentSceneIdRef.current;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      stopSpeechRecognition();
      if (opts?.restartSpeech && handsFreeModeRef.current && shootingStateRef.current !== 'reviewing') {
        window.setTimeout(() => {
          // startSpeechRecognition is defined below; call via ref pattern after mount
          if (handsFreeModeRef.current && shootingStateRef.current !== 'reviewing') {
            startSpeechRecognitionRef.current?.(false);
          }
        }, 80);
      }
    },
    [stopSpeechRecognition]
  );

  const startSpeechRecognitionRef = useRef<(fromUserGesture?: boolean) => void>(() => {});

  useEffect(() => {
    setPrompterLineIdx(0);
    setLineDwellAt(Date.now());
    resetLiveDirector({ restartSpeech: shootingStateRef.current === 'ready' });
  }, [currentScene?.id, resetLiveDirector]);

  // Level meter lives inside liveSttClient (one AudioContext). Clear local UI only.
  const cleanupAudioAnalyser = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setMicLevel(0);
  };

  const handleVoiceCommandTranscript = useCallback((raw: string) => {
    const text = (raw || '').trim();
    if (!text) return;
    const latestLower = text.toLowerCase();
    const wordCount = latestLower.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    const state = shootingStateRef.current;
    const now = Date.now();
    if (now - lastCommandAtRef.current < 1800) {
      // still allow fact-check below
    } else if (handsFreeModeRef.current && wordCount <= 5) {
      if (state === 'ready' && /\baction\b/.test(latestLower)) {
        lastCommandAtRef.current = now;
        setHandsFreeHint('Heard “Action” — starting…');
        initiateCountdownRef.current();
        return;
      }
      if (state === 'recording' && /\bcut\b/.test(latestLower)) {
        lastCommandAtRef.current = now;
        setHandsFreeHint('Heard “Cut” — stopping…');
        stopRecordingRef.current();
        return;
      }
    }

  }, []);

  useEffect(() => {
    handleVoiceCommandTranscriptRef.current = handleVoiceCommandTranscript;
  }, [handleVoiceCommandTranscript]);

  // Indian-English model on devices set up for India; script language otherwise.
  const spokenLangBcp47 = liveSttLanguageCode(
    project.spokenLanguage || project.channelSettings?.currentLanguage || 'en'
  );

  useEffect(() => {
    liveSttRef.current = createLiveSttClient(
      {
      onInterim: (text) => {
        if (shootingStateRef.current !== 'recording') return;
        // Interim is current utterance only — never wipe finals
        interimTextRef.current = text || '';
        const spokenForMatch = syncSpokenForMatch();
        lastSpokenTimestampRef.current = Date.now();
        // Freeze prompter cursor while paused; keep radar/fact-check alive
        if (!recordingPausedRef.current) applySpokenToCursor(spokenForMatch);
        handleVoiceCommandTranscriptRef.current(text);
        const cleaned = spokenForMatch.replace(/\b(action|cut)\b/gi, ' ').replace(/\s+/g, ' ').trim();
        if (isStablePhrase(cleaned) || cleaned.split(/\s+/).length >= 4) {
          queueSpeechRef.current(cleaned);
        }
      },
      onFinal: (seg) => {
        if (!seg.text) return;
        if (shootingStateRef.current !== 'recording') return;
        transcriptSegmentsRef.current = [...transcriptSegmentsRef.current, seg];
        finalsTextRef.current = [...finalsTextRef.current, seg.text];
        interimTextRef.current = '';
        const spokenForMatch = syncSpokenForMatch();
        lastSpokenTimestampRef.current = Date.now();
        if (!recordingPausedRef.current) applySpokenToCursor(spokenForMatch);
        handleVoiceCommandTranscriptRef.current(seg.text);
        if (shootingStateRef.current === 'recording') {
          const cleaned = spokenForMatch
            .replace(/\b(action|cut)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (isStablePhrase(cleaned) || cleaned.split(/\s+/).length >= 4) {
            queueSpeechRef.current(cleaned);
          }
        }
      },
      onLevel: (level) => setMicLevel(level),
      onStatus: (status, detail) => {
        setLiveSttStatus(status);
        if (status === 'listening' || status === 'transcribing') {
          setLiveCaptionHint('');
        } else if (status === 'reconnecting') {
          setLiveCaptionHint(detail || 'Captions reconnecting…');
        } else if (detail) {
          setLiveCaptionHint(detail);
        }
        // Only start browser SR from a user gesture path — never from silent "listening"
        if (
          (status === 'error' || status === 'unsupported') &&
          handsFreeModeRef.current &&
          shootingStateRef.current === 'recording'
        ) {
          startSpeechRecognitionRef.current?.(true);
        }
      },
      onError: (message) => {
        if (/write after a stream was destroyed/i.test(message || '')) {
          setLiveCaptionHint('Captions reconnecting…');
          return;
        }
        setLiveCaptionHint(message);
      },
      },
      { language: spokenLangBcp47 }
    );
    return () => {
      liveSttRef.current?.stop();
      liveSttRef.current = null;
    };
  }, [spokenLangBcp47]);

  useEffect(() => {
    liveSttRef.current?.setLanguage(spokenLangBcp47);
  }, [spokenLangBcp47]);

  const sendAudioChunkForTranscription = useCallback(async () => {
    // Newest ~1s chunk only — never re-send prior-take audio
    const chunks =
      audioOnlyChunksRef.current.length > 0
        ? audioOnlyChunksRef.current.slice(-1)
        : recordedChunksRef.current.slice(-1);
    if (chunks.length === 0) return;
    try {
      const mime =
        audioOnlyRecorderRef.current?.mimeType ||
        mediaRecorderRef.current?.mimeType ||
        'audio/webm';
      const slice = new Blob(chunks, { type: mime });
      if (slice.size < 800) return;
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = (reader.result as string)?.split(',')[1];
        if (!base64) return;
        const res = await fetch('/api/transcribe-live-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64, mimeType: mime }),
        });
        const data = await res.json();
        if (data?.transcript) {
          handleVoiceCommandTranscript(data.transcript);
        }
      };
      reader.readAsDataURL(slice);
    } catch (_) {}
  }, [handleVoiceCommandTranscript]);

  const stopLiveAudioMonitor = useCallback(() => {
    if (liveAudioPollerRef.current) {
      clearInterval(liveAudioPollerRef.current);
      liveAudioPollerRef.current = null;
    }
    if (audioOnlyRecorderRef.current && audioOnlyRecorderRef.current.state !== 'inactive') {
      try {
        audioOnlyRecorderRef.current.stop();
      } catch (_) {}
    }
    audioOnlyRecorderRef.current = null;
    audioOnlyChunksRef.current = [];
  }, []);

  /** Must be called from a user gesture (Record / Voice On). */
  const startLiveAudioMonitor = useCallback(
    async (stream: MediaStream) => {
      stopLiveAudioMonitor();
      const client = liveSttRef.current;
      if (!client) return false;
      const resumed = await client.resume();
      if (!resumed) {
        setLiveCaptionHint('Captions reconnecting…');
        setLiveSttStatus('reconnecting');
        return false;
      }
      const started = await client.start(stream);
      if (!started) {
        setLiveCaptionHint('Captions reconnecting…');
        return false;
      }
      return true;
    },
    [stopLiveAudioMonitor]
  );

  const attachPreview = useCallback(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || shootingStateRef.current === 'reviewing') return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {});
  }, []);

  // Initialize camera & microphone stream
  const startCamera = async (mode = facingMode) => {
    if (cameraLockRef.current) return;
    cameraLockRef.current = true;
    try {
      setCameraError(null);
      cleanupAudioAnalyser();
      stopLiveAudioMonitor();
      const previous = streamRef.current;
      streamRef.current = null;
      if (previous) {
        previous.getTracks().forEach((t) => t.stop());
        // iOS/Safari cannot open the other camera until tracks are fully released.
        await new Promise((r) => setTimeout(r, 400));
      }

      const videoConstraints = (facing: MediaTrackConstraints['facingMode']): MediaStreamConstraints => ({
        video: {
          facingMode: facing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      });

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(videoConstraints({ exact: mode }));
      } catch {
        stream = await navigator.mediaDevices.getUserMedia(videoConstraints({ ideal: mode }));
      }

      streamRef.current = stream;
      attachPreview();
      cameraReadyAtRef.current = Date.now();
      // Soft-crop hint: landscape webcam → vertical export only keeps a narrow slice.
      try {
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.() || {};
        const w = Number(settings.width) || 0;
        const h = Number(settings.height) || 0;
        if (w > 0 && h > 0 && w > h * 1.2) {
          const cropW = Math.round(h * (9 / 16));
          setLiveCaptionHint(
            `Camera ${w}×${h} — vertical export crops to ~${cropW}×${h}. Tap Record to start live captions`
          );
        } else {
          setLiveCaptionHint(
            w && h
              ? `Camera ${w}×${h}. Tap Record to start live captions`
              : 'Tap Record to start live captions'
          );
        }
      } catch {
        // Do NOT start Cloud STT here — Android Chrome keeps AudioContext suspended
        // until a real tap (Record / Enable voice). Starting early shows fake "Listening".
        setLiveCaptionHint('Tap Record to start live captions');
      }
    } catch (err: any) {
      console.warn('Camera access unavailable:', err);
      setCameraError('Camera access not detected. Click "Simulate Actor Take" below for 1-tap testing.');
    } finally {
      cameraLockRef.current = false;
    }
  };

  const stopSpeechRecognitionOnly = () => {
    const rec = speechRecognitionRef.current;
    if (!rec) return;
    try {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.stop();
    } catch (_) {}
    speechRecognitionRef.current = null;
  };

  /** SpeechRecognition for Action/Cut only — never writes finalsTextRef / interimTextRef / cursor. */
  const startSpeechRecognition = useCallback((fromUserGesture = false) => {
    if (shootingStateRef.current === 'reviewing') return;

    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setVoiceStatus('unavailable');
      setHandsFreeHint('Voice API off — tap Enable mic, then say Action / Cut (Gemini listens)');
      return;
    }

    // Already running
    if (speechRecognitionRef.current) {
      setVoiceStatus('ready');
      return;
    }

    try {
      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = spokenLangBcp47;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: any) => {
        let latest = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = (event.results[i][0].transcript || '').trim();
          if (piece) latest += `${piece} `;
        }
        const latestLower = latest.toLowerCase().trim();
        if (!latestLower) return;
        // Live STT (createLiveSttClient) is the sole source for spoken cursor text.
        // Web Speech must only drive Action / Cut — never overwrite finalsTextRef.
        handleVoiceCommandTranscript(latestLower);
      };

      recognition.onerror = (e: any) => {
        const err = e?.error || '';
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          setVoiceStatus('unavailable');
          setHandsFreeHint('Mic blocked — tap to record (Gemini mic still used while filming)');
          stopSpeechRecognition();
          return;
        }
        if (err === 'no-speech' || err === 'aborted' || err === 'network') return;
        console.warn('SpeechRecognition error:', err);
      };

      recognition.onend = () => {
        speechRecognitionRef.current = null;
        if (
          handsFreeModeRef.current &&
          shootingStateRef.current !== 'reviewing' &&
          document.visibilityState === 'visible'
        ) {
          window.setTimeout(() => {
            if (!speechRecognitionRef.current && handsFreeModeRef.current) {
              startSpeechRecognition(false);
            }
          }, 250);
        }
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      setVoiceStatus('ready');
      setHandsFreeHint('Voice ready · say Action / Cut');
    } catch (err) {
      console.warn('SpeechRecognition start failed:', err);
      setVoiceStatus(fromUserGesture ? 'unavailable' : 'needs-gesture');
      setHandsFreeHint(
        fromUserGesture
          ? 'Browser voice unavailable — Gemini mic listens for Action / Cut'
          : 'Tap “Enable voice” once (required on some phones)'
      );
    }
  }, [handleVoiceCommandTranscript, stopSpeechRecognition, spokenLangBcp47]);

  useEffect(() => {
    startSpeechRecognitionRef.current = startSpeechRecognition;
  }, [startSpeechRecognition]);

  useEffect(() => {
    void startCamera(facingMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

  useEffect(() => {
    return () => {
      recordCanvasStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      recordCanvasStreamRef.current = null;
      cleanupAudioAnalyser();
      stopLiveAudioMonitor();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      stopSpeechRecognition();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Virtual green screen compositor: segment the camera and draw preview + record canvases.
  useEffect(() => {
    virtualBgActiveRef.current = false;
    if (!wantsVirtualBg || shootingState === 'reviewing') {
      setVirtualBgStatus('off');
      return;
    }
    if (!segmentationAvailable()) {
      setVirtualBgStatus('unavailable');
      return;
    }
    let cancelled = false;
    let raf = 0;
    setVirtualBgStatus('loading');

    const bgImage = new Image();
    bgImage.crossOrigin = 'anonymous';
    virtualBgImageRef.current = null;
    if (virtualBgUrl !== PLACEHOLDER_BACKGROUND_URL) {
      bgImage.onload = () => {
        if (!cancelled && bgImage.naturalWidth) virtualBgImageRef.current = bgImage;
      };
    }
    bgImage.src = virtualBgUrl;

    const fitCanvas = (c: HTMLCanvasElement, vw: number, vh: number, maxSide: number) => {
      const scale = Math.min(1, maxSide / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    };

    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      const preview = previewCanvasRef.current;
      if (!video || !preview || video.readyState < 2 || !video.videoWidth) return;
      // Only the part of the camera frame the video keeps (any camera, any orientation).
      const crop = coverCrop(video.videoWidth, video.videoHeight, aspectRatioValue(viewAspectRef.current));
      const mask = segmentPerson(video, { crop });
      if (!mask) return;

      fitCanvas(preview, crop.sw, crop.sh, 1280);
      const pctx = preview.getContext('2d');
      if (pctx) {
        const bg: CanvasImageSource | string = bgImage.complete && bgImage.naturalWidth ? bgImage : '#1f2937';
        drawPersonOverBackground(pctx, video, mask, bg, 2, crop);
      }

      if (isRecordingRef.current) {
        let rc = recordCanvasRef.current;
        if (!rc) {
          rc = document.createElement('canvas');
          recordCanvasRef.current = rc;
        }
        fitCanvas(rc, crop.sw, crop.sh, 1920);
        const rctx = rc.getContext('2d');
        if (rctx) {
          // Baked takes record exactly what the preview shows; otherwise green for a later key.
          const baked = bakedBackgroundRef.current ? virtualBgImageRef.current : null;
          if (baked) drawPersonOverBackground(rctx, video, mask, baked, 2, crop);
          else drawPersonOverGreen(rctx, video, mask, 2, crop);
        }
      }
    };

    ensureSegmenter()
      .then(() => {
        if (cancelled) return;
        virtualBgActiveRef.current = true;
        setVirtualBgStatus('on');
        raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (cancelled) return;
        virtualBgActiveRef.current = false;
        setVirtualBgStatus('unavailable');
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      virtualBgActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsVirtualBg, virtualBgUrl, shootingState === 'reviewing', currentScene?.id]);

  // Re-attach the live stream after review remounts the <video> (next scene / redo).
  useEffect(() => {
    if (shootingState === 'reviewing') return;
    const t = window.setTimeout(() => {
      if (streamRef.current) {
        const live = streamRef.current.getVideoTracks().some((track) => track.readyState === 'live');
        attachPreview();
        if (!live) void startCamera(facingMode);
      } else {
        void startCamera(facingMode);
      }
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shootingState, currentUserSceneIndex]);

  useEffect(() => {
    if (!handsFreeMode) {
      stopSpeechRecognition();
      setVoiceStatus('off');
      setHandsFreeHint('Voice commands off — tap to record / stop');
      return;
    }
    setHandsFreeHint('Voice on · say Action / Cut (or tap)');
    // Browser SpeechRecognition is fallback only when Cloud STT is down.
    if (liveSttStatus === 'error' || liveSttStatus === 'unsupported') {
      startSpeechRecognition(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFreeMode, liveSttStatus]);

  // Word-cursor teleprompter: phrase index derived from cursor; dwell is soft min-on-screen only
  useEffect(() => {
    if (shootingState !== 'recording' || recordingPaused || !hasSpokenLines || prompterUnits.length === 0)
      return;
    if (Date.now() - recordingStartedAtRef.current < 800) return;

    // Active recording time only — paused time would make the reader look behind.
    const elapsed = Math.max(0, recordingElapsedSec());
    const pace = estimateSpeechPace({
      units: prompterUnits,
      currentIndex: prompterLineIdx,
      spokenText: liveSpokenText,
      recordingElapsedSec: elapsed,
      speakingPace: currentScene?.delivery?.speakingPace,
    });
    setPaceStatus(pace.status);
    paceDwellRef.current = pace.suggestedDwellMs;

    const unit = prompterUnits[prompterLineIdx];
    if (!unit) return;

    // Pause-only units: soft hold for pauseAfter, then advance
    if (unit.isPauseOnly) {
      const pauseHold = Math.max(600, unit.pauseAfter * 1000);
      const heldFor = Date.now() - lineDwellAt;
      if (heldFor >= pauseHold) {
        setPrompterLineIdx((i) => Math.min(i + 1, prompterUnits.length - 1));
        setLineDwellAt(Date.now());
        return;
      }
      const t = window.setTimeout(() => {
        setPrompterLineIdx((i) => Math.min(i + 1, prompterUnits.length - 1));
        setLineDwellAt(Date.now());
      }, pauseHold - heldFor);
      return () => clearTimeout(t);
    }

    // Speech recognition reports a word ~0.3–0.7s after it is said, so waiting for the line's
    // last word makes every hand-off feel late. Hand off while the last word (two on long
    // lines) is being spoken — the reader is already looking at the next line by then.
    const lineStart = wordCursorAtPhraseStart(prompterUnits, prompterLineIdx);
    const lineWords = tokenizeSpeech(unit.text).length;
    const remaining = lineStart + lineWords - wordCursor;
    const lead = lineWords >= 10 ? 2 : lineWords >= 4 ? 1 : 0;
    const handoff = remaining > 0 && remaining <= lead && wordCursor > lineStart;
    const targetIdx = phraseIndexFromWordCursor(prompterUnits, wordCursor + (handoff ? remaining : 0));
    if (targetIdx <= prompterLineIdx) return;

    // Soft min-on-screen — do NOT require phrase text still present in spoken string
    const dwell = phraseDwellMs(unit, currentScene?.delivery?.speakingPace);
    const softMin = Math.max(450, Math.min(Math.round(dwell * 0.25), 1200));
    const heldFor = Date.now() - lineDwellAt;
    if (heldFor >= softMin) {
      setPrompterLineIdx((i) => Math.min(i + 1, targetIdx));
      setLineDwellAt(Date.now());
      return;
    }
    const t = window.setTimeout(() => {
      setPrompterLineIdx((i) => Math.min(i + 1, targetIdx));
      setLineDwellAt(Date.now());
    }, softMin - heldFor);
    return () => clearTimeout(t);
  }, [
    liveSpokenText,
    wordCursor,
    shootingState,
    recordingPaused,
    prompterUnits,
    prompterLineIdx,
    lineDwellAt,
    hasSpokenLines,
    currentScene?.delivery?.speakingPace,
  ]);

  // End-of-scene poller: cursor ≥ 90% + last phrase matched + ~1.2s silence → Cut cue
  useEffect(() => {
    if (
      shootingState !== 'recording' ||
      recordingPaused ||
      !hasSpokenLines ||
      prompterUnits.length === 0
    ) {
      return;
    }
    const scriptTokens = scriptTokensFromUnits(prompterUnits);
    if (!scriptTokens.length) return;
    const ratio = wordCursor / scriptTokens.length;
    if (ratio < 0.9) return;

    const tick = window.setInterval(() => {
      if (shootingStateRef.current !== 'recording' || recordingPausedRef.current) return;
      const lastUnit = prompterUnits[prompterUnits.length - 1];
      const spoken =
        `${finalsTextRef.current.join(' ')} ${interimTextRef.current}`.replace(/\s+/g, ' ').trim();
      const lastMatched =
        wordCursorRef.current >= scriptTokens.length ||
        (!!lastUnit && !lastUnit.isPauseOnly && phraseIsMatched(lastUnit.text, spoken)) ||
        (lastUnit?.isPauseOnly && wordCursorRef.current / scriptTokens.length >= 0.9);
      const silenceMs = Date.now() - lastSpokenTimestampRef.current;
      if (!lastMatched || silenceMs < 1200) return;
      setShowCutCue(true);
      if (handsFreeModeRef.current && !cutAutoStopArmedRef.current) {
        cutAutoStopArmedRef.current = true;
        setHandsFreeHint('Script complete — Cut');
        stopRecordingRef.current();
      }
    }, 300);
    return () => clearInterval(tick);
  }, [shootingState, recordingPaused, hasSpokenLines, prompterUnits, wordCursor]);

  // Temporary director cues — show at beat/phrase boundaries, then dismiss
  useEffect(() => {
    if (shootingState !== 'recording') {
      setLiveDirectorCue(null);
      return;
    }
    const cues: DirectorCue[] = [
      ...(currentScene?.directorCues || []),
      ...narrativeBeats.flatMap((b) => b.directorCues || []),
    ];
    if (!cues.length) return;

    let phraseCursor = 0;
    const beatStarts = narrativeBeats.map((b) => {
      const start = phraseCursor;
      phraseCursor += Math.max(1, splitIntoPhraseUnits(b.dialogue || '').length);
      return { id: b.id, start };
    });
    const atBeat = beatStarts.find((b) => b.start === prompterLineIdx);
    const match =
      cues.find((c) => typeof c.afterPhraseIndex === 'number' && c.afterPhraseIndex === prompterLineIdx) ||
      cues.find((c) => atBeat && c.atBeatId === atBeat.id) ||
      (prompterLineIdx === 0 ? cues[0] : null);
    if (!match) return;
    setLiveDirectorCue(match);
    const hold = match.holdMs || 2200;
    const t = window.setTimeout(() => setLiveDirectorCue(null), hold);
    return () => clearTimeout(t);
  }, [
    shootingState,
    prompterLineIdx,
    currentScene?.directorCues,
    narrativeBeats,
  ]);

  const toggleFacingMode = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') return;
    setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
  };

  // Live Fact Check — full accumulated transcript vs the same script the prompter shows
  const evaluateLiveSpeech = useCallback(
    async (spoken: string) => {
      if (!spoken.trim()) return;
      if (shootingStateRef.current !== 'recording') return;
      const sceneIdAtStart = currentSceneIdRef.current;
      factCheckSceneIdRef.current = sceneIdAtStart;
      // Always prefer full spokenForMatch so early hook lines are never dropped
      const cleanSpoken =
        `${finalsTextRef.current.join(' ')} ${interimTextRef.current}`.replace(/\s+/g, ' ').trim() ||
        spoken.trim();
      lastSpokenTimestampRef.current = Date.now();

      // Avoid repeating identical checks
      if (cleanSpoken.toLowerCase() === lastEvaluatedTextRef.current.toLowerCase()) {
        return;
      }
      lastEvaluatedTextRef.current = cleanSpoken;

      setIsCheckingFact(true);

      try {
        const res = await fetch('/api/live-fact-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            spokenText: cleanSpoken,
            // Same text the prompter shows (teleprompterPrompt or joined beat dialogue)
            expectedScript: expectedScriptRef.current || currentScene?.teleprompterPrompt || '',
            sceneContext: `${currentScene?.title || ''}. Instructions: ${
              currentScene?.plainInstruction || ''
            }`,
            projectTitle: project.title,
            sceneId: sceneIdAtStart,
          }),
        });

        const data: LiveFactCheckResult = await res.json();
        // Ignore stale responses from a previous scene/take
        if (currentSceneIdRef.current !== sceneIdAtStart) return;
        if (shootingStateRef.current !== 'recording') return;
        if (data) {
          const stamped = { ...data, timestamp: Date.now() };
          setFactCheckResult(stamped);
          setHudDismissed(false);
          if (data.status && data.status !== 'listening' && data.factCheckMessage) {
            setDirectorLog((prev) =>
              [
                {
                  t: Date.now(),
                  title: data.alertTitle || 'Director note',
                  message: data.factCheckMessage,
                  status: data.status,
                },
                ...prev,
              ].slice(0, 6)
            );
          }
        }
      } catch (err) {
        console.error('Fact check call error:', err);
      } finally {
        if (currentSceneIdRef.current === sceneIdAtStart) {
          setIsCheckingFact(false);
        }
      }
    },
    [currentScene, project.title]
  );

  // Debounced wrapper to avoid flooding API during streaming speech
  const queueSpeechEvaluation = useCallback(
    (spoken: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        evaluateLiveSpeech(spoken);
      }, 400);
    },
    [evaluateLiveSpeech]
  );

  useEffect(() => {
    queueSpeechRef.current = queueSpeechEvaluation;
  }, [queueSpeechEvaluation]);

  // Do not rewrite lastShootingSceneId on every mount/currentScene — that re-pinned
  // scene 1 after tab switches. Keep / Next / Retake already persist the pointer.

  // While recording: re-check accumulated speech for fact-check (does not start SR)
  useEffect(() => {
    if (shootingState !== 'recording') return;
    const tick = window.setInterval(() => {
      const spoken = (liveSpokenText || '').replace(/\s+/g, ' ').trim();
      if (spoken.length >= 12) queueSpeechRef.current(spoken);
    }, 7000);
    return () => clearInterval(tick);
  }, [shootingState, liveSpokenText]);

  // Start Countdown before take
  const initiateCountdown = () => {
    if (shootingStateRef.current !== 'ready') return;
    // Never record a plain-camera take by accident when the scene wants a virtual background.
    if (BROWSER_BAKE && wantsVirtualBg && !virtualBgActiveRef.current && !vbOverrideRef.current) {
      if (virtualBgStatus === 'unavailable') {
        setVbGate('unavailable');
        return;
      }
      setVbGate('waiting');
      const startedWait = Date.now();
      const poll = window.setInterval(() => {
        if (virtualBgActiveRef.current) {
          clearInterval(poll);
          setVbGate(null);
          initiateCountdownRef.current?.();
        } else if (Date.now() - startedWait > 5000) {
          clearInterval(poll);
          setVbGate('unavailable');
        }
      }, 200);
      return;
    }
    setVbGate(null);
    resetLiveDirector({ restartSpeech: false });
    setPrompterLineIdx(0);
    setLineDwellAt(Date.now());
    recordingStartedAtRef.current = 0;
    void liveSttRef.current?.resume();
    if (
      handsFreeModeRef.current &&
      (liveSttStatus === 'error' || liveSttStatus === 'unsupported')
    ) {
      startSpeechRecognition(true);
    }
    setShootingState('countdown');
    setCountdownNum(3);

    let count = 3;
    const timer = setInterval(() => {
      count -= 1;
      if (count > 0) {
        setCountdownNum(count);
      } else {
        clearInterval(timer);
        startRecording();
      }
    }, 1000);
  };

  useEffect(() => {
    initiateCountdownRef.current = initiateCountdown;
  });

  // Start recording — keep the single speech recognizer alive for Cut commands
  const startRecording = () => {
    // Nothing else may play while recording (a reviewed take, a preview, music).
    stopReviewPlayback();
    document.querySelectorAll('video, audio').forEach((el) => {
      const m = el as HTMLMediaElement;
      if (m !== videoRef.current && !m.paused) m.pause();
    });
    takeEpochRef.current += 1;
    liveSttRef.current?.beginTake();
    stopSpeechRecognition();
    setShootingState('recording');
    isRecordingRef.current = true;
    recordingPausedRef.current = false;
    spokenAtPauseRef.current = null;
    setRecordingPaused(false);
    recordingStartedAtRef.current = Date.now();
    setRecordingSeconds(0);
    recordedChunksRef.current = [];
    audioOnlyChunksRef.current = [];
    transcriptSegmentsRef.current = [];
    finalsTextRef.current = [];
    interimTextRef.current = '';
    wordCursorRef.current = 0;
    setWordCursor(0);
    setShowCutCue(false);
    cutAutoStopArmedRef.current = false;
    setLiveSpokenText('');
    setDirectorLog([]);
    setFactCheckResult({ ...DEFAULT_FACT_CHECK });
    setHudDismissed(false);
    setPrompterLineIdx(0);
    setLineDwellAt(Date.now());
    lastEvaluatedTextRef.current = '';
    lastSpokenTimestampRef.current = Date.now();
    factCheckSceneIdRef.current = currentSceneIdRef.current;

    if (videoRef.current) {
      videoRef.current.muted = true;
      videoRef.current.playsInline = true;
      void videoRef.current.play().catch(() => {});
    }

    // Start Cloud STT on this user-gesture path (required for Android Chrome)
    if (streamRef.current) {
      void startLiveAudioMonitor(streamRef.current).then((ok) => {
        if (!ok && handsFreeModeRef.current) {
          startSpeechRecognition(true);
        }
      });
    }

    // Start Video Recorder — iOS Safari needs mp4; desktop prefers webm
    if (streamRef.current) {
      try {
        const videoMimes = [
          'video/mp4',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp8',
          'video/webm',
        ];
        const mimeType = videoMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

        // Virtual background: the take is the plain camera; the server mattes it (RVM) and puts
        // you on the background after upload. The live composite is a preview only.
        // (BROWSER_BAKE re-enables recording the in-browser composite.)
        let recordSource: MediaStream = streamRef.current;
        recordCanvasStreamRef.current = null;
        bakedBackgroundRef.current = null;
        vbModeRef.current = wantsVirtualBg ? 'none' : undefined;
        vbOverrideRef.current = false;
        if (BROWSER_BAKE && virtualBgActiveRef.current && videoRef.current && segmentationAvailable()) {
          try {
            let rc = recordCanvasRef.current;
            if (!rc) {
              rc = document.createElement('canvas');
              recordCanvasRef.current = rc;
            }
            const v = videoRef.current;
            const crop = coverCrop(v.videoWidth, v.videoHeight, aspectRatioValue(viewAspectRef.current));
            if (v.videoWidth) {
              const scale = Math.min(1, 1920 / Math.max(crop.sw, crop.sh));
              rc.width = Math.max(2, Math.round(crop.sw * scale));
              rc.height = Math.max(2, Math.round(crop.sh * scale));
            }
            const bakeImage = virtualBgImageRef.current;
            const rctx = rc.getContext('2d');
            if (rctx) {
              // Prime the canvas with one frame so captureStream has content immediately.
              const first = segmentPerson(v, { crop });
              if (first && bakeImage) drawPersonOverBackground(rctx, v, first, bakeImage, 2, crop);
              else if (first) drawPersonOverGreen(rctx, v, first, 2, crop);
              else {
                rctx.fillStyle = CHROMA_GREEN;
                rctx.fillRect(0, 0, rc.width, rc.height);
              }
              bakedBackgroundRef.current = bakeImage ? sceneBgUrl || virtualBgUrl : null;
              vbModeRef.current = bakeImage ? 'baked' : 'green';
              const canvasStream = rc.captureStream(30);
              streamRef.current.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
              recordCanvasStreamRef.current = canvasStream;
              recordSource = canvasStream;
            }
          } catch (vbErr) {
            console.warn('Virtual background capture failed, recording raw camera:', vbErr);
            recordSource = streamRef.current;
            bakedBackgroundRef.current = null;
            vbModeRef.current = wantsVirtualBg ? 'none' : undefined;
          }
        }

        const recorderOpts: MediaRecorderOptions = {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: 8_000_000,
          audioBitsPerSecond: 128_000,
        };
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(recordSource, recorderOpts);
        } catch {
          recorder = mimeType
            ? new MediaRecorder(recordSource, { mimeType })
            : new MediaRecorder(recordSource);
        }
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };

        recorder.onstop = () => {
          recordCanvasStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
          recordCanvasStreamRef.current = null;
          const recordedType =
            (recorder.mimeType || mimeType || 'video/webm').split(';')[0].trim() || 'video/webm';
          const blob = new Blob(recordedChunksRef.current, { type: recordedType });
          const wallClockDuration = Math.round(recordingElapsedSec() * 100) / 100;
          let finalDuration = wallClockDuration || recordingSecondsRef.current || recordingSeconds || 0;
          recordingSecondsRef.current = Math.round(finalDuration);
          savedTakeRef.current = null;
          beginTakeUpload();
          setTakeSaveStatus('idle');
          setTakeSaveError(null);
          setRecordedBlob(blob);
          setShootingState('reviewing');
          setReviewPlaying(true);

          void (async () => {
            // The file's own duration wins when it is longer (it is the truth the export cuts from).
            const fileDuration = await probeBlobDuration(blob);
            if (fileDuration && fileDuration > finalDuration) finalDuration = Math.round(fileDuration * 100) / 100;
            // Save to IndexedDB immediately so reload or navigation never loses it
            const liveUrl = await saveTakeMedia(project.id, currentScene.id, blob, recordedType);
            setRecordedVideoUrl(liveUrl);

            // Immediately commit take to project state (drops the previous take's transcript/words)
            saveTakeToProject(
              '',
              liveUrl,
              finalDuration,
              undefined,
              { mimeType: recordedType, newTake: true }
            );

            const hasAudio = Boolean(streamRef.current?.getAudioTracks?.().length);
            if (!hasAudio) {
              console.warn('Take recorded without an audio track');
            }

            triggerAutoTranscription(
              blob,
              currentScene?.teleprompterPrompt || '',
              liveUrl,
              finalDuration,
              hasAudio
            );
          })();
        };

        recorder.start(250);
      } catch (e) {
        console.error('Recorder error:', e);
      }
    }

    // Live timer (fact-check / voice commands polled by live audio monitor). Display only — the
    // take's length comes from the wall clock, so a busy page can't shorten it.
    recActiveMsRef.current = 0;
    recSegmentStartRef.current = performance.now();
    recordingSecondsRef.current = 0;
    recordingTimerRef.current = window.setInterval(() => {
      const secs = Math.floor(recordingElapsedSec());
      recordingSecondsRef.current = secs;
      setRecordingSeconds(secs);
    }, 500);
  };

  // Stop recording — keep live audio monitor for next ready state
  const stopRecording = () => {
    if (recSegmentStartRef.current != null) {
      recActiveMsRef.current += performance.now() - recSegmentStartRef.current;
      recSegmentStartRef.current = null;
    }
    isRecordingRef.current = false;
    recordingPausedRef.current = false;
    setRecordingPaused(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else if (shootingStateRef.current === 'recording') {
      simulateDemoTake();
    }
  };

  const pauseRecording = () => {
    if (shootingStateRef.current !== 'recording' || recordingPausedRef.current) return;
    const rec = mediaRecorderRef.current;
    const audioRec = audioOnlyRecorderRef.current;
    try {
      if (rec && rec.state === 'recording' && typeof rec.pause === 'function') rec.pause();
      if (audioRec && audioRec.state === 'recording' && typeof audioRec.pause === 'function') {
        audioRec.pause();
      }
    } catch {
      /* pause unsupported — still freeze UI/prompter */
    }
    recordingPausedRef.current = true;
    setRecordingPaused(true);
    spokenAtPauseRef.current = `${finalsTextRef.current.join(' ')} ${interimTextRef.current}`.replace(/\s+/g, ' ').trim();
    if (recSegmentStartRef.current != null) {
      recActiveMsRef.current += performance.now() - recSegmentStartRef.current;
      recSegmentStartRef.current = null;
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const resumeRecording = () => {
    if (shootingStateRef.current !== 'recording' || !recordingPausedRef.current) return;
    const rec = mediaRecorderRef.current;
    const audioRec = audioOnlyRecorderRef.current;
    try {
      if (rec && rec.state === 'paused' && typeof rec.resume === 'function') rec.resume();
      if (audioRec && audioRec.state === 'paused' && typeof audioRec.resume === 'function') {
        audioRec.resume();
      }
    } catch {
      /* resume unsupported */
    }
    recordingPausedRef.current = false;
    setRecordingPaused(false);
    // Anything said while paused isn't in the take, so it must not move the prompter.
    if (spokenAtPauseRef.current != null) {
      finalsTextRef.current = spokenAtPauseRef.current ? [spokenAtPauseRef.current] : [];
      interimTextRef.current = '';
      spokenAtPauseRef.current = null;
      syncSpokenForMatch();
    }
    setLineDwellAt(Date.now());
    recSegmentStartRef.current = performance.now();
    if (!recordingTimerRef.current) {
      recordingTimerRef.current = window.setInterval(() => {
        const secs = Math.floor(recordingElapsedSec());
        recordingSecondsRef.current = secs;
        setRecordingSeconds(secs);
      }, 500);
    }
  };

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  });

  // Instant demo take for stage rehearsal (clearly labeled, no fake dialogue captions)
  const simulateDemoTake = async () => {
    const url = await createDemoVideoBlob(`Shot ${currentScene?.sceneNumber}: Simulated Take`);
    setRecordedVideoUrl(url);
    setRecordingSeconds(3);
    recordingSecondsRef.current = 3;
    setNoAudioWarning(true);
    setShootingState('reviewing');
    setTakeSaveStatus('idle');
    savedTakeRef.current = null;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      setRecordedBlob(blob);
    } catch {
      setRecordedBlob(null);
    }
    // Do not invent transcript from teleprompter for simulated takes
    saveTakeToProject('', url, 3);
  };

  const triggerAutoTranscription = async (
    blob: Blob | null,
    _promptLine: string,
    videoUrl: string,
    durationSeconds: number,
    hasAudio: boolean
  ) => {
    setIsTranscribing(true);
    setNoAudioWarning(!hasAudio);
    // Live finals are for sync/captions only — ALWAYS run full Chirp transcription
    // for the canonical transcript (never early-return when liveSegs exist).
    const liveSegs = transcriptSegmentsRef.current.filter((s) => s.text.trim());
    let transcriptResult = '';
    let segments: Array<{ start: number; end: number; text: string }> = [];
    let words: Array<{ w: string; start: number; end: number; conf?: number }> = [];

    if (blob && hasAudio) {
      try {
        // Prefer the GCS path (no request-size cap): wait for THIS take's upload to finish.
        let gcsUri = savedTakeRef.current?.gcsObjectPath || '';
        if (!gcsUri) {
          const pending = takeUploadRef.current?.promise;
          const uploaded = pending
            ? await Promise.race([
                pending,
                new Promise<null>((r) => setTimeout(() => r(null), TAKE_UPLOAD_WAIT_MS)),
              ])
            : null;
          gcsUri = uploaded || savedTakeRef.current?.gcsObjectPath || '';
        }

        if (gcsUri && !gcsUri.startsWith('blob:')) {
          const res = await fetch('/api/transcribe-gcs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gcsUri,
              mimeType: blob.type || 'video/webm',
              languageCode: spokenLangBcp47,
              durationSec: durationSeconds > 0 ? durationSeconds : undefined,
            }),
          });
          const data = await res.json();
          const txText = data?.transcript || data?.fullTranscript;
          if (data?.ok && txText) {
            transcriptResult = txText;
            segments = data.segments || data.transcriptSegments || [];
            words = Array.isArray(data.words) ? data.words : [];
          }
        }

        // Fallback: inline base64 — only for small takes (Cloud Run rejects requests over 32 MB).
        if (!transcriptResult.trim() && blob.size <= INLINE_TRANSCRIBE_MAX_BYTES) {
          const reader = new FileReader();
          const base64Promise = new Promise<string>((resolve) => {
            reader.onloadend = () => {
              const b64 = (reader.result as string)?.split(',')[1] || '';
              resolve(b64);
            };
            reader.readAsDataURL(blob);
          });
          const audioBase64 = await base64Promise;

          if (audioBase64) {
            const res = await fetch('/api/transcribe-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audioBase64,
                mimeType: blob.type || 'audio/webm',
                languageCode: spokenLangBcp47,
                durationSec: durationSeconds > 0 ? durationSeconds : undefined,
              }),
            });
            const data = await res.json();
            const txText = data?.transcript || data?.fullTranscript;
            if (data?.ok && txText) {
              transcriptResult = txText;
              segments = data.segments || data.transcriptSegments || [];
              words = Array.isArray(data.words) ? data.words : [];
            }
          }
        }
      } catch (err) {
        console.warn('Transcription notice:', err);
      }
    }

    const sttOk = Boolean(transcriptResult.trim());
    // Fallback to live captions only if full STT failed — never overwrite with live as primary when STT ok
    if (!transcriptResult.trim()) {
      transcriptResult =
        liveSegs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim() ||
        finalsTextRef.current.join(' ').trim() ||
        '';
      if (liveSegs.length) {
        const dur = durationSeconds > 0 ? durationSeconds : 60;
        const minStart = Math.min(...liveSegs.map((s) => s.start));
        const needRealign = minStart > 1.2 || liveSegs.some((s) => s.start >= dur);
        segments = needRealign
          ? liveSegs.map((s) => {
              const relStart = Math.max(0, s.start - minStart);
              const relEnd = Math.max(relStart + 0.3, s.end - minStart);
              return {
                ...s,
                start: Math.round(Math.min(Math.max(0, dur - 0.2), relStart) * 100) / 100,
                end: Math.round(Math.min(dur, relEnd) * 100) / 100,
              };
            })
          : liveSegs.map((s) => ({
              ...s,
              start: Math.round(Math.max(0, Math.min(dur - 0.2, s.start)) * 100) / 100,
              end: Math.round(Math.max(s.start + 0.2, Math.min(dur, s.end)) * 100) / 100,
            }));
        // Live finals may carry word timings — keep them (same realignment as segments) and keep segments clean
        const shift = needRealign ? minStart : 0;
        const liveWords = liveSegs.flatMap((s) => s.words || []);
        if (liveWords.length) {
          words = liveWords
            .map((w) => ({
              ...w,
              start: Math.round(Math.max(0, Math.min(dur - 0.05, w.start - shift)) * 1000) / 1000,
              end: Math.round(Math.max(0.05, Math.min(dur, w.end - shift)) * 1000) / 1000,
            }))
            .filter((w) => w.end > w.start);
        }
        segments = segments.map(({ words: _w, ...rest }: any) => rest);
      }
    }

    saveTakeToProject(transcriptResult, videoUrl, durationSeconds, segments, {
      words,
      wordsSource: words.length ? (sttOk ? 'stt' : 'live') : undefined,
    });
    setIsTranscribing(false);
  };

  const saveTakeToProject = (
    transcriptText: string,
    videoUrl: string | null,
    durationSeconds?: number,
    segments?: Array<{ start: number; end: number; text: string }>,
    extras?: {
      gcsObjectPath?: string;
      mimeType?: string;
      words?: Array<{ w: string; start: number; end: number; conf?: number }>;
      wordsSource?: 'stt' | 'live';
      /** First save of a fresh recording: forget the previous take's transcript and timings. */
      newTake?: boolean;
    }
  ) => {
    if (!currentScene) return;
    const sceneId = currentScene.id;
    const liveSnap =
      factCheckResult.status && factCheckResult.status !== 'listening'
        ? {
            status: factCheckResult.status,
            alertTitle: factCheckResult.alertTitle,
            factCheckMessage: factCheckResult.factCheckMessage,
            audienceConnectionScore: factCheckResult.audienceConnectionScore,
            connectionFeedback: factCheckResult.connectionFeedback,
            actionableTip: factCheckResult.actionableTip,
          }
        : undefined;
    const recordedDuration =
      durationSeconds && durationSeconds > 0
        ? durationSeconds
        : recordingSecondsRef.current || recordingSeconds || 5;

    onUpdateProject((prev) => {
      const nextProj = {
        ...prev,
        lastShootingSceneId: sceneId,
        scenes: prev.scenes.map((s) =>
          s.id === sceneId
            ? {
                ...s,
                ...(extras?.newTake
                  ? {
                      transcript: undefined,
                      transcriptSegments: undefined,
                      words: undefined,
                      wordsSource: undefined,
                      virtualBackgroundBaked: bakedBackgroundRef.current ? true : undefined,
                      virtualBackgroundMode: vbModeRef.current,
                      // A redo reuses the same upload path: the old matte must not stick.
                      matteStatus: undefined,
                      matteJobId: undefined,
                      matteProgress: undefined,
                      matteError: undefined,
                      mattedGcsPath: undefined,
                      mattedSourcePath: undefined,
                      mattedBackgroundUrl: undefined,
                      // Keep a reference, not a copy: inline data: images would bloat the project.
                      virtualBackgroundBakedUrl:
                        bakedBackgroundRef.current && !bakedBackgroundRef.current.startsWith('data:')
                          ? bakedBackgroundRef.current
                          : undefined,
                    }
                  : {}),
                userRecordedVideoUrl: videoUrl || s.userRecordedVideoUrl,
                transcript: transcriptText || (extras?.newTake ? undefined : s.transcript),
                transcriptSegments: segments?.length
                  ? segments
                  : extras?.newTake
                    ? undefined
                    : s.transcriptSegments,
                words: extras?.words?.length ? extras.words : extras?.newTake ? undefined : s.words,
                wordsSource: extras?.words?.length
                  ? extras.wordsSource
                  : extras?.newTake
                    ? undefined
                    : s.wordsSource,
                recordedDuration: recordedDuration || s.recordedDuration || s.durationSeconds || 5,
                gcsObjectPath: extras?.gcsObjectPath || s.gcsObjectPath,
                mimeType: extras?.mimeType || s.mimeType,
                mediaSource: s.mediaSource || 'recorded',
                includeInExport: true,
                liveFactCheck: liveSnap || s.liveFactCheck,
              }
            : s
        ),
      };
      void saveProjectLocally(nextProj, 'guided-shooting');
      return nextProj;
    });

    if (transcriptText || extras?.gcsObjectPath) {
      void analyzeTakeClaims({
        projectTitle: project.title,
        gcsUri: extras?.gcsObjectPath || currentScene.gcsObjectPath,
        mimeType: extras?.mimeType || currentScene.mimeType,
        transcript: transcriptText,
        segments,
        words: extras?.words,
        languageCode: spokenLangBcp47,
      }).then((analysis) => {
        onUpdateProject((prev) => {
          const next = {
            ...prev,
            lastShootingSceneId: sceneId,
            scenes: prev.scenes.map((s) =>
              s.id === sceneId
                ? {
                    ...s,
                    transcript: analysis.transcript || transcriptText || s.transcript,
                    transcriptSegments: analysis.segments.length
                      ? analysis.segments
                      : segments?.length
                        ? segments
                        : s.transcriptSegments,
                    words: analysis.words?.length ? analysis.words : extras?.words?.length ? extras.words : s.words,
                    wordsSource:
                      analysis.words?.length && !extras?.words?.length ? 'stt' : s.wordsSource,
                    factCheckClaims: analysis.claims,
                  }
                : s
            ),
          };
          void saveProjectLocally(next, 'guided-shooting');
          return next;
        });
      });
    }
  };

  /** Idempotent GCS persist — deterministic key source/{projectId}/{sceneId}. */
  const persistCurrentTake = useCallback(
    async (blob: Blob, previewUrl: string | null, durationSeconds: number) => {
      if (!currentScene) return;
      if (!blob || blob.size < 256) {
        setTakeSaveStatus('error');
        setTakeSaveError('Recording was empty — tap Redo, then record again');
        return;
      }
      // Only skip re-upload when THIS review session already saved
      if (savedTakeRef.current?.gcsObjectPath) {
        takeUploadRef.current?.resolve(savedTakeRef.current.gcsObjectPath);
        setTakeSaveStatus('saved');
        return;
      }
      const gen = ++takePersistGenRef.current;
      setTakeSaveStatus('saving');
      setTakeSaveError(null);
      try {
        const mime = inferVideoMime(blob, (blob as File).name);
        // Ensure take is saved locally in IndexedDB
        await saveTakeMedia(project.id, currentScene.id, blob, mime);
        const persisted = await persistTakeBlob(blob, project.id, currentScene.id, mime);
        if (gen !== takePersistGenRef.current) return;
        savedTakeRef.current = {
          gcsObjectPath: persisted.gcsUri,
          mimeType: persisted.mimeType,
        };
        takeUploadRef.current?.resolve(persisted.gcsUri);
        // Do NOT overwrite canonical transcript with liveSpokenText — only attach GCS path.
        // Full /api/transcribe-audio runs in triggerAutoTranscription.
        saveTakeToProject(
          currentScene.transcript || '',
          previewUrl,
          durationSeconds,
          currentScene.transcriptSegments,
          { gcsObjectPath: persisted.gcsUri, mimeType: persisted.mimeType }
        );
        kickProxyBuild({
          gcsObjectPath: persisted.gcsUri,
          projectId: project.id,
          sceneId: currentScene.id,
          durationSec: durationSeconds,
          onReady: (proxyUrl) => {
            onUpdateProject((prev) => ({
              ...prev,
              scenes: prev.scenes.map((s) =>
                s.id === currentScene.id ? { ...s, proxyUrl } : s
              ),
            }));
          },
        });
        setTakeSaveStatus('saved');
      } catch (err: any) {
        if (gen !== takePersistGenRef.current) return;
        console.warn('Take persist failed:', err);
        takeUploadRef.current?.resolve(null);
        setTakeSaveStatus('error');
        setTakeSaveError(err?.message || 'Upload failed');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentScene, project.id]
  );

  // Auto-save to GCS as soon as a take blob is ready for review
  useEffect(() => {
    if (shootingState !== 'reviewing' || !recordedBlob || !currentScene) return;
    if (takeSaveStatus === 'saving' || takeSaveStatus === 'saved') return;
    // Always upload the new blob for this review session (don't trust stale gcsObjectPath)
    void persistCurrentTake(
      recordedBlob,
      recordedVideoUrl,
      recordingSecondsRef.current || recordingSeconds
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shootingState, recordedBlob, currentScene?.id]);

  /** Stop the take that was being reviewed so it can never play over the next recording. */
  const stopReviewPlayback = () => {
    const v = reviewVideoRef.current;
    if (v) {
      try {
        v.pause();
        v.muted = true;
        v.removeAttribute('src');
        v.load();
      } catch {
        /* element already gone */
      }
    }
    setReviewPlaying(false);
  };

  /** Move to any shot (next, previous, or picked from the shot strip) with a clean slate. */
  const goToShot = (index: number) => {
    if (index < 0 || index >= totalUserScenes) return;
    if (shootingStateRef.current === 'recording' || shootingStateRef.current === 'countdown') return;
    stopReviewPlayback();
    savedTakeRef.current = null;
    setTakeSaveStatus('idle');
    setTakeSaveError(null);
    setCurrentUserSceneIndex(index);
    setShootingState('ready');
    setRecordedVideoUrl(null);
    setRecordedBlob(null);
    setRecordingSeconds(0);
    recordingSecondsRef.current = 0;
    recordingStartedAtRef.current = 0;
    setNoAudioWarning(false);
    setHudDismissed(false);
    // The teleprompter starts at the top of the new shot's lines, with nothing heard yet.
    setPrompterLineIdx(0);
    setLineDwellAt(Date.now());
    wordCursorRef.current = 0;
    setWordCursor(0);
    finalsTextRef.current = [];
    interimTextRef.current = '';
    setLiveSpokenText('');
    transcriptSegmentsRef.current = [];
    resetLiveDirector({ restartSpeech: false });
    window.setTimeout(() => {
      if (handsFreeModeRef.current) startSpeechRecognition(true);
    }, 400);
  };

  const handleRedoShot = () => {
    stopReviewPlayback();
    takePersistGenRef.current += 1;
    takeEpochRef.current += 1;
    liveSttRef.current?.beginTake();
    stopSpeechRecognition();
    savedTakeRef.current = null;
    setTakeSaveStatus('idle');
    setTakeSaveError(null);
    setForceRecordWithoutVb(false);
    setShootingState('ready');
    setRecordedVideoUrl(null);
    setRecordedBlob(null);
    setRecordingSeconds(0);
    recordingStartedAtRef.current = 0;
    setHudDismissed(false);
    setPrompterLineIdx(0);
    setLineDwellAt(Date.now());
    setLiveSpokenText('');
    transcriptSegmentsRef.current = [];
    resetLiveDirector({ restartSpeech: false });
    // Clear durable path so redo re-uploads the new take to the same key
    if (currentScene) {
      const sceneId = currentScene.id;
      onUpdateProject((prev) => ({
        ...prev,
        scenes: prev.scenes.map((s) =>
          s.id === sceneId
            ? {
                ...s,
                gcsObjectPath: undefined,
                mimeType: undefined,
                userRecordedVideoUrl: undefined,
                words: undefined,
                wordsSource: undefined,
                virtualBackgroundBaked: undefined,
                virtualBackgroundBakedUrl: undefined,
                virtualBackgroundMode: undefined,
                matteStatus: undefined,
                matteJobId: undefined,
                mattedGcsPath: undefined,
                mattedSourcePath: undefined,
                mattedBackgroundUrl: undefined,
              }
            : s
        ),
      }));
    }
    window.setTimeout(() => {
      if (handsFreeModeRef.current) startSpeechRecognition(true);
    }, 400);
  };

  const handleKeepShot = () => {
    const saved = savedTakeRef.current;
    const gcsPath = saved?.gcsObjectPath || currentScene?.gcsObjectPath;
    const mime = saved?.mimeType || currentScene?.mimeType;
    if (takeSaveStatus !== 'saved' || !gcsPath) {
      if (recordedBlob) {
        void persistCurrentTake(
          recordedBlob,
          recordedVideoUrl,
          recordingSecondsRef.current || recordingSeconds
        );
      }
      return;
    }

    // Preserve canonical transcript from /api/transcribe-audio — never overwrite with live STT
    saveTakeToProject(
      currentScene?.transcript || '',
      recordedVideoUrl,
      recordingSecondsRef.current || recordingSeconds,
      currentScene?.transcriptSegments,
      { gcsObjectPath: gcsPath, mimeType: mime }
    );

    takePersistGenRef.current += 1;
    // Next shot still to film (shots can be filmed in any order); otherwise we're done.
    const nextOpen = userScenes.findIndex(
      (s, i) => i !== currentUserSceneIndex && !sceneHasTake(s) && s.captureStatus !== 'upload' && s.captureStatus !== 'skipped'
    );
    const nextIndex =
      currentUserSceneIndex < totalUserScenes - 1 && !sceneHasTake(userScenes[currentUserSceneIndex + 1])
        ? currentUserSceneIndex + 1
        : nextOpen;
    if (nextIndex >= 0) {
      goToShot(nextIndex);
    } else {
      stopReviewPlayback();
      onFinishShooting();
    }
  };

  const skipOptionalInserts = () => {
    // Mark remaining optional inserts as skipped (do not silently abandon status)
    onUpdateProject((prev) => {
      const remainingIds = new Set(
        userScenes.slice(currentUserSceneIndex).filter((s) => s.optionalInsert).map((s) => s.id)
      );
      const scenes = prev.scenes.map((s) => {
        if (!remainingIds.has(s.id)) return s;
        if (sceneHasTake(s)) return s;
        return { ...s, captureStatus: 'skipped' as const };
      });
      return { ...prev, scenes };
    });
    onFinishShooting();
  };

  /** Required scenes can defer capture — mark upload-later and advance. */
  const markUploadLater = () => {
    if (!currentScene || currentScene.optionalInsert) return;
    onUpdateProject((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === currentScene.id ? { ...s, captureStatus: 'upload' as const } : s
      ),
    }));
    if (currentUserSceneIndex < totalUserScenes - 1) {
      goToShot(currentUserSceneIndex + 1);
    } else {
      stopReviewPlayback();
      onFinishShooting();
    }
  };

  const handleUploadFootage = async (file: File) => {
    if (!currentScene || !file) return;
    const mime = inferVideoMime(file, file.name);
    // 1. Immediately store binary in IndexedDB media vault
    const liveUrl = await saveTakeMedia(project.id, currentScene.id, file, mime);

    savedTakeRef.current = null;
    setTakeSaveStatus('idle');
    setTakeSaveError(null);
    setRecordedVideoUrl(liveUrl);
    setRecordedBlob(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = liveUrl;
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => resolve();
      setTimeout(() => resolve(), 2000);
    });
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10;
    setRecordingSeconds(Math.round(dur));
    recordingSecondsRef.current = Math.round(dur);
    setShootingState('reviewing');
    setNoAudioWarning(false);
    setReviewPlaying(true);

    // 2. Immediately save to project state so navigation never loses it
    bakedBackgroundRef.current = null;
    saveTakeToProject('', liveUrl, Math.round(dur), undefined, { mimeType: mime, newTake: true });

    // 3. Persist to GCS in the background
    savedTakeRef.current = null;
    beginTakeUpload();
    void persistCurrentTake(file, liveUrl, Math.round(dur));
    await triggerAutoTranscription(file, '', liveUrl, Math.round(dur), true);
  };

  // Force the take to play on review (mobile Chrome blocks muted-less autoplay otherwise)
  useEffect(() => {
    if (shootingState !== 'reviewing' || !recordedVideoUrl) return;
    const v = reviewVideoRef.current;
    if (!v) return;
    v.src = recordedVideoUrl;
    v.muted = false;
    v.playsInline = true;
    v.controls = true;
    const tryPlay = () => {
      void v.play().then(() => setReviewPlaying(true)).catch(() => {
        setReviewPlaying(false);
      });
    };
    if (v.readyState >= 2) tryPlay();
    else v.onloadeddata = tryPlay;
    return () => {
      v.onloadeddata = null;
      // Leaving review (or swapping the clip): never let this element keep playing.
      v.pause();
    };
  }, [shootingState, recordedVideoUrl]);

  // Determine viewport glow border based on live status
  const getViewportRingClass = () => {
    if (shootingState !== 'recording') return 'border-neutral-800';
    if (factCheckResult.status === 'alert')
      return 'border-rose-500 shadow-[0_0_30px_rgba(239,68,68,0.4)] ring-2 ring-rose-500/60';
    if (factCheckResult.status === 'warning')
      return 'border-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.4)] ring-2 ring-amber-500/60';
    if (factCheckResult.status === 'verified')
      return 'border-emerald-500/80 shadow-[0_0_20px_rgba(34,197,94,0.3)] ring-1 ring-emerald-500/50';
    return 'border-neutral-800';
  };

  const scoreLabel =
    factCheckResult.audienceConnectionScore == null
      ? '—'
      : `${factCheckResult.audienceConnectionScore}%`;
  const scoreWidth = factCheckResult.audienceConnectionScore ?? 0;
  const hudPhase = isCheckingFact
    ? 'Checking claim'
    : factCheckResult.status === 'alert' || factCheckResult.status === 'warning'
      ? 'Needs review'
      : factCheckResult.status === 'verified'
        ? 'Verified'
        : liveSttStatus === 'transcribing'
          ? 'Transcribing'
          : liveSttStatus === 'reconnecting'
            ? 'Reconnecting'
            : 'Listening';
  const currentLine = hasSpokenLines
    ? prompterLines[Math.min(prompterLineIdx, Math.max(0, prompterLines.length - 1))] ||
      prompterSource
    : directorCue.capture;
  const nextLine =
    hasSpokenLines && prompterLineIdx < prompterLines.length - 1
      ? prompterLines[prompterLineIdx + 1]
      : null;
  const paceLabel =
    paceStatus === 'ahead'
      ? 'Ahead of script'
      : paceStatus === 'behind'
        ? 'Behind — holding this line'
        : 'On pace';
  const waitingForSpeech =
    shootingState === 'recording' && hasSpokenLines && !(liveSpokenText || '').trim();

  return (
    <div className="flex-1 min-h-0 overflow-hidden md:min-h-[calc(100dvh-65px)] md:flex-none md:overflow-x-hidden bg-[#F8F9FA] flex flex-col items-center p-2 sm:p-3 md:p-6 text-[#202124] select-none">
      {showOutputSheet && (
        <div className="fixed inset-0 z-[70] bg-black/45 flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#1A73E8]">
                Before you shoot
              </p>
              <h2 className="text-lg font-extrabold text-[#202124]">Choose the output format</h2>
              <p className="text-xs text-[#5F6368] mt-1">
                You&apos;re holding the phone in {devicePortrait ? 'portrait' : 'landscape'} —{' '}
                <strong>{recommendedAspect}</strong> is recommended so your face is not cropped.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  { id: '16:9' as AspectRatio, label: '16:9 Landscape', Icon: Monitor },
                  { id: '9:16' as AspectRatio, label: '9:16 Portrait', Icon: Smartphone },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => persistAspect(opt.id, false)}
                  className={`rounded-2xl border-2 p-4 text-left cursor-pointer ${
                    viewAspectRatio === opt.id
                      ? 'border-[#1A73E8] bg-[#E8F0FE]'
                      : 'border-[#DADCE0] bg-white'
                  }`}
                >
                  <opt.Icon className="w-5 h-5 text-[#1A73E8] mb-2" />
                  <p className="text-sm font-bold text-[#202124]">{opt.label}</p>
                  {opt.id === recommendedAspect ? (
                    <p className="text-[11px] font-semibold text-[#137333] mt-1">Recommended</p>
                  ) : (
                    <p className="text-[11px] text-[#80868B] mt-1">Can crop if you film the other way</p>
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                persistAspect(viewAspectRatio, true);
                setShowOutputSheet(false);
              }}
              className="w-full py-3 rounded-xl bg-[#1A73E8] text-white text-sm font-bold cursor-pointer"
            >
              Use {viewAspectRatio}
            </button>
          </div>
        </div>
      )}
      {filmingMismatch && (
        <div className="w-full max-w-5xl mb-2 px-3 py-2 rounded-xl bg-[#FEF7E0] border border-[#FEEFC3] text-[11px] text-[#5C3800] flex items-center justify-between gap-2">
          <span>
            You&apos;re filming {devicePortrait ? 'portrait' : 'landscape'} but the output is{' '}
            {viewAspectRatio} — switch?
          </span>
          <button
            type="button"
            onClick={() => persistAspect(recommendedAspect)}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#1A73E8] cursor-pointer"
          >
            Use {recommendedAspect}
          </button>
        </div>
      )}
      <div className="w-full max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2 mb-2 sm:mb-3 min-w-0 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[#34A853] animate-pulse" />
          <span className="text-xs md:text-sm font-bold truncate">
            {isSingleTake
              ? shootingState === 'recording'
                ? `RECORDING — TAKE ${takeNumber}`
                : `Take ${takeNumber}`
              : `Shot ${currentUserSceneIndex + 1} of ${totalUserScenes}`}
          </span>
          <span className="text-[11px] text-[#5F6368] bg-white px-2 py-0.5 rounded-md border border-[#DADCE0] shrink-0">
            {isSingleTake
              ? `${Math.max(1, narrativeBeats.length)} story beats · 1 recording`
              : isOptionalInsert
                ? 'Optional insert — skip if you only want the main take'
                : `Scene #${currentScene?.sceneNumber}`}
          </span>
        </div>
        {!isSingleTake && totalUserScenes > 1 ? (
          <nav aria-label="Shots" className="flex items-center gap-1 flex-wrap">
            {userScenes.map((sc, i) => {
              const done = sceneHasTake(sc);
              const active = i === currentUserSceneIndex;
              const locked =
                shootingState === 'recording' ||
                shootingState === 'countdown' ||
                (shootingState === 'reviewing' && takeSaveStatus === 'saving');
              return (
                <button
                  key={sc.id}
                  type="button"
                  disabled={locked || active}
                  onClick={() => goToShot(i)}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Shot ${i + 1}: ${sc.title}${done ? ' (filmed)' : ''}`}
                  title={
                    locked && !active
                      ? shootingState === 'reviewing'
                        ? 'Saving this take…'
                        : 'Finish recording first'
                      : `${sc.title}${done ? ' · filmed — tap to retake' : ''}`
                  }
                  className={`h-7 min-w-7 px-2 rounded-full text-xs font-bold tabular-nums inline-flex items-center justify-center gap-1 transition-colors ${
                    active
                      ? 'bg-[#1A73E8] text-white'
                      : done
                        ? 'bg-[#E6F4EA] text-[#137333] hover:bg-[#CEEAD6]'
                        : 'bg-white text-[#3C4043] border border-[#DADCE0] hover:bg-[#F1F3F4]'
                  } ${locked && !active ? 'opacity-50 cursor-not-allowed' : active ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  {done && !active ? <Check className="w-3 h-3" /> : null}
                  {i + 1}
                </button>
              );
            })}
          </nav>
        ) : (
        <div className="flex items-center gap-1.5 flex-1 max-w-[160px]">
          {(isSingleTake && narrativeBeats.length ? narrativeBeats : isSingleTake ? narrativeBeats : userScenes).map((item, i) => {
            const currentBeatId =
              prompterUnits[prompterLineIdx] && 'beatId' in prompterUnits[prompterLineIdx]
                ? (prompterUnits[prompterLineIdx] as { beatId?: string }).beatId
                : narrativeBeats[0]?.id;
            const beatIdx = narrativeBeats.findIndex((b) => b.id === currentBeatId);
            const done = !isSingleTake && sceneHasTake(item as (typeof userScenes)[number]);
            return (
            <div
              key={i}
              className={`h-1.5 rounded-full flex-1 ${
                isSingleTake
                  ? i <= Math.max(0, beatIdx)
                    ? 'bg-[#1A73E8]'
                    : 'bg-[#DADCE0]'
                  : done
                    ? 'bg-[#34A853]'
                    : i === currentUserSceneIndex
                      ? 'bg-[#1A73E8] animate-pulse'
                      : 'bg-[#DADCE0]'
              }`}
            />
            );
          })}
        </div>
        )}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              const next = !handsFreeMode;
              setHandsFreeMode(next);
              if (next && streamRef.current) {
                startLiveAudioMonitor(streamRef.current);
                startSpeechRecognition(true);
              }
            }}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-semibold cursor-pointer ${
              handsFreeMode
                ? 'bg-[#E6F4EA] border-[#CEEAD6] text-[#137333]'
                : 'bg-white border-[#DADCE0] text-[#5F6368]'
            }`}
            title="Voice Action / Cut commands"
          >
            <Mic className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Voice Action/Cut</span>
            <span className="sm:hidden">{handsFreeMode ? 'Voice On' : 'Voice Off'}</span>
          </button>
          <button
            onClick={() => persistAspect(viewAspectRatio === '9:16' ? '16:9' : '9:16')}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border border-[#DADCE0] text-xs font-semibold cursor-pointer"
          >
            {viewAspectRatio === '16:9' ? (
              <>
                <Monitor className="w-3.5 h-3.5 text-[#1A73E8]" />
                <span>16:9</span>
              </>
            ) : (
              <>
                <Smartphone className="w-3.5 h-3.5 text-[#1A73E8]" />
                <span>9:16</span>
              </>
            )}
          </button>
          <button
            onClick={toggleFacingMode}
            className="p-2 rounded-xl bg-white border border-[#DADCE0] cursor-pointer"
            title="Flip Camera"
          >
            <SwitchCamera className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="w-full max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-2 lg:gap-5 items-stretch lg:items-start flex-1 min-h-0">
        {/* Camera / review — flex so phone fits camera + compact radar + controls */}
        <div className="lg:col-span-7 flex flex-col items-center gap-2 min-h-0 flex-1 w-full">
          <div
            className={`w-full bg-neutral-900 rounded-2xl sm:rounded-3xl overflow-hidden relative shadow-2xl border transition-all flex flex-col min-h-0 ${getViewportRingClass()} ${
              viewAspectRatio === '16:9'
                ? 'flex-1 min-h-[240px] sm:min-h-[420px] md:min-h-[520px]'
                : 'flex-1 max-w-md sm:h-[min(64vh,640px)] sm:flex-none'
            }`}
          >
            {shootingState === 'reviewing' && recordedVideoUrl ? (
              <video
                key={recordedVideoUrl}
                ref={reviewVideoRef}
                src={recordedVideoUrl}
                playsInline
                controls
                autoPlay
                className="absolute inset-0 w-full h-full object-contain bg-black z-0"
                onPlay={() => setReviewPlaying(true)}
                onPause={() => setReviewPlaying(false)}
              />
            ) : (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`absolute inset-0 w-full h-full object-cover z-0 ${
                  facingMode === 'user' ? 'scale-x-[-1]' : ''
                }`}
              />
            )}

            {shootingState !== 'reviewing' && wantsVirtualBg && (
              <canvas
                ref={previewCanvasRef}
                className={`absolute inset-0 w-full h-full object-cover z-[1] transition-opacity ${
                  virtualBgStatus === 'on' ? 'opacity-100' : 'opacity-0'
                } ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
              />
            )}

            <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/25 via-transparent to-black/45 z-10" />

            {shootingState === 'ready' && !cameraError && currentScene && !setupHiddenFor[currentScene.id] && (
              <ShotSetupSheet
                scene={currentScene}
                heading={isSingleTake ? 'Main take' : `Shot ${takeNumber} of ${totalUserScenes}`}
                isSingleTake={isSingleTake}
                wantsVirtualBg={wantsVirtualBg}
                recordBlocked={
                  wantsVirtualBg &&
                  !forceRecordWithoutVb &&
                  virtualBgStatus !== 'on' &&
                  virtualBgStatus !== 'unavailable'
                }
                onHide={() => setSetupHiddenFor((m) => ({ ...m, [currentScene.id]: true }))}
                onStart={() => {
                  setSetupHiddenFor((m) => ({ ...m, [currentScene.id]: true }));
                  if (streamRef.current) void startLiveAudioMonitor(streamRef.current);
                  if (handsFreeMode) startSpeechRecognition(true);
                  initiateCountdown();
                }}
              />
            )}

            {cameraError && shootingState !== 'reviewing' && (
              <div className="absolute inset-0 bg-neutral-950/85 z-30 p-6 flex flex-col items-center justify-center text-center space-y-4">
                <Camera className="w-8 h-8 text-amber-300" />
                <p className="text-sm text-neutral-300 max-w-xs">{cameraError}</p>
                <button
                  onClick={simulateDemoTake}
                  className="px-5 py-2.5 rounded-xl font-bold bg-[#1A73E8] text-white text-xs cursor-pointer"
                >
                  Simulate Actor Take
                </button>
              </div>
            )}

            {shootingState === 'countdown' && (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/55">
                <div className="text-8xl font-black text-amber-400">{countdownNum}</div>
                <p className="text-base font-semibold mt-2 text-white">Get ready…</p>
              </div>
            )}

            {shootingState !== 'reviewing' && (
              <div className="relative z-20 flex flex-col h-full min-h-0">
                <div className="p-3 space-y-1.5 shrink-0 pointer-events-none">
                  {wantsVirtualBg && virtualBgStatus === 'on' && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/90 text-white text-[11px] font-bold">
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                      Virtual background ON
                    </div>
                  )}
                  {wantsVirtualBg && virtualBgStatus === 'loading' && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 text-white text-[11px] font-bold">
                      Loading virtual background…
                    </div>
                  )}
                  {wantsVirtualBg && virtualBgStatus === 'unavailable' && !vbGate && (
                    <div className="max-w-[92%] rounded-xl px-2.5 py-1.5 text-[11px] font-semibold leading-snug bg-amber-500/95 text-black">
                      Live preview of the background isn&rsquo;t available on this device. Record as
                      usual — the background is added after the take uploads.
                    </div>
                  )}
                  {vbGate === 'waiting' && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px] font-bold">
                      Getting your virtual background ready…
                    </div>
                  )}
                  {vbGate === 'unavailable' && (
                    <div
                      role="alertdialog"
                      aria-label="Virtual background not ready"
                      className="pointer-events-auto max-w-[340px] rounded-xl bg-white text-[#202124] p-3 space-y-2 shadow-lg"
                    >
                      <p className="text-sm font-bold">Background removal isn&rsquo;t ready on this device</p>
                      <p className="text-xs text-[#5F6368] leading-snug">
                        If you record now, the take uses your real background. You can still add the
                        virtual one afterwards with Apply background in the Master Cut.
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            vbOverrideRef.current = true;
                            setVbGate(null);
                            initiateCountdown();
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[#1A73E8] text-white text-xs font-bold cursor-pointer"
                        >
                          Record anyway
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setVbGate(null);
                            // Still loading (slow network) → wait again; failed for good → just close.
                            if (virtualBgStatus === 'loading') initiateCountdown();
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[#F1F3F4] text-[#3C4043] text-xs font-bold cursor-pointer"
                        >
                          {virtualBgStatus === 'loading' ? 'Keep waiting' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  )}
                  {shootingState === 'recording' ? (
                    <div className="space-y-1.5">
                      <div
                        className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-white text-xs font-bold pointer-events-auto ${
                          recordingPaused ? 'bg-amber-600/95' : 'bg-red-600/90'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full bg-white ${
                            recordingPaused ? '' : 'animate-ping'
                          }`}
                        />
                        {recordingPaused
                          ? `PAUSED ${formatDuration(recordingSeconds)}`
                          : isSingleTake
                            ? `RECORDING — TAKE ${takeNumber} ${formatDuration(recordingSeconds)}`
                            : `REC ${formatDuration(recordingSeconds)}`}
                      </div>
                      <div
                        className={`lg:hidden max-w-[92%] rounded-xl px-2.5 py-1.5 text-[11px] font-semibold leading-snug pointer-events-none ${
                          factCheckResult.status === 'alert'
                            ? 'bg-rose-600/90 text-white'
                            : factCheckResult.status === 'warning'
                              ? 'bg-amber-500/90 text-black'
                              : 'bg-black/70 text-white'
                        }`}
                      >
                        <div className="font-bold">{factCheckResult.alertTitle || hudPhase}</div>
                        <p className="line-clamp-2">
                          {factCheckResult.factCheckMessage ||
                            (liveSpokenText
                              ? `Hearing: ${liveSpokenText.slice(-80)}`
                              : 'Listening — speak naturally.')}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          currentScene && setSetupHiddenFor((m) => ({ ...m, [currentScene.id]: false }))
                        }
                        className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/55 border border-white/15 text-amber-300 text-xs font-bold hover:bg-black/70 transition-colors cursor-pointer"
                      >
                        <Smile className="w-3.5 h-3.5" />
                        {isSingleTake ? 'Continuous take' : "Director's positioning"}
                        <span className="text-white/70 font-semibold">· setup</span>
                      </button>
                      <p className="text-xs font-semibold text-white/90 leading-snug drop-shadow-md line-clamp-2 max-w-[92%]">
                        {isSingleTake
                          ? 'Speak the beats in one take. Camera stays on your face.'
                          : isOptionalInsert
                            ? currentScene?.plainInstruction ||
                              'Optional insert. Skip if you already have the main take.'
                            : currentScene?.plainInstruction}
                      </p>
                    </>
                  )}
                  {handsFreeMode && shootingState !== 'recording' && (
                    <p className="text-[11px] text-emerald-200/90 font-medium flex items-center gap-1 pointer-events-auto">
                      <Mic className="w-3 h-3" />
                      {handsFreeHint}
                      {voiceStatus === 'needs-gesture' && (
                        <button
                          type="button"
                          onClick={() => {
                            if (streamRef.current) startLiveAudioMonitor(streamRef.current);
                            startSpeechRecognition(true);
                          }}
                          className="ml-1 px-2 py-0.5 rounded-full bg-[#1A73E8] text-white text-[10px] font-bold cursor-pointer"
                        >
                          Enable voice
                        </button>
                      )}
                    </p>
                  )}
                </div>

                <div className="flex-1" />

                <div className="p-2 sm:p-3 space-y-1.5 bg-gradient-to-t from-black/70 via-black/40 to-transparent shrink-0 pb-3 flex flex-col min-h-0">
                  <div className="max-h-[28vh] overflow-y-auto min-h-0 overscroll-contain">
                    <SmartTeleprompter
                      units={hasSpokenLines ? prompterUnits : []}
                      currentIndex={prompterLineIdx}
                      nextText={nextLine}
                      farType={farPrompter}
                      opacity={prompterOpacity}
                      onOpacity={setPrompterOpacity}
                      onToggleType={() => setFarPrompter((v) => !v)}
                      visualCue={
                        hasSpokenLines
                          ? null
                          : { capture: directorCue.capture, action: directorCue.action }
                      }
                      liveCue={liveDirectorCue}
                      offsetY={prompterOffsetY}
                      onOffsetY={setPrompterOffsetY}
                      compact
                      waitingForSpeech={waitingForSpeech}
                      beatLabel={isSingleTake ? currentBeatLabel : null}
                      onSkip={() => {
                        if (recordingPaused) return;
                        if (prompterLineIdx < prompterUnits.length - 1) {
                          const nextIdx = prompterLineIdx + 1;
                          const cursorAt = wordCursorAtPhraseStart(prompterUnits, nextIdx);
                          wordCursorRef.current = Math.max(wordCursorRef.current, cursorAt);
                          setWordCursor(wordCursorRef.current);
                          setPrompterLineIdx(nextIdx);
                          setLineDwellAt(Date.now());
                        }
                      }}
                    />
                    {shootingState === 'recording' && showCutCue && !recordingPaused && (
                      <div className="flex justify-center mt-1">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-500 text-white text-sm font-black tracking-wide shadow-lg animate-pulse">
                          CUT
                          {!handsFreeMode && (
                            <span className="text-[10px] font-semibold opacity-90">tap stop</span>
                          )}
                        </div>
                      </div>
                    )}
                    {shootingState === 'recording' && recordingPaused && (
                      <p className="text-center text-[11px] text-amber-200 font-bold mt-1 tracking-wide">
                        Paused
                      </p>
                    )}
                    {shootingState === 'recording' &&
                      hasSpokenLines &&
                      !showCutCue &&
                      !recordingPaused && (
                        <p className="text-center text-[10px] text-white/50 font-semibold mt-0.5">
                          {waitingForSpeech ? 'Waiting for this line…' : paceLabel}
                        </p>
                      )}
                  </div>

                  <div className="shrink-0 pt-0.5">
                  {shootingState === 'ready' && (
                    <div className="flex flex-col items-center gap-1">
                      {(() => {
                        const vbBlocking =
                          wantsVirtualBg &&
                          !forceRecordWithoutVb &&
                          virtualBgStatus !== 'on' &&
                          virtualBgStatus !== 'unavailable';
                        return (
                          <>
                      <button
                        disabled={vbBlocking}
                        onClick={() => {
                          if (vbBlocking) return;
                          if (streamRef.current) void startLiveAudioMonitor(streamRef.current);
                          if (handsFreeMode) startSpeechRecognition(true);
                          initiateCountdown();
                        }}
                        className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full border-4 border-white flex items-center justify-center shrink-0 ${
                          vbBlocking
                            ? 'bg-red-500/40 cursor-not-allowed'
                            : 'bg-red-500 cursor-pointer'
                        }`}
                      >
                        <div className="w-5 h-5 rounded-md bg-white" />
                      </button>
                      <span className="text-[11px] font-semibold text-white">
                        {vbBlocking
                          ? 'Loading virtual background…'
                          : handsFreeMode
                            ? 'Tap · say Action'
                            : 'Tap to record'}
                      </span>
                      {vbBlocking && (
                        <button
                          type="button"
                          onClick={() => setForceRecordWithoutVb(true)}
                          className="text-[10px] font-bold text-amber-200/90 underline cursor-pointer"
                        >
                          Record without background
                        </button>
                      )}
                          </>
                        );
                      })()}
                      <label className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/10 text-[10px] font-semibold text-white/80 cursor-pointer border border-white/15">
                        <Upload className="w-3 h-3" />
                        Upload
                        <input
                          type="file"
                          accept="video/*,audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleUploadFootage(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      {isOptionalInsert && (
                        <button
                          type="button"
                          onClick={skipOptionalInserts}
                          className="text-[10px] font-bold text-white/70 underline cursor-pointer"
                        >
                          Skip optional inserts — finish
                        </button>
                      )}
                      {!isOptionalInsert && shootingState === 'ready' && !sceneHasTake(currentScene) && (
                        <button
                          type="button"
                          onClick={markUploadLater}
                          className="text-[10px] font-bold text-white/70 underline cursor-pointer"
                        >
                          Upload later
                        </button>
                      )}
                    </div>
                  )}

                  {shootingState === 'recording' && (
                    <div className="flex flex-col items-center gap-1">
                      <div className="flex items-center justify-center gap-4">
                        <button
                          type="button"
                          onClick={recordingPaused ? resumeRecording : pauseRecording}
                          className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/15 border-2 border-white/70 flex items-center justify-center cursor-pointer shrink-0 text-white"
                          aria-label={recordingPaused ? 'Resume recording' : 'Pause recording'}
                        >
                          {recordingPaused ? (
                            <Play className="w-5 h-5 fill-white" />
                          ) : (
                            <Pause className="w-5 h-5 fill-white" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={stopRecording}
                          className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-neutral-900 border-4 border-red-500 flex items-center justify-center cursor-pointer shrink-0"
                          aria-label="Stop recording"
                        >
                          <div className="w-6 h-6 rounded-sm bg-red-500" />
                        </button>
                      </div>
                      <span className="text-[11px] font-bold text-red-300">
                        {recordingPaused
                          ? 'Paused — resume or stop'
                          : handsFreeMode
                            ? 'Tap · say Cut'
                            : 'Tap to stop'}
                      </span>
                    </div>
                  )}
                  </div>
                </div>
              </div>
            )}

            {shootingState === 'reviewing' && (
              <div className="absolute bottom-0 left-0 right-0 z-30 p-3 space-y-2 bg-gradient-to-t from-black via-black/85 to-transparent">
                {noAudioWarning && (
                  <p className="text-[11px] text-amber-300 text-center">
                    No dialogue audio — captions will be skipped.
                  </p>
                )}
                <p className="text-center text-xs font-semibold text-white">Review your take — play it back</p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const v = reviewVideoRef.current;
                      if (!v) return;
                      v.currentTime = Math.max(0, v.currentTime - 3);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-[11px] font-bold cursor-pointer"
                  >
                    −3s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const v = reviewVideoRef.current;
                      if (!v) return;
                      if (v.paused) {
                        void v.play();
                        setReviewPlaying(true);
                      } else {
                        v.pause();
                        setReviewPlaying(false);
                      }
                    }}
                    className="px-4 py-2 rounded-xl bg-[#1A73E8] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    {reviewPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {reviewPlaying ? 'Pause' : 'Play take'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const v = reviewVideoRef.current;
                      if (!v) return;
                      v.currentTime = 0;
                      void v.play();
                      setReviewPlaying(true);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-[11px] font-bold cursor-pointer"
                  >
                    Replay
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={handleRedoShot}
                    className="py-2.5 rounded-xl font-bold bg-neutral-800 text-white text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                    {isSingleTake ? 'Restart take' : 'Redo'}
                  </button>
                  <button
                    onClick={handleKeepShot}
                    disabled={takeSaveStatus === 'saving' || takeSaveStatus !== 'saved'}
                    className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 ${
                      takeSaveStatus === 'saved'
                        ? 'bg-[#1A73E8] text-white cursor-pointer'
                        : 'bg-[#1A73E8]/60 text-white/80 cursor-not-allowed'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {isSingleTake
                      ? remainingOptional
                        ? 'Keep take'
                        : 'Keep take'
                      : isOptionalInsert
                        ? currentUserSceneIndex >= totalUserScenes - 1
                          ? 'Keep insert'
                          : 'Keep · next insert'
                        : currentUserSceneIndex >= totalUserScenes - 1
                          ? 'Keep take'
                          : 'Keep · next shot'}
                  </button>
                </div>
                {(isOptionalInsert || (isSingleTake && remainingOptional && takeSaveStatus === 'saved')) && (
                  <button
                    type="button"
                    onClick={skipOptionalInserts}
                    className="w-full py-2 rounded-xl text-[11px] font-bold text-white/80 border border-white/20 cursor-pointer"
                  >
                    {isOptionalInsert
                      ? 'Skip remaining inserts — finish'
                      : 'Skip optional inserts — finish'}
                  </button>
                )}
                <div className="text-center text-[11px] font-semibold min-h-[1.25rem]">
                  {takeSaveStatus === 'saving' && (
                    <span className="text-sky-300 animate-pulse">Saving take…</span>
                  )}
                  {takeSaveStatus === 'saved' && (
                    <span className="text-emerald-300 flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Take saved
                    </span>
                  )}
                  {takeSaveStatus === 'error' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (recordedBlob) {
                          savedTakeRef.current = null;
                          setTakeSaveStatus('idle');
                          void persistCurrentTake(
                            recordedBlob,
                            recordedVideoUrl,
                            recordingSecondsRef.current || recordingSeconds
                          );
                        }
                      }}
                      className="text-rose-300 underline cursor-pointer"
                    >
                      Couldn’t save take — tap to retry
                      {takeSaveError ? ` (${takeSaveError.slice(0, 80)})` : ''}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          {(shootingState === 'recording' || shootingState === 'ready' || shootingState === 'countdown') && (
            <div className="w-full max-w-md lg:hidden rounded-xl border border-[#DADCE0] bg-white px-3 py-1.5 flex items-center justify-between gap-2 shadow-sm shrink-0">
              <span className="text-[11px] font-bold text-[#1A73E8] font-mono shrink-0">
                {scoreLabel}
              </span>
              <p className="text-[11px] text-[#3C4043] truncate min-w-0 flex-1 text-right">
                {liveSpokenText
                  ? `“${liveSpokenText.slice(-60)}”`
                  : liveCaptionHint || 'Tap Record for live captions'}
              </p>
            </div>
          )}
          <p className="text-xs text-[#5F6368] font-medium text-center hidden sm:block">
            Drag the teleprompter up if it covers your face. Tap a line to skip ahead.
          </p>
        </div>

        {/* Full radar — desktop only; phone uses the compact strip under the camera */}
        <div className="lg:col-span-5 space-y-3 min-w-0 hidden lg:block">
          <div className="bg-white border border-[#DADCE0] rounded-2xl p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between border-b border-[#DADCE0] pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#1A73E8]" />
                <div>
                  <h3 className="font-bold text-sm leading-tight">Live Director Radar</h3>
                  <span className="text-xs text-[#5F6368]">Live captions + claim check</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    hudPhase === 'Needs review'
                      ? 'bg-rose-500'
                      : hudPhase === 'Checking claim' || hudPhase === 'Transcribing'
                        ? 'bg-[#1A73E8] animate-pulse'
                        : hudPhase === 'Reconnecting'
                          ? 'bg-amber-500'
                          : 'bg-[#34A853] animate-ping'
                  }`}
                />
                <span className="text-xs font-mono font-semibold text-[#3C4043]">{hudPhase}</span>
              </div>
            </div>

            <div
              className={`p-3 rounded-xl border ${
                factCheckResult.status === 'alert'
                  ? 'bg-[#FCE8E6] border-[#F5C2C7] text-[#C5221F]'
                  : factCheckResult.status === 'warning'
                  ? 'bg-[#FEF7E0] border-[#FEEFC3] text-[#B06000]'
                  : factCheckResult.status === 'listening'
                  ? 'bg-[#F8F9FA] border-[#DADCE0] text-[#3C4043]'
                  : 'bg-[#E6F4EA] border-[#CEEAD6] text-[#137333]'
              }`}
            >
              <div className="flex items-center gap-2 font-bold text-xs mb-1">
                {factCheckResult.status === 'alert' ? (
                  <AlertTriangle className="w-4 h-4" />
                ) : factCheckResult.status === 'warning' ? (
                  <Zap className="w-4 h-4" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                <span>{factCheckResult.alertTitle || 'Listening'}</span>
              </div>
              <p className="text-xs font-semibold leading-relaxed">{factCheckResult.factCheckMessage}</p>
              {factCheckResult.actionableTip && (
                <p className="mt-2 text-xs border-t border-black/10 pt-2">
                  <strong>Cue: </strong>
                  {factCheckResult.actionableTip}
                </p>
              )}
            </div>

            <div className="bg-[#F8F9FA] border border-[#DADCE0] rounded-xl p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-[#1A73E8]" />
                  Audience connection
                </span>
                <span className="font-bold text-[#1A73E8] font-mono">{scoreLabel}</span>
              </div>
              <div className="w-full bg-[#DADCE0] h-2 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    scoreWidth < 50 ? 'bg-rose-500' : scoreWidth < 75 ? 'bg-amber-500' : 'bg-[#34A853]'
                  }`}
                  style={{ width: `${scoreWidth}%` }}
                />
              </div>
              {factCheckResult.connectionFeedback && (
                <p className="text-xs text-[#5F6368]">{factCheckResult.connectionFeedback}</p>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs font-semibold text-[#5F6368] flex items-center gap-1">
                <Radio className="w-3 h-3 text-[#1A73E8]" />
                Live speech
              </span>
              <div className="p-2.5 rounded-lg bg-[#F8F9FA] border border-[#DADCE0] text-xs min-h-[48px]">
                {liveSpokenText ? (
                  <span className="font-medium">
                    “
                    {liveSpokenText.length > 120
                      ? `…${liveSpokenText.slice(-120)}`
                      : liveSpokenText}
                    ”
                  </span>
                ) : (
                  <span className="text-[#80868B] italic">
                    {liveCaptionHint ||
                      (hudPhase === 'Listening'
                        ? 'Listening — speak naturally. Captions appear as you talk.'
                        : `${hudPhase}…`)}
                  </span>
                )}
              </div>
              {liveCaptionHint && liveSpokenText ? (
                <p className="text-xs text-[#5F6368]">{liveCaptionHint}</p>
              ) : null}
            </div>

            {directorLog.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-[#5F6368]">Recent director notes</span>
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {directorLog.map((n) => (
                    <div key={n.t} className="text-xs px-2 py-1.5 rounded-lg bg-[#F8F9FA] border border-[#E8EAED]">
                      <span className="font-bold">{n.title}: </span>
                      {n.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Spoken lines already live on the teleprompter — only silent shots need a reminder here. */}
            {!hasSpokenLines && (
              <div className="p-3 rounded-lg bg-[#F8F9FA] text-xs text-[#3C4043] leading-relaxed">
                <div className="font-semibold text-[#202124] mb-0.5">What to capture</div>
                {`${directorCue.capture}. ${directorCue.camera}. ~${directorCue.durationSec}s.`}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
