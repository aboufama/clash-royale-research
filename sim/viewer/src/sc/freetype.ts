// TrueType loading and FreeType 2.9.x glyph rasterisation, as libg 160402020 builds its text glyphs.
//
// The client's text engine shapes with HarfBuzz and rasterises with the FreeType it links: the glyph
// cache asks FTC_ImageCache_Lookup for the glyph with load flags 0x100002 (FT_LOAD_NO_HINTING |
// FT_LOAD_COLOR), turns it into a bitmap with FT_Glyph_To_Bitmap(FT_RENDER_MODE_NORMAL) and copies the
// grey values into its atlas (0x15222f0, decompiled in work/native/decomp_text/). The FreeType build
// is 2.9.x: its smooth renderer computes the bitmap box itself (0x15f8f30, pre-2.10), its line
// renderer is the 2.9 reciprocal-division one (0x15f8b54, the 0x00ffffffffffffff / dx and `>> 56`
// pair), the conic one counts bisections (0x15f85d8) and the sweep is inlined in gray_convert_glyph
// (0x15f7efc). Those four are ported here line for line (FreeType's public ftgrays.c of that version
// is the reading aid; every branch was checked against the decompile).
//
// Scaling follows FreeType's unhinted TrueType path: FT_Request_Metrics (nominal size at 72 dpi:
// x_scale = FT_DivFix(char size, units per EM)), points scaled with FT_MulFix, the size metrics grid
// fitted (ascender ceil, descender floor, height round; GRID_FIT_METRICS) and the outline shifted by
// the phantom point pp1.x. All integer arithmetic is exact (values stay far below 2^53; the 64-bit
// reciprocal products use BigInt).

/** TrueType outline in 26.6 units, y up (FreeType's FT_Outline). */
export interface Outline {
  x: number[];
  y: number[];
  /** 1 = on the curve, 0 = conic control point (FT_CURVE_TAG) */
  on: number[];
  /** index of each contour's last point */
  ends: number[];
}

/** An 8-bit coverage bitmap as FT_Glyph_To_Bitmap returns it (rows top-down). */
export interface Bitmap {
  width: number;
  rows: number;
  /** bitmap_left: floor(cbox.xMin / 64) */
  left: number;
  /** bitmap_top: ceil(cbox.yMax / 64) */
  top: number;
  buf: Uint8Array;
}

// -- FreeType fixed-point helpers (ftcalc.c, generic 64-bit versions; aarch64 has no MulFix assembler) --

/** FT_MulFix: (|a| * |b| + 0x8000) >> 16 with the sign restored. */
export function ftMulFix(a: number, b: number): number {
  let s = 1;
  if (a < 0) { a = -a; s = -s; }
  if (b < 0) { b = -b; s = -s; }
  const c = Math.floor((a * b + 0x8000) / 65536);
  return s < 0 ? -c : c;
}

/** FT_DivFix: ((|a| << 16) + |b| / 2) / |b| with the sign restored. */
export function ftDivFix(a: number, b: number): number {
  let s = 1;
  if (a < 0) { a = -a; s = -s; }
  if (b < 0) { b = -b; s = -s; }
  const q = b > 0 ? Math.floor((a * 65536 + Math.floor(b / 2)) / b) : 0x7fffffff;
  return s < 0 ? -q : q;
}

export const pixCeil = (x: number): number => (x + 63) & ~63;
export const pixFloor = (x: number): number => x & ~63;
export const pixRound = (x: number): number => (x + 32) & ~63;

/** FreeType size metrics of a scalable face (ft_recompute_scaled_metrics with GRID_FIT_METRICS), 26.6. */
export interface SizeMetrics {
  xScale: number;
  yScale: number;
  ascender: number;
  descender: number;
  height: number;
}

interface PairValue { xPla1: number; xAdv1: number; xPla2: number; xAdv2: number; hasV2: boolean }

/** The tables of one TrueType font file that the client's text path reads. */
export class TtfFont {
  readonly dv: DataView;
  readonly tables = new Map<string, { off: number; len: number }>();
  readonly upem: number;
  readonly numGlyphs: number;
  /** FT_FaceRec ascender / descender / height (font units; sfnt_load_face: hhea, else OS/2) */
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  /** name ID 1 (FT_Face family_name; the client's font lookup compares the TextField's font with it) */
  readonly family: string;
  readonly style: string;
  private readonly locFormat: number;
  private readonly numHMetrics: number;
  private readonly cmap: (cp: number) => number;
  private readonly kern = new Map<number, PairValue>();
  /** glyph pairs not in `kern` but covered by a PairPos format 2 subtable */
  private readonly classKern: ((g1: number, g2: number) => PairValue | null)[] = [];

  constructor(bytes: ArrayBuffer | Uint8Array) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dv = this.dv;
    const n = dv.getUint16(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + 16 * i;
      const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      this.tables.set(tag, { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) });
    }
    const head = this.tab('head');
    this.upem = dv.getUint16(head + 18);
    this.locFormat = dv.getInt16(head + 50);
    this.numGlyphs = dv.getUint16(this.tab('maxp') + 4);
    const hhea = this.tab('hhea');
    this.numHMetrics = dv.getUint16(hhea + 34);
    let asc = dv.getInt16(hhea + 4), desc = dv.getInt16(hhea + 6);
    let height = asc - desc + dv.getInt16(hhea + 8);
    const os2 = this.tables.get('OS/2');
    if (!(asc || desc) && os2) {
      const ta = dv.getInt16(os2.off + 68), td = dv.getInt16(os2.off + 70), tg = dv.getInt16(os2.off + 72);
      if (ta || td) { asc = ta; desc = td; height = ta - td + tg; } else {
        asc = dv.getUint16(os2.off + 74); desc = -dv.getUint16(os2.off + 76); height = asc - desc;
      }
    }
    this.ascender = asc; this.descender = desc; this.height = height;
    this.family = this.name(1);
    this.style = this.name(2);
    this.cmap = this.parseCmap();
    this.parseGpos();
  }

  private tab(tag: string): number {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`ttf: no ${tag} table`);
    return t.off;
  }

  private name(id: number): string {
    const t = this.tables.get('name');
    if (!t) return '';
    const dv = this.dv, o = t.off, count = dv.getUint16(o + 2), so = o + dv.getUint16(o + 4);
    let mac = '';
    for (let i = 0; i < count; i++) {
      const r = o + 6 + 12 * i;
      const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), nid = dv.getUint16(r + 6);
      const len = dv.getUint16(r + 8), off = so + dv.getUint16(r + 10);
      if (nid !== id) continue;
      if (pid === 3 || pid === 0) {
        let s = '';
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
        if (pid === 3 && (eid === 1 || eid === 10)) return s;
        if (!mac) mac = s;
      } else if (pid === 1 && !mac) {
        for (let k = 0; k < len; k++) mac += String.fromCharCode(dv.getUint8(off + k));
      }
    }
    return mac;
  }

  /** cmap: (3,10) format 12, else (3,1)/(0,x) format 4, else (1,0) format 0 or 6. */
  private parseCmap(): (cp: number) => number {
    const dv = this.dv, base = this.tab('cmap'), n = dv.getUint16(base + 2);
    const subs: { pid: number; eid: number; off: number; fmt: number }[] = [];
    for (let i = 0; i < n; i++) {
      const pid = dv.getUint16(base + 4 + 8 * i), eid = dv.getUint16(base + 6 + 8 * i);
      const off = base + dv.getUint32(base + 8 + 8 * i);
      subs.push({ pid, eid, off, fmt: dv.getUint16(off) });
    }
    const pick = subs.find((s) => s.pid === 3 && s.eid === 10 && s.fmt === 12)
      ?? subs.find((s) => s.pid === 0 && s.fmt === 12)
      ?? subs.find((s) => s.pid === 3 && s.eid === 1 && s.fmt === 4)
      ?? subs.find((s) => s.pid === 0 && s.fmt === 4)
      ?? subs.find((s) => s.pid === 1 && s.eid === 0);
    if (!pick) return () => 0;
    const o = pick.off;
    if (pick.fmt === 4) {
      const segX2 = dv.getUint16(o + 6), ends = o + 14, starts = ends + segX2 + 2;
      const deltas = starts + segX2, ranges = deltas + segX2;
      return (cp) => {
        if (cp > 0xffff) return 0;
        for (let i = 0; i < segX2 / 2; i++) {
          const end = dv.getUint16(ends + 2 * i);
          if (cp > end) continue;
          const start = dv.getUint16(starts + 2 * i);
          if (cp < start) return 0;
          const delta = dv.getInt16(deltas + 2 * i), ro = dv.getUint16(ranges + 2 * i);
          if (ro === 0) return (cp + delta) & 0xffff;
          const gi = dv.getUint16(ranges + 2 * i + ro + 2 * (cp - start));
          return gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        return 0;
      };
    }
    if (pick.fmt === 12) {
      const ng = dv.getUint32(o + 12);
      return (cp) => {
        for (let i = 0; i < ng; i++) {
          const g = o + 16 + 12 * i, s = dv.getUint32(g), e = dv.getUint32(g + 4);
          if (cp >= s && cp <= e) return dv.getUint32(g + 8) + cp - s;
        }
        return 0;
      };
    }
    if (pick.fmt === 6) {
      const first = dv.getUint16(o + 6), count = dv.getUint16(o + 8);
      return (cp) => (cp >= first && cp < first + count ? dv.getUint16(o + 10 + 2 * (cp - first)) : 0);
    }
    return (cp) => (cp < 256 ? dv.getUint8(o + 6 + cp) : 0);
  }

  glyphIndex(cp: number): number {
    return this.cmap(cp);
  }

  /** hmtx advance width and left side bearing (font units). */
  hMetrics(g: number): { adv: number; lsb: number } {
    const dv = this.dv, o = this.tab('hmtx'), nh = this.numHMetrics;
    if (g < nh) return { adv: dv.getUint16(o + 4 * g), lsb: dv.getInt16(o + 4 * g + 2) };
    return { adv: dv.getUint16(o + 4 * (nh - 1)), lsb: dv.getInt16(o + 4 * nh + 2 * (g - nh)) };
  }

  // -- GPOS kerning (the only OpenType layout these fonts carry: one `kern` feature, PairPos lookups) --

  private parseGpos(): void {
    const t = this.tables.get('GPOS');
    if (!t) return;
    const dv = this.dv, base = t.off;
    const scriptList = base + dv.getUint16(base + 4), featList = base + dv.getUint16(base + 6);
    const lookupList = base + dv.getUint16(base + 8);
    // HarfBuzz's script selection for a Latin / Common run: the script's tag, else DFLT, dflt, latn
    const scripts = new Map<string, number>();
    for (let i = 0, n = dv.getUint16(scriptList); i < n; i++) {
      const r = scriptList + 2 + 6 * i;
      scripts.set(this.tag4(r), scriptList + dv.getUint16(r + 4));
    }
    const so = scripts.get('latn') ?? scripts.get('DFLT') ?? scripts.get('dflt');
    if (so === undefined) return;
    const dls = dv.getUint16(so);
    if (!dls) return;
    const ls = so + dls;
    const feats: number[] = [];
    for (let i = 0, n = dv.getUint16(ls + 4); i < n; i++) feats.push(dv.getUint16(ls + 6 + 2 * i));
    const lookups = new Set<number>();
    for (const fi of feats) {
      const r = featList + 2 + 6 * fi;
      if (this.tag4(r) !== 'kern') continue;
      const fo = featList + dv.getUint16(r + 4);
      for (let k = 0, n = dv.getUint16(fo + 2); k < n; k++) lookups.add(dv.getUint16(fo + 4 + 2 * k));
    }
    for (const li of [...lookups].sort((a, b) => a - b)) {
      const lo = lookupList + dv.getUint16(lookupList + 2 + 2 * li);
      let type = dv.getUint16(lo);
      for (let s = 0, ns = dv.getUint16(lo + 4); s < ns; s++) {
        let st = lo + dv.getUint16(lo + 6 + 2 * s);
        if (type === 9) { type = dv.getUint16(st + 2); st += dv.getUint32(st + 4); }
        if (type === 2) this.parsePairPos(st);
      }
    }
  }

  private tag4(o: number): string {
    const dv = this.dv;
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }

  private coverage(o: number): number[] {
    const dv = this.dv, fmt = dv.getUint16(o), n = dv.getUint16(o + 2), out: number[] = [];
    if (fmt === 1) for (let i = 0; i < n; i++) out.push(dv.getUint16(o + 4 + 2 * i));
    else for (let i = 0; i < n; i++) {
      const r = o + 4 + 6 * i;
      for (let g = dv.getUint16(r); g <= dv.getUint16(r + 2); g++) out.push(g);
    }
    return out;
  }

  private classDef(o: number): (g: number) => number {
    const dv = this.dv, fmt = dv.getUint16(o);
    if (fmt === 1) {
      const first = dv.getUint16(o + 2), n = dv.getUint16(o + 4);
      return (g) => (g >= first && g < first + n ? dv.getUint16(o + 6 + 2 * (g - first)) : 0);
    }
    const n = dv.getUint16(o + 2);
    return (g) => {
      for (let i = 0; i < n; i++) {
        const r = o + 4 + 6 * i;
        if (g >= dv.getUint16(r) && g <= dv.getUint16(r + 2)) return dv.getUint16(r + 4);
      }
      return 0;
    };
  }

  /** A ValueRecord's x placement and x advance (device tables only matter with hinting/ppem: skipped). */
  private valueRecord(o: number, fmt: number): [number, number, number] {
    const dv = this.dv;
    let p = o, xPla = 0, xAdv = 0;
    if (fmt & 1) { xPla = dv.getInt16(p); p += 2; }
    if (fmt & 2) p += 2;
    if (fmt & 4) { xAdv = dv.getInt16(p); p += 2; }
    for (let bit = 8; bit <= 0x80; bit <<= 1) if (fmt & bit) p += 2;
    return [xPla, xAdv, p - o];
  }

  private recordSize(fmt: number): number {
    let n = 0;
    for (let bit = 1; bit <= 0x80; bit <<= 1) if (fmt & bit) n += 2;
    return n;
  }

  private parsePairPos(st: number): void {
    const dv = this.dv, fmt = dv.getUint16(st), cov = this.coverage(st + dv.getUint16(st + 2));
    const vf1 = dv.getUint16(st + 4), vf2 = dv.getUint16(st + 6);
    const s1 = this.recordSize(vf1), s2 = this.recordSize(vf2);
    if (fmt === 1) {
      for (let i = 0, n = dv.getUint16(st + 8); i < n && i < cov.length; i++) {
        const ps = st + dv.getUint16(st + 10 + 2 * i), g1 = cov[i];
        for (let k = 0, m = dv.getUint16(ps); k < m; k++) {
          const r = ps + 2 + k * (2 + s1 + s2), g2 = dv.getUint16(r);
          const key = g1 * 65536 + g2;
          if (this.kern.has(key)) continue; // the first subtable that covers a pair wins
          const [xPla1, xAdv1] = this.valueRecord(r + 2, vf1);
          const [xPla2, xAdv2] = this.valueRecord(r + 2 + s1, vf2);
          this.kern.set(key, { xPla1, xAdv1, xPla2, xAdv2, hasV2: vf2 !== 0 });
        }
      }
    } else if (fmt === 2) {
      const cd1 = this.classDef(st + dv.getUint16(st + 8)), cd2 = this.classDef(st + dv.getUint16(st + 10));
      const n2 = dv.getUint16(st + 14), covSet = new Set(cov);
      this.classKern.push((g1, g2) => {
        if (!covSet.has(g1)) return null;
        const r = st + 16 + (cd1(g1) * n2 + cd2(g2)) * (s1 + s2);
        const [xPla1, xAdv1] = this.valueRecord(r, vf1);
        const [xPla2, xAdv2] = this.valueRecord(r + s1, vf2);
        return { xPla1, xAdv1, xPla2, xAdv2, hasV2: vf2 !== 0 };
      });
    }
  }

  /** PairPos adjustment of the pair (g1, g2) in font units, or null when no subtable covers it. */
  pairAdjust(g1: number, g2: number): PairValue | null {
    const v = this.kern.get(g1 * 65536 + g2);
    if (v) return v;
    for (const f of this.classKern) {
      const r = f(g1, g2);
      if (r) return r;
    }
    return null;
  }

  // -- glyph outlines (FreeType's TrueType loader, unhinted) --

  private glyphRange(g: number): [number, number] {
    const dv = this.dv, loca = this.tab('loca');
    if (g < 0 || g >= this.numGlyphs) return [0, 0];
    if (this.locFormat === 0) return [dv.getUint16(loca + 2 * g) * 2, dv.getUint16(loca + 2 * g + 2) * 2];
    return [dv.getUint32(loca + 4 * g), dv.getUint32(loca + 4 * g + 4)];
  }

  /** The glyph's points in font units (contours as in glyf; composites resolved, unscaled). */
  private rawGlyph(g: number, depth = 0): { x: number[]; y: number[]; on: number[]; ends: number[]; xMin: number } | null {
    const [a, b] = this.glyphRange(g);
    if (b <= a || depth > 8) return null;
    const dv = this.dv, o = this.tab('glyf') + a;
    const nc = dv.getInt16(o), xMin = dv.getInt16(o + 2);
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++) ends.push(dv.getUint16(o + 10 + 2 * i));
      const np = nc ? ends[nc - 1] + 1 : 0;
      let p = o + 10 + 2 * nc;
      p += 2 + dv.getUint16(p);
      const flags: number[] = [];
      while (flags.length < np) {
        const f = dv.getUint8(p++);
        flags.push(f);
        if (f & 8) { let r = dv.getUint8(p++); while (r-- > 0 && flags.length < np) flags.push(f); }
      }
      const x: number[] = [], y: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) { const d = dv.getUint8(p++); v += f & 16 ? d : -d; } else if (!(f & 16)) { v += dv.getInt16(p); p += 2; }
        x.push(v);
      }
      v = 0;
      for (const f of flags) {
        if (f & 4) { const d = dv.getUint8(p++); v += f & 32 ? d : -d; } else if (!(f & 32)) { v += dv.getInt16(p); p += 2; }
        y.push(v);
      }
      return { x, y, on: flags.map((f) => f & 1), ends, xMin };
    }
    return null; // composites are assembled after scaling (outline())
  }

  /**
   * FT_Load_Glyph(FT_LOAD_NO_HINTING) outline at the given scale (16.16, FT_Size_Metrics x/y_scale),
   * in 26.6, translated by -pp1.x (TT_Load_Glyph).
   */
  outline(g: number, xScale: number, yScale: number, depth = 0): Outline {
    const out: Outline = { x: [], y: [], on: [], ends: [] };
    const [a, b] = this.glyphRange(g);
    if (b <= a || depth > 8) return out;
    const dv = this.dv, o = this.tab('glyf') + a;
    const nc = dv.getInt16(o), xMin = dv.getInt16(o + 2);
    const { lsb } = this.hMetrics(g);
    // phantom point pp1.x: the final outline is translated by -pp1.x (components keep their own frame)
    const pp1x = depth === 0 ? ftMulFix(xMin - lsb, xScale) : 0;
    if (nc >= 0) {
      const raw = this.rawGlyph(g, depth)!;
      for (let i = 0; i < raw.x.length; i++) {
        out.x.push(ftMulFix(raw.x[i], xScale) - pp1x);
        out.y.push(ftMulFix(raw.y[i], yScale));
        out.on.push(raw.on[i]);
      }
      out.ends.push(...raw.ends);
      return out;
    }
    // composite (TT_Process_Composite_Component): component scaled, transformed, then offset
    let p = o + 10, more = true;
    while (more) {
      const flags = dv.getUint16(p), gi = dv.getUint16(p + 2);
      p += 4;
      let a1: number, a2: number;
      if (flags & 1) { a1 = dv.getInt16(p); a2 = dv.getInt16(p + 2); p += 4; } else {
        a1 = flags & 2 ? dv.getInt8(p) : dv.getUint8(p);
        a2 = flags & 2 ? dv.getInt8(p + 1) : dv.getUint8(p + 1);
        p += 2;
      }
      let xx = 0x10000, xy = 0, yx = 0, yy = 0x10000, have = false;
      if (flags & 8) { xx = yy = dv.getInt16(p) * 4; p += 2; have = true; } else if (flags & 0x40) {
        xx = dv.getInt16(p) * 4; yy = dv.getInt16(p + 2) * 4; p += 4; have = true;
      } else if (flags & 0x80) {
        xx = dv.getInt16(p) * 4; yx = dv.getInt16(p + 2) * 4; xy = dv.getInt16(p + 4) * 4; yy = dv.getInt16(p + 6) * 4;
        p += 8; have = true;
      }
      const sub = this.outline(gi, xScale, yScale, depth + 1);
      const n0 = out.x.length;
      let ox = 0, oy = 0;
      if (flags & 2) { // ARGS_ARE_XY_VALUES (point matching is not used by these fonts)
        ox = ftMulFix(a1, xScale); oy = ftMulFix(a2, yScale); // no ROUND_XY_TO_GRID without hinting
      }
      for (let i = 0; i < sub.x.length; i++) {
        let x = sub.x[i], y = sub.y[i];
        if (have) { const tx = ftMulFix(x, xx) + ftMulFix(y, xy); y = ftMulFix(x, yx) + ftMulFix(y, yy); x = tx; }
        out.x.push(x + ox); out.y.push(y + oy); out.on.push(sub.on[i]);
      }
      for (const e of sub.ends) out.ends.push(e + n0);
      more = (flags & 0x20) !== 0;
    }
    if (pp1x) for (let i = 0; i < out.x.length; i++) out.x[i] -= pp1x;
    return out;
  }

  /** FT_Request_Metrics (nominal, 72 dpi) + ft_recompute_scaled_metrics for a 26.6 character size. */
  sizeMetrics(charSize26: number): SizeMetrics {
    const xScale = ftDivFix(charSize26, this.upem), yScale = xScale;
    return {
      xScale, yScale,
      ascender: pixCeil(ftMulFix(this.ascender, yScale)),
      descender: pixFloor(ftMulFix(this.descender, yScale)),
      height: pixRound(ftMulFix(this.height, yScale)),
    };
  }
}

/** FT_Outline_Get_CBox in 26.6 ([xMin, yMin, xMax, yMax]; zeros for an empty outline). */
export function outlineCBox(o: Outline): [number, number, number, number] {
  if (!o.x.length) return [0, 0, 0, 0];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < o.x.length; i++) {
    if (o.x[i] < x0) x0 = o.x[i];
    if (o.x[i] > x1) x1 = o.x[i];
    if (o.y[i] < y0) y0 = o.y[i];
    if (o.y[i] > y1) y1 = o.y[i];
  }
  return [x0, y0, x1, y1];
}

// -- FreeType 2.9.x smooth rasteriser (ftgrays.c) ----------------------------------------------------

const PIXEL_BITS = 8;
const ONE_PIXEL = 1 << PIXEL_BITS;
const UDIV_NUM = (1n << 56n) - 1n; // FT_ULONG_MAX >> PIXEL_BITS on a 64-bit long

/** FT_UDIVPREP: (long)(FT_ULONG_MAX >> PIXEL_BITS) / b, or 0 when the walk never needs it. */
function udivPrep(c: boolean, b: number): bigint {
  return c && b !== 0 ? UDIV_NUM / BigInt(b) : 0n;
}

/** FT_UDIV: ((unsigned long)a * (unsigned long)b_r) >> (64 - PIXEL_BITS). */
function udiv(a: number, br: bigint): number {
  return Number(BigInt.asUintN(64, BigInt(a) * br) >> 56n);
}

interface Cell { x: number; cover: number; area: number }

class GrayWorker {
  minEx = 0; maxEx = 0; minEy = 0; maxEy = 0;
  ex = 0; ey = 0; area = 0; cover = 0; invalid = true;
  x = 0; y = 0; // TPos: 26.6 << 2 (1/256 px)
  rows: Cell[][] = [];

  /** gray_record_cell: add the current cell into its row (rows sorted by x). */
  private recordCell(): void {
    const row = this.rows[this.ey - this.minEy];
    let i = 0;
    while (i < row.length && row[i].x < this.ex) i++;
    if (i < row.length && row[i].x === this.ex) {
      row[i].area += this.area;
      row[i].cover += this.cover;
    } else {
      row.splice(i, 0, { x: this.ex, area: this.area, cover: this.cover });
    }
  }

  /** gray_set_cell (0x15f8a18) */
  setCell(ex: number, ey: number): void {
    if (!this.invalid) this.recordCell();
    this.area = 0;
    this.cover = 0;
    this.ex = Math.max(ex, this.minEx - 1);
    this.ey = ey;
    this.invalid = ey >= this.maxEy || ey < this.minEy || this.ex >= this.maxEx;
  }

  /** gray_render_line (0x15f8b54, the 2.9 reciprocal-division walk) */
  renderLine(toX: number, toY: number): void {
    let ey1 = this.y >> PIXEL_BITS;
    const ey2 = toY >> PIXEL_BITS;
    if ((ey1 >= this.maxEy && ey2 >= this.maxEy) || (ey1 < this.minEy && ey2 < this.minEy)) {
      this.x = toX; this.y = toY;
      return;
    }
    let ex1 = this.x >> PIXEL_BITS;
    const ex2 = toX >> PIXEL_BITS;
    let fx1 = this.x & (ONE_PIXEL - 1), fy1 = this.y & (ONE_PIXEL - 1);
    const dx = toX - this.x, dy = toY - this.y;
    if (ex1 === ex2 && ey1 === ey2) {
      // inside one cell
    } else if (dy === 0) {
      ex1 = ex2;
      this.setCell(ex1, ey1);
    } else if (dx === 0) {
      if (dy > 0) {
        do {
          this.cover += ONE_PIXEL - fy1;
          this.area += (ONE_PIXEL - fy1) * fx1 * 2;
          fy1 = 0;
          ey1++;
          this.setCell(ex1, ey1);
        } while (ey1 !== ey2);
      } else {
        do {
          this.cover += -fy1;
          this.area += -fy1 * fx1 * 2;
          fy1 = ONE_PIXEL;
          ey1--;
          this.setCell(ex1, ey1);
        } while (ey1 !== ey2);
      }
    } else {
      let prod = dx * fy1 - dy * fx1;
      const dxr = udivPrep(ex1 !== ex2, dx), dyr = udivPrep(ey1 !== ey2, dy);
      do {
        let fx2: number, fy2: number;
        if (prod <= 0 && prod - dx * ONE_PIXEL > 0) { // left
          fx2 = 0;
          fy2 = udiv(-prod, -dxr);
          prod -= dy * ONE_PIXEL;
          this.cover += fy2 - fy1;
          this.area += (fy2 - fy1) * (fx1 + fx2);
          fx1 = ONE_PIXEL;
          fy1 = fy2;
          ex1--;
        } else if (prod - dx * ONE_PIXEL <= 0 && prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0) { // up
          prod -= dx * ONE_PIXEL;
          fx2 = udiv(-prod, dyr);
          fy2 = ONE_PIXEL;
          this.cover += fy2 - fy1;
          this.area += (fy2 - fy1) * (fx1 + fx2);
          fx1 = fx2;
          fy1 = 0;
          ey1++;
        } else if (prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0 && prod + dy * ONE_PIXEL >= 0) { // right
          prod += dy * ONE_PIXEL;
          fx2 = ONE_PIXEL;
          fy2 = udiv(prod, dxr);
          this.cover += fy2 - fy1;
          this.area += (fy2 - fy1) * (fx1 + fx2);
          fx1 = 0;
          fy1 = fy2;
          ex1++;
        } else { // down
          fx2 = udiv(prod, -dyr);
          fy2 = 0;
          prod += dx * ONE_PIXEL;
          this.cover += fy2 - fy1;
          this.area += (fy2 - fy1) * (fx1 + fx2);
          fx1 = fx2;
          fy1 = ONE_PIXEL;
          ey1--;
        }
        this.setCell(ex1, ey1);
      } while (ex1 !== ex2 || ey1 !== ey2);
    }
    const fx2 = toX & (ONE_PIXEL - 1), fy2 = toY & (ONE_PIXEL - 1);
    this.cover += fy2 - fy1;
    this.area += (fy2 - fy1) * (fx1 + fx2);
    this.x = toX;
    this.y = toY;
  }

  /** gray_render_conic (0x15f85d8): bisection count from the deviation, then gray_split_conic (/ 2). */
  renderConic(cx: number, cy: number, tx: number, ty: number): void {
    const arc = new Array<number>(80).fill(0); // bez_stack[16 * 2 + 1] (+ room for base[4])
    arc[0] = tx * 4; arc[1] = ty * 4; // UPSCALE
    arc[2] = cx * 4; arc[3] = cy * 4;
    arc[4] = this.x; arc[5] = this.y;
    const t0 = arc[1] >> PIXEL_BITS, t1 = arc[3] >> PIXEL_BITS, t2 = arc[5] >> PIXEL_BITS;
    if ((t0 >= this.maxEy && t1 >= this.maxEy && t2 >= this.maxEy) || (t0 < this.minEy && t1 < this.minEy && t2 < this.minEy)) {
      this.x = arc[0]; this.y = arc[1];
      return;
    }
    let dx = Math.abs(arc[4] + arc[0] - 2 * arc[2]);
    const dy = Math.abs(arc[5] + arc[1] - 2 * arc[3]);
    if (dx < dy) dx = dy;
    let draw = 1;
    while (dx > ONE_PIXEL / 4) { dx >>= 2; draw <<= 1; }
    let b = 0; // index of base[0].x in arc
    do {
      let split = 1;
      while ((draw & split) === 0) {
        // gray_split_conic(base)
        for (let k = 0; k < 2; k++) {
          arc[b + 8 + k] = arc[b + 4 + k];
          let s = arc[b + 2 + k];
          const aa = arc[b + 6 + k] = Math.trunc((arc[b + 4 + k] + s) / 2);
          s = arc[b + 2 + k] = Math.trunc((arc[b + k] + s) / 2);
          arc[b + 4 + k] = Math.trunc((aa + s) / 2);
        }
        b += 4;
        split <<= 1;
      }
      this.renderLine(arc[b], arc[b + 1]);
      b -= 4;
    } while (--draw);
  }

  /** gray_convert_glyph_inner's final gray_record_cell */
  finish(): void {
    if (!this.invalid) this.recordCell();
  }

  moveTo(x: number, y: number): void {
    this.setCell(x >> 6, y >> 6);
    this.x = x * 4;
    this.y = y * 4;
  }
}

/** FT_Outline_Decompose with the gray raster's funcs (shift 0, delta 0); conic midpoints / 2. */
function decompose(o: Outline, w: GrayWorker): void {
  let first = 0;
  for (const last of o.ends) {
    let sx = o.x[first], sy = o.y[first];
    const lx = o.x[last], ly = o.y[last];
    let p = first, limit = last;
    if (!o.on[first]) {
      if (o.on[last]) { sx = lx; sy = ly; limit--; } else { sx = Math.trunc((sx + lx) / 2); sy = Math.trunc((sy + ly) / 2); }
      p--;
    }
    w.moveTo(sx, sy);
    let closedByConic = false;
    while (p < limit) {
      p++;
      if (o.on[p]) { w.renderLine(o.x[p] * 4, o.y[p] * 4); continue; }
      let cx = o.x[p], cy = o.y[p];
      for (;;) {
        if (p < limit) {
          p++;
          const vx = o.x[p], vy = o.y[p];
          if (o.on[p]) { w.renderConic(cx, cy, vx, vy); break; }
          w.renderConic(cx, cy, Math.trunc((cx + vx) / 2), Math.trunc((cy + vy) / 2));
          cx = vx; cy = vy;
          continue;
        }
        w.renderConic(cx, cy, sx, sy);
        closedByConic = true;
        break;
      }
      if (closedByConic) break;
    }
    if (!closedByConic) w.renderLine(sx * 4, sy * 4);
    first = last + 1;
  }
}

/**
 * FT_Glyph_To_Bitmap(FT_RENDER_MODE_NORMAL) of an outline: the smooth renderer's floor/ceil box
 * (0x15f8f30), the outline shifted onto it, gray_convert_glyph's sweep (0x15f7efc): spans get
 * min(255, |cover|), cells min(255, |(cover * 512 - area) >> 9|), non-zero winding.
 */
export function renderOutline(o: Outline): Bitmap {
  const [x0, y0, x1, y1] = outlineCBox(o);
  const xMin = pixFloor(x0), yMin = pixFloor(y0), xMax = pixCeil(x1), yMax = pixCeil(y1);
  const width = (xMax - xMin) >> 6, rows = (yMax - yMin) >> 6;
  const bm: Bitmap = { width, rows, left: xMin >> 6, top: yMax >> 6, buf: new Uint8Array(Math.max(0, width * rows)) };
  if (width <= 0 || rows <= 0) return bm;
  const sh: Outline = { x: o.x.map((v) => v - xMin), y: o.y.map((v) => v - yMin), on: o.on, ends: o.ends };
  const w = new GrayWorker();
  w.minEx = 0; w.maxEx = width; w.minEy = 0; w.maxEy = rows;
  for (let i = 0; i < rows; i++) w.rows.push([]);
  w.invalid = true;
  decompose(sh, w);
  w.finish();
  const put = (x: number, y: number, n: number, c: number): void => {
    if (n <= 0) return;
    const row = (rows - 1 - y) * width; // target origin = last row, pitch > 0
    bm.buf.fill(c, row + x, row + x + n);
  };
  for (let y = 0; y < rows; y++) {
    let x = w.minEx, cover = 0;
    for (const cell of w.rows[y]) {
      if (cover !== 0 && cell.x > x) put(x, y, cell.x - x, Math.min(255, Math.abs(cover)));
      cover += cell.cover;
      const a = cover * 512 - cell.area;
      if (a !== 0 && cell.x >= w.minEx) put(cell.x, y, 1, Math.min(255, Math.abs(a >> 9)));
      x = cell.x + 1;
    }
    if (cover !== 0) put(x, y, w.maxEx - x, Math.min(255, Math.abs(cover)));
  }
  return bm;
}
