// RL environment (sim/rl): determinism, canonical tiles, masks, cycle tracking, episode ends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle, ELIXIR_ONE } from '../../core/src/index.ts';
import { loadGameData } from '../../core/src/node.ts';
import { DEFAULT_ENV, RlEnv, XRng } from '../env.ts';
import { Encoder, makeVocab, N_TILES, TILES_W } from '../obs.ts';
import { DONE_F, META_F, Worker } from '../worker.ts';

function frames(seed: number, n: number): Uint8Array[] {
  const w = new Worker({ numEnvs: 3, seed });
  const L = w.enc.L;
  const out: Uint8Array[] = [];
  let actions = new Int32Array(0);
  for (let k = 0; k < n; k++) {
    const f = w.step(actions);
    out.push(f);
    const dv = new DataView(f.buffer);
    const nDone = dv.getInt32(0, true), nRec = dv.getInt32(4, true);
    const meta = new Float32Array(f.buffer, 8 + nDone * DONE_F * 4, nRec * META_F);
    const masks = new Uint8Array(f.buffer, 8 + (nDone * DONE_F + nRec * META_F + nRec * L.floats) * 4);
    actions = new Int32Array(nRec * 4);
    for (let r = 0; r < nRec; r++) {
      // first legal card at its first legal tile
      let slot = 0, tile = 0;
      for (let s = 1; s < 5 && !slot; s++) if (masks[r * L.maskBytes + s]) slot = s;
      if (slot) for (let t = 0; t < N_TILES; t++) if (masks[r * L.maskBytes + 5 + (slot - 1) * N_TILES + t]) { tile = t; break; }
      actions.set([meta[r * META_F], meta[r * META_F + 1], slot, tile], r * 4);
    }
  }
  return out;
}

test('the worker is deterministic for a seed and its actions', () => {
  const a = frames(11, 40), b = frames(11, 40);
  for (let i = 0; i < a.length; i++) assert.deepEqual(a[i], b[i], `frame ${i}`);
  const c = frames(12, 40);
  assert.ok(a.some((f, i) => f.length !== c[i].length || f.some((v, j) => v !== c[i][j])));
});

test('canonical tiles: team 1 sees the arena turned 180 degrees', () => {
  assert.deepEqual(Encoder.tileWorld(0, 0), { x: 500, y: 500 });
  assert.deepEqual(Encoder.tileWorld(1, 0), { x: 17500, y: 31500 });
  assert.deepEqual(Encoder.tileWorld(1, 17 * TILES_W + 3), { x: 14500, y: 14500 });
});

test('troop masks cover only the own half; both sides see the same canonical zone', () => {
  const data = loadGameData();
  const enc = new Encoder(makeVocab(data));
  const deck = ['Knight', 'Archer', 'Giant', 'Musketeer', 'MiniPekka', 'SpearGoblins', 'Fireball', 'Arrows'];
  const b = new Battle(data, { seed: 3, decks: [deck, deck], noShuffle: true });
  const L = enc.L;
  const out = new Float32Array(L.floats);
  const m0 = new Uint8Array(L.maskBytes), m1 = new Uint8Array(L.maskBytes);
  const cyc: [{ commits: number }, { commits: number }] = [{ commits: 0 }, { commits: 0 }];
  enc.encode(b, 0, cyc, out, 0, m0, 0);
  enc.encode(b, 1, cyc, out, 0, m1, 0);
  // Knight (slot 0) at the start: 5 elixir, playable
  assert.equal(m0[1], 1);
  const knight0 = m0.subarray(5, 5 + N_TILES), knight1 = m1.subarray(5, 5 + N_TILES);
  for (let t = 16 * TILES_W; t < N_TILES; t++) assert.equal(knight0[t], 0, `tile ${t} is the enemy half`);
  assert.ok(knight0.reduce((s, v) => s + v, 0) > 150);
  // the arena is symmetric under the half turn up to the deploy snap's one-unit nudge
  let diff = 0;
  for (let t = 0; t < N_TILES; t++) diff += knight0[t] !== knight1[t] ? 1 : 0;
  assert.equal(diff, 0);
  // the hand's 4th card (Musketeer, 4 elixir) is playable, nothing above 5 is
  for (let s = 0; s < 4; s++) assert.equal(m0[1 + s], b.players[0].deck[b.players[0].hand[s]].cost <= 5 ? 1 : 0);
});

test('commits are counted from the queue and the known tail grows with them', () => {
  const data = loadGameData();
  const env = new RlEnv(data, { ...DEFAULT_ENV, deckSwap: false }, new XRng(5));
  env.reset();
  const p = env.b.players[0];
  p.elixir = 10 * ELIXIR_ONE;
  let slot = -1;
  for (let s = 0; s < 4; s++) if (Encoder.playable(env.b, 0, s)) { slot = s; break; }
  assert.ok(slot >= 0);
  env.waiting[0] = true;
  env.act(0, slot + 1, 5 * TILES_W + 4);
  for (let i = 0; i < 25; i++) {
    env.b.step();
    (env as unknown as { trackCycle(): void }).trackCycle();
  }
  assert.equal(env.cycle[0].commits, 1);
  assert.equal(env.cycle[1].commits, 0);
});

test('a py-vs-py episode ends with opposite outcomes', () => {
  const data = loadGameData();
  const env = new RlEnv(data, { ...DEFAULT_ENV, maxTicks: 8000 }, new XRng(9));
  env.reset();
  let ends = null;
  let guard = 0;
  while (ends === null && guard++ < 10000) {
    ends = env.advance();
    if (ends) break;
    // both sides play their first legal card at the bridge
    for (let t = 0; t < 2; t++) if (env.decides(t)) {
      for (let s = 0; s < 4; s++) if (Encoder.playable(env.b, t, s)) { env.waiting[t] = true; env.act(t, s + 1, 14 * TILES_W + 3); break; }
    }
  }
  assert.ok(ends);
  assert.equal(ends!.length, 2);
  assert.equal(ends![0].outcome + ends![1].outcome, 0);
  assert.ok(env.b.result !== null);
});
