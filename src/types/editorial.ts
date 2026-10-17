/**
 * Professional multi-stage editor types.
 * Gemini specifies WHAT; FFmpeg renderer determines HOW.
 */

export type EditingStyle =
  | 'cinematic'
  | 'youtube'
  | 'high_energy_social'
  | 'documentary'
  | 'corporate'
  | 'travel'
  | 'interview_podcast';

/** Map legacy channel presets → new editorial styles */
export function mapLegacyPresetToStyle(
  preset?: string | null
): EditingStyle {
  switch (preset) {
    case 'cinematic-documentary':
      return 'cinematic';
    case 'educational-explainer':
      return 'youtube';
    case 'chill-vlog':
      return 'travel';
    case 'jump_cut_social':
    case 'viral-creator':
    default:
      return 'high_energy_social';
  }
}

export type TransitionPrimitive =
  | 'hard_cut'
  | 'cross_dissolve'
  | 'dip_black'
  | 'dip_white'
  | 'push'
  | 'whip'
  | 'zoom'
  | 'j_cut'
  | 'l_cut'
  | 'cutaway'
  | 'match_cut';

export const TRANSITION_PRIMITIVES: TransitionPrimitive[] = [
  'hard_cut',
  'cross_dissolve',
  'dip_black',
  'dip_white',
  'push',
  'whip',
  'zoom',
  'j_cut',
  'l_cut',
  'cutaway',
  'match_cut',
];

export type ClipRole =
  | 'hook'
  | 'context'
  | 'explanation'
  | 'proof'
  | 'cta'
  | 'broll'
  | 'outro'
  | 'bridge';

/**
 * directed — TakeOne-recorded production: polish the already-directed performance.
 * creative_recut — imported/raw footage: AI may find a new story.
 */
export type EditPolicy = 'directed' | 'creative_recut';

export interface IntendedBeat {
  sourceId: string;
  label: string;
  required: boolean;
  role?: ClipRole;
}

export type ShotType =
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'extreme_close_up'
  | 'unknown';

export type CameraMovement =
  | 'static'
  | 'pan'
  | 'tilt'
  | 'zoom'
  | 'handheld'
  | 'unknown';

export type QualityLevel = 'high' | 'medium' | 'low' | 'unknown';

export type MomentType =
  | 'speech_beat'
  | 'completed_thought'
  | 'reaction'
  | 'gesture'
  | 'person_entering_frame'
  | 'person_exiting_frame'
  | 'look_away'
  | 'visual_reveal'
  | 'movement_peak'
  | 'emotional_change'
  | 'natural_cut_point'
  | 'silence'
  | 'filler'
  | 'mistake'
  | 'repetition'
  | 'unknown';

/** Stage A — factual visual shot (no keep/drop / narrative scores) */
export interface ObservedShot {
  shotId: string;
  start: number;
  end: number;
  shotType: ShotType | string;
  framing: string;
  cameraMovement: CameraMovement | string;
  composition: string;
  subject: string;
  scene: string;
  objects: string[];
  visualChanges: string;
  stability: string;
  focus: string;
  lighting: string;
}

/** Stage A — meaningful moment inside a shot */
export interface ObservedMoment {
  start: number;
  end: number;
  shotId: string;
  transcript?: string;
  momentType: MomentType | string;
  description: string;
  naturalCutPoints?: number[];
  containsSilence?: boolean;
  containsFiller?: boolean;
  containsMistake?: boolean;
  repetitionObserved?: boolean;
}

/** Stage A — factual audio observations */
export interface AudioObservation {
  speechPresent: boolean | 'unknown';
  speakerCount: number | 'unknown';
  dialogueClarity: QualityLevel;
  backgroundNoise: QualityLevel | string;
  clipping: boolean | 'unknown';
  volumeConsistency: QualityLevel | string;
  musicPresent: boolean | 'unknown';
  silenceRanges: Array<{ start: number; end: number }>;
}

export interface TakeObservation {
  shots: ObservedShot[];
  moments: ObservedMoment[];
  audio: AudioObservation;
}

/**
 * Derived factual view of a moment for planner snap / critic transcript.
 * Stage A must NOT fill suggestedEditorialAction / hookValue / narrativeImportance / usefulAsPrimary.
 */
export interface FootageSegment {
  sourceId: string;
  start: number;
  end: number;
  transcript?: string;
  speaker?: string | 'unknown';
  shotType?: ShotType;
  cameraAngle?: string | 'unknown';
  framing?: string | 'unknown';
  cameraMovement?: CameraMovement;
  subject?: string | 'unknown';
  objects?: string[];
  locationScene?: string | 'unknown';
  visualQuality?: QualityLevel;
  audioQuality?: QualityLevel;
  emotion?: string | 'unknown';
  energy?: number; // 0–1 — optional legacy; Stage A leaves unset
  speechQuality?: QualityLevel;
  containsMistake?: boolean;
  containsFiller?: boolean;
  containsSilence?: boolean;
  isRepetition?: boolean;
  /** Project-level judgments live on ProjectUnderstanding — not Stage A */
  usefulAsPrimary?: boolean;
  usefulAsBroll?: boolean;
  narrativeImportance?: number;
  hookValue?: number;
  silenceRanges?: Array<{ start: number; end: number }>;
  naturalCutPoints?: number[];
  someoneEntersFrame?: boolean;
  reactionMoment?: boolean;
  speakerLooksAway?: boolean;
  becomesShaky?: boolean;
  visualInterestPeak?: number | null;
  suggestedEditorialAction?:
    | 'keep'
    | 'drop'
    | 'trim_start'
    | 'trim_end'
    | 'punch_in'
    | 'cover_with_broll'
    | 'unknown';
  momentType?: MomentType | string;
  shotId?: string;
}

/** FFmpeg-grounded speech window — authority for CTA / last spoken word. */
export interface AudioEnvelope {
  speechStart: number;
  speechEnd: number;
  pauses: Array<{ start: number; end: number }>;
  duration: number;
  source: 'ffmpeg';
}

export interface FootageIntelligence {
  sourceId: string;
  sourceDuration: number;
  title?: string;
  fullTranscript?: string;
  /** Derived from observation.moments for planner/critic compatibility */
  segments: FootageSegment[];
  /** Stage A lean observation — required for Observe→Understand→Direct */
  observation?: TakeObservation;
  analyzedAt: number;
  /** true when Gemini watched the actual video file (not just stills) */
  nativeVideoAnalyzed?: boolean;
  /** Real speech bounds from silencedetect — overrides Gemini dead-air guesses */
  audioEnvelope?: AudioEnvelope;
  /** Transcript segments retimed onto audioEnvelope (for captions / scene patches) */
  retimedTranscriptSegments?: Array<{ start: number; end: number; text: string }>;
}

/** Timed ref across takes */
export interface FootageTimeRef {
  sourceId: string;
  start: number;
  end: number;
  reason?: string;
  text?: string;
  score?: number;
}

/** Stage B project-level judgment on a moment (not a keep/drop decision) */
export interface MomentJudgment {
  sourceId: string;
  start: number;
  end: number;
  narrativeImportance?: number;
  hookPotential?: number;
  emotionalImportance?: number;
  visualImportance?: number;
  primaryFootageCandidate?: boolean;
  brollCandidate?: boolean;
  reactionCandidate?: boolean;
  transitionCandidate?: boolean;
  notes?: string;
}

/**
 * Stage B — "What matters creatively?" across the whole project.
 * No timeline / keep-drop / EDL.
 */
export interface ProjectUnderstanding {
  overallStory: string;
  majorStorySections: string[];
  primarySubject: string;
  intendedAudience: string;
  keyMessage: string;
  strongestStatements: FootageTimeRef[];
  strongestEmotionalMoments: FootageTimeRef[];
  strongestVisualMoments: FootageTimeRef[];
  redundantInformation: string[];
  weakIrrelevantMaterial: FootageTimeRef[];
  candidateHooks: FootageTimeRef[];
  candidateEndings: FootageTimeRef[];
  candidateBroll: FootageTimeRef[];
  candidateReactions: FootageTimeRef[];
  candidateEstablishingShots: FootageTimeRef[];
  candidateCutaways: FootageTimeRef[];
  candidateTransitions: Array<{
    fromSourceId: string;
    toSourceId: string;
    suggestion: string;
    reason: string;
  }>;
  pacingOpportunities: string[];
  possibleNarrativeOrder: string[];
  momentJudgments: MomentJudgment[];
  /** Legacy StoryUnderstanding fields for DirectorCreativeBrief.story */
  majorTopics?: string[];
  repeatedInformation?: string[];
  irrelevantSections?: FootageTimeRef[];
  narrativeOpportunities?: string[];
  naturalStoryProgression?: string[];
}

/** Legacy alias used by DirectorCreativeBrief.story */
export interface StoryUnderstanding {
  primarySubject: string;
  intendedAudience: string;
  keyMessage: string;
  majorTopics: string[];
  strongestStatements: Array<{ sourceId: string; start: number; end: number; text: string }>;
  strongestEmotionalMoments: Array<{ sourceId: string; start: number; end: number; reason: string }>;
  repeatedInformation: string[];
  irrelevantSections: Array<{ sourceId: string; start: number; end: number; reason: string }>;
  narrativeOpportunities: string[];
  possibleOpeningHooks: Array<{ sourceId: string; start: number; end: number; score: number; reason: string }>;
  strongestEnding: { sourceId: string; start: number; end: number; reason: string } | null;
  naturalStoryProgression: string[];
}

export interface StyleConstraints {
  style: EditingStyle;
  avgShotSeconds: [number, number];
  transitionBudgetPerMinute: number;
  brollFrequency: 'rare' | 'moderate' | 'frequent';
  punchInAllowed: boolean;
  musicIntensity: 'none' | 'subtle' | 'medium' | 'high';
  captionDensity: 'sparse' | 'normal' | 'dense';
  preferHardCuts: boolean;
  introPreferred: boolean;
  outroPreferred: boolean;
  maxGeneratedBroll: number;
}

export const STYLE_CONSTRAINTS: Record<EditingStyle, StyleConstraints> = {
  cinematic: {
    style: 'cinematic',
    avgShotSeconds: [3.5, 7],
    transitionBudgetPerMinute: 1,
    brollFrequency: 'moderate',
    punchInAllowed: true,
    musicIntensity: 'medium',
    captionDensity: 'sparse',
    preferHardCuts: true,
    introPreferred: true,
    outroPreferred: true,
    maxGeneratedBroll: 1,
  },
  youtube: {
    style: 'youtube',
    avgShotSeconds: [2.5, 5],
    transitionBudgetPerMinute: 1,
    brollFrequency: 'moderate',
    punchInAllowed: true,
    musicIntensity: 'medium',
    captionDensity: 'normal',
    preferHardCuts: true,
    introPreferred: true,
    outroPreferred: true,
    maxGeneratedBroll: 1,
  },
  high_energy_social: {
    style: 'high_energy_social',
    avgShotSeconds: [1.2, 3.5],
    transitionBudgetPerMinute: 1,
    brollFrequency: 'frequent',
    punchInAllowed: true,
    musicIntensity: 'high',
    captionDensity: 'dense',
    preferHardCuts: true,
    introPreferred: false,
    outroPreferred: false,
    maxGeneratedBroll: 0,
  },
  documentary: {
    style: 'documentary',
    avgShotSeconds: [4, 8],
    transitionBudgetPerMinute: 1,
    brollFrequency: 'frequent',
    punchInAllowed: false,
    musicIntensity: 'subtle',
    captionDensity: 'sparse',
    preferHardCuts: true,
    introPreferred: false,
    outroPreferred: true,
    maxGeneratedBroll: 0,
  },
  corporate: {
    style: 'corporate',
    avgShotSeconds: [3, 6],
    transitionBudgetPerMinute: 1,
    brollFrequency: 'moderate',
    punchInAllowed: false,
    musicIntensity: 'subtle',
    captionDensity: 'normal',
    preferHardCuts: true,
    introPreferred: true,
    outroPreferred: true,
    maxGeneratedBroll: 1,
  },
  travel: {
    style: 'travel',
    avgShotSeconds: [2, 5],
    transitionBudgetPerMinute: 2,
    brollFrequency: 'frequent',
    punchInAllowed: true,
    musicIntensity: 'medium',
    captionDensity: 'normal',
    preferHardCuts: true,
    introPreferred: false,
    outroPreferred: true,
    maxGeneratedBroll: 0,
  },
  interview_podcast: {
    style: 'interview_podcast',
    avgShotSeconds: [4, 10],
    transitionBudgetPerMinute: 0,
    brollFrequency: 'rare',
    punchInAllowed: true,
    musicIntensity: 'none',
    captionDensity: 'normal',
    preferHardCuts: true,
    introPreferred: false,
    outroPreferred: false,
    maxGeneratedBroll: 0,
  },
};

export interface KeepDropDecision {
  sourceId: string;
  start: number;
  end: number;
  action: 'keep' | 'drop';
  reason: string;
}

/** Granular editorial action — sentence/beat level, not whole-take */
export interface GranularCutAction {
  sourceId: string;
  start: number;
  end: number;
  action: 'keep' | 'drop' | 'punch_in' | 'cover_with_broll' | 'split_return';
  reason: string;
  /** For punch_in */
  zoom?: number;
  /** For cover_with_broll / split_return: B-roll then return to speaker */
  brollSourceId?: string;
  brollStart?: number;
  brollEnd?: number;
  returnStart?: number;
  returnEnd?: number;
}

export interface DirectorCreativeBrief {
  style: EditingStyle;
  targetDuration: number;
  aspectRatio: '9:16' | '16:9';
  /** TakeOne shoot = directed (order locked). Import/raw = creative recut. */
  editPolicy?: EditPolicy;
  /** Production-plan beats in creator order (directed footage). */
  intendedBeats?: IntendedBeat[];
  story: StoryUnderstanding;
  openingHook: { sourceId: string; start: number; end: number; reason: string };
  sequenceRoles: Array<{
    sourceId: string;
    start: number;
    end: number;
    role: ClipRole;
    notes?: string;
    zoom?: number;
    transitionOut?: TransitionPrimitive;
  }>;
  keepDrop: KeepDropDecision[];
  /** Sentence-level cut instructions (preferred over coarse keepDrop alone) */
  granularCuts?: GranularCutAction[];
  brollOpportunities: Array<{
    atSourceId: string;
    atTime: number;
    concept: string;
    preferredSourceId?: string;
    preferredStart?: number;
    preferredEnd?: number;
    durationSeconds: number;
    replaceOrOverlay: 'replace' | 'overlay';
    whyNeeded: string;
  }>;
  audioStrategy: {
    musicEnabled: boolean;
    duckUnderSpeech: boolean;
    fadeInOut: boolean;
    notes: string;
  };
  captionStrategy: {
    enabled: boolean;
    emphasizeKeywords: string[];
  };
  pacingNotes: string;
  /** Explicit: prefer hard cuts; fancy transitions only when justified */
  transitionPhilosophy: string;
}

export interface MusicCue {
  start: number;
  end: number;
  level: 'ducked' | 'lift' | 'mute' | 'hold';
}

export interface PlannedClip {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  role: ClipRole;
  transitionIn: TransitionPrimitive;
  transitionOut: TransitionPrimitive;
  transitionDuration?: number;
  crop?: 'none' | 'face_priority';
  zoom?: number;
  audioGainDb?: number;
  musicDuck?: 'speech' | 'lift' | 'hold';
  isBroll?: boolean;
  parentClipId?: string;
  emphasisPhrases?: string[];
  notes?: string;
}

export interface ValidatedEditPlan {
  version: 1;
  projectId: string;
  targetDuration: number;
  aspectRatio: '9:16' | '16:9';
  style: EditingStyle;
  editPolicy?: EditPolicy;
  sequence: PlannedClip[];
  musicCues: MusicCue[];
  audioStrategy: DirectorCreativeBrief['audioStrategy'];
  captionStrategy: DirectorCreativeBrief['captionStrategy'];
  warnings: string[];
  createdAt: number;
  iteration: number;
}

export type CriticCategory =
  | 'story'
  | 'pacing'
  | 'visual_continuity'
  | 'audio'
  | 'transition'
  | 'caption'
  | 'professionalism'
  | 'social_effectiveness'
  | 'hook'
  | 'zoom_consistency'
  | 'ending';

export type CriticEditAction =
  | 'extend_clip'
  | 'trim_clip'
  | 'set_range'
  | 'set_zoom'
  | 'normalize_zoom'
  | 'hard_cut'
  | 'complete_ending'
  | 'none';

export interface CriticIssueParameters {
  clipId?: string;
  /**
   * Canonical SOURCE in/out (seconds on sourceId) for revision mutations.
   * Prefer these over newStart/newEnd.
   */
  sourceStart?: number;
  sourceEnd?: number;
  /** Legacy alias for sourceStart/sourceEnd (also SOURCE seconds, never timeline). */
  newStart?: number;
  newEnd?: number;
  /** Excise-range trim: remove this source window; keep surrounding footage. */
  removeStart?: number;
  removeEnd?: number;
  zoom?: number;
  zoomValues?: number[];
}

export interface CriticIssue {
  severity: 'high' | 'medium' | 'low';
  timestamp: string;
  /** Rough-cut TIMELINE seconds where the problem is visible */
  start?: number;
  end?: number;
  category: CriticCategory;
  problem: string;
  /** What is visible/heard at this timestamp */
  seenHeard?: string;
  reason?: string;
  /** Legacy prose fix hint */
  recommendation: string;
  /** Structured edit operation for targeted EDL mutation */
  action?: CriticEditAction;
  parameters?: CriticIssueParameters;
}

export interface CriticPassStats {
  issueCount: number;
  highSeverity: number;
  overall: number;
}

export interface CriticIterationRecord {
  iteration: number;
  edlClipCount: number;
  roughCutOk: boolean;
  before: CriticPassStats;
  after?: CriticPassStats;
  changesApplied: string[];
  unresolved?: string[];
}

export interface QualityScores {
  story_score: number;
  pacing_score: number;
  visual_continuity_score: number;
  audio_score: number;
  transition_score: number;
  caption_score: number;
  professionalism_score: number;
  overall: number;
}

export interface CriticReport {
  issues: CriticIssue[];
  scores: QualityScores;
  summary: string;
  approve: boolean;
}

/** Suggested edit from Analyze (not applied until user taps Apply). */
export interface EditInsight {
  id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  recommendation: string;
  /** Structured mutation for /api/edit/apply-mutation (optional) */
  mutation?: {
    op: string;
    sourceId?: string;
    sourceStart?: number;
    sourceEnd?: number;
    clipId?: string;
    parentSourceId?: string;
    mediaUrl?: string;
    mediaType?: string;
    at?: number;
    duration?: number;
    layout?: string;
    enabled?: boolean;
    mood?: string;
    clipIds?: string[];
    role?: ClipRole;
    [key: string]: unknown;
  };
}

export interface DirectorEditResult {
  ok: boolean;
  stage: string;
  /** analyze = insights only; recut = apply plan onto scenes */
  mode?: 'analyze' | 'recut';
  footageIntel?: FootageIntelligence[];
  /** Stage A observations (per take) for inspectability */
  observation?: Array<{ sourceId: string; observation?: TakeObservation; nativeVideoAnalyzed?: boolean }>;
  /** Stage B project understanding */
  projectUnderstanding?: ProjectUnderstanding;
  story?: StoryUnderstanding;
  brief?: DirectorCreativeBrief;
  editPlan?: ValidatedEditPlan;
  critic?: CriticReport;
  qualityScores?: QualityScores;
  iterations: number;
  criticIterations?: CriticIterationRecord[];
  scenes?: any[];
  channelSettings?: any;
  editingStyleSummary?: string;
  directorLog?: string[];
  criticWatchedRoughCut?: boolean;
  /** Insights-only suggestions (analyze mode) */
  insights?: EditInsight[];
  error?: string;
}
