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
    lb?: Record<string, string>; nm?: string[] }>;
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
      for (const [fi, lb] of Object.entries(c.lb ?? {})) {
        if (!labels.has(lb)) labels.set(lb, +fi);
        frameLabels.set(+fi, lb);
      }
      this.clips.set(+k, {
        id: +k, fps: c.fps, frameCount: c.n.length, frameStart, elements: new Int32Array(c.e),
        children: new Int32Array(c.c), blend: c.b ? new Uint8Array(c.b) : null, bank: c.k,
        labels, frameLabels, names: c.nm ? c.nm.map((s) => s || null) : null,
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

  async loadAll(names: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(names)].map((n) => this.load(n)));
  }
}
