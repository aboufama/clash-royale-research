// Area-damage indicator rings (viewer/src/sc/area_rings.ts: listener 0xbe76e8 / 0xbe7980, ring class
// 0xcf0464 with meshes 0xcf05d4 / 0xcf0838 -> 0xcf152c, fade in the battle screen update 0xbe1d3c) and
// the footstep effects of the character view update 0x840d44 (viewer/src/sc/unit_fx.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alphaByte, AREA_DAMAGE_INDICATOR_DURATION_MS, AREA_RING_RGB, AreaRings, indicatorMesh, PUSH_RING_RGB, rectFrameStrip,
  ringRadiiPx,
} from '../src/sc/area_rings.ts';
import { ringBand, ringStrip } from '../src/sc/ui_port.ts';
import { stepCrossed, UnitFx, type StepFxPlayer } from '../src/sc/unit_fx.ts';
import type { CharacterArt } from '../src/sc/manifest.ts';
import type { PlayOptions } from '../src/sc/effects.ts';
import type { AnimFrame } from '../src/sc/anim.ts';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('ring size: R * 0.03 and R2 * 0.024 times the battle layer scale (float32)', () => {
  const [rx, ry] = ringRadiiPx(2500, 0, 1.5, 1.5);
  close(rx, 112.5, 1e-4);
  assert.equal(ry, 0);
  const [ax, ay] = ringRadiiPx(1950, 600, 1, 1);
  close(ax, 58.5, 1e-4);
  close(ay, 14.4, 1e-4);
});

test('ellipse ring (R2 = 0): the 0xcf0838 band and the 0xcf152c strip with y / 1.25', () => {
  const m = indicatorMesh(75, 0, 32);
  assert.deepEqual([...m], [...ringStrip(75, ringBand(75, 32), 1.25)]);
  // band: texture height 32 unless that leaves less than half (R - 32 <= R / 2)
  assert.equal(ringBand(75, 32), 32);
  assert.equal(ringBand(60, 32), 30);
  // outer point at angle 90 degrees: (0, 75 / 1.25)
  const n = m.length / 8 - 1;
  const q = Math.round(n / 4);
  close(m[q * 8 + 1], 60, 1e-3);
});

test('rectangle frame (R2 > 0, 0xcf05d4): 10 vertices around, band from the smaller half extent', () => {
  const v = rectFrameStrip(100, 40, 32);
  assert.equal(v.length, 40);
  // band: rx > ry, so ry decides: 40 - 32 <= 20 -> 20
  assert.deepEqual([...v.slice(0, 8)], [100, -40, 0, 0, 80, -20, 1, 1]);
  assert.deepEqual([...v.slice(8, 16)], [100, 40, 0, 0, 80, 20, 1, 1]);
  assert.deepEqual([...v.slice(16, 24)], [-100, 40, 0, 0, -80, 20, 1, 1]);
  assert.deepEqual([...v.slice(24, 32)], [-100, -40, 0, 0, -80, -20, 1, 1]);
  assert.deepEqual([...v.slice(32, 40)], [...v.slice(0, 8)]);
  // rx <= ry: rx decides (100 - 32 > 50 -> 32)
  const w = rectFrameStrip(100, 300, 32);
  assert.deepEqual([...w.slice(0, 8)], [100, -300, 0, 0, 68, -268, 1, 1]);
  assert.deepEqual([...indicatorMesh(100, 40, 32)], [...v]);
});

test('fade (0xbe1d3c): alpha 1 - t / 0.4 as a byte, then t += dt; gone once t passes 0.4 s', () => {
  assert.equal(AREA_DAMAGE_INDICATOR_DURATION_MS, 400);
  const g = new AreaRings();
  g.onEvents([{ type: 'areaRing', x: 9000, y: 16000, r: 2500, r2: 0 }, { type: 'hit', x: 0, y: 0 }]);
  assert.equal(g.list.length, 1);
  const alphas: number[] = [];
  for (let i = 0; i < 8 && g.list.length; i++) {
    g.update(0.1);
    if (g.list.length) alphas.push(Math.round(g.list[0].alpha * 255));
  }
  // ages before each update 0, 0.1, 0.2, 0.3 (after it 0.4 = fround(0.4): kept); the fifth sets alpha 0
  // from age 0.4 and deletes the ring in the same update (age 0.5 > 0.4), so it is never drawn at 0
  assert.deepEqual(alphas, [255, alphaByte(0.75), 127, alphaByte(0.25)]);
  assert.equal(g.list.length, 0);
  assert.equal(alphaByte(1.5), 255);
  assert.equal(alphaByte(-0.1), 0);
});

test('draw: both calls in the HUD layer at the truncated projection, tinted (255,127,127) / grey, no team', () => {
  const g = new AreaRings();
  g.onEvents([
    { type: 'areaRing', x: 1000, y: 2000, r: 2500, r2: 0 },
    { type: 'pushRing', x: 1000, y: 2000, r: 1000 },
  ]);
  g.update(0);
  const calls: { v: Float32Array; m: number[]; c: number[] }[] = [];
  g.draw((x, y) => [x * 0.03 + 0.7, y * 0.024 + 0.9], 2, 32, (v, m, c) => calls.push({ v, m: [...m], c: [...c] }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].m, [1, 0, 0, 1, 30, 48]);
  assert.deepEqual(calls[0].c, [...AREA_RING_RGB, 1, 0, 0, 0]);
  assert.deepEqual(calls[1].c, [...PUSH_RING_RGB, 1, 0, 0, 0]);
  close(AREA_RING_RGB[1], 127 / 255);
  close(calls[0].v[0], 150, 1e-3); // 2500 * 0.03 * 2
  close(calls[1].v[0], 60, 1e-3); // 1000 * 0.03 * 2
  g.visible = false;
  calls.length = 0;
  g.draw(() => [0, 0], 1, 32, (v, m, c) => calls.push({ v, m: [...m], c: [...c] }));
  assert.equal(calls.length, 0);
});

test('footsteps: a labelled frame plays MoveEffect on the update that leaves it, once per pass', () => {
  // Knight run1: 26 frames, action_frame1 at 0, action_frame2 at 13
  assert.equal(stepCrossed(0, 1, 26, 0, 13), true);
  assert.equal(stepCrossed(0, 0, 26, 0, 13), false, 'same frame');
  assert.equal(stepCrossed(12, 13, 26, 0, 13), false, 'reaching the label does not fire yet');
  assert.equal(stepCrossed(13, 14, 26, 0, 13), true);
  assert.equal(stepCrossed(11, 15, 26, 0, 13), true, 'skipped over in one update');
  assert.equal(stepCrossed(25, 0, 26, 0, 13), false, 'wraps to the label');
  assert.equal(stepCrossed(24, 2, 26, 0, 13), true, 'wraps past the label');
  assert.equal(stepCrossed(3, 9, 26, -1, -1), false, 'no labels');
  assert.equal(stepCrossed(28, 30, 35, 29, -1), true, 'one label (Royal Hog)');
});

test('footsteps: UnitFx plays the character MoveEffect at the actor, only while walking or charging', () => {
  const played: { name: string; x: number; y: number; o: PlayOptions | undefined }[] = [];
  const fx: StepFxPlayer = {
    art: { manifest: { effects: { knight_steps: { components: [] } as never } } },
    has: (n) => n === 'knight_steps',
    play: (name, x, y, o) => { played.push({ name, x, y, o }); return played.length; },
    stop: () => {},
  };
  const art = {
    sc: 'x', blue: 'b', red: 'r', scale: 100, effects: { moveEffect: 'knight_steps' },
    actions: { run1: { export: 'KnightRun', dirs: 9, frames: 26, fps: 30, labels: { 0: 'action_frame1', 13: 'action_frame2' } },
      attack1: { export: 'KnightAttack', dirs: 9, frames: 35, fps: 30, labels: { 22: 'action_frame' } } },
  } as unknown as CharacterArt;
  const u = { id: 7, team: 0, x: 4000, y: 9000, z: 0, dirX: 0, dirY: 100, walker: true };
  const run = (frame: number, action = 0, key = 'run1'): AnimFrame => ({ export: 'KnightRun_1', frame, mirror: false, action, key });
  const ufx = new UnitFx();
  for (const f of [0, 1, 2, 12, 13, 14, 20, 25, 0, 1]) ufx.step(fx, art, u, run(f));
  assert.equal(played.length, 3); // leaving 0, leaving 13, leaving 0 again
  assert.deepEqual([played[0].name, played[0].x, played[0].y], ['knight_steps', 4000, 9000]);
  assert.equal(played[0].o?.angle, 90);
  assert.equal(played[0].o?.team, 0);
  // attacking: no steps; the run slot keeps its last frame for when walking resumes
  ufx.step(fx, art, u, run(5, 2, 'attack1'));
  ufx.step(fx, art, u, run(30, 2, 'attack1'));
  assert.equal(played.length, 3);
  ufx.step(fx, art, u, run(2)); // prev run frame 1 -> 2: no label in between
  assert.equal(played.length, 3);
  // a non-walker (no movement component) never steps
  const tower = { ...u, id: 8, walker: false };
  for (const f of [0, 1, 13, 14]) ufx.step(fx, art, tower, run(f));
  assert.equal(played.length, 3);
  ufx.prune(fx, new Set([7]));
});
