// Floater texts of the popup manager (viewer/src/sc/floater.ts): the not-enough-mana failure gate of
// 0xbe7184, the slot choice and cap of 0x88cb54 / 0x88ce50, the setup 0x88cc2c (shadow scale, horizontal
// clamp) and the per-frame pass 0x88c7fc, on a stand-in library shaped like sc/ui.sc's floater_text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Floaters, floaterParts, MAX_FLOATERS, NOT_ENOUGH_MANA_COLOR, NotEnoughManaGate,
  SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES } from '../src/sc/floater.ts';
import { ScLibrary } from '../src/sc/library.ts';

/**
 * floater_text as in sc/ui.sc: 161 frames at 60 fps holding FloaterContent (frame 80 at (0, -18.5)), whose
 * frame 0 holds `shadow` at (-0.75, -0.15) (a 29 x 29 shape scaled 20.607 x 2.134: 597.6 x 61.9) and the
 * `Text` field (rect -2, -2, 551, 30, centred, 26 px) at (-274.5, -13).
 */
function lib(): ScLibrary {
  const m: number[] = [];
  for (let f = 0; f < 161; f++) m.push(1, 0, 0, 1, 0, f === 80 ? -18.5 : 0);
  m.push(1, 0, 0, 1, -0.75, -0.15); // 161 shadow
  m.push(1, 0, 0, 1, -274.5, -13); // 162 Text
  m.push(20.607, 0, 0, 2.134, 0, -0.05); // 163 shadow's shape
  const e: number[] = [];
  for (let f = 0; f < 161; f++) e.push(0, f, -1);
  return new ScLibrary({
    v: 1, name: 'ui', tex: [{ f: 'none', w: 1, h: 1 }],
    shapes: { 100: [[0, [-14, -14, 0, 0, 15, -14, 0, 0, -14, 15, 0, 0, 15, 15, 0, 0]]] },
    banks: [{ m, c: [] }],
    clips: {
      107: { fps: 60, n: new Array(161).fill(1), e, c: [106], k: 0, nm: ['FloaterContent'] },
      106: { fps: 60, n: [2], e: [0, 161, -1, 1, 162, -1], c: [105, 102], k: 0, nm: ['shadow', 'Text'] },
      105: { fps: 60, n: [1], e: [0, 163, -1], c: [100], k: 0, nm: [''] },
    },
    tf: { 102: { font: 'Supercell-Magic', text: '', rect: [-2, -2, 551, 30], color: 0xffffffff, outline: 0xff000000, bytes: [2, 2, 26, 0] } },
    exports: { floater_text: 107 },
  } as never, []);
}

const STAGE_W = 578.5;
const SIZE = { w: 300, h: 30 };

function floaters(): Floaters {
  const p = floaterParts(lib());
  assert.ok(p);
  return new Floaters(p);
}

test('floaterParts reads the clip, the Text field and the shadow size', () => {
  const p = floaterParts(lib())!;
  assert.equal(p.frames, 161);
  assert.equal(p.fps, 60);
  assert.deepEqual(p.text.rect, [-2, -2, 551, 30]);
  assert.deepEqual(p.textM, [1, 0, 0, 1, -274.5, -13]);
  assert.ok(Math.abs(p.shadowW - 29 * 20.607) < 1e-6);
  assert.ok(Math.abs(p.shadowH - 29 * 2.134) < 1e-6);
  assert.deepEqual(p.contentAt(80), [1, 0, 0, 1, 0, -18.5]);
});

test('not-enough-mana gate: SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES = 1 shows every failure; more counts up and resets', () => {
  assert.equal(SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES, 1);
  const g = new NotEnoughManaGate();
  for (let i = 0; i < 4; i++) assert.equal(g.fail(), true);
  const g3 = new NotEnoughManaGate(3);
  assert.deepEqual([g3.fail(), g3.fail(), g3.fail(), g3.fail(), g3.fail(), g3.fail()], [false, false, true, false, false, true]);
  // a running old-tutorial step (or the _DAT_01a4e3d0 flag) shows it before the count
  const gt = new NotEnoughManaGate(3);
  assert.equal(gt.fail(true), true);
  assert.equal(gt.count, 0);
});

test('slot choice: the same text reuses its slot (restarted, moved); six live floaters refuse any more', () => {
  const fl = floaters();
  const a = fl.show(0, [200, 300], 'Not enough Elixir!', NOT_ENOUGH_MANA_COLOR, SIZE, STAGE_W)!;
  assert.equal(fl.count, 1);
  for (let i = 0; i < 30; i++) fl.update(1 / 60);
  assert.ok(a.clip.frame > 0);
  const b = fl.show(0, [250, 400], 'Not enough Elixir!', NOT_ENOUGH_MANA_COLOR, SIZE, STAGE_W)!;
  assert.equal(b, a);
  assert.equal(fl.count, 1);
  assert.equal(a.clip.frame, 0);
  assert.ok(a.clip.playing);
  assert.deepEqual([a.x, a.y], [250, 400]);
  // other texts take the next empty slots
  for (let i = 1; i < MAX_FLOATERS; i++) assert.ok(fl.show(0, [289, 100], `t${i}`, 0xffffffff, SIZE, STAGE_W));
  assert.equal(fl.count, MAX_FLOATERS);
  assert.equal(fl.show(0, [289, 100], 'other', 0xffffffff, SIZE, STAGE_W), null);
  // 0x88cb54 checks the count before the slot choice: even the same text is refused now
  assert.equal(fl.show(0, [289, 100], 'Not enough Elixir!', NOT_ENOUGH_MANA_COLOR, SIZE, STAGE_W), null);
  assert.deepEqual(fl.shown().map((s) => s.text), ['Not enough Elixir!', 't1', 't2', 't3', 't4', 't5']);
});

test('the slot lookup returns the first slot that is empty or has the same text', () => {
  const fl = floaters();
  fl.show(0, [289, 100], 'a', 0, SIZE, STAGE_W);
  fl.show(0, [289, 100], 'b', 0, SIZE, STAGE_W);
  fl.show(0, [289, 100], 'c', 0, SIZE, STAGE_W);
  assert.equal(fl.pick('b'), 1);
  assert.equal(fl.pick('d'), 3);
  // a reused slot moves to the top of the container
  fl.show(0, [289, 100], 'a', 0, SIZE, STAGE_W);
  assert.deepEqual(fl.shown().map((s) => s.text), ['b', 'c', 'a']);
});

test('timing: frames 0..160 at one per 60 Hz frame, removed on the frame after it stops', () => {
  const fl = floaters();
  const s = fl.show(0, [289, 300], 'x', 0, SIZE, STAGE_W)!;
  const frames: number[] = [];
  let removedAt = -1;
  for (let k = 1; k <= 200; k++) {
    fl.update(1 / 60);
    if (!fl.slots[0]) { removedAt = k; break; }
    frames.push(s.clip.frame);
  }
  assert.deepEqual(frames.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(frames.length, 161);
  assert.equal(frames[160], 160);
  assert.equal(removedAt, 162);
  assert.equal(fl.count, 0);
  assert.equal(fl.shown().length, 0);
});

test('a delayed floater waits stopped and hidden, then plays from frame 0', () => {
  const fl = floaters();
  const s = fl.show(0.125, [289, 300], 'x', 0, SIZE, STAGE_W)!;
  assert.equal(s.visible, false);
  assert.equal(s.clip.playing, false);
  for (let k = 0; k < 7; k++) fl.update(1 / 64);
  assert.equal(s.visible, false);
  fl.update(1 / 64); // 8 frames: 0.125 - 8/64 = 0
  assert.equal(s.visible, true);
  assert.equal(s.clip.playing, true);
  assert.equal(s.clip.frame, 0);
});

test('setup: shadow scale from the text size, horizontal clamp of the text to the stage', () => {
  const fl = floaters();
  const s = fl.show(0, [289, 300], 'x', 0, SIZE, STAGE_W)!;
  assert.ok(Math.abs(s.sx - (300 * 1.25) / (29 * 20.607)) < 1e-9);
  assert.equal(s.sy, 1); // 30 * 1.75 / 61.9 < 1
  assert.equal(s.x, 289);
  const tall = fl.show(0, [289, 300], 'y', 0, { w: 300, h: 50 }, STAGE_W)!;
  assert.ok(Math.abs(tall.sy - (50 * 1.75) / (29 * 2.134)) < 1e-9);
  // centred text 300 wide: x0 = x - 150 must be >= 1, x1 = x + 150 <= trunc(578.5) - 1
  const left = fl.show(0, [50, 300], 'l', 0, SIZE, STAGE_W)!;
  assert.equal(left.x, 151);
  const right = fl.show(0, [550, 300], 'r', 0, SIZE, STAGE_W)!;
  assert.equal(right.x, 577 - 150);
  assert.equal(right.y, 300);
});
