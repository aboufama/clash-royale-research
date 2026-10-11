// Area-effect spells, buffs and buildings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ST_DEAD } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

/** Full-size arena without towers: units have no default target, so they stand still. */
const still = () => newBattle({ fixture: { width: 18000, height: 32000 } });

test('Zap: level-11 damage 192, stuns 0.5 s, resets the attack', () => {
  const b = newBattle();
  assert.equal(b.defs.areaEffect('Zap', 11).damage, 192);
  const k = addActive(b, 'Knight', 1, 9000, 20000);
  b.spawn(0, 'Zap', 9000, 20000);
  b.run(20);
  b.step(); // commit tick: AEO created and hits this tick
  assert.equal(k.hp, 1766 - 192);
  assert.ok(k.buffs.some((x) => x.def.name === 'ZapFreeze'));
  assert.equal(k.atkTimer, 0);
  const pos = [k.x, k.y];
  b.run(5);
  assert.deepEqual([k.x, k.y], pos, 'stunned: no movement');
  b.run(10);
  assert.equal(k.buffs.length, 0, 'stun over after 500 ms');
});

test('Poison deals 8 damage ticks and slows by 15%', () => {
  const b = still();
  const g = addActive(b, 'Giant', 1, 9000, 22000);
  g.def.speed; // 45
  b.spawn(0, 'Poison', 9000, 22000);
  const hits: number[] = [];
  let last = g.hp;
  for (let t = 0; t < 260; t++) {
    b.step();
    if (g.hp < last) { hits.push(last - g.hp); last = g.hp; }
  }
  const tick = b.defs.buff('Poison', 11).dps;
  assert.equal(tick, 92);
  const poisonHits = hits.filter((h) => h === tick);
  assert.equal(poisonHits.length, 8, `poison ticks: ${hits.join(',')}`);
});

test('Lightning strikes the three highest-HP enemies once each', () => {
  const b = still();
  const units = [
    addActive(b, 'Knight', 1, 8000, 22000),
    addActive(b, 'Giant', 1, 9000, 22000),
    addActive(b, 'Musketeer', 1, 10000, 22000),
    addActive(b, 'Pekka', 1, 9000, 23000),
  ];
  const start = units.map((u) => u.hp);
  b.spawn(0, 'Lightning', 9000, 22300);
  b.run(80);
  const hit = units.map((u, i) => u.hp < start[i] || u.state === ST_DEAD);
  // Pekka, Giant, Knight have the most HP; Musketeer is spared
  assert.deepEqual(hit, [true, true, false, true]);
});

test('Rage hastes friendly troops (x1.3 speed and attack clock)', () => {
  const b = newBattle();
  const k = addActive(b, 'Knight', 0, 9000, 8000);
  b.spawn(0, 'Rage', 9000, 8000);
  b.run(32);
  assert.ok(k.buffs.some((x) => x.def.name === 'Rage'), 'raged');
  assert.equal((b as unknown as { clockDelta(u: unknown): number }).clockDelta(k), 65);
  assert.equal((b as unknown as { moveSpeed(u: unknown): number }).moveSpeed(k), 78);
});

test('attack clock with haste and slow buffs follows the native formula', () => {
  const b = newBattle();
  const k = addActive(b, 'Knight', 0, 9000, 8000);
  const cd = () => (b as unknown as { clockDelta(u: unknown): number }).clockDelta(k);
  const mk = (name: string, hitSpeedMul: number) => ({ ...b.defs.buff('Rage', 11), name, hitSpeedMul, dps: 0, hps: 0, stacking: false });
  b.applyBuff(k, mk('haste150', 150), 1000, 1);
  assert.equal(cd(), 75);
  k.buffs.length = 0;
  b.applyBuff(k, mk('slow35', -35), 1000, 1);
  assert.equal(cd(), 32);
  b.applyBuff(k, mk('haste150', 150), 1000, 1);
  assert.equal(cd(), 48);
});

test('Ice Spirit freezes what it hits; buildings decay over their lifetime', () => {
  const b = still();
  const k = addActive(b, 'Knight', 1, 9000, 18500);
  b.spawn(0, 'IceSpirits', 9000, 14500);
  let frozen = false;
  for (let t = 0; t < 120 && !frozen; t++) { b.step(); frozen = k.buffs.some((x) => x.def.name === 'Freeze'); }
  assert.ok(frozen, 'knight frozen by the ice spirit');

  const c = newBattle();
  c.spawn(0, 'Cannon', 9000, 9000);
  c.run(50);
  const cannon = c.units.find((u) => u.def.name === 'Cannon')!;
  assert.ok(cannon && cannon.hp < cannon.maxHp, 'decaying');
  c.run(600);
  assert.ok(!c.units.includes(cannon), 'expired after 30 s');
});
