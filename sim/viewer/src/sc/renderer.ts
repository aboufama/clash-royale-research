// ScRenderer: WebGL2 renderer for baked Supercell SC2 movie clips.
//
// Port of tools/art/render.py Scene.collect(): a clip's frame is `frame % frameCount`; each
// element composes  world = parent * childMatrix  and  color = parent (x) childColor
// (sc2.Matrix.mul / sc2.Color.mul); a child's non-zero blend mode overrides the parent's; shapes
// are textured triangle strips. Unlike render.py it also implements
//   - masks (modifiers 38/39/40) with the stencil buffer (render.py ignores them),
//   - blend modes 3 multiply / 4 screen / 8 add as real GL blends (render.py: all "additive"),
//   - text fields: the client's text path (text.ts / freetype.ts: FreeType glyphs, outline channel,
//     layout; 0x126ab4c's two passes of glyph quads), glyph images cached in one atlas,
//   - named-child overrides (Supercell code swaps placeholder children such as the King tower's
//     `king_dummy`/`turret`, health-bar `bar` frames and text instances at runtime),
//   - the shadow pass of the game's 2D renderer: silhouettes (sprite alpha x vertex alpha,
//     custom_sprite_shadow) into a half-resolution offscreen buffer, then one composite (shadow_2d_composite):
//     4 taps at (+-ox, +-oy), summed, clamped to 1, times the location shadow colour.
// Nested clips receive `childFrame` (default = the root frame), i.e. one shared clock like
// render.py; pass a separate childFrame to hold the root on a frame while children animate.
//
// API:
//   const r = new ScRenderer(canvas);
//   r.begin([r, g, b, a]?)                   // clears, resets stats; call once per frame
//   r.setView(a, b, c, d, tx, ty)            // SC pixels -> canvas pixels (flushes)
//   r.draw(lib, 'Knight_run1_5', frame, matrix?, color?, opts?)
//   r.beginShadows(); ...draw silhouettes...; r.endShadows([r, g, b, a], [ox, oy])
//   r.end()                                  // flushes; r.stats = {drawCalls, triangles}
// Mirroring: pass a matrix with a negative x scale, e.g. [-s, 0, 0, s, x, y].
// Textures are premultiplied (the .sc atlases are stored that way; other images are premultiplied at load) and mip-mapped.

import type { Col, Mat } from './math.ts';
import { colMul, IDENTITY, WHITE } from './math.ts';
import type { ScLibrary, ShapeCmd, TextFieldDef, TextureSource } from './library.ts';
import type { GlyphImage as GlyphImageT, TfLayout } from './text.ts';
import { fontGeneration, fontsLoaded, layoutTextField, loadGameFonts, textPlacement, tfOutlineColor } from './text.ts';

export interface NamedOverride {
  /** skip this child */
  hide?: boolean;
  /** frame of this child clip (its own descendants still get `childFrame`) */
  frame?: number;
  /** clock passed further down from this child */
  childFrame?: number;
  /** draw this export instead of the child (child's matrix/colour still apply) */
  lib?: ScLibrary;
  export?: string;
  /** extra transform applied in the child's space before its own content (e.g. mirror) */
  matrix?: Mat;
  color?: Col;
  /** text for a text-field child */
  text?: string;
}

export interface DrawOptions {
  /** frame passed to nested clips (default: the root frame) */
  childFrame?: number;
  /** overrides by child instance name (any depth) */
  named?: Record<string, NamedOverride>;
  /** text by text-field instance name (any depth) */
  text?: Record<string, string>;
  /** force a blend mode for everything drawn (0 = use the file's modes) */
  blend?: number;
  /** draw with the stage's grayscale program (DisplayObject flag 4, 0x123c580 -> program 3,
   * builtin_stage_grayscale: rgb = mul.rgb * dot(tex.rgb, (0.30, 0.59, 0.11)) + add * tex.a) */
  grayscale?: boolean;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
}

/** glyph atlas size (px) */
const TEXT_ATLAS = 2048;
const MAX_SLOTS = 8;
const FLOATS = 12; // x y u v mulR mulG mulB mulA addR addG addB slot
const MAX_VERTS = 262144; // one frame's vertices (uploaded once per frame)
const MAX_INDICES = MAX_VERTS * 3;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec4 aMul;
layout(location=3) in vec4 aAdd;
uniform mat3 uView;
out vec2 vUv;
out vec4 vMul;
out vec3 vAdd;
flat out int vSlot;
void main() {
  vec3 p = uView * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = aUv;
  vMul = aMul;
  vAdd = aAdd.rgb;
  vSlot = int(aAdd.a + 0.5);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vMul;
in vec3 vAdd;
flat in int vSlot;
uniform sampler2D uTex[${MAX_SLOTS}];
uniform int uMode; // 0 normal, 1 stencil-mask write, 2 shadow silhouette
out vec4 outColor;
vec4 sampleSlot(int s, vec2 uv) {
  ${Array.from({ length: MAX_SLOTS }, (_, i) => `${i ? 'else ' : ''}if (s == ${i}) return texture(uTex[${i}], uv);`).join('\n  ')}
  return vec4(0.0);
}
void main() {
  // slot >= 16: grayscale program (builtin_stage_grayscale.frag with the premultiplied stage colours)
  bool gray = vSlot >= 16;
  vec4 s = sampleSlot(gray ? vSlot - 16 : vSlot, vUv);
  if (gray && uMode == 0) {
    float l = dot(s.rgb, vec3(0.30000001, 0.58999997, 0.11));
    outColor = vec4((vMul.rgb * l + vAdd * s.a) * vMul.a, s.a * vMul.a);
    return;
  }
  // render.py: rgb = s.rgb * mul + a * add / 255 ; clamp rgb <= a ; then * alphaMul
  vec3 rgb = min(s.rgb * vMul.rgb + s.a * vAdd, vec3(s.a));
  vec4 o = vec4(rgb, s.a) * vMul.a;
  if (uMode == 1) { if (o.a < 0.02) discard; outColor = vec4(0.0); return; }
  if (uMode == 2) { outColor = vec4(o.a); return; }
  outColor = o;
}`;

const BLUR_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// sc3d/shaders/shadow_2d_composite.frag (libg 160402020): four taps of the silhouette buffer at
// (+ox,+oy) (-ox,+oy) (-ox,-oy) (+ox,-oy), summed, clamped to 1, times u_c (premultiplied).
const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uOff;
uniform vec4 uC;
out vec4 outColor;
void main() {
  float s = texture(uSrc, vUv + uOff).a + texture(uSrc, vUv + vec2(-uOff.x, uOff.y)).a
          + texture(uSrc, vUv - uOff).a + texture(uSrc, vUv + vec2(uOff.x, -uOff.y)).a;
  outColor = uC * min(s, 1.0);
}`;

interface GlTex {
  tex: WebGLTexture;
  w: number;
  h: number;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class ScRenderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  stats: RenderStats = { drawCalls: 0, triangles: 0 };

  private readonly prog: WebGLProgram;
  private readonly uView: WebGLUniformLocation;
  private readonly uMode: WebGLUniformLocation;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly verts = new Float32Array(MAX_VERTS * FLOATS);
  private readonly indices = new Uint32Array(MAX_INDICES);
  private nv = 0;
  private ni = 0;
  private slots: (WebGLTexture | null)[] = new Array(MAX_SLOTS).fill(null);
  private nslots = 0;
  private curBlend = -1;
  private mode = 0; // 0 normal, 1 mask write, 2 shadow
  private view: Mat = [1, 0, 0, 1, 0, 0];
  private readonly texCache = new WeakMap<object, GlTex>();
  private readonly white: WebGLTexture;
  private readonly matStack: Mat[] = [];
  private readonly colStack: Col[] = [];
  private maskDepth = 0;
  private inMaskWrite = false;
  /** glyph images (fill + outline coverage), packed into one atlas texture (shelf packer; reset when full) */
  private textCache = new Map<string, { x: number; y: number }>();
  private textAtlas: WebGLTexture | null = null;
  private textShelves: { y: number; h: number; x: number }[] = [];
  /** bumps when the glyph atlas is reset (cached atlas positions are void) */
  private textAtlasGen = 0;
  /** TextField layouts by definition, then by text / stage scale / font generation */
  private textLayouts = new WeakMap<TextFieldDef, Map<string, TfLayout | null>>();
  /**
   * Stage scale the client rasterises text at (device px per stage px, its stage +0x188). Null = the
   * current view's scale, which is the stage scale for the HUD; a layer drawn through a scaled view
   * (the battle) should set this to the HUD's scale so its text is scaled as a bitmap like the client's.
   */
  textStageScale: number | null = null;
  /** where the game fonts are fetched from (`<fontBase>/fonts/<file>`) */
  fontBase = 'assets';
  private frameNo = 0;
  /** TID key -> localised string, for text instances named with a TID (set by the owner) */
  textTable: Record<string, string> | null = null;
  // shadow pass
  private readonly blurProg: WebGLProgram;
  private readonly quadVao: WebGLVertexArrayObject;
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private fboSize: [number, number] = [0, 0];
  /** grayscale program for the vertices being emitted (DrawOptions.grayscale / drawImageStrip) */
  private gray = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, attrs: WebGLContextAttributes = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, premultipliedAlpha: true, stencil: true, antialias: true, preserveDrawingBuffer: true, ...attrs,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.prog = compile(gl, VS, FS);
    this.uView = gl.getUniformLocation(this.prog, 'uView')!;
    this.uMode = gl.getUniformLocation(this.prog, 'uMode')!;
    gl.useProgram(this.prog);
    for (let i = 0; i < MAX_SLOTS; i++) gl.uniform1i(gl.getUniformLocation(this.prog, `uTex[${i}]`), i);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.byteLength, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (let i = 0; i <= 40; i++) {
      this.matStack.push([1, 0, 0, 1, 0, 0]);
      this.colStack.push([1, 1, 1, 1, 0, 0, 0]);
    }
    this.blurProg = compile(gl, BLUR_VS, BLUR_FS);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  get width(): number { return this.canvas.width; }
  get height(): number { return this.canvas.height; }

  /** Start a frame: viewport = canvas, clear, reset view to identity (1 SC px = 1 canvas px). */
  begin(clear: [number, number, number, number] = [0, 0, 0, 1]): void {
    const gl = this.gl;
    this.submit();
    this.frameNo++;
    this.stats = { drawCalls: 0, triangles: 0 };
    const w = this.width, h = this.height;
    this.q.push(() => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.useProgram(this.prog);
    });
    this.curBlend = -1;
    this.mode = 0;
    this.maskDepth = 0;
    this.inMaskWrite = false;
    this.setView(1, 0, 0, 1, 0, 0);
  }

  end(): void {
    this.submit();
  }

  // -- command queue ------------------------------------------------------------------------------
  // Batches and the state changes between them are queued in order while the frame is built; the
  // frame's vertices and indices accumulate in one array and go to the GPU in a single upload, then
  // the queue replays. Re-uploading into the same buffer for every batch made the driver wait for
  // the previous batch's draw (the dominant per-frame cost). Values are captured when recorded.
  private q: (() => void)[] = [];
  private batchStart = 0;

  /** Upload the queued frame data once and run the queued GL commands. */
  private submit(): void {
    this.flush();
    if (this.q.length === 0) { this.nv = 0; this.ni = 0; this.batchStart = 0; return; }
    const gl = this.gl;
    if (this.ni > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, this.nv * FLOATS), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.subarray(0, this.ni), gl.STREAM_DRAW);
    }
    const q = this.q;
    this.q = [];
    for (let i = 0; i < q.length; i++) q[i]();
    this.nv = 0;
    this.ni = 0;
    this.batchStart = 0;
  }

  /** SC pixel -> canvas pixel transform for subsequent draws. */
  setView(a: number, b: number, c: number, d: number, tx: number, ty: number): void {
    this.flush();
    this.view = [a, b, c, d, tx, ty];
    this.applyView();
  }

  getView(): Mat {
    return [...this.view] as Mat;
  }

  private applyView(): void {
    const gl = this.gl;
    const [a, b, c, d, tx, ty] = this.view;
    // the shadow target covers the whole canvas at a lower resolution: same SC -> clip transform
    const sx = 2 / this.width, sy = -2 / this.height;
    // column-major mat3: clip = P * V
    const m = new Float32Array([
      a * sx, b * sy, 0,
      c * sx, d * sy, 0,
      tx * sx - 1, ty * sy + 1, 1,
    ]);
    this.q.push(() => {
      gl.useProgram(this.prog);
      gl.uniformMatrix3fv(this.uView, false, m);
    });
  }

  // -- public drawing ---------------------------------------------------------------------------

  /** Draw an export at `frame` with a world matrix (SC px) and an optional colour transform. */
  draw(lib: ScLibrary, exportName: string, frame = 0, matrix: Readonly<Mat> = IDENTITY,
    color: Readonly<Col> = WHITE, opts: DrawOptions = {}): void {
    const id = lib.exports.get(exportName);
    if (id === undefined) return;
    this.drawId(lib, id, frame, matrix, color, opts);
  }

  drawId(lib: ScLibrary, id: number, frame = 0, matrix: Readonly<Mat> = IDENTITY,
    color: Readonly<Col> = WHITE, opts: DrawOptions = {}): void {
    const m = this.matStack[0], c = this.colStack[0];
    for (let i = 0; i < 6; i++) m[i] = matrix[i];
    for (let i = 0; i < 7; i++) c[i] = color[i];
    this.gray = !!opts.grayscale;
    this.node(lib, id, Math.floor(frame), Math.floor(opts.childFrame ?? frame), 0, opts.blend ?? 0, opts);
    this.gray = false;
  }

  /** Solid rectangle in SC px (premultiplied colour), for debug overlays. */
  drawRect(x: number, y: number, w: number, h: number, rgba: [number, number, number, number],
    matrix: Readonly<Mat> = IDENTITY): void {
    this.setBlend(0);
    if (this.nv + 4 > MAX_VERTS || this.ni + 6 > MAX_INDICES) this.submit();
    const slot = this.slotFor(this.white);
    const q = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    const base = this.nv;
    for (const [px, py] of q) {
      this.pushVert(matrix[0] * px + matrix[2] * py + matrix[4], matrix[1] * px + matrix[3] * py + matrix[5], 0.5, 0.5,
        rgba[0], rgba[1], rgba[2], rgba[3], 0, 0, 0, slot);
    }
    this.pushIdx(base, base + 1, base + 2);
    this.pushIdx(base + 1, base + 3, base + 2);
  }

  /**
   * Textured triangle strip from a standalone image (e.g. image/range.png for the drag radius
   * indicator): verts = [x, y, u, v] * n in SC px through `matrix`, colour transform `color`.
   */
  drawImageStrip(src: TextureSource, verts: Float32Array, matrix: Readonly<Mat> = IDENTITY,
    color: Readonly<Col> = WHITE, blend = 0, grayscale = false): void {
    const n = verts.length >> 2;
    if (n < 3) return;
    const tex = this.glTexture(src);
    this.gray = grayscale;
    this.setBlend(blend);
    if (this.nv + n > MAX_VERTS || this.ni + (n - 2) * 3 > MAX_INDICES) this.submit();
    const slot = this.slotFor(tex.tex);
    const m = matrix, c = color;
    const base = this.nv;
    for (let k = 0; k < n; k++) {
      const x = verts[k * 4], y = verts[k * 4 + 1];
      this.pushVert(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], verts[k * 4 + 2], verts[k * 4 + 3],
        c[0], c[1], c[2], c[3], c[4] / 255, c[5] / 255, c[6] / 255, slot);
    }
    for (let k = 0; k < n - 2; k++) this.pushIdx(base + k, base + k + 1, base + k + 2);
    this.stats.triangles += n - 2;
    this.gray = false;
  }

  /** Start drawing shadow silhouettes into an offscreen buffer (alpha only, max-blended). */
  beginShadows(): void {
    this.flush();
    const gl = this.gl;
    this.ensureFbos();
    const fb = this.fbos[0].fb, [fw, fh] = this.fboSize;
    this.q.push(() => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, fw, fh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    this.mode = 2;
    this.curBlend = -1;
    this.applyView();
  }

  /**
   * Composite the silhouettes onto the screen like shadow_2d_composite: `c` is the shader's u_c
   * (premultiplied colour, blended ONE / ONE_MINUS_SRC_ALPHA), `off` the tap offset in buffer texels.
   */
  endShadows(c: [number, number, number, number], off: [number, number] = [0, 0]): void {
    this.flush();
    const gl = this.gl;
    this.mode = 0;
    const [w, h] = this.fboSize;
    const tex = this.fbos[0].tex, cw = this.width, ch = this.height;
    const ox = off[0] / w, oy = off[1] / h, cc = [c[0], c[1], c[2], c[3]];
    this.q.push(() => {
      gl.blendEquation(gl.FUNC_ADD);
      gl.useProgram(this.blurProg);
      gl.bindVertexArray(this.quadVao);
      gl.uniform1i(this.blurLoc('uSrc'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform2f(this.blurLoc('uOff'), ox, oy);
      gl.uniform4f(this.blurLoc('uC'), cc[0], cc[1], cc[2], cc[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      gl.useProgram(this.prog);
    });
    this.stats.drawCalls += 1;
    this.curBlend = -1;
    this.applyView();
  }

  // -- traversal --------------------------------------------------------------------------------

  private node(lib: ScLibrary, id: number, frame: number, childFrame: number, depth: number, blend: number,
    opts: DrawOptions): void {
    if (depth > 32) return;
    const m = this.matStack[depth], c = this.colStack[depth];
    const shape = lib.shapes.get(id);
    if (shape) {
      this.emitShape(lib, shape, m, c, blend);
      return;
    }
    const clip = lib.clips.get(id);
    if (!clip) {
      const tf = lib.textFields.get(id);
      if (tf) this.drawText(tf, tf.text, m, c, blend);
      return;
    }
    const n = clip.frameCount;
    if (!n) return;
    let f = frame % n;
    if (f < 0) f += n;
    const s = clip.frameStart[f], e = clip.frameStart[f + 1];
    const bank = lib.banks[clip.bank];
    const el = clip.elements;
    const cm = this.matStack[depth + 1], cc = this.colStack[depth + 1];
    for (let i = s; i < e; i++) {
      const ci = el[i * 3], mi = el[i * 3 + 1], coi = el[i * 3 + 2];
      const cid = clip.children[ci];
      const mod = lib.modifiers.get(cid);
      if (mod !== undefined) {
        this.maskOp(mod);
        continue;
      }
      // child matrix / colour (sc2: parent * child)
      if (mi >= 0) {
        const bm = bank.m, o = mi * 6;
        const a0 = bm[o], b0 = bm[o + 1], c0 = bm[o + 2], d0 = bm[o + 3], x0 = bm[o + 4], y0 = bm[o + 5];
        cm[0] = m[0] * a0 + m[2] * b0;
        cm[1] = m[1] * a0 + m[3] * b0;
        cm[2] = m[0] * c0 + m[2] * d0;
        cm[3] = m[1] * c0 + m[3] * d0;
        cm[4] = m[0] * x0 + m[2] * y0 + m[4];
        cm[5] = m[1] * x0 + m[3] * y0 + m[5];
      } else {
        for (let k = 0; k < 6; k++) cm[k] = m[k];
      }
      if (coi >= 0) {
        const bc = bank.c, o = coi * 7;
        cc[4] = Math.min(255, c[4] + bc[o + 4] * c[0]);
        cc[5] = Math.min(255, c[5] + bc[o + 5] * c[1]);
        cc[6] = Math.min(255, c[6] + bc[o + 6] * c[2]);
        cc[0] = c[0] * bc[o]; cc[1] = c[1] * bc[o + 1]; cc[2] = c[2] * bc[o + 2]; cc[3] = c[3] * bc[o + 3];
      } else {
        for (let k = 0; k < 7; k++) cc[k] = c[k];
      }
      if (cc[3] <= 0.001 && !this.inMaskWrite) continue;
      const b = (clip.blend && clip.blend[ci]) || blend;
      const name = clip.names ? clip.names[ci] : null;
      // a text field instance named with a TID key shows its localised string (texts.csv EN)
      const tid = name !== null && this.textTable && name.startsWith('TID_') && lib.textFields.has(cid) ? this.textTable[name] : undefined;
      if (name !== null && (opts.named || opts.text || tid !== undefined)) {
        const ov = opts.named?.[name];
        const txt = opts.text?.[name] ?? ov?.text ?? tid;
        if (ov?.hide) continue;
        if (txt !== undefined) {
          const direct = lib.textFields.get(cid);
          const tf = direct ? { def: direct, m: null } : this.findTextField(lib, cid);
          if (tf) {
            if (ov?.matrix) this.mulInPlace(cm, ov.matrix); // e.g. the HUD's elixir number bounce
            this.drawText(tf.def, txt, tf.m ? this.tmpMul(cm, tf.m) : cm, cc, b);
            continue;
          }
        }
        if (ov) {
          if (ov.matrix) this.mulInPlace(cm, ov.matrix);
          if (ov.color) colMul(cc, ov.color, cc);
          if (ov.lib && ov.export) {
            const oid = ov.lib.exports.get(ov.export);
            if (oid !== undefined) {
              this.node(ov.lib, oid, Math.floor(ov.frame ?? frame), Math.floor(ov.childFrame ?? childFrame), depth + 1, b, opts);
            }
            continue;
          }
          this.node(lib, cid, Math.floor(ov.frame ?? childFrame), Math.floor(ov.childFrame ?? childFrame), depth + 1, b, opts);
          continue;
        }
      }
      this.node(lib, cid, childFrame, childFrame, depth + 1, b, opts);
    }
  }

  /** A text instance is often a one-child clip wrapping the text field (e.g. `hpNumber` -> `txt`). */
  private findTextField(lib: ScLibrary, cid: number): { def: TextFieldDef; m: Mat | null } | null {
    const clip = lib.clips.get(cid);
    if (!clip || clip.frameCount < 1) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const tid = clip.children[clip.elements[i * 3]];
      const def = lib.textFields.get(tid);
      if (def) {
        const mi = clip.elements[i * 3 + 1];
        if (mi < 0) return { def, m: null };
        const bm = lib.banks[clip.bank].m, o = mi * 6;
        return { def, m: [bm[o], bm[o + 1], bm[o + 2], bm[o + 3], bm[o + 4], bm[o + 5]] };
      }
    }
    return null;
  }

  private tmpM: Mat = [1, 0, 0, 1, 0, 0];
  private tmpMul(p: Readonly<Mat>, q: Readonly<Mat>): Mat {
    const t = this.tmpM;
    t[0] = p[0] * q[0] + p[2] * q[1];
    t[1] = p[1] * q[0] + p[3] * q[1];
    t[2] = p[0] * q[2] + p[2] * q[3];
    t[3] = p[1] * q[2] + p[3] * q[3];
    t[4] = p[0] * q[4] + p[2] * q[5] + p[4];
    t[5] = p[1] * q[4] + p[3] * q[5] + p[5];
    return t;
  }

  private mulInPlace(m: Mat, q: Readonly<Mat>): void {
    const t = this.tmpMul(m, q);
    for (let k = 0; k < 6; k++) m[k] = t[k];
  }

  private emitShape(lib: ScLibrary, cmds: ShapeCmd[], m: Readonly<Mat>, c: Readonly<Col>, blend: number): void {
    const add0 = c[4] / 255, add1 = c[5] / 255, add2 = c[6] / 255;
    for (const cmd of cmds) {
      if (cmd.count < 3) continue;
      const tex = this.glTexture(lib.textures[cmd.tex]);
      this.setBlend(blend);
      if (this.nv + cmd.count > MAX_VERTS || this.ni + (cmd.count - 2) * 3 > MAX_INDICES) this.submit();
      const slot = this.slotFor(tex.tex);
      const v = cmd.verts;
      const base = this.nv;
      for (let k = 0; k < cmd.count; k++) {
        const x = v[k * 4], y = v[k * 4 + 1];
        this.pushVert(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], v[k * 4 + 2], v[k * 4 + 3],
          c[0], c[1], c[2], c[3], add0, add1, add2, slot);
      }
      // triangle strip (k, k+1, k+2) as in render.py
      for (let k = 0; k < cmd.count - 2; k++) this.pushIdx(base + k, base + k + 1, base + k + 2);
      this.stats.triangles += cmd.count - 2;
    }
  }

  private pushVert(x: number, y: number, u: number, v: number, mr: number, mg: number, mb: number, ma: number,
    ar: number, ag: number, ab: number, slot: number): void {
    const o = this.nv * FLOATS, a = this.verts;
    a[o] = x; a[o + 1] = y; a[o + 2] = u; a[o + 3] = v;
    a[o + 4] = mr; a[o + 5] = mg; a[o + 6] = mb; a[o + 7] = ma;
    a[o + 8] = ar; a[o + 9] = ag; a[o + 10] = ab; a[o + 11] = this.gray ? slot + 16 : slot;
    this.nv++;
  }

  private pushIdx(i0: number, i1: number, i2: number): void {
    const a = this.indices, o = this.ni;
    a[o] = i0; a[o + 1] = i1; a[o + 2] = i2;
    this.ni += 3;
  }

  // -- batching ---------------------------------------------------------------------------------

  private slotFor(tex: WebGLTexture): number {
    for (let i = 0; i < this.nslots; i++) if (this.slots[i] === tex) return i;
    if (this.nslots >= MAX_SLOTS) this.flush();
    this.slots[this.nslots] = tex;
    return this.nslots++;
  }

  private setBlend(mode: number): void {
    // modes: 0/1 normal, 3 multiply, 4 screen, 8 add (others fall back to normal)
    const m = this.mode === 2 ? 100 : (mode === 3 || mode === 4 || mode === 8 ? mode : 0);
    if (m === this.curBlend) return;
    this.flush();
    this.curBlend = m;
    const gl = this.gl;
    this.q.push(() => {
      gl.blendEquation(gl.FUNC_ADD);
      switch (m) {
        case 100: gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); break;
        case 8: gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); break;
        case 4: gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE); break;
        case 3: gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); break;
        default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    });
  }

  /** Close the current batch: queue its draw (index range, textures, program mode). */
  flush(): void {
    const start = this.batchStart, count = this.ni - start;
    if (count === 0) {
      this.nslots = 0;
      return;
    }
    const gl = this.gl;
    const mode = this.inMaskWrite ? 1 : this.mode;
    const slots = this.slots.slice(0, this.nslots);
    this.q.push(() => {
      gl.useProgram(this.prog);
      gl.uniform1i(this.uMode, mode);
      gl.bindVertexArray(this.vao);
      for (let i = 0; i < slots.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, slots[i]);
      }
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4);
      gl.bindVertexArray(null);
    });
    this.stats.drawCalls++;
    this.batchStart = this.ni;
    this.nslots = 0;
  }

  /** Upload a library's atlases now (mip-mapped), so the first frame that draws them does not stall. */
  preload(lib: ScLibrary): void {
    for (const t of lib.textures) this.glTexture(t);
  }

  private glTexture(src: TextureSource): GlTex {
    let t = this.texCache.get(src);
    if (t) return t;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(src instanceof ImageBitmap));
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t = { tex, w: src.width, h: src.height };
    this.texCache.set(src, t);
    // the batch's bound textures are rebound at flush; nothing else to restore
    return t;
  }

  // -- masks (modifiers) ------------------------------------------------------------------------

  private maskOp(mod: number): void {
    const gl = this.gl;
    this.flush();
    if (mod === 38) { // begin mask shapes
      this.maskDepth++;
      this.inMaskWrite = true;
      const ref = this.maskDepth - 1;
      this.q.push(() => {
        gl.enable(gl.STENCIL_TEST);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.EQUAL, ref, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
      });
    } else if (mod === 39) { // masked content
      this.inMaskWrite = false;
      const ref = this.maskDepth;
      this.q.push(() => {
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, ref, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      });
    } else if (mod === 40) { // end
      this.inMaskWrite = false;
      this.maskDepth = Math.max(0, this.maskDepth - 1);
      const ref = this.maskDepth;
      this.q.push(() => {
        gl.colorMask(true, true, true, true);
        if (ref === 0) {
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.disable(gl.STENCIL_TEST);
        } else {
          gl.stencilFunc(gl.EQUAL, ref, 0xff);
        }
      });
    }
  }

  // -- text fields ------------------------------------------------------------------------------

  /**
   * A TextField's text, drawn like 0x126ab4c: the layout (text.ts) in device px, its origin at
   * ceil(M (left + inset, top + inset)) (0x88 pixel snap; M = view x world matrix) and the matrix's
   * scale entries snapped to the stage scale S when within 0.01, glyph corners at origin + M2x2 g / S.
   * With an outline colour the glyph quads go out twice (DAT_019874e8 = 1, stored at startup by 0x770bec): all
   * the outline quads first (G coverage x outline colour), then all fill quads (R coverage x fill colour); the
   * colours follow builtin_stage_text(_with_outline): clamp(colour x mul + add) x alpha, premultiplied.
   */
  private drawText(tf: TextFieldDef, text: string, m: Readonly<Mat>, c: Readonly<Col>, blend: number): void {
    if (!text) return;
    if (text.startsWith('TID_')) return; // localisation keys are not resolved here
    if (!fontsLoaded()) { void loadGameFonts(this.fontBase); return; }
    const V = this.view;
    const S = this.textStageScale ?? Math.sqrt(Math.abs(V[0] * V[3] - V[1] * V[2]));
    if (!(S > 0)) return;
    let byText = this.textLayouts.get(tf);
    if (!byText) { byText = new Map(); this.textLayouts.set(tf, byText); }
    const lkey = `${S}|${fontGeneration()}|${text}`;
    let lay = byText.get(lkey);
    if (lay === undefined) {
      if (byText.size > 64) byText.clear();
      lay = layoutTextField(tf, text, S);
      byText.set(lkey, lay);
    }
    if (!lay || !lay.glyphs.length) return;
    const fill = tf.color >>> 0, outline = tfOutlineColor(tf, lay.font);
    // colours: the field's ARGB through the colour transform (greyed first under DisplayObject flag 4)
    const vcol = (argb: number): [number, number, number, number] => {
      let r = (argb >>> 16) & 255, g = (argb >>> 8) & 255, b = argb & 255;
      if (this.gray) r = g = b = ((r * 30 + g * 59 + b * 11) * 0x147b) >>> 19;
      return [c[0] * r / 255, c[1] * g / 255, c[2] * b / 255, c[3] * ((argb >>> 24) & 255) / 255];
    };
    const fc = vcol(fill), oc = vcol(outline);
    const twoPass = ((outline >>> 24) & 255) !== 0 && oc[3] > 0;
    // atlas entries for every glyph (an atlas reset part-way restarts the pass)
    const at: ({ x: number; y: number } | null)[] = new Array(lay.glyphs.length);
    for (let tries = 0; tries < 2; tries++) {
      const gen = this.textAtlasGen;
      for (let i = 0; i < lay.glyphs.length; i++) at[i] = lay.glyphs[i].img.empty ? null : this.glyphEntry(lay.glyphs[i].img);
      if (gen === this.textAtlasGen) break;
    }
    // device matrix (view x world), the snapped origin and scale
    const M = [V[0] * m[0] + V[2] * m[1], V[1] * m[0] + V[3] * m[1], V[0] * m[2] + V[2] * m[3],
      V[1] * m[2] + V[3] * m[3], V[0] * m[4] + V[2] * m[5] + V[4], V[1] * m[4] + V[3] * m[5] + V[5]];
    const pl = textPlacement(M, tf.rect[0], tf.rect[1], lay.inset, S);
    const Ox = pl.ox, Oy = pl.oy, A = pl.a, B = pl.b, C = pl.c, D = pl.d;
    // device -> SC px (the vertex shader applies the view again)
    const det = V[0] * V[3] - V[1] * V[2];
    const i0 = V[3] / det, i1 = -V[1] / det, i2 = -V[2] / det, i3 = V[0] / det;
    this.setBlend(blend);
    const wasGray = this.gray;
    this.gray = false;
    for (let pass = twoPass ? 0 : 1; pass < 2; pass++) {
      const col = pass === 0 ? oc : fc;
      for (let i = 0; i < lay.glyphs.length; i++) {
        const e = at[i];
        if (!e) continue;
        const gl = lay.glyphs[i], img = gl.img;
        if (this.nv + 4 > MAX_VERTS || this.ni + 6 > MAX_INDICES) this.submit();
        const slot = this.slotFor(this.textAtlas!);
        const ux = (e.x + 1 + (pass === 0 ? img.w + 1 : 0)) / TEXT_ATLAS, uy = (e.y + 1) / TEXT_ATLAS;
        const uw = img.w / TEXT_ATLAS, uh = img.h / TEXT_ATLAS;
        const base = this.nv;
        for (let k = 0; k < 4; k++) {
          const gx = gl.x + (k & 1 ? img.w : 0), gy = gl.y + (k & 2 ? img.h : 0);
          const dx = Ox + A * gx + C * gy - V[4], dy = Oy + B * gx + D * gy - V[5];
          this.pushVert(i0 * dx + i2 * dy, i1 * dx + i3 * dy, ux + (k & 1 ? uw : 0), uy + (k & 2 ? uh : 0),
            col[0], col[1], col[2], col[3], c[4] / 255, c[5] / 255, c[6] / 255, slot);
        }
        this.pushIdx(base, base + 1, base + 2);
        this.pushIdx(base + 1, base + 3, base + 2);
        this.stats.triangles += 2;
      }
    }
    this.gray = wasGray;
  }

  /**
   * A glyph image's atlas region: (2w + 3) x (h + 2) texels, the fill coverage at (1, 1), the outline
   * coverage at (w + 2, 1), zero texels around both so bilinear taps past an edge read nothing (as the
   * client's slot margins). Uploaded as premultiplied white (v, v, v, v).
   */
  private glyphEntry(img: GlyphImageT): { x: number; y: number } {
    let e = this.textCache.get(img.key);
    if (e) return e;
    const W = 2 * img.w + 3, H = img.h + 2;
    const [ax, ay] = this.textAlloc(W, H);
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const r = img.r[y * img.w + x], g = img.g[y * img.w + x];
        const o1 = ((y + 1) * W + x + 1) * 4, o2 = ((y + 1) * W + x + img.w + 2) * 4;
        px[o1] = px[o1 + 1] = px[o1 + 2] = px[o1 + 3] = r;
        px[o2] = px[o2 + 1] = px[o2 + 2] = px[o2 + 3] = g;
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textAtlas);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, ax, ay, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    e = { x: ax, y: ay };
    this.textCache.set(img.key, e);
    return e;
  }

  /** Drop cached glyph regions (they are uploaded again on demand). */
  clearTextCache(): void {
    this.textCache.clear();
    this.textShelves = [];
    this.textAtlasGen++;
  }

  /**
   * A w × h region of the glyph atlas (shelves of similar heights, 2 px gaps). When it is full, pending
   * vertices are flushed and every glyph is uploaded again on demand.
   */
  private textAlloc(w: number, h: number): [number, number] {
    const gl = this.gl;
    if (!this.textAtlas) {
      this.textAtlas = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.textAtlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEXT_ATLAS, TEXT_ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const W = w + 2, H = h + 2;
    for (let pass = 0; pass < 2; pass++) {
      for (const sh of this.textShelves) {
        if (H <= sh.h && sh.h <= H * 1.3 + 4 && sh.x + W <= TEXT_ATLAS) {
          const x = sh.x;
          sh.x += W;
          return [x, sh.y];
        }
      }
      const last = this.textShelves[this.textShelves.length - 1];
      const y = last ? last.y + last.h : 0;
      if (y + H <= TEXT_ATLAS) {
        this.textShelves.push({ y, h: H, x: W });
        return [0, y];
      }
      // full: draw what refers to the old contents, then start over
      this.submit();
      this.clearTextCache();
    }
    return [0, 0];
  }

  private readonly blurLocs = new Map<string, WebGLUniformLocation | null>();
  private blurLoc(name: string): WebGLUniformLocation | null {
    let l = this.blurLocs.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(this.blurProg, name); this.blurLocs.set(name, l); }
    return l;
  }

  /**
   * The shadow target: like 0x86b66c, half the surface size in device pixels (the globals 0x1aa4ab0/4,
   * set from the GL surface size by createGameMain and the resize handler 0x14441b4), at least 1 x 1.
   */
  private ensureFbos(): void {
    const gl = this.gl;
    const w = Math.max(Math.trunc(this.width * 0.5), 1), h = Math.max(Math.trunc(this.height * 0.5), 1);
    if (this.fboSize[0] === w && this.fboSize[1] === h && this.fbos.length) return;
    for (const f of this.fbos) {
      gl.deleteFramebuffer(f.fb);
      gl.deleteTexture(f.tex);
    }
    this.fbos = [];
    for (let i = 0; i < 1; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbos.push({ fb, tex });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboSize = [w, h];
  }
}
