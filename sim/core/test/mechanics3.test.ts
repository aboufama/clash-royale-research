// Ports from libg 160402020 (work/native/decomp_eng4/): Kamikaze self-kill, the target-removal notice
// and its finish wait, MultipleTargets / AllTargetsHit, the Inferno attack sequence, the projectile start
// collision's extra radius, the Miner's tunnel path (state 6), the area-effect candidate order, child
// area effects, the double King kill, crown-tower scaling and the stop-and-go walking speed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaleTower, walkSpeed, type Battle, type Unit } from '../src/index.ts';
import { addActive, data, newBattle } from './helpers.ts';

const still = () => newBattle({ fixture: { width: 18000, height: 32000 }, recordEvents: true });
type Internals = {
  queueKill(t: Unit, amount: number, owner?: number): void;
  getRange(u: Unit): number;
  nativeState(u: Unit): number;
  areaEffects: { def: { name: string } }[];
  newAeos: unknown[];
  newUnits: Unit[];
};
const I = (b: Battle) => b as unknown as Internals;

test('Kamikaze (0xf83018): the Battle Ram dies by a queued kill after its hit and spawns its Barbarians', () => {
  const b = newBattle({ recordEvents: true });
  const pt = b.players[1].princess[0];
  const ram = addActive(b, 'BattleRam', 0, pt.x, pt.y - 3000);
  let seen = false;
  for (let i = 0; i < 60 && !seen; i++) {
    b.step();
    const hit = b.events.find((e) => e.type === 'hit' && e.id === ram.id);
    if (!hit) continue;
    seen = true;
    assert.ok(pt.hp < pt.maxHp, 'the hit landed');
    // the same flush applies the self-kill (0xfca24c): a normal death with its events and death spawn
    assert.ok(b.events.some((e) => e.type === 'death' && e.id === ram.id));
    const barbs = b.events.filter((e) => e.type === 'spawn' && e.name === 'Barbarian' && e.src === ram.id);
    assert.equal(barbs.length, 2);
    assert.equal(ram.alive, false);
  }
  assert.ok(seen);
});

test('target removal (0xfc7640): an ordinary attacker waits ATTACK_FINISH_TIME_MS before it looks again', () => {
  const b = still();
  const kn = addActive(b, 'Knight', 0, 9000, 10000);
  const p1 = addActive(b, 'Pekka', 1, 9000, 11200);
  const p2 = addActive(b, 'Pekka', 1, 10500, 11200);
  while (!(kn.target === p1 && kn.atkTimer > 300)) b.step();
  const timer = kn.atkTimer;
  I(b).queueKill(p1, p1.hp, 0);
  b.step(); // the kill lands in this tick's flush; the maintenance announces the removal
  assert.equal(p1.alive, false);
  assert.equal(kn.target, null);
  assert.equal(kn.finishMs, 1);
  const finish: number[] = [];
  for (let i = 0; i < 4; i++) { b.step(); finish.push(kn.finishMs); assert.equal(kn.target, null); }
  assert.deepEqual(finish, [51, 101, 151, 201]);
  assert.ok(kn.atkTimer >= timer, 'the attack timer is not touched by the notice');
  b.step(); // 251 >= 250: the attack resets
  assert.equal(kn.finishMs, 0);
  assert.equal(kn.atkTimer, 0);
  assert.equal(kn.target, null);
  b.step(); // and the search runs again
  assert.equal(kn.target, p2);
});

test('target removal: OverrideAttackFinishTime (Electro Wizard) retargets on the next update', () => {
  const b = still();
  const ew = addActive(b, 'ElectroWizard', 0, 9000, 10000);
  const p1 = addActive(b, 'Pekka', 1, 9000, 13000);
  const p2 = addActive(b, 'Pekka', 1, 11000, 13500);
  while (!(ew.target === p1 && ew.atkTimer > 300)) b.step();
  I(b).queueKill(p1, p1.hp, 0);
  b.step();
  assert.equal(ew.target, null);
  assert.equal(ew.finishMs, 0);
  b.step();
  assert.equal(ew.target, p2);
});

test('MultipleTargets with AllTargetsHit: a lone target takes both of the Electro Wizard\'s hits', () => {
  const b = still();
  const ew = addActive(b, 'ElectroWizard', 0, 9000, 10000);
  const pk = addActive(b, 'Pekka', 1, 9000, 14000);
  const per: number[] = [];
  let last = pk.hp;
  for (let i = 0; i < 80; i++) {
    b.step();
    if (pk.hp === last) continue;
    per.push(last - pk.hp);
    assert.equal(b.events.filter((e) => e.type === 'hit' && e.id === ew.id && e.src === pk.id).length, 2);
    last = pk.hp;
  }
  assert.ok(per.length >= 2);
  for (const d of per) assert.equal(d, 2 * ew.def.damage);
});

test('Inferno attack sequence (mode 3): the stage follows the attack timer, and the hit carries it', () => {
  const b = still();
  const inf = addActive(b, 'InfernoTower', 0, 9000, 8000);
  const g = addActive(b, 'Golem', 1, 9000, 12000);
  const seq = inf.def.seq;
  assert.equal(inf.def.seqMode, 3);
  assert.equal(seq.length, 3);
  assert.equal(inf.seqIndex, -1);
  let last = g.hp;
  const stages = new Set<number>();
  for (let i = 0; i < 100; i++) {
    b.step();
    if (g.hp === last) continue;
    // 0xde0e5c: the entry whose duration the timer is in, in index order
    const t = inf.atkTimer;
    const k = t < seq[0].duration ? 0 : t < seq[0].duration + seq[1].duration ? 1 : 2;
    assert.equal(inf.seqIndex, k, `timer ${t}`);
    assert.equal(last - g.hp, seq[k].damage);
    const hit = b.events.find((e) => e.type === 'hit' && e.id === inf.id);
    assert.equal(hit?.seq, k);
    stages.add(k);
    last = g.hp;
  }
  assert.deepEqual([...stages], [0, 1, 2]);
  // the target dies: the removal notice starts the finish wait (no replacement, so no sequence reset
  // in 0xfc7640); the wait then resets the attack, the index stays until the next swing sets it
  I(b).queueKill(g, g.hp, 0);
  b.step();
  assert.equal(inf.finishMs, 1);
  assert.ok(inf.atkTimer > 0);
  b.run(5);
  assert.equal(inf.atkTimer, 0);
  assert.equal(inf.seqIndex, 2);
});

test('LOGIC_CHARACTER_CONTINUOUS_DAMAGE_ATTACK_CLOSER: the Inferno Dragon approaches 500 closer while it walks', () => {
  const b = still();
  const d = addActive(b, 'InfernoDragon', 0, 3000, 3000);
  assert.equal(I(b).nativeState(d), 1);
  assert.equal(I(b).getRange(d), d.def.range + d.radius - 500);
  d.locked = true; // attacking (state 2)
  assert.equal(I(b).getRange(d), d.def.range + d.radius);
});

test('ProjectileStartExtraRadius (0xf934bc): the Magic Archer\'s arrow checks a wider circle where it starts', () => {
  const run = (dx: number): number => {
    const b = still();
    const ma = addActive(b, 'EliteArcher', 0, 9000, 10000);
    addActive(b, 'Pekka', 1, 9000, 16000);
    b.run(2);
    assert.equal(ma.target?.def.name, 'Pekka');
    // beside the start point (800 ahead): outside the flight's 250 + 500, inside 250 + 400 + 500 at 1000
    const k = addActive(b, 'Knight', 1, 9000 + dx, 10800);
    for (let i = 0; i < 20; i++) {
      b.step();
      if (b.events.some((e) => e.type === 'shoot' && e.id === ma.id)) return k.maxHp - k.hp;
    }
    return -1;
  };
  assert.equal(data.projectiles.EliteArcherArrow.ProjectileStartExtraRadius, 400);
  assert.ok(run(1000) > 0, 'hit on launch');
  assert.equal(run(1200), 0, 'too far even with the extra radius');
});

test('Miner (0xf84f4c): state 6 from the King tower along an A* path to the deploy point, then deploys', () => {
  const b = newBattle();
  const king = b.players[0].king;
  assert.equal(b.spawn(0, 'Miner', 14000, 26000), null);
  let m: Unit | undefined;
  for (let i = 0; i < 25 && !m; i++) { b.step(); m = b.units.find((u) => u.def.name === 'Miner'); }
  assert.ok(m && m.tunneling);
  assert.equal(I(b).nativeState(m), 6);
  assert.ok(Math.abs(m.x - king.x) <= m.def.spawnPathfindSpeed && Math.abs(m.y - king.y) <= m.def.spawnPathfindSpeed);
  const dest = [m.tunnelX, m.tunnelY];
  let wet = 0;
  let ticks = 0;
  while (m.tunneling && ticks++ < 200) {
    b.step();
    // the state-6 path costs keep water at the blocked cost: it crosses on a bridge
    if (b.arena.waterCell(Math.trunc(m.x / 500), Math.trunc(m.y / 500))) wet++;
  }
  assert.equal(wet, 0);
  assert.ok(!m.tunneling);
  assert.deepEqual([m.x, m.y], dest);
  // DeployTime 1000 set at the tunnel end (0xf7f2c8 state 4) and counted down in the same update
  assert.equal(m.deployTicks, 19);
  assert.deepEqual([m.dirX, m.dirY], [0, 256]);
  b.run(19);
  assert.equal(m.deployTicks, 0);
});

test('area effects: candidates in spatial-grid order (0xf9a594) decide equal picks (Lightning)', () => {
  const b = still();
  // Lightning lands on the tile centre (9500, 20500); four equal targets 3000 away, listed right, up,
  // down, left. The grid visits columns left to right: left, down, up, right.
  const [r, u, d, l] = [[12500, 20500], [9500, 23500], [9500, 17500], [6500, 20500]].map(([x, y]) => addActive(b, 'Pekka', 1, x, y));
  b.step();
  assert.equal(b.spawn(0, 'Lightning', 9000, 20000), null);
  b.run(80);
  assert.ok(l.hp < l.maxHp && d.hp < d.maxHp && u.hp < u.maxHp);
  assert.equal(r.hp, r.maxHp);
  assert.equal(b.defs.areaEffect('Lightning', 11).targetProjectiles, true); // loader default 1 (0xdc2e74)
});

test('SpawnAreaEffectObject: the child is made on the parent\'s first update (0xf7a34c -> 0xf7b254)', () => {
  const b = newBattle({ recordEvents: true });
  assert.equal(b.spawn(0, 'Rage', 9000, 20000), null);
  let t0 = -1;
  for (let i = 0; i < 90; i++) {
    b.step();
    const names = I(b).areaEffects.map((a) => a.def.name);
    if (t0 < 0 && names.includes('Rage')) {
      t0 = b.tick;
      assert.deepEqual(names, ['Rage']);
    } else if (t0 >= 0) {
      assert.equal(b.tick, t0 + 1);
      assert.deepEqual(names, ['Rage', 'RageDamage']);
      break;
    }
  }
  assert.ok(t0 > 0);
});

test('both Kings in one tick: equal crowns, so the tiebreak gate holds (NoDraws), else a draw', () => {
  for (const noDraws of [true, false]) {
    const b = newBattle({ noDraws });
    b.run(10);
    I(b).queueKill(b.players[0].king, b.players[0].king.hp, 1);
    I(b).queueKill(b.players[1].king, b.players[1].king.hp, 0);
    b.step();
    assert.deepEqual(b.players.map((p) => p.crowns), [3, 3]);
    if (noDraws) {
      assert.equal(b.result, null);
      assert.equal(b.timeUp, true);
    } else {
      assert.deepEqual([b.result?.winner, b.result?.reason], [-1, 'king']);
    }
  }
  const b = newBattle();
  b.run(10);
  I(b).queueKill(b.players[1].king, b.players[1].king.hp, 0);
  b.step();
  assert.deepEqual([b.result?.winner, b.result?.reason], [0, 'king']);
});

test('crown-tower scaling 0xe7e418 (kinds 3-6) reproduces the exported tower tables', () => {
  const T = data.towerScaling;
  const rows: [number[], 3 | 4 | 5 | 6][] = [
    [T.king_tower.Hitpoints, 4], [T.king_tower.Damage, 3], [T.princess_tower.Hitpoints, 6], [T.princess_tower.Damage, 5],
  ];
  for (const [t, kind] of rows) {
    for (let L = 1; L <= t.length; L++) assert.equal(scaleTower(data, t[0], L, kind), t[L - 1], `kind ${kind} level ${L}`);
  }
});

test('stop-and-go characters walk faster while they move (0xdde618): Speed x ((s + w) x 1000 / s) / 1000', () => {
  assert.equal(walkSpeed(data.units.Giant), 52);
  assert.equal(walkSpeed(data.units.Golem), 54);
  assert.equal(walkSpeed(data.units.Knight), data.units.Knight.Speed);
  const b = newBattle();
  assert.equal(b.defs.unit('Giant', 11).speed, 52);
});

test('the King\'s activation is an event (King_player_activate)', () => {
  const b = newBattle({ recordEvents: true });
  const k = b.players[1].king;
  b.players[1].princess[0].hp = 1;
  I(b).queueKill(b.players[1].princess[0], 1, 0);
  let at = -1;
  for (let i = 0; i < 120 && at < 0; i++) {
    b.step();
    const e = b.events.find((x) => x.type === 'kingActivate');
    if (e) { at = b.tick; assert.equal(e.id, k.id); assert.equal(e.name, 'King_player_activate'); }
  }
  assert.ok(at > 0);
});

test('a hit cancelled from long distance is recorded as such', () => {
  const b = still();
  const kn = addActive(b, 'Knight', 0, 9000, 10000);
  const p = addActive(b, 'Pekka', 1, 9000, 11200);
  let moved = false;
  let cancelled = false;
  for (let i = 0; i < 60 && !cancelled; i++) {
    b.step();
    if (b.events.some((e) => e.type === 'hit' && e.id === kn.id && e.cancelled === true)) cancelled = true;
    // mid-swing, beyond range + LOGIC_CANCEL_HIT_FROM_LONG_DISTANCE (1500)
    if (!moved && kn.hitStarted) { p.y = 15000; moved = true; }
  }
  assert.ok(moved && cancelled);
});
