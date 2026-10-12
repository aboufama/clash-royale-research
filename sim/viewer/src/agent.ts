// The trained RL agent as a player in the viewer (not a client feature): the actor exported to ONNX by
// train/crl/export.py, run with onnxruntime-web (WASM, loaded from the jsDelivr CDN on first use).
//
// It sees exactly what it saw in training: the same observation encoder (sim/rl/obs.ts) on the same
// engine, its side's view turned 180 degrees for red, and the same decision rule (a 5-tick grid, only
// while a card is playable). The network's slot and tile logits are masked to legal actions and sampled
// as in training. Inference is asynchronous, so an action lands a few ticks after the observation it was
// chosen from (like a human's reaction time); it is dropped if it became illegal meanwhile.

import type { Battle, GameData } from '../../core/src/index.ts';
import { CycleTracker, Encoder, makeVocab, N_SLOTS, N_TILES } from '../../rl/obs.ts';
import { versionedUrl } from './sc/asset_fetch.ts';

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const DECISION_TICKS = 5;

/** The bits of onnxruntime-web used here. */
interface OrtTensor { data: Float32Array }
interface OrtSession { run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>> }
interface Ort {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(url: string, opts?: Record<string, unknown>): Promise<OrtSession> };
}

let ortPromise: Promise<Ort> | null = null;
function loadOrt(): Promise<Ort> {
  if (!ortPromise) {
    const url = `${ORT_BASE}ort.wasm.min.mjs`;
    ortPromise = (import(/* @vite-ignore */ url) as Promise<Ort & { default?: Ort }>).then((m) => {
      const ort = (m.default ?? m) as Ort;
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1; // Pages sends no cross-origin isolation headers: no wasm threads
      return ort;
    });
  }
  return ortPromise;
}

const sessions = new Map<string, Promise<OrtSession>>();

/** Sample an index from logits restricted to `ok` (softmax at temperature `temp`; 0 = argmax). */
export function sampleMasked(logits: ArrayLike<number>, ok: (i: number) => boolean, temp: number, rnd: () => number): number {
  let best = -1;
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (ok(i) && logits[i] > max) { max = logits[i]; best = i; }
  if (best < 0 || temp <= 0) return best;
  let sum = 0;
  const p = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) if (ok(i)) { p[i] = Math.exp((logits[i] - max) / temp); sum += p[i]; }
  let r = rnd() * sum;
  for (let i = 0; i < logits.length; i++) {
    if (!ok(i)) continue;
    r -= p[i];
    if (r <= 0) return i;
  }
  return best;
}

export class AgentPlayer {
  readonly team: number;
  readonly enc: Encoder;
  readonly cycle = new CycleTracker();
  private session: OrtSession | null = null;
  private ort: Ort | null = null;
  private busy = false;
  private ready: { slot: number; tile: number } | null = null;
  private obs: Float32Array;
  private mask: Uint8Array;
  private rngState = 0x9e3779b9;
  temperature = 1;
  error: string | null = null;

  constructor(team: number, data: GameData) {
    this.team = team;
    this.enc = new Encoder(makeVocab(data));
    this.obs = new Float32Array(this.enc.L.floats);
    this.mask = new Uint8Array(this.enc.L.maskBytes);
  }

  get loaded(): boolean { return this.session !== null; }

  async load(modelUrl: string): Promise<void> {
    try {
      this.ort = await loadOrt();
      let s = sessions.get(modelUrl);
      if (!s) {
        s = this.ort.InferenceSession.create(versionedUrl(modelUrl), { executionProviders: ['wasm'] });
        sessions.set(modelUrl, s);
      }
      this.session = await s;
    } catch (e) {
      this.error = String(e);
      console.warn('agent model', e);
    }
  }

  /** A new battle: restart the cycle tracking. */
  reset(b: Battle): void {
    this.cycle.reset(b);
    this.ready = null;
  }

  /** After every Battle.step. */
  observe(b: Battle): void {
    this.cycle.update(b);
  }

  private rnd(): number {
    let x = this.rngState;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rngState = x;
    return x / 4294967296;
  }

  /**
   * Before every Battle.step: a finished decision is played if still legal; a new one starts on the
   * decision grid while a card is playable. Returns the play to make now, if any.
   */
  decide(b: Battle): { slot: number; x: number; y: number } | null {
    let play: { slot: number; x: number; y: number } | null = null;
    const r = this.ready;
    if (r) {
      this.ready = null;
      if (r.slot > 0 && Encoder.playable(b, this.team, r.slot - 1)) {
        const { x, y } = Encoder.tileWorld(this.team, r.tile);
        play = { slot: r.slot - 1, x, y };
      }
    }
    if (!this.session || !this.ort || this.busy || b.result !== null || b.tick % DECISION_TICKS !== 0) return play;
    let any = false;
    for (let s = 0; s < 4; s++) if (Encoder.playable(b, this.team, s)) any = true;
    if (!any) return play;
    this.enc.encode(b, this.team, this.cycle.cycle, this.obs, 0, this.mask, 0);
    const mask = this.mask.slice();
    const input = new this.ort.Tensor('float32', this.obs.slice(), [1, this.obs.length]);
    this.busy = true;
    this.session.run({ obs: input }).then((out) => {
      const sl = out.slot_logits.data;
      const tl = out.tile_logits.data;
      const slot = sampleMasked(sl, (i) => i < N_SLOTS && mask[i] === 1, this.temperature, () => this.rnd());
      let tile = 0;
      if (slot > 0) {
        const off = (slot - 1) * N_TILES;
        const tm = N_SLOTS + off;
        tile = sampleMasked(tl.subarray(off, off + N_TILES), (i) => mask[tm + i] === 1, this.temperature, () => this.rnd());
      }
      this.ready = { slot, tile: Math.max(0, tile) };
    }).catch((e) => { this.error = String(e); console.warn('agent inference', e); })
      .finally(() => { this.busy = false; });
    return play;
  }
}
