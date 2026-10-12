// End of the match: the battle manager's tiebreak (0x10ca9a0, 0x10cad30, 0x10cae90, 0x10cb060)
// and the crown result of the end check (0x10cb17c -> 0xd3e360). See work/native/decomp_end/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Battle } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

const END = 6000; // 180 s regulation + 120 s overtime at 20 ticks/s

/** Every crown tower HP, side 0 then side 1 (left princess, right princess, King). */
function towerHp(b: Battle): number[] {
  return b.players.flatMap((p) => [p.princess[0].hp, p.princess[1].hp, p.king.hp]);
}

/** The drain amount of 0x10cae90(mgr, 0, *) for the lowest tower HP. */
function drainAmount(low: number): number {
  return low < 21 ? 1 : low < 200 ? 10 : low < 500 ? 20 : low > 999 ? 50 : 40;
}

test('equal crowns at the end of overtime start the tiebreak instead of ending (NoDraws)', () => {
  const b = newBattle();
  b.run(END);
  assert.equal(b.result, null);
  assert.equal(b.timeUp, true);
  assert.equal(b.tiebreakMs, 0);
  b.step();
  assert.equal(b.tiebreakMs, 50); // +0x1f4 += 50 per tiebreak tick
});

test('tiebreak: the field is cleared, then 3.25 s of nothing, then the towers drain until one falls', () => {
  const b = newBattle();
  b.run(END - 1);
  // a troop on the field and a tower 100 HP down on side 1
  const k = addActive(b, 'Knight', 0, 9000, 8000);
  b.players[1].princess[0].hp -= 100;
  b.step(); // last tick of overtime: time is up, the end check is held back
  assert.equal(b.timeUp, true);
  assert.ok(k.alive);
  const before = towerHp(b);
  b.step(); // tiebreak tick 1 (clock 0 -> 50): 0x10cad30 kills every non-tower character
  assert.equal(k.alive, false);
  assert.ok(b.units.every((u) => u.tower !== 0));
  assert.equal(b.projectiles.length, 0);
  assert.equal(b.areaEffects.length, 0);
  // ticks 2..65 (clock up to 3250): nothing happens to the towers
  for (let i = 2; i <= 65; i++) b.step();
  assert.equal(b.tiebreakMs, 65 * 50);
  assert.deepEqual(towerHp(b), before);
  // from clock 3250 on: every tower loses drainAmount(lowest) per tick
  let ticks = 0;
  while (!b.result) {
    const hp = towerHp(b);
    const low = Math.min(...hp.filter((v, i) => i % 3 === 2 || v > 0));
    const crownsBefore = b.players[0].crowns;
    b.step();
    ticks++;
    if (b.result) break;
    if (crownsBefore !== b.players[0].crowns) continue; // the tower fell this tick
    const now = towerHp(b);
    for (let i = 0; i < 6; i++) assert.equal(hp[i] - now[i], drainAmount(low), `tick ${b.tick} tower ${i}`);
  }
  assert.deepEqual(b.result, { winner: 0, reason: 'tiebreak', tick: b.tick - 1 });
  assert.equal(b.players[1].princess[0].alive, false);
  assert.equal(b.players[0].crowns, 1);
  assert.ok(ticks > 90 && ticks < 120, `drain lasted ${ticks} ticks`);
});

test('tiebreak with equal towers ends in a draw after the first drain (0x10cb060)', () => {
  const b = newBattle();
  b.run(END);
  for (let i = 0; i < 66; i++) b.step();
  assert.equal(b.tiebreakDone, true);
  assert.equal(b.result, null); // the end check runs on the next manager tick
  b.step();
  assert.deepEqual(b.result, { winner: -1, reason: 'tiebreak', tick: END + 66 });
  const hp = towerHp(b);
  assert.deepEqual(hp.slice(0, 3), hp.slice(3)); // both sides drained once by 50
  assert.equal(hp[0], b.players[0].princess[0].def.hitpoints - 50);
});

test('without NoDraws a tie at the end of overtime is a draw at once', () => {
  const b = newBattle({ noDraws: false });
  b.run(END);
  assert.deepEqual(b.result, { winner: -1, reason: 'overtime', tick: END - 1 });
  assert.equal(b.tiebreakMs, 0);
});

test('BestOfGame: equal towers drain to 1 HP, the draw clock runs to 2500 ms, then a coin flip', () => {
  const run = (seed: number) => {
    const b = newBattle({ bestOfGame: true, seed });
    b.run(END);
    let drawStart = -1;
    while (!b.result) {
      b.step();
      if (drawStart < 0 && b.drawMs > 0) {
        drawStart = b.tick - 1; // the tick that started the draw clock
        assert.equal(b.lowestTowerHp(), 1);
        assert.equal(b.towersTied(), true);
      }
    }
    assert.ok(drawStart > 0);
    assert.equal(b.drawMs, 2500);
    // 50 draw-clock ticks (50..2500 ms), then the coin-flip drain, then the end check
    assert.equal(b.result!.tick, drawStart + 51);
    assert.notEqual(b.result!.winner, -1);
    return b;
  };
  const a = run(1);
  assert.equal(a.hash(), run(1).hash());
});

test('a crown lead at time up ends the match at once; the tiebreak state stays clear', () => {
  const b = newBattle();
  b.run(END - 1);
  b.players[0].princess[0].hp = 1;
  (b as unknown as { kill(u: unknown): void }).kill(b.players[0].princess[0]);
  b.step();
  assert.deepEqual(b.result, { winner: 1, reason: 'overtime', tick: END - 1 });
  assert.equal(b.timeUp, false);
});
