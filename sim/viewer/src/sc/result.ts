// End-of-battle result screen (libg 160402020), ported from the client:
//   - when: the logic battle counts ms since its end (+0x198 = 1 at the end 0xd3e360, +50 per later
//     tick 0xd33f74); 0xd3581c is true once that reaches the location's EndScreenDelay (0xe48ce4,
//     PvP_goblin 4000) - 80 ticks after the end tick. The battle screen update 0xbe1d3c then creates
//     the screen (local battles; a server battle gets it from the battle-end message 0x4f45 in
//     0xaf11dc) through 0xbe0100: the intro is deleted, pending play leftovers dropped, the screen
//     (0x8bc564) inserted at index 0 of the popup layer +0x170 (above the HUD, below popups),
//     placed at the stage centre (0x8bef20 -> 0x89ac0c), and the HUD's hand panels +0x90 / +0x98
//     hidden (0x8d5ff8); battle input stays blocked (0xbe4400 while the screen exists);
//   - 0x8bcab8 picks `pvp_battle_end_new` (sc/ui_battle_end.sc) for a 1v1 battle that is not Best of
//     three, PvE, tournament, 2v2 or a custom season screen;
//   - 0x8bc564: `dimmer_stretch` stretched over the stage (0x89b344 `_stretch`, 0x89a38c); buttons
//     0x8bc248: without "play again" (0x8bc408 needs the own avatar's data, which the sandbox lacks)
//     `again_btn`, `ok_btn` and `button_ok` are removed and `ok_btn_single` is the OK button;
//     `replay_btn` removed (not a replay); 0x8be288: player_02 (+0x1e0, the opponent) and player_01
//     (+0x1e8, the own player) play appear_start..appear_end, their y is kept (+0x298), crown_1..3 go
//     to crown_appear_start, their `crown` and cushion_1..3 to frame 0; 0x8bee20: the root plays
//     0..score_end (+0x310);
//   - 0x8bf730 (result 1 win / 2 loss / 3 draw, own and opponent crowns): `draw` hidden, or played for
//     a draw; both winner_txt hidden, the winner's kept (+0x2f8) with the winner's clip (+0x1d8);
//     0x8c0bc4 per player: name = the avatar's name, TID_YOU for the own avatar without one; clan text
//     TID_NO_CLAN without a clan (TID_NPC_CLAN for an NPC); trophies only with a trophy change (none in
//     the sandbox: hidden), crown-rush, league and rating rows hidden; `loot` hidden without rewards
//     (0x8c16ec), loot_season hidden;
//   - update 0x8c1b9c -> 0x8c2b80, each battle screen update: once the root reached score_end, every
//     0.3 s (+0x328, first at once) one crown: the opponent's first, then the own; its crown_N plays
//     crown_appear_start..crown_appear_end and its `crown` frames 30..79 at a frame time of 0.008163 s
//     in mode 1 (0x124351c, +0x4c = 1); when crown_N passes 80 % of its frames the cushion plays and
//     the player panel shakes (entry t = -0.02: y = y0 + sin(2 pi f) * (6 - 6 f), f = t * 8.333 clamped,
//     back to y0 at 0.12 s); after the last crown and 1 s more (+0x1cc) the root plays
//     score_end..result_end; once it stops there the winner's winner_txt plays and becomes visible and
//     the winner's panel plays winner_start..winner_end.
// Not ported: the confetti effects of 0x8c08b0 (win_battle_confetti_blue(_top) through two effect
// layers), sounds and music (Pre_result, Post_result_loop, crown sounds), the OK button's press
// feedback (0x8a1c08); trophies, rewards and clan badges have no sandbox data.

import type { ScLibrary } from './library.ts';
import type { Col, Mat } from './math.ts';
import { matMul, WHITE } from './math.ts';
import { type DrawCtx, McNode } from './movieclip.ts';
import type { ScRenderer } from './renderer.ts';
import { BattleIntro, type IntroArt, introHudVisible } from './intro.ts';

const f32 = Math.fround;

/** manifest.hud.result (tools/art/bake_web.py) */
export interface ResultArt {
  sc: string;
  export: string;
  /** the location's EndScreenDelay (ms) */
  endScreenDelay: number;
}

/** 1 own win, 2 own loss, 3 draw (0x8bf730 param 2) */
export type ResultKind = 1 | 2 | 3;

export interface ResultInfo {
  kind: ResultKind;
  ownCrowns: number;
  oppCrowns: number;
  /** own name: TID_YOU (the client's fallback for an own avatar without a name) */
  ownName: string;
  /** opponent name (no opponent profile in the sandbox: an approximation) */
  oppName: string;
  /** TID_NO_CLAN */
  noClan: string;
}

/**
 * Logic ms since the end like +0x198 (1 at the end tick, +50 per later tick) and the 0xd3581c test.
 * `ticksSinceEnd` counts the 50 ms ticks after the end tick.
 */
export function endScreenDue(ticksSinceEnd: number, endScreenDelay: number): boolean {
  return 1 + 50 * ticksSinceEnd >= endScreenDelay;
}

interface Crown { wrap: McNode | null; crown: McNode | null; cushion: McNode | null; state: number }
interface Shake { player: 0 | 1; y0: number; t: number }

const CROWN_FRAME_TIME = f32(0.008163); // 0x3c05bf38
const CROWN_STEP = f32(0.3); // 0x3e99999a

export class ResultScreen {
  readonly root: McNode;
  readonly kind: ResultKind;
  private readonly oppCrowns: number; // +0x314
  private readonly ownCrowns: number; // +0x318
  private shown = 0; // +0x31c
  private crownT = 0; // +0x328
  private resultDelay = 1; // +0x1cc
  private resultShown = false; // +0x1d0
  private readonly scoreEnd: number; // +0x310
  /** [0] player_02 (opponent), [1] player_01 (own) */
  private readonly players: [McNode | null, McNode | null];
  private readonly playerSlot: [number, number];
  private readonly y0: [number, number] = [0, 0]; // +0x298
  private readonly crowns: [Crown[], Crown[]] = [[], []];
  private shakes: Shake[] = []; // +0x2d0
  private winnerTxt: McNode | null = null; // +0x2f8
  private winnerClip: McNode | null = null; // +0x1d8
  private readonly ok: number; // ok_btn_single slot
  private readonly dimmer: number;
  private stageKey = '';
  /** stage position of the screen (the stage centre) */
  private pos: [number, number] = [0, 0];
  /** time since creation (+0x1c8) */
  time = 0;

  constructor(lib: ScLibrary, art: ResultArt, info: ResultInfo) {
    const root = McNode.of(lib, art.export);
    if (!root) throw new Error(`result: no export ${art.export}`);
    this.root = root;
    this.kind = info.kind;
    // 0x8bc248 without play-again: ok_btn_single is the button, the others are removed
    for (const n of ['again_btn', 'ok_btn', 'button_ok', 'replay_btn']) {
      const k = root.child(n);
      if (k) k.visible = false;
    }
    this.ok = root.index('ok_btn_single');
    this.dimmer = root.index('dimmer_stretch');
    // 0x8be288
    const p2 = root.child('player_02'), p1 = root.child('player_01');
    this.players = [p2, p1];
    this.playerSlot = [root.index('player_02'), root.index('player_01')];
    for (const p of [0, 1] as const) {
      const pl = this.players[p];
      if (!pl) continue;
      pl.playLabels('appear_start', 'appear_end', false);
      this.y0[p] = this.slotMatrix(this.playerSlot[p], 0)?.[5] ?? 0;
      for (let i = 1; i <= 3; i++) {
        const wrap = pl.child(`crown_${i}`);
        wrap?.gotoLabel('crown_appear_start');
        const crown = wrap?.child('crown') ?? null;
        crown?.gotoAndStop(0);
        const cushion = pl.child(`cushion_${i}`);
        cushion?.gotoAndStop(0);
        this.crowns[p].push({ wrap, crown, cushion, state: 0 });
      }
    }
    // 0x8bee20: root 0..score_end
    this.scoreEnd = root.label('score_end');
    root.playLabels('0', 'score_end', false);
    // 0x8bf730
    this.oppCrowns = info.oppCrowns;
    this.ownCrowns = info.ownCrowns;
    this.crownT = 0;
    const draw = root.child('draw');
    const w2 = p2?.child('winner_txt') ?? null, w1 = p1?.child('winner_txt') ?? null;
    if (info.kind === 1) {
      if (draw) draw.visible = false;
      if (w2) w2.visible = false;
      if (w1) w1.visible = false;
      this.winnerTxt = w1;
      this.winnerClip = p1;
    } else if (info.kind === 2) {
      if (draw) draw.visible = false;
      if (w1) w1.visible = false;
      if (w2) w2.visible = false;
      this.winnerTxt = w2;
      this.winnerClip = p2;
    } else {
      draw?.playRange(0, draw.frames - 1, false);
      if (w2) w2.visible = false;
      if (w1) w1.visible = false;
    }
    // 0x8c0bc4: names, clan rows, trophies and the crown-rush / league / rating rows
    this.fillPlayer(p2, info.oppName, info.noClan);
    this.fillPlayer(p1, info.ownName, info.noClan);
    for (const n of ['loot', 'loot_season']) {
      const k = root.child(n);
      if (k) k.visible = false;
    }
  }

  private fillPlayer(p: McNode | null, name: string, noClan: string): void {
    if (!p) return;
    const pn = p.child('player_name');
    if (pn) {
      const ni = pn.index('name');
      if (ni >= 0) pn.slot(ni).text = name;
      const ci = pn.index('clan');
      if (ci >= 0) pn.slot(ci).text = noClan;
    }
    for (const n of ['crowns_crown_rush', 'trophies', 'trophies_crown_rush', 'rating', 'league', 'score']) {
      const k = p.child(n);
      if (k) k.visible = false;
    }
  }

  private slotMatrix(ci: number, f: number): Mat | null {
    const c = this.root.clip, bm = this.root.lib.banks[c.bank].m;
    for (let i = c.frameStart[f]; i < c.frameStart[f + 1]; i++) {
      if (c.elements[i * 3] !== ci) continue;
      const mi = c.elements[i * 3 + 1];
      return mi >= 0 ? Array.from(bm.subarray(mi * 6, mi * 6 + 6)) as Mat : [1, 0, 0, 1, 0, 0];
    }
    return null;
  }

  /** The screen update 0x8c1b9c -> 0x8c2b80 and the panel shakes, `dt` s of UI time (before the render). */
  update(dt: number): void {
    this.time = f32(this.time + dt);
    const root = this.root;
    let crownStep = false;
    if (root.frame >= this.scoreEnd && this.shown < this.ownCrowns + this.oppCrowns) {
      crownStep = true;
      this.crownT = f32(this.crownT - dt);
      if (this.crownT <= 0) {
        const own = this.oppCrowns <= this.shown;
        const idx = this.shown - (own ? this.oppCrowns : 0);
        const c = this.crowns[own ? 1 : 0][idx];
        if (c) {
          c.wrap?.playLabels('crown_appear_start', 'crown_appear_end', false);
          if (c.crown) {
            c.crown.mode = 1;
            c.crown.setFrameTime(CROWN_FRAME_TIME);
            c.crown.playRange(30, 79, false);
          }
          c.state = 1;
        }
        this.crownT = CROWN_STEP;
        this.shown++;
      }
    }
    if (!crownStep && root.state === 2) {
      if (root.frame === this.scoreEnd && !this.resultShown) {
        this.resultDelay = f32(this.resultDelay - dt);
        if (this.resultDelay <= 0) {
          root.playLabels('score_end', 'result_end', false);
          this.resultShown = true;
        }
      } else {
        const w = this.winnerTxt;
        if (w) { w.playRange(0, w.frames - 1, false); w.visible = true; this.winnerTxt = null; }
        const wc = this.winnerClip;
        if (wc) { wc.playLabels('winner_start', 'winner_end', false); this.winnerClip = null; }
      }
    }
    // LAB_008c2d60: a landing crown (crown_N past 80 % of its frames) starts its cushion and a shake
    for (const p of [0, 1] as const) {
      for (const c of this.crowns[p]) {
        const w = c.wrap;
        if (!w || c.state !== 1 || Math.trunc((w.frames * 80) / 100) > w.frame) continue;
        c.cushion?.playRange(0, c.cushion.frames - 1, false);
        this.shakes.push({ player: p, y0: this.y0[p], t: f32(-0.02) });
        c.state = 2;
      }
    }
    // shakes (0x8c1b9c), last to first: the panel's y set by code until the next root frame change
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.t = f32(s.t + dt);
      const ci = this.playerSlot[s.player];
      if (ci < 0) { this.shakes.splice(i, 1); continue; }
      const tx = this.slotMatrix(ci, root.frame)?.[4] ?? 0;
      if (s.t >= 0.12) {
        root.slot(ci).offset = [tx, s.y0];
        this.shakes.splice(i, 1);
      } else if (s.t >= 0) {
        const f = Math.min(1, Math.max(0, f32(s.t * 8.333334)));
        root.slot(ci).offset = [tx, f32(s.y0 + Math.sin(f * 6.2831855) * (6 - f * 6))];
      }
    }
  }

  /** Render-time advance of the clip tree (0x123f55c). */
  advance(dt: number): void {
    this.root.advance(dt);
  }

  private layout(stageW: number, stageH: number): void {
    const key = `${stageW}|${stageH}`;
    if (key === this.stageKey) return;
    this.stageKey = key;
    this.pos = [stageW * 0.5, stageH * 0.5];
    // dimmer_stretch: both axes (0x89a38c), the wrapped clip left at the wrapper's origin
    if (this.dimmer >= 0) {
      const sm = this.slotMatrix(this.dimmer, 0);
      const lib = this.root.lib;
      const id = this.root.clip.children[this.dimmer];
      const c = lib.clips.get(id);
      let b: [number, number, number, number] | null = null;
      if (c) {
        const bb = [Infinity, Infinity, -Infinity, -Infinity];
        const bm = lib.banks[c.bank].m;
        for (let i = c.frameStart[0]; i < c.frameStart[1]; i++) {
          const mi = c.elements[i * 3 + 1];
          const m = mi >= 0 ? Array.from(bm.subarray(mi * 6, mi * 6 + 6)) : [1, 0, 0, 1, 0, 0];
          for (const cmd of lib.shapes.get(c.children[c.elements[i * 3]]) ?? []) {
            for (let k = 0; k < cmd.verts.length; k += 4) {
              const x = m[0] * cmd.verts[k] + m[2] * cmd.verts[k + 1] + m[4];
              const y = m[1] * cmd.verts[k] + m[3] * cmd.verts[k + 1] + m[5];
              bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
            }
          }
        }
        if (bb[0] <= bb[2]) b = [bb[0], bb[1], bb[2], bb[3]];
      }
      if (sm && b) {
        const sx = Math.max(1, f32(stageW / f32((b[2] - b[0]) * Math.abs(sm[0]))));
        const sy = Math.max(1, f32(stageH / f32((b[3] - b[1]) * Math.abs(sm[3]))));
        this.root.slot(this.dimmer).inner = [sx, 0, 0, sy, 0, 0];
      }
    }
  }

  /** Draw in stage px at the stage centre. */
  draw(r: ScRenderer, stageW: number, stageH: number, ctx: DrawCtx): void {
    this.layout(stageW, stageH);
    this.root.draw(r, [1, 0, 0, 1, this.pos[0], this.pos[1]], WHITE as Col, ctx);
  }

  /** Stage-space bounds [x0, y0, x1, y1] of the OK button now, or null when it is not shown. */
  okBounds(): [number, number, number, number] | null {
    const root = this.root, ci = this.ok;
    if (ci < 0) return null;
    const kid = root.kids[ci];
    if (!kid || !kid.visible || !root.displayed().includes(ci)) return null;
    const sm = this.slotMatrix(ci, root.frame);
    if (!sm) return null;
    const m = matMul([1, 0, 0, 1, this.pos[0], this.pos[1]], sm);
    const lib = root.lib, c = kid.clip, bm = lib.banks[c.bank].m;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = c.frameStart[0]; i < c.frameStart[1]; i++) {
      const mi = c.elements[i * 3 + 1];
      const cm = matMul(m, mi >= 0 ? Array.from(bm.subarray(mi * 6, mi * 6 + 6)) as Mat : [1, 0, 0, 1, 0, 0]);
      for (const cmd of lib.shapes.get(c.children[c.elements[i * 3]]) ?? []) {
        for (let k = 0; k < cmd.verts.length; k += 4) {
          const x = cm[0] * cmd.verts[k] + cm[2] * cmd.verts[k + 1] + cm[4];
          const y = cm[1] * cmd.verts[k] + cm[3] * cmd.verts[k + 1] + cm[5];
          b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
        }
      }
    }
    return b[0] <= b[2] ? [b[0], b[1], b[2], b[3]] : null;
  }

  /** The OK button was hit at stage point (x, y) (it is a button once the root shows it). */
  hitOk(x: number, y: number): boolean {
    const b = this.okBounds();
    return !!b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }
}

/** Result kind for the HUD's player from the engine result (winner team, -1 draw). */
export function resultKind(winner: number, team: number): ResultKind {
  return winner < 0 ? 3 : winner === team ? 1 : 2;
}

// ------------------------------------------------------------------------------------------------
// The battle screen's part of both (0xbe1d3c, 0xbdfa8c, 0xbe0100), for sim/viewer/src/battle_ui.ts.

interface ScreensArt {
  manifest: { hud: { texts?: Record<string, string> } & { intro?: IntroArt; result?: ResultArt } };
  libs: { get(name: string): ScLibrary | undefined };
}

interface ScreensBattle {
  readonly result: { winner: number; tick: number } | null;
  readonly players: readonly { crowns: number }[];
  /** crowns at the end (Battle.endCrowns: the post-end world can still fell a tower) */
  readonly endCrowns?: readonly number[] | null;
}

/** Stage placement as sc/ui_port.ts stageLayout gives it. */
interface ScreensLayout { stageW: number; stageH: number; k: number }

export class BattleScreens {
  intro: BattleIntro | null = null;
  result: ResultScreen | null = null;
  /** the HUD's visibility (+8) as the intro block of 0xbe1d3c sets it */
  hudShown = true;
  private introDue = true;
  private readonly hudFlag = { on: false }; // battle screen +0x468
  /** a player queued a card play this battle (King tower +0x318 >= 1, 0xd3cb70) */
  private cardPlayed = false;

  /** New battle: the screen setup 0xbde180 makes the intro again. */
  reset(): void {
    this.intro = null;
    this.result = null;
    this.hudShown = true;
    this.introDue = true;
    this.hudFlag.on = false;
    this.cardPlayed = false;
  }

  /** Engine events of a tick: a committed play counts as the King tower's queued play (0xf9ea68). */
  onEvents(events: readonly { type: string }[]): void {
    if (!this.cardPlayed && events.some((e) => e.type === 'cast')) this.cardPlayed = true;
  }

  /**
   * One battle screen update: `dt` s of UI time, `simMs` = the viewer's simulation clock (ms; it runs on
   * past the last tick like the client's logic, which keeps ticking after the end, paused with the
   * battle), `team` = the HUD player's side, `opponentName` = the HUD's opponent name (A).
   */
  update(art: ScreensArt, dt: number, simMs: number, b: ScreensBattle, team: number, opponentName: string): void {
    const hud = art.manifest.hud;
    const texts = hud.texts ?? {};
    // 0xbde180 -> 0xbdfa8c: a battle joined at tick 0 gets the banner; +0x468 = 0x8c8140 (1)
    if (this.introDue && hud.intro) {
      const lib = art.libs.get(hud.intro.sc);
      if (lib) {
        this.introDue = false;
        if (lib.has(hud.intro.export)) {
          this.intro = new BattleIntro(lib, hud.intro, { player: texts.TID_YOU ?? '', enemy: opponentName });
          this.hudFlag.on = true;
        }
      }
    }
    // 0xbe1d3c: the intro's update 0x8ca764, deleted once its clip stopped
    if (this.intro) {
      this.intro.update(dt, this.cardPlayed);
      if (this.intro.done) this.intro = null;
    }
    const v = introHudVisible(this.hudFlag, this.intro);
    if (v !== null) this.hudShown = v;
    // the screen's own update (0x8c1b9c) runs earlier in 0xbe1d3c than its creation, so a new screen
    // is first updated by the next battle screen update
    this.result?.update(dt);
    // the end screen: logic ms since the end reach EndScreenDelay (0xd3581c), then 0xbe0100
    if (b.result && !this.result && hud.result) {
      // the end tick (result.tick) finishes at (tick + 1) * 50 ms; each later tick adds 50 ms to +0x198
      const ticks = Math.floor((simMs - (b.result.tick + 1) * 50) / 50 + 1e-6);
      const lib = art.libs.get(hud.result.sc);
      if (lib && lib.has(hud.result.export) && endScreenDue(ticks, hud.result.endScreenDelay)) {
        this.intro = null;
        // the crowns the end stored with the result (0xd3e360), not ones the post-end world added
        const crowns = b.endCrowns ?? b.players.map((p) => p.crowns);
        const own = crowns[team] ?? 0, opp = crowns[1 - team] ?? 0;
        this.result = new ResultScreen(lib, hud.result, {
          kind: resultKind(b.result.winner, team), ownCrowns: own, oppCrowns: opp,
          ownName: texts.TID_YOU ?? '', oppName: opponentName, noClan: texts.TID_NO_CLAN ?? '',
        });
      }
    }
    // the render advances the clip trees (0x123f55c)
    this.intro?.advance(dt);
    this.result?.advance(dt);
  }

  /**
   * Battle input blocked (0xbe4400) as far as these screens decide it: the intro before its
   * actionFrame, or the result screen. (0xbe4400 also blocks once the battle is over.)
   */
  get inputBlocked(): boolean {
    return (this.intro?.beforeAction ?? false) || this.result !== null;
  }

  /** The intro (game layer +0x168) and the result screen (layer +0x170, index 0), in stage px. */
  draw(r: ScRenderer, L: ScreensLayout, dpr: number, centreY: number, texts: Record<string, string>): void {
    if (!this.intro && !this.result) return;
    const k = L.k * dpr;
    r.setView(k, 0, 0, k, 0, 0);
    const ctx: DrawCtx = { texts };
    this.intro?.draw(r, { stageW: L.stageW, stageH: L.stageH, centreY: Math.trunc(centreY) }, ctx);
    this.result?.draw(r, L.stageW, L.stageH, ctx);
  }

  /** A click at board CSS px (x, y) hit the result screen's OK button. */
  okAt(x: number, y: number, L: ScreensLayout): boolean {
    return !!this.result && this.result.hitOk(x / L.k, y / L.k);
  }
}
