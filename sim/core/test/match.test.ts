// Whole-match behaviour: determinism, legality, end conditions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle, M1_CARDS } from '../src/index.ts';
import { data, DECK_A, DECK_B, newBattle, randomPolicy } from './helpers.ts';

function selfPlay(seed: number, maxTicks = 6000): Battle {
  const b = new Battle(data, { seed, decks: [DECK_A, DECK_B] });
  const rs = { s: seed * 7919 + 1 };
  while (!b.ended && b.tick < maxTicks) {
    randomPolicy(b, rs, 0);
    randomPolicy(b, rs, 1);
    b.step();
  }
  return b;
}

test('replays are exact: same seed and actions give the same state hash', () => {
  for (const seed of [1, 2, 3]) {
    const a = selfPlay(seed);
    const b = selfPlay(seed);
    assert.equal(a.hash(), b.hash());
    assert.equal(a.tick, b.tick);
  }
  assert.notEqual(selfPlay(1).hash(), selfPlay(2).hash());
});

test('random self-play matches end with a result by the overtime limit', () => {
  for (const seed of [11, 12, 13, 14]) {
    const b = selfPlay(seed, 7000);
    assert.ok(b.result, `seed ${seed} ended`);
    assert.ok(b.result!.tick < 6000);
    assert.ok(b.players.every((p) => p.elixir >= 0 && p.elixir <= 100000));
  }
});

test('no play rejected for elixir when affordable; hand cycles correctly', () => {
  const b = newBattle();
  const p = b.players[0];
  const hand0 = [...p.hand];
  const next = p.queue[0];
  const err = b.play(0, 0, 9000, 5000);
  assert.equal(err, null);
  assert.equal(p.hand[0], next);
  assert.equal(p.queue[p.queue.length - 1], hand0[0]);
  assert.equal(b.play(0, 0, 9000, 5000), 'slot-cooldown');
});

test('every M1 card is supported and can be deployed by both sides', () => {
  for (const name of M1_CARDS) {
    const b = newBattle();
    const card = b.defs.card(name, 11);
    assert.deepEqual(card.unsupported, [], name);
    assert.equal(b.spawn(0, name, 9000, card.type === 'spell' ? 25000 : 10000), null, name);
    assert.equal(b.spawn(1, name, 9000, card.type === 'spell' ? 7000 : 22000), null, name);
    b.run(200);
  }
});

test('a Giant alone walks over the bridge and damages the princess tower', () => {
  const b = newBattle();
  b.spawn(0, 'Giant', 3500, 14500);
  b.run(800);
  const t = b.players[1].princess[0];
  assert.ok(t.hp < t.maxHp, `tower hp ${t.hp}`);
});
