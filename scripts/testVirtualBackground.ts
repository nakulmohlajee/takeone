/**
 * spreadVirtualBackground: one background across every shot the creator films.
 * Usage: npx tsx scripts/testVirtualBackground.ts
 */
import assert from 'node:assert/strict';
import { setVideoBackground, spreadVirtualBackground, videoBackground } from '../src/utils/virtualBackground';
import { applyAssetResults, findMissingAssets } from '../src/utils/aiVisuals';

const bg = { prompt: 'neon studio', assetUrl: 'gs://b/neon.jpg' };
const take = (id: string, recipe?: any, extra: any = {}) => ({ id, filmedBy: 'user', recipe, ...extra });

// Plan set it on shot 1 only → every take gets the same background; AI scenes untouched.
{
  const scenes = [
    take('s1', { layout: 'virtual_background', background: bg, inserts: [], punchIns: [] }),
    take('s2', { layout: 'talking_head', inserts: [{ kind: 'text_pop' }], punchIns: [] }),
    take('s3'),
    { id: 'ai1', filmedBy: 'ai' },
  ];
  const out = spreadVirtualBackground(scenes);
  assert.equal(out[1].recipe.layout, 'virtual_background');
  assert.deepEqual(out[1].recipe.background, bg);
  assert.equal(out[1].recipe.inserts.length, 1, 'existing inserts kept');
  assert.equal(out[2].recipe.layout, 'virtual_background');
  assert.equal(out[3], scenes[3]);
}
// Shot switched off by the creator stays off; pip / split layouts stay.
{
  const scenes = [
    take('s1', { layout: 'virtual_background', background: bg }),
    take('s2', { layout: 'talking_head' }, { virtualBackgroundOff: true }),
    take('s3', { layout: 'pip' }),
  ];
  const out = spreadVirtualBackground(scenes);
  assert.equal(out[1].recipe.layout, 'talking_head');
  assert.equal(out[2].recipe.layout, 'pip');
}
// Nothing to spread → same array (no re-render loop); look chosen with no plan → fallback prompt.
{
  const scenes = [take('s1', { layout: 'talking_head' }), take('s2')];
  assert.equal(spreadVirtualBackground(scenes), scenes);
  const out = spreadVirtualBackground(scenes, { lookChosen: true, fallbackPrompt: 'a library' });
  assert.equal(out[0].recipe.background.prompt, 'a library');
  assert.equal(out[1].recipe.background.prompt, 'a library');
  const again = spreadVirtualBackground(out, { lookChosen: true, fallbackPrompt: 'a library' });
  assert.equal(again, out, 'stable once applied');
}
// Three shots that each made their own picture → all use the first picture (one background).
{
  const scenes = [
    take('s1', { layout: 'virtual_background', background: { prompt: 'stadium', assetUrl: 'gs://b/one.jpg' } }),
    take('s2', { layout: 'virtual_background', background: { prompt: 'stadium', assetUrl: 'gs://b/two.jpg' } }),
    take('s3', { layout: 'virtual_background', background: { prompt: 'stadium' } }),
  ];
  const out = spreadVirtualBackground(scenes);
  assert.deepEqual(out.map((s: any) => s.recipe.background.assetUrl), ['gs://b/one.jpg', 'gs://b/one.jpg', 'gs://b/one.jpg']);
  assert.deepEqual(videoBackground(out), { prompt: 'stadium', assetUrl: 'gs://b/one.jpg' });
  // Changing the background changes it for every shot at once.
  const changed = setVideoBackground({ scenes: out }, { prompt: 'beach', assetUrl: undefined });
  assert.ok(changed.scenes.every((s: any) => s.recipe.background.prompt === 'beach' && !s.recipe.background.assetUrl));
}
// Only ONE background picture is ever queued for generation, however many shots there are.
{
  const project: any = {
    scenes: ['a', 'b', 'c', 'd'].map((id) => take(id, { layout: 'virtual_background', background: { prompt: 'library' }, inserts: [] })),
  };
  const missing = findMissingAssets(project, { looks: ['virtual_background'] } as any).filter((m) => m.kind === 'background');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'video:bg');
  const applied = applyAssetResults(project, new Map([['video:bg', 'gs://b/lib.jpg']]));
  assert.ok(applied.scenes.every((s: any) => s.recipe.background.assetUrl === 'gs://b/lib.jpg'));
}
console.log('ok — virtual background on every shot');
