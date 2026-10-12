// Floater texts of the battle's popup manager (libg 160402020), used here for the "Not enough Elixir!"
// text of a play the client's play check rejects for elixir. Decompiles: work/native/decomp_floater/.
//
//   0xd77504  play check (client submit 0xbe1634 -> 0xcc4658 -> command vt+0x18 with param_4 = 1): when the
//             player's elixir (0xfa1c84 / 0xfa1c64) is below the card's cost it calls the battle screen's
//             listener vt+0x278 with the command's position (+0x28 / +0x2c) and returns 0xd. The elixir
//             check comes after the hand checks and before the deploy check 0xd42214. 0xbe1634 only
//             submits a command at a position its own deploy check 0xf9e16c accepts (the command then
//             carries the snapped position) and outside the own back rows.
//   0xbe7184  battle screen vt+0x278: plays a sound (battle screen vt+0xd0 0xbe43b0 -> 0xcba648 with the
//             client tables' entry +0xcc0; no sound here), counts the failure (+0x418) and shows the text
//             only once the count reaches client globals +0x1c8 = SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES
//             (loader 0xdf24d4 at 0xdf2878; client_globals.csv: 1), or while the old tutorial manager has
//             a step (game mode vt+0x88 -> +0x1d8 -> 0x11dba50: +8 != 0) or the flag +0xa0 of the global
//             _DAT_01a4e3d0 (0xaf6c28) is set; then the count is reset, the logic point is projected to
//             the stage (0x8583bc, whole px) and 0x88cb54(0, popup manager 0x88bafc, &pos,
//             TID_NOT_ENOUGH_MANA, 0xffff3366) is called.
//   0x88cb54  show(delay, manager, pos, text, colour): only with fewer than 6 live floaters (+0x158);
//             0x88ce50 picks the slot; an empty slot gets a new "floater_text" clip of sc/ui.sc (0x88f3d8
//             with the file string 0x1a5e988) and the count goes up; slot +8 = delay; then 0x88cc2c.
//   0x88ce50  slot choice: the six slots {clip, delay} at manager +0xf8 + 16 i in order; the first that
//             is empty or whose clip's FloaterContent.Text holds the same text (0x14307a8). None: no text.
//   0x88cc2c  setup(delay, clip, text, colour, pos, container +0xc0): Text: multi-line flag +0x93 = 1
//             (0x126f578), the text (0x126f1e4), fill colour +0x80 = colour (0x126f294; the outline
//             +0x84 keeps the clip's black), +0x88 = 0, vertical alignment nibble 0x10 (0x8912f0).
//             shadow: scale 1 (0x123c564), then sx = textWidth (0x126f3ac) * 1.25 / shadow width
//             (0x123c9e0), sy = max(1, textHeight (0x126f464) * 1.75 / shadow height (0x123ca58)).
//             Position = pos (0x123c548); added on top of the manager's top container +0xc0
//             (0x1252994); goto-and-stop the middle frame (frames - 1) >> 1 (0x1242234) and take the
//             text's stage bounds (0x123c69c): x0 < 1 moves the clip right by 1 - x0, else x1 past the
//             stage width (int +0x2ac minus the safe-area insets, - 1) moves it left by the excess.
//             delay <= 0: play 0..frames-1 once (0x1241f50); else stopped and hidden.
//   0x88c7fc  per frame (popup manager update 0x88bce4, its vt+0x160 via 0x899640): a slot with
//             delay <= 0 whose clip has stopped is removed (count - 1); a slot with delay > 0 counts it
//             down by the frame dt and at <= 0 plays the clip and shows it.
// The popup manager (ctor 0x88b3a4, made by the battle screen's vt+0xa20 0xbe40ec and stored at game mode
// +0x38 by 0xcc2a20) is added to the game's layer +0x170 (0xcc2a44), above the layers +0x160 / +0x168
// that hold the HUD (battle screen +0x300) and its drag texts, so floaters draw over the whole HUD; the
// layers are added to the stage root in offset order (0x77220c..0x772324, 0x1258640 appends).
// The floater_text clip (161 frames, 60 fps) does the motion itself: FloaterContent grows from
// (0.8, 0.4) and rises from y +48 to -2.7 while fading in over frames 0..8, drifts up to -18.95 by frame
// 89, then fades out to 0 at frame 160 (2.67 s), drifting back to -17.95.

import { ClipPlayer } from './anim.ts';
import type { Col, Mat } from './math.ts';
import { WHITE } from './math.ts';
import type { ScLibrary, TextFieldDef } from './library.ts';
import type { ScRenderer } from './renderer.ts';

export const FLOATER_EXPORT = 'floater_text';
/** 0x88cb54: no new floater with this many live ones (manager +0x158) */
export const MAX_FLOATERS = 6;
/** the colour 0xbe7184 passes for TID_NOT_ENOUGH_MANA (ARGB) */
export const NOT_ENOUGH_MANA_COLOR = 0xffff3366;
/** client_globals.csv SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES (client globals +0x1c8, loader 0xdf2878) */
export const SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES = 1;

/**
 * The failure counter of the battle screen's not-enough-mana listener 0xbe7184 (+0x418). `fail` counts one
 * rejected play and says whether the text shows: once the count reaches the threshold (or with the old
 * tutorial manager's step / the _DAT_01a4e3d0 flag, which the sandbox never has), resetting the count.
 */
export class NotEnoughManaGate {
  count = 0;
  readonly threshold: number;
  constructor(threshold = SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES) {
    this.threshold = threshold;
  }

  fail(tutorialStep = false, flag = false): boolean {
    this.count++;
    if (this.count < this.threshold && !(flag || tutorialStep)) return false;
    this.count = 0;
    return true;
  }
}

/** Text extents in stage px as the text field lays them out (0x126f3ac width, 0x126f464 height incl. its + 2). */
export interface TextSize { w: number; h: number }

/** The parts of floater_text the setup touches, read from the library. */
export interface FloaterParts {
  frames: number;
  fps: number;
  /** FloaterContent's matrix in floater_text at each frame (for the bounds at the middle frame) */
  contentAt: (frame: number) => Mat;
  /** the Text field, its matrix in FloaterContent */
  text: TextFieldDef;
  textM: Mat;
  /** natural width / height of the shadow child at scale 1 (0x123c9e0 / 0x123ca58) */
  shadowW: number;
  shadowH: number;
}

export interface FloaterSlot {
  clip: ClipPlayer;
  /** slot +8 */
  delay: number;
  /** clip +8 */
  visible: boolean;
  text: string;
  color: number;
  /** clip position in stage px (after the horizontal clamp) */
  x: number;
  y: number;
  /** shadow scale set by 0x88cc2c */
  sx: number;
  sy: number;
}

/**
 * The popup manager's floaters (0x88cb54 / 0x88ce50 / 0x88cc2c / 0x88c7fc). `measure` gives the laid-out
 * text size; `stageW` the stage width in stage px.
 */
export class Floaters {
  readonly slots: (FloaterSlot | null)[] = new Array(MAX_FLOATERS).fill(null);
  /** +0x158: clips created and not yet removed */
  count = 0;
  /** draw order: children of the container +0xc0, bottom first */
  private order: FloaterSlot[] = [];
  readonly parts: FloaterParts;

  constructor(parts: FloaterParts) {
    this.parts = parts;
  }

  /** 0x88ce50: the first slot that is empty or shows the same text; -1 if none. */
  pick(text: string): number {
    for (let i = 0; i < MAX_FLOATERS; i++) {
      const s = this.slots[i];
      if (!s || s.text === text) return i;
    }
    return -1;
  }

  /** 0x88cb54 + 0x88cc2c. `pos` is the projected stage point (whole px). */
  show(delay: number, pos: [number, number], text: string, color: number, size: TextSize, stageW: number): FloaterSlot | null {
    if (this.count >= MAX_FLOATERS) return null;
    const i = this.pick(text);
    if (i < 0) return null;
    const P = this.parts;
    let s = this.slots[i];
    if (!s) {
      s = { clip: new ClipPlayer(P.frames, P.fps), delay: 0, visible: true, text: '', color: 0, x: 0, y: 0, sx: 1, sy: 1 };
      this.slots[i] = s;
      this.count++;
    }
    s.delay = delay;
    // 0x88cc2c
    s.text = text;
    s.color = color;
    s.sx = P.shadowW > 0 ? (size.w * 1.25) / P.shadowW : 1;
    s.sy = P.shadowH > 0 ? Math.max(1, (size.h * 1.75) / P.shadowH) : 1;
    s.x = pos[0];
    s.y = pos[1];
    this.order = this.order.filter((o) => o !== s);
    this.order.push(s);
    const mid = (P.frames > 0 ? P.frames - 1 : P.frames) >> 1;
    s.clip.gotoAndStop(mid);
    const [x0, x1] = this.textBoundsX(s, mid, size.w);
    if (x0 < 1) s.x += 1 - x0;
    else {
      const limit = Math.trunc(stageW) - 1;
      if (x1 > limit) s.x += limit - x1;
    }
    if (delay <= 0) s.clip.playRange(0, P.frames - 1, false);
    else s.visible = false; // stopped already (gotoAndStop)
    return s;
  }

  /**
   * Horizontal stage extent of the drawn text at `frame` (0x123c69c on the Text field): the text of
   * width `w` placed in the field rect by its alignment, through FloaterContent and the clip position.
   */
  textBoundsX(s: FloaterSlot, frame: number, w: number): [number, number] {
    const P = this.parts;
    const [l, , r] = P.text.rect;
    const align = P.text.bytes[1] & 3; // 2 centre, 1 right, else left (renderer.ts drawText)
    const a = align === 2 ? (l + r - w) / 2 : align === 1 ? r - w : l;
    const cm = P.contentAt(frame);
    const tm = P.textM;
    // x of a field point (fx, fy) in the clip: content * text matrix
    const fx = (x: number, y: number) => cm[0] * (tm[0] * x + tm[2] * y + tm[4]) + cm[2] * (tm[1] * x + tm[3] * y + tm[5]) + cm[4];
    const ya = P.text.rect[1], yb = P.text.rect[3];
    const xs = [fx(a, ya), fx(a + w, ya), fx(a, yb), fx(a + w, yb)];
    return [s.x + Math.min(...xs), s.x + Math.max(...xs)];
  }

  /** One frame: the manager pass 0x88c7fc, then the clips advance (the stage update; A: their order in the frame). */
  update(dt: number): void {
    for (let i = 0; i < MAX_FLOATERS; i++) {
      const s = this.slots[i];
      if (!s) continue;
      if (s.delay <= 0) {
        if (!s.clip.playing) {
          this.slots[i] = null;
          this.count--;
          this.order = this.order.filter((o) => o !== s);
        }
      } else {
        s.delay = Math.fround(s.delay - dt);
        if (s.delay <= 0) {
          s.clip.playRange(0, this.parts.frames - 1, false);
          s.visible = true;
        }
      }
    }
    for (const s of this.order) s.clip.advance(dt);
  }

  /** Live floaters in draw order (bottom first). */
  shown(): readonly FloaterSlot[] {
    return this.order;
  }

  /**
   * Draw in stage px: shadow first, then the text in its colour. The text field's fill colour is replaced
   * by the colour; the renderer fills the clip's white and keeps its black outline, so the text pass is
   * tinted by the colour's channels (white x tint = the colour, black stays black) while the shadow pass
   * keeps the clip's own colours.
   */
  draw(r: ScRenderer, ui: ScLibrary): void {
    for (const s of this.order) {
      if (!s.visible) continue;
      const m: Mat = [1, 0, 0, 1, s.x, s.y];
      const f = s.clip.frame;
      r.draw(ui, FLOATER_EXPORT, f, m, WHITE, { named: { Text: { hide: true }, shadow: { matrix: [s.sx, 0, 0, s.sy, 0, 0] } } });
      const c = s.color;
      const tint: Col = [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, ((c >>> 24) & 255) / 255, 0, 0, 0];
      r.draw(ui, FLOATER_EXPORT, f, m, tint, { named: { shadow: { hide: true } }, text: { Text: s.text } });
    }
  }
}

/** floater_text's parts from the library (null when the export is not baked). */
export function floaterParts(ui: ScLibrary): FloaterParts | null {
  const clip = ui.clip(FLOATER_EXPORT);
  if (!clip) return null;
  const bm = ui.banks[clip.bank]?.m;
  const matOf = (bank: Float64Array | undefined, mi: number): Mat =>
    mi >= 0 && bank ? [bank[mi * 6], bank[mi * 6 + 1], bank[mi * 6 + 2], bank[mi * 6 + 3], bank[mi * 6 + 4], bank[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
  const ci = clip.names?.indexOf('FloaterContent') ?? -1;
  if (ci < 0) return null;
  const content = ui.clips.get(clip.children[ci]);
  if (!content) return null;
  const contentAt = (frame: number): Mat => {
    const f = Math.max(0, Math.min(clip.frameCount - 1, frame));
    for (let i = clip.frameStart[f]; i < clip.frameStart[f + 1]; i++) {
      if (clip.elements[i * 3] === ci) return matOf(bm, clip.elements[i * 3 + 1]);
    }
    return [1, 0, 0, 1, 0, 0];
  };
  let text: TextFieldDef | null = null;
  let textM: Mat = [1, 0, 0, 1, 0, 0];
  let shadowW = 0, shadowH = 0;
  const cbm = ui.banks[content.bank]?.m;
  for (let i = content.frameStart[0]; i < content.frameStart[1]; i++) {
    const k = content.elements[i * 3];
    const name = content.names?.[k];
    const id = content.children[k];
    if (name === 'Text' && ui.textFields.has(id)) {
      text = ui.textFields.get(id)!;
      textM = matOf(cbm, content.elements[i * 3 + 1]);
    } else if (name === 'shadow') {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      accBounds(ui, id, [1, 0, 0, 1, 0, 0], b, 0);
      if (b[0] <= b[2]) { shadowW = b[2] - b[0]; shadowH = b[3] - b[1]; }
    }
  }
  if (!text) return null;
  return { frames: clip.frameCount, fps: clip.fps || 60, contentAt, text, textM, shadowW, shadowH };
}

/** Bounds of an object's frame 0 (shapes through the display list), like 0x125a0f4 with no translation. */
function accBounds(ui: ScLibrary, id: number, m: number[], b: number[], depth: number): void {
  if (depth > 16) return;
  const shape = ui.shapes.get(id);
  if (shape) {
    for (const cmd of shape) {
      const v = cmd.verts;
      for (let i = 0; i < v.length; i += 4) {
        const x = m[0] * v[i] + m[2] * v[i + 1] + m[4];
        const y = m[1] * v[i] + m[3] * v[i + 1] + m[5];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
    return;
  }
  const clip = ui.clips.get(id);
  if (!clip || clip.frameCount < 1) return;
  const bm = ui.banks[clip.bank]?.m;
  for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
    const mi = clip.elements[i * 3 + 1];
    const cm = mi >= 0 && bm ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
    accBounds(ui, clip.children[clip.elements[i * 3]], [
      m[0] * cm[0] + m[2] * cm[1], m[1] * cm[0] + m[3] * cm[1],
      m[0] * cm[2] + m[2] * cm[3], m[1] * cm[2] + m[3] * cm[3],
      m[0] * cm[4] + m[2] * cm[5] + m[4], m[1] * cm[4] + m[3] * cm[5] + m[5],
    ], b, depth + 1);
  }
}

/**
 * Text size as the viewer's renderer draws the field (A: the client lays the text out with its own
 * glyph metrics): the font's advance width plus the outline the renderer strokes, and the glyph height
 * plus the client's + 2 (0x126f464).
 */
export function measureFieldText(tf: TextFieldDef, text: string): TextSize {
  const size = tf.bytes[2] || 16;
  const outline = (tf.outline >>> 24) & 255 ? Math.max(1, size * 0.16) : 0;
  let w = text.length * size * 0.6, h = size;
  try {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4)
      : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 4, height: 4 }) : null;
    const g = cv?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (g) {
      g.font = `${size}px "${tf.font}", "Supercell-Magic", sans-serif`;
      const mt = g.measureText(text);
      w = mt.width;
      const asc = mt.actualBoundingBoxAscent, desc = mt.actualBoundingBoxDescent;
      if (Number.isFinite(asc) && Number.isFinite(desc) && asc + desc > 0) h = asc + desc;
    }
  } catch { /* keep the estimate */ }
  return { w: w + outline, h: h + outline + 2 };
}
