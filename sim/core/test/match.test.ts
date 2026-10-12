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
    // a tie at the end of overtime goes through the tiebreak (0x10ca9a0), which ends it in at most ~10 s
    assert.ok(b.result!.tick < 6000 || (b.result!.reason === 'tiebreak' && b.result!.tick < 6200));
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
  // the card stays in its slot (and cannot be played again) until its play commits
  assert.deepEqual(p.hand, hand0);
  assert.equal(b.play(0, 0, 9000, 5000), 'pending');
  b.run(21);
  // tick 20, commit at age 20: the card leaves (0xfa5810) and the idle hand timer refills the slot at once (0xfa5b4c)
  assert.equal(p.hand[0], next);
  assert.equal(p.queue[p.queue.length - 1], hand0[0]);
  assert.equal(p.cycleTimer, 1000);
});

test('hand refills wait for the hand timer (NextSpellCooldownMS, 0xfa5b4c)', () => {
  const b = newBattle();
  b.infiniteElixir = true;
  const p = b.players[0];
  const [q0, q1] = p.queue;
  assert.equal(b.play(0, 0, 9000, 5000), null);
  b.step();
  assert.equal(b.play(0, 1, 9000, 5000), null);
  b.run(20); // ticks 1..20; tick 20: first commit, slot 0 refilled at once, timer 1000
  assert.equal(p.hand[0], q0);
  b.step(); // tick 21: second commit, the timer is still running
  assert.equal(p.hand[1], -1);
  assert.equal(b.play(0, 1, 9000, 5000), 'empty-slot');
  b.run(18); // ticks 22..39: timer 900 .. 50
  assert.equal(p.hand[1], -1);
  assert.equal(p.cycleTimer, 50);
  b.step(); // tick 40: 50 - 50 < 1 -> refill
  assert.equal(p.hand[1], q1);
  assert.equal(p.cycleTimer, 1000);
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
