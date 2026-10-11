// Checks against facts observed in the original engine (docs/MECHANICS_BRIEF.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ST_ACTIVE, ST_DEPLOYING, TOWER_KING } from '../src/index.ts';
import { addActive, data, newBattle } from './helpers.ts';

test('level scaling matches known level-11 values', () => {
  const b = newBattle();
  assert.equal(b.defs.unit('Knight', 11).hitpoints, 1766);
  assert.equal(b.defs.unit('Knight', 11).damage, 202);
  assert.equal(b.defs.unit('Knight', 1).hitpoints, 690);
  assert.equal(b.defs.unit('Musketeer', 11).projectile!.damage, 217);
  assert.equal(b.defs.card('Fireball', 11).spellProjectile!.damage, 688);
  assert.equal(b.defs.unit('Giant', 11).hitpoints, 3968);
  assert.equal(b.defs.unit('Pekka', 11).hitpoints, 3760);
  assert.equal(b.defs.tower('princess', 11).hitpoints, 3052);
  assert.equal(b.defs.tower('princess', 11).projectile!.damage, 109);
  assert.equal(b.defs.tower('king', 11).hitpoints, 4824);
  assert.equal(b.defs.tower('king', 11).projectile!.damage, 109);
});

test('towers at the native frame-0 positions', () => {
  const b = newBattle();
  const pos = (u: { x: number; y: number }) => [u.x, u.y];
  assert.deepEqual(pos(b.players[0].king), [9000, 3000]);
  assert.deepEqual(b.players[0].princess.map(pos), [[3500, 6500], [14500, 6500]]);
  assert.deepEqual(pos(b.players[1].king), [9000, 29000]);
  assert.deepEqual(b.players[1].princess.map(pos), [[3500, 25500], [14500, 25500]]);
});

test('elixir = 60000 + 178 x tick at 1x (native observation)', () => {
  const b = newBattle();
  for (let t = 0; t < 22; t++) {
    assert.equal(b.players[0].elixir, 60000 + 178 * t);
    b.step();
  }
  // capped at 10 elixir
  b.run(400);
  assert.equal(b.players[0].elixir, 100000);
  assert.equal(b.elixirPerTick(), 178);
});

test('double and triple elixir rates from the timeline', () => {
  const b = newBattle();
  b.tick = 2400; // 120 s
  assert.equal(b.elixirPerTick(), 357);
  b.tick = 4800; // 240 s
  assert.equal(b.elixirPerTick(), 537);
});

test('command commits after 20 ticks; debit min(cost, current) at commit', () => {
  const b = newBattle();
  b.run(97);
  const slot = b.players[0].hand.findIndex((i) => b.players[0].deck[i].name === 'Knight');
  assert.ok(slot >= 0);
  assert.equal(b.play(0, slot, 12247, 10000), null);
  b.run(117 - 97);
  // before commit at frame 117: elixir 60000 + 178*117 = 80826 (as natively observed)
  assert.equal(b.players[0].elixir, 80826);
  b.step(); // frame 117: commit, debit 30000, then regen 178
  assert.equal(b.players[0].elixir, 80826 - 30000 + 178);
  const k = b.units.find((u) => u.def.name === 'Knight')!;
  assert.ok(k, 'knight joins the live list on the tick after commit');
  assert.equal(k.state, ST_DEPLOYING);
  assert.deepEqual([k.x, k.y], [12500, 10500]);
  // active and moving at frame 138 (118 + DeployTime 1000 ms)
  b.run(137 - 118 + 1); // frames 118..137
  assert.equal(b.tick, 138);
  const before = [k.x, k.y];
  b.step(); // frame 138
  assert.equal(k.state, ST_ACTIVE);
  assert.notDeepEqual([k.x, k.y], before, 'moves on frame 138');
});

test('group stagger: Barbarians activate 2 ticks apart (native 145,147,...)', () => {
  const b = newBattle();
  b.run(104);
  b.spawn(1, 'Barbarians', 9000, 22000);
  b.run(124 - 104 + 1); // commit at 124
  const barbs = b.units.filter((u) => u.def.name === 'Barbarian');
  assert.equal(barbs.length, 5);
  const firstActive: number[] = [];
  for (let t = b.tick; t < 160; t++) {
    const was = barbs.map((u) => u.state);
    b.step();
    barbs.forEach((u, i) => { if (was[i] === ST_DEPLOYING && u.state === ST_ACTIVE) firstActive[i] = t + 1; });
  }
  // first frame on which each can act
  assert.deepEqual(firstActive, [145, 147, 149, 151, 153]);
});

test('native deploy snapping for 1x1 troops (8-input episode)', () => {
  const b = newBattle();
  const card = b.defs.card('Knight', 11);
  const cases: [number, number, number, number, number][] = [
    [1, 1241, 23316, 1499, 23499],
    [0, 12247, 17395, 12500, 14500],
    [0, 17014, 4325, 17500, 4500],
    [1, 7846, 12187, 7499, 17499],
    [0, 12802, 2204, 12500, 2500],
    [1, 5208, 24895, 5499, 24499],
  ];
  for (const [team, x, y, ex, ey] of cases) {
    assert.deepEqual(b.snapDeploy(team, x, y, card), { x: ex, y: ey }, `${team} ${x},${y}`);
  }
});

test('Knight vs Knight fixture: hits at ticks 9, 33, 57; HP 690 -> 611 -> 532 -> 453', () => {
  const b = newBattle();
  const a = addActive(b, 'Knight', 0, 9000, 12000, 1);
  const c = addActive(b, 'Knight', 1, 9000, 13000, 1);
  const hpAt: Record<number, number> = {};
  for (let t = 0; t < 80; t++) {
    b.step();
    hpAt[t] = c.hp;
    assert.equal(a.hp, c.hp, 'symmetric exchange');
  }
  const changes = Object.entries(hpAt).filter(([t, hp]) => hp !== (hpAt[Number(t) - 1] ?? 690));
  assert.deepEqual(changes.map(([t, hp]) => [Number(t), hp]), [[9, 611], [33, 532], [57, 453]]);
});

test('King activation: first shot 76 ticks after first damage (native 621 -> 697)', () => {
  const b = newBattle();
  const king = b.players[1].king;
  assert.equal(king.tower, TOWER_KING);
  const k = addActive(b, 'Knight', 0, 9000, 29000 - 1400 - 600, 11);
  let firstDamage = -1;
  let firstShot = -1;
  const startHp = king.hp;
  for (let t = 0; t < 200 && firstShot < 0; t++) {
    const nProj = b.projectiles.length;
    b.step();
    if (firstDamage < 0 && king.hp < startHp) firstDamage = t;
    for (const p of b.projectiles.slice(0)) {
      if (p.sourceId === king.id && p.born === t && firstShot < 0) firstShot = t;
    }
    void nProj;
  }
  assert.equal(firstDamage, 9, 'knight hits the king first at tick 9');
  assert.equal(firstShot - firstDamage, 76);
  assert.ok(k);
});

test('data has the M1 cards fully supported', () => {
  const b = newBattle();
  for (const n of ['Knight', 'Archer', 'Giant', 'Musketeer', 'Fireball', 'Arrows']) {
    assert.deepEqual(b.defs.card(n, 11).unsupported, [], n);
  }
  assert.equal(data.build, '160402020');
});
