/**
 * Tweak operations change what the export reads (kept ranges, recipe, prefs) and undo cleanly.
 * Run: npx tsx scripts/testTweaks.ts
 */
import assert from 'node:assert/strict';
import { applyTweakOps, currentKeep, subtractRange } from '../src/utils/tweaks';
import type { Project, ProductionPrefs } from '../src/types/director';
import { compileDirectorCut } from '../server/cut/compile';

const prefs: ProductionPrefs = { shots: 'one_take', looks: ['talking_head'], captions: 'bold_pop', cleanup: { silences: true, fillers: true }, music: true };
const words = Array.from({ length: 46 }, (_, i) => ({ w: `w${i}`, start: i, end: i + 0.6 }));
const base = {
  id: 'p', title: 'Vedic', videoFormat: 'short-form', aspectRatio: '9:16', estimatedTotalSeconds: 46, musicMood: 'Lo-fi', createdAt: 0,
  scenes: [{ id: 's1', sceneNumber: 1, title: 'Main take', filmedBy: 'user', durationSeconds: 45, recordedDuration: 29, words, wordsSource: 'stt', gcsObjectPath: 'gs://b/take.mp4', mimeType: 'video/mp4',
    plainInstruction: '', directorTip: '', inPoint: 0.5, outPoint: 29, userTrimLocked: true,
    recipe: { layout: 'talking_head', inserts: [{ anchorPhrase: 'w1 w2 w3', kind: 'broll_image', layout: 'full', prompt: 'x', durationSec: 3 }], punchIns: [{ anchorPhrase: 'w4 w5', zoom: 1.1 }], transitionOut: 'cut' } }],
} as unknown as Project;

// restore_full: trims cleared AND the take reaches its last spoken word (the 46s→29s bug).
{
  const r = applyTweakOps(base, prefs, [{ op: 'restore_full', sceneId: 's1' }]);
  const s = r.project.scenes[0];
  assert.equal(s.keepRanges, undefined);
  assert.equal(s.userTrimLocked, false);
  assert.ok((s.recordedDuration || 0) >= 45.6, `length ${s.recordedDuration}`);
  assert.equal(r.applied, 1);
  assert.equal(base.scenes[0].recordedDuration, 29, 'original project mutated (undo would break)');
}
// cut_range on an untrimmed take removes exactly that part.
{
  const untrimmed = { ...base, scenes: [{ ...base.scenes[0], inPoint: undefined, outPoint: undefined, userTrimLocked: false, recordedDuration: 46.2 }] } as Project;
  const r = applyTweakOps(untrimmed, prefs, [{ op: 'cut_range', sceneId: 's1', start: 0, end: 3 }]);
  assert.deepEqual(r.project.scenes[0].keepRanges, [{ start: 3, end: 46.2 }]);
  assert.deepEqual(subtractRange([{ start: 0, end: 10 }], 4, 6), [{ start: 0, end: 4 }, { start: 6, end: 10 }]);
  assert.deepEqual(currentKeep(untrimmed.scenes[0]), [{ start: 0, end: 46.2 }]);
}
// visuals, punch-ins and prefs; the look needed for a new visual is switched on.
{
  const r = applyTweakOps(base, prefs, [
    { op: 'add_visual', sceneId: 's1', anchorPhrase: 'w40 w41 w42', kind: 'text_pop', text: 'Humbled' },
    { op: 'add_visual', sceneId: 's1', anchorPhrase: 'w30 w31 w32', kind: 'overlay', prompt: 'a starry birth chart' },
    { op: 'remove_visual', sceneId: 's1', index: 0 },
    { op: 'remove_punch_in', sceneId: 's1', index: 0 },
    { op: 'add_punch_in', sceneId: 's1', anchorPhrase: 'w20 w21', zoom: 1.15 },
    { op: 'set_captions', style: 'karaoke' },
    { op: 'set_cleanup', fillers: false },
    { op: 'set_music', volume: 0.1, mood: 'Cinematic' },
  ]);
  const s = r.project.scenes[0];
  const kinds = s.recipe!.inserts.map((i) => `${i.kind}:${i.layout}`);
  assert.deepEqual(kinds, ['text_pop:full', 'broll_image:pip'], kinds.join(','));
  assert.equal(s.recipe!.inserts[0].text, 'HUMBLED');
  assert.deepEqual(s.recipe!.punchIns, [{ anchorPhrase: 'w20 w21', zoom: 1.15 }]);
  assert.equal(r.project.prefs!.captions, 'karaoke');
  assert.equal(r.project.prefs!.cleanup.fillers, false);
  assert.equal(r.project.prefs!.cleanup.silences, true);
  assert.equal(r.project.musicVolume, 0.1);
  assert.equal(r.project.musicMood, 'Cinematic');
  assert.ok(r.project.prefs!.looks.includes('text_pops') && r.project.prefs!.looks.includes('overlays'), 'looks not switched on');
  assert.equal(r.newVisualKeys.length, 1, 'only the image visual needs generating');
  assert.equal(r.newVisualKeys[0].prompt, 'a starry birth chart');
}
// Unknown scene ids change nothing.
{
  const r = applyTweakOps(base, prefs, [{ op: 'restore_full', sceneId: 'nope' }]);
  assert.equal(r.applied, 0);
}
// set_visual: longer, nudged, moved, resized, re-prompted — and the compiled cut really changes.
{
  const r = applyTweakOps(base, prefs, [
    { op: 'set_visual', sceneId: 's1', index: 0, duration: 5, nudge: -0.5, layout: 'pip', prompt: 'a new chart' },
  ]);
  const ins = r.project.scenes[0].recipe!.inserts[0];
  assert.equal(ins.durationSec, 5);
  assert.equal(ins.offsetSec, -0.5);
  assert.equal(ins.layout, 'pip');
  assert.equal(ins.prompt, 'a new chart');
  assert.equal(ins.assetUrl, undefined, 'old image kept after re-prompt');
  assert.deepEqual(r.newVisualKeys.map((k) => k.key), ['s1:ins:0']);
  const moved = applyTweakOps(r.project, prefs, [{ op: 'set_visual', sceneId: 's1', index: 0, moveTo: 'w10 w11 w12' }]);
  assert.equal(moved.project.scenes[0].recipe!.inserts[0].anchorPhrase, 'w10 w11 w12');
  assert.equal(moved.project.scenes[0].recipe!.inserts[0].offsetSec, 0);

  // Through the compiler: overlay 3s → 5s and 1s earlier shows up in the EDL.
  const withAsset = {
    ...base,
    scenes: [{ ...base.scenes[0], inPoint: undefined, outPoint: undefined, userTrimLocked: false, recordedDuration: 46.2,
      recipe: { ...base.scenes[0].recipe!, inserts: [{ anchorPhrase: 'w20 w21 w22', kind: 'broll_image', layout: 'pip', prompt: 'x', durationSec: 3, assetUrl: 'gs://b/x.jpg' }] } }],
  } as unknown as Project;
  const p2 = { ...prefs, looks: ['talking_head', 'overlays'] } as ProductionPrefs;
  const before = compileDirectorCut({ project: withAsset, prefs: p2 }).edl.clips[0].brollInserts[0];
  const tweaked = applyTweakOps(withAsset, p2, [{ op: 'set_visual', sceneId: 's1', index: 0, duration: 5, nudge: -1 }]).project;
  const after = compileDirectorCut({ project: tweaked, prefs: p2 }).edl.clips[0].brollInserts[0];
  assert.equal(Math.round(before.durationSeconds), 3);
  assert.equal(Math.round(after.durationSeconds), 5, `duration ${after.durationSeconds}`);
  assert.ok(Math.abs(after.startOffsetSeconds - (before.startOffsetSeconds - 1)) < 0.05, `start ${before.startOffsetSeconds} → ${after.startOffsetSeconds}`);
}
// captions look, punch-in, reorder, aspect
{
  const two = { ...base, scenes: [base.scenes[0], { ...base.scenes[0], id: 's2', title: 'Second' }] } as Project;
  const r = applyTweakOps(two, prefs, [
    { op: 'set_captions', position: 'top', size: 'large' },
    { op: 'set_punch_in', sceneId: 's1', index: 0, zoom: 1.25 },
    { op: 'reorder_takes', order: ['s2', 's1'] },
    { op: 'set_aspect', ratio: '16:9' },
  ]);
  assert.equal(r.project.prefs!.captionPosition, 'top');
  assert.equal(r.project.prefs!.captionSize, 'large');
  assert.equal(r.project.prefs!.captions, 'bold_pop', 'style kept');
  assert.deepEqual(r.project.scenes.map((s) => s.id), ['s2', 's1']);
  assert.equal(r.project.scenes.find((s) => s.id === 's1')!.recipe!.punchIns[0].zoom, 1.25);
  assert.equal(r.project.aspectRatio, '16:9');
}
// virtual background: change the place, switch it off
{
  const r = applyTweakOps(base, prefs, [{ op: 'set_background', sceneId: 's1', prompt: 'a beach at sunset' }]);
  const rc = r.project.scenes[0].recipe!;
  assert.equal(rc.layout, 'virtual_background');
  assert.equal(rc.background!.prompt, 'a beach at sunset');
  assert.equal(rc.background!.assetUrl, undefined);
  assert.deepEqual(r.newVisualKeys.map((k) => k.key), ['s1:bg']);
  const off = applyTweakOps(r.project, prefs, [{ op: 'set_background', sceneId: 's1', on: false }]);
  assert.equal(off.project.scenes[0].recipe!.layout, 'talking_head');
  assert.equal(off.newVisualKeys.length, 0);
}
console.log('ok — tweak operations');
