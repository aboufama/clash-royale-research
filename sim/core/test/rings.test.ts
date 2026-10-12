// View events of the client's battle-screen listener and character view: area rings (World_areaDamage
// 0xf97be8 -> vt+0x3a8 0xbe76e8 / vt+0x3b0 0xbe7980, area-effect pulses 0xf7a34c) and the jump landing
// (Actor_setState 0xf7f2c8 -> view vt+0x80). Events only: the state hash must not depend on recording.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Battle, BattleEvent } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

/** Full-size arena without towers. */
const still = (recordEvents = true) => newBattle({ fixture: { width: 18000, height: 32000 }, recordEvents });

function collect(b: Battle, ticks: number, types: BattleEvent['type'][]): BattleEvent[] {
  const out: BattleEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    b.step();
    for (const e of b.events) if (types.includes(e.type)) out.push({ ...e });
  }
  return out;
}

test('Fireball: one area ring (Radius 2500) and one pushback ring (Pushback 1000) at the aim point', () => {
  const b = still();
  addActive(b, 'Knight', 1, 9000, 22000);
  addActive(b, 'Knight', 1, 9600, 22000);
  b.spawn(0, 'Fireball', 9000, 22000);
  const ev = collect(b, 120, ['areaRing', 'pushRing', 'impact', 'cast']);
  const cast = ev.find((e) => e.type === 'cast')!; // the deploy check snaps the drop to a tile centre
  const impact = ev.find((e) => e.type === 'impact')!;
  assert.ok(cast && impact);
  const rings = ev.filter((e) => e.type === 'areaRing');
  const push = ev.filter((e) => e.type === 'pushRing');
  assert.equal(rings.length, 1);
  assert.equal(push.length, 1);
  assert.deepEqual([rings[0].x, rings[0].y, rings[0].r, rings[0].r2, rings[0].tick], [cast.x, cast.y, 2500, 0, impact.tick]);
  assert.deepEqual([push[0].x, push[0].y, push[0].r, push[0].tick], [cast.x, cast.y, 1000, impact.tick]);
});

test('Arrows: each wave shows one ring, the spell circle (0xf8f03c group +0xc), even with no target', () => {
  const b = still();
  b.spawn(0, 'Arrows', 9000, 22000);
  const ev = collect(b, 200, ['areaRing', 'pushRing', 'impact', 'cast']);
  const cast = ev.find((e) => e.type === 'cast')!;
  const rings = ev.filter((e) => e.type === 'areaRing');
  assert.equal(ev.filter((e) => e.type === 'impact').length, 30);
  assert.equal(rings.length, 3);
  for (const r of rings) assert.deepEqual([r.x, r.y, r.r, r.r2], [cast.x, cast.y, 3500, 0]);
  assert.equal(new Set(rings.map((r) => r.tick)).size, 3, 'one per wave');
  assert.equal(ev.filter((e) => e.type === 'pushRing').length, 0, 'no pushback');
});

test('Valkyrie: a ring of AreaDamageRadius around herself on every swing (melee splash 0xfc7080)', () => {
  const b = still();
  const v = addActive(b, 'Valkyrie', 0, 9000, 10000);
  addActive(b, 'Knight', 1, 9000, 11200);
  const ev = collect(b, 80, ['areaRing', 'hit']);
  const hits = ev.filter((e) => e.type === 'hit' && e.id === v.id);
  const rings = ev.filter((e) => e.type === 'areaRing');
  assert.ok(hits.length >= 1);
  assert.equal(rings.length, hits.length);
  for (const r of rings) {
    assert.equal(r.r, 2000);
    assert.equal(r.r2, 0);
    assert.equal(r.id, v.id);
    assert.ok(hits.some((h) => h.tick === r.tick));
  }
});

test('Goblin Barrel: no damage, so World_areaDamage is never called and no ring shows', () => {
  const b = still();
  b.spawn(0, 'GoblinBarrel', 9000, 22000);
  const ev = collect(b, 200, ['areaRing', 'pushRing', 'impact']);
  assert.ok(ev.some((e) => e.type === 'impact'));
  assert.equal(ev.filter((e) => e.type !== 'impact').length, 0);
});

test('Golem death explosion: the area-effect pulse shows a pushback ring (Pushback 1800), no area ring', () => {
  const b = still();
  const g = addActive(b, 'Golem', 0, 9000, 10000);
  b.step();
  g.hp = 1;
  addActive(b, 'Knight', 1, 9000, 11000);
  const ev = collect(b, 100, ['areaRing', 'pushRing', 'aoe']);
  const aoe = ev.find((e) => e.type === 'aoe' && e.name === 'GolemDeathExplosion');
  assert.ok(aoe, 'death area effect');
  const push = ev.filter((e) => e.type === 'pushRing' && e.name === 'GolemDeathExplosion');
  assert.equal(push.length, 1);
  assert.deepEqual([push[0].x, push[0].y, push[0].r], [aoe.x, aoe.y, 1800]);
  assert.equal(ev.filter((e) => e.type === 'areaRing' && e.name === 'GolemDeathExplosion').length, 0);
});

test('Hog Rider river jump: one landing event when the jump state ends, at the actor', () => {
  const b = newBattle({ recordEvents: true });
  b.spawn(0, 'HogRider', 8000, 13000);
  let jumped = false;
  const ev: BattleEvent[] = [];
  for (let t = 0; t < 200; t++) {
    b.step();
    const hog = b.units.find((u) => u.def.name === 'HogRider');
    if (hog?.jumping) jumped = true;
    for (const e of b.events) {
      if (e.type !== 'landing') continue;
      ev.push({ ...e });
      assert.ok(hog && !hog.jumping && e.id === hog.id && e.x === hog.x && e.y === hog.y);
    }
  }
  assert.ok(jumped);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].name, 'HogRider');
  assert.ok(ev[0].y >= 17000, 'landed past the river');
  // the z base recorded on the tick before the landing (JumpHeight 4000: (4 - 0) * 4000 >> 4)
  assert.equal(ev[0].z, 1000);
});

test('recording the view events leaves the simulation unchanged', () => {
  const run = (rec: boolean) => {
    const b = still(rec);
    addActive(b, 'Knight', 1, 9000, 22000);
    addActive(b, 'Valkyrie', 0, 9000, 21000);
    b.spawn(0, 'Fireball', 9000, 22000);
    b.spawn(0, 'Arrows', 9000, 22500);
    b.run(200);
    return b.hash();
  };
  assert.equal(run(true), run(false));
});
