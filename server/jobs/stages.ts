/** Named Director Edit / master-render stages — never invent a fake overall %. */

export const DIRECTOR_STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  observe: 'Reading take',
  understand: 'Story notes',
  direct: 'Suggestions',
  plan: 'Suggestions',
  rough: 'Rendering preview',
  critic: 'Suggestions',
  revise: 'Refining',
  final: 'Locking edit',
  done: 'Complete',
  error: 'Failed',
};

export const RENDER_STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Preparing clips',
  normalizing: 'Normalizing clips',
  assembling: 'Assembling timeline',
  overlays: 'Burning captions',
  mixing: 'Mixing soundtrack',
  uploading: 'Uploading master',
  done: 'Complete',
  error: 'Failed',
};

export function labelForDirectorStage(stage: string | undefined): string {
  if (!stage) return 'Working';
  return DIRECTOR_STAGE_LABELS[stage] || stage;
}

export function labelForRenderStage(stage: string | undefined): string {
  if (!stage) return 'Working';
  return RENDER_STAGE_LABELS[stage] || stage;
}

export function formatStageMessage(stage: string, message: string): string {
  const label = DIRECTOR_STAGE_LABELS[stage] || RENDER_STAGE_LABELS[stage] || stage;
  if (!message || message === label) return label;
  return `${label} — ${message}`;
}
