// Battle HUD drawn with the client's own exports and layout (libg 160402020), in stage space
// (sc/ui_port.ts stageLayout). Elements and where the client puts them:
//   HUD_player      (stageW / 2, stageH)  0x8d9d30 / 0x8da088: hand in `cardArea`, next card in
//                   `nextCard1`, elixir bar (0x8dbebc), `panel` replaced by panel_ingame_blue
//   HUD_topLeft     (0, 0)                0x8cf3b8: opponent name / clan
//   HUD_topRight    (stageW, 0)           0x8cf3b8 / 0x8d38c4: "Time left:" m:ss, overtime clip
//   HUD_rightMiddle (stageW, river y)     0x8cd4ec / 0x8d1e6c: crowns
//   HUD_taunt       (stageW / 2, stageH)  0x8cd4ec: emote button (not functional here)
import type { Battle } from '../../core/src/index.ts';
import type { Col, Mat } from './sc/math.ts';
import { matMul, WHITE } from './sc/math.ts';
import type { BattleArt } from './sc/battle_art.ts';
import type { ScLibrary } from './sc/library.ts';
import type { DrawOptions, ScRenderer } from './sc/renderer.ts';
import { ClipPlayer } from './sc/anim.ts';
import { cardRaise, cardSlot, ElixirBar, type StageLayout, stageLayout, uiEase } from './sc/ui_port.ts';

type Rect = [number, number, number, number];

/** A named child of an export's frame 0: its matrix and its bounds in the parent's space. */
interface ChildInfo { m: Mat; bounds: Rect | null; textRect: Rect | null }

function childInfo(lib: ScLibrary, exportName: string, path: string[]): ChildInfo | null {
  let clip = lib.clip(exportName);
  let acc: Mat = [1, 0, 0, 1, 0, 0];
  let info: ChildInfo | null = null;
  for (let p = 0; p < path.length; p++) {
    if (!clip) return null;
    let found = false;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== path[p]) continue;
      const mi = clip.elements[i * 3 + 1];
      const bm = lib.banks[clip.bank].m;
      const m: Mat = mi >= 0 ? [...bm.subarray(mi * 6, mi * 6 + 6)] as Mat : [1, 0, 0, 1, 0, 0];
      const cid = clip.children[ci];
      const last = p === path.length - 1;
      if (last) {
        const tf = lib.textFields.get(cid);
        const local = boundsOf(lib, cid);
        info = {
          m, bounds: local ? xform(m, local) : null,
          textRect: tf ? xform(m, tf.rect as Rect) : null,
        };
        acc = matMul(acc, m);
      } else {
        acc = matMul(acc, m);
        clip = lib.clips.get(cid);
      }
      found = true;
      break;
    }
    if (!found) return null;
  }
  return info;
}

function boundsOf(lib: ScLibrary, id: number): Rect | null {
  // ScLibrary.frameBounds works on exports; build the same union for an inner id
  const b: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (cid: number, m: Mat, depth: number): void => {
    if (depth > 16) return;
    const sh = lib.shapes.get(cid);
    if (sh) {
      for (const cmd of sh) {
        const v = cmd.verts;
        for (let i = 0; i < v.length; i += 4) {
          const x = m[0] * v[i] + m[2] * v[i + 1] + m[4], y = m[1] * v[i] + m[3] * v[i + 1] + m[5];
          if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
        }
      }
      return;
    }
    const c = lib.clips.get(cid);
    if (!c) return;
    const bm = lib.banks[c.bank].m;
    for (let i = c.frameStart[0]; i < c.frameStart[1]; i++) {
      const mi = c.elements[i * 3 + 1];
      const cm: Mat = mi >= 0 ? [...bm.subarray(mi * 6, mi * 6 + 6)] as Mat : [1, 0, 0, 1, 0, 0];
      visit(c.children[c.elements[i * 3]], matMul(m, cm), depth + 1);
    }
  };
  visit(id, [1, 0, 0, 1, 0, 0], 0);
  return b[0] <= b[2] ? b : null;
}

function xform(m: Mat, r: Rect): Rect {
  const xs = [m[0] * r[0] + m[2] * r[1] + m[4], m[0] * r[2] + m[2] * r[3] + m[4], m[0] * r[0] + m[2] * r[3] + m[4], m[0] * r[2] + m[2] * r[1] + m[4]];
  const ys = [m[1] * r[0] + m[3] * r[1] + m[5], m[1] * r[2] + m[3] * r[3] + m[5], m[1] * r[0] + m[3] * r[3] + m[5], m[1] * r[2] + m[3] * r[1] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Per-card hand state: selection raise timer (+0x320), the card shown and its cycle animation
 * (0x8e1408: from the next-card slot over +0x354 = 0.375 s, started by 0x8e0a80 / 0x8e0aa8). */
interface CardState { card: number; raiseT: number; selected: boolean; t: number; dur: number }

export interface HudDrag {
  slot: number;
  card: string;
  /** stage position of the pointer */
  x: number;
  y: number;
  /** card visual scale/alpha while it shrinks toward the arena (0x8e1fb8), 0 = hidden */
  cardScale: number;
  /** grab offset: card origin - pointer at the touch (stage px) */
  gx: number;
  gy: number;
}

export class Hud {
  readonly art: BattleArt;
  layout: StageLayout = stageLayout(400, 800);
  /** whose hand and elixir the bottom HUD shows */
  team: 0 | 1 = 0;
  readonly elixir = new ElixirBar(10);
  selected = -1;
  drag: HudDrag | null = null;
  opponentName = 'Opponent';
  private cards: CardState[] = [0, 1, 2, 3].map((i) => ({ card: -1, raiseT: 1, selected: false, t: -(i * 0.18 + 0.6), dur: 0.375 }));
  private cardH = 198;
  private area: Rect | null = null;
  private next: Rect | null = null;
  private bar: { len: number; body: ChildInfo; end: ChildInfo; ghost: ChildInfo; tip: ChildInfo | null;
    flow: ChildInfo | null; dividers: ChildInfo[] } | null = null;
  private amountTxt: Mat | null = null;
  private tip = new ClipPlayer(1, 30);
  private flow = new ClipPlayer(1, 30);
  private warning = new ClipPlayer(1, 30);
  private tipVisible = false;
  private crowns: [number, number] = [0, 0];
  private stars: [ClipPlayer, ClipPlayer] = [new ClipPlayer(1, 30), new ClipPlayer(1, 30)];
  private ot = new ClipPlayer(1, 30);
  private topRight = new ClipPlayer(1, 30);
  private wasOvertime = false;

  constructor(art: BattleArt) {
    this.art = art;
    const ui = this.ui;
    if (!ui) return;
    const cb = ui.frameBounds('spell_card_ingame', 0);
    if (cb) this.cardH = cb[3] - cb[1];
    this.area = childInfo(ui, 'HUD_player', ['cardArea'])?.textRect ?? null;
    this.next = childInfo(ui, 'HUD_player', ['nextCard1'])?.textRect ?? null;
    const p = (n: string) => childInfo(ui, 'HUD_player', ['elixir_bar', n]);
    const bg = p('bar_bg'), body = p('bar_body'), end = p('bar_end'), ghost = p('ghost');
    if (bg?.bounds && body?.bounds && end?.bounds && ghost?.bounds) {
      const dividers: ChildInfo[] = [];
      for (let i = 1; i <= 9; i++) { const d = p(`d${i}`); if (d) dividers.push(d); }
      this.bar = { len: bg.bounds[2] - bg.bounds[0], body, end, ghost, tip: p('bar_tip'), flow: p('bar_flow'), dividers };
    }
    this.amountTxt = childInfo(ui, 'HUD_player', ['elixir_bar', 'elixirBarLeftNumbers', 'elixirAmount', 'txt'])?.m ?? null;
    this.tip = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_bar', 'bar_tip']), 30);
    this.flow = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_bar', 'bar_flow']), 30);
    this.warning = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_warning']), 30);
    this.stars = [new ClipPlayer(this.childFrames(ui, 'HUD_rightMiddle', ['crowns_blue', 'starPlayer']), 30),
      new ClipPlayer(this.childFrames(ui, 'HUD_rightMiddle', ['crowns_red', 'starEnemy']), 30)];
    this.topRight = new ClipPlayer(ui.frameCount('HUD_topRight'), ui.fps('HUD_topRight'));
    this.ot = new ClipPlayer(ui.frameCount('HUD_topRight_overtime'), ui.fps('HUD_topRight_overtime'));
    this.topRight.gotoAndStop(0);
    this.ot.gotoAndStop(0);
  }

  private get ui(): ScLibrary | undefined { return this.art.libs.get(this.art.manifest.hud.sc); }

  private childFrames(lib: ScLibrary, exportName: string, path: string[]): number {
    let clip = lib.clip(exportName);
    for (const name of path) {
      if (!clip) return 1;
      let next: ReturnType<ScLibrary['clip']>;
      for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
        const ci = clip.elements[i * 3];
        if (clip.names?.[ci] === name) { next = lib.clips.get(clip.children[ci]); break; }
      }
      clip = next!;
    }
    return clip?.frameCount ?? 1;
  }

  private text(id: string, vars: Record<string, string | number> = {}): string {
    let s = this.art.manifest.hud.texts?.[id] ?? '';
    for (const [k, v] of Object.entries(vars)) s = s.replace(`<${k}>`, String(v));
    return s;
  }

  resize(cssW: number, cssH: number): void {
    this.layout = stageLayout(cssW, cssH);
  }

  /** CSS px (relative to the canvas) -> stage px. */
  toStage(x: number, y: number): [number, number] {
    return [x / this.layout.k, y / this.layout.k];
  }

  /** HUD_player origin on the stage. */
  private get playerOrigin(): [number, number] {
    return [this.layout.stageW * 0.5, this.layout.stageH];
  }

  /** Stage position and scale of hand slot i (with the selection raise). */
  slotPos(i: number): { x: number; y: number; s: number } | null {
    if (!this.area) return null;
    const [ox, oy] = this.playerOrigin;
    const p = cardSlot(this.area, i, this.cardH);
    const c = this.cards[i];
    if (c.t < c.dur && this.next) {
      // cycle-in from the next card (0x8e1408): x eases with overshoot, y and scale lerp over 4x the time
      if (c.t < 0) return null;
      const nr = this.next;
      const fx = (nr[0] + nr[2]) / 2, fy = (nr[1] + nr[3]) / 2;
      const fs = (nr[3] - nr[1]) / 1.34 / this.cardH;
      const k = Math.max(0, Math.min(1, c.t / c.dur)), k4 = Math.max(0, Math.min(1, (c.t * 4) / c.dur));
      const x = uiEase(fx, p.x, k, 1 / 3, 20, 2 / 3);
      return { x: ox + x, y: oy + fy + k4 * (p.y - fy), s: fs + k4 * (p.s - fs) };
    }
    const y = cardRaise(p.y, c.raiseT, c.selected);
    return { x: ox + p.x, y: oy + y, s: p.s };
  }

  /** Hand slot under a stage point, or -1. */
  cardAt(x: number, y: number): number {
    const ui = this.ui;
    const b = ui?.frameBounds('spell_card_ingame', 0);
    if (!b) return -1;
    for (let i = 0; i < 4; i++) {
      const p = this.slotPos(i);
      if (!p) continue;
      if (x >= p.x + b[0] * p.s && x <= p.x + b[2] * p.s && y >= p.y + b[1] * p.s && y <= p.y + b[3] * p.s) return i;
    }
    return -1;
  }

  /** Stage y of the top of the hand area (pointer above it = over the arena). */
  get handTop(): number {
    const [, oy] = this.playerOrigin;
    return this.area ? oy + this.area[1] : this.layout.stageH;
  }

  /** New battle: cards cycle in again with the start delays (0x8e0aa8: 0.6 + 0.18 i s). */
  reset(): void {
    this.cards = [0, 1, 2, 3].map((i) => ({ card: -1, raiseT: 1, selected: false, t: -(i * 0.18 + 0.6), dur: 0.375 }));
    this.selected = -1;
    this.drag = null;
    this.elixir.last = 0;
    this.elixir.timer = 0;
    this.elixir.fill = 0;
    this.crowns = [0, 0];
  }

  select(slot: number): void {
    for (let i = 0; i < 4; i++) {
      const sel = i === slot;
      if (this.cards[i].selected !== sel) { this.cards[i].selected = sel; this.cards[i].raiseT = 0; }
    }
    this.selected = slot;
  }

  update(dt: number, b: Battle): void {
    const p = b.players[this.team];
    const whole = Math.max(0, Math.min(10, Math.floor((p.elixir - p.pending) / 10000)));
    const hundredths = Math.max(0, Math.min(1000, Math.floor((p.elixir - p.pending) / 100)));
    this.elixir.update(dt, whole, hundredths);
    if (this.elixir.tipAt !== null) { this.tip.playRange(0, this.tip.frames - 1, false); this.tipVisible = true; }
    if (this.elixir.flowStarted) { this.flow.playRange(0, this.flow.frames - 1, true); this.warning.playRange(0, this.warning.frames - 1, false); }
    this.tip.advance(dt);
    if (this.tipVisible && !this.tip.playing) this.tipVisible = false;
    this.flow.advance(dt);
    this.warning.advance(dt);
    for (let i = 0; i < 4; i++) {
      const c = this.cards[i];
      c.raiseT += dt;
      const di = p.hand[i];
      if (c.card !== di) {
        // a new card in this slot cycles in from the next-card position (battle start keeps its delay)
        if (c.card !== -1) c.t = -0;
        c.card = di;
      }
      if (c.t < c.dur) c.t += dt;
    }
    for (let t = 0; t < 2; t++) {
      const cr = b.players[t === 0 ? this.team : 1 - this.team].crowns;
      if (cr !== this.crowns[t]) { this.crowns[t] = cr; this.stars[t].playRange(0, this.stars[t].frames - 1, false); }
      this.stars[t].advance(dt);
    }
    const ot = b.tick >= b.regulationTicks;
    if (ot !== this.wasOvertime) {
      this.wasOvertime = ot;
      const ui = this.ui;
      if (ui && ot) {
        const l = ui.labels('HUD_topRight'), lo = ui.labels('HUD_topRight_overtime');
        this.topRight.playRange(l.out_start ?? 0, l.out_end ?? this.topRight.frames - 1, false);
        this.ot.playRange(lo.in_start ?? 0, lo.in_end ?? this.ot.frames - 1, false);
      }
    }
    this.topRight.advance(dt);
    this.ot.advance(dt);
  }

  /**
   * Draw the HUD in stage space. `riverY` = stage y of the arena centre (0xbdf674 projects logic
   * (9000, 16000) for HUD_rightMiddle).
   */
  draw(r: ScRenderer, b: Battle, dpr: number, riverY: number): void {
    const ui = this.ui;
    if (!ui) return;
    const L = this.layout;
    const k = L.k * dpr;
    r.setView(k, 0, 0, k, 0, 0);
    const p = b.players[this.team];
    // top left: opponent
    r.draw(ui, 'HUD_topLeft', 0, [1, 0, 0, 1, 0, 0], WHITE, {
      named: { darken: { hide: true }, enemyTrophies: { hide: true }, enemyRankedRating: { hide: true },
        enemyRankedLeague: { hide: true }, clan_icon: { hide: true } },
      text: { enemyName: this.opponentName, enemyClan: this.text('TID_NO_CLAN') },
    });
    // top right: time left / overtime
    const reg = b.regulationTicks;
    const ot = b.tick >= reg;
    const leftMs = Math.max(0, ((ot ? reg + b.overtimeTicks : reg) - b.tick) * 50);
    const secs = Math.floor((leftMs + 999) / 1000);
    const ss = secs % 60 < 10 ? `0${secs % 60}` : String(secs % 60);
    const time = this.text('TID_TIME_M_S', { M: Math.floor(secs / 60), S: ss }) || `${Math.floor(secs / 60)}:${ss}`;
    // last 30 s: the time's green/blue multipliers follow the second's parity (red on even seconds)
    const red = secs < 31 && (secs & 1) === 0;
    const timeCol: Col | undefined = red ? [1, 0, 0, 1, 0, 0, 0] : undefined;
    const rate = b.elixirPerTick() / 178;
    const regen = rate >= 1.1;
    const trOpts = (): DrawOptions => ({
      named: { timeLeft: { color: timeCol }, elixirRegen: { hide: !regen } },
      text: { timeLeft: time, TID_TIME_LEFT: this.text('TID_TIME_LEFT'), TID_OVERTIME: this.text('TID_OVERTIME') },
    });
    if (!ot || this.topRight.playing) r.draw(ui, 'HUD_topRight', this.topRight.frame, [1, 0, 0, 1, L.stageW, 0], WHITE, trOpts());
    if (ot) r.draw(ui, 'HUD_topRight_overtime', this.ot.frame, [1, 0, 0, 1, L.stageW, 0], WHITE, trOpts());
    // right middle: crowns at the river line
    r.draw(ui, 'HUD_rightMiddle', 0, [1, 0, 0, 1, L.stageW, riverY], WHITE, {
      named: {
        cheer_button_blue: { hide: true }, cheer_button_red: { hide: true },
        starPlayer: { frame: this.stars[0].frame }, starEnemy: { frame: this.stars[1].frame },
      },
      text: { scorePlayer: String(this.crowns[0]), scoreEnemy: String(this.crowns[1]) },
    });
    // bottom: HUD_player
    const [ox, oy] = this.playerOrigin;
    const hm: Mat = [1, 0, 0, 1, ox, oy];
    const named: NonNullable<DrawOptions['named']> = {
      darken: { hide: true }, ability_location: { hide: true }, NextSpellTimer: { hide: true },
      panel: { lib: ui, export: 'panel_ingame_blue', frame: 0 },
      bar_refund: { hide: true },
      elixir_warning: { frame: this.warning.frame },
    };
    const bar = this.bar;
    if (bar) {
      const E = this.elixir;
      const endW = bar.end.bounds![2] - bar.end.bounds![0];
      const bodyW0 = bar.body.bounds![2] - bar.body.bounds![0];
      const ghostW0 = bar.ghost.bounds![2] - bar.ghost.bounds![0];
      const fillW = (bar.len - endW) * E.fill;
      named.bar_body = { matrix: [Math.max(1e-4, fillW / bodyW0), 0, 0, 1, 0, 0] };
      const right = bar.body.bounds![0] + fillW;
      named.bar_end = { matrix: [1, 0, 0, 1, (right - bar.end.m[4]) / bar.end.m[0], 0] };
      named.ghost = { matrix: [Math.max(1e-4, (bar.len * E.ghost) / ghostW0), 0, 0, 1, 0, 0] };
      bar.dividers.forEach((d, i) => {
        named[`d${i + 1}`] = { matrix: [1, 0, 0, 1, ((bar.len * (i + 1)) / 10 - d.m[4]) / d.m[0], 0] };
      });
      if (bar.tip && this.tipVisible) {
        const x = this.elixir.last / 10 * bar.len + 2 + bar.body.m[4];
        named.bar_tip = { frame: this.tip.frame, matrix: [1, 0, 0, 1, (x - bar.tip.m[4]) / bar.tip.m[0], 0] };
      } else named.bar_tip = { hide: true };
      named.bar_flow = E.full ? { frame: this.flow.frame } : { hide: true };
      const sel = this.selected >= 0 ? b.players[this.team].deck[p.hand[this.selected]] : null;
      named.elixirRequirementBar = sel ? { frame: Math.max(0, Math.min(10, sel.cost)) } : { hide: true };
      if (this.amountTxt) {
        const [tx, ty] = [this.amountTxt[4], this.amountTxt[5]];
        named.elixirAmount = { matrix: [E.textScaleX, 0, 0, E.textScaleY, tx - tx * E.textScaleX, ty - ty * E.textScaleY] };
      }
    }
    r.draw(ui, 'HUD_player', 0, hm, WHITE, {
      named,
      text: {
        elixirAmount: String(this.elixir.last), TID_NEXT_CARD: this.text('TID_NEXT_CARD'),
        TID_MAX_ELIXIR: this.text('TID_MAX_ELIXIR', { MAX_MANA: 10 }),
      },
    });
    // next card (nextCard1: scaled to the rect height / (card item height * 1.34), 0x8da088)
    if (this.next) {
      const nr = this.next;
      const card = p.deck[p.queue[0]]?.name;
      const s = (nr[3] - nr[1]) / 1.34 / this.cardH;
      const cx = (nr[0] + nr[2]) / 2, cy = (nr[1] + nr[3]) / 2;
      const cb = ui.frameBounds('spell_card_ingame', 0);
      const mid = cb ? (cb[1] + cb[3]) / 2 : 0;
      if (card) this.art.drawCard(r, card, matMul(hm, [s, 0, 0, s, cx, cy - mid * s]), { noCost: true });
    }
    // hand: the elixir the cards see (0xfa1d10) is (elixir − pending plays, at most MAX_MANA) / 100,
    // 0 below 1; a card is playable at cost · 100, else its RadialFill shows shown / (cost · 100)
    // (0x8dc37c → 0x8e1408 → 0x89fd04)
    const avail = p.elixir - p.pending;
    const shown = avail < 1 ? 0 : Math.trunc(Math.min(avail, b.maxElixir) / 100);
    for (let i = 0; i < 4; i++) {
      const def = p.deck[p.hand[i]];
      const pos = this.slotPos(i);
      if (!def || !pos) continue;
      if (this.drag && this.drag.slot === i) continue; // drawn at the pointer
      const need = def.cost * 100;
      const ok = b.infiniteElixir || shown >= need;
      const ready = b.tick >= p.slotReady[i];
      this.art.drawCard(r, def.name, [pos.s, 0, 0, pos.s, pos.x, pos.y], { dim: !ok || !ready, fill: ok ? null : shown / need });
    }
    // emote button
    r.draw(ui, 'HUD_taunt', 0, [1, 0, 0, 1, L.stageW * 0.5, L.stageH], WHITE, {
      named: { buttons: { frame: 0 }, mute_btn: { hide: true }, muted: { hide: true } },
    });
    // dragged card following the pointer (0x8e1fb8: scale/alpha shrink toward the arena)
    if (this.drag && this.drag.cardScale > 0) {
      const d = this.drag;
      const pos = this.slotPos(d.slot);
      const s = (pos?.s ?? 0.64) * d.cardScale;
      // card visual at the pointer plus the grab offset scaled with the card (0x8e1fb8 +0x2c8/+0x2cc)
      this.art.drawCard(r, d.card, [s, 0, 0, s, d.x + d.gx * d.cardScale, d.y + d.gy * d.cardScale], { alpha: d.cardScale });
    }
  }
}
