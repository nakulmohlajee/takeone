import type {
  EditingStyle,
  FootageIntelligence,
  TransitionPrimitive,
  ValidatedEditPlan,
  ClipRole,
} from './editorial';

export type FilmedBy = 'user' | 'ai';
export type VideoFormat = 'short-form' | 'long-form';
export type AspectRatio = '9:16' | '16:9';

/** Inferred production approach for a project idea */
export type ContentType =
  | 'ugc_ad'
  | 'talking_head'
  | 'educational'
  | 'tutorial'
  | 'workout'
  | 'cooking'
  | 'gardening'
  | 'diy_build'
  | 'woodworking'
  | 'product_demo'
  | 'travel'
  | 'transformation'
  | 'cinematic_montage'
  | 'interview'
  | 'commentary'
  | 'hybrid';

export type ContentMode =
  | 'dialogue'
  | 'voiceover'
  | 'visual_only'
  | 'natural_audio'
  | 'text_overlay'
  | 'mixed';

export type EditIntent =
  | 'hook'
  | 'problem'
  | 'product'
  | 'benefit'
  | 'context'
  | 'demonstration'
  | 'explanation'
  | 'progression'
  | 'reaction'
  | 'transition'
  | 'payoff'
  | 'cta'
  | 'ending'
  | 'establishing'
  | 'broll';

/** How the creator should capture footage — not the same as story beats. */
export type CaptureStrategy = 'single_take' | 'multi_take' | 'multi_shot' | 'montage';

export type StorytellingMode = 'direct_to_camera' | 'visual_first' | 'mixed';

export type EditingStrategy = 'jump_cut_social' | 'cinematic' | 'documentary' | 'youtube';

export type DirectorCueKind =
  | 'LOOK_AT_CAMERA'
  | 'PAUSE'
  | 'SHOW_PRODUCT'
  | 'SMILE'
  | 'TURN_TO_SIDE'
  | 'START_ACTION'
  | 'HOLD'
  | 'CONTINUE'
  | 'GET_CLOSEUP'
  | 'WIDEN_FRAME';

/** Cues that stay compatible with a continuous selfie recording. */
export const UGC_SAFE_CUES: DirectorCueKind[] = [
  'LOOK_AT_CAMERA',
  'SHOW_PRODUCT',
  'PAUSE',
  'SMILE',
  'HOLD',
  'CONTINUE',
];

export interface DirectorCue {
  kind: DirectorCueKind | string;
  label?: string;
  atBeatId?: string;
  afterPhraseIndex?: number;
  holdMs?: number;
}

export interface DeliveryMetadata {
  speakingPace?: 'slow' | 'natural' | 'brisk' | string;
  pauseSec?: number;
  emphasisPhrase?: string;
  lookAtCamera?: boolean;
  breathingPoint?: boolean;
}

/** Story beat — what part of the story this is, not a camera roll. */
export interface NarrativeBeat {
  id: string;
  title: string;
  purpose?: string;
  contentMode?: ContentMode | string;
  editIntent?: EditIntent | string;
  dialogue?: string;
  voiceover?: string;
  durationSeconds?: number;
  directorCues?: DirectorCue[];
  delivery?: DeliveryMetadata;
}

/** One camera recording / shot the creator actually films. */
export interface CaptureUnit {
  id: string;
  title: string;
  beatIds: string[];
  contentMode?: ContentMode | string;
  durationSeconds: number;
  instruction?: string;
  camera?: string;
  framing?: string;
  action?: string;
  dialogueRequired?: boolean;
  teleprompterRequired?: boolean;
  /** Optional B-roll/insert after the main take — not a required scene. */
  optional?: boolean;
  kind?: 'main' | 'insert';
}

export interface SceneVisualDirection {
  action?: string;
  camera?: string;
  framing?: string;
  movement?: string;
  environment?: string;
}

export interface SceneDialogue {
  required: boolean;
  teleprompterText?: string | null;
}

export interface SceneVoiceover {
  required: boolean;
  text?: string | null;
}

/** Structured creative brief from generate-script (no chain-of-thought). */
/** Fact-check result for a transcript claim (import + post pipeline). */
export interface FactCheckedClaim {
  start: number;
  end: number;
  text: string;
  kind: 'factual_claim' | 'opinion' | 'personal' | 'other';
  verdict?: 'supported' | 'disputed' | 'unverifiable' | 'skipped';
  confidence?: number;
  explanation?: string;
  sources?: Array<{ title?: string; url?: string }>;
}

/** What the creator asked for — drives shot budget, looks, captions, and cleanup. */
export interface ProductionPrefs {
  shots: 'one_take' | 'few' | 'cinematic';
  looks: Array<'talking_head' | 'virtual_background' | 'broll' | 'overlays' | 'memes' | 'text_pops'>;
  captions: 'bold_pop' | 'karaoke' | 'clean' | 'off';
  /** Where captions sit and how big they are (defaults: bottom, medium). */
  captionPosition?: 'bottom' | 'middle' | 'top';
  captionSize?: 'small' | 'medium' | 'large';
  cleanup: { silences: boolean; fillers: boolean };
  music: boolean;
}

/** Per-scene edit recipe produced by the script pass (layout, inserts, punch-ins). */
export interface SceneRecipe {
  layout: 'talking_head' | 'virtual_background' | 'pip' | 'split';
  background?: { prompt: string; assetUrl?: string };
  inserts: Array<{
    anchorPhrase: string;
    kind: 'broll_image' | 'broll_video' | 'text_pop' | 'meme';
    prompt?: string;
    text?: string;
    layout: 'full' | 'pip';
    durationSec: number;
    /** Generated or uploaded image (gs:// or data:). */
    assetUrl?: string;
    /** Seconds to shift from the anchor phrase (negative = earlier). */
    offsetSec?: number;
    /** false = creator switched this visual off; it is neither generated nor rendered. */
    enabled?: boolean;
  }>;
  punchIns: Array<{ anchorPhrase: string; zoom: number }>;
  transitionOut: 'cut' | 'zoom_snap' | 'whip' | 'crossfade';
}

export function defaultProductionPrefs(format?: string): ProductionPrefs {
  return {
    shots: format === 'long-form' ? 'few' : 'one_take',
    looks: ['talking_head', 'text_pops'],
    captions: 'bold_pop',
    cleanup: { silences: true, fillers: true },
    music: true,
  };
}

export interface CreativeBrief {
  contentType: ContentType | string;
  storyObjective: string;
  audience: string;
  visualPriority: 'low' | 'medium' | 'high' | 'very_high' | string;
  dialoguePriority: 'none' | 'low' | 'medium' | 'high' | string;
  teleprompterRequired: boolean;
  voiceoverPossible: boolean;
  naturalAudioImportance: 'low' | 'medium' | 'high' | string;
  creatorPresence: 'constant' | 'frequent' | 'intermittent' | 'minimal' | string;
  narrativeStructure: string;
  pacing: string;
  tone: string;
  platform: string;
  targetDuration: number;
  captureStrategy?: CaptureStrategy | string;
  storytellingMode?: StorytellingMode | string;
  editingStrategy?: EditingStrategy | string;
  /** Short language code for spoken teleprompter / STT (e.g. en, hi, es). UI stays English. */
  spokenLanguage?: string;
  /** Creator production preferences (shots / looks / captions / cleanup / music) */
  prefs?: ProductionPrefs;
  /** Viral look recipe from Gemini — drives zooms/transitions; overlays only if selective/meme */
  viralStyle?: {
    referenceLook?: string;
    effects?: string[];
    overlayPolicy?: 'none' | 'selective' | 'meme' | string;
    musicEnergy?: string;
  };
}

export type TransitionType =
  | 'dissolve'
  | 'fade-to-black'
  | 'whip-pan'
  | 'crossfade'
  | 'zoom-snap'
  | 'light-leak'
  | 'dip-black'
  | 'cut'
  | TransitionPrimitive;

export type {
  EditingStyle,
  FootageIntelligence,
  TransitionPrimitive,
  ValidatedEditPlan,
  ClipRole,
};

export interface LowerThirdConfig {
  title: string;
  subtitle?: string;
  style: 'creator-badge' | 'tip-card' | 'key-stat' | 'none';
  durationSeconds?: number;
}

export type MotionGraphicType =
  | 'subscribe-banner'
  | 'pro-tip'
  | 'like-pulse'
  | 'fire'
  | 'checkmark'
  | 'none';

export interface Scene {
  id: string;
  sceneNumber: number;
  title: string;
  chapterTitle?: string;
  filmedBy: FilmedBy;
  durationSeconds: number;
  plainInstruction: string;
  directorTip: string;
  teleprompterPrompt?: string;
  aiGenerationPrompt?: string;

  /** Why this beat exists in the production plan */
  purpose?: string;
  /** How the creator should deliver this unit */
  contentMode?: ContentMode | string;
  visual?: SceneVisualDirection;
  dialogue?: SceneDialogue;
  voiceover?: SceneVoiceover;
  naturalAudio?: string | null;
  onScreenText?: string | null;
  /** Intent for the later AI editor (stored now; not wired into critic yet) */
  editIntent?: EditIntent | string;
  /** Narrative beats covered by this recording (single-take may list several) */
  narrativeBeatIds?: string[];
  captureUnitId?: string;
  directorCues?: DirectorCue[];
  delivery?: DeliveryMetadata;
  /** Optional insert after the main take — skippable. */
  optionalInsert?: boolean;
  /**
   * Explicit capture disposition for this scene:
   * - shoot: record on device
   * - upload: creator will attach footage later
   * - skipped: optional insert intentionally omitted
   */
  captureStatus?: 'shoot' | 'upload' | 'skipped';

  /** Post-import / post-transcribe claim fact-check results */
  factCheckClaims?: FactCheckedClaim[];
  /** Snapshot of live director radar from the last recording */
  liveFactCheck?: {
    status?: string;
    alertTitle?: string;
    factCheckMessage?: string;
    audienceConnectionScore?: number | null;
    connectionFeedback?: string;
    actionableTip?: string;
  };
  /** How this take entered the project */
  mediaSource?: 'recorded' | 'imported';

  // Recorded or generated assets
  userRecordedVideoUrl?: string;
  aiGeneratedImageUrl?: string;
  aiGeneratedVideoUrl?: string;
  mediaType?: 'image' | 'video';
  aiGenerationStatus?: 'idle' | 'generating' | 'ready' | 'failed';
  aiGenerationMessage?: string;
  transcript?: string;
  /** Timed caption segments from real speech (never teleprompter) */
  transcriptSegments?: Array<{ start: number; end: number; text: string }>;
  /** Word-level timings from real speech (seconds, take-relative) */
  words?: Array<{ w: string; start: number; end: number; conf?: number }>;
  /** AI scenes: false = creator switched this visual off (not generated, not in the cut). */
  aiVisualEnabled?: boolean;
  /** Where `words` came from: full speech-to-text (trusted for cuts) or live captions (rough). */
  wordsSource?: 'stt' | 'live';
  /** Take was recorded with the virtual background already composited in (no chroma key). */
  virtualBackgroundBaked?: boolean;
  /** Background image that was baked into the take. */
  virtualBackgroundBakedUrl?: string;
  /**
   * How the take was captured when its scene wanted a virtual background: baked in, on virtual
   * green (keyed at export) or plain camera (no background unless "Apply background" is run).
   */
  virtualBackgroundMode?: 'baked' | 'green' | 'none';
  /**
   * Server-side matting (RVM): the take with the person cut out and placed on the background.
   * Valid only while it was made from the current take and the current background.
   */
  /** Creator switched the virtual background off for this shot (it isn't spread to it). */
  virtualBackgroundOff?: boolean;
  matteStatus?: 'running' | 'ready' | 'failed';
  matteJobId?: string;
  matteProgress?: number;
  matteError?: string;
  mattedGcsPath?: string;
  /** The take (gcsObjectPath) and background the matted file was made from. */
  mattedSourcePath?: string;
  mattedBackgroundUrl?: string;
  /** Edit recipe: layout, inserts, punch-ins, transition out */
  recipe?: SceneRecipe;
  recordedDuration?: number;
  /** GCS object path after upload (gs:// or object key) */
  gcsObjectPath?: string;
  /** 480p proxy for analysis / critic rough cuts */
  proxyUrl?: string;
  /** Recorded MIME from the browser (video/webm, video/mp4, …) — never infer from filename alone */
  mimeType?: string;
  /** B-roll / AI still overlays on this take (composited, not hard cutaways) */
  brollInserts?: Array<{
    id: string;
    mediaUrl: string;
    mediaType: 'image' | 'video';
    startOffsetSeconds: number;
    durationSeconds: number;
    layout?: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
    source: 'ai' | 'upload' | 'ai_still' | 'ai_video' | 'footage';
    accepted: boolean;
    prompt?: string;
    disclosureLabel?: string;
  }>;
  /** When false, AI cutaways are excluded from master export (default for AI scenes). */
  includeInExport?: boolean;
  /**
   * How this AI asset participates in the edit:
   * - capture: required user take
   * - cutaway: hard-cut replacement scene
   * - overlay: timed composite on a parent talking-head take
   */
  mediaRole?: 'capture' | 'cutaway' | 'overlay';
  /** Parent scene id when mediaRole is overlay */
  overlayParentSceneId?: string;
  /** Composite layout when mediaRole is overlay (greenscreen = chroma-key over AI background) */
  overlayLayout?: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
  /** Parent-source absolute start for overlay compositing (seconds) */
  overlayStartSeconds?: number;
  /** Overlay hold duration on parent (seconds) */
  overlayDurationSeconds?: number;
  /** Free-text timing hint from media plan (matched against parent transcript) */
  mediaTimingHint?: string;
  referenceImageUrl?: string;
  /**
   * YouTube-style insert between talking-head takes:
   * title-card, meme, reference clip, or b-roll.
   */
  insertKind?: 'title-card' | 'meme' | 'reference' | 'broll';
  /** Uploaded meme / reference clip / screenshot for an insert scene */
  userInsertUrl?: string;

  // AI-Powered Editing enhancements
  transition?: TransitionType;
  transitionDuration?: number;
  lowerThird?: LowerThirdConfig;
  motionGraphic?: MotionGraphicType;
  audioDenoise?: boolean;
  voiceBoost?: boolean;

  /** Structured footage intelligence from Stage A analysis */
  footageIntel?: FootageIntelligence;
  /** In/out points on source media for professional trim (seconds) */
  inPoint?: number;
  outPoint?: number;
  /**
   * Kept segments within the take (split tool). When set with multiple ranges,
   * EDL emits one clip per range. Overall inPoint/outPoint remain min start / max end.
   */
  keepRanges?: Array<{ start: number; end: number }>;
  /** When true, user-set in/out win over Gemini director edits */
  userTrimLocked?: boolean;
  /** Editorial role in the final cut */
  editRole?: ClipRole;
  /** Punch-in zoom factor (1.0–1.15) */
  editZoom?: number;
}

export interface ChannelSettings {
  channelName: string;
  showWatermark: boolean;
  watermarkPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  watermarkOpacity: number;
  entryMusicEnabled: boolean;
  entryMusicStyle: 'signature-chime' | 'sub-boom' | 'sparkle' | 'acoustic';
  noiseRemovalEnabled: boolean;
  captionsEnabled: boolean;
  captionStyle: 'tiktok-yellow' | 'modern-white' | 'studio-box' | 'subtle-sub';
  currentLanguage: string;

  // YouTube Channel Intro & Outro enhancements
  youtubeIntroEnabled?: boolean;
  youtubeIntroDuration?: number;
  youtubeIntroStyle?: 'cinematic-studio' | 'vlog-neon' | 'minimal-bold' | 'creator-card';
  youtubeChannelHandle?: string;
  youtubeTagline?: string;
  youtubeOutroEnabled?: boolean;
  youtubeOutroCta?: string;
  aiEditingPreset?:
    | 'viral-creator'
    | 'cinematic-documentary'
    | 'educational-explainer'
    | 'chill-vlog'
    | EditingStyle;

  /** Channel kit */
  logoUrl?: string;
  brandColor?: string;
  /** Short-form defaults to off; long-form may use after-hook */
  introMode?: 'off' | 'after-hook';
  stingAudioUrl?: string;
  musicTrackUrl?: string;
  /** Gemini TTS / AI dub mixed over (or replacing) dialogue on export */
  voiceoverUrl?: string;
  voiceoverEnabled?: boolean;
  /** AI-generated or uploaded cinematic background for brand sting */
  introBackgroundUrl?: string;
  /** Uploaded existing intro video clip (preferred over still when set) */
  introVideoUrl?: string;
  /** User prompt used to generate the intro look */
  introPrompt?: string;
  /** Visual continuity description derived from take frames */
  styleBible?: string;
  /** Analyzed from existing YouTube channel */
  channelAnalysisNotes?: string;
}

/** Last Director's Cut compile/render report (mirrors server DirectorCutReport + render metadata). */
export interface DirectorCutReportSummary {
  summary: string;
  fillersRemoved: number;
  silenceRemovedSec: number;
  punchIns: number;
  inserts: number;
  insertsUnresolved?: number;
  virtualBackgroundScenes: number;
  captionStyle: string;
  warnings?: string[];
  quality?: 'draft' | 'standard' | 'high' | 'final';
  at?: number;
  /** Prefs used for that render — lets the UI flag "settings changed, re-render". */
  prefs?: ProductionPrefs;
}

export interface Project {
  id: string;
  title: string;
  logline: string;
  estimatedTotalSeconds: number;
  musicMood: string;
  scenes: Scene[];
  createdAt: number;
  videoFormat?: VideoFormat;
  aspectRatio?: AspectRatio;
  channelSettings?: ChannelSettings;
  /** Context-aware production brief from generate-script */
  creativeBrief?: CreativeBrief;
  captureStrategy?: CaptureStrategy | string;
  narrativeBeats?: NarrativeBeat[];
  captureUnits?: CaptureUnit[];
  /** Same as captureUnits — one entry per recording session. */
  capturePlan?: CaptureUnit[];
  /** Last capture unit the creator was filming — resume here after leaving Shoot */
  lastShootingSceneId?: string;
  /** Shot Direction asked to start the shoot on this scene (consumed when the shoot opens). */
  shootFromSceneId?: string;
  /** shoot = ProductionPlan path; import = external camera footage */
  entryPath?: 'shoot' | 'import';
  /** Cloud Run FFmpeg master MP4 (inline playable) */
  masterVideoUrl?: string;
  /** Validated multi-stage edit plan (Director → Planner) */
  editPlan?: ValidatedEditPlan;
  /** Spoken language for teleprompter/STT/captions (UI remains English). */
  spokenLanguage?: string;
  /** Creator production preferences */
  prefs?: ProductionPrefs;
  /** Looks / shot budget Gemini did not satisfy — shown on Shots with a regenerate action. */
  prefsUnmet?: string[];
  /** 0–0.4 bed level under voice (default 0.18). */
  musicVolume?: number;
  /** Confirmed on the Shoot output-format sheet so we don't ask again. */
  outputFormatConfirmed?: boolean;
  /** Saved preview / master renders in GCS — survive tab changes until deleted. */
  renders?: ProjectRender[];
  /** In-flight Cloud Run render — survives Master tab remounts (IndexedDB). */
  pendingRender?: {
    jobId: string;
    quality: 'draft' | 'standard' | 'high';
    startedAt: number;
  };
  /** "What I did" report from the last Director's Cut compile/render */
  directorReport?: DirectorCutReportSummary;
}

export type ProjectRender = {
  jobId: string;
  kind: 'draft' | 'final';
  quality: 'draft' | 'standard' | 'high';
  createdAt: number;
  durationSec?: number;
  gcsPath?: string;
  outdated?: boolean;
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remainingSecs = Math.round(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return remainingSecs > 0 ? `${mins}m ${remainingSecs}s` : `${mins} min`;
}

export type AppScreen =
  | 'idea'            // Step 1: Input idea + duration + style
  | 'script-overview' // Step 2: Review script & shot direction
  | 'guided-shooting' // Step 3: Full-screen calm camera UI scene-by-scene
  | 'import-footage'  // Alt path: upload existing footage → GCS → analyze
  | 'ai-generation'   // Step 4: AI Cutaways generating & preview
  | 'assembly-review';// Step 5 & 6: Master playback, edit, captions, soundtrack & export
