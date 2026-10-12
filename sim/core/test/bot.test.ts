// Scripted bot (sim/core/src/bot.ts): roles from data, legality, determinism, strength smoke tests.
// The bench (node bench/bot.ts) runs the large evaluation; these stay to a handful of matches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle, Bot, cardRole, supportedCards } from '../src/index.ts';
import { data, DECK_A, DECK_B, randomPolicy } from './helpers.ts';

const defs = new Battle(data, { seed: 1, decks: [DECK_A, DECK_B] }).defs;
const role = (name: string) => cardRole(defs.card(name, 11));

/** 8 distinct supported cards from a seeded LCG (the bench uses the same generator). */
function randomDeck(seed: number): string[] {
  const left = supportedCards(defs);
  let s = (seed * 2654435761 + 12345) >>> 0;
  const out: string[] = [];
  while (out.length < 8) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(left.splice(s % left.length, 1)[0]);
  }
  return out;
}

type Policy = 'bot' | 'random' | 'passive';

function match(seed: number, decks: [string[], string[]], policies: [Policy, Policy], botSeed = seed): { b: Battle; bots: (Bot | null)[] } {
  const b = new Battle(data, { seed, decks });
  const bots = policies.map((p, t) => (p === 'bot' ? new Bot(t, { seed: botSeed * 13 + t }) : null));
  const rs = { s: seed * 7919 + 1 };
  while (!b.ended) {
    for (let t = 0; t < 2; t++) {
      if (bots[t]) bots[t]!.act(b);
      else if (policies[t] === 'random') randomPolicy(b, rs, t);
    }
    b.step();
  }
  return { b, bots };
}

test('card roles come from the data, not from names', () => {
  const giant = role('Giant');
  assert.ok(giant.win && giant.tank && giant.buildingsOnly && !giant.air);
  assert.ok(role('HogRider').win && role('HogRider').speed >= 90);
  const minions = role('Minions');
  assert.ok(minions.air && minions.antiAir && minions.swarm && !minions.win);
  assert.ok(role('Valkyrie').splashy && !role('Valkyrie').antiAir);
  assert.ok(role('Musketeer').ranged && role('Musketeer').antiAir);
  assert.ok(role('Cannon').building && !role('Cannon').siege);
  assert.ok(role('Xbow').siege && role('Xbow').win);
  assert.ok(role('Elixir Collector').collector);
  assert.ok(role('Miner').enemySide && role('Miner').win);
  assert.ok(role('SkeletonArmy').swarm && role('SkeletonArmy').count === 15);
  const barrel = role('GoblinBarrel');
  assert.equal(barrel.spell?.kind, 'spawn');
  assert.ok(barrel.win && barrel.count === 3);
  const fb = role('Fireball').spell!;
  assert.equal(fb.kind, 'damage');
  assert.equal(fb.radius, 2500);
  assert.ok(fb.towerDamage > 0 && fb.towerDamage < fb.damage && fb.hitsAir && fb.hitsGround);
  const arrows = role('Arrows').spell!;
  assert.equal(arrows.radius, 3500);
  assert.equal(arrows.damage, defs.card('Arrows', 11).spellProjectile!.damage * 3);
  const log = role('Log').spell!;
  assert.equal(log.kind, 'roll');
  assert.ok(log.rollRange >= 10000 && !log.hitsAir);
  assert.ok(role('Zap').spell!.stun > 0);
  assert.equal(role('Freeze').spell!.kind, 'freeze');
  assert.equal(role('Rage').spell!.kind, 'rage');
  assert.equal(role('Lightning').spell!.strikes, 3);
  assert.ok(role('Poison').spell!.dot);
  // every supported card gets a usable role
  for (const name of supportedCards(defs)) {
    const r = role(name);
    if (r.type === 'spell') assert.ok(r.spell, name);
    else assert.ok(r.hp > 0 && r.count > 0, name);
  }
});

test('bot vs bot replays exactly from (seed, bot seeds) and finishes', () => {
  const decks: [string[], string[]] = [randomDeck(11), randomDeck(12)];
  const a = match(5, decks, ['bot', 'bot']);
  const c = match(5, decks, ['bot', 'bot']);
  assert.ok(a.b.result, 'the match ends');
  assert.equal(a.b.hash(), c.b.hash());
  assert.equal(a.b.tick, c.b.tick);
  assert.deepEqual(a.b.result, c.b.result);
  assert.ok(a.bots.every((x) => x!.stats.plays > 10));
  const d = match(5, decks, ['bot', 'bot'], 99);
  assert.notEqual(a.b.hash(), d.b.hash(), 'the bot seed changes tie-breaks and jitter');
});

test('every bot play is legal (never rejected)', () => {
  for (const seed of [21, 22, 23]) {
    const decks: [string[], string[]] = [randomDeck(seed), randomDeck(seed + 100)];
    const { bots } = match(seed, decks, ['bot', 'random']);
    assert.equal(bots[0]!.stats.rejected, 0, `seed ${seed}`);
  }
});

test('the bot three-crowns a passive opponent in regulation', () => {
  for (const seed of [31, 32]) {
    const { b } = match(seed, [randomDeck(seed), randomDeck(seed + 1)], ['passive', 'bot']);
    assert.equal(b.result!.winner, 1);
    assert.equal(b.players[1].crowns, 3);
    assert.ok(b.result!.tick < b.regulationTicks, `seed ${seed} ended at ${b.result!.tick}`);
  }
});

test('the bot beats the random policy (same random deck on both sides, either side)', () => {
  // mirror decks keep deck match-ups out of this small sample; the bench covers mixed decks
  let wins = 0;
  let crownsFor = 0;
  let crownsAgainst = 0;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const botTeam = i & 1;
    const d0 = randomDeck(40 + i);
    const decks: [string[], string[]] = [d0, d0];
    const policies: [Policy, Policy] = botTeam === 0 ? ['bot', 'random'] : ['random', 'bot'];
    const { b } = match(40 + i, decks, policies);
    if (b.result!.winner === botTeam) wins++;
    crownsFor += b.players[botTeam].crowns;
    crownsAgainst += b.players[1 - botTeam].crowns;
  }
  assert.ok(wins >= 6, `won ${wins}/${n}`);
  assert.ok(crownsFor >= 2 * crownsAgainst, `crowns ${crownsFor}-${crownsAgainst}`);
});

test('the bot defends a lone Hog Rider and a Minion Horde without losing much tower', () => {
  const deck = ['Cannon', 'Knight', 'Musketeer', 'Fireball', 'Arrows', 'MiniPekka', 'Valkyrie', 'Skeletons'];
  for (const threat of ['HogRider', 'MinionHorde']) {
    for (const team of [0, 1]) {
      const b = new Battle(data, { seed: 3, decks: [deck, deck], noShuffle: true });
      const bot = new Bot(team, { seed: 9 });
      b.players[team].elixir = 70000;
      b.spawn(1 - team, threat, 3500, team === 0 ? 17500 : 14500);
      for (let i = 0; i < 600; i++) {
        bot.act(b);
        b.step();
      }
      const t = b.players[team].princess[0];
      assert.ok(t.maxHp - t.hp <= 700, `${threat} vs team ${team}: tower lost ${t.maxHp - t.hp}`);
      assert.ok(bot.stats.plays >= 1);
    }
  }
});

test('levels: clamped to 1..3, all play, and the bot stays cheap per tick', () => {
  assert.equal(new Bot(0, { level: 0 }).level, 1);
  assert.equal(new Bot(0, { level: 7 }).level, 3);
  assert.equal(new Bot(0).level, 3);
  const decks: [string[], string[]] = [randomDeck(61), randomDeck(62)];
  const b = new Battle(data, { seed: 61, decks });
  const bots = [new Bot(0, { seed: 1, level: 1 }), new Bot(1, { seed: 2, level: 3 })];
  let ms = 0;
  let calls = 0;
  while (!b.ended) {
    for (const bot of bots) {
      const t0 = performance.now();
      bot.act(b);
      ms += performance.now() - t0;
      calls++;
    }
    b.step();
  }
  assert.ok(bots.every((x) => x.stats.plays > 5 && x.stats.rejected === 0));
  const us = (1000 * ms) / calls;
  assert.ok(us < 300, `${us.toFixed(1)} µs per call`);
});
