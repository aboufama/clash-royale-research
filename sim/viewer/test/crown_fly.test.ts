// Crown flights and the crown counter's fade (viewer/src/sc/crown_fly.ts; libg 160402020 0x8d0dd8 /
// 0x8d2de0 / 0x8dd754 / 0x8dd90c / 0x8ddc70 / 0x8d1e6c).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alphaByte, CrownFly, CrownPanelFade, crownTowerGone } from '../src/sc/crown_fly.ts';

const f32 = Math.fround;
// star_appear / star_appear_enemy in sc/effects.sc: 130 frames at 60 fps, "startMove" on frame 109
const CLIP = { frames: 130, fps: 60, startMove: 109 };

test('0x8dd754 / 0x8dd90c: the star waits at the tower, then flies to the counter over the last frames', () => {
  const f = new CrownFly(true, CLIP);
  assert.equal(f.total, f32(f32(1 / 60) * 130));
  assert.equal(f.visible, false);
  assert.equal(f.flying, false);
  assert.equal(f.done, false);
  // not started: nothing happens
  f.update(1 / 60, [500, 300]);
  assert.equal(f.t, 0);
  assert.equal(f.visible, false);
  f.start(100, 700);
  assert.equal(f.flying, true);
  const dt = 1 / 60;
  let landed = 0, n = 0, firstMove = -1;
  const xs: number[] = [];
  while (f.flying && n < 400) {
    f.update(dt, [500, 300]);
    n++;
    if (f.takeLanded()) landed++;
    if (f.visible) xs.push(f.x);
    if (firstMove < 0 && f.x !== 100) firstMove = n;
    // shown frame = (int)(t * n / total), clamped
    assert.equal(f.frame, Math.min(129, Math.trunc(f32(f32(f.t * 130) / f.total))));
  }
  assert.equal(landed, 1);
  assert.equal(f.done, true);
  assert.equal(f.visible, false);
  // 130 frames of 1/60 s: lands on the 130th update (float32 time may need one more)
  assert.ok(n === 130 || n === 131, `landed after ${n} updates`);
  // the move starts once the shown frame reaches startMove (109) and ends on the target
  assert.ok(firstMove >= 109 && firstMove <= 111, `moved from update ${firstMove}`);
  assert.equal(f.x, 500);
  assert.equal(f.y, 300);
  // positions only advance toward the target
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1]);
  // a finished flight never starts again by itself (0x8ddb58 checks flying and done)
  assert.equal(f.flying, false);
});

test('0x8dd90c: the move fraction is moveT * n / (total * (n - startMove)), capped at 1', () => {
  const f = new CrownFly(false, CLIP);
  f.start(0, 0);
  // one step past the end: frame 129, moveT = dt -> k = dt * 130 / (total * 21) > 1
  const dt = 3;
  f.update(dt, [210, -420]);
  assert.equal(f.frame, 129);
  assert.equal(f.visible, false);
  assert.equal(f.takeLanded(), true);
  assert.equal(f.takeLanded(), false);
  assert.equal(f.x, 210); // k capped at 1
  assert.equal(f.y, -420);
});

test('0x8ddc70: a tower is gone when its King is dead or it is no longer alive', () => {
  assert.equal(crownTowerGone(false, true, false), true);
  assert.equal(crownTowerGone(false, false, true), true); // King dead: every crown of that team flies
  assert.equal(crownTowerGone(true, true, true), false);
  assert.equal(crownTowerGone(true, false, true), false);
  assert.equal(crownTowerGone(true, false, false), true);
});

test('0x8d1e6c: HUD_rightMiddle fades in at 4/s while a crown flies, holds 1 s, fades out at 2/s', () => {
  const p = new CrownPanelFade();
  const dt = 1 / 60;
  p.update(dt, false, false);
  assert.equal(p.alphaByte, 0);
  // flying: alpha byte = (int)(byte / 255 + 4 dt) * 255 each frame
  let byte = 0;
  for (let i = 0; i < 20; i++) {
    p.update(dt, true, false);
    byte = alphaByte(f32(f32(byte * f32(0.003921569)) + f32(dt * 4)));
    assert.equal(p.alphaByte, byte);
    assert.equal(p.hold, 1);
  }
  assert.equal(p.alphaByte, 255);
  // landed: the hold counts down 1 s (still fading in), then the counter fades out
  let frames = 0;
  while (p.hold > 0) { p.update(dt, false, false); frames++; }
  assert.ok(frames >= 59 && frames <= 61, `${frames}`);
  // the update that ran the hold out already faded: byte / 255 - 2 dt
  assert.equal(p.alphaByte, alphaByte(f32(1 - f32(dt + dt))));
  let out = 0;
  while (p.alphaByte > 0) { p.update(dt, false, false); out++; }
  assert.ok(out >= 28 && out <= 31, `${out} frames to fade out`);
  // battle over and nothing flying: straight out
  const q = new CrownPanelFade();
  q.alphaByte = 255;
  q.hold = 1;
  q.update(0.1, false, true);
  assert.ok(q.hold < 0);
  assert.equal(q.alphaByte, alphaByte(f32(1 - 0.2)));
});

test('0x123cbc0: alpha byte = (int)(clamp(a) * 255)', () => {
  assert.equal(alphaByte(-0.1), 0);
  assert.equal(alphaByte(1.5), 255);
  assert.equal(alphaByte(0.5), 127);
});
