/**
 * keepMainPerson + planGeometry (server/matting/rvm.ts).
 * Usage: npx tsx scripts/testMatte.ts
 */
import assert from 'node:assert/strict';
import { keepMainPerson, planGeometry } from '../server/matting/rvm';

const W = 200;
const H = 120;
const mask = () => new Float32Array(W * H);
const rect = (m: Float32Array, x0: number, y0: number, x1: number, y1: number, v = 1) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = v;
};

// Body + small face-like blob (a photo frame) → blob removed, body kept.
{
  const m = mask();
  rect(m, 80, 30, 140, 120);
  rect(m, 10, 20, 26, 36);
  const out = keepMainPerson(m, W, H);
  assert.equal(out[100 * W + 100], 1, 'body kept');
  assert.equal(out[28 * W + 18], 0, 'photo-frame blob removed');
}
// Two people of similar size → both kept.
{
  const m = mask();
  rect(m, 20, 30, 70, 120);
  rect(m, 120, 35, 175, 120);
  const out = keepMainPerson(m, W, H);
  assert.equal(out[80 * W + 40], 1);
  assert.equal(out[80 * W + 150], 1);
}
// Soft hair edge right next to the body survives.
{
  const m = mask();
  rect(m, 80, 40, 140, 120);
  rect(m, 84, 30, 136, 40, 0.2); // faint hair just above, below the 0.3 "solid" threshold
  const out = keepMainPerson(m, W, H);
  assert.ok(Math.abs(out[34 * W + 100] - 0.2) < 1e-6, 'hair kept');
}
// Geometry: 1920x1080 camera → 9:16 crop, long side ≤ 1280, even sizes.
{
  const g = planGeometry(1920, 1080, '9:16');
  assert.equal(g.crop.h, 1080);
  assert.equal(g.crop.w % 2, 0);
  assert.ok(Math.abs(g.crop.w / g.crop.h - 9 / 16) < 0.01);
  assert.ok(g.out.h <= 1280 && g.out.w % 2 === 0 && g.out.h % 2 === 0);
  const wide = planGeometry(1920, 1080, '16:9');
  assert.deepEqual([wide.out.w, wide.out.h], [1280, 720]);
}
console.log('ok — matting helpers');
