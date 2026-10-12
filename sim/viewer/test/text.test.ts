// The client's TextField rendering (viewer/src/sc/text.ts, freetype.ts): FreeType's fixed-point helpers
// and smooth rasteriser (2.9.x, 0x15f8b54 / 0x15f85d8 / 0x15f7efc), the glyph outline post-process
// 0xccd5c0 and its padding (0x135fe10 / 0x15213e0), the layout flags (0x126f764), the placement of
// 0x126ab4c, and, when the baked fonts are present, the font lookup 0x1203e28 and full layouts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ftDivFix, ftMulFix, renderOutline, type Outline } from '../src/sc/freetype.ts';
import { findFont, glyphImage, glyphPads, layoutFlags, layoutTextField, measureTextField, outlinePass,
  registerFont, shapeText, textPlacement, tfOutlineColor } from '../src/sc/text.ts';
import type { TextFieldDef } from '../src/sc/library.ts';

test('FT_MulFix / FT_DivFix round half away from zero', () => {
  assert.equal(ftMulFix(3, 0x8000), 2); // 1.5 -> 2
  assert.equal(ftMulFix(-3, 0x8000), -2);
  assert.equal(ftMulFix(800, ftDivFix(1792, 1000)), 1434); // 0.8 em at 28 px, 26.6
  assert.equal(ftDivFix(1792, 1000), 117441); // (1792 << 16 + 500) / 1000
  assert.equal(ftDivFix(-1, 2), -32768);
});

test('gray raster: exact area coverage of a square, non-zero winding, 255 cap', () => {
  // square (0.5, 0.5)..(2.5, 2.5) px in 26.6
  const sq: Outline = { x: [32, 160, 160, 32], y: [32, 32, 160, 160], on: [1, 1, 1, 1], ends: [3] };
  const bm = renderOutline(sq);
  assert.deepEqual([bm.width, bm.rows, bm.left, bm.top], [3, 3, 0, 3]);
  assert.deepEqual([...bm.buf], [64, 128, 64, 128, 255, 128, 64, 128, 64]);
  // the same square wound the other way gives the same coverage
  const rev: Outline = { x: [32, 32, 160, 160], y: [32, 160, 160, 32], on: [1, 1, 1, 1], ends: [3] };
  assert.deepEqual([...renderOutline(rev).buf], [...bm.buf]);
  // a quadratic arc stays inside its control box and covers its middle
  const arc: Outline = { x: [0, 256, 512], y: [0, 512, 0], on: [1, 0, 1], ends: [2] };
  const ab = renderOutline(arc);
  assert.deepEqual([ab.width, ab.rows], [8, 8]);
  assert.ok(ab.buf[7 * 8 + 4] > 200 && ab.buf[0] === 0);
});

test('glyph padding: max(1, ceil(cfg * p / 30)) for cfg (1, 1, 3, 1)', () => {
  assert.deepEqual(glyphPads(28), [1, 1, 3, 1]);
  assert.deepEqual(glyphPads(56), [2, 2, 6, 2]);
  assert.deepEqual(glyphPads(10), [1, 1, 1, 1]);
  assert.deepEqual(glyphPads(31), [2, 2, 4, 2]);
});

test('outline post-process 0xccd5c0: box dilation (a up, c down, b left, d right) minus the fill', () => {
  const W = 7, H = 8, R = new Uint8Array(W * H);
  R[3 * W + 3] = 200;
  const G = outlinePass(R, W, H, 1, 1, 2, 1);
  const on = (x: number, y: number) => G[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBox = x >= 2 && x <= 4 && y >= 2 && y <= 5 && !(x === 3 && y === 3);
      assert.equal(on(x, y), inBox ? 200 : 0, `G(${x}, ${y})`);
    }
  }
  // partial fill keeps the uncovered rest as outline
  const R2 = new Uint8Array(W * H);
  R2[3 * W + 3] = 200; R2[3 * W + 4] = 120;
  assert.equal(outlinePass(R2, W, H, 1, 1, 2, 1)[3 * W + 4], 80);
});

test('layout flags of the align byte (0x126f764 with DAT_002b2d20)', () => {
  assert.equal(layoutFlags(0), 0);
  assert.equal(layoutFlags(1), 1); // right
  assert.equal(layoutFlags(2), 2); // centre
  assert.equal(layoutFlags(18), 2 | 8); // centre, v-centre
  assert.equal(layoutFlags(0x22), 2 | 0x10); // centre, bottom
  assert.equal(layoutFlags(4), 0); // justify on a left-to-right line: left
});

test('placement 0x126ab4c: origin rounded up, scale snapped to the stage scale within 0.01', () => {
  const p = textPlacement([2.004, 0, 0, 1.995, 10.2, 20.0], -2, -2, 0, 2);
  assert.deepEqual([p.ox, p.oy], [Math.ceil(10.2 - 4.008), 17]);
  assert.deepEqual([p.a, p.b, p.c, p.d], [1, 0, 0, 1]);
  const q = textPlacement([3, 0, 0, 3, 0, 0], 0, 0, 2, 2); // scaled 1.5x: no snap, inset 2
  assert.deepEqual([q.ox, q.oy, q.a, q.d], [6, 6, 1.5, 1.5]);
});

const FONTS = new URL('../assets/fonts/', import.meta.url);
const haveFonts = existsSync(new URL('supercell-magic_0.ttf', FONTS)) && existsSync(new URL('sc_ccbackbeatregular.ttf', FONTS));
const tf = (over: Partial<TextFieldDef> = {}): TextFieldDef => ({
  font: 'Supercell-Magic', text: '', rect: [-2, -2, 54, 36], color: 0xffffffff, outline: 0xff000000, bytes: [2, 2, 28, 0], ...over,
});

test('fonts: lookup by family, bold fallback, outlined variants (needs the baked fonts)', { skip: !haveFonts }, () => {
  registerFont(readFileSync(new URL('sc_ccbackbeatregular.ttf', FONTS)), 'sc_ccbackbeatregular.ttf');
  registerFont(readFileSync(new URL('supercell-magic_0.ttf', FONTS)), 'supercell-magic_0.ttf');
  const m = findFont('Supercell-Magic', false, false, true)!;
  assert.ok(m && m.outlined && m.name === 'Supercell-Magic');
  assert.equal(findFont('Supercell-Magic', true, false, false)?.outlined, false); // bold falls back
  assert.equal(findFont('Times New Roman', false, false, false), null);
  assert.equal(findFont('SC CCBackBeat', false, false, false)?.ttf.family, 'SC CCBackBeat');
  assert.equal(m.asc16, 13); // ceil(0.8 * 16)
  assert.equal(tfOutlineColor(tf({ outline: 0 }), m), 0xff000000);
  // kerning (GPOS PairPos): "74" is tightened by -86 units, scaled on its own like the advance
  const em = (v: number) => Math.trunc((v * 1792 + (v < 0 ? -500 : 500)) / 1000);
  const s = shapeText(m, 1792, [0x37, 0x34]);
  assert.equal(s.adv[0], em(m.ttf.hMetrics(s.gids[0]).adv) + em(-86));
});

test('glyph image of "8" at 28 / 56 px (pinned to the port)', { skip: !haveFonts }, () => {
  const m = findFont('Supercell-Magic', false, false, true)!;
  const fnv = (a: Uint8Array) => { let h = 0x811c9dc5; for (const v of a) { h ^= v; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
  const a = glyphImage(m, 28, m.ttf.glyphIndex(0x38));
  assert.deepEqual([a.w, a.h, a.xoff, a.yoff, fnv(a.r), fnv(a.g)], [23, 28, -1, -24, '8df903a6', '2ab0bf29']);
  const b = glyphImage(m, 56, m.ttf.glyphIndex(0x38));
  assert.deepEqual([b.w, b.h, b.xoff, b.yoff, fnv(b.r), fnv(b.g)], [44, 55, -1, -47, '4f69d887', '21561a5e']);
});

test('layout: top-aligned baseline, centring, whole-pixel pens, measuring (0x126f3ac / 0x126f464)', { skip: !haveFonts }, () => {
  // 28 px Supercell-Magic: ascender ceil(22.4) = 23, descender 6, gap round(28) - 23 - 6 = -1
  const lay = layoutTextField(tf(), '1:74', 1)!;
  assert.equal(lay.p, 28);
  assert.equal(lay.height, 28);
  for (const g of lay.glyphs) assert.equal(g.x, Math.round(g.x));
  // top: y0 = -(23 - 13 * 28 / 16) = -0.25 -> baseline 22.75; glyph '1' quad top = baseline + yoff
  assert.equal(lay.glyphs[0].y, 22.75 + lay.glyphs[0].img.yoff);
  // v-centre: (H - text height) / 2 = (38 - 28) / 2 = 5 -> baseline 28
  const vc = layoutTextField(tf({ bytes: [2, 18, 28, 0] }), '1', 1)!;
  assert.equal(vc.glyphs[0].y, 28 + vc.glyphs[0].img.yoff);
  // centred: offset ceil((W - line width) / 2), W = 56
  const one = layoutTextField(tf(), '1', 1)!;
  assert.equal(one.glyphs[0].x, Math.ceil(Math.fround((56 - one.width) * 0.5)) + one.glyphs[0].img.xoff);
  const ms = measureTextField(tf(), '1:74', 2)!;
  assert.ok(Math.abs(ms.h - 28) < 1e-9 && ms.w > 50 && ms.w < 60);
  // no font: nothing is drawn
  assert.equal(layoutTextField(tf({ font: 'Arial' }), 'x', 1), null);
});
