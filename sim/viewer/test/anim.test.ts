// The client's character-view helpers ported in viewer/src/sc/anim.ts (libg 160402020).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animate, animateBuilding, attackFrame, ClipPlayer, nativeAngle, newAnimState, newBuildingAnim, pickDirectionNative, viewAngle } from '../src/sc/anim.ts';
import type { CharacterArt } from '../src/sc/manifest.ts';

test('FUN_00f81d0c integer atan2: axes, diagonals, and within a degree of atan2', () => {
  assert.equal(nativeAngle(256, 0), 0);
  assert.equal(nativeAngle(0, 256), 90);
  assert.equal(nativeAngle(-256, 0), 180);
  assert.equal(nativeAngle(0, -256), 270);
  assert.equal(nativeAngle(181, 181), 45);
  assert.equal(nativeAngle(0, 0), 0);
  let s = 7;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) % 20001) - 10000;
  for (let i = 0; i < 5000; i++) {
    const x = r(), y = r();
    if (!x && !y) continue;
    const a = nativeAngle(x, y);
    assert.ok(a >= 0 && a < 360, `range ${a}`);
    const ref = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    const d = Math.abs(((a - ref + 540) % 360) - 180);
    assert.ok(d <= 1.01, `(${x},${y}) ${a} vs ${ref}`);
  }
});

test('FUN_00844f78 view angle: blue (flipped) view, 0 = screen up, clockwise', () => {
  assert.equal(viewAngle(0, 256, true), 0); // toward red = up
  assert.equal(viewAngle(-256, 0, true), 90); // logic -x = screen right in the flipped view
  assert.equal(viewAngle(0, -256, true), 180);
  assert.equal(viewAngle(0, 256, false), 180);
});

test('FUN_0084a7f8 direction sectors (N = 9: 18 sectors of 20 degrees)', () => {
  const d = (a: number, last = 1) => pickDirectionNative(a, 9, last);
  assert.deepEqual(d(0), { idx: 0, sign: 1 });
  assert.deepEqual(d(19), { idx: 0, sign: 1 });
  assert.deepEqual(d(345, -1), { idx: 0, sign: -1 }); // front/back keep the last mirror sign
  assert.deepEqual(d(20), { idx: 1, sign: 1 });
  assert.deepEqual(d(90), { idx: 4, sign: 1 });
  assert.deepEqual(d(159), { idx: 7, sign: 1 });
  assert.deepEqual(d(160), { idx: 8, sign: 1 });
  assert.deepEqual(d(199, -1), { idx: 8, sign: -1 });
  assert.deepEqual(d(200), { idx: 7, sign: -1 });
  assert.deepEqual(d(270), { idx: 4, sign: -1 });
  assert.deepEqual(pickDirectionNative(123, 1, -1), { idx: 0, sign: 1 });
});

test('FUN_0084a9cc attack frame: the action frame lands on the hit (Knight: 35 frames, hit at 22, HS 1200)', () => {
  const f = (time: number, extra = 0) => attackFrame(false, false, 1200, time, 35, 1166, 22, extra);
  // wind-up = 1166 * 22 / 35 = 732 ms, starting at 1200 - 732 = 468 into each cycle
  assert.deepEqual(f(0), { frame: 0, done: false });
  assert.deepEqual(f(467), { frame: 0, done: false });
  assert.deepEqual(f(468), { frame: 0, done: true });
  assert.deepEqual(f(1199), { frame: 21, done: true });
  assert.deepEqual(f(1200), { frame: 22, done: false }); // hit
  assert.deepEqual(f(1200 + 300), { frame: 22 + 9, done: false }); // follow-through
  assert.deepEqual(f(1200 + 440), { frame: 0, done: false }); // held between swings
  assert.deepEqual(f(2400 - 1), { frame: 21, done: true });
  assert.equal(f(1199, 10).done, false);
});

test('ClipPlayer steps like the client MovieClip (0x123f55c / 0x1241f50 / 0x1242234)', () => {
  const c = new ClipPlayer(10, 10);
  assert.equal(c.playing, true);
  // one frame per step once 1/fps has accumulated, wrapping over the whole clip
  for (let i = 0; i < 12; i++) c.advance(0.1);
  assert.equal(c.frame, 1);
  c.playRange(5, 7, false);
  assert.equal(c.frame, 5);
  for (let i = 0; i < 5; i++) c.advance(0.1);
  assert.equal(c.frame, 7);
  assert.equal(c.playing, false, 'an unlooped range stops on its end');
  c.gotoAndStop(3);
  c.advance(0.5);
  assert.equal(c.frame, 3);
});

test('building clip frames follow the client view (0x840d44 first branch)', () => {
  const tesla = { hidesWhenNotAttacking: true, hideTimeMs: 800, upTimeMs: 800 } as unknown as CharacterArt;
  const tl = { deploy: 0, idle: 1, appear_start: 2, appear_end: 21, hide_start: 22, hide_end: 38 };
  const base = { state: 0, deployLeft: 0, deployTime: 1000, manaT: 0, collected: false, dt: 1 / 60 };
  const frame = (hideT: number) => animateBuilding(tesla, 'Tesla', tl, newBuildingAnim(tesla, tl, 56, 24), { ...base, hideT });
  assert.deepEqual([0, 400, 800, 1200, 1599, -400].map(frame), [22, 30, 38, 11, 20, 30]);

  const tomb = {} as CharacterArt;
  const dl = { deploy_start: 0, deploy_end: 20 };
  const ts = newBuildingAnim(tomb, dl, 60, 30);
  assert.equal(animateBuilding(tomb, 'Tombstone', dl, ts, { ...base, hideT: 0, state: 4, deployLeft: 450 }), 11);
  assert.equal(animateBuilding(tomb, 'Tombstone', dl, ts, { ...base, hideT: 0 }), 11, 'holds after deploy (no idle labels)');

  const coll = { manaGenerateTimeMs: 15000 } as unknown as CharacterArt;
  const cl = { action_frame: 29 };
  const cs = newBuildingAnim(coll, cl, 35, 60);
  const step = (manaT: number, collected = false) => animateBuilding(coll, 'ElixirCollector', cl, cs, { ...base, hideT: 0, manaT, collected });
  assert.equal(step(7500), 14);
  assert.equal(step(0, true), 29, 'collection plays action_frame to the end (0x84692c)');
  let f = 29;
  for (let i = 0; i < 20; i++) f = step(50);
  assert.equal(f, 0, 'then back to the timer sync');
});

test('river jump clip timing (0x840d44 jump timer +0xa2c, cap at 0x84440c): half the clip, hold, land on the last frame', () => {
  // Hog Rider: no _jump1_, so the jump action plays its _run1_ (17 frames at 24 fps, 0x835fd0 slot 4)
  const run1 = { export: 'HogRider_run1', dirs: 9, frames: 17, fps: 24 };
  const hog = { jumpEnabled: 1, actions: { run1, idle1: { ...run1, frames: 1 } } } as unknown as CharacterArt;
  const s = newAnimState();
  const base = { dirX: 0, dirY: 1, id: 1, walker: true, charge: 0, walk: 0, walkPrev: 0, atk: 0, atkPrev: 0, finish: 0,
    alpha: 0, dt: 0.05, clock: 0, flip: false };
  const at = (left: number) => animate(hog, 0, s, { ...base, state: 5, jumpLeft: left })!;
  // 22 jump ticks of 50 ms: steps left 21 .. 0 (one view frame per tick here)
  const frames: number[] = [];
  for (let left = 21; left >= 0; left--) frames.push(at(left).frame);
  assert.equal(at(5).action, 4);
  // the timer gives f = (int)(t·24); the cap max((int)(17 − left·1.2), 8) holds it at frame 8 until
  // 7 steps are left, then the second half plays out and reaches frame 17 (≡ 0) at the landing
  assert.deepEqual(frames, [1, 2, 3, 4, 6, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 9, 11, 12, 13, 14, 15, 0]);
  // leaving state 5 resets the timer
  animate(hog, 0, s, { ...base, state: 1, walk: 100, walkPrev: 100 });
  assert.equal(s.jumpT, 0);
});
