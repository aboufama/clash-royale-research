// Death spawns and death elixir, ported from the client (libg 160402020): character death 0xf83990
// (ManaOnDeath, the spawn request run by 0xf8aac8), the kill reward 0xfca5ec (ManaOnDeathForOpponent to
// the damage's owner, battle screen listener vt+0x398), the death-spawn slide 0xfcff3c and the
// LOGIC_DEATH_SPAWN_IMMUNE_FIRST_TICK targeting immunity (0xf7e058 / 0xf825e4 / 0xf800bc).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Battle, type BattleEvent, ST_ACTIVE, ST_DEAD, type Unit } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

interface Priv {
  queueDamage(t: Unit, amount: number, towerDamage: number, pct: number): void;
  flushDamage(): void;
  removeDead(): void;
  tiebreakClear(): number;
  isValidTarget(u: Unit, t: Unit | null, checkPending: boolean): boolean;
  movementUpdate(u: Unit): void;
  updateActor(u: Unit): void;
}
const priv = (b: Battle) => b as unknown as Priv;

/** Kill `u` with damage from its opponent (Damage_apply), then merge the new actors as the tick end does. */
function kill(b: Battle, u: Unit): BattleEvent[] {
  b.events.length = 0;
  priv(b).queueDamage(u, u.hp + u.shield + 1, -1, 0);
  priv(b).flushDamage();
  priv(b).removeDead();
  return b.events.map((e) => ({ ...e }));
}

const spawned = (b: Battle, name: string) => b.units.filter((u) => u.def.name === name && u.state !== ST_DEAD);

test('Elixir Golem: 2 Golemites, then 4 Blobs; the killer gets 1 + 2 x 0.5 + 4 x 0.5 elixir with a float event each', () => {
  const b = newBattle({ recordEvents: true });
  for (const p of b.players) p.elixir = 0;
  const g = addActive(b, 'ElixirGolem1', 1, 9000, 20000);
  const ev = kill(b, g);
  // ManaOnDeathForOpponent 1000 -> loader x10 = 10000 (1 elixir) to the damage's owner (team 0)
  assert.equal(b.players[0].elixir, 10000);
  assert.equal(b.players[1].elixir, 0);
  const el = ev.filter((e) => e.type === 'elixir');
  assert.equal(el.length, 1);
  assert.deepEqual([el[0].team, el[0].side, el[0].amount, el[0].x, el[0].y, el[0].id], [0, 0, 10000, 9000, 20000, g.id]);
  // two Golemites on DeathSpawnRadius 750 at steps 180 and 0 (no team mirror), active at once, immune
  const mid = spawned(b, 'ElixirGolem2');
  assert.deepEqual(mid.map((u) => [u.x, u.y]), [[8250, 20000], [9750, 20000]]);
  assert.ok(mid.every((u) => u.state === ST_ACTIVE && u.spawnImmune && u.team === 1));
  for (const m of mid) kill(b, m);
  assert.equal(b.players[0].elixir, 20000);
  const blobs = spawned(b, 'ElixirGolem4');
  assert.equal(blobs.length, 4);
  assert.deepEqual(blobs.map((u) => [u.x, u.y]), [[7500, 20000], [9000, 20000], [9000, 20000], [10500, 20000]]);
  for (const u of blobs) kill(b, u);
  assert.equal(b.players[0].elixir, 40000);
  assert.equal(spawned(b, 'ElixirGolem4').length, 0);
});

test('death elixir is clamped to MAX_MANA and the tiebreak kill (owner -1) gives none', () => {
  const b = newBattle({ recordEvents: true });
  b.players[0].elixir = 95000;
  const g = addActive(b, 'ElixirGolem1', 1, 9000, 20000);
  kill(b, g);
  assert.equal(b.players[0].elixir, 100000);
  const c = newBattle({ recordEvents: true });
  for (const p of c.players) p.elixir = 0;
  addActive(c, 'ElixirGolem1', 1, 9000, 20000);
  c.events.length = 0;
  priv(c).tiebreakClear();
  priv(c).flushDamage();
  priv(c).removeDead();
  assert.deepEqual(c.players.map((p) => p.elixir), [0, 0]);
  assert.equal(c.events.filter((e) => e.type === 'elixir').length, 0);
  assert.equal(c.units.filter((u) => u.def.name === 'ElixirGolem2').length, 2, 'the death itself still spawns');
});

test('death spawns cannot be targeted until the immunity counter passes ATTACK_FINISH_TIME_MS (6 updates)', () => {
  const b = newBattle();
  const g = addActive(b, 'ElixirGolem1', 1, 9000, 20000);
  const k = addActive(b, 'Knight', 0, 9000, 19000);
  kill(b, g);
  const m = spawned(b, 'ElixirGolem2')[0];
  for (let i = 1; i <= 6; i++) {
    assert.equal(priv(b).isValidTarget(k, m, true), false, `update ${i}`);
    priv(b).updateActor(m);
  }
  assert.equal(m.spawnImmune, false);
  assert.equal(priv(b).isValidTarget(k, m, true), true);
});

test('Golem: DeathSpawnPushback slides the Golemites out from the death point (dist / 250 steps)', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 } });
  const g = addActive(b, 'Golem', 1, 9000, 20000);
  kill(b, g);
  const gs = spawned(b, 'Golemite');
  assert.equal(gs.length, 2);
  assert.ok(gs.every((u) => u.x === 9000 && u.y === 20000 && u.slideN === 6 && u.kbStep === 250));
  assert.deepEqual(gs.map((u) => [u.kbX, u.kbY]), [[7500, 20000], [10500, 20000]]);
  for (let i = 0; i < 6; i++) for (const u of gs) priv(b).movementUpdate(u);
  assert.ok(gs.every((u) => u.slideN === 0 && u.kbStep === 0));
  assert.ok(gs[0].x < 8000 && gs[1].x > 10000, `slid out: ${gs.map((u) => u.x)}`);
});

test('Night Witch bat: radius 500 at the facing angle + SpawnAngleShift 90; Battle Ram barbarians deploy 1 s', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 } });
  const w = addActive(b, 'DarkWitch', 1, 9000, 20000); // team 1 faces (0, -256): angle 270 + 90 = 0
  kill(b, w);
  const bat = spawned(b, 'Bat');
  assert.deepEqual(bat.map((u) => [u.x, u.y, u.state]), [[9500, 20000, ST_ACTIVE]]);
  const r = addActive(b, 'BattleRam', 0, 9000, 12000); // team 0 faces (0, 256): angle 90 + 180 = 270
  kill(b, r);
  const bar = spawned(b, 'Barbarian');
  assert.deepEqual(bar.map((u) => [u.x, u.y]), [[9000, 12600], [9000, 11400]]);
  assert.ok(bar.every((u) => u.state !== ST_ACTIVE && u.deployTicks === 20 && u.dirY === 256));
});

test('Tombstone: every Skeleton at the first free point of (0, R) rotated; bombs deploy their DeployTime', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 } });
  const t = addActive(b, 'Tombstone', 0, 6000, 10000);
  kill(b, t);
  const sk = spawned(b, 'Skeleton');
  assert.equal(sk.length, 4);
  assert.ok(sk.every((u) => u.x === 6000 && u.y === 11500 && u.state === ST_ACTIVE));
  const t1 = addActive(b, 'Tombstone', 1, 6000, 22000);
  kill(b, t1);
  assert.ok(spawned(b, 'Skeleton').slice(4).every((u) => u.x === 6000 && u.y === 20500));
  const bal = addActive(b, 'Balloon', 1, 9000, 20000);
  kill(b, bal);
  const bomb = spawned(b, 'BalloonBomb')[0];
  assert.ok(bomb && bomb.x === 9000 && bomb.y === 20000 && bomb.state !== ST_ACTIVE && bomb.deployTicks === 60);
});

test('events: the cast carries its first projectile id, which a projEnd reports; a failed commit reports reject', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 }, recordEvents: true });
  b.spawn(0, 'Log', 9000, 12000);
  let cast: BattleEvent | undefined;
  const ends: BattleEvent[] = [];
  for (let i = 0; i < 120; i++) {
    b.step();
    for (const e of b.events) {
      if (e.type === 'cast') cast = { ...e };
      if (e.type === 'projEnd') ends.push({ ...e });
    }
  }
  assert.ok(cast && cast.pid !== undefined && cast.pid >= 0);
  const first = ends.find((e) => e.id === cast!.pid);
  assert.ok(first, 'the cast projectile left the world');
  assert.ok(ends.some((e) => e.id !== cast!.pid), 'the rolling log too');
  // a play whose commit-run deploy check fails (the check snaps almost any point, so it is stubbed)
  b.spawn(1, 'Knight', 9000, 22000);
  (b as unknown as { deployPlace: () => null }).deployPlace = () => null;
  const rej: BattleEvent[] = [];
  for (let i = 0; i < 25; i++) { b.step(); for (const e of b.events) if (e.type === 'reject') rej.push({ ...e }); }
  assert.deepEqual(rej.map((e) => [e.team, e.name]), [[1, 'Knight']]);
});

test('timeline: a battle won at the end of regulation stays in regulation; equal crowns enter overtime', () => {
  const won = newBattle();
  won.tick = won.regulationTicks - 1;
  won.players[0].crowns = 1;
  won.step();
  assert.equal(won.result?.reason, 'time');
  assert.equal(won.overtime, false);
  const tied = newBattle();
  tied.tick = tied.regulationTicks - 2;
  tied.step();
  assert.equal(tied.overtime, false);
  tied.step();
  assert.equal(tied.overtime, true);
  assert.equal(tied.result, null);
});

test('recording the elixir / projectile / reject events leaves the simulation unchanged', () => {
  const run = (rec: boolean) => {
    const b = newBattle({ recordEvents: rec });
    addActive(b, 'ElixirGolem1', 1, 9000, 17500);
    addActive(b, 'Pekka', 0, 9000, 15500);
    b.spawn(0, 'Log', 9000, 18000);
    b.run(400);
    return b.hash();
  };
  assert.equal(run(true), run(false));
});
