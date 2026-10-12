// Character view items of the 2026-10-12 view5 pass, ported from libg 160402020: the attack frame's
// VisualHitSpeed branch (0x845244), TryToFinishAttackAnimationBeforeNextAttack (0x840d44 @0x8427a8),
// AttackShakeTime (@0x842c44), the AttackDashTime lunge (0x845ce8, 0x846f98), the view jolt of vt+0xf0 /
// vt+0xf8 (0x83e488 / 0x83e4d8 → 0x839b08) and the recorded engine events behind them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animate, attackFrame, attackFrame845244, newAnimState } from '../src/sc/anim.ts';
import type { CharacterArt } from '../src/sc/manifest.ts';
import { dashPull, joltStep, jumpMoveSpeed } from '../src/sc/unit_view.ts';
import type { Jolt } from '../src/sc/unit_view.ts';
import { childCenter } from '../src/sc/char_effects.ts';
import { ScLibrary } from '../src/sc/library.ts';
import { newBattle } from '../../core/test/helpers.ts';

const base = { dirX: 0, dirY: 256, id: 1, walker: true, charge: 0, walk: 0, walkPrev: 0, finish: 0, alpha: 0, flip: true, clock: 0 };

test('0x845244 VisualHitSpeed branch: in sequence mode the attack clip loops every V ms, no swing flag', () => {
  // Inferno Dragon: 36-frame attack clip, HitSpeed 400, VisualHitSpeed 1200 for every entry (0xdde618 copies it)
  assert.deepEqual(attackFrame845244(false, true, 1200, 1200, 400, 600, 36, 1200, 18, 0), { frame: 18, done: false });
  assert.deepEqual(attackFrame845244(false, true, 1200, 1200, 400, 1300, 36, 1200, 18, 0), { frame: 3, done: false });
  // no VisualHitSpeed: 0x84a9cc
  assert.deepEqual(attackFrame845244(false, false, 0, 0, 1200, 900, 35, 1166, 22, 0), attackFrame(false, false, 1200, 900, 35, 1166, 22, 0));
  // no action_frame label: frame 0
  assert.deepEqual(attackFrame845244(false, true, 1200, 1200, 400, 600, 36, 1200, -1, 0), { frame: 0, done: false });
  // VisualHitSpeed without sequence mode: 0x84a9cc's formula with hit speed V
  assert.deepEqual(attackFrame845244(false, false, 900, 900, 400, 850, 30, 1000, 15, 0), attackFrame(false, false, 900, 850, 30, 1000, 15, 0));
});

test('animate: an Inferno Dragon swing shows the looping clip and never raises the AttackStartEffect', () => {
  const art = { actions: { attack1: { export: 'i_attack1', dirs: 9, frames: 36, fps: 30, actionFrame: 18 } }, hitSpeed: 400 } as unknown as CharacterArt;
  const s = newAnimState();
  let starts = 0;
  for (let t = 50; t <= 2400; t += 50) {
    const a = animate(art, 0, s, { ...base, state: 2, atk: t, atkPrev: t, dt: 0.05, visualHitSpeed: 1200, visualHitSpeedCur: 1200, seqMode: true })!;
    assert.equal(a.frame, Math.trunc(((t % 1200) * 36) / 1200));
    if (a.attackStart) starts++;
  }
  assert.equal(starts, 0);
});

test('TryToFinishAttackAnimationBeforeNextAttack: a swing cut by a timer restart goes on, on the view clock (0x8427a8)', () => {
  const mk = (flag: boolean) => ({
    actions: { attack1: { export: 'v_attack1', dirs: 9, frames: 30, fps: 30, actionFrame: 15 } },
    hitSpeed: 1500, tryToFinishAttackAnimationBeforeNextAttack: flag,
  }) as unknown as CharacterArt;
  const run = (flag: boolean) => {
    const s = newAnimState();
    const out: number[] = [];
    // the hit at 1500, the follow-through at 1550, then the timer restarts at 0 (target died, new target)
    for (const atk of [1450, 1500, 1550, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) {
      out.push(animate(mk(flag), 0, s, { ...base, state: 2, atk, atkPrev: atk, dt: 0.05 })!.frame);
    }
    return { out, s };
  };
  const off = run(false), on = run(true);
  assert.equal(off.out[3], 0); // snaps back to frame 0
  assert.ok(on.out[3] > on.out[2], 'the swing continues past the restart');
  // finish clock: from the last shown attack time, + dt·(step·20) per frame
  assert.equal(on.s.midSwing, false);
  assert.ok(on.out.slice(3).some((f) => f === 0), 'and ends on frame 0');
  const firstZero = on.out.indexOf(0, 3);
  for (let i = 3; i < firstZero; i++) assert.ok(on.out[i] > 0);
});

test('AttackShakeTime: the clip jitters within ±1.2 px in the last AttackShakeTime ms of the swing, never once the battle is over', () => {
  const art = { actions: { attack1: { export: 'r_attack1', dirs: 9, frames: 20, fps: 30, actionFrame: 10 } }, hitSpeed: 400 } as unknown as CharacterArt;
  let n = 0;
  const rand = () => (n += 37);
  const s = newAnimState();
  const frames = [250, 300, 350].map((atk) => animate(art, 0, s, { ...base, state: 2, atk, atkPrev: atk, dt: 0.05, attackShakeTime: 500, rand })!);
  // first swing frame: AttackStartEffect, no shake yet (+0xa15 clear); then the jitter
  assert.ok(frames.some((f) => f.attackStart));
  const shaken = frames.filter((f) => f.shake);
  assert.ok(shaken.length >= 1);
  for (const f of shaken) for (const v of f.shake!) assert.ok(v >= -1.2001 && v <= 1.18);
  const over = newAnimState();
  const o = [250, 300, 350].map((atk) => animate(art, 0, over, { ...base, state: 2, atk, atkPrev: atk, dt: 0.05, attackShakeTime: 500, rand, battleOver: true })!);
  assert.ok(o.every((f) => !f.shake));
});

test('AttackDashTime lunge: half way to the point at the hit, out and back over 2·AttackDashTime (0x846f98)', () => {
  const D = 150;
  assert.equal(dashPull(1000, 2000, 300, D), 1000); // just started: u = 0
  assert.equal(dashPull(1000, 2000, 150, D), 1500); // at the hit: u = 100 → 50 %
  assert.equal(dashPull(1000, 2000, 225, D), 1250); // p = 50 → u = 50 → 25 %
  assert.equal(dashPull(1000, 2000, 1, D), 1000); // p = 99, u = 1: no pull
  assert.equal(dashPull(1000, 2000, 2, D), 1010); // u = 2: 1 %
  assert.equal(dashPull(2000, 1000, 150, D), 1500);
  assert.equal(dashPull(1000, 1003, 150, D), 1001); // C division truncates
  assert.equal(dashPull(1000, 2000, 0, D), 1000);
});

test('view jolt (0x839b08): shake ±0.00125·v over 0.1 s, recoil ±0.003125·v over 0.25 s, −0.00125·v at rest', () => {
  const j: Jolt = { t0: Math.fround(0.1), t1: 0, vx: 800, vy: -400, ox: 0, oy: 0 };
  joltStep(j, Math.fround(0.05), false);
  assert.ok(Math.abs(j.ox - 1) < 1e-6 && Math.abs(j.oy + 0.5) < 1e-6); // t0 = 0.05: k = +0.00125
  joltStep(j, Math.fround(0.05), false);
  assert.ok(Math.abs(j.ox + 1) < 1e-6); // timers out: k = −0.00125 for good
  joltStep(j, Math.fround(1), true);
  assert.ok(Math.abs(j.ox - 1) < 1e-6 && Math.abs(j.oy - -0.5) < 1e-6); // the turned view negates
  const r: Jolt = { t0: 0, t1: 0.25, vx: 1000, vy: 0, ox: 0, oy: 0 };
  joltStep(r, Math.fround(0.125), false);
  assert.ok(Math.abs(r.ox - 3.125) < 1e-4); // t1 = 0.125: k = +0.003125
});

test('river jump view speed vtb8: JumpSpeed unscaled (frozen jumpers keep it), 0 with an axe in flight', () => {
  const u = { axeWait: 0, def: { jumpSpeed: 160 } } as never;
  assert.equal(jumpMoveSpeed(u), 160);
  assert.equal(jumpMoveSpeed({ axeWait: 3, def: { jumpSpeed: 160 } } as never), 0);
});

test('attack pivots are text fields: tx/ty plus the rect centre (0x84eb7c → 0x126f52c)', () => {
  const lib = new ScLibrary({
    v: 1, name: 'chr_p', tex: [{ w: 1, h: 1 }], banks: [{ m: [1, 0, 0, 1, 10, -40], c: [] }],
    clips: { 20: { fps: 30, n: [1], e: [0, 0, -1], c: [5], k: 0, nm: ['attack_pivot_1'] } },
    shapes: {}, exports: { p_attack1_1: 20 }, tf: { 5: { font: 'x', text: '', rect: [-6, -2, 7, 15], color: 0, outline: 0 } },
  } as never, []);
  assert.deepEqual(childCenter(lib, 'p_attack1_1', 0, 'attack_pivot_1'), [10 + 0.5, -40 + 6.5]);
});

test('engine: dash events for AttackDashTime units and shake events for ShakesTargets hits, recorded only', () => {
  const run = (record: boolean) => {
    const b = newBattle({ seed: 5, recordEvents: record });
    b.spawn(0, 'Bats', 9000, 14500);
    b.spawn(1, 'Golem', 9000, 17500);
    b.spawn(0, 'AxeMan', 4000, 13000);
    b.spawn(1, 'Knight', 4000, 17000);
    b.spawn(1, 'Knight', 4600, 17600);
    const ev: { type: string; id: number; src?: number; vx?: number; vy?: number; r?: number; tick: number }[] = [];
    for (let i = 0; i < 300; i++) { b.step(); if (record) ev.push(...b.events.map((e) => ({ ...e }))); }
    return { hash: b.hash(), ev };
  };
  const on = run(true), off = run(false);
  assert.equal(on.hash, off.hash);
  const dash = on.ev.filter((e) => e.type === 'dash');
  assert.ok(dash.length > 0);
  // each dash comes AttackDashTime (150 ms = 3 ticks) before the attacker's hit
  const hits = on.ev.filter((e) => e.type === 'hit');
  for (const d of dash.slice(0, 5)) assert.ok(hits.some((h) => h.id === d.id && h.tick === d.tick + 3), `hit 3 ticks after the dash at ${d.tick}`);
  for (const d of dash) assert.ok(d.r! > 0);
  const shake = on.ev.filter((e) => e.type === 'shake');
  assert.ok(shake.length > 0);
  for (const s of shake) assert.ok(s.vx !== undefined && s.vy !== undefined);
});
