// Crown towers and buildings on the generic attack component (0xfc7e20 / 0xfc4c38 / 0xfc5398 /
// 0xfc3cb4), as ported from the decompiled libg (docs/FIDELITY.md "Tower targeting").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addActive, newBattle } from './helpers.ts';

test('a crown tower with nothing in sight takes the default target: the enemy princess tower on its lane (0xfc5398)', () => {
  const b = newBattle();
  b.step();
  const [p0, p1] = [b.players[0], b.players[1]];
  assert.equal(p0.princess[0].target, p1.princess[0]);
  assert.equal(p0.princess[1].target, p1.princess[1]);
  assert.equal(p1.princess[0].target, p0.princess[0]);
  assert.equal(p0.king.target, null, 'the inactive King runs no attack component (INACTIVE: 0xf7fee4)');
});

test('losing its target resets a tower attack: the out-of-range default target clears the clock (0xfc3cb4)', () => {
  const b = newBattle();
  const t = b.players[0].princess[0];
  const k = addActive(b, 'Knight', 1, 3500, 12000);
  for (let i = 0; i < 40 && t.target !== k; i++) b.step();
  assert.equal(t.target, k);
  b.run(5);
  assert.ok(t.atkTimer > 0);
  k.x = 3500; k.y = 20000; k.gx = k.x; k.gy = k.y; // out of sight and range
  b.step();
  assert.equal(t.target, b.players[1].princess[0]);
  assert.equal(t.atkTimer, 0);
  assert.equal(t.hitStarted, false);
});

test('an idle Cannon points at the enemy crown tower of its lane like any building (0xfc4c38 tail)', () => {
  const b = newBattle();
  const c = addActive(b, 'Cannon', 0, 4000, 9000);
  c.lane = b.laneOf(c.x, c.y);
  b.step();
  assert.equal(c.target, b.players[1].princess[0]);
});

test('missing Mass is ((r²/250)·r)/62500 clamped to [1, 20] (loader 0xdde618 @0xdded9c)', () => {
  const b = newBattle();
  assert.equal(b.defs.unit('Cannon', 11).mass, 13, 'r 600');
  assert.equal(b.defs.tower('princess', 11).mass, 20, 'r 1000 -> 64 -> 20');
  assert.equal(b.defs.tower('king', 11).mass, 20, 'r 1400 -> 175 -> 20');
  assert.equal(b.defs.unit('Knight', 11).mass, 6, 'explicit Mass kept');
});

// ---- buffs (0xf7fee4, 0xfc0748 / 0xf86668, 0xfc0e08) ----
interface BuffInternals { applyBuff(u: import('../src/index.ts').Unit, def: import('../src/index.ts').BuffDef, ms: number, src: number): void }

test('a stun drops the target and freezes the attack component; the swing resumes after it (0xf7fee4)', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 } });
  const k = addActive(b, 'Knight', 0, 9000, 10000);
  const g = addActive(b, 'Golem', 1, 9000, 11400);
  b.run(5);
  assert.equal(k.target, g);
  const t0 = k.atkTimer;
  assert.ok(t0 > 0);
  (b as unknown as BuffInternals).applyBuff(k, b.defs.buff('ZapFreeze', 11), 500, -1);
  b.step(); // attack update runs with a zero clock step; the character update then drops the target
  assert.equal(k.atkTimer, t0);
  assert.equal(k.target, null);
  assert.ok(k.atkOff);
  b.run(9); // buff expires on its 10th buff update
  assert.equal(k.atkTimer, t0, 'no attack updates while frozen');
  assert.ok(!k.atkOff);
  b.step();
  assert.equal(k.target, g, 'retargets after the stun');
  assert.equal(k.atkTimer, t0 + 50, 'the swing in progress continues (timer kept)');
});

test('damage over time ticks on every HitFrequency/50-th buff update, the first one HitFrequency after it lands (0xf86668)', () => {
  const b = newBattle({ fixture: { width: 18000, height: 32000 } });
  const g = addActive(b, 'Golem', 1, 9000, 11400);
  const poison = b.defs.buff('Poison', 11);
  (b as unknown as BuffInternals).applyBuff(g, poison, 3000, -1);
  const hp0 = g.hp;
  b.run(19);
  assert.equal(g.hp, hp0);
  b.step(); // 20th buff update
  assert.equal(g.hp, hp0 - poison.dps);
  b.run(20);
  assert.equal(g.hp, hp0 - 2 * poison.dps);
});
