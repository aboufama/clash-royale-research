// ScLibrary: one baked .sc file (see tools/art/bake_web.py for the JSON format).
//
//   const lib = await ScLibrary.load('assets', 'chr_knight');
//   lib.has('Knight_run1_5'); lib.frameCount('Knight_run1_5'); lib.fps(...); lib.labels(...)
//
// Shapes keep the SC2 triangle-strip vertex order; u/v are converted from texels to 0..1 here.

export const NO_INDEX = -1;

export interface ShapeCmd {
  tex: number;
  /** x, y, u, v per vertex (u, v normalised), triangle-strip order */
  verts: Float32Array;
  count: number;
}

export interface Clip {
  id: number;
  fps: number;
  frameCount: number;
  frameStart: Int32Array; // element index of each frame's first element (length frameCount + 1)
  elements: Int32Array; // flat [childIndex, matrixIndex, colorIndex] * n
  children: Int32Array;
  blend: Uint8Array | null;
  bank: number;
  labels: Map<string, number>; // label -> frame
  frameLabels: Map<number, string>;
  names: (string | null)[] | null;
  /** 9-slice scaling grid: the stretched centre rect x0, y0, x1, y1 (clip space), or null */
  grid: [number, number, number, number] | null;
}

export interface Bank {
  m: Float64Array; // 6 per matrix
  c: Float32Array; // 7 per color
}

export interface TextFieldDef {
  font: string;
  text: string;
  rect: [number, number, number, number];
  color: number; // ARGB
  outline: number; // ARGB
  bytes: [number, number, number, number];
}

interface LibJson {
  v: number;
  name: string;
  tex: { f: string; w: number; h: number }[];
  shapes: Record<string, [number, number[]][]>;
  clips: Record<string, { fps: number; n: number[]; e: number[]; c: number[]; k: number; b?: number[];
    lb?: Record<string, string>; nm?: string[]; g?: [number, number, number, number] }>;
  banks: { m: number[]; c: number[] }[];
  exports: Record<string, number>;
  mods?: Record<string, number>;
  tf?: Record<string, TextFieldDef>;
}

export type TextureSource = ImageBitmap | HTMLImageElement;

let nextLibId = 1;

export class ScLibrary {
  readonly uid = nextLibId++;
  readonly name: string;
  readonly textures: TextureSource[];
  readonly texSize: [number, number][];
  readonly shapes = new Map<number, ShapeCmd[]>();
  readonly clips = new Map<number, Clip>();
  readonly banks: Bank[];
  readonly exports = new Map<string, number>();
  readonly modifiers = new Map<number, number>();
  readonly textFields = new Map<number, TextFieldDef>();

  constructor(json: LibJson, textures: TextureSource[]) {
    this.name = json.name;
    this.textures = textures;
    this.texSize = json.tex.map((t) => [t.w, t.h]);
    for (const [k, cmds] of Object.entries(json.shapes)) {
      this.shapes.set(+k, cmds.map(([tex, flat]) => {
        const v = new Float32Array(flat);
        const [w, h] = this.texSize[tex];
        for (let i = 0; i < v.length; i += 4) {
          v[i + 2] /= w;
          v[i + 3] /= h;
        }
        return { tex, verts: v, count: v.length / 4 };
      }));
    }
    for (const [k, c] of Object.entries(json.clips)) {
      const frameStart = new Int32Array(c.n.length + 1);
      for (let i = 0; i < c.n.length; i++) frameStart[i + 1] = frameStart[i] + c.n[i];
      const labels = new Map<string, number>();
      const frameLabels = new Map<number, string>();
      // a repeated label resolves to its last frame, as the client's lookup searches from the end (0x123f3c0)
      for (const [fi, lb] of Object.entries(c.lb ?? {})) {
        labels.set(lb, +fi);
        frameLabels.set(+fi, lb);
      }
      this.clips.set(+k, {
        id: +k, fps: c.fps, frameCount: c.n.length, frameStart, elements: new Int32Array(c.e),
        children: new Int32Array(c.c), blend: c.b ? new Uint8Array(c.b) : null, bank: c.k,
        labels, frameLabels, names: c.nm ? c.nm.map((s) => s || null) : null, grid: c.g ?? null,
      });
    }
    this.banks = json.banks.map((b) => ({ m: new Float64Array(b.m), c: new Float32Array(b.c) }));
    for (const [k, v] of Object.entries(json.exports)) this.exports.set(k, v);
    for (const [k, v] of Object.entries(json.mods ?? {})) this.modifiers.set(+k, v);
    for (const [k, v] of Object.entries(json.tf ?? {})) this.textFields.set(+k, v);
  }

  /** Load `<baseUrl>/sc/<name>.json` and its atlases (premultiplied, no colour conversion). */
  static async load(baseUrl: string, name: string): Promise<ScLibrary> {
    const base = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/sc/${name}.json`);
    if (!res.ok) throw new Error(`ScLibrary: ${name}.json: HTTP ${res.status}`);
    const json = (await res.json()) as LibJson;
    const textures = await Promise.all(json.tex.map(async (t) => {
      const r = await fetch(`${base}/sc/${t.f}`);
      if (!r.ok) throw new Error(`ScLibrary: ${t.f}: HTTP ${r.status}`);
      const blob = await r.blob();
      return createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    }));
    return new ScLibrary(json, textures);
  }

  id(exportName: string): number {
    const id = this.exports.get(exportName);
    if (id === undefined) throw new Error(`${this.name}: no export ${exportName}`);
    return id;
  }

  has(exportName: string): boolean {
    return this.exports.has(exportName);
  }

  clip(exportName: string): Clip | undefined {
    const id = this.exports.get(exportName);
    return id === undefined ? undefined : this.clips.get(id);
  }

  frameCount(exportName: string): number {
    return this.clip(exportName)?.frameCount ?? 1;
  }

  fps(exportName: string): number {
    return this.clip(exportName)?.fps ?? 30;
  }

  /** label -> frame index */
  labels(exportName: string): Record<string, number> {
    const c = this.clip(exportName);
    return c ? Object.fromEntries(c.labels) : {};
  }

  private boundsCache = new Map<string, [number, number, number, number] | null>();

  /**
   * Axis-aligned bounds [x0, y0, x1, y1] (export space, SC px) of an export's frame: the union of
   * its shapes' vertices through the display list (child clips at their frame 0). Null when empty.
   */
  frameBounds(exportName: string, frame = 0): [number, number, number, number] | null {
    const key = `${exportName}#${frame}`;
    if (this.boundsCache.has(key)) return this.boundsCache.get(key)!;
    const id = this.exports.get(exportName);
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    if (id !== undefined) this.accBounds(id, frame, [1, 0, 0, 1, 0, 0], b, 0);
    const out = b[0] <= b[2] ? b : null;
    this.boundsCache.set(key, out);
    return out;
  }

  /**
   * Height (maxY − minY) of an export's frame drawn through the 2×2 matrix [a, b, c, d] with no
   * translation: DisplayObject height 0x123ca58 (bounds pass 0x125a0f4 with the object's own matrix).
   * 0 when the frame is empty.
   */
  frameHeight(exportName: string, frame: number, m: [number, number, number, number]): number {
    const id = this.exports.get(exportName);
    if (id === undefined) return 0;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    this.accBounds(id, frame, [m[0], m[1], m[2], m[3], 0, 0], b, 0);
    return b[0] <= b[2] ? b[3] - b[1] : 0;
  }

  private accBounds(id: number, frame: number, m: number[], b: number[], depth: number): void {
    if (depth > 16) return;
    const shape = this.shapes.get(id);
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
    const clip = this.clips.get(id);
    if (!clip) return;
    const f = Math.max(0, Math.min(clip.frameCount - 1, frame));
    const bm = this.banks[clip.bank].m;
    for (let i = clip.frameStart[f]; i < clip.frameStart[f + 1]; i++) {
      const ci = clip.elements[i * 3];
      const mi = clip.elements[i * 3 + 1];
      const cm = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
      const mm = [
        m[0] * cm[0] + m[2] * cm[1], m[1] * cm[0] + m[3] * cm[1],
        m[0] * cm[2] + m[2] * cm[3], m[1] * cm[2] + m[3] * cm[3],
        m[0] * cm[4] + m[2] * cm[5] + m[4], m[1] * cm[4] + m[3] * cm[5] + m[5],
      ];
      this.accBounds(clip.children[ci], 0, mm, b, depth + 1);
    }
  }
}

/** An empty library: drawing from it is a no-op (stands in while the real one loads). */
export function emptyLibrary(name: string): ScLibrary {
  return new ScLibrary({ v: 1, name, tex: [], shapes: {}, clips: {}, banks: [], exports: {} }, []);
}

/** Loads libraries on demand, de-duplicating concurrent requests. */
export class ScLibraryCache {
  private readonly map = new Map<string, Promise<ScLibrary>>();
  private readonly ready = new Map<string, ScLibrary>();
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  load(name: string): Promise<ScLibrary> {
    let p = this.map.get(name);
    if (!p) {
      p = ScLibrary.load(this.baseUrl, name).then((lib) => {
        this.ready.set(name, lib);
        return lib;
      });
      this.map.set(name, p);
    }
    return p;
  }

  /** Synchronous access once loaded (undefined while loading / unknown). */
  get(name: string): ScLibrary | undefined {
    return this.ready.get(name);
  }

  /** Every library loaded so far. */
  loaded(): ScLibrary[] {
    return [...this.ready.values()];
  }

  async loadAll(names: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(names)].map((n) => this.load(n)));
  }
}
