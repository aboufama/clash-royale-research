// TryToFinishAttackAnimation in the character view update 0x840d44 (libg 160402020): the finish is armed by
// the state the view returned last frame (+0xa84, stored by 0x839b08 from vt+0x2a8 = 0x840d44; @0x840de0)
// and ends on frame 0, a frame before the action frame or past the clip (@0x8436d8). The old port armed it
// from the shown action, which stays the attack on the frame a finish ends, so the Valkyrie swung on forever
// while walking (owner report 2026-10-12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animate, newAnimState } from '../src/sc/anim.ts';
import type { AnimFrame, AnimState } from '../src/sc/anim.ts';
import type { CharacterArt } from '../src/sc/manifest.ts';
import { newBattle, addActive } from '../../core/test/helpers.ts';
import { ST_DEAD } from '../../core/src/index.ts';

// the Valkyrie's clips in this build (chr_valkyrie: attack1 27 frames at 24 fps, action_frame 9; run1 16 frames
// with action_frame1 / 2 at 0 / 8) and her data (HitSpeed 1500, both finish flags)
const VALK = {
  actions: {
    attack1: { export: 'valkyrie1_attack1', dirs: 9, frames: 27, fps: 24, labels: { 9: 'action_frame' }, actionFrame: 9 },
    idle1: { export: 'valkyrie1_idle1', dirs: 9, frames: 1, fps: 24 },
    run1: { export: 'valkyrie1_run1', dirs: 9, frames: 16, fps: 24, labels: { 0: 'action_frame1', 8: 'action_frame2' } },
  },
  hitSpeed: 1500, tryToFinishAttackAnimation: true, tryToFinishAttackAnimationBeforeNextAttack: true,
} as unknown as CharacterArt;

const DT = 1 / 60;
const base = { dirX: 0, dirY: 256, id: 1, walker: true, charge: 0, walk: 0, walkPrev: 0, finish: 0, flip: true };

/** Three 60 fps view frames per 50 ms tick, the attack timer lerped from its tick-start value like art.ts. */
function tick(s: AnimState, clock: { t: number }, state: number, atkPrev: number, atk: number): AnimFrame[] {
  const out: AnimFrame[] = [];
  for (let k = 0; k < 3; k++) {
    clock.t += DT;
    out.push(animate(VALK, 0, s, { ...base, state, atk, atkPrev, alpha: k / 3, dt: DT, clock: clock.t })!);
  }
  return out;
}

test('a Valkyrie that kills on the hit and walks on shows her run clip, not an endless swing (0x840d44 @0x840de0 / @0x8436d8)', () => {
  const s = newAnimState();
  const clock = { t: 0 };
  tick(s, clock, 2, 1400, 1450);
  const hit = tick(s, clock, 2, 1450, 1500); // the hit tick: the wind-up shown up to frame 8
  assert.ok(hit.every((f) => f.key === 'attack1'));
  // the next tick she walks (target dead, the next one out of range: engine state 1)
  const walk: AnimFrame[] = [];
  for (let i = 0; i < 80; i++) walk.push(...tick(s, clock, 1, 0, 0));
  // the first walking frame is the finish: the view clock (1483 + 16) gives frame 8, before the action frame,
  // so the finish ends there; from the next frame on the run clip, for good
  assert.equal(walk[0].key, 'attack1');
  assert.equal(walk[0].frame, 8);
  assert.ok(walk.slice(1).every((f) => f.key === 'run1'), 'no attack clip while walking after the finish frame');
  assert.ok(!walk.some((f) => f.attackStart), 'no AttackStartEffect while walking');
  assert.equal(s.ret, 1);
});

test('a finish plays the follow-through on the view clock and ends where the frame drops below the action frame', () => {
  const s = newAnimState();
  const clock = { t: 0 };
  // a hit at 1500, the follow-through to 1700 (frame 13), then the attack state ends (the target died to
  // someone else)
  let prev = 1400;
  for (let atk = 1450; atk <= 1700; atk += 50) { tick(s, clock, 2, prev, atk); prev = atk; }
  assert.equal(s.finishClock, 1683); // the last shown attack time: 1650 + 2/3 · 50, truncated
  const walk: AnimFrame[] = [];
  for (let i = 0; i < 40; i++) walk.push(...tick(s, clock, 1, 0, 0));
  const fin = walk.filter((f) => f.key === 'attack1');
  // the follow-through goes on up to the clip's last frame, then the hold frame 0 ends the finish
  assert.ok(fin.slice(0, -1).every((f) => f.frame >= 9), 'only the follow-through, never a new wind-up');
  assert.equal(fin[fin.length - 1].frame, 0);
  assert.equal(Math.max(...fin.map((f) => f.frame)), 26);
  // the clock: fmadd((float)(50·20), dt, clock) each frame, stored back truncated (@0x841920, @0x842828), so
  // +16 per 60 fps frame: 1699, 1715, ... 2243 (35 follow-through frames, 2250 = 1500 + the 750 ms
  // follow-through), then 2259 shows the hold frame 0 and ends it (an untruncated clock would give 34 + 1)
  assert.equal(fin.length, 36);
  const firstRun = walk.findIndex((f) => f.key === 'run1');
  assert.equal(firstRun, fin.length);
  assert.ok(walk.slice(firstRun).every((f) => f.key === 'run1'));
  assert.equal(s.ret, 1);
});

test('walking clears +0xc68: the next attack does not resume the cut swing (@0x84295c)', () => {
  const s = newAnimState();
  const clock = { t: 0 };
  let prev = 1400;
  for (let atk = 1450; atk <= 1600; atk += 50) { tick(s, clock, 2, prev, atk); prev = atk; }
  assert.equal(s.midSwing, true);
  // stunned out of the attack (no finish while the time scale is 0), walking a while
  for (let k = 0; k < 3; k++) { clock.t += DT; animate(VALK, 0, s, { ...base, state: 1, atk: 0, atkPrev: 0, alpha: 0, dt: DT, clock: clock.t, scale: 0 }); }
  for (let i = 0; i < 10; i++) tick(s, clock, 1, 0, 0);
  assert.equal(s.midSwing, false);
  // a new attack from a fresh timer shows frame 0 until its wind-up
  const again = tick(s, clock, 2, 0, 50);
  assert.ok(again.every((f) => f.key === 'attack1' && f.frame === 0));
});

test('engine + view: Valkyrie fights shown frame by frame never keep the attack clip while she walks', () => {
  const b = newBattle({ seed: 7 });
  const v = addActive(b, 'Valkyrie', 0, 9000, 11000);
  addActive(b, 'Skeleton', 1, 9000, 12300);
  addActive(b, 'Skeleton', 1, 9000, 15500);
  addActive(b, 'Goblin', 1, 8000, 17500);
  const s = newAnimState();
  const clock = { t: 0 };
  let moving = 0, swingMoving = 0, run = 0, longest = 0, attacking = 0;
  for (let i = 0; i < 240; i++) {
    const atkPrev = v.atkTimer, px = v.x, py = v.y;
    b.step();
    if (v.state === ST_DEAD) break;
    const state = v.locked ? 2 : 1;
    for (const f of tick(s, clock, state, atkPrev, v.atkTimer)) {
      if (state === 2) attacking++;
      if (v.x !== px || v.y !== py) {
        moving++;
        if (f.key === 'attack1') { swingMoving++; run++; longest = Math.max(longest, run); } else run = 0;
      } else run = 0;
    }
  }
  assert.ok(attacking > 0 && moving > 300, `attacking ${attacking}, moving ${moving}`);
  // at most the one finish frame after each kill (three kills)
  assert.ok(longest <= 1, `longest attack-clip run while moving: ${longest} frames`);
  assert.ok(swingMoving <= 3, `attack-clip frames while moving: ${swingMoving}`);
});
