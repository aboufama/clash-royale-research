// The world after the end, ported from the battle manager (libg 160402020): after the end (0xd3e360: ctx +0x198
// = 1) 0x10ca9a0 keeps running the command manager and the battle tick 0xd33f74 until +0x198 (+50 per tick)
// reaches EndScreenDelay (0xd3581c). Plays fail (0xd77504), attack clocks stay at 0 (0xfc90b0), damage without
// flag 8 is dropped (0xfcb29c), the fallen King's side dies in the wave of 0xd352f8 / 0xd35de4. Also the
// tiebreak's gates: plays fail once time is up (0xd77504 -> 0xd360a8) and only flag-8 damage applies while the
// tiebreak clock runs (0xfcaeec). Decompiles in work/native/decomp_eng3/ and decomp_end/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle, Bot, type BattleConfig, ST_ACTIVE, ST_DEAD, type Unit } from '../src/index.ts';
import { addActive, data, DECK_A, DECK_B, newBattle, randomPolicy } from './helpers.ts';

interface Priv {
  queueDamage(t: Unit, amount: number, towerDamage: number, pct: number): void;
}
const priv = (b: Battle) => b as unknown as Priv;

/** Kill side `team`'s King through the damage queue on the next step (the end tick). */
function killKing(b: Battle, team: number): void {
  const k = b.players[team].king;
  priv(b).queueDamage(k, k.hp + 1, -1, 0);
  b.step();
  assert.equal(b.result?.reason, 'king');
}

/** End by time with side 0 one crown up, on the next step. */
function endByTime(b: Battle): void {
  b.tick = b.regulationTicks - 1;
  b.players[0].crowns = 1;
  b.step();
  assert.equal(b.result?.reason, 'time');
}

test('without postEnd the battle stops at the result; with it 80 more ticks run (EndScreenDelay 4000), then it stops', () => {
  for (const postEnd of [false, true]) {
    const b = newBattle({ postEnd });
    killKing(b, 1);
    const res = { ...b.result! };
    assert.equal(b.endMs, 1);
    assert.deepEqual(b.endCrowns, [3, 0]);
    let n = 0;
    while (!b.stopped && n < 1000) { b.step(); n++; }
    assert.equal(n, postEnd ? 80 : 0);
    assert.equal(b.tick, res.tick + 1 + n);
    assert.equal(b.endMs, postEnd ? 4001 : 1);
    const h = b.hash();
    b.step();
    assert.equal(b.hash(), h, 'stopped: step() changes nothing');
    assert.deepEqual(b.result, res, 'the result never changes');
    assert.ok(b.ended);
  }
});

test('post-end: plays fail without a debit (0xd77504), play() says ended, the Bot does not act', () => {
  const b = newBattle({ postEnd: true });
  b.infiniteElixir = false;
  assert.equal(b.play(0, 0, 9000, 5000), null); // commits 20 ticks later, after the end
  const p = b.players[0];
  const elixir0 = p.elixir;
  const hand0 = [...p.hand];
  killKing(b, 1);
  assert.equal(b.play(0, 1, 9000, 5000), 'ended');
  const bot = new Bot(1, { seed: 3 });
  for (let i = 0; i < 30; i++) {
    assert.equal(bot.act(b), null);
    b.step();
  }
  assert.equal(b.commands.length, 0, 'the command was consumed');
  assert.equal(p.pending, 0);
  assert.deepEqual(p.hand, hand0, 'the card stays in the hand');
  assert.ok(p.elixir > elixir0, 'no debit; elixir keeps regenerating in the post-end world');
  assert.ok(!b.units.some((u) => u.def.name === 'Knight'), 'nothing was cast');
});

test('post-end: attack clocks stay at 0 (0xfc90b0) and towers do not shoot; troops still move', () => {
  const b = newBattle({ postEnd: true, recordEvents: true });
  const t = b.players[1].princess[0];
  const k = addActive(b, 'Knight', 0, t.x, t.y - 1600); // in range of the tower, and the tower of it
  const far = addActive(b, 'Giant', 0, 3000, 9000);
  endByTime(b);
  const hpT = t.hp, hpK = k.hp, y0 = far.y;
  for (let i = 0; i < 80; i++) {
    b.step();
    assert.ok(!b.events.some((e) => e.type === 'hit' || e.type === 'shoot'), `no attack at tick ${b.tick}`);
    assert.equal(k.atkTimer, 0);
  }
  assert.equal(t.hp, hpT);
  assert.equal(k.hp, hpK);
  assert.ok(far.y > y0, 'the Giant walks on');
});

test('post-end: damage without flag 8 is dropped (0xfcb29c), queued kills apply', () => {
  const b = newBattle({ postEnd: true });
  const k = addActive(b, 'Knight', 0, 9000, 8000);
  endByTime(b);
  priv(b).queueDamage(k, 100, -1, 0);
  b.step();
  assert.equal(k.hp, k.maxHp);
  (b as unknown as { queueKill(t: Unit, a: number): void }).queueKill(k, k.hp);
  b.step();
  assert.equal(k.state, ST_DEAD);
});

test("King wave (0xd352f8 -> 0xd35de4): the fallen King's side dies in a circle growing 800 per tick, the winner's units live", () => {
  const b = newBattle({ postEnd: true, recordEvents: true });
  const king = b.players[1].king;
  // buildings stay where they are: loser's Cannons 3000 and 9000 from its King, a winner's Cannon next to it
  const c3 = addActive(b, 'Cannon', 1, king.x, king.y - 3000);
  const c9 = addActive(b, 'Cannon', 1, king.x - 5400, king.y - 7200);
  const own = addActive(b, 'Cannon', 0, king.x, king.y - 2000);
  killKing(b, 1); // end tick E: wave call 1 (r = 800)
  const E = b.result!.tick;
  const died = new Map<number, number>();
  while (!b.stopped) {
    b.step();
    for (const e of b.events) if (e.type === 'death' || e.type === 'tower') died.set(e.id, e.tick);
  }
  // call k (tick E + k - 1) reaches 800·k; the queued kill lands at the next tick's flush
  assert.equal(died.get(c3.id), E + Math.ceil(3000 / 800));
  assert.equal(died.get(c9.id), E + Math.ceil(9000 / 800));
  for (const t of b.players[1].princess) assert.equal(t.state, ST_DEAD, 'Princess towers fall too');
  assert.equal(own.state, ST_ACTIVE);
  assert.ok(b.players[0].princess.every((t) => t.alive));
  assert.deepEqual(b.result, { winner: 0, reason: 'king', tick: E });
});

test('post-end matches: same states up to the result, same result; deterministic', () => {
  const run = (seed: number, cfg: Partial<BattleConfig>): Battle => {
    const b = new Battle(data, { seed, decks: [DECK_A, DECK_B], ...cfg });
    const rs = { s: seed * 7919 + 1 };
    while (!b.ended) {
      randomPolicy(b, rs, 0);
      randomPolicy(b, rs, 1);
      b.step();
    }
    return b;
  };
  for (const seed of [11, 12, 13]) {
    const a = run(seed, {});
    const b = run(seed, { postEnd: true });
    assert.equal(a.hash(), b.hash());
    assert.deepEqual(a.result, b.result);
    while (!b.stopped) b.step();
    const c = run(seed, { postEnd: true });
    while (!c.stopped) c.step();
    assert.equal(b.hash(), c.hash());
    assert.deepEqual(b.result, a.result);
  }
});

test('tiebreak: a play committing once time is up fails (0xd77504 -> 0xd360a8); damage without flag 8 is dropped (0xfcaeec)', () => {
  const b = newBattle();
  b.run(5999);
  assert.equal(b.result, null);
  const p = b.players[0];
  const elixir0 = p.elixir;
  assert.equal(b.play(0, 0, 9000, 5000), null); // submitted at 5999, commits at 6019 during the tiebreak
  b.step(); // 5999: time is up
  assert.ok(b.timeUp);
  const tw = b.players[1].princess[0];
  const hp0 = tw.hp;
  priv(b).queueDamage(tw, 300, -1, 0);
  b.step(); // tiebreak tick 1: the clear runs a world tick and its flush
  assert.equal(tw.hp, hp0, 'tower damage dropped while the tiebreak clock runs');
  for (let i = 0; i < 25; i++) b.step();
  assert.equal(b.commands.length, 0);
  assert.equal(p.pending, 0);
  assert.ok(p.elixir >= elixir0 - 1, 'no debit');
  assert.ok(!b.units.some((u) => u.tower === 0 && u.team === 0), 'nothing cast');
});
