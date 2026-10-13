// One training battle (not native: training tooling). Each team is controlled by the Python
// trainer ('py'), the scripted bot ('bot', core/src/bot.ts), random play ('random') or nothing.
//
// A py team is asked for an action only at decision points: ticks that are a multiple of
// `decisionTicks` at which it has a playable card (with nothing playable the only legal action is
// to wait, so asking would waste a network call and a transition). Rewards are accumulated per team
// between its decision points, discounted per tick (gamma^k for the k-th tick after the decision),
// so the trainer works on a semi-MDP: transition (s, a, R, k ticks, s').

import { Battle, Bot, ELIXIR_ONE } from '../core/src/index.ts';
import type { GameData } from '../core/src/index.ts';
import { type CycleInfo, CycleTracker, Encoder, TILES_H } from './obs.ts';

export type Ctrl = 'py' | 'bot' | 'random' | 'none';

export interface EnvConfig {
  decks: [string[], string[]];
  /** Assign the two decks to the teams at random each episode. */
  deckSwap: boolean;
  /** Mirror match: both teams play decks[0]. */
  mirror?: boolean;
  /** Terminal reward += crownCoef * (own crowns - opponent crowns) / 3 (on top of win +1 / loss -1). */
  crownCoef?: number;
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
  /** Write each finished episode as a replay JSON into this directory (worker; viewer `?replay=`). */
  replayDir?: string;
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

/**
 * mulberry32 for episode sampling (env-local, so a worker's episodes are reproducible). Not xorshift32:
 * its consecutive outputs are correlated when one is small, which skewed the bot's side (draw after a
 * small `r < botProb`) about 2:1.
 */
export class XRng {
  s: number;
  constructor(s: number) { this.s = s >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
}

/**
 * Per-team behaviour of an episode, for monitoring only (not in the reward or the observation):
 * [plays of deck card 0..7, plays in the enemy half, elixir at play (sum), ticks at full elixir,
 *  crown-tower damage dealt, crown-tower damage taken (fractions of max hp, summed over the 3 towers)].
 */
export const BEH_F = 13;

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
  private readonly tracker = new CycleTracker();
  get cycle(): [CycleInfo, CycleInfo] { return this.tracker.cycle; }
  private towerHp: number[] = [0, 0, 0, 0, 0, 0];
  readonly beh: [Float64Array, Float64Array] = [new Float64Array(BEH_F), new Float64Array(BEH_F)];
  episode = 0;
  seed = 0;
  /** Successful plays of the episode, [tick, team, slot, x, y] (recorded when cfg.replayDir is set). */
  plays: number[][] = [];
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
    this.deckOf = cfg.mirror ? [0, 0] : swap ? [1, 0] : [0, 1];
    this.b = new Battle(this.data, { seed, decks: [cfg.decks[this.deckOf[0]], cfg.decks[this.deckOf[1]]], level: cfg.level });
    this.seed = seed;
    this.plays = [];
    this.beh[0].fill(0);
    this.beh[1].fill(0);
    {
      // every play (trainer, bot, random) goes through Battle.play: count the accepted ones (and record
      // them with their tick for replays)
      const b = this.b;
      const play = b.play.bind(b);
      const mid = TILES_H * 500;
      b.play = (team: number, slot: number, x: number, y: number) => {
        const p = b.players[team];
        const di = p.hand[slot] ?? -1;
        const elixir = p.elixir;
        const err = play(team, slot, x, y);
        if (err === null) {
          const s = this.beh[team];
          if (di >= 0 && di < 8) s[di]++;
          if ((y - mid) * (p.king.y - mid) < 0) s[8]++;
          s[9] += elixir / ELIXIR_ONE;
          if (cfg.replayDir) this.plays.push([b.tick, team, slot, x, y]);
        }
        return err;
      };
    }
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
      this.waiting[t] = false;
      this.started[t] = false;
    }
    this.tracker.reset(this.b);
    this.readTowers(this.towerHp);
  }

  private readTowers(out: number[]): void {
    for (let t = 0; t < 2; t++) {
      const p = this.b.players[t];
      const ts = [p.king, p.princess[0], p.princess[1]];
      for (let i = 0; i < 3; i++) out[t * 3 + i] = ts[i] ? Math.max(0, ts[i].hp) / Math.max(1, ts[i].maxHp) : 0;
    }
  }

  /** The episode as a replay: Battle config plus every accepted play by tick (deterministic). */
  replay(): Record<string, unknown> {
    const b = this.b;
    return {
      v: 1, seed: this.seed, level: this.cfg.level, decks: [this.cfg.decks[this.deckOf[0]], this.cfg.decks[this.deckOf[1]]],
      ctrl: this.ctrl, plays: this.plays, result: b.result, crowns: [b.players[0].crowns, b.players[1].crowns], ticks: b.tick,
    };
  }

  /** Commits since the last call (plays push to the queue's back, refills shift its head). */
  private trackCycle(): void {
    this.tracker.update(this.b);
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
      for (let t = 0; t < 2; t++) if (b.players[t].elixir >= b.maxElixir) this.beh[t][10]++;
      if (b.result !== null || b.tick >= this.cfg.maxTicks) {
        for (let t = 0; t < 2; t++) {
          let dealt = 0, taken = 0;
          for (let i = 0; i < 3; i++) { dealt += 1 - hp[(1 - t) * 3 + i]; taken += 1 - hp[t * 3 + i]; }
          this.beh[t][11] = dealt;
          this.beh[t][12] = taken;
        }
        const w = b.result ? b.result.winner : -1;
        const ends: EpisodeEnd[] = [];
        for (let t = 0; t < 2; t++) {
          if (this.ctrl[t] !== 'py') continue;
          const outcome = w < 0 ? 0 : w === t ? 1 : -1;
          // the terminal reward arrives with the last tick: discount of the tick before
          const a = this.acc[t];
          const crowns = (b.players[t].crowns - b.players[1 - t].crowns) / 3;
          a.term += (a.disc / g) * (outcome + (this.cfg.crownCoef ?? 0) * crowns);
          ends.push({ team: t, outcome, acc: a });
        }
        return ends;
      }
      if (this.decides(0) || this.decides(1)) return null;
    }
  }
}
