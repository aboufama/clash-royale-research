// Character view details ported from libg 160402020 (2026-10-12 audit fixes): per-view clip instances
// (0x84a310 anim entries, 0x123f55c), the health bar's reference clip (0x836e58 @0x83834c / 0x838a34),
// TryToFinishAttackAnimation's time-scale gate (0x840d44), the buff time scale, the 0x12437b8 restart and
// the recorded hit / damage vectors of the engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScLibrary } from '../src/sc/library.ts';
import { ClipInstances, McNode } from '../src/sc/movieclip.ts';
import { animate, gallerySprite, newAnimState } from '../src/sc/anim.ts';
import { BattleArt } from '../src/sc/battle_art.ts';
import type { CharacterArt, Manifest } from '../src/sc/manifest.ts';
import { ScLibraryCache } from '../src/sc/library.ts';
import { newBattle } from '../../core/test/helpers.ts';

type ClipJson = { fps: number; n: number[]; e: number[]; c: number[]; k: number; nm?: string[] };

/** A clip of `frames` frames showing every child in every frame (matrix index per child, -1 = identity). */
function clip(frames: number, kids: number[], names: string[] = [], mats: number[] = []): ClipJson {
  const n: number[] = [], e: number[] = [];
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < kids.length; i++) e.push(i, mats[i] ?? -1, -1);
    n.push(kids.length);
  }
  return { fps: 30, n, e, c: kids, k: 0, nm: names };
}

/** A square shape of half-size h centred at (0, -h) (top at -2h). */
function square(h: number): unknown {
  return [[0, [-h, -2 * h, 0, 0, h, -2 * h, 0, 0, -h, 0, 0, 0, h, 0, 0, 0]]];
}

/**
 * A unit library: Knight-like idle direction clips _1.._3 (18 frames) holding a 70-frame inner clip; the
 * red export's _1 is taller than its _3 (as the audit measured for the enemy Knight).
 */
function unitLib(): ScLibrary {
  const clips: Record<string, ClipJson> = {
    10: clip(70, [1]), // inner animated clip (body), its shape on every frame
    20: clip(18, [10]), 21: clip(18, [10]), 22: clip(18, [10]), // blue idle _1 .. _3
    30: clip(18, [2]), 31: clip(18, [3]), 32: clip(18, [4]), // red idle _1 (top -88), _2, _3 (top -48)
  };
  return new ScLibrary({
    v: 1, name: 'chr_test', tex: [{ w: 1, h: 1 }], banks: [{ m: [], c: [] }], clips,
    shapes: { 1: square(40), 2: square(44), 3: square(30), 4: square(24) },
    exports: { t_idle1_1: 20, t_idle1_2: 21, t_idle1_3: 22, t_red_idle1_1: 30, t_red_idle1_2: 31, t_red_idle1_3: 32 },
  } as never, []);
}

const ACT = (exp: string) => ({ idle1: { export: exp, dirs: 3, frames: 18, fps: 30 } });
const CHAR = { sc: 'chr_test', scale: 100, actions: ACT('t_idle1'), actionsRed: ACT('t_red_idle1'),
  healthBarOffsetY: -5, healthBarOffsetYBlue: 2, healthBarOffsetYRed: -3 } as unknown as CharacterArt;

test('per-view clip instances: the inner clip keeps its own playhead under a stopped root (0x84a310, 0x123f55c)', () => {
  const lib = unitLib();
  const ci = new ClipInstances();
  const dt = 1 / 30 + 1e-6;
  let n = ci.show(lib, 't_idle1_1', 0, dt)!;
  assert.equal(n.frame, 0);
  assert.equal(n.kids[0]!.frame, 0); // the first step only accumulates time
  for (let i = 0; i < 20; i++) n = ci.show(lib, 't_idle1_1', 0, dt)!;
  // root held on 0 by the view, the 70-frame inner clip moved one frame per step
  assert.equal(n.frame, 0);
  assert.equal(n.kids[0]!.frame, 20);
  // another direction clip is its own instance from frame 0; the first keeps its playhead while not shown
  const m = ci.show(lib, 't_idle1_2', 5, dt)!;
  assert.notEqual(m, n);
  assert.equal(m.frame, 5);
  assert.equal(m.kids[0]!.frame, 0);
  for (let i = 0; i < 3; i++) ci.show(lib, 't_idle1_2', 5, dt);
  assert.equal(n.kids[0]!.frame, 20);
  assert.equal(ci.show(lib, 't_idle1_1', 3, dt)!.kids[0]!.frame, 21);
  // no time, no step
  assert.equal(ci.show(lib, 't_idle1_1', 3, 0)!.kids[0]!.frame, 21);
});

test('0x12437b8 playAll: the root and its children play from frame 0 once; a one-frame clip stops', () => {
  const lib = unitLib();
  const n = McNode.of(lib, 't_idle1_1')!;
  n.gotoAndStop(7);
  n.kids[0]!.gotoAndStop(40);
  n.playAll();
  assert.equal(n.frame, 0);
  assert.equal(n.kids[0]!.frame, 0);
  assert.equal(n.state, 0);
  assert.equal(n.end, 17);
  const dt = 1 / 30 + 1e-6;
  for (let i = 0; i < 40; i++) n.advance(dt);
  assert.equal(n.frame, 17); // held on the last frame
  assert.equal(n.state, 2);
  const one = new McNode(lib, lib.clips.get(10)!);
  one.playAll();
  assert.equal(one.state, 0);
  const single = new ScLibrary({ v: 1, name: 's', tex: [], banks: [{ m: [], c: [] }], shapes: {}, clips: { 5: clip(1, []) }, exports: { s: 5 } } as never, []);
  const s = McNode.of(single, 's')!;
  s.playAll();
  assert.equal(s.state, 2);
});

function artWith(lib: ScLibrary, characters: Record<string, CharacterArt>): BattleArt {
  const libs = new ScLibraryCache('');
  (libs as unknown as { ready: Map<string, ScLibrary> }).ready.set(lib.name, lib);
  const manifest = { characters, towers: { king: {}, princess: {} } } as unknown as Manifest;
  return new BattleArt(manifest, libs, '');
}

test('health bar reference clip: direction _1 of the team\'s idle export, top rounded up (0x836e58 @0x83834c, @0x838a34)', () => {
  const lib = unitLib();
  const art = artWith(lib, { T: CHAR });
  assert.equal(art.barRefClip(CHAR, 0), 't_idle1_1');
  assert.equal(art.barRefClip(CHAR, 1), 't_red_idle1_1');
  // blue: top -80 -5 +2; red: its own _1 (-88), not the last direction (-48): -88 -5 -3
  const [, by] = art.unitBarPx('T', 0, 9000, 16000);
  const [, ry] = art.unitBarPx('T', 1, 9000, 16000);
  const gy = art.gameToPx(9000, 16000)[1];
  assert.equal(by - gy, -80 - 5 + 2);
  assert.equal(ry - gy, -88 - 5 - 3);
  // frintp: a fractional top rounds toward +inf
  assert.equal(art.barOffsetY('chr_test', 't_idle1_1', 0.99, 0, 0, 0, true), Math.ceil(-80 * 0.99));
  // no idle entry: the bounds are 0, only the offsets remain
  const noIdle = { ...CHAR, actions: { run1: { export: 't_idle1', dirs: 3, frames: 18, fps: 30 } }, actionsRed: undefined } as unknown as CharacterArt;
  assert.equal(art.barRefClip(noIdle, 0), null);
});

test('TryToFinishAttackAnimation stops while frozen and runs at the last attack step (0x840d44 @0x840e24 / @0x8418fc)', () => {
  const art = {
    actions: { attack1: { export: 'v_attack1', dirs: 9, frames: 30, fps: 30, actionFrame: 15 }, idle1: { export: 'v_idle1', dirs: 9, frames: 10, fps: 30 } },
    tryToFinishAttackAnimation: true, hitSpeed: 1500,
  } as unknown as CharacterArt;
  const base = { dirX: 0, dirY: 256, id: 1, walker: true, charge: 0, walk: 0, walkPrev: 0, finish: 0, alpha: 0, flip: true };
  const run = (scale: number, atkScale: number) => {
    const s = newAnimState();
    // swinging (state 2) at the attack step atkScale, then the attack state ends
    animate(art, 0, s, { ...base, state: 2, atk: 1400, atkPrev: 1400, dt: 0.05, clock: 0, scale: atkScale });
    const a = animate(art, 0, s, { ...base, state: 0, atk: 0, atkPrev: 0, dt: 0.05, clock: 0.05, scale });
    return { a, s };
  };
  const live = run(50, 50);
  assert.equal(live.a!.action, 2); // still finishing the swing
  assert.equal(live.s.finishClock, Math.fround(1400 + Math.fround(0.05 * 1000)));
  const frozen = run(0, 50);
  assert.equal(frozen.a!.action, 1); // idle: no finishing while the time scale is 0
  const raged = run(50, 67); // the clock runs at the last attacking frame's step (67 ms per tick)
  assert.equal(raged.s.finishClock, Math.fround(1400 + Math.fround(0.05 * Math.fround(67 * 20))));
});

test('gallery sprite uses the client direction pick', () => {
  const g = gallerySprite(CHAR, 1, 'idle1', 0, -256, true, 100)!;
  assert.equal(g.export, 't_red_idle1_3'); // facing the camera in the blue view: the last direction
  assert.equal(g.frame, 3);
  assert.equal(gallerySprite(CHAR, 0, 'idle1', 0, 256, true, 0)!.export, 't_idle1_1');
});

test('engine: damage events carry the entry vector, view hits record vt+0xe8 calls (no simulation change)', () => {
  const run = (record: boolean) => {
    const b = newBattle({ seed: 3, recordEvents: record });
    b.spawn(0, 'Knight', 9000, 14000);
    b.spawn(1, 'Knight', 9000, 18500);
    b.spawn(0, 'Musketeer', 6000, 12000);
    const ev: { type: string; vx?: number; vy?: number; fx?: number }[] = [];
    for (let i = 0; i < 400; i++) { b.step(); if (record) ev.push(...b.events); }
    return { hash: b.hash(), ev };
  };
  const on = run(true), off = run(false);
  assert.equal(on.hash, off.hash);
  const melee = on.ev.filter((e) => e.type === 'damage' && e.fx === 2);
  assert.ok(melee.length > 0);
  for (const e of melee) assert.ok(e.vx !== 0 || e.vy !== 0, 'single melee hits carry (target snapshot − attacker)');
  const proj = on.ev.filter((e) => e.type === 'damage' && e.fx === 4);
  assert.ok(proj.length > 0);
  for (const e of proj) assert.ok(e.vx !== 0 || e.vy !== 0, 'single projectile hits carry (aim − start)');
  const wob = on.ev.filter((e) => e.type === 'wobble');
  assert.ok(wob.length >= melee.length);
});
