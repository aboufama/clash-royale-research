// Battle HUD drawn with the client's own exports and layout (libg 160402020), in stage space
// (sc/ui_port.ts stageLayout). Elements and where the client puts them:
//   HUD_player      (stageW / 2, stageH)  0x8d9d30 / 0x8da088: hand in `cardArea`, next card in
//                   `nextCard1`, elixir bar (0x8dbebc), `panel` replaced by panel_ingame_blue
//   HUD_topLeft     (0, 0)                0x8cf3b8: opponent name / clan
//   HUD_topRight    (stageW, 0)           0x8cf3b8 / 0x8d38c4: "Time left:" m:ss, overtime clip, elixir badge
//   HUD_rightMiddle (stageW, river y)     0x8cd4ec / 0x8d1e6c: crowns, faded in while a crown flies
//   HUD_taunt       (stageW / 2, stageH)  0x8cd4ec: emote button (not functional here)
//   crown flights   HUD children          0x8d0dd8 / 0x8d2de0 (sc/crown_fly.ts), effects.sc star_appear*
// Both `darken` backdrops (HUD_topLeft, HUD_player) show only at graphics level 2 (setting +0x198 of
// 0x770758, 0x8cf3b8 / 0x8da088); the viewer assumes that level, as for the location clouds (A).
import { type Battle, ST_DEAD, type Unit } from '../../core/src/index.ts';
import type { Col, Mat } from './sc/math.ts';
import { matMul, WHITE } from './sc/math.ts';
import type { BattleArt } from './sc/battle_art.ts';
import type { ScLibrary } from './sc/library.ts';
import type { DrawOptions, ScRenderer } from './sc/renderer.ts';
import { ClipPlayer } from './sc/anim.ts';
import { CrownFly, CrownPanelFade, crownTowerGone } from './sc/crown_fly.ts';
import {
  barTipX, type CardStart, cardEntry, cardRaise, cardSlot, dropWaitStep, elixirDropXs, ElixirBar, HandCard, HandWiggle,
  nextCardTimer, PanelFlash, refundBar, regenBadgeText, rotScale, spellInstanceId, type StageLayout, stageLayout, UiBar,
} from './sc/ui_port.ts';

type Rect = [number, number, number, number];

const f32 = Math.fround;

/**
 * The battle phase's visible elixir rate x10 (0xd56780 via 0xd56070: the battle_timelines row's
 * ElixirRateVisible for the ElixirRateLength phase the match time is in), as sc/announce.ts reads it.
 */
function elixirRateX10(b: Battle): number {
  const raw = (b.timeline?.raw ?? {}) as Record<string, unknown>;
  const lens = (raw.ElixirRateLength as number[] | undefined) ?? [];
  const rates = (raw.ElixirRateVisible as number[] | undefined) ?? [];
  const sec = (b.tick * 50) / 1000;
  let i = 0, t = 0;
  while (i < lens.length - 1 && sec >= t + lens[i]) { t += lens[i]; i++; }
  return rates[i] ?? Math.round((b.elixirPerTick() / 178) * 10);
}

/** A named child of an export's frame 0: its matrix, its bounds in the parent's space and in its own. */
interface ChildInfo { m: Mat; bounds: Rect | null; local: Rect | null; textRect: Rect | null }

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
          m, bounds: local ? xform(m, local) : null, local,
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

/** The four hand cards as the HUD setup 0x8da088 deals them: entry 0.375 s, delays 0.6 + 0.18 i s. */
function dealHand(): HandCard[] {
  return [0, 1, 2, 3].map((i) => { const c = new HandCard(); c.deal(0.375, i * 0.18 + 0.6); return c; });
}

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
  /** a card released before it was affordable, still in drag mode while it waits (0x8e2c04 +0x324) */
  held: HudDrag | null = null;
  /**
   * Called from the hand update when a waiting card's time is up or it became affordable (0x8e1408 ->
   * 0x8e29f4): the owner releases it at its touch-end point now.
   */
  onRelease: ((slot: number) => void) | null = null;
  /** full-elixir hand shake (HUD +0x280) */
  readonly wiggle = new HandWiggle();
  opponentName = 'Opponent';
  private cards: HandCard[] = dealHand();
  /** hand card height at scale 1 (card_item_frame, see cardSlot) and its bounds (hit test) */
  private cardH = 160.35;
  private cardBounds: Rect | null = null;
  private area: Rect | null = null;
  private next: Rect | null = null;
  /**
   * Elixir bar geometry (0x8da088): the main bar (bar_body + bar_end) and the ghost, both 0x8b2368 bars
   * of length = bar_bg's width, and the refund bar (bar_refund's bar_body_refund / bar_end_refund).
   */
  private bar: { len: number; body: ChildInfo; end: ChildInfo; ghost: ChildInfo; tip: ChildInfo | null;
    flow: ChildInfo | null; dividers: ChildInfo[]; main: UiBar; ghostBar: UiBar;
    refund: { body: ChildInfo; end: ChildInfo; bar: UiBar } | null } | null = null;
  /** elixir_bar's position in HUD_player (+0x1a8 +0x20 / +0x24), where the spend drops start (0x8dcbf4) */
  private barPos: [number, number] | null = null;
  private amountTxt: Mat | null = null;
  /** HUD_player with every top-level child but NextSpellTimer hidden */
  private timerOnly: NonNullable<DrawOptions['named']> | null = null;
  private tip = new ClipPlayer(1, 30);
  private flow = new ClipPlayer(1, 30);
  private warning = new ClipPlayer(1, 30);
  private tipVisible = false;
  /** bar_tip x in elixir_bar space at the last change (0x8dbebc) */
  private tipX = 0;
  /** Elixir_bar_drop_anim clips of the spends (HUD_player children, list +0x190) */
  private drops: { x: number; clip: ClipPlayer }[] = [];
  /** hand panels hidden (the result screen, 0xbe0100 -> 0x8d5ff8) */
  handHidden = false;
  /** HUD_player's additive flash of an elixir gain (0x8dce48 / 0x8db8e0) */
  readonly flash = new PanelFlash();
  /** counter texts: crowns minus the flights of that side in the air (0x8d2de0), [player, enemy] */
  private scores: [number, number] = [0, 0];
  private stars: [ClipPlayer, ClipPlayer] = [new ClipPlayer(1, 30), new ClipPlayer(1, 30)];
  /** crown flights (0x8d0dd8), built on the first update of a battle; null until then */
  private flies: { team: number; unit: Unit; king: boolean; x: number; y: number; fly: CrownFly }[] | null = null;
  private fliesTeam = -1;
  private fliesBattle: Battle | null = null;
  /** HUD_rightMiddle's alpha (0x8d1e6c) */
  readonly crownFade = new CrownPanelFade();
  /**
   * Logic -> stage px, truncated (0x8583bc); set by the owner (battle_ui.ts). The crown flights start at
   * the projected tower and HUD_rightMiddle sits at the projected arena centre.
   */
  project: ((x: number, y: number) => [number, number]) | null = null;
  private ot = new ClipPlayer(1, 30);
  private topRight = new ClipPlayer(1, 30);
  private wasOvertime = false;
  /** elixirRegen of HUD_topRight [0] and HUD_topRight_overtime [1] (0x8d38c4 +0x180) */
  private regen: { visible: boolean; clip: ClipPlayer; text: string }[] = [];
  /** the time update's previous seconds (+0x288) and visible elixir rate (+0x370) */
  private prevSecs = -1;
  private prevRate = 0;

  constructor(art: BattleArt) {
    this.art = art;
    const ui = this.ui;
    if (!ui) return;
    const cb = ui.frameBounds('card_item_frame', 0);
    if (cb) { this.cardH = cb[3] - cb[1]; this.cardBounds = cb as Rect; }
    this.area = childInfo(ui, 'HUD_player', ['cardArea'])?.textRect ?? null;
    this.next = childInfo(ui, 'HUD_player', ['nextCard1'])?.textRect ?? null;
    const eb = childInfo(ui, 'HUD_player', ['elixir_bar']);
    if (eb) this.barPos = [eb.m[4], eb.m[5]];
    const p = (n: string) => childInfo(ui, 'HUD_player', ['elixir_bar', n]);
    const bg = p('bar_bg'), body = p('bar_body'), end = p('bar_end'), ghost = p('ghost');
    if (bg?.bounds && body?.bounds && body.local && end?.bounds && ghost?.bounds && ghost.local) {
      const dividers: ChildInfo[] = [];
      for (let i = 1; i <= 9; i++) { const d = p(`d${i}`); if (d) dividers.push(d); }
      const len = bg.bounds[2] - bg.bounds[0];
      const uiBar = (c: ChildInfo, endW: number) => new UiBar(len, { x: c.m[4], scale: c.m[0], x0: c.local![0], x1: c.local![2] }, endW);
      // bar_refund (0x8da088 +0x1f0, stopped on frame 0, hidden) and its bar of the same length (+0x1c0)
      const rb = childInfo(ui, 'HUD_player', ['elixir_bar', 'bar_refund', 'bar_body_refund']);
      const re = childInfo(ui, 'HUD_player', ['elixir_bar', 'bar_refund', 'bar_end_refund']);
      const refund = rb?.local && re?.bounds ? { body: rb, end: re, bar: uiBar(rb, re.bounds[2] - re.bounds[0]) } : null;
      this.bar = { len, body, end, ghost, tip: p('bar_tip'), flow: p('bar_flow'), dividers,
        main: uiBar(body, end.bounds[2] - end.bounds[0]), ghostBar: uiBar(ghost, 0), refund };
    }
    this.amountTxt = childInfo(ui, 'HUD_player', ['elixir_bar', 'elixirBarLeftNumbers', 'elixirAmount', 'txt'])?.m ?? null;
    const hp = ui.clip('HUD_player');
    if (hp?.names) {
      const only: NonNullable<DrawOptions['named']> = {};
      let named = true;
      for (let i = hp.frameStart[0]; i < hp.frameStart[1]; i++) {
        const n = hp.names[hp.elements[i * 3]];
        if (!n) named = false;
        else if (n !== 'NextSpellTimer') only[n] = { hide: true };
      }
      if (named) this.timerOnly = only;
    }
    this.tip = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_bar', 'bar_tip']), 30);
    this.flow = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_bar', 'bar_flow']), 30);
    this.warning = new ClipPlayer(this.childFrames(ui, 'HUD_player', ['elixir_warning']), 30);
    // 0x8da088: bar_tip and elixir_warning stopped (+0x4d = 2) on frame 0 until 0x8dbebc plays them
    this.tip.gotoAndStop(0);
    this.warning.gotoAndStop(0);
    // HUD init 0x8cd4ec: starEnemy / starPlayer stopped (+0x4d = 2) on frame 0
    this.stars = [new ClipPlayer(this.childFrames(ui, 'HUD_rightMiddle', ['crowns_blue', 'starPlayer']), 30),
      new ClipPlayer(this.childFrames(ui, 'HUD_rightMiddle', ['crowns_red', 'starEnemy']), 30)];
    for (const s of this.stars) s.gotoAndStop(0);
    this.topRight = new ClipPlayer(ui.frameCount('HUD_topRight'), ui.fps('HUD_topRight'));
    this.ot = new ClipPlayer(ui.frameCount('HUD_topRight_overtime'), ui.fps('HUD_topRight_overtime'));
    this.topRight.gotoAndStop(0);
    this.ot.gotoAndStop(0);
    // elixirRegen: hidden and stopped (0x8cf3b8, and 0x8d38c4 for the overtime clip's)
    this.regen = ['HUD_topRight', 'HUD_topRight_overtime'].map((e) => {
      const clip = new ClipPlayer(this.childFrames(ui, e, ['elixirRegen']), 30);
      clip.gotoAndStop(0);
      return { visible: false, clip, text: '' };
    });
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

  /**
   * Start transform of every entry (0x8e0a80 from the HUD setup 0x8da088): the next card's position
   * (nextCard1's middle, set by vt+0x28 before the hand is built) and scale x / y = next card width /
   * card width and height / card height. The next card holds no card yet when the setup measures it
   * (its card is set by the first hand update 0x8dc37c -> 0x909fbc), so its bounds collapse to its
   * position (0x125a0f4 with nothing drawn) and both scales are 0: a new card grows from that point.
   */
  private get entryStart(): CardStart | null {
    const nr = this.next;
    if (!nr) return null;
    return { x: (nr[0] + nr[2]) / 2, y: (nr[1] + nr[3]) / 2, sx: 0, sy: 0 };
  }

  /**
   * Stage position and scale of hand slot i (entry animation or selection raise), or null while the
   * card is not shown (empty slot, hidden after a play, before its battle-start delay).
   */
  slotPos(i: number): { x: number; y: number; s: number } | null {
    if (!this.area) return null;
    const c = this.cards[i];
    if (!c.visible) return null;
    const [ox, oy] = this.playerOrigin;
    const p = cardSlot(this.area, i, this.cardH);
    const from = this.entryStart;
    if (c.t < c.dur && from) {
      const e = cardEntry(c.t, c.dur, from, p.x, p.y, p.s);
      if (!e) return null;
      return { x: ox + e.x, y: oy + e.y, s: e.sx };
    }
    const y = cardRaise(p.y, c.raiseT, c.selected);
    return { x: ox + p.x, y: oy + y, s: p.s };
  }

  /**
   * Linear part of hand card i's matrix: its scale (slotPos), or while the card is in the full-elixir
   * wiggle list the list's rotation at the stored scale (0x907ab0 runs after the card updates).
   */
  private cardLinear(i: number, s: number): [number, number, number, number] {
    const w = this.wiggle.of(i);
    return w ? rotScale(w.deg, w.sx, w.sy) : [s, 0, 0, s];
  }

  /** Hand card i's matrix in stage space, or null while it is not shown. */
  slotMatrix(i: number): Mat | null {
    const p = this.slotPos(i);
    if (!p) return null;
    const [a, b, c, d] = this.cardLinear(i, p.s);
    return [a, b, c, d, p.x, p.y];
  }

  /** The card held by the pointer or waiting for elixir in slot i, if any. */
  private dragOf(i: number): HudDrag | null {
    if (this.drag?.slot === i) return this.drag;
    if (this.held?.slot === i) return this.held;
    return null;
  }

  /** Hand slot under a stage point, or -1. */
  cardAt(x: number, y: number): number {
    const b = this.cardBounds;
    if (!b) return -1;
    for (let i = 0; i < 4; i++) {
      const p = this.slotPos(i);
      // a dragged or waiting card is at the pointer (0x8e1fb8 moves the card itself), not in its slot
      if (!p || this.dragOf(i)) continue;
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
    this.cards = dealHand();
    this.selected = -1;
    this.drag = null;
    this.held = null;
    this.wiggle.reset();
    // 0x8da088: +0x260 = -1 (the first update's rise past 1 shows the refund flash)
    this.elixir.last = -1;
    this.elixir.timer = 0;
    this.elixir.fill = 0;
    this.elixir.refundShown = false;
    this.elixir.refundT = 0;
    this.tipVisible = false;
    this.drops = [];
    this.flash.t = 0;
    this.flash.add = 0;
    // a new battle screen: new HUD (0x8cd4ec: HUD_rightMiddle alpha 0, stars stopped) and new flights
    this.scores = [0, 0];
    this.flies = null;
    this.crownFade.alphaByte = 0;
    this.crownFade.hold = 0;
    for (const s of this.stars) s.gotoAndStop(0);
    for (const r of this.regen) { r.visible = false; r.clip.gotoAndStop(0); r.text = ''; }
    this.prevSecs = -1;
    this.prevRate = 0;
  }

  /**
   * A play of the HUD player was accepted (the play command's pending run 0xd77504 -> 0xfa35c4, which
   * reserves its elixir and calls the King view's card-deploy handler 0x85ada8 -> 0x8d144c): `cost`
   * Elixir_bar_drop_anim clips side by side from the elixir_bar's position (0x8dcbf4).
   */
  spendDrops(cost: number): void {
    const ui = this.ui;
    if (!ui || !this.barPos || !ui.has('Elixir_bar_drop_anim') || cost <= 0) return;
    const b0 = ui.frameBounds('Elixir_bar_drop_anim', 0);
    const w = b0 ? b0[2] - b0[0] : 0;
    for (const x of elixirDropXs(cost, this.barPos[0], w)) {
      const clip = new ClipPlayer(ui.frameCount('Elixir_bar_drop_anim'), ui.fps('Elixir_bar_drop_anim') || 30);
      clip.playRange(0, clip.frames - 1, false);
      this.drops.push({ x, clip });
    }
  }

  /** The effects.sc clip of the crown flights (star_appear / star_appear_enemy), or null if not baked. */
  private flyLib(): ScLibrary | null {
    const fx = (this.art.manifest.hud as { crownFly?: { sc: string; exports: string[] } }).crownFly;
    if (!fx) return null;
    const lib = this.art.lib(fx.sc);
    return lib.has('star_appear') && lib.has('star_appear_enemy') ? lib : null;
  }

  /**
   * 0x8d0dd8: one flight per crown tower, logic team 0's King and Princess towers then team 1's; a tower
   * of the HUD player's team flies to the enemy's counter (star_appear_enemy), the others to the
   * player's (star_appear); the record keeps the tower's position (0x8dda9c).
   */
  private buildFlies(b: Battle, lib: ScLibrary): void {
    const list: NonNullable<Hud['flies']> = [];
    for (let team = 0; team < 2; team++) {
      const pl = b.players[team];
      for (const unit of [pl.king, ...pl.princess]) {
        if (!unit) continue;
        const player = team !== this.team;
        const exp = player ? 'star_appear' : 'star_appear_enemy';
        const startMove = lib.labels(exp).startMove ?? 0;
        list.push({ team, unit, king: unit === pl.king, x: unit.x, y: unit.y,
          fly: new CrownFly(player, { frames: lib.frameCount(exp), fps: lib.fps(exp), startMove }) });
      }
    }
    this.flies = list;
    this.fliesTeam = this.team;
    this.fliesBattle = b;
  }

  /** Stage origin of the target star of a flight (0x123c724 on starPlayer / starEnemy). */
  private starOrigin(player: boolean, riverY: number): [number, number] {
    const ui = this.ui;
    const ox = Math.floor(this.layout.stageW), oy = Math.floor(riverY);
    const path = player ? ['crowns_blue', 'starPlayer'] : ['crowns_red', 'starEnemy'];
    const c = ui ? childInfo(ui, 'HUD_rightMiddle', [path[0]]) : null;
    const s = ui ? childInfo(ui, 'HUD_rightMiddle', path) : null;
    if (!c || !s) return [ox, oy];
    return [ox + c.m[4] + c.m[0] * s.m[4] + c.m[2] * s.m[5], oy + c.m[5] + c.m[1] * s.m[4] + c.m[3] * s.m[5]];
  }

  /**
   * The HUD update's crown part: HUD_rightMiddle's fade (0x8d1e6c, on the flights' state of the previous
   * frame), then 0x8d2de0: towers gone start their flights (0x8ddb58 / 0x8ddc70), every flight is
   * updated (0x8dd90c), a landing plays its star clip 0..n-1 once, and the counters show crowns minus
   * the flights still shown.
   */
  private updateCrowns(dt: number, b: Battle): void {
    const lib = this.flyLib();
    if (lib && (!this.flies || this.fliesTeam !== this.team || this.fliesBattle !== b)) this.buildFlies(b, lib);
    const flies = lib ? this.flies ?? [] : [];
    this.crownFade.update(dt, flies.some((f) => f.fly.flying), !!b.result);
    const riverY = this.project ? this.project(9000, 16000)[1] : this.layout.stageH * 0.5;
    for (const f of flies) {
      const king = b.players[f.team].king;
      if (f.fly.flying || f.fly.done) continue;
      if (!crownTowerGone(!!king && king.state !== ST_DEAD, f.king, f.unit.state !== ST_DEAD)) continue;
      const [sx, sy] = this.project ? this.project(f.x, f.y) : [0, 0];
      f.fly.start(sx, sy);
    }
    const inAir = [0, 0];
    for (const f of flies) {
      const side = f.fly.player ? 0 : 1;
      f.fly.update(dt, this.starOrigin(f.fly.player, riverY));
      if (f.fly.visible) inAir[side]++;
      if (f.fly.takeLanded()) this.stars[side].playRange(0, this.stars[side].frames - 1, false);
    }
    for (let t = 0; t < 2; t++) {
      const cr = b.players[t === 0 ? this.team : 1 - this.team].crowns;
      // without the flight art the counter follows the crowns at once (and its star plays)
      if (!lib && cr !== this.scores[t]) this.stars[t].playRange(0, this.stars[t].frames - 1, false);
      this.scores[t] = cr - inAir[t];
      this.stars[t].advance(dt);
    }
  }

  /** Crown flights, HUD children added after the HUD's own elements (0x8d0d08 after 0x8cd4ec). */
  drawFlies(r: ScRenderer): void {
    const lib = this.flyLib();
    if (!lib || !this.flies) return;
    for (const f of this.flies) {
      if (!f.fly.visible) continue;
      const exp = f.fly.player ? 'star_appear' : 'star_appear_enemy';
      r.draw(lib, exp, f.fly.frame, [1, 0, 0, 1, f.fly.x, f.fly.y], WHITE, { childFrame: f.fly.frame });
    }
  }

  select(slot: number): void {
    for (let i = 0; i < 4; i++) this.cards[i].select(i === slot);
    this.selected = slot;
  }

  /**
   * A play from hand slot `slot` was accepted: the card hides until its slot changes (0x8e2868, 3 s at
   * most) and loses its selection (0x8e1004 after a placement).
   */
  played(slot: number): void {
    const c = this.cards[slot];
    if (!c) return;
    c.played();
    c.select(false);
    if (this.selected === slot) this.selected = -1;
  }

  /** A released card starts waiting for its elixir (0x8e2c04: +0x324 = MAX_SPELL_PENDING_TIME). */
  startWait(slot: number, t: number): void {
    const c = this.cards[slot];
    if (c) c.waitT = t;
  }

  /** Slot of a card waiting for elixir, or -1. */
  get waiting(): number {
    return this.cards.findIndex((c) => c.waitT > 0);
  }

  /** End a card's wait without the hand update (0x8e2b6c: +0x324 = 0, the caller releases it). */
  stopWait(slot: number): void {
    const c = this.cards[slot];
    if (c) c.waitT = 0;
  }

  /**
   * `dt` is the UI frame time (wall clock, like the client's HUD animations); `simDt` the simulation
   * time of the frame, which runs the elixir wait so that it keeps the client's relation to the elixir
   * regeneration at any viewer speed.
   */
  update(dt: number, b: Battle, simDt = dt): void {
    const p = b.players[this.team];
    const whole = Math.max(0, Math.min(10, Math.floor((p.elixir - p.pending) / 10000)));
    const hundredths = Math.max(0, Math.min(1000, Math.floor((p.elixir - p.pending) / 100)));
    // HUD_player update 0x8db8e0: the gain flash decays first, then the elixir bar 0x8dbebc
    this.flash.update(dt);
    this.elixir.update(dt, whole, hundredths);
    const bar = this.bar;
    if (bar) {
      const E = this.elixir;
      bar.ghostBar.setFill(f32(hundredths / f32(E.max * 100)));
      if (E.timer > 0 || E.tipAt !== null) bar.main.setFill(E.fill);
      if (E.refundStarted && bar.refund) refundBar(bar.refund.bar, bar.main.len, E.max, E.refundFrom, E.refund);
      if (E.tipAt !== null) this.tipX = barTipX(E.last, E.max, bar.main.len, bar.main.bodyX);
    }
    if (this.elixir.tipAt !== null) { this.tip.playRange(0, this.tip.frames - 1, false); this.tipVisible = true; }
    if (this.elixir.flowStarted) { this.flow.playRange(0, this.flow.frames - 1, true); this.warning.playRange(0, this.warning.frames - 1, false); }
    this.tip.advance(dt);
    if (this.tipVisible && !this.tip.playing) this.tipVisible = false;
    this.flow.advance(dt);
    this.warning.advance(dt);
    // hand cards (0x8dc37c -> 0x8e1408 per slot): the logic hand's card, -1 while the slot is empty.
    // Before each card's update its full-elixir wiggle entry is added or removed (0x907654 / 0x9077f0);
    // the elixir the hand sees is hundredths (0xfa1d10). A card waiting for elixir is released at the
    // end of its update once affordable (cost · 100 <= hundredths, +0x31a) or out of time.
    const maxHundredths = Math.trunc(b.maxElixir / 100);
    for (let i = 0; i < 4; i++) {
      const c = this.cards[i];
      const card = p.hand[i] ?? -1;
      if (card < 0 || hundredths < maxHundredths || !this.area) this.wiggle.remove(i);
      else {
        const s = cardSlot(this.area, i, this.cardH).s;
        this.wiggle.add(i, s, s, spellInstanceId(p.deck[card]?.name ?? ''));
      }
      if (c.update(dt, card, this.dragOf(i) !== null) && this.selected === i) this.selected = -1;
      if (c.waitT > 0) {
        const def = card >= 0 ? p.deck[card] : undefined;
        const affordable = !!def && (b.infiniteElixir || def.cost * 100 <= hundredths);
        const st = dropWaitStep(c.waitT, simDt, affordable);
        c.waitT = st.t;
        if (st.release) this.onRelease?.(i);
      }
    }
    this.wiggle.update(dt);
    // the spend drops: deleted once stopped (0x8db8e0 after the hand update), advanced as clips
    this.drops = this.drops.filter((d) => { const was = d.clip.playing; d.clip.advance(dt); return was; });
    this.updateCrowns(dt, b);
    const ot = b.tick >= b.regulationTicks;
    if (ot !== this.wasOvertime) {
      this.wasOvertime = ot;
      const ui = this.ui;
      if (ui && ot) {
        const l = ui.labels('HUD_topRight'), lo = ui.labels('HUD_topRight_overtime');
        this.topRight.playRange(l.out_start ?? 0, l.out_end ?? this.topRight.frames - 1, false);
        this.ot.playRange(lo.in_start ?? 0, lo.in_end ?? this.ot.frames - 1, false);
        // 0x8d38c4: the old elixirRegen hides; the overtime clip's is hidden and stopped (+0x180)
        if (this.regen[0]) this.regen[0].visible = false;
        if (this.regen[1]) { this.regen[1].visible = false; this.regen[1].clip.gotoAndStop(0); }
      }
    }
    // elixir badge of the time update 0x8d38c4 (skipped while the battle is over and on its first update)
    const rate10 = elixirRateX10(b);
    const reg = b.regulationTicks;
    const secs = Math.floor((Math.max(0, ((ot ? reg + b.overtimeTicks : reg) - b.tick) * 50) + 999) / 1000);
    const badge = this.regen[ot ? 1 : 0];
    if (badge && !b.result && this.prevSecs >= 0) {
      if (rate10 < 11) badge.visible = false;
      else if (rate10 !== this.prevRate || !badge.visible) {
        badge.text = regenBadgeText(rate10);
        badge.visible = true;
        badge.clip.playRange(0, badge.clip.frames - 1, false);
      }
    }
    this.prevSecs = secs;
    this.prevRate = rate10;
    for (const r of this.regen) r.clip.advance(dt);
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
    // top left: opponent; `darken` shows at graphics level 2 (0x8cf3b8), assumed (A)
    r.draw(ui, 'HUD_topLeft', 0, [1, 0, 0, 1, 0, 0], WHITE, {
      named: { enemyTrophies: { hide: true }, enemyRankedRating: { hide: true },
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
    // 0x8d38c4: the time text's green and blue bytes (+0xa / +0xb) are -(secs & 1) below 31 s, else 0xff:
    // red on even seconds of the last 30
    const red = secs < 31 && (secs & 1) === 0;
    const timeCol: Col | undefined = red ? [1, 0, 0, 1, 0, 0, 0] : undefined;
    // elixirRegen of each clip (0x8d38c4 -> 0x8d5158: "x2" / "x3" in its `elixir` child, played once)
    const trOpts = (i: number): DrawOptions => {
      const g = this.regen[i];
      return {
        named: { timeLeft: { color: timeCol }, elixirRegen: g?.visible ? { frame: g.clip.frame } : { hide: true },
          elixir: { text: g?.text ?? '' } },
        text: { timeLeft: time, TID_TIME_LEFT: this.text('TID_TIME_LEFT'), TID_OVERTIME: this.text('TID_OVERTIME') },
      };
    };
    if (!ot || this.topRight.playing) r.draw(ui, 'HUD_topRight', this.topRight.frame, [1, 0, 0, 1, L.stageW, 0], WHITE, trOpts(0));
    if (ot) r.draw(ui, 'HUD_topRight_overtime', this.ot.frame, [1, 0, 0, 1, L.stageW, 0], WHITE, trOpts(1));
    // right middle: crowns at the river line, x and y floored (0x123c550 from 0x8cd4ec / 0x8d1e6c), at
    // the alpha of 0x8d1e6c (hidden until a crown flies); counters minus the flights in the air
    const cf = this.crownFade.alpha;
    if (cf > 0) {
      r.draw(ui, 'HUD_rightMiddle', 0, [1, 0, 0, 1, Math.floor(L.stageW), Math.floor(riverY)], [1, 1, 1, cf, 0, 0, 0], {
        named: {
          cheer_button_blue: { hide: true }, cheer_button_red: { hide: true },
          starPlayer: { frame: this.stars[0].frame }, starEnemy: { frame: this.stars[1].frame },
        },
        text: { scorePlayer: String(this.scores[0]), scoreEnemy: String(this.scores[1]) },
      });
    }
    // bottom: HUD_player and the hand; the result screen hides the hand panels (0xbe0100 ->
    // 0x8d5ff8(hud, 0 / 1, 0): HUD +0x90 / +0x98 invisible)
    if (!this.handHidden) this.drawHandPanel(r, b, ui, p);
    // emote button
    r.draw(ui, 'HUD_taunt', 0, [1, 0, 0, 1, L.stageW * 0.5, L.stageH], WHITE, {
      named: { buttons: { frame: 0 }, mute_btn: { hide: true }, muted: { hide: true } },
    });
    // dragged card following the pointer (0x8e1fb8: scale/alpha shrink toward the arena); a card waiting
    // for elixir keeps its drag state (its visual is hidden over the arena)
    for (const d of this.handHidden ? [] : [this.held, this.drag]) {
      if (!d || d.cardScale <= 0) continue;
      const pos = this.slotPos(d.slot);
      const s0 = pos?.s ?? (this.area ? cardSlot(this.area, d.slot, this.cardH).s : 1);
      // the hand card sits at the pointer with its own matrix (scale, or the wiggle's rotation); its card
      // visual (+0x88) is scaled by cardScale and offset by the grab offset times cardScale
      // (0x8e1fb8 +0x2c8/+0x2cc, in the card's local space)
      const [a, bb, c, dd] = this.cardLinear(d.slot, s0);
      const f = d.cardScale;
      const lx = d.gx / s0, ly = d.gy / s0;
      this.art.drawCard(r, d.card, [a * f, bb * f, c * f, dd * f, d.x + (a * lx + c * ly) * f, d.y + (bb * lx + dd * ly) * f],
        { alpha: f });
    }
  }

  /** HUD_player (the hand panel built by 0x8d9d30): panel, elixir bar, next card, hand and spend drops. */
  private drawHandPanel(r: ScRenderer, b: Battle, ui: ScLibrary, p: Battle['players'][number]): void {
    const [ox, oy] = this.playerOrigin;
    const hm: Mat = [1, 0, 0, 1, ox, oy];
    // next card and NextSpellTimer follow the hand timer (0x8dc37c)
    const nt = nextCardTimer(p.cycleTimer);
    const named: NonNullable<DrawOptions['named']> = {
      // NextSpellTimer is drawn after the next card (below); `darken` shows at graphics level 2
      // (0x8da088), assumed (A)
      ability_location: { hide: true }, NextSpellTimer: { hide: true },
      panel: { lib: ui, export: 'panel_ingame_blue', frame: 0 },
      bar_refund: { hide: true },
      elixir_warning: { frame: this.warning.frame },
    };
    const bar = this.bar;
    if (bar) {
      const E = this.elixir;
      // a 0x8b2368 bar drawn with its body's scale / x and its end at the body's right edge, as overrides
      // in the children's own space
      const put = (u: UiBar, body: ChildInfo, end: ChildInfo | null, bodyName: string, endName: string | null) => {
        named[bodyName] = { matrix: [Math.max(1e-4, u.bodyScale / body.m[0]), 0, 0, 1, (u.bodyX - body.m[4]) / body.m[0], 0] };
        if (end && endName) named[endName] = { matrix: [1, 0, 0, 1, (u.endX - end.m[4]) / end.m[0], 0] };
      };
      put(bar.main, bar.body, bar.end, 'bar_body', 'bar_end');
      put(bar.ghostBar, bar.ghost, null, 'ghost', null);
      // dividers d1..d9 at len * i / max (0x8da088)
      bar.dividers.forEach((d, i) => {
        named[`d${i + 1}`] = { matrix: [1, 0, 0, 1, (f32(f32(bar.len * (i + 1)) * f32(1 / E.max)) - d.m[4]) / d.m[0], 0] };
      });
      // refund flash (0x8dbebc): bar_refund on its stopped frame 0 at the flash alpha, its bar placed at the rise
      if (E.refundShown && bar.refund) {
        named.bar_refund = { frame: 0, color: [1, 1, 1, E.refundAlpha / 255, 0, 0, 0] };
        put(bar.refund.bar, bar.refund.body, bar.refund.end, 'bar_body_refund', 'bar_end_refund');
      }
      // bar_tip at clamp(whole / max) * len + 2 + body x (0x8dbebc), played once, hidden once stopped
      if (bar.tip && this.tipVisible) {
        named.bar_tip = { frame: this.tip.frame, matrix: [1, 0, 0, 1, (this.tipX - bar.tip.m[4]) / bar.tip.m[0], 0] };
      } else named.bar_tip = { hide: true };
      named.bar_flow = E.full ? { frame: this.flow.frame } : { hide: true };
      const sel = this.selected >= 0 ? b.players[this.team].deck[p.hand[this.selected]] : null;
      named.elixirRequirementBar = sel ? { frame: Math.max(0, Math.min(10, sel.cost)) } : { hide: true };
      if (this.amountTxt) {
        const [tx, ty] = [this.amountTxt[4], this.amountTxt[5]];
        named.elixirAmount = { matrix: [E.textScaleX, 0, 0, E.textScaleY, tx - tx * E.textScaleX, ty - ty * E.textScaleY] };
      }
    }
    // the gain flash adds white to HUD_player and its children (0x8db8e0 +0xd..+0xf)
    const fa = this.flash.add;
    const panelCol: Readonly<Col> = fa > 0 ? [1, 1, 1, 1, fa, fa, fa] : WHITE;
    r.draw(ui, 'HUD_player', 0, hm, panelCol, {
      named,
      text: {
        elixirAmount: String(this.elixir.last), TID_NEXT_CARD: this.text('TID_NEXT_CARD'),
        TID_MAX_ELIXIR: this.text('TID_MAX_ELIXIR', { MAX_MANA: 10 }),
      },
    });
    // next card (0x907dc8 at nextCard1's middle, scale = rect height / (card_item_frame height * 1.34),
    // 0x8da088 / 0x90a6bc): the queue's head (0xfa4170), rebuilt at once when it changes (0x909fbc), in
    // grayscale while the hand timer runs
    if (this.next) {
      const nr = this.next;
      const card = p.queue.length ? p.deck[p.queue[0]]?.name : undefined;
      const s = (nr[3] - nr[1]) / 1.34 / this.cardH;
      const cx = (nr[0] + nr[2]) / 2, cy = (nr[1] + nr[3]) / 2;
      if (card) this.art.drawCard(r, card, matMul(hm, [s, 0, 0, s, cx, cy]), { noCost: true, grayscale: nt.gray });
    }
    // the next card sits at nextCard1's place in HUD_player's children (0x125299c at its index), so the
    // later NextSpellTimer field draws over it
    if (nt.text !== null && this.timerOnly) {
      r.draw(ui, 'HUD_player', 0, hm, WHITE, { named: this.timerOnly, text: { NextSpellTimer: nt.text } });
    }
    // hand: the elixir the cards see (0xfa1d10) is (elixir − pending plays, at most MAX_MANA) / 100,
    // 0 below 1; a card is playable at cost · 100, else its RadialFill shows shown / (cost · 100)
    // (0x8dc37c → 0x8e1408 → 0x89fd04)
    const avail = p.elixir - p.pending;
    const shown = avail < 1 ? 0 : Math.trunc(Math.min(avail, b.maxElixir) / 100);
    for (let i = 0; i < 4; i++) {
      const def = p.deck[p.hand[i]];
      const m = this.slotMatrix(i);
      if (!def || !m) continue;
      if (this.dragOf(i)) continue; // drawn at the pointer
      const need = def.cost * 100;
      const ok = b.infiniteElixir || shown >= need;
      this.art.drawCard(r, def.name, m, { dim: !ok, fill: ok ? null : shown / need });
    }
    // spend drops: HUD_player children added after the hand cards (0x8dcbf4 -> 0x1252994 on elixir_bar
    // +0x38), at the elixir_bar's y
    if (this.barPos) {
      for (const d of this.drops) {
        r.draw(ui, 'Elixir_bar_drop_anim', d.clip.frame, matMul(hm, [1, 0, 0, 1, d.x, this.barPos[1]]), panelCol,
          { childFrame: d.clip.frame });
      }
    }
  }
}
