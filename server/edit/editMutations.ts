/**
 * Structured EDL mutations from user edit prompts (Runway-style).
 * Applies restore/drop/overlay/music/reorder with overlap safety.
 */
import type {
  FootageIntelligence,
  PlannedClip,
  ValidatedEditPlan,
} from '../../src/types/editorial';
import type { Project, Scene } from '../../src/types/director';
import {
  hasSourceOverlap,
  lastPrimarySpeechEnd,
  repairSourceOverlaps,
  validateGeneralEdlSequence,
} from './edlHoles';
import { MIN_USABLE_CLIP_SECONDS } from './editPolicy';
import { validateEditPlan, type SourceDurationMap } from './validateEdl';
import { snapCutToPause, tailOutAfterSpeech } from './audioEnvelope';

export type EditMutationOp =
  | {
      op: 'restore_range';
      sourceId: string;
      sourceStart: number;
      sourceEnd: number;
      role?: PlannedClip['role'];
    }
  | {
      op: 'drop_range';
      sourceId: string;
      sourceStart: number;
      sourceEnd: number;
    }
  | {
      op: 'add_overlay';
      parentClipId?: string;
      parentSourceId?: string;
      mediaUrl: string;
      mediaType?: 'image' | 'video';
      at: number;
      duration: number;
      layout?: 'full' | 'pip_br' | 'pip_bl';
      prompt?: string;
    }
  | {
      op: 'set_music';
      enabled: boolean;
      mood?: string;
    }
  | {
      op: 'reorder';
      clipIds: string[];
    }
  | {
      op: 'set_range';
      clipId: string;
      sourceStart: number;
      sourceEnd: number;
    };

export type EditPromptResult = {
  plan: ValidatedEditPlan;
  projectPatch: Partial<Project>;
  changes: string[];
  summary: string;
  musicMood?: string;
};

function sourceDurationMap(intel: FootageIntelligence[]): SourceDurationMap {
  const m: SourceDurationMap = {};
  for (const f of intel) m[f.sourceId] = f.sourceDuration;
  return m;
}

function nextClipId(sequence: PlannedClip[]): string {
  let max = 0;
  for (const c of sequence) {
    const m = String(c.id || '').match(/(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `c${max + 1}`;
}

/**
 * Apply structured mutations to an edit plan (+ optional scene overlay patches).
 */
export function applyEditMutations(
  current: ValidatedEditPlan,
  mutations: EditMutationOp[],
  intel: FootageIntelligence[],
  project: Project,
  opts?: { editPolicy?: string }
): EditPromptResult {
  const durations = sourceDurationMap(intel);
  let sequence = current.sequence.map((c) => ({ ...c }));
  const changes: string[] = [];
  const scenes = (project.scenes || []).map((s) => ({ ...s }));
  let musicEnabled = current.audioStrategy?.musicEnabled ?? false;
  let musicMood: string | undefined;
  const editPolicy = opts?.editPolicy || current.editPolicy || 'creative_recut';

  for (const mut of mutations) {
    switch (mut.op) {
      case 'restore_range': {
        const srcDur = durations[mut.sourceId];
        if (srcDur == null) {
          changes.push(`restore_range skipped: unknown source ${mut.sourceId}`);
          break;
        }
        let start = Math.max(0, mut.sourceStart);
        let end = Math.min(srcDur, Math.max(start + MIN_USABLE_CLIP_SECONDS, mut.sourceEnd));
        if (end - start < MIN_USABLE_CLIP_SECONDS) {
          changes.push(`restore_range skipped: too short`);
          break;
        }
        // Refuse if would fully nest inside existing same-source keep without adding value
        const id = nextClipId(sequence);
        const clip: PlannedClip = {
          id,
          sourceId: mut.sourceId,
          start,
          end,
          role: mut.role || 'context',
          transitionIn: 'hard_cut',
          transitionOut: 'hard_cut',
          zoom: 1,
          musicDuck: 'speech',
          notes: 'restored by edit prompt',
        };
        // Insert in timeline near chronological peers of same source, else append before last
        let insertAt = sequence.length;
        for (let i = 0; i < sequence.length; i++) {
          const c = sequence[i];
          if (!c.isBroll && c.sourceId === mut.sourceId && c.start > start) {
            insertAt = i;
            break;
          }
        }
        sequence.splice(insertAt, 0, clip);
        console.log(
          `[EDIT PROMPT] BEFORE: (none) AFTER: ${id} source=${start.toFixed(1)}–${end.toFixed(1)}`
        );
        changes.push(
          `restore_range ${mut.sourceId} source=${start.toFixed(1)}–${end.toFixed(1)} → ${id}`
        );
        break;
      }
      case 'drop_range': {
        const fDrop = intel.find((i) => i.sourceId === mut.sourceId);
        const speechEnd =
          fDrop?.audioEnvelope != null
            ? tailOutAfterSpeech(fDrop.audioEnvelope, 0.35)
            : fDrop
              ? lastPrimarySpeechEnd(fDrop)
              : null;
        let dropStart = mut.sourceStart;
        let dropEnd = mut.sourceEnd;
        // Clamp tail drops so they never start before protected CTA / speechEnd
        if (speechEnd != null && dropStart < speechEnd) {
          if (dropEnd <= speechEnd) {
            changes.push(
              `drop_range blocked: entirely inside protected speech ${dropStart.toFixed(1)}–${dropEnd.toFixed(1)}`
            );
            break;
          }
          dropStart = speechEnd;
          changes.push(
            `drop_range clamped to after speechEnd ${speechEnd.toFixed(1)}`
          );
        }
        // Polish: never carve interior holes — convert to head/tail trim only
        if (editPolicy === 'directed') {
          const targets = sequence.filter(
            (c) => !c.isBroll && c.sourceId === mut.sourceId
          );
          for (const c of targets) {
            const idx = sequence.findIndex((x) => x.id === c.id);
            if (idx < 0) continue;
            const nearHead = Math.abs(dropStart - c.start) < 0.6;
            const nearTail = Math.abs(dropEnd - c.end) < 0.6;
            if (nearHead && dropEnd < c.end - MIN_USABLE_CLIP_SECONDS) {
              let nextStart = dropEnd;
              if (fDrop?.audioEnvelope) {
                nextStart = snapCutToPause(nextStart, fDrop.audioEnvelope, 'in', 0.6);
              }
              sequence[idx] = { ...c, start: nextStart };
              changes.push(
                `polish drop→trim_start ${c.id} → ${nextStart.toFixed(1)}`
              );
            } else if (nearTail && dropStart > c.start + MIN_USABLE_CLIP_SECONDS) {
              let nextEnd = dropStart;
              if (fDrop?.audioEnvelope) {
                nextEnd = snapCutToPause(nextEnd, fDrop.audioEnvelope, 'out', 0.6);
              }
              if (speechEnd != null) nextEnd = Math.max(nextEnd, speechEnd);
              sequence[idx] = { ...c, end: nextEnd };
              changes.push(
                `polish drop→trim_end ${c.id} → ${nextEnd.toFixed(1)}`
              );
            } else {
              changes.push(
                `polish blocked interior drop_range on ${c.id} ${dropStart.toFixed(1)}–${dropEnd.toFixed(1)}`
              );
            }
          }
          break;
        }
        const next: PlannedClip[] = [];
        for (const c of sequence) {
          if (c.isBroll || c.sourceId !== mut.sourceId) {
            next.push(c);
            continue;
          }
          // Excise overlapping window
          if (c.end <= dropStart + 0.05 || c.start >= dropEnd - 0.05) {
            next.push(c);
            continue;
          }
          const leftDur = dropStart - c.start;
          const rightDur = c.end - dropEnd;
          console.log(
            `[EDIT PROMPT] BEFORE: ${c.id} source=${c.start.toFixed(1)}–${c.end.toFixed(1)}`
          );
          if (leftDur >= MIN_USABLE_CLIP_SECONDS) {
            next.push({ ...c, end: dropStart });
            console.log(
              `[EDIT PROMPT] AFTER: ${c.id} source=${c.start.toFixed(1)}–${dropStart.toFixed(1)}`
            );
          }
          if (rightDur >= MIN_USABLE_CLIP_SECONDS) {
            const rid = leftDur >= MIN_USABLE_CLIP_SECONDS ? `${c.id}b` : c.id;
            next.push({ ...c, id: rid, start: dropEnd });
            console.log(
              `[EDIT PROMPT] AFTER: ${rid} source=${dropEnd.toFixed(1)}–${c.end.toFixed(1)}`
            );
          }
          changes.push(
            `drop_range ${c.id} excised source=${dropStart.toFixed(1)}–${dropEnd.toFixed(1)}`
          );
        }
        sequence = next;
        break;
      }
      case 'set_range': {
        const idx = sequence.findIndex((c) => c.id === mut.clipId);
        if (idx < 0) {
          changes.push(`set_range skipped: unknown clip ${mut.clipId}`);
          break;
        }
        const c = sequence[idx];
        const srcDur = durations[c.sourceId] ?? c.end + 5;
        const start = Math.max(0, Math.min(mut.sourceStart, srcDur - MIN_USABLE_CLIP_SECONDS));
        const end = Math.min(srcDur, Math.max(start + MIN_USABLE_CLIP_SECONDS, mut.sourceEnd));
        if (
          Math.abs(start - c.start) < 0.04 &&
          Math.abs(end - c.end) < 0.04
        ) {
          console.log(
            `[EDIT PROMPT] skipped no-op set_range ${c.id} source=${c.start.toFixed(1)}–${c.end.toFixed(1)}`
          );
          break;
        }
        console.log(
          `[EDIT PROMPT] BEFORE: ${c.id} source=${c.start.toFixed(1)}–${c.end.toFixed(1)}`
        );
        sequence[idx] = { ...c, start, end };
        console.log(
          `[EDIT PROMPT] AFTER: ${c.id} source=${start.toFixed(1)}–${end.toFixed(1)}`
        );
        changes.push(
          `set_range ${c.id} source=${c.start.toFixed(1)}–${c.end.toFixed(1)} → ${start.toFixed(1)}–${end.toFixed(1)}`
        );
        break;
      }
      case 'add_overlay': {
        const parent =
          (mut.parentClipId && sequence.find((c) => c.id === mut.parentClipId)) ||
          (mut.parentSourceId &&
            sequence.find((c) => !c.isBroll && c.sourceId === mut.parentSourceId)) ||
          sequence.find((c) => !c.isBroll);
        if (!parent || !mut.mediaUrl) {
          changes.push('add_overlay skipped: no parent or media');
          break;
        }
        const sceneIdx = scenes.findIndex((s) => s.id === parent.sourceId);
        if (sceneIdx < 0) {
          changes.push(`add_overlay skipped: scene ${parent.sourceId} missing`);
          break;
        }
        const scene = scenes[sceneIdx];
        const insert = {
          id: `ov-${Date.now().toString(36)}`,
          mediaUrl: mut.mediaUrl,
          mediaType: (mut.mediaType || 'image') as 'image' | 'video',
          startOffsetSeconds: Math.max(0, mut.at),
          durationSeconds: Math.max(0.8, mut.duration || 2.5),
          layout: mut.layout || 'pip_br',
          source: (mut.mediaType === 'video' ? 'ai_video' : 'ai_still') as
            | 'ai_still'
            | 'ai_video',
          accepted: true,
          prompt: mut.prompt || 'edit prompt overlay',
          disclosureLabel: 'AI generated',
        };
        const existing = [...(scene.brollInserts || [])];
        existing.push(insert);
        scenes[sceneIdx] = { ...scene, brollInserts: existing };
        changes.push(
          `add_overlay on ${parent.id} at ${insert.startOffsetSeconds.toFixed(1)}s (${insert.layout})`
        );
        break;
      }
      case 'set_music': {
        musicEnabled = Boolean(mut.enabled);
        musicMood = mut.mood;
        changes.push(
          `set_music ${musicEnabled ? 'on' : 'off'}${mut.mood ? ` mood=${mut.mood}` : ''}`
        );
        break;
      }
      case 'reorder': {
        if (editPolicy === 'directed' && !/creative/i.test(String(opts?.editPolicy || ''))) {
          // Soft allow if user explicitly asked via mutation list — still apply but log
          console.log('[EDIT PROMPT] reorder on directed plan — applying (user requested)');
        }
        const byId = new Map(sequence.map((c) => [c.id, c]));
        const ordered: PlannedClip[] = [];
        for (const id of mut.clipIds) {
          const c = byId.get(id);
          if (c) {
            ordered.push(c);
            byId.delete(id);
          }
        }
        for (const c of sequence) {
          if (byId.has(c.id)) ordered.push(c);
        }
        if (ordered.map((c) => c.id).join('|') === sequence.map((c) => c.id).join('|')) {
          console.log('[EDIT PROMPT] skipped no-op reorder');
          break;
        }
        sequence = ordered;
        changes.push(`reorder → ${ordered.map((c) => c.id).join(',')}`);
        break;
      }
      default:
        break;
    }
  }

  if (hasSourceOverlap(sequence)) {
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    sequence = repaired.sequence;
    changes.push(...repaired.repairs.map((r) => `auto ${r}`));
  }

  const general = validateGeneralEdlSequence(sequence, intel);
  if (!general.ok) {
    console.warn(
      '[EDIT PROMPT] validation issues:',
      general.errors.map((e) => e.message).join('; ')
    );
  }

  const raw = {
    ...current,
    sequence,
    iteration: current.iteration + 1,
    audioStrategy: {
      ...current.audioStrategy,
      musicEnabled,
      notes: musicMood
        ? `${current.audioStrategy?.notes || ''} mood:${musicMood}`.trim()
        : current.audioStrategy?.notes || '',
    },
  };
  const validated = validateEditPlan(raw, durations, {
    projectId: current.projectId,
    iteration: current.iteration + 1,
    defaultAspect: current.aspectRatio,
    defaultStyle: current.style,
    targetDuration: current.targetDuration,
  });

  if (!validated.ok || !validated.plan) {
    // Last-chance repair
    const repaired = repairSourceOverlaps(sequence, MIN_USABLE_CLIP_SECONDS);
    const retry = validateEditPlan(
      { ...raw, sequence: repaired.sequence },
      durations,
      {
        projectId: current.projectId,
        iteration: current.iteration + 1,
        defaultAspect: current.aspectRatio,
        defaultStyle: current.style,
        targetDuration: current.targetDuration,
      }
    );
    if (!retry.plan) {
      return {
        plan: current,
        projectPatch: {},
        changes: [],
        summary: `Edit prompt rejected: ${(validated.errors || []).join('; ')}`,
      };
    }
    return {
      plan: retry.plan,
      projectPatch: {
        scenes,
        channelSettings: {
          ...(project.channelSettings as any),
        },
        editPlan: retry.plan,
      },
      changes: [...changes, ...repaired.repairs.map((r) => `auto ${r}`)],
      summary: changes.join('; ') || 'Applied repairs',
      musicMood,
    };
  }

  return {
    plan: validated.plan,
    projectPatch: {
      scenes,
      editPlan: validated.plan,
      channelSettings: musicEnabled
        ? {
            ...(project.channelSettings || ({} as any)),
            entryMusicEnabled: true,
          }
        : project.channelSettings,
    },
    changes,
    summary: changes.join('; ') || 'No changes',
    musicMood,
  };
}

/** Parse Gemini JSON mutations array safely. */
export function parseEditMutations(raw: unknown): {
  mutations: EditMutationOp[];
  summary: string;
} {
  const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  const list = Array.isArray((obj as any).mutations) ? (obj as any).mutations : [];
  const mutations: EditMutationOp[] = [];
  for (const m of list) {
    const op = String(m.op || '');
    if (op === 'restore_range' && m.sourceId != null) {
      mutations.push({
        op: 'restore_range',
        sourceId: String(m.sourceId),
        sourceStart: Number(m.sourceStart),
        sourceEnd: Number(m.sourceEnd),
        role: m.role,
      });
    } else if (op === 'drop_range' && m.sourceId != null) {
      mutations.push({
        op: 'drop_range',
        sourceId: String(m.sourceId),
        sourceStart: Number(m.sourceStart),
        sourceEnd: Number(m.sourceEnd),
      });
    } else if (op === 'add_overlay') {
      mutations.push({
        op: 'add_overlay',
        parentClipId: m.parentClipId ? String(m.parentClipId) : undefined,
        parentSourceId: m.parentSourceId ? String(m.parentSourceId) : undefined,
        mediaUrl: m.mediaUrl ? String(m.mediaUrl) : '',
        mediaType: m.mediaType === 'video' ? 'video' : 'image',
        at: Number(m.at) || 0,
        duration: Number(m.duration) || 2.5,
        layout: ['full', 'pip_br', 'pip_bl'].includes(m.layout) ? m.layout : 'pip_br',
        prompt: m.prompt ? String(m.prompt) : undefined,
      });
    } else if (op === 'set_music') {
      mutations.push({
        op: 'set_music',
        enabled: Boolean(m.enabled),
        mood: m.mood ? String(m.mood) : undefined,
      });
    } else if (op === 'reorder' && Array.isArray(m.clipIds)) {
      mutations.push({ op: 'reorder', clipIds: m.clipIds.map(String) });
    } else if (op === 'set_range' && m.clipId != null) {
      mutations.push({
        op: 'set_range',
        clipId: String(m.clipId),
        sourceStart: Number(m.sourceStart),
        sourceEnd: Number(m.sourceEnd),
      });
    }
  }
  return {
    mutations,
    summary: String((obj as any).summary || ''),
  };
}

export function buildEditPromptSystem(
  plan: ValidatedEditPlan,
  editPolicy: string
): string {
  const map = plan.sequence
    .map(
      (c) =>
        `${c.id} role=${c.role} sourceId=${c.sourceId} source=${c.start.toFixed(1)}–${c.end.toFixed(1)}${c.isBroll ? ' broll' : ''}`
    )
    .join('\n');
  return `You are TakeOne's edit assistant. The user will describe how to change the cut.
Return JSON ONLY:
{
  "mutations": [ ... ],
  "summary": "one sentence"
}
Allowed ops:
- restore_range { sourceId, sourceStart, sourceEnd, role? }
- drop_range { sourceId, sourceStart, sourceEnd }
- set_range { clipId, sourceStart, sourceEnd }
- add_overlay { parentClipId?, parentSourceId?, mediaUrl?, mediaType?, at, duration, layout: full|pip_br|pip_bl, prompt? }
- set_music { enabled, mood? }
- reorder { clipIds: string[] }

Rules:
- sourceStart/sourceEnd are SOURCE seconds on sourceId (never timeline seconds).
- editPolicy=${editPolicy}. If directed, prefer polish (drop dead air, overlays, music) over radical reorder unless user clearly asks to recut.
- If a relevant mediaUrl is provided in the available media list, use it. If the user asks for an overlay, cutaway, graphic, or visual not in the list, emit add_overlay with a descriptive prompt explaining the visual (mediaUrl can be omitted or empty and will be synthesized).
- Prefer pip_br for still overlays on talking-head, or full if the user asks for a full-screen cutaway.

Current EDL:
${map}`;
}
