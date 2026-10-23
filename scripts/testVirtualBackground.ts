/**
 * spreadVirtualBackground: one background across every shot the creator films.
 * Usage: npx tsx scripts/testVirtualBackground.ts
 */
import assert from 'node:assert/strict';
import { spreadVirtualBackground } from '../src/utils/virtualBackground';

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
console.log('ok — virtual background on every shot');
