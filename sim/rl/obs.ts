// Observation and action encoding for reinforcement learning (not native: training tooling).
//
// Everything is seen from the acting team's side: team 1's view is the arena turned 180 degrees
// (x -> 18000 - x, y -> 32000 - y), so a policy always defends the bottom half and one network can
// play either side. An observation is one Float32Array record (layout in `layout()`, mirrored by
// train/crl/spec.py from the JSON spec the worker prints) plus a Uint8Array of legal-action masks.
//
// Fair information only for the actor: the board, both sides' towers, the clock, the own hand,
// elixir and queue, and what the opponent has publicly shown. Two derived opponent features are
// included because a player can compute them exactly from the public history:
//  - the opponent's elixir (debited when a play commits, 0xd77504, which is when the card appears;
//    regeneration and the cap are deterministic), and
//  - the opponent's card cycle: a played card goes to the back of the queue, so the last plays
//    (up to 4) are known queue entries and the rest of the deck is split between hand and queue.
// The critic additionally gets a privileged block: the opponent's exact hand, queue order, pending
// plays (still inside the 20-tick command delay) and pending elixir.

import {
  type Battle, type CardDef, ELIXIR_ONE, KING_ACTIVE, type Player, ST_DEPLOYING, TOWER_KING, TOWER_PRINCESS, type Unit,
} from '../core/src/index.ts';

export const TILES_W = 18;
export const TILES_H = 32;
export const N_TILES = TILES_W * TILES_H;
/** Action: slot 0 = wait, 1..4 = hand slot; tile = canonical row * 18 + col. */
export const N_SLOTS = 5;

export const MAX_UNITS = 64;
export const MAX_PROJ = 32;
export const MAX_AOE = 12;
export const N_CARDS = 16; // own deck (8) then opponent deck (8)
export const MAX_PEND = 4;

export const F_GLOBAL = 16;
export const F_UNIT = 40;
export const ID_UNIT = 4; // unit def, card, buff 1, buff 2
export const F_PROJ = 16;
export const ID_PROJ = 2; // projectile def, spell card
export const F_AOE = 10;
export const ID_AOE = 1;
export const F_CARD = 16;
export const ID_CARD = 1;
export const F_PEND = 4;
export const ID_PEND = 1;
export const F_PRIV_CARD = 7; // opponent deck: true in-hand, hand slot one-hot (4), true queue pos, is next
export const F_PRIV_GLOBAL = 2;

export interface Vocab {
  units: string[];
  projectiles: string[];
  areaEffects: string[];
  buffs: string[];
  cards: string[];
}

/** Index 0 is padding; names map to 1 + their sorted index. */
export function makeVocab(data: Battle['data']): Vocab {
  const s = (o: Record<string, unknown>) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
  return { units: s(data.units), projectiles: s(data.projectiles), areaEffects: s(data.areaEffects), buffs: s(data.buffs), cards: s(data.cards) };
}

export interface Layout {
  global: number;
  units: number;
  proj: number;
  aoe: number;
  cards: number;
  pend: number;
  hand: number;
  privCards: number;
  privPend: number;
  privGlobal: number;
  floats: number;
  slotMask: number;
  tileMask: number;
  maskBytes: number;
}

/** Offsets (in floats / mask bytes) of each block of a record. */
export function layout(): Layout {
  let o = 0;
  const take = (n: number) => { const at = o; o += n; return at; };
  const L = {
    global: take(F_GLOBAL),
    units: take(MAX_UNITS * (F_UNIT + ID_UNIT)),
    proj: take(MAX_PROJ * (F_PROJ + ID_PROJ)),
    aoe: take(MAX_AOE * (F_AOE + ID_AOE)),
    cards: take(N_CARDS * (F_CARD + ID_CARD)),
    pend: take(MAX_PEND * (F_PEND + ID_PEND)),
    hand: take(4),
    privCards: take(8 * F_PRIV_CARD),
    privPend: take(MAX_PEND * (F_PEND + ID_PEND)),
    privGlobal: take(F_PRIV_GLOBAL),
    floats: 0,
    slotMask: 0,
    tileMask: N_SLOTS,
    maskBytes: N_SLOTS + 4 * N_TILES,
  };
  L.floats = o;
  return L;
}

/** Public knowledge of one player's cycle, kept by the env from the queue it sees change. */
export interface CycleInfo {
  /** Plays committed so far (each pushes its card to the back of the queue, 0xf9f23c). */
  commits: number;
}

/**
 * Each player's commit count, read from its queue as the env and the viewer both see it: a committed
 * play pushes its card to the queue's back, a refill shifts the head (0xf9f23c / 0xfa5b4c).
 */
export class CycleTracker {
  readonly cycle: [CycleInfo, CycleInfo] = [{ commits: 0 }, { commits: 0 }];
  private last: [number[], number[]] = [[], []];

  reset(b: Battle): void {
    for (let t = 0; t < 2; t++) {
      this.cycle[t].commits = 0;
      this.last[t] = b.players[t].queue.slice();
    }
  }

  /** Call once per tick, after Battle.step. */
  update(b: Battle): void {
    for (let t = 0; t < 2; t++) {
      const q = b.players[t].queue;
      const old = this.last[t];
      if (q.length === old.length && q.every((v, i) => v === old[i])) continue;
      const s = q.length ? old.indexOf(q[0]) : old.length;
      const kept = s < 0 ? 0 : old.length - s;
      this.cycle[t].commits += Math.max(0, q.length - kept);
      this.last[t] = q.slice();
    }
  }
}

export class Encoder {
  readonly L = layout();
  private readonly unitId = new Map<string, number>();
  private readonly projId = new Map<string, number>();
  private readonly aoeId = new Map<string, number>();
  private readonly buffId = new Map<string, number>();
  private readonly cardId = new Map<string, number>();
  private readonly grid = new Uint8Array(N_TILES);

  readonly vocab: Vocab;

  constructor(vocab: Vocab) {
    this.vocab = vocab;
    vocab.units.forEach((n, i) => this.unitId.set(n, i + 1));
    vocab.projectiles.forEach((n, i) => this.projId.set(n, i + 1));
    vocab.areaEffects.forEach((n, i) => this.aoeId.set(n, i + 1));
    vocab.buffs.forEach((n, i) => this.buffId.set(n, i + 1));
    vocab.cards.forEach((n, i) => this.cardId.set(n, i + 1));
  }

  card(name: string): number { return this.cardId.get(name) ?? 0; }

  /** World tile (col, row) of a canonical action tile for `team`. */
  static tileWorld(team: number, tile: number): { x: number; y: number } {
    let col = tile % TILES_W;
    let row = (tile / TILES_W) | 0;
    if (team === 1) { col = TILES_W - 1 - col; row = TILES_H - 1 - row; }
    return { x: col * 1000 + 500, y: row * 1000 + 500 };
  }

  /** Whether hand slot `s` (0..3) of `team` can be played now (the engine's checkPlay minus position). */
  static playable(b: Battle, team: number, s: number): boolean {
    const p = b.players[team];
    const di = p.hand[s];
    if (di < 0 || b.result !== null) return false;
    for (const c of b.commands) if (c.team === team && c.slot === s) return false;
    const card = p.deck[di];
    if (card.unsupported.length) return false;
    return b.infiniteElixir || p.elixir - p.pending >= card.cost * ELIXIR_ONE;
  }

  /**
   * Write `team`'s observation into `out` at float offset `fo` and its masks into `mask` at byte
   * offset `mo`. `cycle` = both players' public cycle info.
   */
  encode(b: Battle, team: number, cycle: [CycleInfo, CycleInfo], out: Float32Array, fo: number, mask: Uint8Array, mo: number): void {
    const L = this.L;
    out.fill(0, fo, fo + L.floats);
    const flip = team === 1;
    const X = (x: number) => (flip ? 18000 - x : x) / 18000;
    const Y = (y: number) => (flip ? 32000 - y : y) / 32000;
    const sgn = flip ? -1 : 1;
    const me = b.players[team];
    const op = b.players[1 - team];
    const regMs = b.regulationTicks * 50;
    const t = b.timeMs;

    // global
    let g = fo + L.global;
    out[g++] = t / regMs;
    out[g++] = b.overtime ? 1 : 0;
    out[g++] = b.overtime ? Math.max(0, regMs + b.overtimeTicks * 50 - t) / regMs : Math.max(0, regMs - t) / regMs;
    out[g++] = (b.elixirPerTick() * 20) / ELIXIR_ONE; // elixir per second
    out[g++] = me.elixir / ELIXIR_ONE / 10;
    out[g++] = me.pending / ELIXIR_ONE / 10;
    out[g++] = (me.elixir - me.pending) / ELIXIR_ONE / 10;
    out[g++] = op.elixir / ELIXIR_ONE / 10; // public: see the header
    out[g++] = me.crowns / 3;
    out[g++] = op.crowns / 3;
    out[g++] = me.cycleTimer / 3000;
    out[g++] = Math.min(cycle[1 - team].commits, 40) / 20;
    out[g++] = Math.min(cycle[team].commits, 40) / 20;
    out[g++] = b.timeUp ? 1 : 0;
    out[g++] = b.maxElixir / ELIXIR_ONE / 10;
    out[g++] = 1;

    // units: the six crown towers first (destroyed ones keep a token at 0 hp), then the rest
    const U = L.units;
    const stride = F_UNIT + ID_UNIT;
    let n = 0;
    const put = (u: Unit) => {
      if (n >= MAX_UNITS) return;
      const o = fo + U + n * stride;
      n++;
      const d = u.def;
      const own = u.team === team;
      out[o] = own ? 1 : 0;
      out[o + 1] = X(u.x);
      out[o + 2] = Y(u.y);
      const hp = Math.max(0, u.hp);
      out[o + 3] = u.maxHp > 0 ? hp / u.maxHp : 0;
      out[o + 4] = Math.log1p(hp) / 10;
      out[o + 5] = Math.log1p(u.maxHp) / 10;
      out[o + 6] = Math.log1p(Math.max(0, u.shield)) / 10;
      out[o + 7] = u.state === ST_DEPLOYING ? 1 : 0;
      out[o + 8] = u.deployTotal > 0 ? u.deployTicks / u.deployTotal : 0;
      out[o + 9] = u.isAir ? 1 : 0;
      out[o + 10] = u.isBuilding ? 1 : 0;
      out[o + 11] = u.tower === TOWER_PRINCESS ? 1 : 0;
      out[o + 12] = u.tower === TOWER_KING ? 1 : 0;
      out[o + 13] = u.tower === TOWER_KING && u.kingState === KING_ACTIVE ? 1 : 0;
      out[o + 14] = u.moving ? 1 : 0;
      out[o + 15] = (sgn * u.dirX) / 256;
      out[o + 16] = (sgn * u.dirY) / 256;
      const tg = u.target;
      if (tg) {
        out[o + 17] = 1;
        out[o + 18] = (sgn * (tg.x - u.x)) / 18000;
        out[o + 19] = (sgn * (tg.y - u.y)) / 32000;
        out[o + 39] = tg.isBuilding ? 1 : 0;
      }
      out[o + 20] = u.locked ? 1 : 0;
      out[o + 21] = d.hitSpeed > 0 ? u.atkTimer / d.hitSpeed : 0;
      out[o + 22] = u.load / 1000;
      out[o + 23] = u.hitStarted ? 1 : 0;
      out[o + 24] = u.charge / 10000;
      out[o + 25] = u.chargeHit ? 1 : 0;
      out[o + 26] = u.z / 1000;
      out[o + 27] = u.jumping ? 1 : 0;
      out[o + 28] = Math.min(b.tick - u.spawnTick, 400) / 200;
      out[o + 29] = d.lifeTime > 0 ? Math.min(1, (u.lifeTicks * 50) / d.lifeTime) : 0;
      out[o + 30] = u.spawnTimer / 1000;
      out[o + 31] = u.hidden ? 1 : 0;
      out[o + 32] = u.tunneling ? 1 : 0;
      out[o + 33] = u.kbActive ? 1 : 0;
      out[o + 34] = u.buffs.length / 4;
      out[o + 35] = u.atkOff ? 1 : 0;
      let sp = 1, hs = 1, dr = 0;
      for (const bf of u.buffs) { sp *= bf.def.speedMul; hs *= bf.def.hitSpeedMul; dr = Math.max(dr, bf.def.damageReduction); }
      out[o + 36] = sp;
      out[o + 37] = hs;
      out[o + 38] = dr / 100;
      const io = o + F_UNIT;
      out[io] = this.unitId.get(d.name) ?? 0;
      out[io + 1] = u.card ? this.card(u.card) : 0;
      out[io + 2] = u.buffs.length > 0 ? this.buffId.get(u.buffs[0].def.name) ?? 0 : 0;
      out[io + 3] = u.buffs.length > 1 ? this.buffId.get(u.buffs[1].def.name) ?? 0 : 0;
    };
    const towers: Unit[] = [me.king, me.princess[0], me.princess[1], op.king, op.princess[0], op.princess[1]];
    for (const u of towers) if (u) put(u);
    for (const u of b.units) if (u.tower === 0 && u.state !== 2 && u.hp > 0) put(u);

    // projectiles
    let k = 0;
    for (const p of b.projectiles) {
      if (!p.alive || k >= MAX_PROJ) continue;
      const o = fo + L.proj + k * (F_PROJ + ID_PROJ);
      k++;
      out[o] = p.team === team ? 1 : 0;
      out[o + 1] = X(p.x);
      out[o + 2] = Y(p.y);
      const tx = p.target ? p.target.x : p.tx;
      const ty = p.target ? p.target.y : p.ty;
      out[o + 3] = X(tx);
      out[o + 4] = Y(ty);
      out[o + 5] = p.target ? 1 : 0;
      out[o + 6] = Math.log1p(Math.max(0, p.damage)) / 10;
      out[o + 7] = p.radius / 5000;
      out[o + 8] = p.spell ? 1 : 0;
      out[o + 9] = p.z / 1000;
      out[o + 10] = Math.min(b.tick - p.born, 80) / 40;
      out[o + 11] = p.def.speed / 100;
      out[o + 12] = p.aoeAir ? 1 : 0;
      out[o + 13] = p.aoeGround ? 1 : 0;
      out[o + 14] = p.pushback / 1000;
      out[o + 15] = Math.log1p(Math.max(0, p.towerDamage)) / 10;
      out[o + F_PROJ] = this.projId.get(p.def.name) ?? 0;
      out[o + F_PROJ + 1] = p.spell ? this.card(p.spell) : 0;
    }

    // area effects
    k = 0;
    for (const a of b.areaEffects) {
      if (!a.alive || k >= MAX_AOE) continue;
      const o = fo + L.aoe + k * (F_AOE + ID_AOE);
      k++;
      const d = a.def;
      out[o] = a.team === team ? 1 : 0;
      out[o + 1] = X(a.x);
      out[o + 2] = Y(a.y);
      out[o + 3] = d.radius / 5000;
      out[o + 4] = d.lifeDuration > 0 ? Math.max(0, a.life) / d.lifeDuration : 0;
      out[o + 5] = Math.max(0, a.life) / 10000;
      out[o + 6] = Math.log1p(Math.max(0, d.damage)) / 10;
      out[o + 7] = d.hitSpeed / 1000;
      out[o + 8] = Math.min(b.tick - a.born, 200) / 100;
      out[o + 9] = d.buff ? 1 : 0;
      out[o + F_AOE] = this.aoeId.get(d.name) ?? 0;
    }

    // cards: own deck (deck order), then the opponent's (deck order)
    const C = fo + L.cards;
    const cs = F_CARD + ID_CARD;
    const cardBase = (o: number, c: CardDef, own: boolean) => {
      out[o] = own ? 1 : 0;
      out[o + 1] = c.cost / 10;
      out[o + 13] = c.type === 'troop' ? 1 : 0;
      out[o + 14] = c.type === 'building' ? 1 : 0;
      out[o + 15] = c.type === 'spell' ? 1 : 0;
      out[o + F_CARD] = this.card(c.name);
    };
    for (let di = 0; di < 8; di++) {
      const o = C + di * cs;
      cardBase(o, me.deck[di], true);
      const slot = me.hand.indexOf(di);
      if (slot >= 0) {
        out[o + 2] = 1;
        out[o + 3 + slot] = 1;
        out[o + 10] = 1;
        out[o + 11] = Encoder.playable(b, team, slot) ? 1 : 0;
        for (const c of b.commands) if (c.team === team && c.slot === slot) out[o + 12] = 1;
      }
      const q = me.queue.indexOf(di);
      if (q >= 0) {
        out[o + 7] = 1;
        out[o + 8] = q / 4;
        out[o + 9] = q === 0 ? 1 : 0;
      }
    }
    // opponent: the last min(commits, queue length) queue entries are public; the rest of the deck
    // splits between the hand (8 - queue length filled slots) and the unknown queue head
    const known = Math.min(cycle[1 - team].commits, op.queue.length);
    const qStart = op.queue.length - known;
    const handCount = 8 - op.queue.length;
    const unknown = 8 - known;
    for (let di = 0; di < 8; di++) {
      const o = C + (8 + di) * cs;
      cardBase(o, op.deck[di], false);
      const q = op.queue.indexOf(di);
      if (q >= qStart && q >= 0) {
        out[o + 7] = 1;
        out[o + 8] = q / 4;
        out[o + 9] = q === 0 ? 1 : 0;
      } else {
        const p = unknown > 0 ? handCount / unknown : 0;
        out[o + 10] = p;
        if (p >= 1) out[o + 2] = 1;
      }
      // privileged: exact location
      const po = fo + L.privCards + di * F_PRIV_CARD;
      const slot = op.hand.indexOf(di);
      if (slot >= 0) { out[po] = 1; out[po + 1 + slot] = 1; }
      if (q >= 0) { out[po + 5] = q / 4; out[po + 6] = q === 0 ? 1 : 0; }
    }

    // own pending plays (inside the command delay) and the opponent's (privileged)
    let np = 0, nq = 0;
    for (const c of b.commands) {
      const own = c.team === team;
      if (own ? np >= MAX_PEND : nq >= MAX_PEND) continue;
      const o = fo + (own ? L.pend : L.privPend) + (own ? np++ : nq++) * (F_PEND + ID_PEND);
      out[o] = X(c.x);
      out[o + 1] = Y(c.y);
      out[o + 2] = Math.max(0, 20 - (b.tick - c.submitTick)) / 20;
      out[o + 3] = c.cost / ELIXIR_ONE / 10;
      out[o + F_PEND] = this.card(c.card.name);
    }
    out[fo + L.privGlobal] = op.pending / ELIXIR_ONE / 10;
    out[fo + L.privGlobal + 1] = op.cycleTimer / 3000;

    // hand slot -> own card token index (0..7), -1 when the slot is empty
    for (let s = 0; s < 4; s++) out[fo + L.hand + s] = me.hand[s];

    // masks: wait is always legal; a slot is legal when playable and some tile takes the card
    mask.fill(0, mo, mo + L.maskBytes);
    mask[mo] = 1;
    for (let s = 0; s < 4; s++) {
      if (!Encoder.playable(b, team, s)) continue;
      const card = me.deck[me.hand[s]];
      b.deployGrid(team, card, this.grid);
      const tm = mo + L.tileMask + s * N_TILES;
      let any = 0;
      for (let tile = 0; tile < N_TILES; tile++) {
        let col = tile % TILES_W;
        let row = (tile / TILES_W) | 0;
        if (flip) { col = TILES_W - 1 - col; row = TILES_H - 1 - row; }
        const v = this.grid[row * TILES_W + col];
        mask[tm + tile] = v;
        any |= v;
      }
      mask[mo + 1 + s] = any;
    }
  }
}

export function opponentOf(p: Player): number { return 1 - p.team; }
