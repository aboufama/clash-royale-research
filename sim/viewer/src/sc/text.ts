// The client's TextField rendering (libg 160402020), ported: fonts, glyph images, layout, measuring.
//
// Decompiles: work/native/decomp_text/ (and decomp_floater/ for the renderer 0x126ab4c).
//
// Fonts (init-fonts 0xccb3b8, .ttf loader 0x12c3e78, font ctor 0x1208b7c):
//   the client loads font/sc_ccbackbeatregular.ttf then font/supercell-magic_0.ttf (outside vi/th) and
//   registers each file twice, a plain and an outlined variant (font +0x48), at size 16 (+0x8); bold
//   / italic come from "Bold" / "Italic" in the file name (+0x49 / +0x4a), the name is the face's
//   family name. init-fonts then sets every font's glyph configuration to (1, 1, 3, 1) at base size
//   30 (0x1209cbc, +0x4c..+0x5c). A TextField finds its font by name, bold (0x91), italic (0x92) and
//   outlined (0x90) flags (0x1203e28: exact match, else the last one matching all but bold); without
//   a match it draws nothing. An outlined font forces an empty outline colour to opaque black (0x126e184).
//
// Glyphs (glyph cache 0x135fe10 / 0x135ff8c, slot 0x15213e0, raster 0x15222f0, post-process 0xccd5c0):
//   pixel size p = stage scale * TextField size; FreeType renders the unhinted glyph (freetype.ts) into
//   a slot padded by a = b = d = max(1, ceil(1 p / 30)), c = max(1, ceil(3 p / 30)): d columns left,
//   b + 1 right, a + 1 rows above, c + 1 below. Every texel gets R = G = B = A = coverage, then the
//   glyph post-process builds the outline channel: B = max of R over rows [y - c, y + a], G = max(0,
//   max of B over columns [x - d, x + b] - R) (a box dilation: c px down, a up, b left, d right). The
//   glyph quad spans the slot minus its last row and column, at (pen x + floor(xMin) - d, baseline -
//   ceil(yMax) - 1 - a).
//
// Layout (TextField 0x126e7c4 / 0x126f764 / 0x126ed3c, NativeFont 0x1208ed4, iterator 0x1209654,
// cache 0x120157c; text engine: HarfBuzz positions over the FreeType face sized to p):
//   box W x H = (right - (left + pad)) x (bottom - (top + pad)) * stage scale, pad 4 when flag 0x20;
//   line height = leading + line gap + ascender + descender of the face (FT size metrics), lines step
//   by ceil(line height); vertical align (high nibble): 0x10 centre ((H - text height) / 2), 0x20
//   bottom (H - text height), else top (-(ascender - ascender at 16 px * p / 16)); horizontal (low
//   nibble): 2 centre (ceil((W - line width) / 2)), 1 right (W - line width), else left; each glyph
//   at floor(pen x + offset), baseline = line y + ascender. Floats are float32 like the client.
//
// Not ported (none of the baked TextFields uses them; recorded in docs/FIDELITY.md): the multi-line
// break rules of the line breaker 0x15233d8 (greedy wrapping at spaces here), autofit (flag 0x40,
// 0x126f5e4), bent text (+0x9a), markup colour tags (0x8d), device fonts (flag 1: the client's
// device-font list is empty in this build, so they fall back to the name lookup, as here).

import { outlineCBox, renderOutline, TtfFont } from './freetype.ts';
import type { TextFieldDef } from './library.ts';
import { assetFetch } from './asset_fetch.ts';

const f32 = Math.fround;

// TextField definition flags (SC2 TextField byte 0x20 -> def +0x79 -> object 0x8f..0x98, 0x126a1c4)
export const TF_DEVICE_FONT = 1;
export const TF_OUTLINED = 2;
export const TF_BOLD = 4;
export const TF_ITALIC = 8;
export const TF_MULTILINE = 16;
export const TF_PADDED = 32;
export const TF_AUTOFIT = 64;

/** TextField flags, align byte, size: SC2 TextField bytes 0x20, 0x21, 0x22 (0x126c030). */
export function tfFlags(tf: TextFieldDef): number { return tf.bytes[0] | 0; }
export function tfAlign(tf: TextFieldDef): number { return tf.bytes[1] | 0; }
export function tfSize(tf: TextFieldDef): number { return tf.bytes[2] | 0; }

// -- fonts --------------------------------------------------------------------------------------------

export interface GameFont {
  ttf: TtfFont;
  /** vt+0x58: the face's family name */
  name: string;
  bold: boolean;
  italic: boolean;
  /** +0x48: the outlined variant */
  outlined: boolean;
  /** ascender of the font's own 16 px face (vt+0x60, px) */
  asc16: number;
}

/** The font files the client loads, in its order (init-fonts-load-assets, non vi/th locale). */
export const GAME_FONT_FILES = ['sc_ccbackbeatregular.ttf', 'supercell-magic_0.ttf'];
/** font size of every loaded font (0x12c3e78 passes 16.0f) */
export const FONT_BASE_SIZE = 16;
/** glyph configuration set by init-fonts on every font: 0x1209cbc(font, 1, 1, 3, 1, 30) */
export const GLYPH_CFG: readonly [number, number, number, number] = [1, 1, 3, 1];
export const GLYPH_CFG_BASE = 30;

const fonts: GameFont[] = [];
let loading: Promise<void> | null = null;
let generation = 0;

/** Register a font file the way 0x12c3e78 does: a plain and an outlined variant. */
export function registerFont(bytes: ArrayBuffer | Uint8Array, fileName: string): void {
  const ttf = new TtfFont(bytes);
  const asc16 = ttf.sizeMetrics(Math.trunc(FONT_BASE_SIZE * 64)).ascender / 64;
  for (const outlined of [false, true]) {
    fonts.push({ ttf, name: ttf.family, bold: fileName.includes('Bold'), italic: fileName.includes('Italic'), outlined, asc16 });
  }
  generation++;
}

/** Fetch and register the game fonts once (`<base>/fonts/<file>`, as tools/art/bake_web.py copies them). */
export function loadGameFonts(base = 'assets'): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const files = await Promise.all(GAME_FONT_FILES.map(async (f) => {
        try {
          const r = await assetFetch(`${base.replace(/\/$/, '')}/fonts/${f}`);
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        } catch {
          return null;
        }
      }));
      files.forEach((b, i) => { if (b) registerFont(b, GAME_FONT_FILES[i]); });
    })();
  }
  return loading;
}

export function fontsLoaded(): boolean { return fonts.length > 0; }
/** bumps whenever a font is registered (layouts made before then are stale) */
export function fontGeneration(): number { return generation; }

/** Font manager lookup 0x1203e28 (newest first): exact match, else the last match on all but bold. */
export function findFont(name: string, bold: boolean, italic: boolean, outlined: boolean): GameFont | null {
  let fallback: GameFont | null = null;
  for (let i = fonts.length - 1; i >= 0; i--) {
    const f = fonts[i];
    if (f.italic !== italic || f.name !== name || f.outlined !== outlined) continue;
    if (f.bold === bold) return f;
    fallback = f;
  }
  return fallback;
}

/** The font a TextField definition draws with (0x126e184; device fonts fall back to the name lookup). */
export function tfFont(tf: TextFieldDef): GameFont | null {
  const fl = tfFlags(tf);
  return findFont(tf.font, (fl & TF_BOLD) !== 0, (fl & TF_ITALIC) !== 0, (fl & TF_OUTLINED) !== 0);
}

/** Outline colour the renderer uses: the field's, or opaque black for an outlined font (0x126e184). */
export function tfOutlineColor(tf: TextFieldDef, font: GameFont | null): number {
  const o = tf.outline >>> 0;
  return o === 0 && font?.outlined ? 0xff000000 : o;
}

// -- glyph images ----------------------------------------------------------------------------------------

export interface GlyphImage {
  key: string;
  /** visible quad size in device px (slot minus its last column / row) */
  w: number;
  h: number;
  /** quad offset from (pen x, baseline) */
  xoff: number;
  yoff: number;
  /** fill coverage (R) and outline coverage (G), w * h, rows top-down */
  r: Uint8Array;
  g: Uint8Array;
  /** no coverage at all (spaces) */
  empty: boolean;
}

/** Glyph padding a, b, c, d at pixel size p (0x135fe10: max(1, ceil(cfg * p / 30)) in float32). */
export function glyphPads(p: number): [number, number, number, number] {
  return GLYPH_CFG.map((v) => {
    const q = Math.ceil(f32(f32(v * p) / GLYPH_CFG_BASE));
    return q > 1 ? q : 1;
  }) as [number, number, number, number];
}

/**
 * The glyph post-process 0xccd5c0 on a slot (R = coverage): returns G. Rows [0, H - 1) and columns
 * [0, W - 1) are processed; B (vertical max) starts as the coverage, like the atlas texel.
 */
export function outlinePass(R: Uint8Array, W: number, H: number, a: number, b: number, c: number, d: number): Uint8Array {
  const B = R.slice();
  const G = R.slice();
  if (!((a | b | c | d) !== 0 && H > 1 && W > 1)) return G;
  for (let y = 0; y < H - 1; y++) {
    const lo = Math.max(0, y - c), hi = Math.min(y + a, H - 1);
    for (let x = 0; x < W - 1; x++) {
      let m = 0;
      for (let yy = lo; yy <= hi; yy++) { const v = R[yy * W + x]; if (v > m) m = v; }
      B[y * W + x] = hi < lo ? 0 : m;
    }
  }
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const lo = Math.max(0, x - d), hi = Math.min(x + b, W - 1);
      let m = 0;
      for (let xx = lo; xx <= hi; xx++) { const v = B[y * W + xx]; if (v > m) m = v; }
      const r = R[y * W + x];
      G[y * W + x] = m > r ? m - r : 0;
    }
  }
  return G;
}

const glyphCache = new Map<string, GlyphImage>();

/** Glyph `gid` of `font` at pixel size p (26.6 char size trunc(p * 64)), as the glyph cache stores it. */
export function glyphImage(font: GameFont, p: number, gid: number): GlyphImage {
  const size26 = Math.trunc(p * 64);
  const [a, b, c, d] = glyphPads(p);
  const key = `${font.name}|${size26}|${a},${b},${c},${d}|${gid}`;
  let img = glyphCache.get(key);
  if (img) return img;
  const sm = font.ttf.sizeMetrics(size26);
  const o = font.ttf.outline(gid, sm.xScale, sm.yScale);
  const [cx0, cy0, cx1, cy1] = outlineCBox(o);
  // 0x1522704: floor / ceil of the 26.6 control box
  const x0 = Math.floor(cx0 / 64), y0 = Math.floor(cy0 / 64);
  const w = Math.ceil(cx1 / 64) - x0, h = Math.ceil(cy1 / 64) - y0;
  const Ws = d + (b + 1) + (w + 1), Hs = (h + 1) + a + (c + 1);
  const R = new Uint8Array(Ws * Hs);
  const bm = renderOutline(o);
  for (let r = 0; r < bm.rows; r++) {
    for (let q = 0; q < bm.width; q++) R[(a + 1 + r) * Ws + d + q] = bm.buf[r * bm.width + q];
  }
  const G = outlinePass(R, Ws, Hs, a, b, c, d);
  const vw = Ws - 1, vh = Hs - 1;
  const rr = new Uint8Array(vw * vh), gg = new Uint8Array(vw * vh);
  let any = false;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const s = y * Ws + x, t = y * vw + x;
      rr[t] = R[s];
      gg[t] = G[s];
      if (R[s] | G[s]) any = true;
    }
  }
  img = { key, w: vw, h: vh, xoff: x0 - d, yoff: -(h + 1 + y0 + a), r: rr, g: gg, empty: !any };
  glyphCache.set(key, img);
  return img;
}

// -- shaping (HarfBuzz over the sized face: hmtx advances, GPOS `kern` pairs) ------------------------

/**
 * HarfBuzz em_scale (hb-font.hh before 2.6: round(v * scale / upem), half away from zero) with the
 * font scale set to the face's 26.6 character size. Positions are 26.6 px.
 */
function emScale(v: number, scale: number, upem: number): number {
  let s = v * scale;
  s += s >= 0 ? upem >> 1 : -(upem >> 1);
  return Math.trunc(s / upem);
}

export interface Shaped { cps: number[]; gids: number[]; adv: number[]; xoff: number[] }

/** HarfBuzz-style positions of code points (26.6 advances and x offsets). */
export function shapeText(font: GameFont, size26: number, cps: number[]): Shaped {
  const t = font.ttf, upem = t.upem;
  const gids = cps.map((cp) => t.glyphIndex(cp));
  const adv = gids.map((g) => emScale(t.hMetrics(g).adv, size26, upem));
  const xoff = gids.map(() => 0);
  for (let i = 0; i + 1 < gids.length;) {
    const v = t.pairAdjust(gids[i], gids[i + 1]);
    if (!v) { i++; continue; }
    adv[i] += emScale(v.xAdv1, size26, upem);
    xoff[i] += emScale(v.xPla1, size26, upem);
    adv[i + 1] += emScale(v.xAdv2, size26, upem);
    xoff[i + 1] += emScale(v.xPla2, size26, upem);
    i += v.hasV2 ? 2 : 1;
  }
  return { cps, gids, adv, xoff };
}

// -- TextField layout --------------------------------------------------------------------------------------

export interface TfGlyph {
  img: GlyphImage;
  /** quad top-left in device px from the text origin (x whole, y may be fractional) */
  x: number;
  y: number;
}

export interface TfLayout {
  font: GameFont;
  /** stage scale the layout was made for and the pixel size p */
  S: number;
  p: number;
  glyphs: TfGlyph[];
  /** stage px from (left, top) to the text origin: 2 when padded (0x126ab4c fVar40) */
  inset: number;
  /** widest line and text height, device px (0x1201bf0, cache +0x34) */
  width: number;
  height: number;
}

const HALIGN_FLAGS = [1, 2, 0, 32]; // DAT_002b2d20: align low nibble 1..4 -> layout flags

/** Layout flags from the TextField align byte (0x126f764). */
export function layoutFlags(align: number): number {
  const h = (align & 15) - 1;
  let f = h >= 0 && h < 4 ? HALIGN_FLAGS[h] : 0;
  if ((align & 0xf0) === 0x20) f |= 0x10;
  else if ((align & 0xf0) === 0x10) f |= 8;
  // justify on a left-to-right line resolves to left (0x1208ed4: (flags & 0x23) == 0x20 -> vt+0x68)
  if ((f & 0x23) === 0x20) f &= 0x1c;
  return f;
}

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

interface Line { start: number; end: number }

/**
 * Lay a TextField's text out at stage scale S (device px per stage px). Null when the field has no
 * font (the client draws nothing then).
 */
export function layoutTextField(tf: TextFieldDef, text: string, S: number): TfLayout | null {
  const font = tfFont(tf);
  if (!font) return null;
  const flags = tfFlags(tf), size = tfSize(tf);
  const scaleParam = f32(f32(S * size) / FONT_BASE_SIZE); // 0x126e7c4
  const p = f32(FONT_BASE_SIZE * scaleParam);
  const size26 = Math.trunc(p * 64); // 0x1521810
  const pad = flags & TF_PADDED ? 4 : 0;
  const [l, t, r, b] = tf.rect;
  const W = f32(f32(r - f32(l + pad)) * S), H = f32(f32(b - f32(t + pad)) * S);
  const leading = f32(S * (tf.lead ?? 0));
  const lf = layoutFlags(tfAlign(tf));
  const multiline = (flags & TF_MULTILINE) !== 0;

  const sm = font.ttf.sizeMetrics(size26);
  const asc = sm.ascender / 64, desc = -sm.descender / 64;
  const gap = (sm.height - sm.ascender + sm.descender) / 64;
  const LH = f32(f32(f32(leading + gap) + asc) + desc); // 0x1209970
  const step = f32(Math.ceil(LH));

  const cps = codePoints(text);
  const sh = shapeText(font, size26, cps);
  // lines: hard breaks, plus greedy wrapping at spaces when multi-line (A: not the 0x15233d8 rules)
  const lines: Line[] = [];
  let s0 = 0;
  for (let i = 0; i <= cps.length; i++) {
    if (i < cps.length && cps[i] !== 10) continue;
    let st = s0;
    while (multiline && st < i) {
      let wsum = 0, lastSpace = -1, end = i;
      for (let k = st; k < i; k++) {
        if (cps[k] === 32) lastSpace = k;
        wsum = f32(wsum + sh.adv[k] / 64);
        if (wsum > W && lastSpace > st) { end = lastSpace; break; }
      }
      if (end === i) break;
      lines.push({ start: st, end });
      st = end + 1;
    }
    lines.push({ start: st, end: i });
    s0 = i + 1;
  }

  let height = 0;
  for (let k = 0; k < lines.length; k++) height = f32(height + step); // 0x12098e0
  let y0: number;
  if (lf & 0x10) y0 = f32(H - height);
  else if (lf & 8) y0 = f32(f32(H - height) * 0.5);
  else y0 = cps.length ? f32(0 - f32(asc - font.asc16 * scaleParam)) : 0; // fmsub: one rounding

  const glyphs: TfGlyph[] = [];
  let lineY = y0, maxW = 0, maxH = 0;
  for (const ln of lines) {
    let lineW = 0, lineLeft = 0, lead = true;
    for (let k = ln.start; k < ln.end; k++) {
      lineW = f32(lineW + sh.adv[k] / 64);
      if (lead && cps[k] === 32) lineLeft = f32(lineLeft + sh.adv[k] / 64);
      else lead = false;
    }
    const vis = f32(lineW - lineLeft);
    let off = 0;
    if ((lf & 0x23) === 2) off = Math.ceil(f32(f32(W - vis) * 0.5));
    else if ((lf & 0x23) === 1) off = f32(W - vis);
    const baseline = f32(lineY + asc);
    let pen = f32(-lineLeft);
    for (let k = ln.start; k < ln.end; k++) {
      const x = f32(pen + sh.xoff[k] / 64);
      pen = f32(pen + sh.adv[k] / 64);
      const img = glyphImage(font, p, sh.gids[k]);
      const penX = Math.floor(f32(x + off));
      glyphs.push({ img, x: penX + img.xoff, y: f32(baseline + img.yoff) });
    }
    if (ln.end > ln.start) {
      if (lineW > maxW) maxW = lineW;
      const hh = f32(f32(lineY + LH) - y0);
      if (hh > maxH) maxH = hh;
    }
    lineY = f32(lineY + step);
  }
  return { font, S, p, glyphs, inset: pad ? 2 : 0, width: maxW, height: maxH };
}

export interface TextPlacement {
  /** text origin, whole device px */
  ox: number;
  oy: number;
  /** matrix entries for glyph offsets: device = origin + [a c; b d] * (glyph px) */
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * Where 0x126ab4c puts the glyphs: M is the field's device matrix [a, b, c, d, tx, ty] (stage px ->
 * device px). With pixel snapping (TextField 0x88, set by the constructor; off for bent text) the
 * origin M (left + inset, top + inset) is rounded up (frintp) and each scale entry within 0.01 of the
 * stage scale S becomes S; glyph offsets (device px of the layout) are divided by S, so an unscaled
 * field maps its glyph texels 1:1 onto device pixels.
 */
export function textPlacement(M: readonly number[], left: number, top: number, inset: number, S: number): TextPlacement {
  const x = left + inset, y = top + inset;
  // the client multiplies float32 matrices; ours are float64: tolerate float noise at whole pixels
  const EPS = 1e-3;
  const snap = (v: number): number => (Math.abs(v - S) <= 0.01 ? S : v);
  return {
    ox: Math.ceil(M[0] * x + M[2] * y + M[4] - EPS),
    oy: Math.ceil(M[1] * x + M[3] * y + M[5] - EPS),
    a: snap(M[0]) / S, b: snap(M[1]) / S, c: snap(M[2]) / S, d: snap(M[3]) / S,
  };
}

/** TextField text width / height in stage px (0x126f3ac / 0x126f464, the classic text path). */
export function measureTextField(tf: TextFieldDef, text: string, S: number): { w: number; h: number } | null {
  const lay = layoutTextField(tf, text, S);
  if (!lay) return null;
  return { w: lay.width / S, h: lay.height / S };
}

/** Drop cached glyph images (they are rebuilt on demand). */
export function clearGlyphCache(): void {
  glyphCache.clear();
}

// The viewer serves the baked fonts at assets/fonts/ (tools/art/bake_web.py): start fetching them when
// the module loads, so the first frames (and the card thumbnails) find them registered.
if (typeof window !== 'undefined' && typeof fetch === 'function') void loadGameFonts();
