// The client's character-view helpers ported in viewer/src/sc/anim.ts (libg 160402020).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attackFrame, nativeAngle, pickDirectionNative, viewAngle } from '../src/sc/anim.ts';

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
