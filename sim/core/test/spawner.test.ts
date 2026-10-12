// Periodic spawners ported from the client (libg 160402020): the spawn timer of the character update 0xf800bc
// (actor +0x144 from SpawnStartTime at Character_initComponents 0xf7ed38, group count +0x148), the spawn
// request it builds (0xf8a060: SpawnCharacter, SpawnCharacterWithDeploy at +0x68; SpawnNumber on SpawnRadius
// without a SpawnInterval, else one member on no radius) and its executor 0xf8aac8 (positions; a member with
// hitpoints deploys only with SpawnCharacterWithDeploy).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Battle, ST_ACTIVE, ST_DEAD, type Unit } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

const fixture = () => newBattle({ fixture: { width: 18000, height: 32000 } });
const spawned = (b: Battle, name: string): Unit[] => b.units.filter((u) => u.def.name === name && u.state !== ST_DEAD);

/** Ticks (b.tick after the step) on which a `name` joined the field, over `n` steps. */
function spawnTicks(b: Battle, name: string, n: number): number[] {
  const out: number[] = [];
  let seen = spawned(b, name).length;
  for (let i = 0; i < n; i++) {
    b.step();
    const c = spawned(b, name).length;
    for (let k = seen; k < c; k++) out.push(b.tick - 1);
    seen = c;
  }
  return out;
}

test('Witch: 4 Skeletons on SpawnRadius 2000 at steps 270/180/90/0, no team mirror, active at once', () => {
  const b = fixture();
  addActive(b, 'Witch', 0, 9000, 10000);
  addActive(b, 'Witch', 1, 9000, 22000);
  b.run(19);
  assert.equal(spawned(b, 'Skeleton').length, 0);
  b.step(); // the 20th update: SpawnStartTime 1000 - 20 x 50 = 0 < 1
  const sk = spawned(b, 'Skeleton');
  assert.deepEqual(sk.map((u) => [u.team, u.x, u.y]), [
    [0, 9000, 8000], [0, 7000, 10000], [0, 9000, 12000], [0, 11000, 10000],
    [1, 9000, 20000], [1, 7000, 22000], [1, 9000, 24000], [1, 11000, 22000],
  ]);
  assert.ok(sk.every((u) => u.state === ST_ACTIVE && u.deployTicks === 0), 'no deploy (no SpawnCharacterWithDeploy)');
});

test('Night Witch: 2 Bats on SpawnRadius 1500 at the facing angle + SpawnAngleShift 90 + steps 180/0', () => {
  const b = fixture();
  addActive(b, 'DarkWitch', 0, 9000, 10000); // faces (0, 256): 90 + 90 = 180
  b.run(20);
  const bats = spawned(b, 'Bat');
  assert.deepEqual(bats.map((u) => [u.x, u.y]), [[10500, 10000], [7500, 10000]]);
  assert.ok(bats.every((u) => u.state === ST_ACTIVE));
});

test('Tombstone: the first Skeleton on the tick the deploy ends (SpawnStartTime 0), then 9, 70, 10 ticks apart', () => {
  const b = newBattle();
  assert.equal(b.spawn(0, 'Tombstone', 6000, 9000), null);
  let tomb: Unit | undefined;
  let end = -1;
  for (let i = 0; i < 80 && end < 0; i++) {
    b.step();
    tomb ??= b.units.find((u) => u.def.name === 'Tombstone');
    if (tomb && tomb.state === ST_ACTIVE) end = b.tick - 1;
  }
  assert.ok(tomb && end > 0);
  const first = spawned(b, 'Skeleton');
  assert.equal(first.length, 1, 'spawned on the deploy-end tick');
  // one member on no radius: (0, R) with R = 1000 + 500, forward for team 0
  assert.deepEqual([first[0].x, first[0].y, first[0].state, first[0].deployTicks], [tomb.x, tomb.y + 1500, ST_ACTIVE, 0]);
  assert.deepEqual(spawnTicks(b, 'Skeleton', 180).map((t) => t - end), [9, 79, 89, 159, 169]);
});

test('Barbarian Hut: Barbarians active at once, 3 per group SpawnInterval 500 apart, then SpawnPauseTime 14000', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 }, recordEvents: true });
  const hut = addActive(b, 'BarbarianHut', 1, 9000, 22000);
  const at: number[][] = [];
  for (let i = 0; i < 330; i++) {
    b.step();
    for (const e of b.events) if (e.type === 'spawn' && e.name === 'Barbarian') at.push([e.tick, e.x, e.y, e.src ?? -1]);
    for (const u of spawned(b, 'Barbarian')) assert.equal(u.state, ST_ACTIVE);
  }
  // team 1: (0, -R), R = 1000 + 500; spawned by the hut on the ticks of its timer
  assert.deepEqual(at, [0, 9, 19, 299, 309, 319].map((t) => [t, hut.x, hut.y - 1500, hut.id]));
});

test('SpawnCharacterWithDeploy (request +0x68): the member deploys for its DeployTime (PhoenixEgg data)', () => {
  const b = fixture();
  addActive(b, 'PhoenixEgg', 0, 9000, 10000);
  b.run(76); // SpawnStartTime 3800
  const ph = spawned(b, 'PhoenixNoRespawn');
  assert.equal(ph.length, 1);
  assert.ok(ph[0].state !== ST_ACTIVE && ph[0].deployTicks === Math.round(733 / 50), `deploying: ${ph[0].state} ${ph[0].deployTicks}`);
});

test('spawn timer runs at half the spawn-speed percentage (0xfc23f0): frozen spawners wait', () => {
  const b = fixture();
  const w = addActive(b, 'Witch', 0, 9000, 10000);
  const t0 = w.spawnTimer;
  b.step();
  assert.equal(w.spawnTimer, t0 - 50);
  const freeze = b.defs.buff('Freeze', 11);
  (b as unknown as { applyBuff(u: Unit, d: unknown, ms: number, src: number): void }).applyBuff(w, freeze, 1000, -1);
  b.step();
  b.step();
  assert.equal(w.spawnTimer, t0 - 50, 'SpawnSpeedMultiplier -100: no progress');
});
