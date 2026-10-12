// RL environment worker (not native: training tooling): N battles stepped in one Node process,
// driven by the Python trainer (train/crl/envpool.py) over stdin / stdout.
//
//   node sim/rl/worker.ts            # then: one JSON config line on stdin, one JSON spec line back
//   node sim/rl/worker.ts --spec     # print the spec (layout, vocabulary) and exit
//
// After the handshake both sides exchange length-prefixed little-endian frames ([u32 bytes][payload]):
//   trainer -> worker  Int32 [type, n, n x (env, team, slot, tile)]   type 1 = step, 2 = close
//   worker -> trainer  Int32 [nDone, nRec]
//                      Float32 nDone x DONE_F  [env, team, episode, outcome, term, shape, ticks, epTicks]
//                      Float32 nRec x META_F   [env, team, episode, start, term, shape, ticks, opp]
//                      Float32 nRec x floats   observations (obs.ts layout)
//                      Uint8   nRec x maskBytes legal-action masks
// Each step frame carries the actions for the previous frame's records; every env then runs to its
// next decision point (resetting finished episodes), so each frame has at least one record per env.
// `term` / `shape` / `ticks` on a record close that team's previous transition (0 on episode start).

import { readSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadGameData } from '../core/src/node.ts';
import { DEFAULT_ENV, type EnvConfig, RlEnv, XRng } from './env.ts';
import {
  Encoder, F_AOE, F_CARD, F_GLOBAL, F_PEND, F_PRIV_CARD, F_PRIV_GLOBAL, F_PROJ, F_UNIT, ID_AOE, ID_CARD, ID_PEND, ID_PROJ, ID_UNIT,
  makeVocab, MAX_AOE, MAX_PEND, MAX_PROJ, MAX_UNITS, N_CARDS, N_SLOTS, N_TILES, TILES_H, TILES_W,
} from './obs.ts';

export const DONE_F = 8;
export const META_F = 8;
const OPP_CODE = { py: 0, bot: 1, random: 2, none: 3 } as const;

export interface WorkerConfig extends Partial<EnvConfig> {
  numEnvs: number;
  seed: number;
}

export function spec(enc: Encoder, cfg: EnvConfig): Record<string, unknown> {
  return {
    version: 1,
    layout: enc.L,
    sizes: {
      TILES_W, TILES_H, N_TILES, N_SLOTS, MAX_UNITS, MAX_PROJ, MAX_AOE, N_CARDS, MAX_PEND,
      F_GLOBAL, F_UNIT, ID_UNIT, F_PROJ, ID_PROJ, F_AOE, ID_AOE, F_CARD, ID_CARD, F_PEND, ID_PEND, F_PRIV_CARD, F_PRIV_GLOBAL,
      DONE_F, META_F,
    },
    vocab: enc.vocab,
    env: cfg,
  };
}

/** The worker's state machine, independent of the transport (tests drive it directly). */
export class Worker {
  readonly enc: Encoder;
  readonly envs: RlEnv[];
  readonly cfg: EnvConfig;
  private obs = new Float32Array(0);
  private masks = new Uint8Array(0);
  private first = true;

  constructor(wc: WorkerConfig) {
    const data = loadGameData();
    this.cfg = { ...DEFAULT_ENV, ...wc };
    this.enc = new Encoder(makeVocab(data));
    const root = new XRng((wc.seed >>> 0) || 1);
    this.envs = [];
    for (let i = 0; i < wc.numEnvs; i++) this.envs.push(new RlEnv(data, this.cfg, new XRng((root.next() * 4294967296) >>> 0 || 1)));
  }

  /** One frame: apply `actions` (env, team, slot, tile quads), run every env to its next decision. */
  step(actions: Int32Array): Uint8Array {
    for (let i = 0; i + 3 < actions.length; i += 4) {
      const e = this.envs[actions[i]];
      if (e && e.waiting[actions[i + 1]]) e.act(actions[i + 1], actions[i + 2], actions[i + 3]);
    }
    const dones: number[] = [];
    const recs: { e: number; t: number; start: boolean; term: number; shape: number; ticks: number }[] = [];
    for (let i = 0; i < this.envs.length; i++) {
      const env = this.envs[i];
      if (this.first) env.reset();
      // a py team that was asked and got no action waits (slot 0)
      env.waiting[0] = env.waiting[1] = false;
      for (;;) {
        const ends = env.advance();
        if (ends === null) break;
        for (const end of ends) {
          dones.push(i, end.team, env.episode, end.outcome, end.acc.term, end.acc.shape, end.acc.ticks, env.b.tick);
        }
        env.reset();
      }
      for (let t = 0; t < 2; t++) {
        if (!env.decides(t)) continue;
        const a = env.acc[t];
        recs.push({ e: i, t, start: !env.started[t], term: a.term, shape: a.shape, ticks: a.ticks });
        a.reset();
        env.started[t] = true;
        env.waiting[t] = true;
      }
    }
    this.first = false;
    const L = this.enc.L;
    const nRec = recs.length;
    const nDone = dones.length / DONE_F;
    if (this.obs.length < nRec * L.floats) this.obs = new Float32Array(nRec * L.floats * 2);
    if (this.masks.length < nRec * L.maskBytes) this.masks = new Uint8Array(nRec * L.maskBytes * 2);
    const meta = new Float32Array(nRec * META_F);
    for (let r = 0; r < nRec; r++) {
      const { e, t, start, term, shape, ticks } = recs[r];
      const env = this.envs[e];
      meta.set([e, t, env.episode, start ? 1 : 0, term, shape, ticks, OPP_CODE[env.ctrl[1 - t]]], r * META_F);
      this.enc.encode(env.b, t, env.cycle, this.obs, r * L.floats, this.masks, r * L.maskBytes);
    }
    const head = 8;
    const bytes = head + (nDone * DONE_F + nRec * META_F + nRec * L.floats) * 4 + nRec * L.maskBytes;
    const out = new Uint8Array(bytes);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, nDone, true);
    dv.setInt32(4, nRec, true);
    let o = head;
    const f32 = (src: ArrayLike<number>, n: number) => {
      new Float32Array(out.buffer, o, n).set(src instanceof Float32Array ? src.subarray(0, n) : Float32Array.from(src));
      o += n * 4;
    };
    f32(dones, dones.length);
    f32(meta, meta.length);
    f32(this.obs, nRec * L.floats);
    out.set(this.masks.subarray(0, nRec * L.maskBytes), o);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// stdin / stdout transport

function readExact(n: number): Buffer {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    let k = 0;
    try {
      k = readSync(0, buf, got, n - got, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); continue; }
      throw e;
    }
    if (k === 0) process.exit(0); // the trainer closed the pipe
    got += k;
  }
  return buf;
}

function readLine(): string {
  const parts: number[] = [];
  for (;;) {
    const c = readExact(1)[0];
    if (c === 10) break;
    parts.push(c);
  }
  return Buffer.from(parts).toString('utf8');
}

function writeAll(b: Uint8Array): void {
  let o = 0;
  while (o < b.length) {
    try {
      o += writeSync(1, b, o, b.length - o);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); continue; }
      if (code === 'EPIPE') process.exit(0); // the trainer is gone
      throw e;
    }
  }
}

function main(): void {
  if (process.argv.includes('--spec')) {
    const data = loadGameData();
    process.stdout.write(JSON.stringify(spec(new Encoder(makeVocab(data)), DEFAULT_ENV)) + '\n');
    return;
  }
  const wc = JSON.parse(readLine()) as WorkerConfig;
  const w = new Worker(wc);
  writeAll(Buffer.from(JSON.stringify(spec(w.enc, w.cfg)) + '\n'));
  for (;;) {
    const len = readExact(4).readUInt32LE(0);
    const payload = readExact(len);
    const ints = new Int32Array(payload.buffer, payload.byteOffset, len >> 2);
    if (ints[0] === 2) return;
    const n = ints[1];
    const frame = w.step(ints.subarray(2, 2 + 4 * n));
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(frame.length, 0);
    writeAll(hdr);
    writeAll(frame);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
