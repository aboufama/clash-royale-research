// Emotes (libg 160402020): HUD_taunt's emote button, its menu, the bubbles and their sounds, ported from:
//   - HUD init 0x8cd4ec: HUD_taunt (sc/ui.sc) at (stage width / 2, stage height) in the game layer +0x178 (above
//     the result screen and the popup manager), `buttons` stopped on frame 0, `taunt_button` a game button
//     (0x894c54, vt+0x168 with the button_timeline template, listener HUD +0x80) with its `muted` icon shown
//     while taunts are muted, `mute_btn` a game button too (TAUNTS_MUTE_ENABLED, client tables +0x271) on
//     frame `muted`, hidden; HUD_taunt follows the HUD's intro visibility (0xbe1d3c -> 0x8d791c);
//   - HUD update 0x8d1e6c: the taunt timers +0x31c / +0x320 / +0x328 / +0x32c count down to 0; the button's
//     alpha is 1 below TAUNT_LIMIT own taunts (+0x324), else 0.5 and not interactive; each bubble (+0x1b0,
//     last to first) is visible while the HUD is (+0x29c) and updated by 0x8e920c, deleted when it returns
//     false; the menu's update 0x8ead78;
//   - the HUD's click listener 0x8d15c0: the taunt button toggles the menu (0x8d1228 with !menu visible);
//     the mute button toggles muting (settings 0x789614 / 0x7895a0), the `muted` icon, closes the menu and
//     shows its frame;
//   - 0x8d1228(open): refused while the own taunt count reached TAUNT_LIMIT (popup TID_TAUNT_LIMIT_FULL at the
//     stage centre, 0x88cac8); the menu (0x8e9284) is made on the first open as a child of HUD_taunt; the
//     taunt button hides while it is open, the mute button shows; the hand panel's cards and `slots` hide
//     (panel +0xe8 -> the card update 0x8e1408's visibility, 0x8dc37c); 0x8eb1f8 shows / hides the menu;
//     any touch ending on the battle screen (0xbe1120 -> 0x8d120c) or on the hand panel (0x8db630) closes it;
//   - the menu 0x8e9284 (taunt_selector_new, `emotes` / `panel` hidden, button_more deleted below 9 emotes,
//     `grad` deleted): its favourites area (a 400 x 200 ScrollArea 0x8a0f04 at ((stage width - insets) / 2
//     - 190, stage height - insets - 390) in the game layer +0x178) holds 4 empty slots
//     (emote_menu_empty_slot at scale 0.75) and the 4 emotes of a deck of 4 (emote_menu_sticker_btn via
//     0x88938c: `tag_new` hidden, `image` replaced by the pack's icon%d (IndexLo + 1), 0x889a84 background
//     or background_crystal), placed by 0x8ea3a4 at (51 + 102 col, 43.5 + 87 row); the text taunts of
//     taunts.csv with TauntMenu and IsTextEmote (0x8ea21c: their BtnExportName children of the menu clip,
//     game buttons with the template, `txt` = the TID text); each update 0x8ead78 grays every item while
//     the 2 s cooldown runs and bounces the emote items in after the menu shows (scale
//     0x1208868(0.8, 1, 5 t, 0.2, 1, 1));
//   - a click on an item (0x8eab24): ignored during the cooldown; 0x8eac1c sends the taunt (an empty slot
//     shows TID_EMOTE_MISSING instead), the cooldown starts (TAUNT_COOLDOWN_10TH_OF_SECONDS / 10) and the
//     menu closes; the battle event (type 3: value 0 the index, value 2 the emote's IndexHi, 0 for a text
//     taunt) goes through 0xbe62a4, which hands an own taunt to the HUD at once (0x8d601c(hud, event, 1));
//   - 0x8d601c type 3: dropped while the HUD is hidden (+0x29c); muted: dropped (an own one shows
//     TID_NO_TAUNT_DUE_TO_MUTE); then 0x8d6820: the opponent's count +0x318 / gate +0x31c (a second taunt
//     within 1 s is dropped), the own count +0x324 (TID_TAUNT_LIMIT_FULL at the limit) / +0x328; the
//     sender's earlier bubbles end (+0x98 = 0); the bubble 0x8e8f0c (emote: sticker_bubble_player2_master
//     for the own, sticker_bubble_opponent2_master for the opponent in 1v1, by the opponent flag and
//     flag ^ (sender index < 2)) or 0x8e89d0 (text: speech_bubble_*), scale 1, at (the projected arena
//     centre x _DAT_01a57004, stage height for the own / 0 for the opponent), inserted at index 0 of the game
//     layer +0x178, its clip played once (145 frames); the emote clip (0x8897a4: the pack's emote%d in a
//     300 x 150 area at (-150, -115.5) of the bubble's `bubble`, the clip at (150, 150) in it; `anim` and
//     `image` deleted) played once; the emote's sound: event:/Main/Trigger/SFX_trigger/Play_emote with its
//     SfxFile (0x8892cc, no cooldown); a text taunt's Sound with TAUNT_SOUND_COOLDOWN (3 s, +0x32c / +0x320);
//   - bubble update 0x8e920c: +0x98 (SHOW_TAUNT_TIME_SEC) counts down, the bubble clip is visible while it
//     plays and then follows its target (0x8e8c38: the result screen's taunt_player / taunt_enemy centre
//     once that screen is 2.2 s old, else the start point; per axis: snap within 0.2 px, else
//     (target + cur (k - 0.39)) / (k + 0.61), k = 0.2251 / dt); the bubble goes when +0x98 is spent.
// Approximations (A): the sandbox has no player profile, so the deck is the DefaultOwned emotes of
// emotes.csv (the 4 King emotes); the ScrollArea's mask and scrolling are not modelled (its content fits);
// the pack loader 0xcf7a48 draws the loaded clip at its origin; Play_emote's own volume is not applied
// (the .ogg plays at its level); the opponent never emotes on its own (the sandbox panel can send one).
import type { ScLibrary } from './library.ts';
import type { Col, Mat } from './math.ts';
import { matMul, WHITE } from './math.ts';
import { type DrawCtx, McNode } from './movieclip.ts';
import type { ScRenderer } from './renderer.ts';
import { GameButton } from './ui_button.ts';

const f32 = Math.fround;

export interface EmoteDef {
  name: string;
  /** IndexHi / IndexLo (the emote's id; 0x88938c / 0x8897a4 use IndexLo + 1) */
  hi: number;
  lo: number;
  /** the pack's library and its emote%d / icon%d exports */
  sc: string;
  clip: string;
  icon: string;
  /** UseCrystalBackground (+0x9c) */
  crystal: boolean;
  frames?: number;
  /** SfxFile copied by the bake (assets-relative) */
  sfx?: string;
}

export interface TauntDef { index: number; name: string; tid: string; btn: string; sound: string | null }

/** manifest.hud.emotes (tools/art/bake_web.py emote_art) */
export interface EmoteArt {
  ui: string;
  emotes: EmoteDef[];
  taunts: TauntDef[];
  texts: Record<string, string>;
  clickSound?: string;
  globals?: { showTime: number; cooldown10: number; limit: number; soundCooldown: number };
}

type Rect = [number, number, number, number];

/** client_globals.csv: SHOW_TAUNT_TIME_SEC, TAUNT_COOLDOWN_10TH_OF_SECONDS, TAUNT_LIMIT, TAUNT_SOUND_COOLDOWN. */
export const TAUNT_GLOBALS = { showTime: 4, cooldown10: 20, limit: 100, soundCooldown: 3000 };
/** TAUNTS_MUTE_ENABLED (client tables +0x271): TRUE in client_globals.csv */
export const TAUNTS_MUTE_ENABLED = true;

/** The favourites area's item positions (0x8ea3a4). */
export const MENU_SLOTS: readonly [number, number][] = [
  [51, 43.5], [153, 43.5], [255, 43.5], [357, 43.5], [51, 130.5], [153, 130.5], [255, 130.5], [357, 130.5],
];

/** The favourites area's position in stage px (0x8e9284, no safe-area insets). */
export function menuAreaPos(stageW: number, stageH: number): [number, number] {
  return [Math.trunc(stageW) / 2 - 190, Math.trunc(stageH) - 390];
}

/** 0x1208868(from, to, t, amp, part, freq): linear to `to` over 1 - part, then a damped sine around it. */
export function bounceEase(from: number, to: number, t: number, amp: number, part: number, freq: number): number {
  if (t < 0) return from;
  if (t > 1) return to;
  const p = Math.min(1, Math.max(0, part));
  const lin = f32(1 - p);
  if (t < lin) return f32(((to - from) * t) / lin + from);
  if (!(p > 0)) return to;
  const u = f32((t - lin) / p);
  const a = to - from >= 0 ? f32((1 - u) * amp) : -f32((1 - u) * amp);
  return f32(to + Math.sin(freq * f32(Math.PI) * u) * a);
}

/**
 * The bubble export (0x8e8f0c sticker / 0x8e89d0 speech): `opponent` = param_5, param_6 = opponent ^ (the
 * sender's index in the battle's player list < 2), so a 1v1 battle shows the "2" bubbles.
 */
export function bubbleExport(sticker: boolean, opponent: boolean, senderIndex = 0): string {
  const two = (opponent ? 1 : 0) ^ (senderIndex < 2 ? 1 : 0);
  const kind = sticker ? 'sticker' : 'speech';
  if (opponent) return `${kind}_bubble_${two ? 'opponent' : 'opponent2'}_master`;
  return `${kind}_bubble_${two ? 'player2' : 'player'}_master`;
}

/** 0x8e8c38 on one axis: snap within 0.2, else move with k = 0.2251 / dt (no move below dt 0.001). */
export function followAxis(cur: number, target: number, dt: number): number {
  if (!(Math.abs(cur - target) > 0.2)) return target;
  if (!(dt > 0.001)) return cur;
  const k = f32(0.2251 / dt);
  const f = f32(k + 0.61);
  if (!(f > 1)) return target;
  return f32(f32(target + cur * f32(k - 0.39)) / f);
}

/** Union of the shapes a node draws now, through `m` (hit areas). */
export function nodeBounds(node: McNode, m: Readonly<Mat>, out: Rect = [Infinity, Infinity, -Infinity, -Infinity]): Rect {
  const c = node.clip, lib = node.lib, f = Math.min(Math.max(node.frame, 0), c.frameCount - 1);
  for (let i = c.frameStart[f]; i < c.frameStart[f + 1]; i++) {
    const ci = c.elements[i * 3];
    const s = node.slots[ci];
    if (s?.hidden) continue;
    const kid = s?.replace ?? node.kids[ci];
    if (kid && !kid.visible) continue;
    const cm = matMul(m, node.slotMatrix(ci) ?? [1, 0, 0, 1, 0, 0]);
    if (kid) { nodeBounds(kid, cm, out); continue; }
    for (const cmd of lib.shapes.get(c.children[ci]) ?? []) {
      for (let k = 0; k < cmd.verts.length; k += 4) {
        const x = cm[0] * cmd.verts[k] + cm[2] * cmd.verts[k + 1] + cm[4];
        const y = cm[1] * cmd.verts[k] + cm[3] * cmd.verts[k + 1] + cm[5];
        if (x < out[0]) out[0] = x; if (y < out[1]) out[1] = y; if (x > out[2]) out[2] = x; if (y > out[3]) out[3] = y;
      }
    }
  }
  for (const a of node.added) if (a.node.visible) nodeBounds(a.node, matMul(m, a.m), out);
  return out;
}

const inRect = (r: Rect | null, x: number, y: number): boolean => !!r && r[0] <= r[2] && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** Libraries by name: loaded ones, and a request for a missing one (BattleArt.libs / lib). */
export interface EmoteLibs {
  get(name: string): ScLibrary | undefined;
  request?(name: string): void;
}

// ---------------------------------------------------------------------------------------------- bubble

/** One emote bubble (vtable 0x1899f40; 0x8e8f0c / 0x8e89d0). */
export class EmoteBubble {
  readonly root: McNode;
  readonly opponent: boolean;
  /** +0x98: life left (s) */
  life: number;
  /** +0xa4: the start point; current position */
  readonly start: [number, number];
  x: number;
  y: number;
  /** +0xa0 (0x8e9274), +0xa1 = the opponent flag, +0xac (spectator bubbles) */
  readonly follows = true;
  visible = true;
  readonly emoteClip: McNode | null;

  constructor(ui: ScLibrary, opponent: boolean, at: [number, number], life: number,
    content: { emote: EmoteDef; pack: ScLibrary | null } | { text: string }) {
    const sticker = 'emote' in content;
    const root = McNode.of(ui, bubbleExport(sticker, opponent));
    if (!root) throw new Error('emote bubble export missing');
    this.root = root;
    this.opponent = opponent;
    this.life = life;
    this.start = [at[0], at[1]];
    this.x = at[0];
    this.y = at[1];
    const bubble = root.child('bubble');
    let clip: McNode | null = null;
    if (bubble && 'emote' in content) {
      // 0x8897a4: the loader (300 x 150 area at (-150, -115.5), the clip at (150, 150) in it); `image` and
      // `anim` deleted; 0x889a84: background / background_crystal
      for (const n of ['image', 'anim']) { const k = bubble.child(n); if (k) k.visible = false; }
      const bg = bubble.child('background'), bgc = bubble.child('background_crystal');
      if (bg) bg.visible = !content.emote.crystal;
      if (bgc) bgc.visible = content.emote.crystal;
      clip = content.pack ? McNode.of(content.pack, content.emote.clip) : null;
      const node = clip ?? McNode.of(ui, 'emote_downloading');
      if (node) bubble.added.push({ node, m: clip ? [1, 0, 0, 1, 0, 34.5] : [1, 0, 0, 1, 0, 4.5] });
      clip?.playRange(0, clip.frames - 1, false);
    } else if (bubble && 'text' in content) {
      const ti = bubble.index('txt');
      if (ti >= 0) bubble.slot(ti).text = content.text;
    }
    this.emoteClip = clip;
    root.playRange(0, root.frames - 1, false);
  }

  /**
   * 0x8e920c: life -= dt; the clip visible while it plays, and then following its target. Returns false once
   * the life is spent (the HUD deletes it).
   */
  update(dt: number, target: [number, number] | null): boolean {
    const left = f32(this.life - dt);
    this.life = left <= 0 ? 0 : left;
    this.visible = this.root.state !== 2;
    if (this.visible) {
      const t = target ?? this.start;
      this.x = followAxis(this.x, t[0], dt);
      this.y = followAxis(this.y, t[1], dt);
    }
    return left > 0;
  }

  advance(dt: number): void {
    if (this.visible) this.root.advance(dt);
  }

  draw(r: ScRenderer, ctx: DrawCtx): void {
    if (!this.visible) return;
    this.root.draw(r, [1, 0, 0, 1, this.x, this.y], WHITE as Col, ctx);
  }
}

// ---------------------------------------------------------------------------------------------- menu

interface MenuItem {
  node: McNode;
  button: GameButton;
  emote: EmoteDef | null;
  /** button scale (vt+0x30): 0.75 for empty slots, the bounce for emotes */
  scale: number;
  /** +0x15c: time since the menu showed */
  t: number;
  pos: [number, number];
}

interface TextButton { idx: number; node: McNode; button: GameButton; taunt: TauntDef }

/** taunt_selector_new (0x8e9284) with its favourites area. */
export class EmoteMenu {
  readonly root: McNode;
  readonly items: MenuItem[] = [];
  readonly texts: TextButton[] = [];
  /** +0x110 */
  cooldown = 0;
  /** +8 */
  visible = false;
  private readonly ui: ScLibrary;

  constructor(ui: ScLibrary, art: EmoteArt, libs: EmoteLibs) {
    this.ui = ui;
    const root = McNode.of(ui, 'taunt_selector_new');
    if (!root) throw new Error('taunt_selector_new missing');
    this.root = root;
    // 4 empty slots and the deck's 4 emotes (0x101db58 == 4), else 8 emotes
    const deck = art.emotes.slice(0, 8);
    const entries: (EmoteDef | null)[] = deck.length === 4 ? [null, null, null, null, ...deck] : deck;
    entries.forEach((emote, i) => {
      const item = this.makeItem(emote, libs);
      if (!item) return;
      item.pos = [MENU_SLOTS[i]?.[0] ?? 0, MENU_SLOTS[i]?.[1] ?? 0];
      this.items.push(item);
    });
    // 0x8ea21c: text taunts found in the menu clip, game buttons with the template, txt = the TID text
    for (const t of art.taunts) {
      const idx = root.index(t.btn);
      const node = idx >= 0 ? root.kids[idx] : null;
      if (!node) continue;
      const ti = node.index('txt');
      if (ti >= 0) node.slot(ti).text = art.texts[t.tid] ?? '';
      this.texts.push({ idx, node, button: new GameButton(ui), taunt: t });
    }
    // 0x8e9284: button_more deleted below 9 emotes; `grad` deleted; `panel` and `emotes` hidden (also by
    // 0x8ea5dc(menu, 0) on each toggle of a 1v1 battle)
    for (const n of ['button_more', 'grad', 'panel', 'emotes']) { const k = root.child(n); if (k) k.visible = false; }
  }

  private makeItem(emote: EmoteDef | null, libs: EmoteLibs): MenuItem | null {
    const ui = this.ui;
    if (!emote) {
      const node = McNode.of(ui, 'emote_menu_empty_slot');
      return node ? { node, button: new GameButton(ui), emote: null, scale: 0.75, t: 0, pos: [0, 0] } : null;
    }
    // 0x88938c (UseCrystalBackground is not a "special" button; +0x9b exclusive emotes use _special)
    const node = McNode.of(ui, 'emote_menu_sticker_btn');
    if (!node) return null;
    const tag = node.child('tag_new');
    if (tag) tag.visible = false;
    const bg = node.child('background'), bgc = node.child('background_crystal');
    if (bg) bg.visible = !emote.crystal;
    if (bgc) bgc.visible = emote.crystal;
    this.setIcon(node, emote, libs);
    return { node, button: new GameButton(ui), emote, scale: 1, t: 0, pos: [0, 0] };
  }

  /** `image` replaced by the pack's icon (the downloading clip at y -30 until the pack library is there). */
  private setIcon(node: McNode, emote: EmoteDef, libs: EmoteLibs): void {
    const ii = node.index('image');
    if (ii < 0) return;
    const pack = libs.get(emote.sc);
    if (!pack) libs.request?.(emote.sc);
    const icon = pack ? McNode.of(pack, emote.icon) : null;
    const s = node.slot(ii);
    if (icon) { s.replace = icon; s.inner = undefined; return; }
    const dl = McNode.of(this.ui, 'emote_downloading');
    if (dl) { s.replace = dl; s.inner = [1, 0, 0, 1, 0, -30]; }
  }

  /** Swap a placeholder for the icon once the pack library has loaded. */
  refreshIcons(libs: EmoteLibs): void {
    for (const it of this.items) {
      if (!it.emote) continue;
      const ii = it.node.index('image');
      if (ii >= 0 && it.node.slot(ii).inner && libs.get(it.emote.sc)) this.setIcon(it.node, it.emote, libs);
    }
  }

  /** 0x8eb1f8: showing restarts the items' time (+0x15c = 0). */
  show(on: boolean): void {
    if (on) for (const it of this.items) it.t = 0;
    this.visible = on;
  }

  /** 0x8ead78 (the HUD update), `dt` s. */
  update(dt: number): void {
    this.cooldown = f32(this.cooldown - dt);
    if (!this.visible) return;
    for (const it of this.items) {
      it.t = f32(it.t + dt);
      if (it.emote) it.scale = bounceEase(0.8, 1, f32(it.t * 5), 0.2, 1, 1);
    }
  }

  /** Render-time advance of the clips and the buttons' templates. */
  advance(dt: number): void {
    if (!this.visible) return;
    this.root.advance(dt);
    for (const t of this.texts) {
      t.button.advance(dt);
      this.root.slot(t.idx).inner = t.button.matrix();
      this.root.slot(t.idx).grayscale = this.cooldown > 0;
    }
    for (const it of this.items) { it.node.advance(dt); it.button.advance(dt); }
  }

  /** Item world matrix: area + position, button scale, the template's matrix. */
  private itemMatrix(it: MenuItem, area: [number, number], withTemplate: boolean): Mat {
    const s = it.scale;
    const m: Mat = [s, 0, 0, s, area[0] + it.pos[0], area[1] + it.pos[1]];
    return withTemplate ? matMul(m, it.button.matrix()) : m;
  }

  /** The menu clip (a child of HUD_taunt at `origin`). */
  drawMenu(r: ScRenderer, origin: [number, number], ctx: DrawCtx): void {
    if (!this.visible) return;
    this.root.draw(r, [1, 0, 0, 1, origin[0], origin[1]], WHITE as Col, ctx);
  }

  /** The favourites area (game layer +0x178) and its items. */
  drawArea(r: ScRenderer, area: [number, number], ctx: DrawCtx): void {
    if (!this.visible) return;
    const gray = this.cooldown > 0;
    const ictx: DrawCtx = gray ? { ...ctx, grayscale: true } : ctx;
    for (const it of this.items) it.node.draw(r, this.itemMatrix(it, area, true), WHITE as Col, ictx);
  }

  /** The item or text button under stage (x, y). */
  hit(x: number, y: number, origin: [number, number], area: [number, number]): { item?: MenuItem; text?: TextButton } | null {
    if (!this.visible) return null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (inRect(nodeBounds(it.node, this.itemMatrix(it, area, false)), x, y)) return { item: it };
    }
    for (const t of this.texts) {
      const sm = this.root.slotMatrix(t.idx);
      if (!sm || !t.node.visible) continue;
      if (inRect(nodeBounds(t.node, matMul([1, 0, 0, 1, origin[0], origin[1]], sm)), x, y)) return { text: t };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- the HUD's part

/** What the owner does for the emote system (sounds, popups, the hand panel). */
export interface EmoteHooks {
  /** the game buttons' click sound (0x894dfc) */
  click?(): void;
  /** play an emote's SfxFile through Play_emote (0x8892cc) */
  sfx?(path: string): void;
  /** play a sound resource (a text taunt's Sound) */
  sound?(resource: string): void;
  /** popup manager floater at the stage centre (0x88cac8, white) */
  popup?(text: string): void;
}

/** One pending touch on an emote control. */
type Hold = { kind: 'taunt' } | { kind: 'mute' } | { kind: 'item'; item: MenuItem } | { kind: 'text'; text: TextButton };

export class Emotes {
  readonly art: EmoteArt;
  readonly ui: ScLibrary;
  readonly libs: EmoteLibs;
  hooks: EmoteHooks = {};
  /** HUD_taunt (+0x238) */
  readonly taunt: McNode;
  private readonly buttons: McNode | null;
  private readonly tauntIdx: number;
  private readonly muteIdx: number;
  /** the taunt button (+0x240) and the mute button (+0x250) */
  readonly tauntBtn: GameButton;
  readonly muteBtn: GameButton;
  /** the menu (+0x258), made on the first open */
  menu: EmoteMenu | null = null;
  /** bubbles (+0x1b0), oldest first */
  bubbles: EmoteBubble[] = [];
  /** taunts muted (settings 0x789614) */
  muted = false;
  /** own taunts (+0x324) and the opponent's (+0x318) */
  ownCount = 0;
  oppCount = 0;
  /** +0x328 / +0x31c (1 s gates) and the text-taunt sound cooldowns +0x32c / +0x320 */
  private ownGate = 0;
  private oppGate = 0;
  private ownSound = 0;
  private oppSound = 0;
  /** HUD_taunt shown (the HUD's intro visibility, 0x8d791c) */
  shown = true;
  private hold: Hold | null = null;
  private readonly globals: { showTime: number; cooldown10: number; limit: number; soundCooldown: number };

  constructor(ui: ScLibrary, art: EmoteArt, libs: EmoteLibs) {
    this.ui = ui;
    this.art = art;
    this.libs = libs;
    this.globals = art.globals ?? TAUNT_GLOBALS;
    const taunt = McNode.of(ui, 'HUD_taunt');
    if (!taunt) throw new Error('HUD_taunt missing');
    this.taunt = taunt;
    this.buttons = taunt.child('buttons');
    this.buttons?.gotoAndStop(0);
    this.tauntIdx = this.buttons?.index('taunt_button') ?? -1;
    this.muteIdx = this.buttons?.index('mute_btn') ?? -1;
    this.tauntBtn = new GameButton(ui);
    this.muteBtn = new GameButton(ui);
    const mute = this.buttons?.child('mute_btn');
    if (mute) mute.visible = false;
    this.applyMuted();
    for (const e of art.emotes) if (!libs.get(e.sc)) libs.request?.(e.sc);
  }

  /** The menu is open (the hand panel's cards and `slots` hide, panel +0xe8). */
  get menuOpen(): boolean { return !!this.menu?.visible; }

  private text(id: string): string { return this.art.texts[id] ?? ''; }

  private applyMuted(): void {
    // 0x8cd4ec / 0x8d15c0: the taunt button's `muted` icon, the mute button's frame
    const m = this.buttons?.child('taunt_button')?.child('muted');
    if (m) m.visible = this.muted;
    this.buttons?.child('mute_btn')?.gotoAndStop(this.muted ? 1 : 0);
  }

  /** 0x8d1228: open (true) or close the menu. */
  setMenu(open: boolean): void {
    if (open && this.ownCount >= this.globals.limit) { this.hooks.popup?.(this.text('TID_TAUNT_LIMIT_FULL')); open = false; }
    if (open && !this.menu) this.menu = new EmoteMenu(this.ui, this.art, this.libs);
    const tb = this.buttons?.child('taunt_button');
    if (tb) tb.visible = !open;
    if (!this.menu) return;
    this.menu.show(open);
    const mute = this.buttons?.child('mute_btn');
    if (mute && TAUNTS_MUTE_ENABLED) mute.visible = open;
  }

  /** The HUD update's part (0x8d1e6c), `dt` s; `target(opponent)` = the result screen's taunt area or null. */
  update(dt: number, hudShown: boolean, target: (opponent: boolean) => [number, number] | null): void {
    this.shown = hudShown;
    const dec = (v: number) => { const x = f32(v - dt); return x < 0 ? 0 : x; };
    this.oppGate = dec(this.oppGate);
    this.oppSound = dec(this.oppSound);
    this.ownGate = dec(this.ownGate);
    this.ownSound = dec(this.ownSound);
    // the button at alpha 0.5 and not interactive once the own taunts reached the limit
    if (this.tauntIdx >= 0 && this.buttons) {
      this.buttons.slot(this.tauntIdx).color = this.ownCount >= this.globals.limit ? [1, 1, 1, 0.5, 0, 0, 0] : undefined;
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const alive = b.update(dt, target(b.opponent));
      if (!alive) this.bubbles.splice(i, 1);
    }
    this.menu?.update(dt);
  }

  /** Render-time advance (UI time). */
  advance(dt: number): void {
    this.taunt.advance(dt);
    this.tauntBtn.advance(dt);
    this.muteBtn.advance(dt);
    if (this.buttons) {
      if (this.tauntIdx >= 0) this.buttons.slot(this.tauntIdx).inner = this.tauntBtn.matrix();
      if (this.muteIdx >= 0) this.buttons.slot(this.muteIdx).inner = this.muteBtn.matrix();
    }
    for (const b of this.bubbles) b.advance(dt);
    if (this.menu) { this.menu.refreshIcons(this.libs); this.menu.advance(dt); }
  }

  /**
   * A taunt arrives (0x8d601c type 3 -> 0x8d6820): `own` from the HUD player, else from the opponent; `emote`
   * or `taunt` is its data. `centreX` = the projected arena centre x, `stageH` the stage height.
   */
  receive(own: boolean, content: { emote: EmoteDef } | { taunt: TauntDef }, centreX: number, stageH: number): void {
    if (!this.shown) return; // HUD hidden (+0x29c)
    if (this.muted) {
      if (own) this.hooks.popup?.(this.text('TID_NO_TAUNT_DUE_TO_MUTE'));
      return;
    }
    if (own) {
      this.ownCount++;
      if (this.globals.limit <= this.ownCount) { this.hooks.popup?.(this.text('TID_TAUNT_LIMIT_FULL')); return; }
      this.ownGate = 1;
    } else {
      this.oppCount++;
      if (this.oppGate > 0 || this.globals.limit <= this.oppCount) return;
      this.oppGate = 1;
    }
    // the sender's earlier bubbles end
    for (const b of this.bubbles) if (b.opponent === !own) b.life = 0;
    // y = the offset (0 in a 1v1 battle) + the stage height for the own, -0.0 for the opponent
    const at: [number, number] = [centreX, own ? stageH : 0];
    const life = this.globals.showTime;
    let bubble: EmoteBubble;
    if ('emote' in content) {
      const pack = this.libs.get(content.emote.sc) ?? null;
      if (!pack) this.libs.request?.(content.emote.sc);
      bubble = new EmoteBubble(this.ui, !own, at, life, { emote: content.emote, pack });
      if (content.emote.sfx) this.hooks.sfx?.(content.emote.sfx);
    } else {
      bubble = new EmoteBubble(this.ui, !own, at, life, { text: this.text(content.taunt.tid) });
      const snd = content.taunt.sound;
      if (snd) {
        if (own && this.ownSound === 0) { this.hooks.sound?.(snd); this.ownSound = this.globals.soundCooldown * 0.001; }
        if (!own && this.oppSound === 0) { this.hooks.sound?.(snd); this.oppSound = this.globals.soundCooldown * 0.001; }
      }
    }
    // inserted at index 0 of the game layer +0x178: under the earlier bubbles
    this.bubbles.unshift(bubble);
  }

  /** HUD_taunt's origin (stage width / 2, stage height). */
  private origin(stageW: number, stageH: number): [number, number] { return [stageW * 0.5, stageH]; }

  private buttonRect(idx: number, stageW: number, stageH: number): Rect | null {
    const bt = this.buttons;
    if (!bt || idx < 0) return null;
    const kid = bt.kids[idx];
    if (!kid || !kid.visible) return null;
    const o = this.origin(stageW, stageH);
    const bm = this.taunt.slotMatrix(this.taunt.index('buttons')) ?? [1, 0, 0, 1, 0, 0];
    const sm = bt.slotMatrix(idx);
    if (!sm) return null;
    // the hit area without the template's momentary scale
    const m = matMul(matMul([1, 0, 0, 1, o[0], o[1]], bm), [sm[0], sm[1], sm[2], sm[3], sm[4], sm[5]]);
    return nodeBounds(kid, m);
  }

  private holdAt(x: number, y: number, stageW: number, stageH: number): Hold | null {
    if (!this.shown) return null;
    const menu = this.menu;
    if (menu?.visible) {
      const h = menu.hit(x, y, this.origin(stageW, stageH), menuAreaPos(stageW, stageH));
      if (h?.item) return { kind: 'item', item: h.item };
      if (h?.text) return { kind: 'text', text: h.text };
      if (TAUNTS_MUTE_ENABLED && inRect(this.buttonRect(this.muteIdx, stageW, stageH), x, y)) return { kind: 'mute' };
    }
    if (this.ownCount < this.globals.limit && inRect(this.buttonRect(this.tauntIdx, stageW, stageH), x, y)) return { kind: 'taunt' };
    return null;
  }

  private buttonOf(h: Hold): GameButton {
    switch (h.kind) {
      case 'taunt': return this.tauntBtn;
      case 'mute': return this.muteBtn;
      case 'item': return h.item.button;
      case 'text': return h.text.button;
    }
  }

  private same(a: Hold | null, b: Hold): boolean {
    if (!a || a.kind !== b.kind) return false;
    if (a.kind === 'item' && b.kind === 'item') return a.item === b.item;
    if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
    return true;
  }

  /** Touch began at stage (x, y): true when an emote control took it. */
  pointerDown(x: number, y: number, stageW: number, stageH: number): boolean {
    const h = this.holdAt(x, y, stageW, stageH);
    if (!h) return false;
    this.hold = h;
    this.buttonOf(h).press();
    return true;
  }

  pointerMove(x: number, y: number, stageW: number, stageH: number): void {
    const h = this.hold;
    if (!h) return;
    this.buttonOf(h).move(this.same(this.holdAt(x, y, stageW, stageH), h));
  }

  /** The held control's touch ended: the click (0x8d15c0 / 0x8eab24). Returns the taunt to send, if any. */
  pointerUp(x: number, y: number, stageW: number, stageH: number): { emote: EmoteDef } | { taunt: TauntDef } | null {
    const h = this.hold;
    this.hold = null;
    if (!h) return null;
    if (!this.buttonOf(h).release(this.same(this.holdAt(x, y, stageW, stageH), h))) return null;
    this.hooks.click?.();
    switch (h.kind) {
      case 'taunt': this.setMenu(!this.menu?.visible); return null;
      case 'mute':
        this.muted = !this.muted;
        this.applyMuted();
        this.setMenu(false);
        return null;
      default: {
        const menu = this.menu;
        if (!menu || menu.cooldown > 0) return null;
        let out: { emote: EmoteDef } | { taunt: TauntDef } | null = null;
        if (h.kind === 'item') {
          if (h.item.emote) out = { emote: h.item.emote };
          else this.hooks.popup?.(this.text('TID_EMOTE_MISSING')); // 0x8eac1c +0x160
        } else out = { taunt: h.text.taunt };
        menu.cooldown = f32(this.globals.cooldown10 * f32(0.1));
        this.setMenu(false);
        return out;
      }
    }
  }

  /** A touch ended on the battle screen or the hand panel (0xbe1120 / 0x8db630 -> 0x8d120c). */
  closeMenu(): void {
    if (this.menu?.visible) this.setMenu(false);
  }

  /** Game layer +0x178: the bubbles (inserted at index 0), then HUD_taunt with its menu clip. */
  drawLower(r: ScRenderer, stageW: number, stageH: number, ctx: DrawCtx): void {
    if (!this.shown) return;
    for (const b of this.bubbles) b.draw(r, ctx);
    const o = this.origin(stageW, stageH);
    this.taunt.draw(r, [1, 0, 0, 1, o[0], o[1]], WHITE as Col, ctx);
    this.menu?.drawMenu(r, o, ctx);
  }

  /** The menu's favourites area, a later child of the game layer +0x178 (added when the menu was made). */
  drawArea(r: ScRenderer, stageW: number, stageH: number, ctx: DrawCtx): void {
    if (!this.shown) return;
    this.menu?.drawArea(r, menuAreaPos(stageW, stageH), ctx);
  }
}
