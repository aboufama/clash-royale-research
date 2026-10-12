// The client's projectile view (0x8554b0), logic arc (0xf927ec) and effect/emitter code (0x82bf10,
// 0x8319e8, 0x831b90, 0x8311e8, 0x82fcc4, 0x8306a4) ported in viewer/src/sc/ (libg 160402020).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcHeight, isRolling, newProjectileViewState, projectileMatrix, projectileView } from '../src/sc/projectile_view.ts';
import { EffectPlayer } from '../src/sc/effects.ts';
import type { BattleArt } from '../src/sc/battle_art.ts';
import type { EmitterDef, Manifest, ProjectileArt } from '../src/sc/manifest.ts';

test('FUN_00f927ec arc: linear start->aim height plus (t - T)·t·⌊Gravity·-500/1000⌋', () => {
  // Fireball from the King tower: start z 4200 (3 x CollisionRadius 1400), 3000 units at Speed 600 -> T = 5
  const z = (y: number) => arcHeight(0, 0, 4200, 0, 3000, 0, 0, y, 600, 50);
  assert.equal(z(0), 4200);
  assert.equal(z(600), -840 + 4200 + (1 - 5) * 1 * -25); // 3460
  assert.equal(z(1200), -1680 + 4200 + (2 - 5) * 2 * -25); // 2670
  assert.equal(z(3000), 0);
  // integer ticks: 599 units is still t = 0
  assert.equal(z(599), 4200);
  // a homing arrow onto a flying target (aim z = its height), Gravity 60 -> -30 per tick^2
  assert.equal(arcHeight(0, 0, 450, 0, 6000, 1500, 0, 3000, 600, 60), 525 + 450 + (5 - 10) * 5 * -30);
  // Speed < 2 counts as 1; T >= 1
  assert.equal(arcHeight(0, 0, 100, 0, 0, 0, 0, 0, 0, 0), 100);
});

const arrow: ProjectileArt = { sc: 'effects', export: 'a', frames: 15, speed: 600, gravity: 60, homing: true };
const spear: ProjectileArt = { sc: 'effects', export: 's', frames: 33, speed: 500, gravity: 150, use360Frames: true, homing: true };

test('0x8554b0 pitch frames: n/2 + atan(dz)·n·0.3501401, clamped', () => {
  const v = (z: number, prevZ: number) => projectileView(arrow, 15, newProjectileViewState(),
    { x: 0, y: 0, tx: 0, ty: 1000, z, prevZ, alpha: 0, flip: false, own: true }).frame;
  assert.equal(v(0, 0), 7); // level
  assert.equal(v(500, 0), Math.trunc(7.5 + Math.atan(1) * 15 * 0.3501401)); // climbing 1 world unit per tick
  assert.equal(v(0, 500), Math.trunc(7.5 - Math.atan(1) * 15 * 0.3501401));
  assert.equal(v(100000, 0), 14);
  assert.equal(v(0, 100000), 0);
});

test('0x8554b0 use360Frames: angle + 90 (own) / + 270 (enemy), frame from the true pitch, mirrored for the enemy', () => {
  const own = projectileView(spear, 33, newProjectileViewState(), { x: 0, y: 0, tx: 1000, ty: 0, z: 0, prevZ: 0, alpha: 0, flip: false, own: true });
  assert.equal(own.rotation, 90);
  assert.equal(own.frame, Math.trunc(33 * 0.0027777778 * 270)); // level flight = frame 24
  const enemy = projectileView(spear, 33, newProjectileViewState(), { x: 0, y: 0, tx: 1000, ty: 0, z: 0, prevZ: 0, alpha: 0, flip: false, own: false });
  assert.equal(enemy.rotation, 270);
  assert.equal(enemy.frame, 32 - 24);
  // the blue (flipped) view turns the angle by 180 degrees
  const flipped = projectileView(spear, 33, newProjectileViewState(), { x: 0, y: 0, tx: 0, ty: 1000, z: 0, prevZ: 0, alpha: 0, flip: true, own: true });
  // 57.297466 is the client's (slightly off) degrees-per-radian constant
  assert.ok(Math.abs(flipped.rotation - (90 + 180 + 90)) < 0.01);
  // climbing at 45 degrees (dz = Speed·0.002 per tick)
  const up = projectileView(spear, 33, newProjectileViewState(), { x: 0, y: 0, tx: 1000, ty: 0, z: 500, prevZ: 0, alpha: 0, flip: false, own: true });
  assert.equal(up.frame, Math.trunc(33 * 0.0027777778 * (45 + 270)) % 33);
});

test('0x8554b0 angle in logic space, held while the target is reached; height-based scale', () => {
  const st = newProjectileViewState();
  assert.equal(st.angle, -1);
  const a = projectileView(arrow, 15, st, { x: 0, y: 0, tx: 1000, ty: 1000, z: 0, prevZ: 0, alpha: 0, flip: false, own: true });
  assert.ok(Math.abs(a.rotation - 45) < 0.01); // no 0.8 foreshortening
  const b = projectileView(arrow, 15, st, { x: 5, y: 5, tx: 5, ty: 5, z: 0, prevZ: 0, alpha: 0, flip: false, own: true });
  assert.ok(Math.abs(b.rotation - 45) < 0.01);
  // scale = Scale/100 · (1 + clamp(height·0.02, 0, 0.5)); height lerps prevZ -> z by alpha
  const c = projectileView(arrow, 15, st, { x: 0, y: 0, tx: 0, ty: 1, z: 2000, prevZ: 1000, alpha: 0.5, flip: false, own: true });
  assert.ok(Math.abs(c.height - 3) < 1e-9);
  assert.ok(Math.abs(c.scale - 1.06) < 1e-6);
  const d = projectileView({ ...arrow, scale: 200 }, 15, st, { x: 0, y: 0, tx: 0, ty: 1, z: 100000, prevZ: 100000, alpha: 0, flip: false, own: true });
  assert.ok(Math.abs(d.scale - 3) < 1e-6);
  // container scale times clip rotation
  const m = projectileMatrix(90, 2, 10, 20);
  assert.ok(Math.abs(m[0]) < 1e-6 && Math.abs(m[1] - 2) < 1e-6 && Math.abs(m[2] + 2) < 1e-6 && m[4] === 10 && m[5] === 20);
});

test('0xe5a908 rolling projectiles run their clip; shadows keep the angle unless ShadowDisableRotate', () => {
  const log: ProjectileArt = { sc: 'effects', export: 'l', frames: 408, speed: 200, projectileRadius: 1950, projectileRange: 10100 };
  assert.equal(isRolling(log), true);
  assert.equal(isRolling(arrow), false);
  assert.equal(projectileView(log, 408, newProjectileViewState(), { x: 0, y: 0, tx: 0, ty: 1000, z: 0, prevZ: 0, alpha: 0, flip: false, own: true }).frame, null);
  const v = projectileView({ ...arrow, shadowDisableRotate: true }, 15, newProjectileViewState(), { x: 0, y: 0, tx: 0, ty: 1000, z: 0, prevZ: 0, alpha: 0, flip: false, own: true });
  assert.equal(v.shadowRotation, 0);
});

// ------------------------------------------------------------------------------- effects

interface Drawn { exp: string; frame: number; m: number[]; a: number }

function fakeArt(effects: Manifest['effects'], emitters: Record<string, EmitterDef>): BattleArt {
  const lib = { frameCount: () => 10, frameBounds: () => [0, 0, 10, 4], fps: () => 30 };
  return {
    manifest: { effects, emitters, arena: { shadow: { ShadowR: 0, ShadowG: 30, ShadowB: 0, ShadowA: 55 } } } as unknown as Manifest,
    libs: { get: () => lib },
    flip: false,
    // unflipped client projection 0x857ffc on logic units
    gameToPx: (x: number, y: number, z = 0) => [-270 + x * 0.03, y * 0.024 - z * 0.012],
  } as unknown as BattleArt;
}

function drawn(fx: EffectPlayer, layer: string): Drawn[] {
  const out: Drawn[] = [];
  const r = { draw: (_l: unknown, exp: string, frame: number, m: number[], c: number[]) => out.push({ exp, frame, m, a: c[3] }) };
  for (const it of fx.collect(layer)) it.draw(r as never);
  return out;
}

const part = (name: string) => ({ sc: 'effects', export: name, frames: 10, fps: 30 });

test('emitter burst: no interval spawns ParticleCount at once; MinLife 0 -> life 1 ms; done when they die', () => {
  const fx = new EffectPlayer(fakeArt(
    { burst: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 5, ParticleMinLife: 100, ParticleMaxLife: 100 } }), 1);
  fx.play('burst', 9000, 16000);
  fx.update(16);
  assert.equal(drawn(fx, 'Object').length, 5);
  fx.update(16);
  assert.equal(drawn(fx, 'Object').length, 5); // emitter life 1: no more spawns
  for (let i = 0; i < 5; i++) fx.update(16);
  assert.equal(drawn(fx, 'Object').length, 5); // age 96 < ParticleMinLife
  fx.update(16);
  assert.equal(drawn(fx, 'Object').length, 0);
  fx.update(16);
  assert.equal(fx.count, 0);
});

test('emitter interval: the timer counts down by dt, then spawns pre-aged particles until it is positive', () => {
  const fx = new EffectPlayer(fakeArt(
    { e1: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 100, MinLife: 1000, MaxLife: 1000, ParticleMinInterval: 10, ParticleMaxInterval: 10,
      ParticleMinLife: 5000, ParticleMaxLife: 5000 } }), 1);
  fx.play('e1', 9000, 16000);
  const counts: number[] = [];
  for (let i = 0; i < 5; i++) { fx.update(16); counts.push(drawn(fx, 'Object').length); }
  // next: 0 -> spawn, 10 | 10 -> -6 | spawn (6), 4 | 4 -> -12 | spawn (12), spawn (2), 8
  assert.deepEqual(counts, [1, 1, 2, 2, 4]);
});

test('particle ballistics: z = z0 + (vz + g·t/2)·t/1000, vz = VelocityZ·0.1, g = Gravity·1e-4 (world units)', () => {
  const fx = new EffectPlayer(fakeArt(
    { up: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 1, ParticleMinLife: 5000, ParticleMaxLife: 5000,
      ParticleMinVelocityZ: 1000, ParticleMaxVelocityZ: 1000, ParticleGravity: -2000, NoBounce: true } }), 1);
  fx.play('up', 9000, 16000);
  for (let i = 0; i < 10; i++) fx.update(50); // first update spawns at age 0, then 9 x 50 ms
  const [p] = drawn(fx, 'Object');
  const t = 450;
  const zWorld = (100 + (-0.2 * t) / 2) * t * 0.001;
  // screen y = 12 · (wy − wz/2) with wy = 32 (logic 16000)
  assert.ok(Math.abs(p.m[5] - (16000 * 0.024 - zWorld * 6)) < 1e-6, `${p.m[5]}`);
});

test('particle drag and speed: speed −= Inertia·dt/1000 per 16 ms step; x += speed·cos·dt·1e-4', () => {
  const fx = new EffectPlayer(fakeArt(
    { go: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 1, ParticleMinLife: 5000, ParticleMaxLife: 5000,
      ParticleMinSpeed: 100, ParticleMaxSpeed: 100, ParticleRandomAngle: true, Inertia: 1000 } }), 1);
  fx.play('go', 9000, 16000);
  fx.update(16); // spawn: no step yet (accumulator 0)
  fx.update(16); // one 16 ms step: speed 100 − 16 = 84
  const [p] = drawn(fx, 'Object');
  const wx = 18 + 84 * 16 * 0.0001;
  assert.ok(Math.abs(p.m[4] - (-270 + wx * 15)) < 1e-6, `${p.m[4]}`);
});

test('bounce: hitting the ground restarts the arc with direction and vz x 0.65', () => {
  const fx = new EffectPlayer(fakeArt(
    { b: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 1, ParticleMinLife: 5000, ParticleMaxLife: 5000,
      ParticleMinVelocityZ: 1000, ParticleMaxVelocityZ: 1000, ParticleGravity: -2000 } }), 1);
  fx.play('b', 9000, 16000);
  fx.update(1);
  // t = 1000 ms: z would be (100 − 100)·1 = 0 -> bounce at the step that crosses 0
  for (let i = 0; i < 20; i++) fx.update(50);
  assert.ok(Math.abs(drawn(fx, 'Object')[0].m[5] - 16000 * 0.024) < 1e-9, 'on the ground at t = 1000 ms');
  fx.update(50);
  const [p] = drawn(fx, 'Object');
  const z = (65 + (-0.2 * 50) / 2) * 50 * 0.001;
  assert.ok(Math.abs(p.m[5] - (16000 * 0.024 - z * 6)) < 1e-6, 'back in the air with vz x 0.65');
});

test('scale over life and fade out; life-stepped clip frames', () => {
  const fx = new EffectPlayer(fakeArt(
    { s: { components: [{ type: 'ParticleEmitter', layer: 'Ground', emitter: 'e' }] } },
    { e: { particles: [part('p')], ParticleCount: 1, ParticleMinLife: 1000, ParticleMaxLife: 1000,
      StartScale: 100, EndScale: 200, FadeOutDuration: 500 } }), 1);
  fx.play('s', 9000, 16000);
  fx.update(1); // spawn (age 0)
  fx.update(750); // step at age 0 -> age 750 (the step uses the age before the update)
  fx.update(1); // step at age 750
  const [p] = drawn(fx, 'Ground');
  assert.ok(Math.abs(p.m[0] - 1.75) < 1e-9, `scale ${p.m[0]}`);
  assert.equal(p.frame, Math.trunc((750 * 10) / 1000));
  assert.equal(p.a, Math.trunc((1 - 250 / 500) * 255) / 255);
});

test('SWF component lasts frames · frame time; looping effects run until stopped, then finish', () => {
  const art = fakeArt({ swf: { components: [{ type: 'SWF', layer: 'Object', sc: 'effects', export: 'c', frames: 6, fps: 60 }] },
    loop: { Loop: true, components: [{ type: 'SWF', layer: 'Object', sc: 'effects', export: 'c', frames: 6, fps: 60 }] } }, {});
  const fx = new EffectPlayer(art, 1);
  fx.play('swf', 9000, 16000);
  const frames: number[] = [];
  for (let i = 0; i < 7; i++) { fx.update(17); frames.push(drawn(fx, 'Object')[0]?.frame ?? -1); }
  assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, -1]); // D = 99 ms
  const h = fx.play('loop', 9000, 16000);
  for (let i = 0; i < 20; i++) fx.update(17);
  assert.equal(drawn(fx, 'Object').length, 1);
  fx.stop(h);
  for (let i = 0; i < 8; i++) fx.update(17);
  assert.equal(fx.count, 0);
});
