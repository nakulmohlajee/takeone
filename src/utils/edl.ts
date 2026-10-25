import {
  AspectRatio,
  ChannelSettings,
  Project,
  Scene,
  TransitionType,
  VideoFormat,
} from '../types/director';
import type {
  ClipRole,
  MusicCue,
  TransitionPrimitive,
  ValidatedEditPlan,
} from '../types/editorial';
import { resolveOverlayWindow } from './overlayTiming';
import { matteIsCurrent } from './virtualBackground';
import { buildBasePlan } from './basePlan';

export interface TimedCaption {
  start: number;
  end: number;
  text: string;
}

/** B-roll / AI still overlay anchored inside a parent take (not a hard cutaway). */
export interface BrollInsert {
  id: string;
  /** Local or GCS media URL (image or video) */
  mediaUrl: string;
  mediaType: 'image' | 'video';
  /** Offset within the parent take where overlay starts */
  startOffsetSeconds: number;
  durationSeconds: number;
  /** How the overlay is composited on the talking-head frame */
  layout?: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
  source: 'ai' | 'upload' | 'ai_still' | 'ai_video' | 'footage';
  accepted: boolean;
  prompt?: string;
  disclosureLabel?: string;
}

/** Word timing remapped to clip-local seconds (for karaoke / word-pop captions). */
export interface EdlCaptionWord {
  w: string;
  start: number;
  end: number;
  conf?: number;
}

/** Text-only overlay (text pop / meme caption) in clip-local time. */
export interface EdlTextOverlay {
  id: string;
  kind: 'text_pop' | 'meme';
  text: string;
  startOffsetSeconds: number;
  durationSeconds: number;
}

export interface EdlClip {
  sceneId: string;
  title: string;
  filmedBy: 'user' | 'ai';
  /** Resolved media URL for the primary clip */
  mediaUrl: string | null;
  mediaKind: 'video' | 'image' | 'title-card' | 'missing';
  /** True timeline duration used by preview + render */
  durationSeconds: number;
  transition: TransitionType;
  transitionDuration: number;
  transcript?: string;
  captions: TimedCaption[];
  lowerThirdTitle?: string;
  lowerThirdSubtitle?: string;
  brollInserts: BrollInsert[];
  warning?: string;
  /** Source scene id (same as sceneId; explicit for planner EDL) */
  sourceId?: string;
  /** Trim in-point on source media (seconds) */
  inPoint?: number;
  /** Trim out-point on source media (seconds) */
  outPoint?: number;
  role?: ClipRole;
  transitionIn?: TransitionPrimitive;
  transitionOut?: TransitionPrimitive;
  crop?: 'none' | 'face_priority';
  zoom?: number;
  audioGainDb?: number;
  musicDuck?: 'speech' | 'lift' | 'hold';
  isBroll?: boolean;
  /** Soft A/V fade-out on this clip (seconds); used on final talking-head */
  fadeOutSeconds?: number;
  /** Recorded / uploaded MIME so the renderer can pick .mov/.mp4/.webm */
  mimeType?: string;
  /** 480p proxy for critic rough cuts (final always uses mediaUrl/source) */
  proxyUrl?: string;
  /**
   * Virtual background still to be added to this plain-camera take: the export cuts the person
   * out (RVM) and places them on this picture before assembling. Absent once the take is matted.
   */
  matteBackgroundUrl?: string;
  /** Director compiler: word-level captions in clip-local time (karaoke / bold pop) */
  captionWords?: EdlCaptionWord[];
  /** Director compiler: text pops / meme text in clip-local time */
  textOverlays?: EdlTextOverlay[];
  /** Director compiler: inserts that had no resolvable media yet (prompt only) */
  pendingInserts?: Array<{ anchorPhrase: string; kind: string; prompt?: string; startOffsetSeconds: number }>;
  /**
   * Director compiler: contiguous source segments for one scene (cleanup + punch-ins).
   * When present, the renderer builds one continuous take via a single filtergraph instead
   * of emitting one clip per piece (which caused voice dropouts at AAC concat joins).
   */
  segments?: Array<{ inPoint: number; outPoint: number; zoom?: number }>;
}

/** Overlay / B-roll event in parent-source time (timeline fields optional). */
export type EdlOverlayEvent = {
  id: string;
  sourceSceneId: string;
  parentSourceId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  layout: 'full' | 'pip_br' | 'pip_bl' | 'greenscreen';
  sourceStart: number; // parent-source seconds
  sourceEnd: number;
  timelineStart?: number;
  timelineEnd?: number;
};

export interface EditDecisionList {
  projectId: string;
  title: string;
  aspectRatio: AspectRatio;
  videoFormat: VideoFormat;
  musicMood: string;
  musicEnabled: boolean;
  musicGcsPath?: string | null;
  /** Bed level 0–0.4 (default 0.18). */
  musicVolume?: number;
  voiceoverEnabled?: boolean;
  voiceoverGcsPath?: string | null;
  channel: ChannelSettings;
  /** Cold-open first: intro sting after first hook scene when enabled */
  introMode: 'off' | 'after-hook';
  introDurationSeconds: number;
  outroSafeSeconds: number;
  clips: EdlClip[];
  /** Project-wide overlay events (parent-source timing) */
  overlayEvents?: EdlOverlayEvent[];
  totalDurationSeconds: number;
  warnings: string[];
  aiDisclosureRequired: boolean;
  musicCues?: MusicCue[];
  editPlanVersion?: number;
  /** Director compiler: caption look requested in ProductionPrefs */
  captionStyle?: 'bold_pop' | 'karaoke' | 'clean' | 'off';
  captionPosition?: 'bottom' | 'middle' | 'top';
  captionSize?: 'small' | 'medium' | 'large';
  /** Director compiler: ProductionPrefs.cleanup; renderer skips afftdn when both are false */
  cleanup?: { silences: boolean; fillers: boolean };
  /** Director compiler: what the compile changed (mirrors /api/director-cut report) */
  directorReport?: Record<string, unknown>;
}

function isDurableMediaUrl(url?: string | null): url is string {
  if (!url) return false;
  const s = String(url);
  return !s.startsWith('blob:') && !s.startsWith('data:');
}

function resolveMedia(
  scene: Scene,
  project?: Project
): { url: string | null; kind: 'video' | 'image' | 'title-card' | 'missing'; mimeType?: string } {
  if (scene.insertKind === 'title-card') {
    return { url: scene.userInsertUrl || scene.aiGeneratedImageUrl || null, kind: scene.userInsertUrl || scene.aiGeneratedImageUrl ? 'image' : 'title-card' };
  }
  if (scene.filmedBy === 'user') {
    // Server-matted take (person on the virtual background) replaces the camera file when current.
    if (matteIsCurrent(scene, project)) return { url: scene.mattedGcsPath!, kind: 'video', mimeType: 'video/mp4' };
    const durable =
      (isDurableMediaUrl(scene.gcsObjectPath) && scene.gcsObjectPath) ||
      (isDurableMediaUrl(scene.userRecordedVideoUrl) && scene.userRecordedVideoUrl) ||
      null;
    if (durable) {
      return { url: durable, kind: 'video' };
    }
    return { url: null, kind: 'missing' };
  }
  if (scene.userInsertUrl) {
    const isImg = /\.(png|jpe?g|gif|webp)$/i.test(scene.userInsertUrl) || scene.userInsertUrl.startsWith('data:image');
    return { url: scene.userInsertUrl, kind: isImg ? 'image' : 'video' };
  }
  if (scene.aiGeneratedVideoUrl) {
    return { url: scene.aiGeneratedVideoUrl, kind: 'video' };
  }
  if (scene.aiGeneratedImageUrl) {
    return { url: scene.aiGeneratedImageUrl, kind: 'image' };
  }
  return { url: null, kind: 'missing' };
}

/** Resolve keep ranges from scene; falls back to single in/out window. */
export function migrateKeepRanges(scene: Scene): Array<{ start: number; end: number }> {
  if (scene.keepRanges?.length) return scene.keepRanges;
  const inP = typeof scene.inPoint === 'number' ? scene.inPoint : 0;
  const outP =
    typeof scene.outPoint === 'number' && scene.outPoint > inP
      ? scene.outPoint
      : scene.recordedDuration || scene.durationSeconds || 0;
  if (outP > inP) return [{ start: inP, end: outP }];
  return [];
}

function clipDuration(scene: Scene): number {
  if (scene.insertKind === 'title-card') {
    return Math.min(Math.max(scene.durationSeconds || 2.2, 1.6), 3.2);
  }
  const ranges = migrateKeepRanges(scene);
  if (ranges.length > 1) {
    return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
  }
  if (
    typeof scene.inPoint === 'number' &&
    typeof scene.outPoint === 'number' &&
    scene.outPoint > scene.inPoint
  ) {
    return scene.outPoint - scene.inPoint;
  }
  if (scene.filmedBy === 'user') {
    if (scene.recordedDuration && scene.recordedDuration > 0.5) {
      return scene.recordedDuration;
    }
    return Math.max(scene.durationSeconds || 5, 3);
  }
  // AI cutaways / inserts default short
  if (scene.aiGeneratedVideoUrl) {
    return Math.min(Math.max(scene.durationSeconds || 3, 1.5), 4);
  }
  if (scene.aiGeneratedImageUrl) {
    return Math.min(Math.max(scene.durationSeconds || 2.5, 1.5), 3.5);
  }
  if (scene.userInsertUrl) {
    return Math.min(Math.max(scene.durationSeconds || 2.5, 1.5), 5);
  }
  if ((scene.insertKind as string | undefined) === 'title-card') {
    return Math.min(Math.max(scene.durationSeconds || 2.2, 1.6), 3.2);
  }
  return 0;
}

/** Remap transcript segments to clip-local time after in/out trim.
 * Returns [] (and caller should warn) when segment times do not span the clip. */
export function captionsForInOut(
  scene: Scene,
  inPoint: number,
  outPoint: number
): TimedCaption[] {
  const text = (scene.transcript || '').trim();
  if (!text) return [];

  const segs = scene.transcriptSegments || [];
  if (segs.length > 0) {
    const lastEnd = Math.max(...segs.map((s) => s.end || 0));
    // Compressed/stale Gemini times (e.g. last seg ends at 36s on a 52s keep) → skip burn
    if (lastEnd + 2 < outPoint) {
      console.warn(
        `[CAPTIONS] skipped for "${scene.title || scene.id}": last segment ends at ${lastEnd.toFixed(1)}s but clip out=${outPoint.toFixed(1)}s`
      );
      return [];
    }
    return segs
      .filter((s) => s.text?.trim() && s.end > inPoint && s.start < outPoint)
      .map((s) => ({
        start: Math.max(0, s.start - inPoint),
        end: Math.min(outPoint - inPoint, s.end - inPoint),
        text: s.text.trim(),
      }))
      .filter((s) => s.end > s.start + 0.05);
  }

  // No timed segments — do not invent a full-clip caption blob
  return [];
}

function captionsFromScene(scene: Scene): TimedCaption[] {
  // Only burn-in what the creator actually said — never teleprompter text
  const text = (scene.transcript || '').trim();
  if (!text) return [];

  if (
    typeof scene.inPoint === 'number' &&
    typeof scene.outPoint === 'number' &&
    scene.outPoint > scene.inPoint
  ) {
    return captionsForInOut(scene, scene.inPoint, scene.outPoint);
  }

  const segs = (scene as Scene & { transcriptSegments?: TimedCaption[] }).transcriptSegments;
  if (segs && segs.length > 0) {
    return segs.filter((s) => s.text?.trim());
  }

  const dur = clipDuration(scene);
  return [{ start: 0.15, end: Math.max(dur - 0.1, 0.8), text }];
}

function defaultIntroMode(format?: VideoFormat, settings?: ChannelSettings): 'off' | 'after-hook' {
  if (settings?.introMode) return settings.introMode;
  // Short-form: no intro by default. Long-form: optional sting after hook.
  if (format === 'long-form') {
    return settings?.youtubeIntroEnabled === false ? 'off' : 'after-hook';
  }
  return 'off';
}

/** True when text ends like a finished sentence/thought (not mid-clause). */
export function looksCompleteThought(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/[.!?…]["']?\s*$/.test(t)) return true;
  if (/\b(and|but|because|so|when|if|that|the|a|an|to|of|with)\s*$/i.test(t)) return false;
  const tail = t.slice(-40);
  return /[.!?…]/.test(tail);
}

/**
 * Intro sting is only valid after a finished hook (role=hook + complete thought).
 * Incomplete hooks must not get a mid-sentence brand sting.
 */
export function isHookCompleteForIntro(
  clips: Array<{ role?: string; isBroll?: boolean; inPoint?: number; outPoint?: number; transcript?: string }>,
  scene?: Scene | null
): boolean {
  const hook = clips.find((c) => !c.isBroll) || clips[0];
  if (!hook) return false;
  if (hook.role && hook.role !== 'hook') return false;

  const inP = typeof hook.inPoint === 'number' ? hook.inPoint : 0;
  const outP =
    typeof hook.outPoint === 'number'
      ? hook.outPoint
      : inP + (Number((hook as any).durationSeconds) || 0);

  // Prefer observation moments near the out-point
  const moments = scene?.footageIntel?.observation?.moments || [];
  const nearOut = moments.filter(
    (m) => m.end >= outP - 0.6 && m.start <= outP + 0.3
  );
  if (nearOut.some((m) => m.momentType === 'completed_thought' || m.momentType === 'natural_cut_point')) {
    return true;
  }

  const segs = scene?.footageIntel?.segments || [];
  const text =
    segs
      .filter((s) => s.end > inP && s.start < outP)
      .map((s) => s.transcript)
      .filter(Boolean)
      .join(' ') ||
    (hook.transcript || scene?.transcript || '').trim();

  return looksCompleteThought(text);
}

/** Map planner transition → legacy TransitionType for renderer compatibility */
export function primitiveToLegacyTransition(p?: TransitionPrimitive): TransitionType {
  switch (p) {
    case 'hard_cut':
    case 'cutaway':
    case 'match_cut':
    case 'j_cut':
    case 'l_cut':
      return 'cut';
    case 'cross_dissolve':
      return 'crossfade';
    case 'dip_black':
      return 'dip-black';
    case 'dip_white':
      return 'fade-to-black';
    case 'whip':
      return 'whip-pan';
    case 'zoom':
      return 'zoom-snap';
    case 'push':
      return 'dissolve';
    default:
      return 'cut';
  }
}

function buildChannel(project: Project, overrides?: Partial<ChannelSettings>): ChannelSettings {
  return {
    channelName: project.channelSettings?.channelName || 'My Channel',
    showWatermark: project.channelSettings?.showWatermark ?? false,
    watermarkPosition: project.channelSettings?.watermarkPosition || 'top-right',
    watermarkOpacity: project.channelSettings?.watermarkOpacity ?? 0.7,
    entryMusicEnabled: project.channelSettings?.entryMusicEnabled ?? false,
    entryMusicStyle: project.channelSettings?.entryMusicStyle || 'signature-chime',
    noiseRemovalEnabled: project.channelSettings?.noiseRemovalEnabled ?? true,
    captionsEnabled: project.channelSettings?.captionsEnabled ?? false,
    captionStyle: project.channelSettings?.captionStyle || 'modern-white',
    currentLanguage: project.channelSettings?.currentLanguage || 'en',
    youtubeIntroEnabled: project.channelSettings?.youtubeIntroEnabled,
    youtubeIntroDuration: project.channelSettings?.youtubeIntroDuration ?? 2.5,
    youtubeIntroStyle: project.channelSettings?.youtubeIntroStyle,
    youtubeChannelHandle: project.channelSettings?.youtubeChannelHandle || '@mychannel',
    youtubeTagline: project.channelSettings?.youtubeTagline || '',
    youtubeOutroEnabled: project.channelSettings?.youtubeOutroEnabled ?? false,
    youtubeOutroCta: project.channelSettings?.youtubeOutroCta || 'Thanks for watching',
    aiEditingPreset: project.channelSettings?.aiEditingPreset,
    logoUrl: project.channelSettings?.logoUrl,
    brandColor: project.channelSettings?.brandColor || '#1A73E8',
    introMode: project.channelSettings?.introMode,
    stingAudioUrl: project.channelSettings?.stingAudioUrl,
    musicTrackUrl: project.channelSettings?.musicTrackUrl,
    voiceoverUrl: project.channelSettings?.voiceoverUrl,
    voiceoverEnabled: project.channelSettings?.voiceoverEnabled,
    introBackgroundUrl: project.channelSettings?.introBackgroundUrl,
    introVideoUrl: project.channelSettings?.introVideoUrl,
    introPrompt: project.channelSettings?.introPrompt,
    styleBible: project.channelSettings?.styleBible,
    ...overrides,
  };
}

/**
 * Gather all overlay events for a project in parent-SOURCE seconds.
 * Sources: parent.brollInserts + AI scenes with mediaRole=overlay + overlayParentSceneId.
 */
export function collectOverlayEvents(project: Project): EdlOverlayEvent[] {
  const events: EdlOverlayEvent[] = [];
  const scenes = project.scenes || [];
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  for (const parent of scenes) {
    for (const ins of parent.brollInserts || []) {
      if (ins.accepted === false || !ins.mediaUrl) continue;
      const start = Math.max(0, ins.startOffsetSeconds || 0);
      const dur = Math.max(0.4, ins.durationSeconds || 2);
      events.push({
        id: ins.id || `broll-${parent.id}-${start}`,
        sourceSceneId: parent.id,
        parentSourceId: parent.id,
        mediaUrl: ins.mediaUrl,
        mediaType: ins.mediaType === 'video' ? 'video' : 'image',
        layout: ins.layout || 'pip_br',
        sourceStart: start,
        sourceEnd: start + dur,
      });
    }
  }

  for (const s of scenes) {
    if (s.mediaRole !== 'overlay') continue;
    if (s.aiVisualEnabled === false) continue;
    if (!s.overlayParentSceneId) continue;
    const parent = sceneById.get(s.overlayParentSceneId);
    const url = s.aiGeneratedImageUrl || s.aiGeneratedVideoUrl || s.userInsertUrl;
    if (!url) continue;
    const mediaType: 'image' | 'video' = s.aiGeneratedVideoUrl ? 'video' : 'image';

    let start: number;
    let dur: number;
    // Pop-in visuals stay short; a background plate may span the whole take.
    // Pop-in visuals default short; a length the creator set explicitly is respected (≤15s).
    const cap =
      s.overlayLayout === 'greenscreen'
        ? Number.POSITIVE_INFINITY
        : Math.max(3, Math.min(15, Number(s.overlayDurationSeconds) || 0));
    const hasExplicitOverlayStart =
      typeof s.overlayStartSeconds === 'number' && Number.isFinite(s.overlayStartSeconds);
    const hasInOut =
      typeof s.inPoint === 'number' &&
      typeof s.outPoint === 'number' &&
      s.outPoint > s.inPoint;
    const hasOverlayDur =
      typeof s.overlayDurationSeconds === 'number' && s.overlayDurationSeconds > 0.3;

    if (hasExplicitOverlayStart) {
      start = Math.max(0, s.overlayStartSeconds!);
      dur = hasOverlayDur
        ? Math.min(cap, s.overlayDurationSeconds!)
        : Math.min(cap, Math.max(1.2, s.durationSeconds || 2.5));
    } else if (hasInOut) {
      start = Math.max(0, s.inPoint!);
      dur = Math.min(cap, s.outPoint! - start);
    } else if (hasOverlayDur && typeof s.inPoint === 'number') {
      start = Math.max(0, s.inPoint);
      dur = Math.min(cap, s.overlayDurationSeconds!);
    } else {
      const win = resolveOverlayWindow(s, parent);
      start = win.startSeconds;
      dur = win.durationSeconds;
    }

    events.push({
      id: `overlay-${s.id}`,
      sourceSceneId: s.id,
      parentSourceId: s.overlayParentSceneId,
      mediaUrl: url,
      mediaType,
      layout: s.overlayLayout || 'pip_br',
      sourceStart: start,
      sourceEnd: start + Math.max(0.4, dur),
    });
  }

  return events;
}

function overlayEventToBrollInsert(ev: EdlOverlayEvent): BrollInsert {
  const fromOverlayScene = ev.id.startsWith('overlay-');
  return {
    id: ev.id,
    mediaUrl: ev.mediaUrl,
    mediaType: ev.mediaType,
    startOffsetSeconds: ev.sourceStart,
    durationSeconds: Math.max(0.4, ev.sourceEnd - ev.sourceStart),
    layout: ev.layout || 'pip_br',
    source: fromOverlayScene
      ? ev.mediaType === 'video'
        ? 'ai_video'
        : 'ai_still'
      : 'ai',
    accepted: true,
    disclosureLabel: fromOverlayScene ? 'AI generated' : undefined,
  };
}

/**
 * Collect accepted overlays for a planned A-roll window.
 * Derives from collectOverlayEvents filtered to parent; remapped to clip-local for render.
 */
export function collectOverlaysForClip(
  project: Project,
  parent: Scene,
  trimIn: number,
  trimOut: number
): BrollInsert[] {
  const out: BrollInsert[] = [];
  const clipDur = Math.max(0.3, trimOut - trimIn);

  const pushAdjusted = (ins: BrollInsert) => {
    if (ins.accepted === false || !ins.mediaUrl) return;
    // Canonical: startOffsetSeconds is parent-source absolute
    const rawStart = ins.startOffsetSeconds || 0;
    const rawDur = Math.max(0.4, ins.durationSeconds || 2);
    const absEnd = rawStart + rawDur;
    if (absEnd <= trimIn + 0.05 || rawStart >= trimOut - 0.05) return;
    const startOffsetSeconds = Math.max(0, rawStart - trimIn);
    const endInClip = Math.min(clipDur, absEnd - trimIn);
    const durationSeconds = Math.max(0.4, endInClip - startOffsetSeconds);
    if (durationSeconds < 0.4) return;
    out.push({
      ...ins,
      startOffsetSeconds,
      durationSeconds,
      layout: ins.layout || 'pip_br',
      source: ins.source || 'ai',
    });
  };

  const forParent = collectOverlayEvents(project).filter(
    (ev) => ev.parentSourceId === parent.id
  );
  for (const ev of forParent) {
    pushAdjusted(overlayEventToBrollInsert(ev));
  }

  return out;
}

/**
 * Build a render-ready Edit Decision List from a validated professional edit plan.
 * Honors in/out points, reorder, roles, and music cues.
 */
export function buildEditDecisionListFromPlan(
  project: Project,
  plan: ValidatedEditPlan,
  options?: {
    musicEnabled?: boolean;
    musicGcsPath?: string | null;
    musicVolume?: number;
    voiceoverEnabled?: boolean;
    voiceoverGcsPath?: string | null;
    channelOverrides?: Partial<ChannelSettings>;
    /** When set, overrides plan.aspectRatio (Master Cut player toggle wins) */
    aspectRatio?: AspectRatio;
  }
): EditDecisionList {
  const channel = buildChannel(project, options?.channelOverrides);
  const sceneById = new Map(project.scenes.map((s) => [s.id, s]));
  const warnings = [...(plan.warnings || [])];
  const clips: EdlClip[] = [];
  let aiDisclosureRequired = false;
  const resolvedAspect: AspectRatio =
    options?.aspectRatio ||
    project.aspectRatio ||
    plan.aspectRatio ||
    (project.videoFormat === 'long-form' ? '16:9' : '9:16');

  for (const planned of plan.sequence) {
    const scene = sceneById.get(planned.sourceId);
    if (!scene) {
      warnings.push(`Plan references missing source ${planned.sourceId}`);
      continue;
    }
    // Overlays never become main A-roll; untyped AI scenes stay out unless cutaway+export
    if (scene.mediaRole === 'overlay') continue;
    if (
      scene.filmedBy === 'ai' &&
      !planned.isBroll &&
      scene.insertKind !== 'title-card' &&
      !(scene.mediaRole === 'cutaway' && scene.includeInExport === true)
    ) {
      continue;
    }
    const media = resolveMedia(scene, project);
    if (media.kind === 'missing' && !planned.isBroll) {
      warnings.push(`Not in this cut: "${scene.title}" (no take yet).`);
      continue;
    }

    const inPoint = Math.max(0, planned.start);
    const outPoint = Math.max(inPoint + 0.3, planned.end);
    const userLocked = Boolean(scene.userTrimLocked);
    const userIn = typeof scene.inPoint === 'number' ? scene.inPoint : 0;
    const userOut =
      typeof scene.outPoint === 'number' && scene.outPoint > userIn ? scene.outPoint : null;
    // Only honor multi keepRanges when the user locked a trim/split
    const keepRanges =
      userLocked && scene.keepRanges && scene.keepRanges.length > 1
        ? scene.keepRanges
        : [];

    // Planned window; user lock clamps to keep intersection(s)
    let windowIn = inPoint;
    let windowOut = outPoint;
    if (userLocked && userOut != null) {
      windowIn = Math.max(userIn, inPoint);
      windowOut = Math.min(userOut, outPoint);
      if (windowOut - windowIn < 0.3) {
        windowIn = userIn;
        windowOut = userOut;
      }
    }

    const sceneDur =
      typeof scene.recordedDuration === 'number' && scene.recordedDuration > 0
        ? scene.recordedDuration
        : scene.durationSeconds || 0;

    // Multi-range: one EDL clip per locked keepRange overlapping the planned window
    const emitWindows: Array<{ trimIn: number; trimOut: number }> =
      keepRanges.length > 1
        ? keepRanges
            .map((r) => ({
              trimIn: Math.max(r.start, windowIn),
              trimOut: Math.min(r.end, windowOut),
            }))
            .filter((w) => w.trimOut - w.trimIn >= 0.15)
        : [{ trimIn: windowIn, trimOut: windowOut }];

    if (emitWindows.length === 0 && keepRanges.length > 1) {
      for (const r of keepRanges) {
        if (r.end - r.start >= 0.15) emitWindows.push({ trimIn: r.start, trimOut: r.end });
      }
    }
    if (emitWindows.length === 0) {
      emitWindows.push({ trimIn: windowIn, trimOut: windowOut });
    }

    if (scene.filmedBy === 'ai') aiDisclosureRequired = true;
    const transitionOut = planned.transitionOut || 'hard_cut';

    for (let wi = 0; wi < emitWindows.length; wi++) {
      let { trimIn, trimOut } = emitWindows[wi];
      if (sceneDur > 0 && !planned.isBroll) {
        if (trimIn >= sceneDur - 0.15) {
          trimIn = Math.max(0, sceneDur - 0.5);
        }
        if (trimOut > sceneDur) {
          trimOut = sceneDur;
        }
      }
      const duration = Math.max(0.2, trimOut - trimIn);
      let captions: TimedCaption[] = [];
      if (channel.captionsEnabled && !planned.isBroll) {
        captions = captionsForInOut(scene, trimIn, trimOut);
        if (
          !captions.length &&
          (scene.transcriptSegments || []).length > 0 &&
          (scene.transcript || '').trim()
        ) {
          warnings.push(
            `captions skipped: timestamps do not match this take ("${scene.title}")`
          );
        }
      }
      const inserts = collectOverlaysForClip(project, scene, trimIn, trimOut);
      if (inserts.some((b) => b.source === 'ai' || b.source === 'ai_still' || b.source === 'ai_video')) {
        aiDisclosureRequired = true;
      }
      const multiSuffix = emitWindows.length > 1 ? ` (${wi + 1}/${emitWindows.length})` : '';
      clips.push({
        sceneId: scene.id,
        sourceId: scene.id,
        title: planned.isBroll
          ? `B-roll: ${scene.title}${multiSuffix}`
          : `${scene.title}${multiSuffix}`,
        filmedBy: scene.filmedBy,
        mediaUrl: media.url,
        mediaKind: media.kind,
        mimeType: media.mimeType || scene.mimeType,
        // The proxy is of the camera take; a matted take has none.
        proxyUrl: media.mimeType ? undefined : (scene as Scene & { proxyUrl?: string }).proxyUrl,
        durationSeconds: duration,
        inPoint: trimIn,
        outPoint: trimOut,
        role: planned.role,
        transitionIn: wi === 0 ? planned.transitionIn || 'hard_cut' : 'hard_cut',
        transitionOut: wi === emitWindows.length - 1 ? transitionOut : 'hard_cut',
        transition: primitiveToLegacyTransition(
          wi === emitWindows.length - 1 ? transitionOut : 'hard_cut'
        ),
        transitionDuration: Math.min(planned.transitionDuration ?? 0.35, 0.7),
        crop: planned.crop || 'none',
        zoom: planned.zoom ?? 1,
        audioGainDb: planned.audioGainDb,
        musicDuck: planned.musicDuck,
        isBroll: planned.isBroll,
        transcript: scene.transcript,
        captions,
        lowerThirdTitle:
          scene.lowerThird && scene.lowerThird.style !== 'none' ? scene.lowerThird.title : undefined,
        lowerThirdSubtitle: scene.lowerThird?.subtitle,
        brollInserts: inserts,
      });
    }
  }

  const usedIds = new Set(clips.map((c) => c.sceneId));
  const directed =
    plan.editPolicy === 'directed' || (project as Project & { entryPath?: string }).entryPath === 'shoot';
  const sceneOrder = project.scenes.map((s) => s.id);
  for (const scene of project.scenes) {
    if (usedIds.has(scene.id)) continue;
    // Overlay-only AI assets are composited onto parents — never hard-cut scenes
    if (scene.mediaRole === 'overlay') continue;
    // Untyped AI scenes without cutaway + includeInExport stay out of the main sequence
    if (
      scene.filmedBy === 'ai' &&
      scene.insertKind !== 'title-card' &&
      !(scene.mediaRole === 'cutaway' && scene.includeInExport === true)
    ) {
      continue;
    }
    const leftover = resolveMedia(scene, project);
    if (leftover.kind === 'missing') continue;
    const leftoverDur = clipDuration(scene);
    if (leftoverDur <= 0) continue;
    const leftoverRanges = migrateKeepRanges(scene);
    const leftoverWindows =
      leftoverRanges.length > 0
        ? leftoverRanges
        : (() => {
            const leftoverIn = typeof scene.inPoint === 'number' ? scene.inPoint : 0;
            const leftoverOut =
              typeof scene.outPoint === 'number' && scene.outPoint > leftoverIn
                ? scene.outPoint
                : leftoverIn + leftoverDur;
            return [{ start: leftoverIn, end: leftoverOut }];
          })();

    const leftoverClips: EdlClip[] = leftoverWindows
      .filter((r) => r.end - r.start >= 0.15)
      .map((r, ri) => {
        const multiSuffix = leftoverWindows.length > 1 ? ` (${ri + 1}/${leftoverWindows.length})` : '';
        return {
          sceneId: scene.id,
          sourceId: scene.id,
          title: `${scene.title}${multiSuffix}`,
          filmedBy: scene.filmedBy,
          mediaUrl: leftover.url,
          mediaKind: leftover.kind,
          mimeType: leftover.mimeType || scene.mimeType,
          // The proxy is of the camera take; a matted take has none.
          proxyUrl: leftover.mimeType ? undefined : (scene as Scene & { proxyUrl?: string }).proxyUrl,
          durationSeconds: r.end - r.start,
          inPoint: r.start,
          outPoint: r.end,
          role: scene.editRole,
          zoom: scene.editZoom ?? 1,
          transition: scene.transition || 'cut',
          transitionDuration: Math.min(scene.transitionDuration ?? 0.35, 0.7),
          transcript: scene.transcript,
          captions:
            channel.captionsEnabled && (scene.transcript || '').trim()
              ? captionsForInOut(scene, r.start, r.end)
              : [],
          lowerThirdTitle:
            scene.lowerThird && scene.lowerThird.style !== 'none' ? scene.lowerThird.title : undefined,
          lowerThirdSubtitle: scene.lowerThird?.subtitle,
          brollInserts: [],
        };
      });
    if (leftoverClips.length === 0) continue;

    if (directed) {
      const sceneIdx = sceneOrder.indexOf(scene.id);
      let insertAt = clips.length;
      for (let i = 0; i < clips.length; i++) {
        const cid = clips[i].sourceId || clips[i].sceneId;
        const cIdx = sceneOrder.indexOf(cid);
        if (cIdx > sceneIdx) {
          insertAt = i;
          break;
        }
      }
      clips.splice(insertAt, 0, ...leftoverClips);
      warnings.push(`Restored directed beat "${scene.title}" at planned position.`);
    } else {
      clips.push(...leftoverClips);
      warnings.push(`Included "${scene.title}" — footage exists but was not in the director plan.`);
    }
    usedIds.add(scene.id);
  }

  // Soft fade on final talking-head (not a new transition style)
  for (let i = clips.length - 1; i >= 0; i--) {
    if (!clips[i].isBroll && clips[i].mediaKind === 'video') {
      clips[i].fadeOutSeconds = 0.2;
      break;
    }
  }

  let introMode = defaultIntroMode(project.videoFormat, channel);
  // Short-form stays off unless user explicitly enabled YouTube intro
  if (project.videoFormat !== 'long-form' && channel.youtubeIntroEnabled !== true) {
    introMode = 'off';
  }
  const hookScene = clips[0] ? sceneById.get(clips[0].sourceId || clips[0].sceneId) : null;
  if (introMode === 'after-hook' && !isHookCompleteForIntro(clips, hookScene || null)) {
    console.log('[INTRO skipped: hook incomplete]');
    warnings.push('INTRO skipped: hook incomplete');
    introMode = 'off';
  }
  const introDurationSeconds =
    introMode === 'after-hook' ? Math.min(channel.youtubeIntroDuration || 2.5, 3) : 0;
  const outroSafeSeconds =
    channel.youtubeOutroEnabled && plan.style !== 'high_energy_social' ? 5 : 0;

  const scenesTotal = clips.reduce((a, c) => a + c.durationSeconds, 0);
  let overlap = 0;
  for (let i = 1; i < clips.length; i++) {
    const t = clips[i].transitionOut || clips[i].transition;
    if (t !== 'cut' && t !== 'hard_cut' && t !== 'cutaway' && t !== 'match_cut' && t !== 'j_cut' && t !== 'l_cut') {
      overlap += (clips[i].transitionDuration || 0.35) * 0.5;
    }
  }

  const overlayEvents = collectOverlayEvents(project);
  if (overlayEvents.some((e) => e.mediaUrl)) {
    aiDisclosureRequired = true;
  }

  return {
    projectId: project.id,
    title: project.title,
    aspectRatio: resolvedAspect,
    videoFormat: project.videoFormat || 'short-form',
    musicMood: project.musicMood || 'Warm Acoustic',
    musicEnabled:
      options?.musicEnabled ??
      (plan.audioStrategy?.musicEnabled && Boolean(channel.musicTrackUrl)),
    musicGcsPath: options?.musicGcsPath ?? channel.musicTrackUrl ?? null,
    musicVolume:
      typeof options?.musicVolume === 'number'
        ? options.musicVolume
        : typeof project.musicVolume === 'number'
          ? project.musicVolume
          : 0.18,
    voiceoverEnabled:
      options?.voiceoverEnabled ?? Boolean(channel.voiceoverEnabled && channel.voiceoverUrl),
    voiceoverGcsPath: options?.voiceoverGcsPath ?? channel.voiceoverUrl ?? null,
    channel,
    introMode,
    introDurationSeconds,
    outroSafeSeconds,
    clips,
    overlayEvents,
    totalDurationSeconds: Math.max(0, introDurationSeconds + scenesTotal - overlap + outroSafeSeconds),
    warnings,
    aiDisclosureRequired,
    musicCues: plan.musicCues || [],
    editPlanVersion: plan.version,
  };
}

/**
 * Build a render-ready Edit Decision List from the project.
 * mode 'master' — ignores editPlan; envelope head/tail + locked keepRanges only.
 * Default — prefers editPlan when present, else base plan (for prompt/preview).
 */
export function buildEditDecisionList(
  project: Project,
  options?: {
    musicEnabled?: boolean;
    musicGcsPath?: string | null;
    musicVolume?: number;
    voiceoverEnabled?: boolean;
    voiceoverGcsPath?: string | null;
    channelOverrides?: Partial<ChannelSettings>;
    /** Master Cut stitch — never read AI editPlan */
    mode?: 'master' | 'plan';
    aspectRatio?: AspectRatio;
  }
): EditDecisionList {
  const warnings: string[] = [];
  const planOpts = {
    musicEnabled: options?.musicEnabled,
    musicGcsPath: options?.musicGcsPath,
    musicVolume: options?.musicVolume ?? project.musicVolume,
    voiceoverEnabled: options?.voiceoverEnabled,
    voiceoverGcsPath: options?.voiceoverGcsPath,
    channelOverrides: options?.channelOverrides,
    aspectRatio: options?.aspectRatio || project.aspectRatio,
  };

  // Master Cut: deterministic stitch — never AI editPlan
  if (options?.mode === 'master') {
    const base = buildBasePlan(project, { forMaster: true });
    const planned = buildEditDecisionListFromPlan(project, base, planOpts);
    if (planned.clips.length > 0) {
      planned.warnings = [
        ...(planned.warnings || []),
        'Master cut (envelope head/tail; AI edit plan ignored).',
        ...warnings,
      ];
      return planned;
    }
    warnings.push('Master base plan empty — falling back to scene-order stitch.');
  } else if (project.editPlan && project.editPlan.sequence?.length) {
    const planned = buildEditDecisionListFromPlan(project, project.editPlan, planOpts);
    if (planned.clips.length > 0) return planned;
    warnings.push('Director plan had no usable clips — stitching filmed/imported takes in scene order.');
  }

  // Prefer base plan path so preview/prompt always has a ValidatedEditPlan-shaped sequence
  const base = buildBasePlan(project);
  if (base.sequence.length) {
    const planned = buildEditDecisionListFromPlan(project, base, planOpts);
    if (planned.clips.length > 0) {
      planned.warnings = [
        ...(planned.warnings || []),
        'Used base cut plan (no AI edit plan yet).',
        ...warnings,
      ];
      return planned;
    }
  }

  const channel = buildChannel(project, options?.channelOverrides);
  const clips: EdlClip[] = [];
  let aiDisclosureRequired = false;
  const overlayEvents = collectOverlayEvents(project);

  for (const scene of project.scenes) {
    // Overlay assets composite onto parents — never primary sequence clips
    if (scene.mediaRole === 'overlay') continue;

    const media = resolveMedia(scene, project);
    const inPoint =
      typeof scene.inPoint === 'number' ? scene.inPoint : 0;
    const duration = clipDuration(scene);
    const outPoint =
      typeof scene.outPoint === 'number' && scene.outPoint > inPoint
        ? scene.outPoint
        : inPoint + duration;
    const inserts = collectOverlaysForClip(project, scene, inPoint, outPoint);

    const hasUserInsert = Boolean(scene.userInsertUrl);
    const isTitleCard = scene.insertKind === 'title-card' || media.kind === 'title-card';
    // Overlay scenes already skipped above (treated as includeInExport:false for main sequence)
    const aiApproved = scene.includeInExport === true || hasUserInsert || isTitleCard;

    if (scene.filmedBy === 'ai' && !aiApproved) {
      continue;
    }

    if (media.kind === 'missing' && inserts.length === 0) {
      warnings.push(`Not in this cut: "${scene.title}" (no take yet).`);
      continue;
    }

    if (
      scene.filmedBy === 'ai' ||
      inserts.some((i) => i.source === 'ai' || i.source === 'ai_still' || i.source === 'ai_video') ||
      isTitleCard
    ) {
      aiDisclosureRequired = scene.filmedBy === 'ai' && !isTitleCard ? true : aiDisclosureRequired;
    }

    if (duration <= 0) {
      warnings.push(`Skipped "${scene.title}" — zero duration.`);
      continue;
    }

    const keepRanges =
      scene.userTrimLocked && scene.keepRanges?.length
        ? scene.keepRanges
        : migrateKeepRanges(scene);
    const windows =
      keepRanges.length > 0
        ? keepRanges
        : [{ start: inPoint, end: outPoint }];

    for (let ri = 0; ri < windows.length; ri++) {
      const w = windows[ri];
      if (w.end - w.start < 0.15) continue;
      let captions: TimedCaption[] = [];
      if (channel.captionsEnabled && (scene.transcript || '').trim()) {
        captions = captionsForInOut(scene, w.start, w.end);
        if (!captions.length && (scene.transcriptSegments || []).length > 0) {
          warnings.push(
            `captions skipped: timestamps do not match this take ("${scene.title}")`
          );
        }
      }
      const multiSuffix = windows.length > 1 ? ` (${ri + 1}/${windows.length})` : '';
      const windowInserts = collectOverlaysForClip(project, scene, w.start, w.end);
      clips.push({
        sceneId: scene.id,
        sourceId: scene.id,
        title: `${scene.title}${multiSuffix}`,
        filmedBy: scene.filmedBy,
        mediaUrl: media.url,
        mediaKind: media.kind,
        mimeType: media.mimeType || scene.mimeType,
        durationSeconds: w.end - w.start,
        inPoint: w.start,
        outPoint: w.end,
        role: scene.editRole,
        zoom: scene.editZoom ?? 1,
        transition: scene.transition || (isTitleCard ? 'dissolve' : 'cut'),
        transitionDuration: Math.min(scene.transitionDuration ?? 0.35, 0.7),
        transcript: scene.transcript,
        captions,
        lowerThirdTitle:
          scene.lowerThird && scene.lowerThird.style !== 'none' ? scene.lowerThird.title : undefined,
        lowerThirdSubtitle: scene.lowerThird?.subtitle,
        brollInserts: windowInserts,
      });
    }
  }

  if (overlayEvents.length) {
    aiDisclosureRequired = true;
  }

  const introMode = defaultIntroMode(project.videoFormat, channel);
  let resolvedIntroMode = introMode;
  if (project.videoFormat !== 'long-form' && channel.youtubeIntroEnabled !== true) {
    resolvedIntroMode = 'off';
  }
  const sceneById = new Map(project.scenes.map((s) => [s.id, s]));
  const hookScene = clips[0] ? sceneById.get(clips[0].sourceId || clips[0].sceneId) : null;
  // For legacy path without plan roles, only allow intro when first clip looks complete
  if (resolvedIntroMode === 'after-hook' && !isHookCompleteForIntro(clips, hookScene || null)) {
    console.log('[INTRO skipped: hook incomplete]');
    warnings.push('INTRO skipped: hook incomplete');
    resolvedIntroMode = 'off';
  }
  const introDurationSeconds =
    resolvedIntroMode === 'after-hook' ? Math.min(channel.youtubeIntroDuration || 2.5, 3) : 0;
  const outroSafeSeconds = channel.youtubeOutroEnabled ? 5 : 0;

  for (let i = clips.length - 1; i >= 0; i--) {
    if (!clips[i].isBroll && clips[i].mediaKind === 'video') {
      clips[i].fadeOutSeconds = 0.2;
      break;
    }
  }

  const scenesTotal = clips.reduce((a, c) => a + c.durationSeconds, 0);
  let overlap = 0;
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].transition !== 'cut') {
      overlap += clips[i].transitionDuration * 0.5;
    }
  }

  const totalDurationSeconds = Math.max(
    0,
    introDurationSeconds + scenesTotal - overlap + outroSafeSeconds
  );

  return {
    projectId: project.id,
    title: project.title,
    aspectRatio: project.aspectRatio || (project.videoFormat === 'long-form' ? '16:9' : '9:16'),
    videoFormat: project.videoFormat || 'short-form',
    musicMood: project.musicMood || 'Warm Acoustic',
    musicEnabled: options?.musicEnabled ?? Boolean(channel.musicTrackUrl),
    musicGcsPath: options?.musicGcsPath ?? channel.musicTrackUrl ?? null,
    musicVolume:
      typeof options?.musicVolume === 'number'
        ? options.musicVolume
        : typeof project.musicVolume === 'number'
          ? project.musicVolume
          : 0.18,
    voiceoverEnabled:
      options?.voiceoverEnabled ?? Boolean(channel.voiceoverEnabled && channel.voiceoverUrl),
    voiceoverGcsPath: options?.voiceoverGcsPath ?? channel.voiceoverUrl ?? null,
    channel,
    introMode: resolvedIntroMode,
    introDurationSeconds,
    outroSafeSeconds,
    clips,
    overlayEvents,
    totalDurationSeconds,
    warnings,
    aiDisclosureRequired,
  };
}

export function formatEdlSummary(edl: EditDecisionList): string {
  return `${edl.clips.length} clips · ${edl.totalDurationSeconds.toFixed(1)}s · intro ${edl.introMode}`;
}

/** Apply a validated plan onto scene objects for client state persistence */
export function applyEditPlanToScenes(
  scenes: Scene[],
  plan: ValidatedEditPlan
): Scene[] {
  const byId = new Map(scenes.map((s) => [s.id, { ...s }]));

  // Clear prior in/out so unused takes don't linger incorrectly (preserve user locks + overlays)
  for (const s of byId.values()) {
    if (s.userTrimLocked) continue;
    if (s.mediaRole === 'overlay') continue;
    delete s.inPoint;
    delete s.outPoint;
    delete s.keepRanges;
    delete s.editRole;
  }

  // First A-roll occurrence of each source gets in/out for preview
  const seen = new Set<string>();
  for (const clip of plan.sequence) {
    if (clip.isBroll) continue;
    const scene = byId.get(clip.sourceId);
    if (!scene) continue;
    if (!seen.has(clip.sourceId)) {
      scene.inPoint = clip.start;
      scene.outPoint = clip.end;
      scene.editRole = clip.role;
      scene.editZoom = clip.zoom;
      scene.transition = primitiveToLegacyTransition(clip.transitionOut);
      scene.transitionDuration = clip.transitionDuration ?? 0.35;
      seen.add(clip.sourceId);
    }
  }

  return scenes.map((s) => byId.get(s.id) || s);
}
