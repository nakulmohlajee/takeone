/**
 * Run: npx tsx scripts/testCompile.ts
 * Smoke-tests compileDirectorCut with a synthetic project (no network, no ffmpeg).
 */
import assert from 'node:assert/strict';
import { ensureTakeWords } from '../server/cut/ensureWords';
import { compileDirectorCut, findPhraseInWords } from '../server/cut/compile';
import type { Project, ProductionPrefs } from '../src/types/director';

const words = [
  ['So', 0.6, 0.8],
  ['um', 0.85, 1.1],
  ['today', 1.15, 1.6],
  ['I', 1.65, 1.75],
  ['want', 1.78, 2.0],
  ['to', 2.02, 2.1],
  ['show', 2.12, 2.4],
  ['you', 2.42, 2.55],
  ['the', 2.57, 2.65],
  ['secret', 2.68, 3.2],
  ['to', 3.22, 3.3],
  ['viral', 3.32, 3.8],
  ['videos', 3.82, 4.4],
  // 1.6s dead air
  ['First', 6.0, 6.4],
  ['uh', 6.45, 6.7],
  ['hook', 6.75, 7.1],
  ['them', 7.12, 7.4],
  ['fast', 7.42, 7.9],
  ['and', 8.0, 8.2],
  ['keep', 8.22, 8.5],
  ['them', 8.52, 8.7],
  ['watching', 8.72, 9.4],
].map(([w, start, end]) => ({ w: w as string, start: start as number, end: end as number }));

const project: Project = {
  id: 'p1',
  title: 'Test',
  logline: 'x',
  estimatedTotalSeconds: 12,
  musicMood: 'Warm',
  createdAt: 0,
  videoFormat: 'short-form',
  aspectRatio: '9:16',
  scenes: [
    {
      id: 's1',
      sceneNumber: 1,
      title: 'Hook',
      filmedBy: 'user',
      durationSeconds: 10,
      plainInstruction: '',
      directorTip: '',
      gcsObjectPath: 'gs://bucket/takes/p1/s1.webm',
      mimeType: 'video/webm',
      recordedDuration: 10,
      includeInExport: true,
      transcript: words.map((w) => w.w).join(' '),
      words,
      wordsSource: 'stt',
      recipe: {
        layout: 'virtual_background',
        background: { prompt: 'neon studio', assetUrl: 'gs://bucket/bg/neon.jpg' },
        inserts: [
          { anchorPhrase: 'secret to viral videos', kind: 'text_pop', text: 'THE SECRET', layout: 'full', durationSec: 1.5 },
          { anchorPhrase: 'hook them fast', kind: 'broll_image', prompt: 'phone', layout: 'pip', durationSec: 2 },
        ],
        punchIns: [{ anchorPhrase: 'hook them fast', zoom: 1.1 }],
        transitionOut: 'zoom_snap',
      },
    } as any,
  ],
} as Project;

const prefs: ProductionPrefs = {
  shots: 'one_take',
  looks: ['talking_head', 'text_pops', 'broll', 'virtual_background'],
  captions: 'bold_pop',
  cleanup: { silences: true, fillers: true },
  music: false,
};

const m = findPhraseInWords(words, 'secret to viral video');
assert.ok(m && m.start === 2.68, 'fuzzy phrase match (video vs videos)');

const { edl, report } = compileDirectorCut({ project, prefs });
console.log(report.summary);
console.log(JSON.stringify(report, null, 2));

assert.equal(report.fillersRemoved, 2);
assert.ok(report.silenceRemovedSec > 1.2, `silence=${report.silenceRemovedSec}`);
assert.equal(report.punchIns, 1);
assert.equal(report.virtualBackgroundScenes, 1);
assert.equal(report.inserts, 1, 'text pop placed; broll has no media yet');
assert.equal(report.insertsUnresolved, 1);
// One clip per scene with segments (cleanup pieces + punch zooms)
assert.equal(edl.clips.length, 1, `expected 1 scene clip, got ${edl.clips.length}`);
const sceneClip = edl.clips[0];
assert.ok(sceneClip.segments && sceneClip.segments.length >= 2, 'scene has segments');
assert.ok(
  sceneClip.segments!.every((s) => (s.zoom || 1) === 1 || (s.zoom || 1) >= 1.12),
  'base zoom is 1.0; punches are ≥1.12',
);
assert.ok(sceneClip.segments!.some((s) => (s.zoom || 1) >= 1.12), 'a punch-in segment exists');
assert.equal(sceneClip.zoom || 1, 1, 'clip-level zoom stays 1.0');
assert.ok(sceneClip.captionWords && sceneClip.captions.length > 0);
assert.ok(sceneClip.brollInserts.some((b) => b.layout === 'greenscreen'));
assert.ok(sceneClip.textOverlays?.length);
assert.equal(edl.musicEnabled, false);
assert.equal(edl.captionStyle, 'bold_pop');
assert.ok(sceneClip.durationSeconds < 10, `cleaned duration ${sceneClip.durationSeconds} should be shorter than raw 10s`);
for (const s of sceneClip.segments!) {
  assert.ok(s.outPoint - s.inPoint >= 0.15, `segment too short: ${s.outPoint - s.inPoint}`);
}

// Rough (live-caption) word timings must never cut inside speech: head/tail trim only.
{
  const rough = {
    ...project,
    scenes: project.scenes.map((sc) => ({ ...sc, wordsSource: 'live' as const })),
  } as Project;
  const { edl: roughEdl, report: roughReport } = compileDirectorCut({ project: rough, prefs });
  const segs = roughEdl.clips[0].segments!;
  const span = segs[segs.length - 1].outPoint - segs[0].inPoint;
  const kept = segs.reduce((a, x) => a + (x.outPoint - x.inPoint), 0);
  assert.ok(Math.abs(span - kept) < 0.01, `rough timings cut inside speech (span ${span}, kept ${kept})`);
  assert.equal(roughReport.fillersRemoved, 0);
  assert.ok(roughReport.warnings.some((w) => w.includes('uncut between words')));
}

// A take recorded with the background baked in must not be keyed over a second plate.
{
  const bakedProject = {
    ...project,
    scenes: project.scenes.map((sc) => ({ ...sc, virtualBackgroundBaked: true })),
  } as Project;
  const { edl: bakedEdl, report: bakedReport } = compileDirectorCut({ project: bakedProject, prefs });
  assert.ok(
    !bakedEdl.clips[0].brollInserts.some((b) => b.layout === 'greenscreen'),
    'baked take got a greenscreen plate'
  );
  assert.equal(bakedReport.virtualBackgroundScenes, 1, 'baked take still counts as virtual background');
}

// A plain-camera take whose background job isn't done: no plate, and the export is told to cut
// it out itself (matteBackgroundUrl) — Export never waits.
{
  const rawProject = {
    ...project,
    scenes: project.scenes.map((sc) => ({ ...sc, virtualBackgroundMode: 'none' as const, matteStatus: 'running' as const })),
  } as Project;
  const { edl: rawEdl, report: rawReport } = compileDirectorCut({ project: rawProject, prefs });
  assert.ok(!rawEdl.clips[0].brollInserts.some((b) => b.layout === 'greenscreen'), 'raw take got a plate');
  assert.equal(rawEdl.clips[0].matteBackgroundUrl, 'gs://bucket/bg/neon.jpg', 'export not told to add the background');
  assert.ok(!rawReport.warnings.some((w) => /virtual background/i.test(w)), `unexpected warning: ${rawReport.warnings.join(' | ')}`);
  // Imported footage (no recording mode) is treated the same way.
  const imported = {
    ...project,
    scenes: project.scenes.map((sc) => ({ ...sc, mediaSource: 'imported' as const })),
  } as Project;
  assert.equal(compileDirectorCut({ project: imported, prefs }).edl.clips[0].matteBackgroundUrl, 'gs://bucket/bg/neon.jpg');
  // No picture yet → a clear warning instead.
  const noPic = {
    ...rawProject,
    scenes: rawProject.scenes.map((sc) => ({ ...sc, recipe: { ...sc.recipe!, background: { prompt: 'neon studio' } } })),
  } as Project;
  const np = compileDirectorCut({ project: noPic, prefs });
  assert.equal(np.edl.clips[0].matteBackgroundUrl, undefined);
  assert.ok(np.report.warnings.some((w) => w.includes("isn't ready yet")));
}

// A server-matted take (current take + current background) plays the matted file, with no plate.
{
  const matte = {
    matteStatus: 'ready' as const,
    mattedGcsPath: 'gs://bucket/matted/p1/s1-m1.mp4',
    mattedSourcePath: 'gs://bucket/takes/p1/s1.webm',
    mattedBackgroundUrl: 'gs://bucket/bg/neon.jpg',
  };
  const matted = { ...project, scenes: project.scenes.map((sc) => ({ ...sc, ...matte })) } as Project;
  const { edl: mEdl } = compileDirectorCut({ project: matted, prefs });
  assert.equal(mEdl.clips[0].mediaUrl, matte.mattedGcsPath, 'matted file not used');
  assert.equal(mEdl.clips[0].mimeType, 'video/mp4');
  assert.ok(!mEdl.clips[0].brollInserts.some((b) => b.layout === 'greenscreen'), 'matted take got a plate');
  assert.equal(mEdl.clips[0].matteBackgroundUrl, undefined, 'already matted, nothing to add');
  // Background changed since → the old matte is not used.
  const changed = {
    ...matted,
    scenes: matted.scenes.map((sc) => ({ ...sc, recipe: { ...sc.recipe!, background: { prompt: 'beach', assetUrl: 'gs://bucket/bg/beach.jpg' } } })),
  } as Project;
  const { edl: cEdl } = compileDirectorCut({ project: changed, prefs });
  assert.equal(cEdl.clips[0].mediaUrl, 'gs://bucket/takes/p1/s1.webm', 'stale matte used');
}

// A take saved shorter than its speech (old 1s-tick recorder: a 46s take saved as 29s) must keep
// every spoken word after ensureTakeWords fixes its length — and report no "you didn't say".
{
  const lastWordEnd = Math.max(...words.map((w) => w.end));
  const shortProject = {
    ...project,
    scenes: project.scenes.map((sc) => ({ ...sc, recordedDuration: 5 })),
  } as Project;
  const fixed = await ensureTakeWords(shortProject);
  assert.ok(
    (fixed.project.scenes[0].recordedDuration || 0) >= lastWordEnd,
    `length not fixed: ${fixed.project.scenes[0].recordedDuration}`
  );
  assert.ok(fixed.updates[project.scenes[0].id]?.recordedDuration, 'corrected length not reported back');
  const { edl: longEdl, report: longReport } = compileDirectorCut({ project: fixed.project, prefs });
  const segs = longEdl.clips[0].segments!;
  assert.ok(segs[segs.length - 1].outPoint >= lastWordEnd - 0.05, `cut still ends early at ${segs[segs.length - 1].outPoint}`);
  assert.ok(!longReport.warnings.some((w) => /didn't say/.test(w)), `false warning: ${longReport.warnings.join(' | ')}`);
}

console.log(`\nok — ${edl.clips.length} clip(s), ${sceneClip.segments!.length} segments, total ${edl.totalDurationSeconds.toFixed(2)}s`);
