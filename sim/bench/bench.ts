// Headless throughput: random-vs-random full matches on one core.
//   node bench/bench.ts [matches]
import { Battle } from '../core/src/index.ts';
import { loadGameData } from '../core/src/node.ts';
import { DECK_A, DECK_B, randomPolicy } from '../core/test/helpers.ts';

const data = loadGameData();
const matches = Number(process.argv[2] ?? 200);
let ticks = 0;
let units = 0;
const results = [0, 0, 0];
const t0 = performance.now();
for (let m = 0; m < matches; m++) {
  const b = new Battle(data, { seed: m + 1, decks: [DECK_A, DECK_B] });
  const rs = { s: m * 7919 + 1 };
  while (!b.ended) {
    randomPolicy(b, rs, 0);
    randomPolicy(b, rs, 1);
    b.step();
    units += b.units.length;
  }
  ticks += b.tick;
  results[b.result!.winner + 1]++;
}
const sec = (performance.now() - t0) / 1000;
const tps = ticks / sec;
console.log(`${matches} matches, ${ticks} ticks in ${sec.toFixed(2)} s`);
console.log(`${Math.round(tps).toLocaleString()} ticks/s = ${(tps / 20).toFixed(0)}x real time per core; ` +
  `avg ${(units / ticks).toFixed(1)} actors/tick; avg match ${(ticks / matches / 20).toFixed(0)} s`);
console.log(`results: draw ${results[0]}, blue ${results[1]}, red ${results[2]}`);
