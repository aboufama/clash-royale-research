// ScRenderer: WebGL2 renderer for baked Supercell SC2 movie clips.
//
// Port of tools/art/render.py Scene.collect(): a clip's frame is `frame % frameCount`; each
// element composes  world = parent * childMatrix  and  color = parent (x) childColor
// (sc2.Matrix.mul / sc2.Color.mul); a child's non-zero blend mode overrides the parent's; shapes
// are textured triangle strips. Unlike render.py it also implements
//   - masks (modifiers 38/39/40) with the stencil buffer (render.py ignores them),
//   - blend modes 3 multiply / 4 screen / 8 add as real GL blends (render.py: all "additive"),
//   - text fields (Canvas2D-rasterised, cached),
//   - named-child overrides (Supercell code swaps placeholder children such as the King tower's
//     `king_dummy`/`turret`, health-bar `bar` frames and text instances at runtime),
//   - a soft-shadow pass (silhouettes into an offscreen buffer, blurred, tinted).
// Nested clips receive `childFrame` (default = the root frame), i.e. one shared clock like
// render.py; pass a separate childFrame to hold the root on a frame while children animate.
//
// API:
//   const r = new ScRenderer(canvas);
//   r.begin([r, g, b, a]?)                   // clears, resets stats; call once per frame
//   r.setView(a, b, c, d, tx, ty)            // SC pixels -> canvas pixels (flushes)
//   r.draw(lib, 'Knight_run1_5', frame, matrix?, color?, opts?)
//   r.beginShadows(); ...draw silhouettes...; r.endShadows([r, g, b, a], blurPx)
//   r.end()                                  // flushes; r.stats = {drawCalls, triangles}
// Mirroring: pass a matrix with a negative x scale, e.g. [-s, 0, 0, s, x, y].
// Textures are premultiplied (createImageBitmap premultiplyAlpha) and mip-mapped.

import type { Col, Mat } from './math.ts';
import { colMul, IDENTITY, matScaleFactor, WHITE } from './math.ts';
import type { ScLibrary, ShapeCmd, TextFieldDef, TextureSource } from './library.ts';

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
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
}

const MAX_SLOTS = 8;
const FLOATS = 12; // x y u v mulR mulG mulB mulA addR addG addB slot
const MAX_VERTS = 65536;
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
  vec4 s = sampleSlot(vSlot, vUv);
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

const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;     // texel step * direction
uniform vec4 uTint;     // premultiplied output colour for the final pass, or (1,1,1,1)
uniform float uSigma;
out vec4 outColor;
void main() {
  float a = 0.0, wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float w = exp(-0.5 * float(i * i) / max(uSigma * uSigma, 0.0001));
    a += texture(uSrc, vUv + uStep * float(i)).a * w;
    wsum += w;
  }
  a /= wsum;
  outColor = uTint * a;
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
  private textCache = new Map<string, { tex: WebGLTexture; w: number; h: number; used: number }>();
  private frameNo = 0;
  // shadow pass
  private readonly blurProg: WebGLProgram;
  private readonly quadVao: WebGLVertexArrayObject;
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private fboSize: [number, number] = [0, 0];
  private inShadows = false;

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
    this.frameNo++;
    this.stats = { drawCalls: 0, triangles: 0 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.useProgram(this.prog);
    this.curBlend = -1;
    this.mode = 0;
    this.maskDepth = 0;
    this.inMaskWrite = false;
    this.setView(1, 0, 0, 1, 0, 0);
    if (this.frameNo % 120 === 0) this.gcText();
  }

  end(): void {
    this.flush();
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
    const sx = 2 / this.currentTargetWidth(), sy = -2 / this.currentTargetHeight();
    // column-major mat3: clip = P * V
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.uView, false, new Float32Array([
      a * sx, b * sy, 0,
      c * sx, d * sy, 0,
      tx * sx - 1, ty * sy + 1, 1,
    ]));
  }

  private currentTargetWidth(): number { return this.inShadows ? this.fboSize[0] : this.width; }
  private currentTargetHeight(): number { return this.inShadows ? this.fboSize[1] : this.height; }

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
    this.node(lib, id, Math.floor(frame), Math.floor(opts.childFrame ?? frame), 0, opts.blend ?? 0, opts);
  }

  /** Solid rectangle in SC px (premultiplied colour), for debug overlays. */
  drawRect(x: number, y: number, w: number, h: number, rgba: [number, number, number, number],
    matrix: Readonly<Mat> = IDENTITY): void {
    this.setBlend(0);
    if (this.nv + 4 > MAX_VERTS || this.ni + 6 > MAX_INDICES) this.flush();
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

  /** Start drawing shadow silhouettes into an offscreen buffer (alpha only, max-blended). */
  beginShadows(): void {
    this.flush();
    const gl = this.gl;
    this.ensureFbos();
    this.inShadows = true;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[0].fb);
    gl.viewport(0, 0, this.fboSize[0], this.fboSize[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.mode = 2;
    this.curBlend = -1;
    this.applyView();
  }

  /** Blur the silhouettes and composite them with a premultiplied-able colour [r, g, b, a] (0..1). */
  endShadows(rgba: [number, number, number, number], blurPx = 3): void {
    this.flush();
    const gl = this.gl;
    this.inShadows = false;
    this.mode = 0;
    gl.blendEquation(gl.FUNC_ADD);
    gl.useProgram(this.blurProg);
    gl.bindVertexArray(this.quadVao);
    const uStep = gl.getUniformLocation(this.blurProg, 'uStep');
    const uTint = gl.getUniformLocation(this.blurProg, 'uTint');
    const uSigma = gl.getUniformLocation(this.blurProg, 'uSigma');
    gl.uniform1i(gl.getUniformLocation(this.blurProg, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE0);
    const [w, h] = this.fboSize;
    const sigma = Math.max(0.01, blurPx / 2);
    const step = Math.max(1, sigma / 4); // 25 taps cover ~3 sigma
    // horizontal into fbo[1]
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1].fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    gl.uniform2f(uStep, step / w, 0);
    gl.uniform4f(uTint, 1, 1, 1, 1);
    gl.uniform1f(uSigma, sigma / step);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // vertical onto the screen, tinted
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex);
    gl.uniform2f(uStep, 0, step / h);
    gl.uniform4f(uTint, rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls += 2;
    gl.bindVertexArray(null);
    gl.useProgram(this.prog);
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
      if (name !== null && (opts.named || opts.text)) {
        const ov = opts.named?.[name];
        const txt = opts.text?.[name] ?? ov?.text;
        if (ov?.hide) continue;
        if (txt !== undefined) {
          const direct = lib.textFields.get(cid);
          const tf = direct ? { def: direct, m: null } : this.findTextField(lib, cid);
          if (tf) {
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
      if (this.nv + cmd.count > MAX_VERTS || this.ni + (cmd.count - 2) * 3 > MAX_INDICES) this.flush();
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
    a[o + 8] = ar; a[o + 9] = ag; a[o + 10] = ab; a[o + 11] = slot;
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
    gl.blendEquation(gl.FUNC_ADD);
    switch (m) {
      case 100: gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); break;
      case 8: gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); break;
      case 4: gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE); break;
      case 3: gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); break;
      default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  flush(): void {
    if (this.ni === 0) {
      this.nslots = 0;
      return;
    }
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform1i(this.uMode, this.inMaskWrite ? 1 : this.mode);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.nv * FLOATS);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.indices, 0, this.ni);
    for (let i = 0; i < this.nslots; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.slots[i]);
    }
    gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.nv = 0;
    this.ni = 0;
    this.nslots = 0;
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
      gl.enable(gl.STENCIL_TEST);
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.EQUAL, this.maskDepth - 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    } else if (mod === 39) { // masked content
      this.inMaskWrite = false;
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, this.maskDepth, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    } else if (mod === 40) { // end
      this.inMaskWrite = false;
      gl.colorMask(true, true, true, true);
      this.maskDepth = Math.max(0, this.maskDepth - 1);
      if (this.maskDepth === 0) {
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.disable(gl.STENCIL_TEST);
      } else {
        gl.stencilFunc(gl.EQUAL, this.maskDepth, 0xff);
      }
    }
  }

  // -- text fields ------------------------------------------------------------------------------

  private drawText(tf: TextFieldDef, text: string, m: Readonly<Mat>, c: Readonly<Col>, blend: number): void {
    if (!text) return;
    if (text.startsWith('TID_')) return; // localisation keys are not resolved here
    const vm = this.view;
    const scale = Math.max(0.25, Math.min(8, matScaleFactor(m) * matScaleFactor(vm)));
    const q = Math.pow(2, Math.round(Math.log2(scale) * 4) / 4); // quantise raster scale
    const [l, t, r, b] = tf.rect;
    const w = Math.max(1, r - l), h = Math.max(1, b - t);
    const key = `${tf.font}|${tf.bytes.join(',')}|${tf.color}|${tf.outline}|${w}x${h}|${q}|${text}`;
    let e = this.textCache.get(key);
    if (!e) {
      const pw = Math.ceil(w * q) + 8, ph = Math.ceil(h * q) + 8;
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
      const g = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      const size = (tf.bytes[2] || 16) * q;
      const align = tf.bytes[1] & 3;
      g.font = `${size}px "${tf.font}", "Supercell-Magic", sans-serif`;
      g.textBaseline = 'middle';
      g.textAlign = align === 2 ? 'center' : align === 1 ? 'right' : 'left';
      const x = align === 2 ? pw / 2 : align === 1 ? pw - 4 : 4;
      const y = ph / 2;
      const argb = (v: number) => `rgba(${(v >>> 16) & 255},${(v >>> 8) & 255},${v & 255},${((v >>> 24) & 255) / 255})`;
      if ((tf.outline >>> 24) & 255) {
        g.lineJoin = 'round';
        g.lineWidth = Math.max(1, size * 0.16);
        g.strokeStyle = argb(tf.outline);
        g.strokeText(text, x, y);
        // drop shadow below the outline (Supercell-Magic HUD style)
        g.save();
        g.translate(0, size * 0.06);
        g.strokeText(text, x, y);
        g.restore();
      }
      g.fillStyle = argb(tf.color | 0xff000000);
      g.fillText(text, x, y);
      const gl = this.gl;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv as TexImageSource);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { tex, w: pw, h: ph, used: this.frameNo };
      this.textCache.set(key, e);
    }
    e.used = this.frameNo;
    this.setBlend(blend);
    if (this.nv + 4 > MAX_VERTS || this.ni + 6 > MAX_INDICES) this.flush();
    const slot = this.slotFor(e.tex);
    const x0 = l - 4 / q, y0 = t - 4 / q, x1 = x0 + e.w / q, y1 = y0 + e.h / q;
    const base = this.nv;
    const corners: [number, number, number, number][] = [[x0, y0, 0, 0], [x1, y0, 1, 0], [x0, y1, 0, 1], [x1, y1, 1, 1]];
    for (const [px, py, u, v] of corners) {
      this.pushVert(m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5], u, v,
        c[0], c[1], c[2], c[3], c[4] / 255, c[5] / 255, c[6] / 255, slot);
    }
    this.pushIdx(base, base + 1, base + 2);
    this.pushIdx(base + 1, base + 3, base + 2);
  }

  /** Drop cached text rasters (call after web fonts finish loading). */
  clearTextCache(): void {
    for (const e of this.textCache.values()) this.gl.deleteTexture(e.tex);
    this.textCache.clear();
  }

  private gcText(): void {
    for (const [k, e] of this.textCache) {
      if (this.frameNo - e.used > 600) {
        this.gl.deleteTexture(e.tex);
        this.textCache.delete(k);
      }
    }
  }

  private ensureFbos(): void {
    const gl = this.gl;
    const w = this.width, h = this.height;
    if (this.fboSize[0] === w && this.fboSize[1] === h && this.fbos.length) return;
    for (const f of this.fbos) {
      gl.deleteFramebuffer(f.fb);
      gl.deleteTexture(f.tex);
    }
    this.fbos = [];
    for (let i = 0; i < 2; i++) {
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
