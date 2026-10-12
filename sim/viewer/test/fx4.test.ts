// Effect-system ports of libg 160402020 in viewer/src/sc/{effects,char_effects,area_view,sound}.ts:
// the logic-side sounds (GenericDie 0xf83990, the crowd reactions 0xfcb29c / 0xf83990 / 0xd423bc, the King
// activation of king_tower.toml), the component offset of 0x82bf10 (PivotClip / ParentLookAtOffsetRadius),
// the effect text of 0x82c58c, the AttackStartEffect pitch 0xfc24e0, the crown-tower filter colour of
// 0x82ebdc and the effect angle 0x1294e04 → 0x12946d4.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { angleOf } from '../../core/src/trig.ts';
import { KING_ACTIVATING, KING_ACTIVE, KING_INACTIVE, TOWER_KING, TOWER_NONE, TOWER_PRINCESS } from '../../core/src/entities.ts';
import type { BattleEvent, Unit } from '../../core/src/index.ts';
import { nativeAngle } from '../src/sc/anim.ts';
import { applyFilterColor, crownTowerFilterColor } from '../src/sc/area_view.ts';
import {
  attackStartPitch, CharEffects, childTranslation, CROWD_DIE, CROWD_SUMMON, CROWD_TOWER_DAMAGE, GENERIC_DIE, KING_ACTIVATE,
} from '../src/sc/char_effects.ts';
import type { CharFxHost } from '../src/sc/char_effects.ts';
import { EffectPlayer, parentOffset, type ParentView } from '../src/sc/effects.ts';
import type { BattleArt } from '../src/sc/battle_art.ts';
import type { Col } from '../src/sc/math.ts';
import type { EmitterDef, Manifest } from '../src/sc/manifest.ts';
import { sound, type SoundDoc, type SoundEventDef } from '../src/sc/sound.ts';

// ------------------------------------------------------------------------- fixtures

const SND = (n: string) => `soundbanks/ui_battle_general/${n}`;
/** Sound-only effects as the bake writes them (no visual component; `sounds` from the components). */
function soundFx(snd: string, enemy?: string): Manifest['effects'][string] {
  return { components: [], sounds: [[0, SND(snd)]], ...(enemy ? { EnemyVersion: enemy } : {}) } as Manifest['effects'][string];
}
const effects: Manifest['effects'] = {
  GenericDie: soundFx('own_die_jingle', 'EnemyGenericDie'),
  EnemyGenericDie: soundFx('enemy_die_jingle'),
  CrowdDieBigUnit: soundFx('summon_own_big_die', 'CrowdDieBigUnitEnemy'),
  CrowdDieBigUnitEnemy: soundFx('summon_enemy_big_die'),
  CrowdSummonBigUnit: soundFx('summon_own_big', 'CrowdSummonBigUnitEnemy'),
  CrowdSummonBigUnitEnemy: soundFx('summon_enemy_big'),
  CrowdTowerTakeDamage: soundFx('take_damage', 'CrowdTowerTakeDamageEnemy'),
  CrowdTowerTakeDamageEnemy: soundFx('take_damage_enemy'),
  King_player_activate: { components: [], sounds: [[0, SND('player_activate')], [0, SND('angry')]], EnemyVersion: 'King_enemy_activate' } as never,
  King_enemy_activate: { components: [], sounds: [[0, SND('enemy_activate')], [0, SND('angry')]] } as never,
  beam: { components: [{ type: 'SWF', layer: 'Object', sc: 'effects', export: 'b', frames: 10, fps: 30 }], Loop: true,
    ParentLookAtOffsetRadius: 1050 } as never,
  muzzle: { components: [{ type: 'ParticleEmitter', layer: 'Object', emitter: 'glow' }], Loop: true, ParentLookAtOffsetRadius: 1050 } as never,
  pivoted: { components: [{ type: 'SWF', layer: 'Object', sc: 'effects', export: 'p', frames: 10, fps: 30 }], PivotClip: 'attack_pivot' } as never,
  charge: { components: [{ type: 'SWF', layer: 'Above', sc: 'effects', export: 'effect_charge', frames: 43, fps: 30,
    textInstanceName: 'txt', textParentInstanceName: 'charge' }] } as never,
  nest: { components: [{ type: 'Effect', layer: 'Above', effect: 'charge' }] } as never,
};
const emitters: Record<string, EmitterDef> = {
  glow: { particles: [{ sc: 'effects', export: 'g', frames: 10, fps: 30 }], ParticleCount: 1, ParticleMinLife: 1000, ParticleMaxLife: 1000 },
};
const manifest = {
  effects, emitters,
  arena: { crowdEffects: true, shadow: { ShadowR: 0, ShadowG: 30, ShadowB: 0, ShadowA: 55 } },
  characters: {
    Giant: { sc: 'g', scale: 100, crowdEffects: true },
    Knight: { sc: 'k', scale: 100 },
    InfernoDragon: { sc: 'd', scale: 115, targetEffectY: -20, actions: { attack1: { export: 'inferno_dragon_attack1', dirs: 9, frames: 10, fps: 30 } } },
  },
  towers: { king: { effects: {} }, princess: { effects: {}, crowdEffects: true } },
  buffs: { Rage: { audioPitchModifier: 125 }, IceWizardCold: { audioPitchModifier: 75 }, Poison: {} },
} as unknown as Manifest;

function fakeArt(): BattleArt {
  const lib = { frameCount: () => 10, frameBounds: () => [0, 0, 10, 4], fps: () => 30, frameHeight: () => 4 };
  return {
    manifest, libs: { get: () => lib }, lib: () => lib, flip: false,
    gameToPx: (x: number, y: number, z = 0) => [-270 + x * 0.03, y * 0.024 - z * 0.012],
  } as unknown as BattleArt;
}

function unit(id: number, name: string, team: number, extra: Partial<Unit> = {}): Unit {
  return {
    id, team, x: 9000, y: 9000, z: 0, radius: 500, state: 1, card: '', tower: TOWER_NONE, kingState: KING_ACTIVE, buffs: [],
    def: { name }, ...extra,
  } as unknown as Unit;
}

function ev(type: BattleEvent['type'], id: number, team: number, name = '', tick = 10): BattleEvent {
  return { tick, type, id, team, name, x: 0, y: 0 };
}

const clock = { currentTime: 0, state: 'running', resume: async () => {}, suspend: async () => {} };
function freshSound(): void {
  const keys = ['own_die_jingle', 'enemy_die_jingle', 'summon_own_big_die', 'summon_enemy_big_die', 'summon_own_big', 'summon_enemy_big',
    'take_damage', 'take_damage_enemy', 'player_activate', 'enemy_activate', 'angry'].map(SND);
  const e = (k: string): SoundEventDef => ({ path: `event:/${k}`, max: 64, steal: 3, prio: 0, len: 48000, inst: [] });
  sound.stopAll();
  sound.doc = { v: 1, files: [], events: Object.fromEntries(keys.map((k) => [k, e(k)])), ui: {}, effects: {}, cast: {},
    time: { times: [], sounds: [] }, music: { times: [], battle: [] } } as unknown as SoundDoc;
  (sound as unknown as { loading: Promise<void> }).loading = Promise.resolve();
  sound.ctx = clock as unknown as AudioContext;
  sound.enabled = true;
  sound.log.length = 0;
}
const played = () => sound.log.filter((l) => l.ok).map((l) => l.name.slice(l.name.lastIndexOf('/') + 1));

function world(): { fx: EffectPlayer; c: CharEffects } {
  const fx = new EffectPlayer(fakeArt(), 3);
  const host: CharFxHost = {
    fx, manifest, flip: false, lib: () => ({ clip: () => undefined }) as never,
    spritePos: (u) => [u.x, u.y, u.z], sprite: () => null,
  };
  return { fx, c: new CharEffects(host) };
}

// ------------------------------------------------------------------------- logic-side sounds

test('0xf83990: GenericDie on every death (enemy version for the opponent), none for crown towers; CrowdDieBigUnit first', () => {
  freshSound();
  const { fx, c } = world();
  const knight = unit(1, 'Knight', 0), giant = unit(2, 'Giant', 1), princess = unit(3, 'PrincessTower', 1, { tower: TOWER_PRINCESS });
  const king = unit(4, 'KingTower', 0, { tower: TOWER_KING });
  const by = new Map([knight, giant, princess, king].map((u) => [u.id, u]));
  c.onStep({ tick: 10, units: [], events: [ev('death', 1, 0), ev('death', 2, 1), ev('tower', 3, 1), ev('tower', 4, 0)] }, (id) => by.get(id));
  fx.update(16);
  assert.deepEqual(played(), ['own_die_jingle', 'summon_enemy_big_die', 'enemy_die_jingle', 'summon_enemy_big_die']);
  assert.equal(fx.count, 0); // sound-only effects end after their first update
});

test('0xfcb29c: CrowdTowerTakeDamage for each entry a crown tower survives, not the lethal one; troops get none', () => {
  freshSound();
  const { fx, c } = world();
  const king = unit(4, 'KingTower', 0, { tower: TOWER_KING }), p = unit(5, 'PrincessTower', 1, { tower: TOWER_PRINCESS });
  const knight = unit(1, 'Knight', 0);
  const by = new Map([king, p, knight].map((u) => [u.id, u]));
  // the engine records a lethal entry's 'tower' event before its 'damage' event (battle.ts flushDamage)
  c.onStep({ tick: 10, units: [], events: [ev('damage', 4, 0), ev('damage', 1, 0), ev('damage', 5, 1), ev('tower', 5, 1), ev('damage', 5, 1)] },
    (id) => by.get(id));
  fx.update(16);
  assert.deepEqual(played(), ['take_damage', 'take_damage_enemy', 'summon_enemy_big_die']);
});

test('0xd423bc: CrowdSummonBigUnit for each CrowdEffects member of a cast summon (same tick, card and team)', () => {
  freshSound();
  const { fx, c } = world();
  const giant = unit(7, 'Giant', 0, { card: 'Giant' }), spawned = unit(8, 'Giant', 0, { card: 'Giant' }), k = unit(9, 'Knight', 0, { card: 'Knight' });
  const by = new Map([giant, spawned, k].map((u) => [u.id, u]));
  c.onStep({ tick: 10, units: [giant], events: [ev('cast', 0, 0, 'Giant', 10), ev('spawn', 7, 0, 'Giant', 10)] }, (id) => by.get(id));
  c.onStep({ tick: 11, units: [], events: [ev('spawn', 8, 0, 'Giant', 11)] }, (id) => by.get(id)); // not the cast's tick
  c.onStep({ tick: 12, units: [], events: [ev('cast', 0, 0, 'Knight', 12), ev('spawn', 9, 0, 'Knight', 12)] }, (id) => by.get(id));
  fx.update(16);
  assert.deepEqual(played(), ['summon_own_big']);
});

test('no crowd reactions at a location without CrowdEffects (0xe48cd4)', () => {
  freshSound();
  const { fx, c } = world();
  (manifest.arena as { crowdEffects?: boolean }).crowdEffects = false;
  try {
    const giant = unit(2, 'Giant', 1);
    c.onStep({ tick: 1, units: [], events: [ev('death', 2, 1)] }, () => giant);
    fx.update(16);
    assert.deepEqual(played(), ['enemy_die_jingle']);
  } finally {
    (manifest.arena as { crowdEffects?: boolean }).crowdEffects = true;
  }
});

test('King tower: King_player_activate (enemy: King_enemy_activate) when the 3300 ms ActionWithDuration ends', () => {
  freshSound();
  const { fx, c } = world();
  const own = unit(4, 'KingTower', 0, { tower: TOWER_KING, kingState: KING_INACTIVE });
  const opp = unit(6, 'KingTower', 1, { tower: TOWER_KING, kingState: KING_ACTIVE }); // already active when first seen
  const step = () => c.onStep({ tick: 0, units: [own, opp], events: [] }, () => undefined);
  step();
  (own as { kingState: number }).kingState = KING_ACTIVATING;
  step();
  step();
  fx.update(16);
  assert.deepEqual(played(), []);
  (own as { kingState: number }).kingState = KING_ACTIVE;
  step();
  step();
  fx.update(16);
  assert.deepEqual(played(), ['player_activate', 'angry']);
  sound.log.length = 0;
  (opp as { kingState: number }).kingState = KING_ACTIVATING;
  step();
  (opp as { kingState: number }).kingState = KING_ACTIVE;
  step();
  fx.update(16);
  assert.deepEqual(played(), ['enemy_activate', 'angry']);
  assert.deepEqual([GENERIC_DIE, CROWD_DIE, CROWD_SUMMON, CROWD_TOWER_DAMAGE, KING_ACTIVATE].every((n) => !!effects[n]), true);
});

// ------------------------------------------------------------------------- pitch

test('0xfc24e0 AttackStartEffect pitch: 100 × each AudioPitchModifier / 100 (integer), missing = 0; 0.01 scale', () => {
  assert.equal(attackStartPitch([]), 1);
  assert.equal(attackStartPitch([125]), Math.fround(1.25));
  assert.equal(attackStartPitch([75]), Math.fround(0.75));
  assert.equal(attackStartPitch([125, 75]), Math.fround(0.93)); // trunc(125·75/100) = 93
  assert.equal(attackStartPitch([undefined]), 0); // BuffData +0xfc defaults to 0
  assert.equal(attackStartPitch([-33]), Math.fround(-0.33));
  const { c } = world();
  assert.equal(c.attackStartPitch(unit(1, 'Knight', 0, { buffs: [{ def: { name: 'Rage' } }] as never })), Math.fround(1.25));
});

test('effect speed +0xb0 reaches the sound (setPitch only when ≠ 1); pitch 0 is not heard; nested effects start at 1', () => {
  freshSound();
  const fx = new EffectPlayer(fakeArt(), 3);
  const pitches: number[] = [];
  const play = sound.play.bind(sound);
  sound.play = (key, pitch = 1, kind = 'sfx') => { pitches.push(pitch); return play(key, pitch, kind); };
  try {
    fx.play('GenericDie', 0, 0, { soundPitch: 1.25 });
    fx.play('GenericDie', 0, 0, { soundPitch: 0 });
    fx.update(16);
    assert.deepEqual(pitches, [1.25, 0]);
    assert.deepEqual(sound.log.map((l) => [l.ok, l.why ?? '']), [[true, ''], [false, 'pitch 0']]);
  } finally {
    sound.play = play;
  }
});

// ------------------------------------------------------------------------- component offset

const view = (dirAngle: number, mirror: number, tey: number, kids: Record<string, [number, number]> = {}): ParentView =>
  ({ dirAngle, mirror, targetEffectY: tey, child: (n) => kids[n.toLowerCase()] ?? null });

test('0x82bf10 @0x82c2ac: PivotClip child (mirror · tx, ty + TargetEffectY); radial ParentLookAtOffsetRadius; else none', () => {
  // Inferno Dragon beam: r 1050, TargetEffectY −20, direction angle = index · 180 / 8
  assert.deepEqual(parentOffset(undefined, 1050, view(0, 1, -20)), [0, -45]); // −trunc(1050·1024/1024)·0.024 − 20
  assert.deepEqual(parentOffset(undefined, 1050, view(90, 1, -20)), [31, -20]); // 1050·0.03 = 31.5
  assert.deepEqual(parentOffset(undefined, 1050, view(90, -1, -20)), [-31, -20]);
  assert.deepEqual(parentOffset(undefined, 1050, view(180, 1, -20)), [0, 5]);
  assert.deepEqual(parentOffset(undefined, 1050, view(45, 1, 0)), [22, -17]); // sin 45 = 724/1024
  // PivotClip found (case-insensitive) wins over the radius; absent: the radius, or nothing at r = 0
  assert.deepEqual(parentOffset('attack_pivot', 1050, view(0, -1, -20, { attack_pivot: [12.5, -40.7] })), [-12, -60]);
  assert.deepEqual(parentOffset('attack_pivot', 0, view(0, 1, 0, { attack_pivot_1: [5, 5] })), null); // Electro Wizard
  assert.deepEqual(parentOffset(undefined, 0, view(0, 1, 0)), null);
});

test('component offset: SWF inner clip at k · offset, particles + offset px; re-set from the parent view every update', () => {
  const fx = new EffectPlayer(fakeArt(), 3);
  let angle = 0;
  const pv = () => view(angle, 1, -20);
  fx.play('beam', 9000, 16000, { parentView: pv, offset: [0, -20] });
  fx.play('muzzle', 9000, 16000, { parentView: pv });
  fx.update(16);
  const out: { exp: string; m: number[] }[] = [];
  const r = { draw: (_l: unknown, exp: string, _f: number, m: number[]) => out.push({ exp, m }) };
  for (const it of fx.collect('Object')) it.draw(r as never);
  const [x0, y0] = [-270 + 9000 * 0.03, 16000 * 0.024];
  const swf = out.find((d) => d.exp === 'b')!, p = out.find((d) => d.exp === 'g')!;
  assert.deepEqual([swf.m[4], swf.m[5]], [x0 + 0, y0 - 45]);
  assert.ok(Math.abs(p.m[5] - (y0 - 45)) < 1e-6 && Math.abs(p.m[4] - x0) < 1e-6);
  angle = 90;
  fx.update(16);
  out.length = 0;
  for (const it of fx.collect('Object')) it.draw(r as never);
  const s2 = out.find((d) => d.exp === 'b')!;
  assert.deepEqual([s2.m[4], s2.m[5]], [x0 + 31, y0 - 20]);
});

test('childTranslation: the direct child\'s matrix tx, ty in the frame, case-insensitive (0x1241adc)', () => {
  const lib = {
    clip: () => ({ frameCount: 1, frameStart: new Int32Array([0, 2]), elements: new Int32Array([0, 0, -1, 1, -1, -1]),
      names: ['Attack_Pivot', 'other'], bank: 0 }),
    banks: [{ m: new Float32Array([1, 0, 0, 1, 7, -9]) }],
  };
  assert.deepEqual(childTranslation(lib as never, 'x', 0, 'attack_pivot'), [7, -9]);
  assert.deepEqual(childTranslation(lib as never, 'x', 0, 'OTHER'), [0, 0]);
  assert.equal(childTranslation(lib as never, 'x', 0, 'attack_pivot_1'), null);
});

// ------------------------------------------------------------------------- effect text

test('0x82c58c effect text: own SWF components set it on TextInstanceName; nested instances carry none', () => {
  const fx = new EffectPlayer(fakeArt(), 3);
  fx.play('charge', 0, 0, { text: '+3' });
  fx.play('nest', 0, 0, { text: '+3' });
  fx.play('charge', 0, 0);
  fx.update(16);
  fx.update(16);
  const opts: unknown[] = [];
  const r = { draw: (...a: unknown[]) => opts.push(a[5]) };
  for (const it of fx.collect('Above')) it.draw(r as never);
  assert.deepEqual(opts, [{ text: { txt: '+3' } }, undefined, undefined]);
});

// ------------------------------------------------------------------------- crown tower filters

test('0x82ebdc crown-tower branch: buff / effect filter colours multiplied in with the alpha kept', () => {
  const cold: Col = [0.5, 0.75, 1, 0.5, 0, 20, 60];
  const rage: Col = [1, 0.5, 0.5, 1, 40, 0, 0];
  assert.equal(crownTowerFilterColor([]), undefined);
  assert.equal(crownTowerFilterColor([null, undefined]), undefined);
  const c = crownTowerFilterColor([cold, null, rage])!;
  assert.deepEqual(c, applyFilterColor(applyFilterColor([1, 1, 1, 1, 0, 0, 0], cold, true), rage, true));
  assert.equal(c[3], 1); // alpha kept (actor vt+0x170 = 1)
  assert.deepEqual(c.slice(4), [40, 20, 60]);
});

// ------------------------------------------------------------------------- angle

test('0x1294e04 → 0x12946d4: the viewer\'s effect angle (anim.ts nativeAngle) is the native integer atan2', () => {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  for (let x = -300; x <= 300; x += 3) for (let y = -300; y <= 300; y += 7) assert.equal(nativeAngle(x, y), angleOf(x, y), `${x},${y}`);
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() % 40001) - 20000, y = (rnd() % 40001) - 20000;
    assert.equal(nativeAngle(x, y), angleOf(x, y));
  }
  assert.deepEqual([angleOf(1, 0), angleOf(0, 1), angleOf(-1, 0), angleOf(0, -1), angleOf(0, 0)], [0, 90, 180, 270, 0]);
});
