/**
 * Acceptance: VedicJourney 55s UGC — envelope, base plan, preflight, overlay layer.
 *
 * Usage:
 *   npx tsx scripts/acceptVedic.ts
 *   npx tsx scripts/acceptVedic.ts /path/to/request.json /path/to/take.mp4
 *
 * Defaults to GCS job 25d73572… / local /tmp copies if present.
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import {
  computeAudioEnvelope,
  applyEnvelopeToIntel,
  retimeSegmentsToAudio,
} from '../server/edit/audioEnvelope';
import { buildBasePlan } from '../src/utils/basePlan';
import { buildEditDecisionList } from '../src/utils/edl';
import { runEdlPreflight } from '../src/utils/edlPreflight';
import type { Project } from '../src/types/director';
import type { FootageIntelligence } from '../src/types/editorial';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function loadProject(requestPath: string): Promise<Project> {
  const raw = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  return (raw.project || raw) as Project;
}

async function main() {
  const requestPath =
    process.argv[2] ||
    (existsSync('/tmp/req.json') ? '/tmp/req.json' : '');
  const videoPath =
    process.argv[3] ||
    (existsSync('/tmp/vedic.mp4') ? '/tmp/vedic.mp4' : '');

  if (!requestPath || !existsSync(requestPath)) {
    console.error('Need request.json path (or /tmp/req.json from prior gcloud cp)');
    process.exit(1);
  }
  if (!videoPath || !existsSync(videoPath)) {
    console.error('Need source video path (or /tmp/vedic.mp4)');
    process.exit(1);
  }

  const project = await loadProject(requestPath);
  console.log(`Project: ${project.title} (${project.id})`);

  const envelope = await computeAudioEnvelope(videoPath);
  assert(envelope, 'envelope computed');
  console.log(
    `Envelope: speech=${envelope.speechStart.toFixed(2)}–${envelope.speechEnd.toFixed(2)} dur=${envelope.duration.toFixed(2)} pauses=${envelope.pauses.length}`
  );

  // Real speech ends ~54.26 on this take
  assert(envelope.speechEnd >= 52, `speechEnd too early: ${envelope.speechEnd}`);
  assert(envelope.speechEnd <= envelope.duration, 'speechEnd <= duration');

  const main = project.scenes.find((s) => s.filmedBy === 'user' || s.mediaRole === 'capture')!;
  assert(main, 'main take scene');
  const segments = (main.transcriptSegments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
  }));
  const lastBefore = segments[segments.length - 1]?.end ?? 0;
  const retimed = retimeSegmentsToAudio(segments, envelope);
  const lastAfter = retimed[retimed.length - 1]?.end ?? 0;
  console.log(`Retime: lastSeg ${lastBefore.toFixed(2)} → ${lastAfter.toFixed(2)}`);
  assert(Math.abs(lastAfter - envelope.speechEnd) < 0.05, 'retimed last end == speechEnd');

  const stubIntel: FootageIntelligence = {
    sourceId: main.id,
    sourceDuration: envelope.duration,
    fullTranscript: main.transcript || '',
    segments: [],
    analyzedAt: Date.now(),
    nativeVideoAnalyzed: true,
    observation: {
      shots: [{ shotId: 'shot-1', start: 0, end: envelope.duration } as any],
      moments: segments.map((s, i) => ({
        start: s.start,
        end: s.end,
        shotId: 'shot-1',
        transcript: s.text,
        momentType: i === segments.length - 1 ? 'completed_thought' : 'speech_beat',
        description: s.text.slice(0, 80),
        containsSilence: false,
        containsFiller: false,
        containsMistake: false,
        repetitionObserved: false,
        naturalCutPoints: [],
      })),
      audio: {
        speechPresent: true,
        speakerCount: 1,
        dialogueClarity: 'unknown',
        backgroundNoise: 'unknown',
        clipping: 'unknown',
        volumeConsistency: 'unknown',
        musicPresent: false,
        silenceRanges: [{ start: 35.1, end: 55 }], // bogus Gemini silence — must be replaced
      },
    },
  };

  const intel = applyEnvelopeToIntel(stubIntel, envelope, segments);
  assert(intel.audioEnvelope?.speechEnd === envelope.speechEnd, 'intel has envelope');
  main.footageIntel = intel;
  if (intel.retimedTranscriptSegments?.length) {
    main.transcriptSegments = intel.retimedTranscriptSegments;
  }

  // Clear any stale editPlan so base plan path is used
  delete (project as any).editPlan;

  const plan = buildBasePlan(project);
  assert(plan.sequence.length >= 1, 'base plan has clips');
  const keep = plan.sequence[0];
  console.log(`Base plan keep: ${keep.start.toFixed(2)}–${keep.end.toFixed(2)}`);
  assert(keep.end >= 54.0, `CTA preserved: end=${keep.end} (want >= 54)`);
  assert(keep.end <= envelope.duration + 0.05, `end <= duration`);
  assert(keep.start < 2, `head trim near speech start, got ${keep.start}`);

  project.editPlan = plan;
  const edl = buildEditDecisionList(project);
  assert(edl.clips.length >= 1, 'edl has video clips');
  for (const c of edl.clips) {
    const scene = project.scenes.find((s) => s.id === c.sceneId || s.id === c.sourceId);
    assert(scene?.mediaRole !== 'overlay', `video clip must not be overlay: ${c.title}`);
  }

  const overlayScenes = project.scenes.filter((s) => s.mediaRole === 'overlay');
  assert(overlayScenes.length >= 1, 'project has overlay scene');
  assert(
    (edl.overlayEvents?.length || 0) >= 1 ||
      edl.clips.some((c) => (c.brollInserts || []).length > 0),
    'overlay present as overlayEvents or brollInserts'
  );
  console.log(
    `Overlays: events=${edl.overlayEvents?.length || 0} brollOnClips=${edl.clips.reduce((a, c) => a + (c.brollInserts?.length || 0), 0)}`
  );

  const pre = runEdlPreflight({ project, edl, plan, autoRepair: true });
  console.log(`Preflight ok=${pre.ok} repaired=${pre.repaired} errors=${pre.errors.length} warnings=${pre.warnings.length}`);
  if (pre.errors.length) console.log(pre.errors);
  assert(pre.ok || pre.repaired, 'preflight ok or repaired');

  const finalOut = pre.edl.clips[pre.edl.clips.length - 1]?.outPoint ?? keep.end;
  assert(finalOut >= 54.0, `final out ${finalOut} preserves CTA`);
  assert(finalOut <= 55.6, `final out ${finalOut} trims trailing dead air`);

  console.log('OK: acceptVedic passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
