// EffectPlayer: the client's legacy_vfx effect system, ported from libg 160402020 (visual only).
//
//   const fx = new EffectPlayer(art);
//   const h = fx.play('Fireball_explosion', x, y, { team: 0, angle: 90 });   // logic units, degrees
//   fx.update(dtMs);                                   // integer-ms steps like the client
//   fx.draw(r, 'Ground'); for (const it of fx.collect('Object')) ... (it.sortY, it.draw(r))
//
// Effect instance (vtable 0x188c2a0; ctor 0x82b7ac, update 0x82bf10, stop 0x82d074, isDone 0x82cf98,
// setLoop 0x82cc5c, parent removed 0x82d300): an age in integer ms; each RenderableComponent is created
// on the first update with age >= its Time (0x82c58c) and then updated with the frame's dt; age += dt
// after the components. A Loop effect never finishes until stopped; with ForcedLength it restarts
// (components destroyed) every ForcedLength ms, and a non-looping one finishes at ForcedLength;
// otherwise it is done when every component has started and finished. Stopping (or the followed
// parent disappearing, for a looping effect) stops every component. FollowParent / attached effects
// take the parent sprite's position each update with y ± 0.01 world (in front of the parent). The
// enemy's effects use EnemyVersion (0x82dcb0 → 0xe22124) and their emitters' EnemyVersion (0xe56cbc).
//
// SWF component (0x82a360, update 0x82a994): the clip lasts D = frames · frame time; while not looping
// it is done once t >= D, frame ⌊t·frames / D⌋ (looping: t mod D); scale RenderableScale% × effect
// Scale; placed at the effect position (setPos3D 0x851b84).
//
// Particle emitter (SpecialEffect None; ctor 0x830b90, update 0x8319e8, spawn 0x831b90, new particle
// 0x8311e8): life = MinLife' + rand(MaxLife − MinLife') with MinLife' = max(MinLife, 1) (setLoop:
// looping → 0 = forever; else 0 → 2000; stop → 1). Each update steps the live particles (removing the
// dead ones), then spawns while life = 0 or age < life, then age += dt. Spawning: with the next-spawn
// timer >= 1 it counts down by dt; otherwise, while fewer than ParticleCount (≤ 100) are alive, spawn
// one pre-aged by −timer and add MinInterval + rand(MaxInterval − MinInterval) to the timer. A new
// particle picks a random resource; its angle is base + MinAngle + rand(range) (ParticleRandomAngle)
// or base + MinAngle + (⌊i·range / ParticleCount⌋ mod range) for the i-th spawn, + the parent's angle
// (ParticleAngleRelativeToParent); speed MinSpeed + rand(Δ)·effect Scale; vz (MinVZ + rand(Δ))·0.1;
// radius (MinR + rand(Δ)) / 2 along the angle; ParticleStartX/Z · 0.1; ParticleStartXYAreaRadius
// adds (sin a · 15, −cos a · 12) · (rand() mod R) · 0.002. Positions are world units (logic · 0.002).
//
// Particle (container, vtable 0x188c578; ctor 0x82f2c0, update 0x83094c → step 0x82fcc4, integrate
// 0x8306a4, bounce 0x831d08): Inertia ≠ 0 steps in fixed 16 ms slices. Integration from the launch:
// speed −= Inertia · dt / 1000 (clamped at 0); x += speed · cos · dt · 1e−4, y += speed · sin · dt · 1e−4;
// z = z0 + (vz + g · t/2) · t / 1000 with g = Gravity · 1e−4 and t the time since launch; hitting z = 0
// (unless NoBounce) restarts the arc at 0 with direction and vz × 0.65 (StopOnBounce: everything 0 and
// the clip stops). Scale RandomScale-jittered × RenderableScale% × lerp(StartScale, EndScale)/100 over
// life (only when either is set); FadeIn/FadeOut alpha; RotateToDirection turns the clip by the launch
// angle (not with FrameFromAngle, which launches along (sin, −cos) and picks frame ⌊⌊angle⌋·n / 360⌋);
// RotateMin/MaxSpeed spin per step. Clips play once over the particle's life (frame
// ⌊age·n/life⌋) unless LoopParticleClip (loop) or PlayParticleClipOnce / a "playOnce" first label
// (play once at fps). Tails (Min/MaxTailLength ms): a second point integrated `tail` ms behind; the
// clip is stretched from it to the head ((|d| + h)·s / h along atan2 d, h = the clip's height
// 0x123ca58: its current frame's bounds through its own rotation, before this step's frame update;
// the client measures the height, not the width). Shadow emitters add a copy in
// the Ground layer at (x, y, 0) offset (−5, 15 + ShadowYShift) px, skew 0.6, flipped vertically,
// tinted by the location shadow colour × ShadowMul% and alpha ShadowA · ShadowMulA / 25500.
//
// Layers (0xe22490 / 0x8569f0, drawn in this order): Base, Shadow (the shadow silhouette), Ground,
// GroundAbility, Object, Above. Base, Ground and Object are sorted every frame by the key vt+0x168
// (0x856a88): the ground-projected y of each sprite (+ SortingOffset for particles); GroundAbility and
// Above keep creation order. A missing Layer means Ground (0xe65a8c).
//
// Approximations (A): the client's Mersenne-Twister effect RNG is replaced by a seeded xorshift;
// emitter modifiers (EmitterReplaceType), trails (TrailSWF), SpecialEffect emitter types 1/2,
// ResourceFromAngle, AngularSpeed spirals around a parent and the 3D/light paths are
// not ported; area effects can be scaled by radius (`radius`/`refRadius`) and cut off (`durationMs`)
// by the caller.

import type { Col, Mat } from './math.ts';
import type { ScLibrary } from './library.ts';
import type { ClipRef, EffectComponent, EffectDef, EmitterDef } from './manifest.ts';
import type { ScRenderer } from './renderer.ts';
import type { BattleArt } from './battle_art.ts';
import { ClipPlayer } from './anim.ts';

/** logic units → world units */
const W = 0.002;

export interface PlayOptions {
  z?: number; // logic units above ground
  team?: 0 | 1; // 1 = the enemy of the viewing player: EnemyVersion effects/emitters
  /** effect angle in degrees (world space, the client's 0..360), e.g. the hit direction */
  angle?: number;
  scale?: number; // extra multiplier (effect scale)
  /** attach to a moving parent: its drawn position [x, y, z] in logic units, or null once it is gone */
  follow?: () => [number, number, number] | null;
  /** the parent's angle in degrees (ParticleAngleRelativeToParent), e.g. a projectile's flight */
  parentAngle?: () => number;
  /** end the effect after this many ms (area effects): it is stopped and its clips fade over `fadeMs` */
  durationMs?: number;
  fadeMs?: number;
  /** area effects: scale by radius / refRadius (ScaledEffects are authored at refRadius) */
  radius?: number;
  refRadius?: number;
  /** skip emitters whose particles are permanent (ParticleMinLife >= 100 s), e.g. tower rubble */
  skipPersistent?: boolean;
  /** draw nothing (HideWhenDelayed parents) while this returns true */
  hidden?: () => boolean;
}

export interface DrawItem {
  layer: string;
  sortY: number; // sort key: ground-projected SC px y (+ SortingOffset)
  draw(r: ScRenderer): void;
}

/** Visual-only random numbers: rand(n) in [0, n), 0 for n <= 0 (stands in for 0x12949ec). */
class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  u32(): number {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s;
  }
  int(n: number): number {
    n = Math.trunc(n);
    return n > 0 ? this.u32() % n : 0;
  }
  /** C rand(): 0..2^31−1 */
  crand(): number { return this.u32() >>> 1; }
}

interface Ctx {
  art: BattleArt;
  rng: Rng;
  seq: () => number;
  /** draw particle shadow copies */
  shadows: boolean;
  shadowCol: Col;
  shadowA: number;
  /** effect constructor 0x82b7ac: ShakeScreen / ShakeMaxIntensity (ms) start a screen shake (0x856a70) */
  shake: (def: { ShakeScreen?: number; ShakeMaxIntensity?: number }) => void;
}

// ---------------------------------------------------------------------------------- particles

interface Motion {
  tAge: number; // ms since launch (int)
  x: number; y: number; z0: number; z: number;
  dirX: number; dirY: number; vz: number; speed: number;
}

class Particle {
  readonly lib: ScLibrary;
  readonly exp: string;
  readonly frames: number;
  readonly seq: number;
  /** 'life': frame by age over life; 'clip': the clip plays on its own (loop or once) */
  mode: 'life' | 'clip';
  player: ClipPlayer | null = null;
  frame = 0;
  m: Motion;
  t: Motion | null = null; // tail point
  tail: number;
  age = 0;
  life = 0;
  acc = 0; // fixed-step accumulator (Inertia)
  rs = 1; // random scale factor (+0x1e4)
  compScale = 1; // RenderableScale (+0x1bc)
  clipRot: number; // the clip's own rotation (RotateToDirection without FrameFromAngle), degrees
  dirAngle: number; // +0x1d8: the launch angle with RotateToDirection, else 0
  rotSpeed: number;
  rotAcc = 0;
  /** container matrix a, b, c, d and screen position */
  a = 1; b = 0; c = 0; d = 1;
  px = 0; py = 0; gy = 0;
  alpha = 1;
  readonly floor: number;
  readonly g: number;
  readonly sortOff: number;
  readonly em: Emitter;

  constructor(em: Emitter, ref: ClipRef, lib: ScLibrary, x: number, y: number, z: number, vz: number, g: number,
    radius: number, angle: number, speed: number, tail: number, bounces: boolean, sortOff: number, seq: number) {
    this.em = em;
    const e = em.e;
    this.lib = lib;
    this.exp = ref.export;
    this.frames = Math.max(1, ref.frames ?? lib.frameCount(ref.export) ?? 1);
    this.seq = seq;
    const rad = angle * 0.017453294;
    let cx = Math.cos(rad), sy = Math.sin(rad);
    if (e.FrameFromAngle) { const c = cx; cx = sy; sy = -c; }
    x += radius * cx;
    y += radius * sy;
    if (e.InverseSpeed) { cx = -cx; sy = -sy; }
    this.m = { tAge: 0, x, y, z0: z, z, dirX: cx, dirY: sy, vz, speed };
    this.tail = tail;
    if (tail) this.t = { tAge: -tail, x, y, z0: z, z, dirX: cx, dirY: sy, vz, speed };
    this.g = g;
    this.floor = bounces ? 0 : -1e6;
    this.sortOff = sortOff;
    this.dirAngle = e.RotateToDirection ? angle : 0;
    this.clipRot = e.RotateToDirection && !e.FrameFromAngle ? angle : 0;
    // the clip plays on its own when its first label is "playOnce", PlayParticleClipOnce or LoopParticleClip
    const once = ref.labels?.['0'] === 'playOnce' || !!e.PlayParticleClipOnce;
    if (once || e.LoopParticleClip) {
      this.mode = 'clip';
      this.player = new ClipPlayer(this.frames, ref.fps || 30);
      if (once) this.player.playRange(0, this.frames - 1, false);
    } else {
      this.mode = 'life';
    }
    const rnd = (e.RandomScale as number | undefined) ?? 0;
    if (rnd > 0) this.rs += (em.ctx.rng.int(rnd * 2) - rnd) * 0.01;
    const rmin = (e.RotateMinSpeed as number | undefined) ?? 0, rmax = (e.RotateMaxSpeed as number | undefined) ?? 0;
    this.rotSpeed = ((((rmax - rmin) * em.ctx.rng.int(100)) / 100 | 0) + rmin) * 0.01;
    const amin = (e.ParticleMinSpawnAngle as number | undefined) ?? 0, amax = (e.ParticleMaxSpawnAngle as number | undefined) ?? 0;
    if (amin !== amax) this.setRot(amin + em.ctx.rng.int(amax - amin), this.rs);
    this.place(this.m);
  }

  private setRot(deg: number, s: number): void {
    const r = deg * 0.017453292;
    const c = Math.cos(r), sn = Math.sin(r);
    this.a = c * s; this.b = sn * s; this.c = -sn * s; this.d = c * s;
  }

  /** setPos3D: world position (relative to the emitter with ParticlesFollowParent) → screen + sort key */
  private place(m: Motion): void {
    const em = this.em;
    let x = m.x, y = m.y;
    if (em.followParticles) { x += em.x; y += em.y; }
    const art = em.ctx.art;
    const [px, py] = art.gameToPx(x / W, y / W, m.z / W);
    this.px = px; this.py = py;
    this.gy = art.gameToPx(x / W, y / W, 0)[1];
  }

  /** 0x8306a4 */
  private integrate(dt: number, m: Motion): void {
    const e = this.em.e;
    const oldZ = m.z;
    const t = Math.max(m.tAge, 0);
    m.z = m.z0;
    const ang = (e.AngularSpeed as number | undefined) ?? 0;
    if (ang !== 0) {
      const r = (((((e.ParticleStartXYAreaRadius as number | undefined) ?? 0) * t) | 0) * 0.01) / (this.life || 1);
      const a = (e.InverseSpeed ? -0.0001 : 0.0001) * (t * ang);
      m.dirX = Math.sin(a) * r;
      m.dirY = Math.cos(a) * r;
    }
    const sp = m.speed + ((e.Inertia as number | undefined) ?? 0) * dt * -0.001;
    m.speed = sp;
    if (sp >= 0) {
      m.x += sp * m.dirX * dt * 0.0001;
      m.y += dt * 0.0001 * m.speed * m.dirY;
    } else {
      m.speed = 0;
    }
    let z = m.z + (m.vz + this.g * (t / 2)) * t * 0.001;
    if (z < this.floor) z = this.floor;
    m.z = z;
    this.place(m);
    if (m.z <= this.floor && this.floor < oldZ) {
      m.z0 = this.floor;
      // 0x831d08 (no emitter modifiers): restart the arc
      m.tAge = 0;
      if (!e.StopOnBounce) {
        m.dirX *= 0.65; m.dirY *= 0.65; m.vz *= 0.65;
      } else {
        m.dirX = 0; m.dirY = 0; m.vz = 0;
        if (this.mode === 'life') this.mode = 'clip';
        if (this.player) this.player.gotoAndStop(this.player.frame);
        else { this.player = new ClipPlayer(this.frames, 30); this.player.gotoAndStop(this.frame); }
      }
    }
  }

  /** 0x83094c: true when dead */
  update(dt: number): boolean {
    if (!this.em.e.Inertia) return this.step(dt);
    this.acc += dt;
    if (this.acc < 16) return false;
    let dead = false;
    for (;;) {
      dead = this.step(16);
      if (dead) break;
      const a = this.acc;
      this.acc = a - 16;
      if (a <= 0x1f) break;
    }
    return dead;
  }

  /** 0x82fcc4 */
  private step(dt: number): boolean {
    const e = this.em.e;
    let tx = 0, ty = 0;
    if (this.t) {
      this.t.tAge += dt;
      this.integrate(this.t.tAge < 0 ? 0 : dt, this.t);
      tx = this.px; ty = this.py;
    }
    this.m.tAge += dt;
    this.integrate(dt, this.m);
    let s = this.rs;
    const s0 = (e.StartScale as number | undefined) ?? 0, s1 = (e.EndScale as number | undefined) ?? 0;
    if (s0 || s1) {
      s = this.rs * 0.01 * this.compScale * ((this.age * (s1 - s0)) / (this.life || 1) + s0);
      this.a = s; this.d = s;
    }
    if (this.t) {
      const w = this.height();
      const dx = this.px - tx, dy = this.py - ty;
      if (w > 0) {
        const len = ((Math.sqrt(dx * dx + dy * dy) + w) * s) / w;
        const r = Math.atan2(dy, dx);
        const c = Math.cos(r), sn = Math.sin(r);
        this.a = c * len; this.b = sn * len; this.c = -sn * s; this.d = c * s;
      }
      this.px = tx + dx * 0.5;
      this.py = ty + dy * 0.5;
    }
    if (this.mode === 'life') {
      const n = this.frames;
      let f = this.life ? Math.trunc((this.age * n) / this.life) : 0;
      if (f < 0) f = 0;
      if (f >= n) f = n - 1;
      if (e.FrameFromAngle) {
        // the frame picks the launch direction instead of the age
        const an = Math.trunc(this.dirAngle) * n;
        f = an < -359 ? 0 : Math.min(n - 1, Math.trunc(an / 360));
      }
      this.frame = f;
    }
    if (Math.abs(this.rotSpeed) > 0.05) {
      this.rotAcc += this.rotSpeed;
      this.setRot((e.FrameFromAngle ? 0 : this.dirAngle) + this.rotAcc, s);
    }
    let a = 1;
    const fin = (e.FadeInDuration as number | undefined) ?? 0;
    if (this.age < fin) a = this.age / fin;
    const fout = (e.FadeOutDuration as number | undefined) ?? 0;
    if (fout > 0) {
      const from = this.life - fout, into = this.age - from;
      if (into !== 0 && from <= this.age) a *= 1 - into / fout;
    }
    this.alpha = Math.max(0, Math.min(1, a));
    this.age += dt;
    return this.life <= this.age;
  }

  /**
   * The clip's height (0x123ca58: maxY − minY of its current frame through its own rotation matrix)
   * for tail stretching. The frame is the one shown before this step's frame update.
   */
  private height(): number {
    const r = this.clipRot * 0.017453292;
    const c = Math.cos(r), sn = Math.sin(r);
    return this.lib.frameHeight(this.exp, this.frame, [c, sn, -sn, c]);
  }

  advanceClip(dtS: number): void {
    if (this.player) {
      this.player.advance(dtS);
      this.frame = this.player.frame;
    }
  }

  item(layer: string, alphaMul: number): DrawItem | null {
    const al = this.alpha * alphaMul;
    if (al <= 0.002) return null;
    const lib = this.lib, exp = this.exp, f = this.frame;
    const cr = this.clipRot * 0.017453292;
    const kc = Math.cos(cr), ks = Math.sin(cr);
    // container [a, b, c, d] times the clip's own rotation (RotateToDirection)
    const m: Mat = [this.a * kc + this.c * ks, this.b * kc + this.d * ks, this.c * kc - this.a * ks, this.d * kc - this.b * ks, this.px, this.py];
    const col: Col = [1, 1, 1, Math.trunc(al * 255) / 255, 0, 0, 0];
    return { layer, sortY: this.gy + this.sortOff, draw: (r) => r.draw(lib, exp, f, m, col) };
  }

  shadowItem(alphaMul: number): DrawItem | null {
    const e = this.em.e;
    const ctx = this.em.ctx;
    const al = this.alpha * alphaMul * ((ctx.shadowA * ((e.ShadowMulA as number | undefined) ?? 0)) / 25500);
    if (al <= 0.002) return null;
    const art = ctx.art;
    let x = this.m.x, y = this.m.y;
    if (this.em.followParticles) { x += this.em.x; y += this.em.y; }
    const [gx, gy] = art.gameToPx(x / W, y / W, 0);
    const shift = (e.ShadowYShift as number | undefined) ?? 0;
    const flip = !e.IgnoreShadowFlip;
    const m: Mat = [this.a, this.b, flip ? 0.6 : this.c, flip ? -this.d : this.d, gx - 5, gy + shift + 15];
    const mul = (k: string) => Math.min(1, Math.max(0, ((ctx.shadowCol[k === 'R' ? 0 : k === 'G' ? 1 : 2] * 255) *
      ((e[`ShadowMul${k}`] as number | undefined) ?? 0)) / 25500));
    const col: Col = [mul('R'), mul('G'), mul('B'), al, 0, 0, 0];
    const lib = this.lib, exp = this.exp, f = this.frame;
    return { layer: 'Ground', sortY: gy, draw: (r) => r.draw(lib, exp, f, m, col) };
  }
}

// ---------------------------------------------------------------------------------- emitter

class Emitter {
  readonly kind = 'emit';
  readonly e: EmitterDef;
  readonly ctx: Ctx;
  readonly fx: Fx;
  readonly layer: string;
  life: number;
  age = 0;
  next = 0;
  count: number;
  counter = 0;
  parts: Particle[] = [];
  x = 0; y = 0; z = 0; // world units
  readonly followParticles: boolean;
  /** effect Scale (+0x8c), RenderableScale (+0x90), base angle in degrees (+0xd8) */
  readonly scale: number;
  readonly compScale: number;
  readonly baseAngle: number;

  constructor(ctx: Ctx, fx: Fx, e: EmitterDef, layer: string, scale: number, compScale: number, baseAngle: number) {
    this.scale = scale;
    this.compScale = compScale;
    this.baseAngle = baseAngle;
    this.ctx = ctx;
    this.fx = fx;
    this.e = e;
    this.layer = layer;
    const min = Math.max(e.MinLife ?? 0, 1), max = e.MaxLife ?? 0;
    this.life = ctx.rng.int(max - min) + min;
    // ParticleCount; the low-end quarter count is not applied (high-quality client, A), capped at 100
    this.count = Math.min(100, e.ParticleCount ?? 0);
    this.followParticles = !!e.ParticlesFollowParent;
  }

  setLoop(loop: boolean): void {
    if (loop) this.life = 0;
    else if (this.life === 0) this.life = 2000;
  }

  stop(): void { this.life = 1; }

  setPos(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }

  isDone(): boolean { return this.life !== 0 && this.life <= this.age && this.parts.length === 0; }

  /** 0x8319e8: true when finished */
  update(dt: number): boolean {
    const n0 = this.parts.length;
    const emitting = !(this.life !== 0 && this.life <= this.age);
    if (n0 || emitting) {
      for (let i = this.parts.length - 1; i >= 0; i--) {
        if (this.parts[i].update(dt)) this.parts.splice(i, 1);
      }
      if (emitting) this.spawn(dt);
      this.age += dt;
    }
    for (const p of this.parts) p.advanceClip(dt / 1000);
    return n0 === 0 && !emitting;
  }

  /** 0x831b90 */
  private spawn(dt: number): void {
    const e = this.e;
    if (!e.particles.length) return;
    let next = this.next;
    if (next >= 1) { this.next = next - dt; return; }
    if (this.parts.length < this.count) {
      const minI = e.ParticleMinInterval ?? 0, maxI = e.ParticleMaxInterval ?? 0;
      let p = this.newParticle(-next);
      while (p) {
        next = minI + next + this.ctx.rng.int(maxI - minI);
        this.next = next;
        if (this.count <= this.parts.length || next > 0) return;
        p = this.newParticle(-next);
      }
    }
    this.next = 0;
  }

  /** 0x8311e8 */
  private newParticle(preAge: number): Particle | null {
    if (this.parts.length >= this.count) return null;
    const e = this.e, rng = this.ctx.rng;
    const ref = e.particles[rng.int(e.particles.length)];
    const lib = this.ctx.art.libs.get(ref.sc);
    const minA = e.ParticleMinAngle ?? 0, rangeA = (e.ParticleMaxAngle ?? 0) - minA;
    let angle: number;
    if (!e.ParticleRandomAngle) {
      const n = rangeA < 2 ? 1 : rangeA; // unsigned compare in the client
      const i = this.counter++;
      const v = this.count ? Math.trunc((i * n) / this.count) : 0;
      angle = this.baseAngle + ((v - Math.trunc(v / n) * n) + minA);
    } else {
      angle = this.baseAngle + (rng.int(rangeA) + minA);
    }
    if (e.ParticleAngleRelativeToParent && this.fx.parentAngle) angle += this.fx.parentAngle();
    const minS = e.ParticleMinSpeed ?? 0;
    const speed = Math.trunc(minS + rng.int((e.ParticleMaxSpeed ?? 0) - minS) * this.scale);
    const minVz = e.ParticleMinVelocityZ ?? 0;
    const vz = (rng.int((e.ParticleMaxVelocityZ ?? 0) - minVz) + minVz) * 0.1;
    const minT = e.ParticleMinTailLength ?? 0;
    const tail = rng.int((e.ParticleMaxTailLength ?? 0) - minT) + minT;
    const minR = e.ParticleMinRadius ?? 0;
    const radius = (rng.int((e.ParticleMaxRadius ?? 0) - minR) + minR) / 2;
    let x = this.followParticles ? 0 : this.x;
    let y = this.followParticles ? 0 : this.y;
    const area = e.ParticleStartXYAreaRadius ?? 0;
    const angSpeed = (e.AngularSpeed as number | undefined) ?? 0;
    if (area && angSpeed < 1) {
      const a = (rng.crand() % 360) * 0.01745328;
      const d = (rng.crand() % area) * 0.002;
      x += Math.sin(a) * 15 * d;
      y -= Math.cos(a) * 12 * d;
    }
    const lifeMin = e.ParticleMinLife ?? 0;
    const life = rng.int((e.ParticleMaxLife ?? 0) - lifeMin) + lifeMin;
    if (!lib) return null;
    const p = new Particle(this, ref, lib, x + (e.ParticleStartX ?? 0) * 0.1, y, this.z + (e.ParticleStartZ ?? 0) * 0.1, vz,
      (e.ParticleGravity ?? 0) * 0.0001, radius, angle, speed, tail, !e.NoBounce,
      (e.SortingOffset as number | undefined) ?? 0, this.ctx.seq());
    // vt+0x30(effect scale) before the scale curve, then RenderableScale (0x8309f8)
    p.a = this.scale; p.d = this.scale;
    p.compScale = this.compScale;
    p.life = life;
    p.update(preAge);
    this.parts.push(p);
    return p;
  }
}

// ---------------------------------------------------------------------------------- SWF component

class SwfComp {
  readonly kind = 'swf';
  readonly lib: ScLibrary;
  readonly c: EffectComponent;
  readonly frames: number;
  readonly dur: number;
  readonly seq: number;
  loop = false;
  t = 0;
  frame = 0;
  done = false;
  x = 0; y = 0; z = 0;
  readonly scale: number;
  constructor(ctx: Ctx, c: EffectComponent, lib: ScLibrary, scale: number) {
    this.scale = scale;
    this.c = c;
    this.lib = lib;
    this.frames = Math.max(1, c.frames ?? lib.frameCount(c.export!) ?? 1);
    const fps = c.fps || 30;
    this.dur = Math.trunc(Math.fround(1 / fps) * this.frames * 1000);
    this.seq = ctx.seq();
  }
  setLoop(loop: boolean): void { this.loop = loop; }
  stop(): void { this.loop = false; }
  setPos(x: number, y: number, z: number): void { this.x = x; this.y = y; this.z = z; }
  isDone(): boolean { return this.done; }
  /** 0x82a994 */
  update(dt: number): boolean {
    const D = this.dur;
    if (!this.loop) {
      if (D <= this.t) { this.done = true; return true; }
    } else if (D) {
      this.t %= D;
    }
    if (this.frames >= 2) {
      let f = D ? Math.trunc((this.t * this.frames) / D) : 0;
      if (D <= this.t) f = this.frames - 1;
      this.frame = f;
    }
    this.t += dt;
    return false;
  }
}

// ---------------------------------------------------------------------------------- effect instance

type CompObj = Emitter | SwfComp | Fx;
interface CompSlot { c: EffectComponent; started: boolean; obj: CompObj | null }

class Fx {
  readonly kind = 'nest';
  readonly ctx: Ctx;
  readonly def: EffectDef;
  readonly name: string;
  readonly opts: PlayOptions;
  readonly enemy: boolean;
  readonly scale: number;
  readonly angle: number;
  age = 0;
  loop: boolean;
  follow: boolean;
  stopped = false;
  x: number; y: number; z: number; // world units
  slots: CompSlot[];
  /** area effects: fade multiplier after durationMs */
  fade = 1;
  killAt: number;
  readonly depth: number;
  parentAngle: (() => number) | undefined;

  constructor(ctx: Ctx, name: string, def: EffectDef, x: number, y: number, z: number, opts: PlayOptions, scale: number, depth: number) {
    this.ctx = ctx;
    this.name = name;
    this.def = def;
    this.opts = opts;
    this.enemy = opts.team === 1;
    this.x = x; this.y = y; this.z = z;
    this.scale = scale;
    this.angle = opts.angle ?? 0;
    this.loop = !!def.Loop;
    this.follow = !!opts.follow;
    this.parentAngle = opts.parentAngle;
    this.depth = depth;
    this.killAt = opts.durationMs ?? Infinity;
    this.slots = def.components.map((c) => ({ c, started: false, obj: null }));
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    for (const s of this.slots) s.obj?.setLoop(loop);
  }

  /** 0x82d074 */
  stop(): void {
    for (const s of this.slots) { s.obj?.stop(); s.started = true; }
    this.setLoop(false);
    this.stopped = true;
  }

  setPos(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z;
    for (const s of this.slots) s.obj?.setPos(x, y, z);
  }

  /** 0x82cf98 */
  isDone(): boolean {
    if (this.loop) return false;
    const forced = this.def.ForcedLength ?? 0;
    if (forced) return forced <= this.age;
    return this.slots.every((s) => s.started && (!s.obj || s.obj.isDone()));
  }

  private make(c: EffectComponent): CompObj | null {
    const ctx = this.ctx;
    const compScale = (c.scale ?? 100) * 0.01;
    if (c.type === 'SWF') {
      const lib = c.sc && c.export ? ctx.art.libs.get(c.sc) : undefined;
      if (!lib) return null;
      return new SwfComp(ctx, c, lib, compScale * this.scale);
    }
    if (c.type === 'ParticleEmitter' && c.emitter) {
      const m = ctx.art.manifest.emitters;
      let e = m[c.emitter];
      if (!e) return null;
      if (this.enemy && e.EnemyVersion && m[e.EnemyVersion]) e = m[e.EnemyVersion];
      if (this.opts.skipPersistent && (e.ParticleMinLife ?? 0) >= 100000) return null;
      return new Emitter(ctx, this, e, c.layer || 'Ground', this.scale, compScale, this.angle);
    }
    if (c.type === 'Effect' && c.effect) {
      if (this.depth > 8) return null;
      const effects = ctx.art.manifest.effects;
      let name = c.effect;
      let def = effects[name];
      if (!def) return null;
      if (this.enemy && def.EnemyVersion && effects[def.EnemyVersion]) { name = def.EnemyVersion; def = effects[name]; }
      // a nested effect keeps its own Scale (0x82b7ac reads it from its data); the caller's extra
      // scale and the area-effect radius scale (A) carry over
      const rs = this.opts.radius && this.opts.refRadius ? this.opts.radius / this.opts.refRadius : 1;
      const fx = new Fx(ctx, name, def, this.x, this.y, this.z, { ...this.opts, durationMs: undefined },
        effectScale(def) * (this.opts.scale ?? 1) * rs, this.depth + 1);
      ctx.shake(def);
      fx.parentAngle = this.parentAngle;
      return fx;
    }
    return null;
  }

  /** 0x82bf10: true when done */
  update(dt: number): boolean {
    if (this.follow && this.opts.follow) {
      const p = this.opts.follow();
      if (p) {
        // the parent sprite's position, y + 0.01 world (−0.01 before the flip) so it sorts in front
        this.x = p[0] * W; this.y = p[1] * W + (this.ctx.art.flip ? -0.01 : 0.01); this.z = p[2] * W;
      } else {
        // 0x82d300: the parent is gone; a looping attached effect stops
        this.follow = false;
        if (this.loop) this.stop();
      }
    }
    if (this.age >= this.killAt) {
      if (!this.stopped) this.stop();
      this.fade = Math.max(0, 1 - (this.age - this.killAt) / (this.opts.fadeMs ?? 300));
    }
    const forced = this.def.ForcedLength ?? 0;
    if (forced && forced <= this.age && this.loop) {
      for (const s of this.slots) { s.obj = null; s.started = false; }
      this.age = 0;
    }
    for (const s of this.slots) {
      if ((s.c.time ?? 0) > this.age) continue;
      if (!s.started) {
        s.started = true;
        if (!this.stopped) {
          s.obj = this.make(s.c);
          if (s.obj) {
            if (s.obj instanceof Fx) {
              const nf = s.obj.def.ForcedLength ?? 0;
              if (nf) s.obj.setLoop(false);
              else if (!s.obj.loop) s.obj.setLoop(this.loop);
            } else {
              s.obj.setLoop(this.loop && !forced);
            }
            s.obj.setPos(this.x, this.y, this.z);
          }
        }
      }
      const o = s.obj;
      if (!o) continue;
      if (this.follow) o.setPos(this.x, this.y, this.z);
      if (o.update(dt)) s.obj = null;
    }
    this.age += dt;
    if (this.fade <= 0) return true;
    return this.isDone();
  }

  collect(layer: string, out: DrawItem[], alphaMul: number): void {
    if (this.opts.hidden?.()) return;
    const a = alphaMul * this.fade;
    for (const s of this.slots) {
      const o = s.obj;
      if (!o) continue;
      if (o instanceof Fx) { o.collect(layer, out, a); continue; }
      if (o instanceof SwfComp) {
        if ((s.c.layer || 'Ground') !== layer || o.done) continue;
        const art = this.ctx.art;
        const [px, py] = art.gameToPx(o.x / W, o.y / W, o.z / W);
        const gy = art.gameToPx(o.x / W, o.y / W, 0)[1];
        const sc = o.scale, lib = o.lib, exp = s.c.export!, f = o.frame;
        const col: Col = [1, 1, 1, a, 0, 0, 0];
        out.push({ layer, sortY: gy, draw: (r) => r.draw(lib, exp, f, [sc, 0, 0, sc, px, py], col) });
        continue;
      }
      const em = o;
      const own = em.layer === layer;
      const shadow = layer === 'Ground' && !!em.e.Shadow && this.ctx.shadows;
      if (!own && !shadow) continue;
      for (const p of em.parts) {
        if (own) { const it = p.item(layer, a); if (it) out.push(it); }
        if (shadow) { const it = p.shadowItem(a); if (it) out.push(it); }
      }
    }
  }
}

function effectScale(def: EffectDef): number {
  return def.Scale ? def.Scale * 0.01 : 1;
}

/** Layers sorted by the sort key every frame (0x856f28 → 0x856a88). */
const SORTED = new Set(['Base', 'Ground', 'Object']);

export class EffectPlayer {
  readonly art: BattleArt;
  private list: Fx[] = [];
  private nextId = 1;
  private handles = new Map<number, Fx>();
  private ctx: Ctx;
  private seqN = 0;
  private dtAcc = 0;
  /** set false to skip particle shadow copies */
  get shadows(): boolean { return this.ctx.shadows; }
  set shadows(v: boolean) { this.ctx.shadows = v; }
  /** screen shake (battle layer +0x170 time left s, +0x174 intensity, +0x178/+0x17c offset px) */
  private shakeT = 0;
  private shakeI = 0;
  private shakeRng = new Rng(0x5eed);

  constructor(art: BattleArt, seed = 12345) {
    this.art = art;
    const sh = art.manifest.arena?.shadow ?? {};
    this.ctx = {
      art, rng: new Rng(seed), seq: () => this.seqN++, shadows: true,
      shadowCol: [(sh.ShadowR ?? 0) / 255, (sh.ShadowG ?? 0) / 255, (sh.ShadowB ?? 0) / 255, 1, 0, 0, 0],
      shadowA: sh.ShadowA ?? 0,
      shake: (def) => {
        // 0x856a70: a longer shake replaces the current one, with its intensity
        const t = (def.ShakeScreen ?? 0) * 0.001;
        if (this.shakeT < t) { this.shakeT = t; this.shakeI = (def.ShakeMaxIntensity ?? 0) * 0.001; }
      },
    };
  }

  /**
   * Battle layer update 0x856f28: the offset applied to every battle-layer child this frame. While
   * time is left, amplitude A = intensity when 0 < intensity < time left, else the time left (so it
   * fades out linearly), and the offset is 6·A SC px in a random direction (the client's view RNG
   * 0x1a46dd0 draws rand(10000) · 0.0006283 rad; its seed is not reproducible); time counts down by
   * the frame dt (s).
   */
  shakeOffset(dt: number): [number, number] {
    if (!(dt > 0) || !(this.shakeT > 0)) return [0, 0];
    const t = this.shakeT, i = this.shakeI;
    const a = Math.fround(6 * (i < t && i > 0 ? i : t));
    const ang = Math.fround(this.shakeRng.int(10000) * Math.fround(0.0006283));
    const off: [number, number] = [Math.fround(Math.cos(ang) * a), Math.fround(Math.sin(ang) * a)];
    this.shakeT = t - dt;
    if (this.shakeT <= 0) { this.shakeT = 0; this.shakeI = 0; }
    return off;
  }

  get count(): number { return this.list.length; }

  has(name: string): boolean { return !!this.art.manifest.effects[name]; }

  /** Start an effect at logic (x, y); returns a handle for stop(). Unknown names return 0. */
  play(name: string, x: number, y: number, opts: PlayOptions = {}): number {
    const effects = this.art.manifest.effects;
    let def = effects[name];
    if (!def) return 0;
    if (opts.team === 1 && def.EnemyVersion && effects[def.EnemyVersion]) { name = def.EnemyVersion; def = effects[name]; }
    const radiusScale = opts.radius && opts.refRadius ? opts.radius / opts.refRadius : 1;
    let px = x, py = y, pz = opts.z ?? 0;
    const f = opts.follow?.();
    if (f) { px = f[0]; py = f[1]; pz = f[2]; }
    const fx = new Fx(this.ctx, name, def, px * W, py * W, pz * W, opts, effectScale(def) * (opts.scale ?? 1) * radiusScale, 0);
    this.ctx.shake(def);
    this.list.push(fx);
    const id = this.nextId++;
    this.handles.set(id, fx);
    return id;
  }

  /** Stop an effect (0x82d074): no new particles or loops; live particles finish. With `fadeOut`,
   * clips also fade out as when `durationMs` elapses (area effects, A). */
  stop(handle: number, fadeOut = false): void {
    const e = this.handles.get(handle);
    if (e) {
      e.stop();
      if (fadeOut && e.killAt === Infinity) e.killAt = e.age;
    }
    this.handles.delete(handle);
  }

  clear(): void {
    this.list = [];
    this.handles.clear();
  }

  /** Advance every effect by dtMs (split into integer-ms updates like the client's frame dt). */
  update(dtMs: number): void {
    this.dtAcc += Math.max(0, dtMs);
    const dt = Math.floor(this.dtAcc);
    if (dt <= 0) return;
    this.dtAcc -= dt;
    this.list = this.list.filter((e) => !e.update(dt));
    const live = new Set(this.list);
    for (const [h, e] of this.handles) if (!live.has(e)) this.handles.delete(h);
  }

  /** Draw the items of one layer (sorted layers by key, the others in creation order). */
  draw(r: ScRenderer, layer: string): void {
    for (const it of this.collect(layer)) it.draw(r);
  }

  /** Items of a layer with their sort keys; Base/Ground/Object come sorted, others in creation order. */
  collect(layer: string): DrawItem[] {
    const out: DrawItem[] = [];
    for (const e of this.list) e.collect(layer, out, 1);
    if (SORTED.has(layer)) {
      // stable: equal keys keep creation order
      return out.map((it, i) => ({ it, i })).sort((p, q) => p.it.sortY - q.it.sortY || p.i - q.i).map((p) => p.it);
    }
    return out;
  }
}
