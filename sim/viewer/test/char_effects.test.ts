// Character / building view effects (viewer/src/sc/char_effects.ts, sc/beam.ts, the Filter component in
// sc/effects.ts) ported from libg 160402020: damage entry effects (0xfcb29c), TargetedHitEffect beams
// (0x84e8e0 / 0x82a994), the Inferno slots (0x83b6d8), SpawnCharacterEffect (0xf8aac8), chain beams
// (0xf8f618 / 0x84ef20), Filter components (0x82ea34 / 0x82ebdc) and death spawn deploy filters (0xf8aac8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beamMatrix } from '../src/sc/beam.ts';
import { CharEffects, DAMAGE_EFFECT, damageEffectName, deathSpawnFilter, infernoLevel } from '../src/sc/char_effects.ts';
import type { CharFxHost } from '../src/sc/char_effects.ts';
import { EffectPlayer } from '../src/sc/effects.ts';
import type { PlayOptions } from '../src/sc/effects.ts';
import type { BattleArt } from '../src/sc/battle_art.ts';
import type { Manifest } from '../src/sc/manifest.ts';
import type { Unit } from '../../core/src/index.ts';

const manifest = {
  characters: {
    Knight: { sc: 'k', scale: 100, effects: { damageEffect: 'knight_hit' } },
    Archer: { sc: 'a', scale: 100, effects: { projectileEffect: 'ArcherAttack' } },
    Prince: { sc: 'p', scale: 100, effects: { damageEffect: 'prince_hit', damageEffectSpecial: 'prince_charge_hit', chargeEffect: 'prince_charge' } },
    NoFallback: { sc: 'n', scale: 100, useFallbackDamageEffect: false },
    Witch: { sc: 'w', scale: 100, effects: { spawnCharacterEffect: 'witch_skelly_spawn' } },
    Skeleton: { sc: 's', scale: 100, effects: { spawnEffect: 'skeleton_deploy' } },
    Tesla: { sc: 't', scale: 100, targetEffectY: -60, effects: { targetedHitEffect: 'Tesla_beam' } },
    Inferno: {
      sc: 'i', scale: 100, targetEffectY: -80, effects: {
        targettedDamageEffect1: 'beam1', targettedDamageEffect2: 'beam2', targettedDamageEffect3: 'beam3',
        flameEffect1: 'flame1', flameEffect2: 'flame2', flameEffect3: 'flame3',
        damageLevelTransitionEffect12: 'root2', damageLevelTransitionEffect23: 'root3',
      },
    },
  },
  towers: { king: { effects: { damageEffect: 'musketeer_hit' } }, princess: { effects: {} } },
  buffs: { Poison: { effect: 'PoisonSteam' }, Hot: { hitEffect: 'burn' } },
  effects: {} as Manifest['effects'],
  emitters: {},
} as unknown as Manifest;
for (const n of ['knight_hit', 'prince_hit', 'prince_charge_hit', 'musketeer_hit', 'burn', DAMAGE_EFFECT, 'witch_skelly_spawn',
  'skeleton_deploy', 'Tesla_beam', 'beam1', 'beam2', 'beam3', 'flame1', 'flame2', 'flame3', 'root2', 'root3', 'chain']) {
  manifest.effects[n] = { components: [] };
}

test('0xfcb29c damage entry effects: area "Damage", melee DamageEffect(Special) with the "Damage" fallback, projectile, buff', () => {
  assert.equal(damageEffectName(manifest, 0, 'Knight'), undefined); // area-effect pulse 0xfd068c: none
  assert.equal(damageEffectName(manifest, 1, 'Knight'), DAMAGE_EFFECT); // World_areaDamage 0xf97be8
  assert.equal(damageEffectName(manifest, 2, 'Knight'), 'knight_hit');
  assert.equal(damageEffectName(manifest, 3, 'Knight'), 'knight_hit'); // 0xde0450: Special only when set
  assert.equal(damageEffectName(manifest, 3, 'Prince'), 'prince_charge_hit');
  assert.equal(damageEffectName(manifest, 2, 'Archer'), DAMAGE_EFFECT); // UseFallbackDamageEffect (default true)
  assert.equal(damageEffectName(manifest, 2, 'NoFallback'), undefined);
  assert.equal(damageEffectName(manifest, 4, 'Archer'), DAMAGE_EFFECT); // the projectile carries the shooter's
  assert.equal(damageEffectName(manifest, 4, 'KingTower'), 'musketeer_hit');
  assert.equal(damageEffectName(manifest, 4, 'PrincessTower'), DAMAGE_EFFECT);
  assert.equal(damageEffectName(manifest, 4, ''), DAMAGE_EFFECT); // spells / spawned projectiles
  assert.equal(damageEffectName(manifest, 5, 'Poison'), DAMAGE_EFFECT); // BuffData +0x248 HitEffect, else "Damage"
  assert.equal(damageEffectName(manifest, 5, 'Hot'), 'burn');
});

test('0x82a994 beam: R(atan2 d)·S(|d|/FlashWidth, 1) from the position + offset; FlashWidth < 1 rotates only', () => {
  const m = beamMatrix([0, 0], [0, -60], [80, -60], 80);
  assert.deepEqual(m.map((v) => Math.round(v * 1e6) / 1e6), [1, 0, -0, 1, 0, -60]);
  const m2 = beamMatrix([10, 20], [0, 0], [10, 220], 100); // straight down, 200 px long
  assert.ok(Math.abs(m2[0]) < 1e-6 && Math.abs(m2[1] - 2) < 1e-6 && Math.abs(m2[2] + 1) < 1e-6 && Math.abs(m2[3]) < 1e-6);
  assert.deepEqual([m2[4], m2[5]], [10, 20]);
  const r = beamMatrix([0, 0], [0, 0], [0, 50], -1); // rotation toward the target, no stretch
  assert.ok(Math.abs(r[1] - 1) < 1e-6 && Math.abs(r[2] + 1) < 1e-6);
});

test('Inferno level = the view\'s +0x4cc = the engine\'s attack sequence index (−1 reads entry 0)', () => {
  assert.equal(infernoLevel({ seqIndex: -1 }), 0);
  assert.equal(infernoLevel({ seqIndex: 0 }), 0);
  assert.equal(infernoLevel({ seqIndex: 1 }), 1);
  assert.equal(infernoLevel({ seqIndex: 2 }), 2);
});

/** A recording effect player standing in for EffectPlayer. */
class RecFx {
  readonly art = { manifest };
  plays: { name: string; x: number; y: number; o: PlayOptions; h: number }[] = [];
  removed: number[] = [];
  private n = 1;
  has(name: string): boolean { return !!manifest.effects[name]; }
  play(name: string, x: number, y: number, o: PlayOptions = {}): number { const h = this.n++; this.plays.push({ name, x, y, o, h }); return h; }
  stop(): void { /* recorded elsewhere */ }
  remove(h: number): void { this.removed.push(h); }
}

function unit(id: number, name: string, team: number, x: number, y: number, extra: Partial<Unit> = {}): Unit {
  return {
    id, team, x, y, z: 0, radius: 500, state: 1, jumping: false, waitTicks: 0, dirX: 0, dirY: 256, charge: 0,
    target: null, atkTimer: 0, seqIndex: -1,
    def: { name, areaDamageRadius: 0, selfAsAoeCenter: false, multipleTargets: 0, seqMode: 0 },
    ...extra,
  } as unknown as Unit;
}

function host(fx: RecFx): CharFxHost {
  return {
    fx: fx as unknown as EffectPlayer, manifest, flip: false,
    lib: () => ({ clip: () => undefined }) as never,
    spritePos: (u) => [u.x, u.y, u.z],
    sprite: () => null,
  };
}

test('view vt+0x90 TargetedHitEffect: at the attacker (+0.01 world), offset (0, TargetEffectY), target point z + 2·radius', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const tesla = unit(1, 'Tesla', 0, 9000, 12000);
  const knight = unit(2, 'Knight', 1, 9000, 16000, { z: 0, radius: 500 });
  c.onAttack(5, tesla, knight, true, false, 9000, 16000);
  assert.equal(fx.plays.length, 1);
  const p = fx.plays[0];
  assert.equal(p.name, 'Tesla_beam');
  assert.deepEqual([p.x, p.y], [9000, 12005]);
  assert.deepEqual(p.o.offset, [0, -60]);
  assert.deepEqual(p.o.target!(), [9000, 16000, 1000]);
  assert.equal(p.o.team, 0);
});

test('0xfcb29c effect on the victim via vt+0xc0 (once, the victim\'s team version); melee splash centre effect', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const k = unit(3, 'Knight', 1, 1000, 2000);
  c.onDamage(1, k, 2, 'Knight', undefined);
  assert.equal(fx.plays[0].name, 'knight_hit');
  assert.equal(fx.plays[0].o.team, 1);
  assert.equal(fx.plays[0].o.loop, false);
  assert.equal(fx.plays[0].o.filterParent, 3);
  const valk = unit(4, 'Knight', 0, 5000, 5000, { def: { ...unit(0, 'Knight', 0, 0, 0).def, areaDamageRadius: 2000 } as never });
  c.onAttack(2, valk, k, true, false, 5100, 5500);
  const last = fx.plays[fx.plays.length - 1];
  assert.equal(last.name, 'knight_hit');
  assert.deepEqual([last.x, last.y, last.o.team, last.o.angle], [5100, 5500, 0, 90]); // facing (0, 256) = 90°
});

test('0xf8aac8 → 0xd35ab4: the source character\'s SpawnCharacterEffect replaces the SpawnEffect', () => {
  const c = new CharEffects(host(new RecFx()));
  assert.equal(c.spawnEffectFor('Skeleton', unit(1, 'Witch', 0, 0, 0)), 'witch_skelly_spawn');
  assert.equal(c.spawnEffectFor('Skeleton', unit(1, 'Knight', 0, 0, 0)), 'skeleton_deploy');
  assert.equal(c.spawnEffectFor('Skeleton', undefined), 'skeleton_deploy');
});

test('0x83b6d8 Inferno slots: beam / transition / flame per level, deleted and replaced when the level changes', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const giant = unit(9, 'Knight', 1, 9000, 16000);
  const inf = unit(8, 'Inferno', 0, 9000, 12000, {
    target: giant, atkTimer: 0,
    def: { ...unit(0, 'Inferno', 0, 0, 0).def, seqMode: 3 } as never,
  });
  c.update([inf, giant]);
  assert.equal(fx.plays.length, 0); // attack timer 0: nothing
  (inf as { atkTimer: number }).atkTimer = 400;
  (inf as { seqIndex: number }).seqIndex = 0;
  c.update([inf, giant]);
  assert.deepEqual(fx.plays.map((p) => p.name), ['beam1', 'root2', 'flame1']);
  assert.deepEqual(fx.plays[0].o.offset, [0, -80]);
  assert.equal(fx.plays[0].o.loop, true);
  assert.ok(fx.plays[0].o.target && !fx.plays[1].o.target && fx.plays[2].o.target);
  c.update([inf, giant]);
  assert.equal(fx.plays.length, 3); // unchanged
  (inf as { seqIndex: number }).seqIndex = 1;
  c.update([inf, giant]);
  assert.deepEqual(fx.plays.slice(3).map((p) => p.name), ['beam2', 'root3', 'flame2']);
  assert.deepEqual(fx.removed, [1, 2, 3]);
  (inf as { seqIndex: number }).seqIndex = 2;
  c.update([inf, giant]);
  assert.deepEqual(fx.plays.slice(6).map((p) => p.name), ['beam3', 'flame3']); // level 3 has no transition
  (inf as { atkTimer: number }).atkTimer = 0;
  c.update([inf, giant]);
  assert.equal(fx.plays.length, 8);
  assert.equal(fx.removed.length, 3 + 3 + 2);
});

test('0x83b6d8: an unchanged slot effect keeps its first target after a retarget; a new one waits for a target', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const a = unit(9, 'Knight', 1, 9000, 16000), b = unit(10, 'Knight', 1, 8000, 16000);
  const inf = unit(8, 'Inferno', 0, 9000, 12000, { target: a, atkTimer: 400, seqIndex: 0,
    def: { ...unit(0, 'Inferno', 0, 0, 0).def, seqMode: 3 } as never });
  c.update([inf, a, b]);
  assert.deepEqual(fx.plays.map((p) => p.name), ['beam1', 'root2', 'flame1']);
  (inf as { target: Unit }).target = b;
  c.update([inf, a, b]);
  assert.equal(fx.plays.length, 3); // same effects: no restart, the beam still aims at its first target
  assert.deepEqual(fx.plays[0].o.target!(), [9000, 16000, 1000]);
  (inf as { target: Unit | null }).target = null;
  (inf as { seqIndex: number }).seqIndex = 1;
  c.update([inf, a, b]);
  assert.deepEqual(fx.plays.slice(3).map((p) => p.name), ['root3']); // beam and flame need a target
  (inf as { target: Unit }).target = b;
  c.update([inf, a, b]);
  assert.deepEqual(fx.plays.slice(4).map((p) => p.name), ['beam2', 'flame2']);
});

test('MultipleTargets: execute\'s slot is vt+0x90\'s pivot index; a cancelled hit plays nothing', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const tesla = unit(1, 'Tesla', 0, 9000, 12000);
  const k1 = unit(2, 'Knight', 1, 9000, 16000), k2 = unit(3, 'Knight', 1, 8000, 16000);
  let idx: number[] = [];
  (c as unknown as { pivot: (u: Unit, i: number) => null }).pivot = (_u, i) => { idx.push(i); return null; };
  c.onAttack(5, tesla, k1, true, false, 0, 0, 0);
  c.onAttack(5, tesla, k2, true, false, 0, 0, 1);
  assert.deepEqual(idx, [0, 1]);
  c.onDamage(5, k2, 2, 'Tesla', tesla); // no extra beam from the damage entry
  assert.equal(fx.plays.filter((p) => p.name === 'Tesla_beam').length, 2);
  idx = [];
  c.onAttack(6, tesla, k1, true, false, 0, 0, -1, true);
  assert.equal(fx.plays.filter((p) => p.name === 'Tesla_beam').length, 2);
  assert.deepEqual(idx, []);
});

test('0xf8f618 chain beam: from the start with the shooter as parent, then from each hit target', () => {
  const fx = new RecFx();
  const c = new CharEffects(host(fx));
  const dragon = unit(1, 'Knight', 0, 9000, 12000, { z: 3500 });
  const t1 = unit(2, 'Knight', 1, 9000, 15000);
  const t2 = unit(3, 'Knight', 1, 10000, 16000);
  c.onProjectile(50, 9000, 12500, 5400, dragon);
  c.onChainHit(50, 'chain', 0, t1);
  c.onChainHit(50, 'chain', 0, t2);
  assert.equal(fx.plays.length, 2);
  // first: snapped to the shooter's sprite (no FollowParent), +0.01 world
  assert.deepEqual([fx.plays[0].x, fx.plays[0].y, fx.plays[0].o.z], [9000, 12005, 3500]);
  assert.deepEqual(fx.plays[0].o.targetPoint, [9000, 15000, 0]);
  assert.deepEqual([fx.plays[1].x, fx.plays[1].y, fx.plays[1].o.z], [9000, 15000, 0]);
  assert.deepEqual(fx.plays[1].o.targetPoint, [10000, 16000, 0]);
});

test('0x840d44 ChargeEffect: once on entering the charge clip while charging', () => {
  const fx = new RecFx();
  manifest.effects.prince_charge = { components: [] };
  const c = new CharEffects(host(fx));
  const p = unit(1, 'Prince', 0, 0, 0, { charge: 10000 });
  const af = (action: number) => ({ export: 'x', frame: 0, mirror: false, action, key: '' });
  c.viewUpdate(p, af(0));
  c.viewUpdate(p, af(3));
  c.viewUpdate(p, af(3));
  assert.deepEqual(fx.plays.map((q) => q.name), ['prince_charge']);
  c.viewUpdate(p, af(0));
  (p as { charge: number }).charge = 9999;
  c.viewUpdate(p, af(3));
  assert.equal(fx.plays.length, 1);
});

test('0x82ebdc Filter component: recolours its parent over the clip length, then ends', () => {
  const colors = [[1, 1, 1, 1, 0, 0, 0], [0.5, 0.5, 0.5, 1, 100, 0, 0]];
  const lib = {
    frameCount: () => 2, fps: () => 30,
    clip: () => ({ frameCount: 2, frameStart: new Int32Array([0, 1, 2]), elements: new Int32Array([0, 0, 0, 0, 0, 1]), bank: 0 }),
    banks: [{ c: new Float32Array(colors.flat()) }],
  };
  const art = {
    manifest: { effects: { glow: { components: [{ type: 'Filter', layer: 'Base', sc: 'fx', export: 'f', frames: 2, fps: 30 }] } }, emitters: {}, arena: {} },
    libs: { get: () => lib }, flip: false, gameToPx: (x: number, y: number) => [x, y],
  } as unknown as BattleArt;
  const fx = new EffectPlayer(art);
  fx.play('glow', 0, 0, { filterParent: 7 });
  fx.update(1);
  assert.deepEqual(fx.filters(7), [colors[0]]);
  assert.deepEqual(fx.filters(8), []);
  fx.update(40); // frame ⌊41·2/66⌋ = 1
  fx.update(1);
  assert.deepEqual(fx.filters(7).map((c) => [...c]), [colors[1]]);
  fx.update(40); // past D = 66 ms: done
  fx.update(1);
  assert.deepEqual(fx.filters(7), []);
  // without a parent the component is not made (0x82c58c needs effect +0x48)
  fx.play('glow', 0, 0);
  fx.update(1);
  assert.equal(fx.filters(7).length, 0);
});

test('vt+0x168 tunnel view: SpawnPathfindEffect following the tunnel, none over water (no _water variant), stopped at the end', () => {
  const fx = new RecFx();
  const stopped: number[] = [];
  (fx as unknown as { stop(h: number): void }).stop = (h: number) => { stopped.push(h); };
  manifest.characters.Miner = { sc: 'm', scale: 100, effects: { spawnPathfindEffect: 'miner_travel_effect' } } as never;
  manifest.effects.miner_travel_effect = { components: [], Loop: true };
  let ended = 0;
  const water = (_x: number, y: number) => y >= 15000 && y < 17000;
  const c = new CharEffects({ ...host(fx), isWater: water, tunnelEnd: () => { ended++; } });
  const m = unit(5, 'Miner', 0, 9000, 3000, { tunneling: true } as never);
  c.update([m]);
  assert.deepEqual(fx.plays.map((p) => p.name), ['miner_travel_effect']);
  assert.ok(fx.plays[0].o.follow);
  c.update([m]);
  assert.equal(fx.plays.length, 1);
  (m as { y: number }).y = 16000; // over the river: stopped, nothing restarted
  c.update([m]);
  assert.deepEqual(stopped, [1]);
  assert.equal(fx.plays.length, 1);
  (m as { y: number }).y = 18000;
  c.update([m]);
  assert.equal(fx.plays.length, 2);
  (m as unknown as { tunneling: boolean }).tunneling = false;
  c.update([m]);
  assert.deepEqual(stopped, [1, 2]);
  assert.equal(ended, 1);
});

test('0xf83990 / 0xf8aac8 death spawn deploy filter: spawned SpawnDeployBaseAnim, else the dying DeathSpawnDeployBaseAnim, else its DeployBaseAnimExportName', () => {
  const clip = (e: string) => ({ sc: 'sc/effects.sc', export: e });
  const m = {
    characters: {
      Balloon: { sc: 'b', scale: 100, deployBaseAnimExportName: clip('filter_deploy_unit_default') },
      BalloonBomb: { sc: 'bb', scale: 100 },
      Odd: { sc: 'o', scale: 100, deployBaseAnimExportName: clip('own'), deathSpawnDeployBaseAnim: clip('death') },
      Pup: { sc: 'p', scale: 100, deployBaseAnimExportName: clip('pup'), spawnDeployBaseAnim: clip('spawned') },
      Hut: { sc: 'h', scale: 100 },
    },
  } as unknown as Manifest;
  assert.equal(deathSpawnFilter(m, 'BalloonBomb', 'Balloon')?.export, 'filter_deploy_unit_default');
  assert.equal(deathSpawnFilter(m, 'BalloonBomb', 'Odd')?.export, 'death');
  assert.equal(deathSpawnFilter(m, 'Pup', 'Odd')?.export, 'spawned');
  // a dying building without the fields: no filter, not the member's own DeployBaseAnimExportName
  assert.equal(deathSpawnFilter(m, 'BalloonBomb', 'Hut'), null);
  assert.equal(deathSpawnFilter(m, 'Odd', 'Hut'), null);
});
