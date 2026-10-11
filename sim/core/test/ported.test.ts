// Mechanics ported from the decompiled libg (docs/FIDELITY.md): pending-damage targeting
// (0xfc4008/0xf94824, 0xf8553c, 0xf8fa94), projectile hits (0xf9188c, 0xf97be8), the damage-key
// window (0xfcaeec/0xfc99e0) and the deploy check (0xf9e16c, 0xfa2c0c, 0xfa023c).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Battle, BuffDef, Unit } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

// private engine internals used to check single rules
interface Internals {
  isValidTarget(u: Unit, t: Unit | null, checkPending: boolean): boolean;
  addPending(t: Unit, dmg: number, time: number): void;
  queueDamage(t: Unit, amount: number, towerDamage: number, pct: number, key?: number): void;
  flushDamage(): void;
  applyBuff(u: Unit, def: BuffDef, timeMs: number, sourceId: number): void;
  summonZone(team: number, x: number, card: unknown): [number, number];
}
const internals = (b: Battle) => b as unknown as Internals;
const fixture = () => newBattle({ fixture: { width: 18000, height: 32000 } });

test('pending damage registers at the end of the firing tick; the shooter and others skip the doomed target (0xf94824)', () => {
  const b = fixture();
  const A = addActive(b, 'Musketeer', 0, 9000, 10000);
  const S = addActive(b, 'Skeleton', 1, 9000, 16000);
  const K = addActive(b, 'Knight', 1, 11000, 16000);
  b.run(13);
  assert.equal(S.pending, 0);
  b.step(); // tick 13: A fires; the projectile joins the world at the end of the tick (0xf8fa94)
  assert.equal(b.projectiles.length, 1);
  assert.equal(S.pending, 217, 'Musketeer damage pending on the skeleton');
  assert.equal(S.pendingDur, 250, 'flight time isqrt(dist2)*50/Speed rounded up to 50');
  assert.equal(A.target, S, 'the target is dropped only from the next tick');
  const B = addActive(b, 'Musketeer', 0, 8000, 10000);
  b.step(); // tick 14
  assert.equal(S.pendingDur, 200, '-50 per actor update (0xf800bc)');
  assert.equal(A.target, K, 'the shooter drops a target its shot will kill');
  assert.equal(B.target, K, 'a new searcher skips it too');
  b.run(3);
  assert.equal(S.alive, false);
  assert.equal(S.pending, 0, 'released when the shot lands');
});

test('pending-damage overkill rule details (0xf94824 tail, 0xfcc054, 0xf8553c)', () => {
  const b = fixture();
  const v = internals(b);
  const archer = addActive(b, 'Archer', 0, 9000, 10000);
  const knight = addActive(b, 'Knight', 0, 9000, 10500);
  const t = addActive(b, 'Knight', 1, 9000, 14000);
  t.hp = 1000; // damaged: below its full hitpoints (1766)
  assert.ok(v.isValidTarget(archer, t, true));
  v.addPending(t, t.hp - 1, 300);
  assert.ok(v.isValidTarget(archer, t, true), 'pending below hitpoints');
  v.addPending(t, 1, 0);
  assert.equal(t.pendingDur, 300);
  assert.ok(!v.isValidTarget(archer, t, true), 'pending reaches hitpoints within 600 ms');
  assert.ok(v.isValidTarget(archer, t, false), 'only with the pending check');
  assert.ok(v.isValidTarget(knight, t, true), 'attackers without a Projectile ignore it');
  t.shield = 1;
  assert.ok(v.isValidTarget(archer, t, true), 'a shield up blocks the overkill test');
  t.shield = 0;
  v.addPending(t, 0, 601);
  assert.equal(t.pendingDur, 650, 'duration = max(duration, ceil50(time))');
  assert.ok(v.isValidTarget(archer, t, true), 'duration above LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS (600)');
  v.addPending(t, 0, 5000);
  assert.equal(t.pendingDur, 1000, 'capped at 1000');
  t.pendingDur = 600;
  assert.ok(!v.isValidTarget(archer, t, true));
  v.applyBuff(t, b.defs.buff('HealSpiritBuff', 11), 1000, -1);
  assert.ok(v.isValidTarget(archer, t, true), 'a healing buff keeps it targetable');
  v.addPending(t, t.maxHp - t.pending, -1);
  assert.equal(t.pendingDur, 600, 'a negative time leaves the duration');
  assert.ok(!v.isValidTarget(archer, t, true), 'unless the pending damage reaches full hitpoints');
});

test('splash takes at most one crown tower (World_areaDamage 0xf97be8)', () => {
  const b = newBattle();
  const king = b.players[1].king;
  const princess = b.players[1].princess[1];
  b.spawn(0, 'Fireball', 12000, 27000); // snaps to (12500, 27500): overlaps King and right Princess
  b.run(80);
  assert.ok(king.hp < king.maxHp, 'the first crown tower in list order (the King) is hit');
  assert.equal(princess.hp, princess.maxHp, 'the second is not');
});

test('chain lightning hops are new flights after a 150 ms delay (0xf9188c chain tail)', () => {
  const b = fixture();
  addActive(b, 'ElectroDragon', 0, 9000, 10000);
  const ts = [addActive(b, 'Knight', 1, 9000, 13000), addActive(b, 'Minion', 1, 11000, 14000), addActive(b, 'Knight', 1, 13000, 15000)];
  const hp = ts.map((u) => u.hp);
  const hits: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    b.step();
    ts.forEach((u, k) => { if (u.hp !== hp[k]) { hits.push([b.tick - 1, k]); hp[k] = u.hp; } });
  }
  // first hit, then the air unit and the farther knight, each hop waiting 3 updates before flying
  assert.deepEqual(hits, [[14, 0], [18, 1], [23, 2]]);
});

test('a damage key is ignored for 1000 ms, each repeat refreshing the window (0xfcaeec, 0xfc99e0)', () => {
  const b = fixture();
  const v = internals(b);
  const t = addActive(b, 'Pekka', 1, 9000, 20000);
  const hp0 = t.hp;
  v.queueDamage(t, 10, -1, 0, 7);
  v.queueDamage(t, 10, -1, 0, 7);
  v.queueDamage(t, 10, -1, 0, 0);
  v.flushDamage();
  assert.equal(t.hp, hp0 - 20, 'same key twice in one flush: once; key 0 is never deduplicated');
  const hitAt = (tick: number) => {
    while (b.tick < tick) b.step();
    const before = t.hp;
    v.queueDamage(t, 10, -1, 0, 7);
    v.flushDamage();
    return before - t.hp;
  };
  const t0 = b.tick;
  assert.equal(hitAt(t0 + 19), 0, 'within 999 ms: ignored (time refreshed)');
  assert.equal(hitAt(t0 + 38), 0, 'refreshed window');
  assert.equal(hitAt(t0 + 59), 10, 'dropped by the health update of tick t0 + 58 (1000 ms after the last refresh)');
});

test('deploy check 0xf9e16c: the native committed positions, including the zone search and symmetric snap', () => {
  const b = newBattle();
  // research/evidence/native-external-full-match.json: input -> native_debit_raw_coordinates
  const cases: [number, string, number, number, number, number][] = [
    [1, 'Knight', 1241, 23316, 1499, 23499],
    [0, 'Knight', 12247, 17395, 12500, 14500], // enemy side: nearest deployable tile
    [1, 'Barbarians', 13701, 10693, 13500, 17499], // right half: x not shifted
    [0, 'Knight', 17014, 4325, 17500, 4500],
    [1, 'Knight', 7846, 12187, 7499, 17499],
    [1, 'GoblinDrill', 11560, 3193, 12000, 3000], // 2x2 footprint, kept off the King's pad
    [0, 'Knight', 12802, 2204, 12500, 2500],
    [1, 'Knight', 5208, 24895, 5499, 24499],
  ];
  for (const [team, card, x, y, ex, ey] of cases) {
    assert.deepEqual(b.deployPlace(team, b.defs.card(card, 11), x, y), { x: ex, y: ey }, `${team} ${card} ${x},${y}`);
  }
  // spells snap to the tile grid and may land on the river
  assert.deepEqual(b.deployPlace(0, b.defs.card('Fireball', 11), 12345, 16100), { x: 12500, y: 16500 });
});

test('deploy zones from the crown towers\' NoDeploySize (0xfa2c0c, 0xfa023c); a fallen Princess tower opens its lane', () => {
  const b = newBattle();
  const v = internals(b);
  const knight = b.defs.card('Knight', 11);
  assert.deepEqual(v.summonZone(0, 12500, knight), [0, 14500]);
  assert.deepEqual(v.summonZone(1, 12500, knight), [17499, 31000]);
  const right = b.players[1].princess[1];
  right.hp = 0;
  right.state = 2; // ST_DEAD
  // the pocket: rows 17..20 of the right half (river rows are water); the King's rows stay closed
  assert.deepEqual(b.deployPlace(0, knight, 14200, 22000), { x: 14500, y: 20500 });
  assert.deepEqual(b.deployPlace(0, knight, 14200, 18300), { x: 14500, y: 18500 });
  assert.deepEqual(b.deployPlace(0, knight, 5200, 18300), { x: 5499, y: 14500 }, 'left lane still closed (left half: 1000k+499)');
  assert.deepEqual(v.summonZone(0, 14500, knight), [-0x80000000, 0x7fffffff], 'span >= 16000: no summon clamp');
});
