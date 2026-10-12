// Character view decisions ported in viewer/src/sc/unit_view.ts (libg 160402020): the health bar logic of
// 0x83c268 (clips from 0x836e58 / 0x83f7a8) and the summon reveal of 0xd423bc -> 0x846b2c -> 0x840d44.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newBattle } from '../../core/test/helpers.ts';
import { barFrame, condMask, deployElapsed, healthBarState, newBarChoose, newBarFrame, newBarView, pickPart, SUMMON_WAIT_ALPHA,
  summonViewDelay } from '../src/sc/unit_view.ts';
import type { BarInput, NewBarInput } from '../src/sc/unit_view.ts';

const small = { showEnemyAlways: true }; // health_bars.csv Small / Medium / High
const shieldRow = { showEnemyAlways: true }; // Shield / Shield_small
const bar = (o: Partial<BarInput>): BarInput => ({
  own: false, flags: small, hp: 100, maxHp: 100, shield: 0, maxShield: 0, lifeTime: 0, hidden: false, swapped: false, ...o,
});

test('0x83c268: an enemy troop always shows its NoDamage badge; an own one shows nothing until damaged', () => {
  const e = healthBarState(bar({}));
  assert.equal(e.visible, true);
  assert.equal(e.swapped, false); // +0x460 (hp_enemy_number)
  const o = healthBarState(bar({ own: true }));
  assert.equal(o.visible, false); // ShowOwnAlways is empty for Small / Medium / High
  const d = healthBarState(bar({ own: true, hp: 99 }));
  assert.deepEqual([d.visible, d.swapped], [true, true]); // swapped to +0x468 (hp_player_small)
  // the swap is for good: healed back to full, the normal bar stays
  const h = healthBarState(bar({ own: true, hp: 100, swapped: true }));
  assert.equal(h.visible, false); // ... but an own full-HP troop hides the container again
  assert.equal(h.swapped, true);
  const eh = healthBarState(bar({ hp: 100, swapped: true }));
  assert.deepEqual([eh.visible, eh.swapped], [true, true]);
});

test('0x83c268: states 6 / 7 / 11, death and attached actors hide the bar', () => {
  assert.equal(healthBarState(bar({ hp: 50, hidden: true })).visible, false);
  assert.equal(healthBarState(bar({ hp: 50, hidden: true })).swapped, false); // not swapped while hidden
});

test('0x83c268: the shield is the bar while it lasts (health +0x2c / +0x30)', () => {
  const full = healthBarState(bar({ flags: shieldRow, shield: 199, maxShield: 199 }));
  assert.deepEqual([full.visible, full.swapped, full.shieldBar, full.shieldUp, full.hp, full.max], [true, false, true, true, 199, 199]);
  const hit = healthBarState(bar({ flags: shieldRow, shield: 100, maxShield: 199 }));
  assert.deepEqual([hit.swapped, hit.shieldUp, hit.hp, hit.max], [true, true, 100, 199]);
  // broken: hitpoints again, `shield` hidden, and bVar8 && !bVar4 swaps and shows even an own unit
  const broken = healthBarState(bar({ own: true, flags: shieldRow, hp: 100, maxHp: 100, shield: 0, maxShield: 199 }));
  assert.deepEqual([broken.visible, broken.swapped, broken.shieldUp, broken.hp], [true, true, false, 100]);
  // own unit with its full shield: hidden
  assert.equal(healthBarState(bar({ own: true, flags: shieldRow, shield: 199, maxShield: 199 })).visible, false);
});

test('0x83c268: a building with LifeTime always shows the normal bar', () => {
  const s = healthBarState(bar({ own: true, lifeTime: 30000 }));
  assert.deepEqual([s.visible, s.swapped], [true, true]);
});

test('0x83c268 bar frame: clamp(n − 1 − ⌊hp·99/max⌋, 0, n − 1), max < 2 counts as 1', () => {
  assert.equal(barFrame(100, 100, 100), 0);
  assert.equal(barFrame(0, 100, 100), 99);
  assert.equal(barFrame(50, 100, 100), 50); // 99 − 49
  assert.equal(barFrame(1, 3, 100), 66); // 99 − ⌊99/3⌋
  assert.equal(barFrame(1, 1000, 100), 99); // ⌊99/1000⌋ = 0
  assert.equal(barFrame(999, 1000, 100), 1); // 99 − 98
  assert.equal(healthBarState(bar({ hp: 0, maxHp: 0 })).max, 1);
  assert.equal(barFrame(5, 10, 200), 199 - 49); // evolution bars have 200 frames
});

test('0xd423bc vt+0x138 delay without SummonCharacterSecond: (DeployDelay₀·i / SummonNumber) mod DeployTime', () => {
  const army = (i: number) => summonViewDelay({ index: i, number: 15, hasSecond: false, spellDeployDelay: 0, deployDelay0: 400,
    deployTime0: 1000, spawnPathfind0: 0, offset: [0, 0], team: 0 });
  assert.deepEqual([0, 1, 2, 3, 4, 14].map(army), [0, 26, 53, 80, 106, 373]);
  const skel = (i: number) => summonViewDelay({ index: i, number: 3, hasSecond: false, spellDeployDelay: 0, deployDelay0: 400,
    deployTime0: 1000, spawnPathfind0: 0, offset: [0, 0], team: 1 });
  assert.deepEqual([0, 1, 2].map(skel), [0, 133, 266]);
  assert.equal(summonViewDelay({ index: 3, number: 2, hasSecond: false, spellDeployDelay: 0, deployDelay0: 1500,
    deployTime0: 1000, spawnPathfind0: 0, offset: [0, 0], team: 0 }), 2250 % 1000);
  // no call without DeployTime, or for a tunnelling character (vt+0x168 instead)
  assert.equal(summonViewDelay({ index: 1, number: 3, hasSecond: false, spellDeployDelay: 0, deployDelay0: 400,
    deployTime0: 0, spawnPathfind0: 0, offset: [0, 0], team: 0 }), null);
  assert.equal(summonViewDelay({ index: 0, number: 1, hasSecond: false, spellDeployDelay: 0, deployDelay0: 0,
    deployTime0: 1000, spawnPathfind0: 650, offset: [0, 0], team: 0 }), null);
});

test('0xd423bc vt+0x138 delay with SummonCharacterSecond: D·a′/360, a′ = 360 − a for the bottom team', () => {
  const gang = (off: [number, number], team: number, sdd = 100) => summonViewDelay({ index: 0, number: 3, hasSecond: true,
    spellDeployDelay: sdd, deployDelay0: 400, deployTime0: 1000, spawnPathfind0: 0, offset: off, team });
  assert.equal(gang([0, -500], 0), Math.trunc((100 * 90) / 360)); // a = 270
  assert.equal(gang([0, -500], 1), Math.trunc((100 * 270) / 360));
  assert.equal(gang([500, 0], 0), 100); // a = 0 -> a′ = 360 − 0 = 360 -> D
  assert.equal(gang([500, 0], 1), 0);
  assert.equal(gang([0, 500], 1, 0), Math.trunc((400 * 90) / 360)); // SummonDeployDelay < 1: DeployDelay₀
});

test('0xf8519c deploy elapsed and the 0x846b2c wait alpha', () => {
  assert.equal(deployElapsed(1000, 1000), 0);
  assert.equal(deployElapsed(1000, 950), 50);
  assert.equal(deployElapsed(1000, -50), 1000);
  assert.equal(deployElapsed(1000, 1200), 0);
  assert.equal(SUMMON_WAIT_ALPHA, 127 / 255); // SPELL_DRAG_OBJECT_ALPHA 50 · 0.01 · 255 truncated
});

test('engine events: a cast is followed by its summon members in index order (what art.ts reads as actor +0x194)', () => {
  const b = newBattle({ seed: 3, recordEvents: true });
  assert.equal(b.spawn(0, 'SkeletonArmy', 9000, 8000), null);
  const seen: { type: string; name: string; id: number }[] = [];
  for (let t = 0; t < 40 && !seen.some((e) => e.type === 'spawn'); t++) {
    b.step();
    for (const e of b.events) if (e.type === 'cast' || e.type === 'spawn') seen.push({ type: e.type, name: e.name, id: e.id });
  }
  assert.equal(seen[0].type, 'cast');
  assert.equal(seen[0].name, 'SkeletonArmy');
  const members = seen.slice(1);
  assert.equal(members.length, 15);
  for (const m of members) {
    const u = b.units.find((q) => q.id === m.id);
    assert.ok(u);
    assert.equal(u.card, 'SkeletonArmy');
    assert.equal(u.waitTicks, 0); // no SummonDeployDelay: all in state 4 -> view delays
  }
  // Barbarians: SummonDeployDelay 100 -> members 1..4 wait (state 11) 100·i ms
  const b2 = newBattle({ seed: 3, recordEvents: true });
  assert.equal(b2.spawn(0, 'Barbarians', 9000, 8000), null);
  for (let t = 0; t < 40 && !b2.units.some((u) => u.card === 'Barbarians'); t++) b2.step();
  const barbs = b2.units.filter((u) => u.card === 'Barbarians');
  assert.deepEqual(barbs.map((u) => u.waitTicks), [0, 2, 4, 6, 8]);
});

// Client-action health bar (healthbars.toml Healthbar_Small / Healthbar_Medium: Dark Prince, Skeleton Warrior)
const U = condMask(['Underground']);
const badges = [ // Healthbar_Badge_Default, _LevelUp, _LevelDown, _Shield, _Shield_LevelUp, _Shield_LevelDown, ..., _Champion (intro)
  { cond: 0, excl: U }, { cond: condMask(['LevelUp']), excl: U }, { cond: condMask(['LevelDown']), excl: U },
  { cond: condMask(['Shield']), excl: U }, { cond: condMask(['Shield', 'LevelUp']), excl: U },
  { cond: condMask(['Shield', 'LevelDown']), excl: U }, { cond: condMask(['ActiveChampion']), excl: U, intro: true },
];
const bars = [{ cond: 0, excl: U }];
const nbIn = (o: Partial<NewBarInput>): NewBarInput => ({ own: false, hp: 1000, maxHp: 1000, shield: 0, maxShield: 0, boost: 0,
  champion: false, underground: false, invincible: false, ...o });

test('0xf739b4 condition bits and the 0x853574 part choice (exact match, else most shared bits, earliest)', () => {
  assert.deepEqual([condMask(['Shield']), condMask(['LevelUp', 'Underground']), condMask(['Nope'])], [1, 18, 0]);
  assert.equal(pickPart(badges, 0), 0);
  assert.equal(pickPart(badges, 1), 3);
  assert.equal(pickPart(badges, 1 | 2), 4);
  assert.equal(pickPart(badges, 32), 0); // Invincible matches nothing: popcount 0 everywhere, earliest wins
  assert.equal(pickPart(badges, 1 | 8), 3); // Shield + ActiveChampion with no exact part: Shield (first with 1 bit)
  assert.equal(pickPart(badges, U), -1); // every part excludes Underground
  assert.equal(pickPart(bars, U | 1), -1);
});

test('0x8405c4: an enemy shows its badge at once, the bar once damaged; an own unit shows nothing until then', () => {
  const v = newBarView();
  const f0 = newBarFrame(v, nbIn({ shield: 199, maxShield: 199 }));
  assert.deepEqual([f0.show, f0.bar, f0.flags, f0.hpPct, f0.shieldPct], [true, false, 1, 100, 100]);
  // the shield takes a hit: damaged for good, the bar shows
  const f1 = newBarFrame(v, nbIn({ shield: 100, maxShield: 199 }));
  assert.deepEqual([f1.show, f1.bar, f1.flags, f1.shieldPct], [true, true, 1, 50]);
  const f2 = newBarFrame(v, nbIn({ shield: 0, maxShield: 199, hp: 1000 }));
  assert.deepEqual([f2.bar, f2.flags, f2.shieldPct], [true, 0, 0]);
  const o = newBarView();
  assert.deepEqual([newBarFrame(o, nbIn({ own: true })).show, newBarFrame(o, nbIn({ own: true })).bar], [false, false]);
  const d = newBarFrame(o, nbIn({ own: true, hp: 999 }));
  assert.deepEqual([d.show, d.bar, d.hpPct], [true, true, 99]);
  assert.equal(newBarFrame(o, nbIn({ own: true, hp: 1000 })).bar, true); // +0x610 stays set
  assert.equal(newBarFrame(newBarView(), nbIn({ hp: 5, maxHp: 1000 })).hpPct, 1); // < 2 -> 1
  assert.equal(newBarFrame(newBarView(), nbIn({ shield: 1, maxShield: 1000 })).shieldPct, 1); // at least 1 while > 0
  assert.equal(newBarFrame(newBarView(), nbIn({ underground: true })).flags, 16);
});

test('0x853574: the badge follows the shield and stops on its last frame when it changes', () => {
  const v = newBarView();
  const a = newBarChoose(v, badges, bars, 1, 11);
  assert.deepEqual([a.badge, a.bar, a.badgeChanged, a.intro], [3, 0, true, false]);
  const b = newBarChoose(v, badges, bars, 1, 11);
  assert.deepEqual([b.badge, b.badgeChanged, b.intro], [3, false, false]);
  const c = newBarChoose(v, badges, bars, 0, 11); // shield broken
  assert.deepEqual([c.badge, c.badgeChanged], [0, true]);
  // back to the badge before last: +0x38 holds it, so no "changed" (the clip is left where it was)
  const d = newBarChoose(v, badges, bars, 1, 11);
  assert.deepEqual([d.badge, d.badgeChanged], [3, false]);
  // a HasIntroAnim badge chosen with the level unchanged plays its intro
  const w = newBarView();
  const e = newBarChoose(w, badges, bars, 8, 11);
  assert.deepEqual([e.badge, e.intro], [6, true]);
  // a level change replays the chosen badge's intro
  const g = newBarChoose(w, badges, bars, 8, 12);
  assert.deepEqual([g.badge, g.badgeChanged, g.intro], [6, false, true]);
  const h = newBarChoose(newBarView(), badges, bars, U, 11);
  assert.deepEqual([h.badge, h.bar], [-1, -1]);
});
