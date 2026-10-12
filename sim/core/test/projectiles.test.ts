// Projectile paths ported from the decompiled libg (docs/FIDELITY.md): Projectile_init 0xf8e4c8,
// Projectile_setup 0xf8e6fc / setAim 0xf8fb34, Projectile_update 0xf90708, the piercing collision
// step 0xf8f2d0 / 0xf8ff74 with the grid box query 0xf9b008 (0xf95488 / 0xf9564c), the impact
// spawns of 0xf9188c, SpellAsDeploy casting in 0xf9f47c, and the river-jump rules that touch them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Battle, Unit } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

interface Internals {
  preTick(): void;
  gridQueryBox(x: number, y: number, R: number, RY: number): Unit[];
  isValidTarget(u: Unit, t: Unit | null, checkPending: boolean): boolean;
  applyPushback(t: Unit, ox: number, oy: number, amount: number, ignoreImmune: boolean): void;
  laneHint(x: number, y: number, hint: number): number;
}
const internals = (b: Battle) => b as unknown as Internals;
const fixture = () => newBattle({ fixture: { width: 18000, height: 32000 } });

test('Log: cast 3000 behind the target at 5x the tower radius, lands on its 9th update, then rolls 10100 (0xf9f47c, 0xf9188c)', () => {
  const b = fixture();
  assert.equal(b.spawn(0, 'Log', 9500, 10000), null);
  b.run(21); // commit on tick 20 (snapped to the tile centre (9500, 10500))
  assert.equal(b.projectiles.length, 1);
  const fall = b.projectiles[0];
  assert.equal(fall.def.name, 'LogProjectile');
  assert.deepEqual([fall.startX, fall.startY, fall.startZ, fall.tx, fall.ty], [9500, 7500, 7000, 9500, 10500]);
  b.run(8); // ticks 21..28: 8 moves of 360
  assert.deepEqual([fall.x, fall.y, fall.z], [9500, 10380, 600], 'arc 0xf927ec ends at the rolling log radius Y');
  b.step(); // tick 29: arrives, spawns the rolling log there
  assert.equal(b.projectiles.length, 1);
  const roll = b.projectiles[0];
  assert.equal(roll.def.name, 'LogProjectileRolling');
  assert.deepEqual([roll.x, roll.y, roll.z, roll.tx, roll.ty], [9500, 10500, 600, 9500, 20600]);
  b.step(); // tick 30: first roll
  assert.equal(roll.y, 10700);
  b.run(49);
  assert.equal(roll.y, 20500);
  b.step(); // tick 80: remaining 100 < 200: arrives and is removed
  assert.equal(b.projectiles.length, 0);
  assert.equal(roll.y, 20600);
});

test('Log for the top side rolls toward -y', () => {
  const b = fixture();
  b.spawn(1, 'Log', 9500, 22000);
  b.run(21);
  const fall = b.projectiles[0];
  assert.deepEqual([fall.startY, fall.ty], [fall.ty + 3000, fall.ty]);
  b.run(9);
  const roll = b.projectiles[0];
  assert.equal(roll.def.name, 'LogProjectileRolling');
  assert.equal(roll.ty, roll.y - 10100);
});

test('rolling Log hits ground units in its box once, pushes them from its centre (PushbackAll), ignores air (0xf8ff74)', () => {
  const b = fixture();
  const knight = addActive(b, 'Knight', 1, 9500, 14000);
  const giant = addActive(b, 'Giant', 1, 11949, 15000); // IgnorePushback, 2449 to the side: box edge 1950 + 499
  const minion = addActive(b, 'Minion', 1, 9500, 14500);
  const dmg = b.defs.projectile('LogProjectileRolling', 11).damage;
  b.spawn(0, 'Log', 9500, 10000);
  b.run(42); // log at 12900 after tick 41: the knight's closest point is exactly 500 away (strict test)
  assert.equal(knight.hp, knight.maxHp);
  b.step(); // tick 42: log at 13100
  assert.equal(knight.hp, knight.maxHp - dmg);
  assert.ok(knight.kbActive);
  b.run(40);
  assert.equal(knight.hp, knight.maxHp - dmg, 'hit once');
  assert.equal(knight.y, 14500, 'knockback 700: 25(n-1)n/2 - 25 = 500 straight away from the log');
  assert.equal(giant.hp, giant.maxHp - dmg);
  assert.ok(giant.x > 11949 && giant.y > 15000, 'PushbackAll moves an IgnorePushback unit, away from the log centre');
  assert.equal(minion.hp, minion.maxHp);
});

test('box query: units by the closest point of the box (strict), buildings by square overlap (0xf95488, 0xf9564c)', () => {
  const b = fixture();
  const inX = addActive(b, 'Knight', 1, 9500 + 1950 + 499, 10000);
  const outX = addActive(b, 'Knight', 1, 9500 - 1950 - 500, 10000);
  const corner = addActive(b, 'Knight', 1, 9500 + 1950 + 300, 10000 + 600 + 400); // 300² + 400² = 500²: out
  const cannon = addActive(b, 'Cannon', 1, 9500, 10000 + 600 + 600 - 1); // square [y - 600, ...] reaches into the box
  const v = internals(b);
  v.preTick();
  const hits = v.gridQueryBox(9500, 10000, 1950, 600).slice();
  assert.ok(hits.includes(inX));
  assert.ok(!hits.includes(outX));
  assert.ok(!hits.includes(corner));
  assert.ok(hits.includes(cannon));
});

test('a jumping Hog Rider: untargetable without AttacksAir, missed by the ground-only Log, no knockback without PushbackAll', () => {
  const b = fixture();
  const hog = addActive(b, 'HogRider', 1, 9000, 17500);
  const knight = addActive(b, 'Knight', 0, 9000, 15000);
  const musk = addActive(b, 'Musketeer', 0, 9000, 12000);
  const v = internals(b);
  hog.jumping = true;
  assert.ok(!v.isValidTarget(knight, hog, true), 'state 5 needs AttacksAir (0xf94824)');
  assert.ok(v.isValidTarget(musk, hog, true));
  hog.pushImmune = true; // JumpHack_Ignore_Pushback_Buff while jumping
  v.applyPushback(hog, 9000, 18000, 1000, false);
  assert.ok(!hog.kbActive);
  v.applyPushback(hog, 9000, 18000, 1000, true);
  assert.ok(hog.kbActive, 'PushbackAll ignores the buff (0xfcfac4)');
});

test('the JumpHack action gives a jumping Hog Rider the pushback buff each tick', () => {
  const b = newBattle();
  b.spawn(0, 'HogRider', 9500, 13000);
  let jumped = false;
  for (let i = 0; i < 200 && !jumped; i++) {
    b.step();
    const hog = b.units.find((u) => u.def.name === 'HogRider');
    if (hog && hog.jumping) {
      jumped = true;
      assert.ok(hog.pushImmune);
      assert.ok(hog.jumpZ >= 0 && hog.jumpZ <= hog.def.jumpHeight);
    }
  }
  assert.ok(jumped, 'the hog jumped the river');
  const hog = b.units.find((u) => u.def.name === 'HogRider')!;
  for (let i = 0; i < 40 && hog.jumping; i++) b.step();
  assert.ok(!hog.jumping);
  b.step();
  assert.ok(!hog.pushImmune && hog.jumpZ === 0);
});

test('Goblin Barrel: three goblins on the formation ring around the impact with priorities (20i)² and 1100 ms deploy (0xf9188c)', () => {
  const b = newBattle();
  b.spawn(0, 'GoblinBarrel', 4000, 24000);
  let gobs: Unit[] = [];
  for (let i = 0; i < 100 && gobs.length === 0; i++) {
    b.step();
    gobs = b.units.filter((u) => u.def.name === 'BarrelGoblin');
  }
  assert.equal(gobs.length, 3);
  // impact (4499, 24500): Deploy_formationOffset(i, 3, r = 500 -> ring 577, team 0 flipped)
  assert.deepEqual(gobs.map((g) => [g.x, g.y]), [[4499, 25077], [4000, 24212], [4998, 24212]]);
  assert.deepEqual(gobs.map((g) => g.prio), [0, 400, 1600]);
  assert.deepEqual(gobs.map((g) => g.deployTicks), [22, 22, 22]);
});

test('target priority (actor +0x1a0) is subtracted from the squared distance in target choice (0xfc4c38)', () => {
  const b = fixture();
  const k = addActive(b, 'Knight', 0, 9000, 10000);
  const a = addActive(b, 'Knight', 1, 9000, 12000);
  const c = addActive(b, 'Knight', 1, 9000, 12010);
  c.prio = 50000; // dist2 2010² - 50000 = 3990100 < 2000²: c now counts as nearer
  b.step();
  assert.equal(k.target, c);
  void a;
});

test('Barbarian Barrel: the rolling barrel spawns a Barbarian at its end, moved to dry land (0xd392c8)', () => {
  const b = newBattle();
  b.spawn(0, 'BarbLog', 9500, 10000);
  let barb: Unit | undefined;
  for (let i = 0; i < 80 && !barb; i++) {
    b.step();
    barb = b.units.find((u) => u.def.name === 'Barbarian');
  }
  assert.ok(barb);
  // rolled from (9500, 10500) to (9500, 15000): river row, nearest dry candidate (9250, 14750)
  assert.deepEqual([barb!.x, barb!.y, barb!.deployTicks], [9250, 14750, 20]);
});

test('Bowler boulder: from ProjectileStartRadius to 7000 from the Bowler, hitting each unit once', () => {
  const b = fixture();
  const bow = addActive(b, 'Bowler', 0, 9000, 10000);
  const golem = addActive(b, 'Golem', 1, 9000, 13000);
  b.run(10);
  assert.equal(b.projectiles.length, 1);
  const p = b.projectiles[0];
  assert.deepEqual([p.startX, p.startY, p.tx, p.ty, p.z], [9000, 11000, 9000, 17000, 1000]);
  assert.equal(p.target, null, 'setAim drops the target of a piercing projectile');
  b.run(40);
  assert.equal(golem.hp, golem.maxHp - bow.def.projectile!.damage);
});

test('Executioner axe: out and back on the sine, hit list cleared at half time, attack waits for it (0xf90708, 0xfc7e20)', () => {
  const b = fixture();
  const ex = addActive(b, 'AxeMan', 0, 9000, 10000);
  const golem = addActive(b, 'Golem', 1, 9000, 13000);
  b.run(10); // throws on tick 9
  const p = b.projectiles[0];
  assert.equal(ex.axe, p);
  assert.deepEqual([p.startX, p.startY, p.tx, p.ty], [9000, 10600, 9000, 17000]);
  b.step(); // t 50: sin(6°) = 107
  assert.equal(p.y, 10600 + Math.trunc((107 * 6400) / 1024));
  b.run(13); // t 700
  const apex = p.y;
  b.step(); // t 750 crosses half: the hit list is cleared, no move
  assert.equal(p.y, apex);
  assert.equal(p.hitIds.length, 0);
  const hits0 = golem.maxHp - golem.hp;
  assert.equal(hits0, p.def.damage);
  b.run(15); // back at the start on tick 39, arrives on tick 40
  b.step();
  assert.equal(b.projectiles.length, 0);
  assert.equal(golem.maxHp - golem.hp, 2 * p.def.damage, 'hit going and coming back');
  assert.equal(ex.axe, null);
  assert.equal(ex.lastHitTick, 9, 'no throw while the axe was out');
});

test('Magic Archer arrow flies 11000 from the archer through the target and pierces (setAim)', () => {
  const b = fixture();
  addActive(b, 'EliteArcher', 0, 9000, 10000);
  const t1 = addActive(b, 'Golem', 1, 9000, 13000);
  const t2 = addActive(b, 'Golem', 1, 9000, 16000);
  b.run(14);
  const p = b.projectiles[0];
  assert.deepEqual([p.startY, p.ty, p.z], [10800, 21000, 2000]);
  b.run(12);
  assert.equal(t1.maxHp - t1.hp, p.def.damage);
  assert.equal(t2.maxHp - t2.hp, p.def.damage);
});

test('lane hint (0xd38d9c): a member across the middle from the deploy point keeps a consistent lane', () => {
  const b = newBattle();
  const v = internals(b);
  assert.equal(v.laneHint(4000, 10000, 4000), b.laneOf(4000, 10000));
  assert.equal(v.laneHint(14000, 10000, 14000), b.laneOf(14000, 10000));
});
