// Worker throughput with uniformly random legal actions (no network): frames, decisions, ticks per
// second on one core. `node rl/bench.ts [envs] [seconds]`
import { DONE_F, META_F, Worker } from './worker.ts';

const envs = Number(process.argv[2] ?? 32);
const secs = Number(process.argv[3] ?? 10);
const w = new Worker({ numEnvs: envs, seed: 7 });
const L = w.enc.L;
let rng = 12345;
const rand = (n: number) => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n; };
let actions = new Int32Array(0);
let frames = 0, recs = 0, dones = 0, wins = 0;
const t0 = performance.now();
const ticks0 = w.envs.reduce((s, e) => s, 0);
let ticks = ticks0;
while (performance.now() - t0 < secs * 1000) {
  const out = w.step(actions);
  const dv = new DataView(out.buffer);
  const nDone = dv.getInt32(0, true), nRec = dv.getInt32(4, true);
  const f = new Float32Array(out.buffer, 8, nDone * DONE_F + nRec * META_F);
  for (let i = 0; i < nDone; i++) { ticks += f[i * DONE_F + 7] / 2; if (f[i * DONE_F + 3] > 0) wins++; }
  const masks = new Uint8Array(out.buffer, 8 + (nDone * DONE_F + nRec * META_F + nRec * L.floats) * 4);
  actions = new Int32Array(nRec * 4);
  for (let r = 0; r < nRec; r++) {
    const m = r * L.maskBytes;
    const meta = nDone * DONE_F + r * META_F;
    const legal = [0];
    for (let s = 1; s < 5; s++) if (masks[m + s]) legal.push(s);
    // wait most of the time, like a policy that saves elixir
    const slot = rand(4) === 0 ? legal[rand(legal.length)] : 0;
    let tile = 0;
    if (slot > 0) {
      const tiles: number[] = [];
      for (let t = 0; t < 576; t++) if (masks[m + 5 + (slot - 1) * 576 + t]) tiles.push(t);
      tile = tiles[rand(tiles.length)];
    }
    actions.set([f[meta], f[meta + 1], slot, tile], r * 4);
  }
  frames++; recs += nRec; dones += nDone;
}
const s = (performance.now() - t0) / 1000;
console.log(`${envs} envs, ${s.toFixed(1)} s: ${(frames / s).toFixed(0)} frames/s, ${(recs / s).toFixed(0)} decisions/s, ` +
  `${(dones / 2 / s).toFixed(1)} episodes/s (~${(ticks / s).toFixed(0)} ticks/s), record ${L.floats} floats + ${L.maskBytes} mask bytes`);
console.log(`episodes ${dones / 2}, wins+losses ${wins}`);
