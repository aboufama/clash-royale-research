// The client's area-effect object view (ctor 0x833b84, update 0x8342c8, removal 0x834038), its SWF
// length / hold-and-fade (0x82ccd8 / 0x82ccd0 read by 0x82c58c, SWF update 0x82a994, alpha 0x123cbc0),
// buff views (0x8348c8 / 0x834e54) and buff filters (0x82ea34 / 0x82ebdc), ported in
// viewer/src/sc/area_view.ts and sc/effects.ts (libg 160402020); the engine's 'aoePulse' event.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alphaByte, EffectPlayer } from '../src/sc/effects.ts';
import { AEO_FADE_MS, aeoViewEffects, applyFilterColor, AreaViews, BuffViews, filterClipLength, filterFrame } from '../src/sc/area_view.ts';
import type { AeoActor, BuffUnit } from '../src/sc/area_view.ts';
import type { BattleArt } from '../src/sc/battle_art.ts';
import type { AreaEffectArt, Manifest } from '../src/sc/manifest.ts';
import type { BattleEvent } from '../../core/src/index.ts';
import { newBattle } from '../../core/test/helpers.ts';

const swf = (exp: string, frames: number, fps: number, layer = 'Base') => ({ type: 'SWF', layer, sc: 'effects', export: exp, frames, fps });

const EFFECTS: Manifest['effects'] = {
  loopFx: { Loop: true, components: [swf('l', 6, 60, 'Object')] },
  shot: { components: [swf('s', 6, 60)] },
  // a ScaledEffect whose data says Loop (Spell_poison_ground does): 0x82dc54 makes it play once
  ground: { Loop: true, components: [swf('g', 10, 30)] },
  hit: { components: [swf('h', 6, 60)] },
  nofollow: { Loop: true, components: [swf('n', 6, 60)] },
  outer: { components: [{ type: 'Effect', effect: 'ground' }] },
  steam: { FollowParent: true, components: [swf('st', 10, 30, 'Above')] },
  steamRed: { FollowParent: true, components: [swf('stR', 10, 30, 'Above')] },
};
EFFECTS.steam.EnemyVersion = 'steamRed';

const AEOS: Record<string, AreaEffectArt> = {
  Freeze: { lifeDuration: 3500, effects: { loopingEffect: 'loopFx', scaledEffect: 'ground', oneShotEffect: 'shot', hitEffect: 'hit' } },
  Zap: { lifeDuration: 1, effects: { oneShotEffect: 'shot' } },
  NF: { lifeDuration: 1000, effects: { noFollowObjectEffect: 'nofollow' } },
};

function fakeArt(): BattleArt {
  const lib = { frameCount: () => 10, frameBounds: () => [0, 0, 10, 4], fps: () => 30 };
  return {
    manifest: { effects: EFFECTS, emitters: {}, areaEffects: AEOS, buffs: { Poison: { effect: 'steam' } },
      arena: { shadow: { ShadowR: 0, ShadowG: 30, ShadowB: 0, ShadowA: 55 } } } as unknown as Manifest,
    libs: { get: () => lib },
    flip: false,
    gameToPx: (x: number, y: number, z = 0) => [-270 + x * 0.03, y * 0.024 - z * 0.012],
  } as unknown as BattleArt;
}

interface Drawn { exp: string; frame: number; a: number; x: number; y: number }

function drawn(fx: EffectPlayer, ...layers: string[]): Drawn[] {
  const out: Drawn[] = [];
  const r = { draw: (_l: unknown, exp: string, frame: number, m: number[], c: number[]) => out.push({ exp, frame, a: c[3], x: m[4], y: m[5] }) };
  for (const layer of layers.length ? layers : ['Base', 'Object', 'Above']) for (const it of fx.collect(layer)) it.draw(r as never);
  return out;
}
const one = (fx: EffectPlayer, exp: string) => drawn(fx).find((d) => d.exp === exp);

test('0x833b84 starts LoopingEffect (looping, attached), OneShotEffect (once, no parent), ScaledEffect (once, D = life − 200)', () => {
  const calls = aeoViewEffects(AEOS.Freeze, 3500);
  assert.deepEqual(calls.map((c) => [c.slot, c.effect, c.loop, c.parented, c.attach, c.swfLength, c.swfFade]), [
    ['looping', 'loopFx', true, true, true, -1, 200],
    ['oneShot', 'shot', false, false, false, -1, 200],
    ['scaled', 'ground', false, true, false, 3300, 200],
  ]);
  assert.equal(AEO_FADE_MS, 200);
  assert.deepEqual(aeoViewEffects(AEOS.Zap, 1).map((c) => c.slot), ['oneShot']);
  // a followed target (+0x138) attaches the ScaledEffect
  assert.equal(aeoViewEffects(AEOS.Freeze, 3500, true)[2].attach, true);
});

test('0x82a994 with the effect length and hold: clip over D, last frame fading over E, done at D + E', () => {
  const fx = new EffectPlayer(fakeArt(), 1);
  fx.play('ground', 9000, 16000, { loop: false, swfLength: 1000, swfFade: 200 });
  const seq: [number, number][] = [];
  for (const dt of [1, 499, 500, 100, 50, 50]) { fx.update(dt); const g = one(fx, 'g')!; seq.push([g.frame, g.a]); }
  // the frame comes from t before this update's dt: t = 0, 1, 500, 1000, 1100, 1150
  assert.deepEqual(seq, [[0, 1], [0, 1], [5, 1], [9, 1], [9, 127 / 255], [9, 63 / 255]]);
  fx.update(50);
  assert.equal(one(fx, 'g'), undefined, 'done once t >= D + E');
  assert.equal(fx.count, 0);
  // without overrides: D = (int)(float(1/30) · 10000) = 333, no hold
  const fx2 = new EffectPlayer(fakeArt(), 1);
  fx2.play('ground', 9000, 16000, { loop: false });
  fx2.update(1); fx2.update(331); fx2.update(1); // drawn from t = 332
  assert.equal(one(fx2, 'g')!.frame, 9);
  fx2.update(1); // t = 333
  assert.equal(fx2.count, 0);
});

test('nested effects keep their own SWF length (child +0x98 / +0x9c from 0x82b7ac)', () => {
  const fx = new EffectPlayer(fakeArt(), 1);
  fx.play('outer', 9000, 16000, { swfLength: 5000, swfFade: 200 });
  fx.update(1); fx.update(199); fx.update(1);
  assert.equal(one(fx, 'g')!.frame, Math.trunc((200 * 10) / 333));
});

test('0x123cbc0: alpha clamped to 0..1, NaN → 0, stored as a byte', () => {
  assert.equal(alphaByte(NaN), 0);
  assert.equal(alphaByte(2), 255);
  assert.equal(alphaByte(-1), 0);
  assert.equal(alphaByte(0.5), 127);
  assert.equal(alphaByte(Infinity), 255);
  assert.equal(alphaByte(-Infinity), 0);
});

test('setLoop after creation (0x82dedc / 0x82dc54) overrides the data Loop flag', () => {
  const fx = new EffectPlayer(fakeArt(), 1);
  fx.play('ground', 9000, 16000, { loop: false });
  for (let i = 0; i < 10; i++) fx.update(50);
  assert.equal(fx.count, 0, 'Loop data, played once');
  const h = fx.play('shot', 9000, 16000, { loop: true });
  for (let i = 0; i < 20; i++) fx.update(50);
  assert.equal(fx.count, 1, 'no Loop data, played looping');
  assert.equal(fx.alive(h), true);
  fx.remove(h);
  assert.equal(fx.count, 0);
  assert.equal(fx.alive(h), false);
});

test('area-effect view: ScaledEffect stretched over the life, OneShot holds and fades, Looping stops when the object goes', () => {
  const art = fakeArt();
  const fx = new EffectPlayer(art, 1);
  const views = new AreaViews(fx, art.manifest, false);
  const battle = {};
  const actor: AeoActor = { id: 3000001, x: 9000, y: 16000, life: 3500, def: { name: 'Freeze', lifeDuration: 3500 } };
  views.create(battle, actor.id, 'Freeze', 0, 9000, 16000, 0, 3500);
  assert.equal(fx.count, 3);
  const step = (ms: number, live: AeoActor[]) => { views.update(battle, live); fx.update(ms); };
  step(1, [actor]);
  // the parented effects start in front of the object's sprite (y + 0.01 world = 5 logic units)
  assert.ok(Math.abs(one(fx, 'g')!.y - (16005 * 0.024)) < 1e-9);
  assert.ok(Math.abs(one(fx, 's')!.y - (16000 * 0.024)) < 1e-9);
  step(149, [actor]); step(1, [actor]); // t = 150
  assert.deepEqual([one(fx, 's')!.frame, one(fx, 's')!.a], [5, 191 / 255], 'OneShot: D = 100, alpha (100 + 200 − 150) / 200');
  for (let t = 151; t < 1651; t += 50) step(50, [actor]);
  step(1, [actor]); // t = 1651
  assert.equal(one(fx, 'g')!.frame, Math.trunc((1651 * 10) / 3300));
  assert.ok(one(fx, 'l'), 'the LoopingEffect loops');
  // the object leaves the world: 0x834038 deletes the ScaledEffect at once; the looping one plays out
  step(1, []);
  assert.equal(views.size, 0);
  assert.equal(one(fx, 'g'), undefined);
  assert.ok(one(fx, 'l'));
  let gone = -1;
  for (let i = 0; i < 40 && gone < 0; i++) { step(10, []); if (!one(fx, 'l')) gone = i; }
  assert.ok(gone > 0 && gone * 10 <= 100 + 200 + 20, `looping clip ends within its loop + E (${gone * 10} ms)`);
});

test('area-effect view: the ScaledEffect runs to its own end before the object is removed', () => {
  const art = fakeArt();
  const fx = new EffectPlayer(art, 1);
  const views = new AreaViews(fx, art.manifest, false);
  const battle = {};
  const actor: AeoActor = { id: 7, x: 9000, y: 16000, life: 3500, def: { name: 'Freeze', lifeDuration: 3500 } };
  views.create(battle, 7, 'Freeze', 1, 9000, 16000, 0, 3500);
  views.update(battle, [actor]); fx.update(1);
  for (let t = 1; t < 3401; t += 50) { views.update(battle, [actor]); fx.update(50); }
  const g = one(fx, 'g')!; // drawn from t = 3351: holding the last frame, alpha (3300 + 200 − 3351) / 200
  assert.deepEqual([g.frame, g.a], [9, alphaByte(Math.fround(149 / 200)) / 255]);
  for (let i = 0; i < 3; i++) { views.update(battle, [actor]); fx.update(50); }
  assert.equal(one(fx, 'g'), undefined, 'done at life');
});

test('area-effect view: HitEffect per pulse (vt+0x80), NoFollowObjectEffect while no target, expire flag hides', () => {
  const art = fakeArt();
  const fx = new EffectPlayer(art, 1);
  const views = new AreaViews(fx, art.manifest, false);
  const battle = {};
  const a: AeoActor = { id: 1, x: 9000, y: 16000, life: 3500, def: { name: 'Freeze', lifeDuration: 3500 } };
  views.create(battle, 1, 'Freeze', 0, 9000, 16000, 0, 3500);
  views.pulse(1);
  fx.update(1);
  assert.ok(one(fx, 'h'));
  views.pulse(99); // unknown id: nothing
  const nf: AeoActor = { id: 2, x: 9000, y: 12000, life: 1000, def: { name: 'NF', lifeDuration: 1000 } };
  views.create(battle, 2, 'NF', 0, 9000, 12000, 0, 1000);
  views.update(battle, [a, nf]);
  const n0 = fx.count;
  fx.update(10);
  views.update(battle, [a, nf]);
  assert.equal(fx.count, n0, 'started once, kept while it runs');
  assert.ok(one(fx, 'n'));
  // the tiebreak's field clear (0x10cad30 → expire flag): 0x833ea8 stops and hides everything
  views.update(battle, [], true);
  fx.update(10);
  assert.deepEqual(drawn(fx).map((d) => d.exp).filter((e) => e !== 'h'), []);
});

test('buff filter 0x82ebdc: loops over the clip length, frame ⌊t·n / D⌋; a non-looping one ends at D', () => {
  // filter_cold: 29 frames at 60 fps
  const D = filterClipLength(29, 60);
  assert.equal(D, 483);
  assert.deepEqual([0, 17, 482, 483, 500].map((t) => filterFrame(t, 29, D, true)), [0, 1, 28, 0, 1]);
  assert.equal(filterFrame(499, 29, 500, false), 28);
  assert.equal(filterFrame(500, 29, 500, false), null);
  assert.equal(filterFrame(5, 29, 0, true), 29 - 1, 'D below 2 counts as 1');
});

test('buff filter colour: adds summed and capped, multipliers and alpha ×/255 in bytes; crown towers keep alpha', () => {
  const cold = [1, 1, 1, 0.992, 0, 53, 163] as const;
  assert.deepEqual(applyFilterColor([1, 1, 1, 1, 0, 0, 0], cold), [1, 1, 1, 253 / 255, 0, 53, 163]);
  const c = applyFilterColor([1, 0.5, 1, 0.5, 10, 0, 200], cold);
  assert.deepEqual(c, [1, Math.trunc((128 * 255) / 255) / 255, 1, Math.trunc((128 * 253) / 255) / 255, 10, 53, 255]);
  assert.equal(applyFilterColor([1, 1, 1, 0.5, 0, 0, 0], cold, true)[3], 0.5);
});

test('buff views 0x8348c8 / 0x834e54: Effect at the actor (enemy version), following with FollowParent, deleted with the buff', () => {
  const art = fakeArt();
  const fx = new EffectPlayer(art, 1);
  const bv = new BuffViews(fx, art.manifest, false);
  const battle = {};
  const inst = { def: { name: 'Poison' } };
  const u: BuffUnit & { x: number } = { id: 5000001, team: 1, buffs: [inst], x: 9000 };
  const pos = (q: BuffUnit) => [(q as typeof u).x, 16000, 0] as [number, number, number];
  bv.sync(battle, [u], 1000, pos);
  assert.equal(bv.size, 1);
  fx.update(1);
  const d0 = one(fx, 'stR')!;
  assert.ok(d0, 'EnemyVersion for the opponent');
  assert.equal(bv.filterTime(inst, 1250), 250);
  u.x = 10000;
  bv.sync(battle, [u], 1050, pos);
  fx.update(50);
  assert.ok(Math.abs(one(fx, 'stR')!.x - d0.x - 1000 * 0.03) < 1e-9, 'follows its unit');
  // same instance refreshed: same view; a new instance would make a new one
  bv.sync(battle, [u], 1100, pos);
  assert.equal(bv.size, 1);
  u.buffs = [];
  bv.sync(battle, [u], 1150, pos);
  assert.equal(bv.size, 0);
  assert.equal(fx.count, 0, '0x82e160: deleted at once');
});

test("engine: 'aoePulse' at the end of every area-effect pulse (0xf7a34c), recording leaves the simulation unchanged", () => {
  const run = (rec: boolean) => {
    const b = newBattle({ fixture: { width: 18000, height: 32000 }, recordEvents: rec });
    b.spawn(0, 'Poison', 9000, 22000);
    b.spawn(0, 'Freeze', 9000, 12000);
    const ev: BattleEvent[] = [];
    for (let t = 0; t < 220; t++) { b.step(); for (const e of b.events) if (e.type === 'aoePulse' || e.type === 'aoe') ev.push({ ...e }); }
    return { ev, hash: b.hash() };
  };
  const on = run(true), off = run(false);
  assert.equal(on.hash, off.hash);
  const poison = on.ev.find((e) => e.type === 'aoe' && e.name === 'Poison')!;
  const freeze = on.ev.find((e) => e.type === 'aoe' && e.name === 'Freeze')!;
  // Poison: LifeDuration 8000, HitSpeedOffset 250, HitSpeed 250 → elapsed updates 5, 10, ..., 160
  const pp = on.ev.filter((e) => e.type === 'aoePulse' && e.id === poison.id);
  assert.equal(pp.length, 32);
  assert.equal(pp[1].tick - pp[0].tick, 5);
  assert.equal(pp[0].tick - poison.tick, 6, 'joins the world at the end of its tick; first update next tick');
  // Freeze: HitSpeed 0 → a single pulse on its first update
  assert.equal(on.ev.filter((e) => e.type === 'aoePulse' && e.id === freeze.id).length, 1);
});
