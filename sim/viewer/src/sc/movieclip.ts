// The client's MovieClip runtime (libg 160402020) for UI screens whose nested clips keep their own
// playheads (the battle intro banner, the end-of-battle result screen). ScRenderer.draw gives every
// nested clip one shared clock; these screens need the SC instance tree instead:
//   - every child clip of a clip is its own instance with its own playhead, created with its parent
//     (child index -> instance, MovieClip children +0x90, names +0x98), playing from frame 0 and
//     looping over the whole clip until code gives it a range;
//   - a clip advances inside the render traversal (vt+0x10 = 0x123f55c: time step, then the sprite
//     render 0x1252f60 over the display list), so a child advances only while it is on its parent's
//     display list (in the parent's current frame, 0x123f7b4) and visible (+8);
//   - time step 0x123f55c: once the accumulated time +0x88 reaches the frame time +0x8c, the whole
//     multiple is consumed; mode +0x4c 0 moves one frame, 1/2 move all due frames without passing the
//     range end; state +0x4d 1 (0x12422a4) walks towards the end frame (backwards through the wrap
//     when it lies behind); mode 2 then interpolates the children between the frame and the next one
//     by t = +0x88 / +0x8c (0x123fc78: matrices 0x123e96c in scale / rotation / translation, colours
//     0x124439c on the bytes); time accumulates only while the state is below 2;
//   - goto 0x123f458: reaching the end of an unlooped range stops (state 2); a frame change re-applies
//     the timeline matrices of the children (0x123f7b4), dropping code-set child positions;
//   - playRange 0x1241f50, labels 0x1241dd0 / 0x123f3c0, gotoAndStop 0x1242234, gotoAndStop(label)
//     0x12423ac, play-to 0x12422a4, frame time 0x124351c (recursive over the display list).
// Drawing walks the same tree and hands shapes and text fields to ScRenderer one by one (text through
// a one-child stand-in clip so the field gets the instance's string).

import type { Clip, ScLibrary, TextFieldDef } from './library.ts';
import { ScLibrary as Lib } from './library.ts';
import type { Col, Mat } from './math.ts';
import { colMul, matMul } from './math.ts';
import type { ScRenderer } from './renderer.ts';

const f32 = Math.fround;
const PI = f32(Math.PI);
const TAU = f32(2 * Math.PI);

/** Code-side changes to one child slot of a clip (what the client does through child pointers). */
export interface SlotOverride {
  /** visible flag (+8) of a non-clip child (clip children use McNode.visible) */
  hidden?: boolean;
  /** string set on a text field (0x126f1e4) */
  text?: string;
  /** a different display object in the slot (0x1242a8c replace / 0x1242970 replace by name): the
   * timeline matrix and colour still apply to it */
  replace?: McNode;
  /** a wrapper between the slot and the child (stretch helper 0x89b344): its content matrix */
  inner?: Mat;
  /** a code-set position of the slot (0x89a010), dropped by the next frame change (0x123f7b4) */
  offset?: [number, number];
}

export interface DrawCtx {
  /** TID key -> localised string, for text instances named with a TID */
  texts: Record<string, string>;
}

export class McNode {
  readonly lib: ScLibrary;
  readonly clip: Clip;
  frame = 0; // +0xb8
  start = 0; // +0xba
  end = -1; // +0xbc
  loop = false; // +0xc2
  state = 0; // +0x4d: 0 playing, 1 playing to the end frame, 2 stopped
  mode = 0; // +0x4c
  acc = 0; // +0x88 (float)
  ft: number; // +0x8c (float)
  visible = true; // +8
  /** interpolation factor of the last time step in mode 2 (0x123fc78), -1 when none */
  lerpT = -1;
  /** child instances by child index (null for shapes and text fields) */
  readonly kids: (McNode | null)[];
  readonly slots: (SlotOverride | undefined)[];

  constructor(lib: ScLibrary, clip: Clip) {
    this.lib = lib;
    this.clip = clip;
    this.ft = f32(1 / (clip.fps || 30));
    this.kids = Array.from(clip.children, (id) => {
      const c = lib.clips.get(id);
      return c ? new McNode(lib, c) : null;
    });
    this.slots = new Array(clip.children.length);
  }

  static of(lib: ScLibrary, exportName: string): McNode | null {
    const c = lib.clip(exportName);
    return c ? new McNode(lib, c) : null;
  }

  get frames(): number { return this.clip.frameCount; }

  /** 0x123f3c0: frame of a label, -1 when absent */
  label(name: string): number {
    return this.clip.labels.get(name) ?? -1;
  }

  /** Child index of a direct child by instance name (0x1242f34 compares case-insensitively), or -1. */
  index(name: string): number {
    const n = this.clip.names;
    if (!n) return -1;
    const k = name.toLowerCase();
    return n.findIndex((s) => s !== null && s.toLowerCase() === k);
  }

  /** Direct child clip instance by name (0x1242f34), or null. */
  child(name: string): McNode | null {
    const i = this.index(name);
    return i >= 0 ? this.kids[i] : null;
  }

  /** Descendant clip instance by name, depth first (0x1241adc / 0x89b344's search), or null. */
  find(name: string): McNode | null {
    const own = this.child(name);
    if (own) return own;
    for (const k of this.kids) {
      const f = k?.find(name);
      if (f) return f;
    }
    return null;
  }

  slot(i: number): SlotOverride {
    let s = this.slots[i];
    if (!s) { s = {}; this.slots[i] = s; }
    return s;
  }

  /** 0x123f458 */
  goto(f: number): void {
    if (this.end === f && !this.loop && this.state !== 2) { this.acc = 0; this.state = 2; }
    if (this.frame === f) return;
    this.frame = f;
    // 0x123f7b4 re-applies the timeline matrices: code-set slot positions are dropped
    for (const s of this.slots) if (s?.offset) s.offset = undefined;
  }

  private setState(stopped: boolean): void {
    if (stopped) {
      if (this.state === 2) return;
      this.state = 2;
    } else {
      if (this.state === 0) return;
      this.state = 0;
    }
    this.acc = 0;
  }

  /** 0x1241f50 */
  playRange(a: number, b: number, loop = false): void {
    this.start = a;
    this.end = b;
    this.loop = loop && a < b && b !== -1;
    if (a >= 0 && a < this.frames) this.goto(a);
    this.setState(a === b);
  }

  /** 0x1241dd0 */
  playLabels(from: string, to: string, loop = false): void {
    this.playRange(this.label(from), this.label(to), loop);
  }

  /** 0x1242234 */
  gotoAndStop(f: number): void {
    this.start = f;
    this.end = -1;
    this.loop = false;
    if (f >= 0 && f < this.frames) this.goto(f);
    else if (f === -1 && this.state === 2) return;
    this.acc = 0;
    this.state = 2;
  }

  /** 0x12423ac */
  gotoLabel(name: string): void {
    this.gotoAndStop(this.label(name));
  }

  /** 0x12422a4: play from the current frame to `f` (state 1) */
  playTo(f: number): void {
    const cur = this.frame;
    this.end = f;
    this.start = cur;
    this.loop = false;
    if (cur >= 0 && cur < this.frames) this.goto(cur);
    if (cur === f) {
      if (this.state === 2) return;
      this.state = 2;
    } else {
      if (this.state === 1) return;
      this.state = 1;
    }
    this.acc = 0;
  }

  /** 0x124351c: frame time of this clip and the clips on its display list, recursively */
  setFrameTime(ft: number): void {
    this.ft = f32(ft);
    for (const ci of this.displayed()) this.kids[ci]?.setFrameTime(ft);
  }

  /** Child indices on the display list (the current frame's elements, 0x123f7b4). */
  displayed(): number[] {
    const c = this.clip, f = Math.min(Math.max(this.frame, 0), c.frameCount - 1), out: number[] = [];
    for (let i = c.frameStart[f]; i < c.frameStart[f + 1]; i++) out.push(c.elements[i * 3]);
    return out;
  }

  /** Time step of 0x123f55c (the part before the sprite render). */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const n = this.frames;
    if (this.ft <= this.acc) {
      const k = Math.trunc(f32(this.acc / this.ft));
      this.acc = f32(this.acc - f32(k * this.ft));
      let next: number;
      if (this.state === 1) {
        const end = this.end, cur = this.frame;
        if (this.mode === 0) next = cur + (cur <= end ? 1 : n - 1);
        else if (end < cur) next = Math.max(cur - k, end);
        else next = Math.min(cur + k, end);
      } else {
        const cur = this.frame, end = this.end;
        let v: number, raw: number;
        if (this.mode === 0) {
          raw = cur + 1; v = raw;
          if (this.loop) v = this.wrap(raw);
        } else {
          raw = cur + k; v = raw;
          if (cur <= end && end < raw) v = this.loop ? this.wrap(raw) : end;
        }
        next = v;
      }
      this.goto(n !== 0 ? next % n : next);
      this.lerpT = this.mode === 2 ? this.interpT() : -1;
    } else {
      this.lerpT = this.mode === 2 ? this.interpT() : -1;
    }
    if (this.state < 2) this.acc = f32(this.acc + dt);
  }

  private wrap(v: number): number {
    const span = this.end - this.start + 1;
    return (span !== 0 ? (v - this.start) % span : v - this.start) + this.start;
  }

  /** The next frame 0x123fc78 interpolates towards, or -1 when it returns early. */
  interpNext(): number {
    const cur = this.frame, n = this.frames;
    if (this.end === -1) {
      const next = cur + 1;
      return next >= n ? next % n : next;
    }
    if (this.end <= cur || n - 1 <= cur) return -1;
    return cur + 1;
  }

  private interpT(): number {
    return this.interpNext() < 0 ? -1 : f32(this.acc / this.ft);
  }

  /** Render-time advance: this clip, then the visible clips on its display list (0x123f55c, 0x1252f60). */
  advance(dt: number): void {
    this.step(dt);
    for (const ci of this.displayed()) {
      const s = this.slots[ci];
      if (s?.replace) { if (s.replace.visible) s.replace.advance(dt); continue; }
      const k = this.kids[ci];
      if (k && k.visible) k.advance(dt);
    }
  }

  // ---------------------------------------------------------------- drawing

  /** Draw this clip with `m` / `c` as its world transform and colour (stage px). */
  draw(r: ScRenderer, m: Readonly<Mat>, c: Readonly<Col>, ctx: DrawCtx, blend = 0): void {
    const clip = this.clip, lib = this.lib;
    const f = Math.min(Math.max(this.frame, 0), clip.frameCount - 1);
    const bank = lib.banks[clip.bank];
    const t = this.lerpT;
    const nextF = t >= 0 ? this.interpNext() : -1;
    const cm: Mat = [1, 0, 0, 1, 0, 0];
    const cc: Col = [1, 1, 1, 1, 0, 0, 0];
    for (let i = clip.frameStart[f]; i < clip.frameStart[f + 1]; i++) {
      const ci = clip.elements[i * 3];
      const mi = clip.elements[i * 3 + 1];
      const coi = clip.elements[i * 3 + 2];
      const s = this.slots[ci];
      const kid = this.kids[ci];
      if (s?.hidden) continue;
      if (s?.replace ? !s.replace.visible : kid ? !kid.visible : false) continue;
      let lm: Mat = bankMat(bank.m, mi);
      let lc: Col = bankCol(bank.c, coi);
      if (nextF >= 0) {
        // 0x123fc78: the same child in the next frame
        for (let j = clip.frameStart[nextF]; j < clip.frameStart[nextF + 1]; j++) {
          if (clip.elements[j * 3] !== ci) continue;
          const mj = clip.elements[j * 3 + 1], cj = clip.elements[j * 3 + 2];
          if (mj !== mi) lm = lerpMat(t, lm, bankMat(bank.m, mj));
          if (cj !== coi) lc = lerpCol(t, lc, bankCol(bank.c, cj));
          break;
        }
      }
      if (s?.offset) { lm = [lm[0], lm[1], lm[2], lm[3], s.offset[0], s.offset[1]]; }
      matMul(m, lm, cm);
      colMul(c, lc, cc);
      if (s?.inner) matMul(cm, s.inner, cm);
      const b = (clip.blend && clip.blend[ci]) || blend;
      if (s?.replace) { s.replace.draw(r, cm, cc, ctx, b); continue; }
      if (kid) { kid.draw(r, cm, cc, ctx, b); continue; }
      const id = clip.children[ci];
      if (lib.shapes.has(id)) { r.drawId(lib, id, 0, cm, cc, b ? { blend: b } : {}); continue; }
      const tf = lib.textFields.get(id);
      if (tf) {
        const name = clip.names?.[ci] ?? null;
        const str = s?.text ?? (name && name.startsWith('TID_') ? ctx.texts[name] ?? '' : tf.text);
        if (str) drawField(r, lib, id, str, cm, cc, b);
      }
    }
  }
}

function bankMat(bm: Float64Array, mi: number): Mat {
  if (mi < 0) return [1, 0, 0, 1, 0, 0];
  const o = mi * 6;
  return [bm[o], bm[o + 1], bm[o + 2], bm[o + 3], bm[o + 4], bm[o + 5]];
}

function bankCol(bc: Float32Array, coi: number): Col {
  if (coi < 0) return [1, 1, 1, 1, 0, 0, 0];
  const o = coi * 7;
  return [bc[o], bc[o + 1], bc[o + 2], bc[o + 3], bc[o + 4], bc[o + 5], bc[o + 6]];
}

/** C fmodf (sign of the dividend). */
function fmod(a: number, b: number): number {
  return f32(a % b);
}

function wrapPos(v: number): number {
  const r = fmod(f32(v + PI), TAU);
  return r < 0 ? f32(r + TAU) : r;
}

/** 0x123e96c: matrix interpolation in scale / rotation (per axis) / translation. */
export function lerpMat(t: number, a: Readonly<Mat>, b: Readonly<Mat>): Mat {
  const out: Mat = [a[0], a[1], a[2], a[3], a[4], a[5]];
  if (!(a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3])) {
    const sa = f32(Math.sqrt(f32(a[0] * a[0] + a[1] * a[1])));
    const sya = f32(Math.sqrt(f32(a[2] * a[2] + a[3] * a[3])));
    const sb = f32(Math.sqrt(f32(b[0] * b[0] + b[1] * b[1])));
    const syb = f32(Math.sqrt(f32(b[2] * b[2] + b[3] * b[3])));
    const rxa = f32(Math.atan2(-(a[0] / sa), -(a[1] / sa)));
    const rya = f32(Math.atan2(-(a[2] / sya), -(a[3] / sya)));
    const rxb = f32(Math.atan2(-(b[0] / sb), -(b[1] / sb)));
    const ryb = f32(Math.atan2(-(b[2] / syb), -(b[3] / syb)));
    const delta = (pa: number, pb: number): number => {
      let d = fmod(f32(wrapPos(pb) - wrapPos(pa)), TAU);
      if (d > PI) d = f32(d - TAU);
      if (d < -PI) d = f32(d + TAU);
      return d;
    };
    const dx = delta(rxa, rxb), dy = delta(rya, ryb);
    let sx = sa, sy = sya;
    if (t > 0) { sx = sb; sy = syb; if (t < 1) { sx = f32(sa + t * (sb - sa)); sy = f32(sya + t * (syb - sya)); } }
    const ax = f32(rxa + PI + t * dx), ay = f32(rya + PI + t * dy);
    out[0] = f32(sx * Math.sin(ax));
    out[1] = f32(sx * Math.cos(ax));
    out[2] = f32(sy * Math.sin(ay));
    out[3] = f32(sy * Math.cos(ay));
  }
  if (t > 0) {
    out[4] = t >= 1 ? b[4] : f32(a[4] + t * (b[4] - a[4]));
    out[5] = t >= 1 ? b[5] : f32(a[5] + t * (b[5] - a[5]));
  }
  return out;
}

/** 0x124439c: colour interpolation on the 7 bytes (multipliers 0..255, adds), truncated. */
export function lerpCol(t: number, a: Readonly<Col>, b: Readonly<Col>): Col {
  if (t <= 0) return [a[0], a[1], a[2], a[3], a[4], a[5], a[6]];
  const ab = [a[0] * 255, a[1] * 255, a[2] * 255, a[3] * 255, a[4], a[5], a[6]].map((v) => Math.round(v));
  const bb = [b[0] * 255, b[1] * 255, b[2] * 255, b[3] * 255, b[4], b[5], b[6]].map((v) => Math.round(v));
  const v = ab.map((x, i) => (t >= 1 ? bb[i] : Math.trunc(f32(x + t * (bb[i] - x)))));
  return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] / 255, v[4], v[5], v[6]];
}

const textLibs = new WeakMap<ScLibrary, ScLibrary>();
const TEXT_WRAP = 1 << 20;

/** A text field drawn with a given string: a one-child stand-in clip whose child gets the text. */
function drawField(r: ScRenderer, lib: ScLibrary, id: number, str: string, m: Readonly<Mat>, c: Readonly<Col>, blend: number): void {
  let tl = textLibs.get(lib);
  if (!tl) {
    const clips: Record<string, { fps: number; n: number[]; e: number[]; c: number[]; k: number; nm: string[] }> = {};
    const tfs: Record<string, TextFieldDef> = {};
    for (const [k, v] of lib.textFields) {
      clips[String(TEXT_WRAP + k)] = { fps: 1, n: [1], e: [0, -1, -1], c: [k], k: 0, nm: ['t'] };
      tfs[String(k)] = v;
    }
    tl = new Lib({ v: 1, name: `${lib.name}#text`, tex: [], shapes: {}, clips, banks: [{ m: [], c: [] }], exports: {}, tf: tfs }, []);
    textLibs.set(lib, tl);
  }
  r.drawId(tl, TEXT_WRAP + id, 0, m, c, blend ? { blend, text: { t: str } } : { text: { t: str } });
}
