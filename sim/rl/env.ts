// One training battle (not native: training tooling). Each team is controlled by the Python
// trainer ('py'), the scripted bot ('bot', core/src/bot.ts), random play ('random') or nothing.
//
// A py team is asked for an action only at decision points: ticks that are a multiple of
// `decisionTicks` at which it has a playable card (with nothing playable the only legal action is
// to wait, so asking would waste a network call and a transition). Rewards are accumulated per team
// between its decision points, discounted per tick (gamma^k for the k-th tick after the decision),
// so the trainer works on a semi-MDP: transition (s, a, R, k ticks, s').

import { Battle, Bot } from '../core/src/index.ts';
import type { GameData } from '../core/src/index.ts';
import { type CycleInfo, Encoder } from './obs.ts';

export type Ctrl = 'py' | 'bot' | 'random' | 'none';

export interface EnvConfig {
  decks: [string[], string[]];
  /** Assign the two decks to the teams at random each episode. */
  deckSwap: boolean;
  decisionTicks: number;
  /** Per-tick discount used for the reward sums handed to the trainer. */
  gamma: number;
  /** Probability that an episode is py vs bot (the bot's team at random); otherwise py vs py. */
  botProb: number;
  botLevel: number;
  randomProb: number;
  /** Stop an episode that has not ended after this many ticks (safety; a match ends by 6000). */
  maxTicks: number;
  level: number;
}

export const DEFAULT_ENV: EnvConfig = {
  decks: [
    ['Knight', 'Archer', 'Giant', 'Musketeer', 'MiniPekka', 'SpearGoblins', 'Fireball', 'Arrows'],
    ['Valkyrie', 'BabyDragon', 'HogRider', 'SkeletonArmy', 'Minions', 'Cannon', 'GoblinBarrel', 'Log'],
  ],
  deckSwap: true,
  decisionTicks: 5,
  gamma: 0.9997,
  botProb: 0,
  botLevel: 3,
  randomProb: 0,
  maxTicks: 8000,
  level: 11,
};

/** Reward accumulated for one team since its last decision point. */
export class Acc {
  term = 0; // win +1 / loss -1 / draw 0, discounted
  shape = 0; // crown-tower damage dealt minus taken (fractions of max hp), discounted
  ticks = 0;
  disc = 1;
  reset(): void { this.term = 0; this.shape = 0; this.ticks = 0; this.disc = 1; }
}

/** xorshift32 for episode sampling (env-local, so a worker's episodes are reproducible). */
export class XRng {
  s: number;
  constructor(s: number) { this.s = s === 0 ? 0x9e3779b9 : s; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
}

export interface EpisodeEnd {
  team: number;
  outcome: number; // +1 win, -1 loss, 0 draw, from this team's side
  acc: Acc;
}

export class RlEnv {
  b!: Battle;
  ctrl: [Ctrl, Ctrl] = ['py', 'py'];
  deckOf: [number, number] = [0, 1];
  bots: [Bot | null, Bot | null] = [null, null];
  readonly acc: [Acc, Acc] = [new Acc(), new Acc()];
  readonly cycle: [CycleInfo, CycleInfo] = [{ commits: 0 }, { commits: 0 }];
  private lastQueue: [number[], number[]] = [[], []];
  private towerHp: number[] = [0, 0, 0, 0, 0, 0];
  episode = 0;
  /** A py team that was asked this round and has not acted yet. */
  readonly waiting: [boolean, boolean] = [false, false];
  readonly started: [boolean, boolean] = [false, false];
  private randState = 1;

  readonly data: GameData;
  readonly cfg: EnvConfig;
  readonly rng: XRng;

  constructor(data: GameData, cfg: EnvConfig, rng: XRng) {
    this.data = data;
    this.cfg = cfg;
    this.rng = rng;
  }

  reset(): void {
    const cfg = this.cfg;
    this.episode++;
    const seed = 1 + this.rng.int(0x7ffffffe);
    const swap = cfg.deckSwap && this.rng.next() < 0.5;
    this.deckOf = swap ? [1, 0] : [0, 1];
    this.b = new Battle(this.data, { seed, decks: [cfg.decks[this.deckOf[0]], cfg.decks[this.deckOf[1]]], level: cfg.level });
    const r = this.rng.next();
    const side = this.rng.int(2);
    if (r < cfg.botProb) this.ctrl = side === 0 ? ['bot', 'py'] : ['py', 'bot'];
    else if (r < cfg.botProb + cfg.randomProb) this.ctrl = side === 0 ? ['random', 'py'] : ['py', 'random'];
    else this.ctrl = ['py', 'py'];
    this.bots = [
      this.ctrl[0] === 'bot' ? new Bot(0, { seed: seed ^ 0x5bd1e995, level: cfg.botLevel }) : null,
      this.ctrl[1] === 'bot' ? new Bot(1, { seed: seed ^ 0x1b873593, level: cfg.botLevel }) : null,
    ];
    this.randState = seed ^ 0x2545f491;
    for (let t = 0; t < 2; t++) {
      this.acc[t].reset();
      this.cycle[t].commits = 0;
      this.lastQueue[t] = this.b.players[t].queue.slice();
      this.waiting[t] = false;
      this.started[t] = false;
    }
    this.readTowers(this.towerHp);
  }

  private readTowers(out: number[]): void {
    for (let t = 0; t < 2; t++) {
      const p = this.b.players[t];
      const ts = [p.king, p.princess[0], p.princess[1]];
      for (let i = 0; i < 3; i++) out[t * 3 + i] = ts[i] ? Math.max(0, ts[i].hp) / Math.max(1, ts[i].maxHp) : 0;
    }
  }

  /** Commits since the last call, from the queue: plays push to its back, refills shift its head. */
  private trackCycle(): void {
    for (let t = 0; t < 2; t++) {
      const q = this.b.players[t].queue;
      const old = this.lastQueue[t];
      if (q.length === old.length && q.every((v, i) => v === old[i])) continue;
      const s = q.length ? old.indexOf(q[0]) : old.length;
      const kept = s < 0 ? 0 : old.length - s;
      this.cycle[t].commits += Math.max(0, q.length - kept);
      this.lastQueue[t] = q.slice();
    }
  }

  /** A py team has a decision now (aligned tick, something playable). */
  decides(t: number): boolean {
    if (this.ctrl[t] !== 'py' || this.b.result !== null) return false;
    if (this.b.tick % this.cfg.decisionTicks !== 0) return false;
    for (let s = 0; s < 4; s++) if (Encoder.playable(this.b, t, s)) return true;
    return false;
  }

  /** Apply a py team's action (slot 0 = wait, 1..4 = hand slot; tile = canonical tile). */
  act(t: number, slot: number, tile: number): void {
    this.waiting[t] = false;
    if (slot <= 0) return;
    const { x, y } = Encoder.tileWorld(t, tile);
    this.b.play(t, slot - 1, x, y);
  }

  private scripted(): void {
    const b = this.b;
    for (let t = 0; t < 2; t++) {
      const c = this.ctrl[t];
      if (c === 'bot') this.bots[t]!.act(b);
      else if (c === 'random') {
        const r = () => { this.randState = (Math.imul(this.randState, 1664525) + 1013904223) >>> 0; return this.randState; };
        if (r() % 10 !== 0) continue;
        const slot = r() % 4;
        if (b.players[t].hand[slot] < 0) continue;
        const { x, y } = Encoder.tileWorld(t, r() % 576);
        b.play(t, slot, x, y);
      }
    }
  }

  /**
   * Step until a py team decides or the episode ends. Returns the episode ends (one per py team)
   * when it ended; decisions are read from `decides()` afterwards.
   */
  advance(): EpisodeEnd[] | null {
    const b = this.b;
    const g = this.cfg.gamma;
    const hp = [0, 0, 0, 0, 0, 0];
    for (;;) {
      this.scripted();
      b.step();
      this.trackCycle();
      this.readTowers(hp);
      for (let t = 0; t < 2; t++) {
        const a = this.acc[t];
        const own = t * 3, opp = (1 - t) * 3;
        let s = 0;
        for (let i = 0; i < 3; i++) s += (this.towerHp[opp + i] - hp[opp + i]) - (this.towerHp[own + i] - hp[own + i]);
        a.shape += a.disc * s;
        a.ticks++;
        a.disc *= g;
      }
      for (let i = 0; i < 6; i++) this.towerHp[i] = hp[i];
      if (b.result !== null || b.tick >= this.cfg.maxTicks) {
        const w = b.result ? b.result.winner : -1;
        const ends: EpisodeEnd[] = [];
        for (let t = 0; t < 2; t++) {
          if (this.ctrl[t] !== 'py') continue;
          const outcome = w < 0 ? 0 : w === t ? 1 : -1;
          // the terminal reward arrives with the last tick: discount of the tick before
          const a = this.acc[t];
          a.term += (a.disc / g) * outcome;
          ends.push({ team: t, outcome, acc: a });
        }
        return ends;
      }
      if (this.decides(0) || this.decides(1)) return null;
    }
  }
}
