// Scripted-bot evaluation: many seeded matches with random supported decks.
//   node bench/bot.ts [matches=200] [level=3] [section]
// Sections: random (bot vs randomPolicy, mixed decks), mirror (bot vs randomPolicy, same deck),
// passive, bots (bot vs bot, same deck), levels (level ladder), determinism. Default: all.
// Reports win/draw/loss, 3-crown rate, average crowns, elixir leaked, plays per match, and the
// bot's time per call (mean and worst).
import { Battle, Bot, supportedCards, type BattleResult } from '../core/src/index.ts';
import { loadGameData } from '../core/src/node.ts';
import { randomPolicy } from '../core/test/helpers.ts';

const data = loadGameData();
const matches = Number(process.argv[2] ?? 200);
const level = Number(process.argv[3] ?? 3);
const only = process.argv[4];
const pool = supportedCards(new Battle(data, { seed: 1, decks: [Array(8).fill('Knight'), Array(8).fill('Knight')] }).defs);

/** 8 distinct supported cards from a seeded LCG (same generator as core/test/bot.test.ts). */
function randomDeck(seed: number): string[] {
  let s = (seed * 2654435761 + 12345) >>> 0;
  const left = [...pool];
  const out: string[] = [];
  while (out.length < 8) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(left.splice(s % left.length, 1)[0]);
  }
  return out;
}

type Side = 'bot' | 'random' | 'passive';

interface Run {
  result: BattleResult;
  crowns: [number, number];
  leaked: [number, number];
  plays: [number, number];
  ms: number;
  worst: number;
  calls: number;
  hash: string;
}

function run(seed: number, decks: [string[], string[]], sides: [Side, Side], levels: [number, number] = [level, level]): Run {
  const b = new Battle(data, { seed, decks });
  const bots = sides.map((s, t) => (s === 'bot' ? new Bot(t, { seed: seed * 31 + 7 + t, level: levels[t] }) : null));
  const rs = { s: seed * 7919 + 1 };
  const leaked: [number, number] = [0, 0];
  let ms = 0;
  let worst = 0;
  let calls = 0;
  while (!b.ended) {
    for (let t = 0; t < 2; t++) {
      const bot = bots[t];
      if (bot) {
        const t0 = performance.now();
        bot.act(b);
        const dt = performance.now() - t0;
        ms += dt;
        if (dt > worst) worst = dt;
        calls++;
      } else if (sides[t] === 'random') randomPolicy(b, rs, t);
    }
    const ept = b.elixirPerTick();
    for (let t = 0; t < 2; t++) if (b.players[t].elixir >= b.maxElixir) leaked[t] += ept / 10000;
    b.step();
  }
  return {
    result: b.result!, crowns: [b.players[0].crowns, b.players[1].crowns], leaked,
    plays: [bots[0]?.stats.plays ?? 0, bots[1]?.stats.plays ?? 0], ms, worst, calls, hash: b.hash(),
  };
}

interface Tally { n: number; win: number; draw: number; three: number; cf: number; ca: number; leak: number; plays: number; ms: number; worst: number; calls: number; secs: number }

function tally(): Tally {
  return { n: 0, win: 0, draw: 0, three: 0, cf: 0, ca: 0, leak: 0, plays: 0, ms: 0, worst: 0, calls: 0, secs: 0 };
}

function add(t: Tally, r: Run, team: number): void {
  t.n++;
  if (r.result.winner === team) t.win++;
  else if (r.result.winner === -1) t.draw++;
  if (r.crowns[team] === 3) t.three++;
  t.cf += r.crowns[team];
  t.ca += r.crowns[1 - team];
  t.leak += r.leaked[team];
  t.plays += r.plays[team];
  t.ms += r.ms;
  t.calls += r.calls;
  if (r.worst > t.worst) t.worst = r.worst;
  t.secs += r.result.tick / 20;
}

function print(label: string, t: Tally, wall: number): void {
  const pc = (x: number) => `${((100 * x) / t.n).toFixed(1)}%`;
  console.log(`${label}: ${t.n} matches in ${wall.toFixed(1)} s`);
  console.log(`  win ${pc(t.win)}  draw ${pc(t.draw)}  loss ${pc(t.n - t.win - t.draw)}  3-crown ${pc(t.three)}`);
  console.log(`  crowns ${(t.cf / t.n).toFixed(2)} for, ${(t.ca / t.n).toFixed(2)} against; elixir leaked ${(t.leak / t.n).toFixed(2)} per match; ` +
    `plays ${(t.plays / t.n).toFixed(1)} per match; avg match ${(t.secs / t.n).toFixed(0)} s`);
  if (t.calls) console.log(`  bot time ${((1000 * t.ms) / t.calls).toFixed(1)} µs per call (mean), worst call ${(1000 * t.worst).toFixed(0)} µs`);
}

function section(name: string, label: string, body: (m: number, t: Tally) => void): void {
  if (only && only !== name) return;
  const t = tally();
  const t0 = performance.now();
  for (let m = 0; m < matches; m++) body(m, t);
  print(label, t, (performance.now() - t0) / 1000);
}

// bot vs random policy, mixed decks, the bot alternating sides
section('random', `bot (level ${level}) vs randomPolicy, mixed random decks`, (m, t) => {
  const team = m & 1;
  const mine = randomDeck(2000 + 2 * m);
  const theirs = randomDeck(2001 + 2 * m);
  const r = run(1000 + m, team === 0 ? [mine, theirs] : [theirs, mine], team === 0 ? ['bot', 'random'] : ['random', 'bot']);
  add(t, r, team);
});

// same, with the same deck on both sides (no deck match-up)
section('mirror', `bot (level ${level}) vs randomPolicy, same random deck`, (m, t) => {
  const team = m & 1;
  const d = randomDeck(2000 + 2 * m);
  add(t, run(1000 + m, [d, d], team === 0 ? ['bot', 'random'] : ['random', 'bot']), team);
});

section('passive', `bot (level ${level}) vs passive (no plays)`, (m, t) => {
  const team = m & 1;
  const r = run(1000 + m, [randomDeck(3000 + 2 * m), randomDeck(3001 + 2 * m)], team === 0 ? ['bot', 'passive'] : ['passive', 'bot']);
  add(t, r, team);
});

section('bots', `bot vs bot (level ${level}, same deck), team-0 view`, (m, t) => {
  const d = randomDeck(4000 + m);
  add(t, run(1000 + m, [d, d], ['bot', 'bot']), 0);
});

if (!only || only === 'levels') {
  for (const [hi, lo] of [[3, 1], [3, 2], [2, 1]]) {
    const t = tally();
    const t0 = performance.now();
    for (let m = 0; m < matches; m++) {
      const hiTeam = m & 1;
      const d0 = randomDeck(5000 + 2 * m);
      const d1 = randomDeck(5001 + 2 * m);
      const decks: [string[], string[]] = (m >> 1) & 1 ? [d0, d1] : [d1, d0];
      add(t, run(1000 + m, decks, ['bot', 'bot'], hiTeam === 0 ? [hi, lo] : [lo, hi]), hiTeam);
    }
    print(`level ${hi} vs level ${lo} (mixed decks, sides swapped)`, t, (performance.now() - t0) / 1000);
  }
}

if (!only || only === 'determinism') {
  const n = Math.min(20, matches);
  let ok = 0;
  for (let m = 0; m < n; m++) {
    const decks: [string[], string[]] = [randomDeck(6000 + m), randomDeck(7000 + m)];
    const a = run(77 + m, decks, ['bot', 'bot']);
    const c = run(77 + m, decks, ['bot', 'bot']);
    if (a.hash === c.hash && a.result.tick === c.result.tick && a.result.winner === c.result.winner) ok++;
  }
  console.log(`determinism: ${ok}/${n} bot-vs-bot replays identical (state hash, result, tick)`);
}
