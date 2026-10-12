// Battle intro banner (libg 160402020), ported from the client:
//   - the battle screen setup 0xbde180 creates it when the battle starts at tick 0 (the gate
//     DAT_01a57010 that 0xd0feac sets when the first battle state has tick 0) through 0xbdfa8c:
//     new 0x8c81b8, position (stage width / 2, _DAT_01a57008 = the projected arena centre y),
//     0x8ca220(intro, 1) (stretches), added to the game layer +0x168 (above the HUD layer +0x160,
//     below the popup layer +0x170); the screen flag +0x468 = 0x8c8140 (1 for the 1v1 clip);
//   - 0x8c8038 picks the clip: a normal 1v1 battle (not 2v2, not a blind / draft mode, not PvE) uses
//     `battle_intro_banners` from sc/ui_battle_banners.sc (290 frames at 60 fps; labels start_sound 0,
//     holdFrame 158, actionFrame 159);
//   - 0x8c81b8 fills it for a ladder battle with a logged-in player (the own avatar 0xcc4f14 exists):
//     txt_fight shown unless the mode has Overtime (+0x1e3) or TargetTouchdowns (+0x110); the `mode`
//     child stays shown with an empty text (no TID_BEST_OF_THREE, no reward-mode colours), so the
//     root txt_fight is hidden and `mode`'s own txt_fight shown instead (LAB_008c8738);
//     mode_suddendeath shown only for Overtime modes; vs_china hidden (0x8907e0); `vs` played 0..end
//     (0x1241f50) and, each update once it stops, hold_start..hold_end again (0x8ca764);
//     `player` = the own avatar (0xcc5a64), `enemy` = the opponent (0xcc531c), each through 0x8c9c70
//     (name text) and 0x8c9db4 -> 0x8ca424: `banner` replaced by a banner object (0x870a50, kind 4 own
//     / 5 enemy) = `battle_banner` with banner_bg / banner_fg replaced by the avatar's decoration, or
//     banner_bg_default_green / banner_fg_default_green without one (0x870afc), its badge slots shown
//     without badges hidden (0x871650 / 0x871a98); `trophies` = the player's trophies when the mode
//     has ShowTrophies (+0x1f8) and the battle type is not 0x11, hidden below 1; `rating` only with a
//     league (battle +0x1b0 +0x38);
//   - stretch helpers 0x89b344 wrap `dimmer` (both axes) and `gradient_top` / `gradient_bottom`
//     (horizontal): 0x89a38c scales the wrapped clip so its stage-space bounds cover the stage
//     (never below 1), 0x89ac0c centres the dimmer on the stage, 0x89a010 moves gradient_bottom's
//     slot by one stage height per 0x8ca220 call (the ctor's and 0xbdfa8c's) until the next frame
//     change re-applies the timeline;
//   - update 0x8ca764 (from the battle screen update 0xbe1d3c, whose battle clock never waits for it,
//     0xcc4338): time +0xe0 += dt; vs hold loop; once any player has played a card (a King tower's
//     queued-card count +0x318 >= 1, 0xd3cb70) the clip's frame time is halved (0x124351c) and its
//     playback mode set to 2 (all due frames, children interpolated); the press-and-hold of the
//     touch handlers (vt+0x110 0x8cace4 / vt+0x120 0x8cad48: hold at holdFrame, scale to 0.95) is not
//     wired (no touch input on the overlay); sounds are not played;
//   - the battle screen removes it once its clip has stopped (state 2) and it is not held (+0xf0);
//   - while it exists and its frame is below actionFrame (0x8caeb8): the HUD is hidden (screen +0x468
//     block of 0xbe1d3c: HUD +8 = !(playing && frame < actionFrame), latched once shown) and battle
//     input is blocked (0xbe4400), which also keeps the hand panel's slide-in (0x8db8e0 +0x21c) and the
//     hand update behind its 0.4 gate (0x8dc37c) waiting.

import type { ScLibrary } from './library.ts';
import type { Col, Mat } from './math.ts';
import { WHITE } from './math.ts';
import { type DrawCtx, McNode } from './movieclip.ts';
import type { ScRenderer } from './renderer.ts';

const f32 = Math.fround;

/** manifest.hud.intro (tools/art/bake_web.py) */
export interface IntroArt {
  sc: string;
  export: string;
  /** banner export of the banner object (0x870afc) and the default decoration clips */
  banner: string;
  bannerBg: string;
  bannerFg: string;
}

/** Stage geometry the intro is placed with (sc/ui_port.ts stageLayout; arena centre from 0x8583bc). */
export interface IntroStage {
  stageW: number;
  stageH: number;
  /** stage y of the projected arena centre (_DAT_01a57008) */
  centreY: number;
}

export interface IntroNames {
  /** own name: the client's TID_YOU for an own avatar without a name (0x8c81b8) */
  player: string;
  /** opponent name (the sandbox has no opponent profile: an approximation) */
  enemy: string;
}

/** Bounds [x0, y0, x1, y1] of a clip's frame 0 content (child clips at their frame 0). */
function clipBounds(lib: ScLibrary, id: number): [number, number, number, number] | null {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const acc = (oid: number, m: number[], depth: number): void => {
    if (depth > 16) return;
    const sh = lib.shapes.get(oid);
    if (sh) {
      for (const cmd of sh) {
        for (let i = 0; i < cmd.verts.length; i += 4) {
          const x = m[0] * cmd.verts[i] + m[2] * cmd.verts[i + 1] + m[4];
          const y = m[1] * cmd.verts[i] + m[3] * cmd.verts[i + 1] + m[5];
          b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
        }
      }
      return;
    }
    const c = lib.clips.get(oid);
    if (!c) return;
    const bm = lib.banks[c.bank].m;
    for (let i = c.frameStart[0]; i < c.frameStart[1]; i++) {
      const mi = c.elements[i * 3 + 1];
      const cm = mi >= 0 ? Array.from(bm.subarray(mi * 6, mi * 6 + 6)) : [1, 0, 0, 1, 0, 0];
      acc(c.children[c.elements[i * 3]], [
        m[0] * cm[0] + m[2] * cm[1], m[1] * cm[0] + m[3] * cm[1], m[0] * cm[2] + m[2] * cm[3], m[1] * cm[2] + m[3] * cm[3],
        m[0] * cm[4] + m[2] * cm[5] + m[4], m[1] * cm[4] + m[3] * cm[5] + m[5]], depth + 1);
    }
  };
  acc(id, [1, 0, 0, 1, 0, 0], 0);
  return b[0] <= b[2] ? [b[0], b[1], b[2], b[3]] : null;
}

/** Timeline matrix of child slot `ci` in frame `f` of a clip (identity when it has none). */
function slotMatrix(node: McNode, ci: number, f = 0): Mat | null {
  const c = node.clip, bm = node.lib.banks[c.bank].m;
  for (let i = c.frameStart[f]; i < c.frameStart[f + 1]; i++) {
    if (c.elements[i * 3] !== ci) continue;
    const mi = c.elements[i * 3 + 1];
    return mi >= 0 ? Array.from(bm.subarray(mi * 6, mi * 6 + 6)) as Mat : [1, 0, 0, 1, 0, 0];
  }
  return null;
}

/**
 * 0x89a38c (keep-aspect off) for a wrapped child at identity under a slot whose matrix is `slot` (the
 * intro and its clip add no scale): x scale max(1, |sx| * W / bounds width), y likewise, the bounds
 * taken through the slot (the bounds pass 0x123c69c renders the child with its parents' matrices).
 */
export function stretchScale(bounds: [number, number, number, number], slot: Readonly<Mat>, W: number, H: number,
  h: boolean, v: boolean): [number, number] {
  const bw = f32((bounds[2] - bounds[0]) * Math.abs(slot[0]));
  const bh = f32((bounds[3] - bounds[1]) * Math.abs(slot[3]));
  const sx = h ? Math.max(1, f32(W / bw)) : 1;
  const sy = v ? Math.max(1, f32(H / bh)) : 1;
  return [sx, sy];
}

export class BattleIntro {
  readonly root: McNode;
  readonly actionFrame: number; // +0xe8
  readonly holdFrame: number; // +0xec
  /** +0xe0: time since creation (s) */
  time = 0;
  /** +0xf0: held by a touch (never set here: no touch input on the overlay) */
  held = false;
  /** +0x13c: the frame time was halved after the first card play */
  spedUp = false;
  private readonly baseFt: number; // +0x17c (the clip's frame time at creation)
  private readonly vs: McNode | null; // +0x158
  private readonly dimmer: number;
  private readonly gradTop: number;
  private readonly gradBottom: number;
  private stageKey = '';

  constructor(lib: ScLibrary, art: IntroArt, names: IntroNames) {
    const root = McNode.of(lib, art.export);
    if (!root) throw new Error(`intro: no export ${art.export}`);
    this.root = root;
    this.baseFt = root.ft;
    this.actionFrame = root.label('actionFrame');
    this.holdFrame = root.label('holdFrame');
    // txt_fight / mode / mode_suddendeath for a ladder battle with an own avatar (see the header)
    const txtFight = root.child('txt_fight');
    const mode = root.child('mode');
    if (mode && mode.visible) {
      if (txtFight) txtFight.visible = false;
      const inner = mode.child('txt_fight');
      if (inner) inner.visible = true;
      const ti = mode.index('txt');
      if (ti >= 0) mode.slot(ti).text = '';
    }
    const sd = root.child('mode_suddendeath');
    if (sd) sd.visible = false;
    // players (0x8c9c70, 0x8c9db4 -> 0x8ca424)
    this.fillPlayer(lib, art, root.child('player'), names.player);
    this.fillPlayer(lib, art, root.child('enemy'), names.enemy);
    // vs (0x8c81b8: visible, played 0..end), vs_china hidden
    this.vs = root.child('vs');
    if (this.vs) {
      this.vs.visible = true;
      this.vs.playRange(0, this.vs.frames - 1, false);
    }
    const china = root.child('vs_china');
    if (china) china.visible = false;
    this.dimmer = root.index('dimmer');
    this.gradTop = root.index('gradient_top');
    this.gradBottom = root.index('gradient_bottom');
    root.playRange(0, root.frames - 1, false);
  }

  private fillPlayer(lib: ScLibrary, art: IntroArt, p: McNode | null, name: string): void {
    if (!p) return;
    // 0x8c9c70 / 0x8ca424: the name text (0x872bb4 finds the field "name" in the "name" clip)
    const nameClip = p.child('name');
    if (nameClip) {
      const ti = nameClip.index('name');
      if (ti >= 0) nameClip.slot(ti).text = name;
    }
    // trophies: count 0 in the sandbox (no profile) -> hidden (0x8ca424: count < 1)
    const tr = p.child('trophies');
    if (tr) tr.visible = false;
    // rating: no league (battle +0x1b0 +0x38) -> hidden
    const ra = p.child('rating');
    if (ra) ra.visible = false;
    // banner -> banner object (0x870a50 kind 4/5): battle_banner with the default decoration
    const bi = p.index('banner');
    const banner = McNode.of(lib, art.banner);
    if (bi >= 0 && banner) {
      const bg = McNode.of(lib, art.bannerBg), fg = McNode.of(lib, art.bannerFg);
      const bgi = banner.index('banner_bg'), fgi = banner.index('banner_fg');
      if (bg && bgi >= 0) banner.slot(bgi).replace = bg;
      if (fg && fgi >= 0) banner.slot(fgi).replace = fg;
      // 0x871650 for kinds 4/5: `badges` shown, badges_editor / badges_profile hidden; 0x871a98 hides
      // the badge slots without a badge (all of them: the sandbox has no badges)
      const badges = banner.child('badges');
      if (badges) {
        badges.visible = true;
        for (const s of ['badge1', 'badge2', 'badge3', 'badge1_active', 'badge2_active', 'badge3_active']) {
          const k = badges.child(s);
          if (k) k.visible = false;
        }
      }
      for (const s of ['badges_editor', 'badges_profile']) {
        const k = banner.child(s);
        if (k) k.visible = false;
      }
      // kinds 4 (own) and 5 (enemy) differ only in mirrored badges and the bg/fg "red"/"blue" labels
      // (0x87199c), which the default decoration clips do not have; the enemy slot's matrix mirrors it
      p.slot(bi).replace = banner;
    }
  }

  /** 0x8caeb8: the clip is still before actionFrame (HUD hidden, input blocked). */
  get beforeAction(): boolean { return this.root.frame < this.actionFrame; }

  /** 0x8caed0: the clip still plays (state below 2). */
  get playing(): boolean { return this.root.state < 2; }

  /** The battle screen deletes it (0xbe1d3c): clip stopped and not held. */
  get done(): boolean { return this.root.state === 2 && !this.held; }

  /**
   * The update of 0x8ca764 (before the frame's render), `dt` s of UI time. `cardPlayed`: some player
   * has queued a card play (0xd3cb70).
   */
  update(dt: number, cardPlayed: boolean): void {
    this.time = f32(this.time + dt);
    const vs = this.vs;
    if (vs && vs.state > 1) vs.playLabels('hold_start', 'hold_end', false);
    if (!this.spedUp && cardPlayed) {
      this.spedUp = true;
      this.root.setFrameTime(f32(this.baseFt * 0.5));
      this.root.mode = 2;
    }
  }

  /** Render-time advance of the clip tree (0x123f55c), `dt` s. */
  advance(dt: number): void {
    this.root.advance(dt);
  }

  /** Stretch / centre helpers of 0x8ca220 for a stage (recomputed when the stage changes). */
  private layout(st: IntroStage, x: number, y: number): void {
    const key = `${st.stageW}|${st.stageH}|${x}|${y}`;
    if (key === this.stageKey) return;
    this.stageKey = key;
    const root = this.root, lib = root.lib, W = st.stageW, H = st.stageH;
    // dimmer: both axes, centred on the stage (0x89ad98 -> 0x89ac0c at (W / 2, H / 2), safe areas 0)
    if (this.dimmer >= 0) {
      const sm = slotMatrix(root, this.dimmer);
      const b = clipBounds(lib, root.clip.children[this.dimmer]);
      if (sm && b) {
        const [sx, sy] = stretchScale(b, sm, W, H, true, true);
        // wrapper world = T(x, y) * sm; the inner position is the stage centre in wrapper space
        const det = sm[0] * sm[3] - sm[1] * sm[2];
        const gx = W * 0.5 - (x + sm[4]), gy = H * 0.5 - (y + sm[5]);
        const lx = (sm[3] * gx - sm[2] * gy) / det, ly = (-sm[1] * gx + sm[0] * gy) / det;
        root.slot(this.dimmer).inner = [sx, 0, 0, sy, f32(lx), f32(ly)];
      }
    }
    for (const gi of [this.gradTop, this.gradBottom]) {
      if (gi < 0) continue;
      const sm = slotMatrix(root, gi);
      const b = clipBounds(lib, root.clip.children[gi]);
      if (sm && b) {
        const [sx] = stretchScale(b, sm, W, H, true, false);
        root.slot(gi).inner = [sx, 0, 0, 1, 0, 0];
      }
    }
    // 0x89a010(0, 1): gradient_bottom's slot one stage height lower per call (two calls), until the
    // first frame change
    if (this.gradBottom >= 0 && root.frame === 0) {
      const sm = slotMatrix(root, this.gradBottom);
      if (sm) root.slot(this.gradBottom).offset = [sm[4], f32(sm[5] + 2 * H)];
    }
  }

  /** Draw in stage px at (stage width / 2, arena centre y) (0xbdfa8c), scale 1. */
  draw(r: ScRenderer, st: IntroStage, ctx: DrawCtx): void {
    const x = st.stageW * 0.5, y = st.centreY;
    this.layout(st, x, y);
    const m: Mat = [1, 0, 0, 1, x, y];
    this.root.draw(r, m, WHITE as Col, ctx);
  }
}

/**
 * The screen flag +0x468 of 0xbe1d3c: while set, the HUD's visibility follows the intro; cleared once
 * the intro is gone or its clip reached actionFrame. Returns the HUD visibility to apply, or null when
 * the flag is already clear (HUD left as it is).
 */
export function introHudVisible(flag: { on: boolean }, intro: BattleIntro | null): boolean | null {
  if (!flag.on) return null;
  let vis: boolean;
  if (!intro) {
    flag.on = false;
    vis = true;
  } else {
    const playing = intro.playing;
    if (!intro.beforeAction) { flag.on = false; vis = true; } else vis = false;
    vis = vis || !playing;
  }
  return vis;
}
