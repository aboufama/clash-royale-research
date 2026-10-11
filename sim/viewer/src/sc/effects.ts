// EffectPlayer: plays legacy_vfx effects (manifest.effects / manifest.emitters) at game positions.
//
//   const fx = new EffectPlayer(art);
//   fx.play('Fireball_explosion', x, y, { team: 0 });
//   fx.update(dtMs);
//   for (const it of fx.collect('Object')) ... (it.sortY, it.draw(r))   // interleave with units
//   fx.draw(r, 'Ground'); fx.draw(r, 'Base'); ... fx.draw(r, 'Above');
//
// Components: SWF (plays the export once, or loops with the effect), Effect (nested), ParticleEmitter
// (below), Filter (not drawn here; filters are applied to units, see BattleArt.filterAt).
// Component `Time` = start delay (ms); effect `Scale` x component `RenderableScale` scale everything.
// `EnemyVersion` is used for team 1. `Loop` effects restart until stop(); `FollowParent` effects
// track a callback position.
//
// Particle emitter model (field names from legacy_vfx/emitters.json; the semantics are inferred,
// not recovered from the game code, so this is an approximation):
//   - emitter lifetime = rand(MinLife, MaxLife) ms; one particle every rand(ParticleMin/MaxInterval) ms
//     while alive; with no interval, a single burst of ParticleCount particles.
//   - ParticleCount caps the number of live particles.
//   - particle lifetime rand(ParticleMinLife, ParticleMaxLife) ms; position starts at radius
//     rand(ParticleMin/MaxRadius) px along the emission angle rand(ParticleMin/MaxAngle) deg
//     (0 = screen up, clockwise; evenly spread unless ParticleRandomAngle), plus a random point in
//     ParticleStartXYAreaRadius and ParticleStartX; height ParticleStartZ px.
//   - horizontal speed rand(ParticleMin/MaxSpeed) px/s along the angle, vertical rand(Min/MaxVelocityZ)
//     px/s, gravity ParticleGravity px/s^2 on z (negative = falls); ground-plane y is foreshortened
//     like the arena and heights are projected by zScale (0.585); particles bounce on z = 0 (half speed) unless NoBounce / StopOnBounce.
//   - Inertia = percent of the parent's velocity inherited (trails use ~1).
//   - scale StartScale -> EndScale (percent, +-RandomScale), alpha fades over FadeIn/FadeOutDuration.
//   - RotateToDirection orients the clip along its screen velocity; RotateMin/MaxSpeed spin (deg/s).
//   - the particle clip plays at its own fps from birth; LoopParticleClip loops, otherwise it holds
//     its last frame.  Shadow draws a dark copy on the ground (Shadow layer, alpha ShadowMulA).
//   - not implemented: tails (ParticleMin/MaxTailLength), ribbon trails (TrailSWF), SpecialEffect,
//     Modifiers, AngularSpeed, FrameFromAngle/ResourceFromAngle.

import type { Col, Mat } from './math.ts';
import type { ScLibrary } from './library.ts';
import type { ClipRef, EffectComponent, EffectDef, EmitterDef } from './manifest.ts';
import type { ScRenderer } from './renderer.ts';
import type { BattleArt } from './battle_art.ts';

export interface PlayOptions {
  z?: number; // game units above ground
  team?: 0 | 1;
  angle?: number; // engine angle (radians) for ParticleAngleRelativeToParent
  scale?: number; // extra multiplier
  /** follow a moving parent: return [x, y, z] in game units, or null when the parent is gone */
  follow?: () => [number, number, number] | null;
  /** parent velocity in game units / s (for Inertia) */
  velocity?: () => [number, number, number];
}

export interface DrawItem {
  layer: string;
  sortY: number; // SC px of the effect origin on the ground (for depth sorting with units)
  draw(r: ScRenderer): void;
}

interface Particle {
  clip: ClipRef;
  lib: ScLibrary;
  x: number; y: number; z: number; // px, relative to the emitter origin (y ground plane, down)
  vx: number; vy: number; vz: number; // px/s
  age: number; life: number;
  s0: number; s1: number;
  rot: number; spin: number;
  stopped: boolean;
}

interface SwfComp { kind: 'swf'; c: EffectComponent; start: number; done: boolean; lib: ScLibrary | undefined }
interface EmitComp {
  kind: 'emit'; c: EffectComponent; e: EmitterDef; start: number; done: boolean; started: boolean;
  life: number; nextEmit: number; emitted: number; parts: Particle[];
}
interface NestComp { kind: 'nest'; c: EffectComponent; start: number; done: boolean; inst: EffectInst | null }
type Comp = SwfComp | EmitComp | NestComp;

interface EffectInst {
  name: string;
  def: EffectDef;
  x: number; y: number; z: number; // game units (current)
  t: number;
  scale: number;
  team: 0 | 1;
  angle: number;
  comps: Comp[];
  stopped: boolean;
  done: boolean;
  opts: PlayOptions;
  parent: EffectInst | null;
}

export class EffectPlayer {
  readonly art: BattleArt;
  private list: EffectInst[] = [];
  private seed: number;
  private nextId = 1;
  private handles = new Map<number, EffectInst>();
  /** set false to skip drawing particle shadows */
  shadows = true;
  /** screen projection of particle heights (orthographic camera: zPxPer1000 / pxPerTileX) */
  zScale: number;
  /** emitted screen-shake intensity of the last update (ms-weighted, effect ShakeScreen) */
  shake = 0;

  constructor(art: BattleArt, seed = 12345) {
    this.art = art;
    this.seed = seed >>> 0 || 1;
    this.zScale = art.manifest.arena.zPxPer1000 / art.manifest.arena.pxPerTileX;
  }

  private rnd(): number {
    // xorshift32 (visual-only randomness)
    let s = this.seed;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.seed = s;
    return s / 4294967296;
  }

  private range(a: number | undefined, b: number | undefined): number {
    const lo = a ?? 0, hi = b ?? lo;
    return lo + (hi - lo) * this.rnd();
  }

  get count(): number {
    return this.list.length;
  }

  has(name: string): boolean {
    return !!this.art.manifest.effects[name];
  }

  /** Start an effect; returns a handle for stop(). Unknown names return 0. */
  play(name: string, x: number, y: number, opts: PlayOptions = {}): number {
    const inst = this.make(name, x, y, opts, null);
    if (!inst) return 0;
    this.list.push(inst);
    const id = this.nextId++;
    this.handles.set(id, inst);
    return id;
  }

  /** Stop a (looping) effect: no new particles/loops; live particles finish. */
  stop(handle: number): void {
    const e = this.handles.get(handle);
    if (e) e.stopped = true;
    this.handles.delete(handle);
  }

  clear(): void {
    this.list = [];
    this.handles.clear();
  }

  private make(name: string, x: number, y: number, opts: PlayOptions, parent: EffectInst | null): EffectInst | null {
    const effects = this.art.manifest.effects;
    let def = effects[name];
    if (!def) return null;
    const team = opts.team ?? 0;
    if (team === 1 && def.EnemyVersion && effects[def.EnemyVersion]) {
      name = def.EnemyVersion;
      def = effects[name];
    }
    const inst: EffectInst = {
      name, def, x, y, z: opts.z ?? 0, t: 0, scale: ((def.Scale ?? 100) / 100) * (opts.scale ?? 1), team,
      angle: opts.angle ?? 0, comps: [], stopped: false, done: false, opts, parent,
    };
    inst.comps = this.makeComps(inst);
    return inst;
  }

  private makeComps(inst: EffectInst): Comp[] {
    const out: Comp[] = [];
    for (const c of inst.def.components) {
      const start = c.time ?? 0;
      if ((c.type === 'SWF') && c.sc && c.export) {
        out.push({ kind: 'swf', c, start, done: false, lib: this.art.libs.get(c.sc) });
      } else if (c.type === 'ParticleEmitter' && c.emitter) {
        let e = this.art.manifest.emitters[c.emitter];
        if (!e) continue;
        if (inst.team === 1 && e.EnemyVersion && this.art.manifest.emitters[e.EnemyVersion]) {
          e = this.art.manifest.emitters[e.EnemyVersion];
        }
        out.push({ kind: 'emit', c, e, start, done: false, started: false, life: 0, nextEmit: 0, emitted: 0, parts: [] });
      } else if (c.type === 'Effect' && c.effect) {
        out.push({ kind: 'nest', c, start, done: false, inst: null });
      }
    }
    return out;
  }

  update(dtMs: number): void {
    this.shake = 0;
    for (const e of this.list) this.step(e, dtMs);
    this.list = this.list.filter((e) => !e.done);
    for (const [h, e] of this.handles) if (e.done) this.handles.delete(h);
  }

  private step(e: EffectInst, dt: number): void {
    if (e.opts.follow) {
      const p = e.opts.follow();
      if (p) {
        e.x = p[0]; e.y = p[1]; e.z = p[2];
      } else {
        e.stopped = true;
      }
    } else if (e.parent && e.def.FollowParent !== false) {
      e.x = e.parent.x; e.y = e.parent.y; e.z = e.parent.z;
    }
    const t0 = e.t;
    e.t += dt;
    if (t0 === 0 && e.def.ShakeScreen) this.shake = Math.max(this.shake, e.def.ShakeScreen);
    const forced = e.def.ForcedLength;
    let allDone = true;
    for (const c of e.comps) {
      if (c.done) continue;
      const lt = e.t - c.start;
      if (lt < 0) {
        if (e.stopped) c.done = true;
        else allDone = false;
        continue;
      }
      if (c.kind === 'swf') {
        const frames = c.c.frames ?? 1, fps = c.c.fps || 30;
        if (!e.def.Loop && (lt * fps) / 1000 >= frames) c.done = true;
        if (e.def.Loop && e.stopped) c.done = true;
      } else if (c.kind === 'nest') {
        if (!c.inst) {
          c.inst = this.make(c.c.effect!, e.x, e.y, { team: e.team, angle: e.angle, scale: e.scale * ((c.c.scale ?? 100) / 100), z: e.z, velocity: e.opts.velocity }, e);
          if (!c.inst) { c.done = true; continue; }
        }
        if (e.stopped) c.inst.stopped = true;
        this.step(c.inst, c.inst.t === 0 ? lt : dt);
        if (c.inst.done) c.done = true;
      } else {
        this.stepEmitter(e, c, lt, dt);
      }
      if (!c.done) allDone = false;
    }
    if (forced && e.t >= forced) allDone = true;
    if (allDone) {
      if (e.def.Loop && !e.stopped && e.t > 0) {
        e.t = 0;
        e.comps = this.makeComps(e);
      } else {
        e.done = true;
      }
    }
  }

  private stepEmitter(e: EffectInst, c: EmitComp, lt: number, dt: number): void {
    const em = c.e;
    const sc = e.scale * ((c.c.scale ?? 100) / 100);
    if (!c.started) {
      c.started = true;
      c.life = em.MinLife !== undefined || em.MaxLife !== undefined ? this.range(em.MinLife, em.MaxLife) : 0;
      c.nextEmit = 0;
      dt = lt; // first step covers the time since the component's start
    }
    const max = em.ParticleCount ?? 1;
    const hasInterval = (em.ParticleMinInterval ?? 0) > 0 || (em.ParticleMaxInterval ?? 0) > 0;
    const emitting = !e.stopped || !e.def.Loop;
    if (emitting && em.particles.length) {
      if (!hasInterval) {
        if (c.emitted === 0) for (let i = 0; i < max; i++) this.emit(e, c, sc, i, max, 0);
      } else {
        const end = Math.min(lt, Math.max(c.life, 0.0001));
        let guard = 0;
        while (c.nextEmit <= end && guard++ < 500) {
          if (c.parts.length < max) this.emit(e, c, sc, c.emitted, max, lt - c.nextEmit);
          c.nextEmit += Math.max(0.5, this.range(em.ParticleMinInterval, em.ParticleMaxInterval));
        }
      }
    }
    // integrate particles
    const g = em.ParticleGravity ?? 0;
    for (const p of c.parts) {
      p.age += dt;
      if (p.stopped) continue;
      const s = dt / 1000;
      p.vz += g * s * sc;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.z += p.vz * s;
      if (p.z < 0 && p.vz < 0) {
        p.z = 0;
        if (em.StopOnBounce) {
          p.vx = p.vy = p.vz = 0;
          p.stopped = true;
        } else if (em.NoBounce) {
          p.vz = 0;
        } else {
          p.vz = -p.vz * 0.45;
          p.vx *= 0.6;
          p.vy *= 0.6;
          if (Math.abs(p.vz) < 20 * sc) p.vz = 0;
        }
      }
      p.rot += p.spin * s;
    }
    c.parts = c.parts.filter((p) => p.age < p.life);
    const emitterOver = !hasInterval ? c.emitted > 0 || !em.particles.length : lt >= c.life;
    if ((emitterOver || e.stopped) && c.parts.length === 0) c.done = true;
  }

  private emit(e: EffectInst, c: EmitComp, sc: number, index: number, count: number, preAge: number): void {
    const em = c.e;
    const ref = em.particles[Math.floor(this.rnd() * em.particles.length)];
    const lib = this.art.libs.get(ref.sc);
    c.emitted++;
    if (!lib) return;
    const minA = em.ParticleMinAngle ?? 0, maxA = em.ParticleMaxAngle ?? 0;
    let deg = em.ParticleRandomAngle || count <= 1 ? this.range(minA, maxA) : minA + ((maxA - minA) * index) / count;
    if (em.ParticleAngleRelativeToParent) deg += 90 - (e.angle * 180) / Math.PI; // engine angle -> screen-up-based
    const a = (deg * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a); // 0 = up (screen), clockwise
    const rad = this.range(em.ParticleMinRadius, em.ParticleMaxRadius) * sc;
    const aspect = (em.ParticleRadiusAspect ?? 100) / 100;
    let x = dx * rad + (em.ParticleStartX ?? 0) * sc, y = dy * rad * aspect;
    if (em.ParticleStartXYAreaRadius) {
      const rr = Math.sqrt(this.rnd()) * em.ParticleStartXYAreaRadius * sc, aa = this.rnd() * Math.PI * 2;
      x += Math.cos(aa) * rr;
      y += Math.sin(aa) * rr;
    }
    const speed = this.range(em.ParticleMinSpeed, em.ParticleMaxSpeed) * sc;
    let vx = dx * speed, vy = dy * speed;
    if (em.Inertia && e.opts.velocity) {
      const [pvx, pvy] = e.opts.velocity();
      const k = em.Inertia / 100;
      vx += (pvx / 1000) * this.art.pxPerTileX * k;
      vy -= (pvy / 1000) * this.art.pxPerTileX * k;
    }
    const rs = em.RandomScale ? 1 + ((this.rnd() * 2 - 1) * em.RandomScale) / 100 : 1;
    const p: Particle = {
      clip: ref, lib, x, y, z: (em.ParticleStartZ ?? 0) * sc,
      vx, vy, vz: this.range(em.ParticleMinVelocityZ, em.ParticleMaxVelocityZ) * sc,
      age: 0, life: Math.max(1, this.range(em.ParticleMinLife, em.ParticleMaxLife)),
      s0: ((em.StartScale ?? 100) / 100) * rs * sc, s1: ((em.EndScale ?? em.StartScale ?? 100) / 100) * rs * sc,
      rot: 0, spin: (this.range(em.RotateMinSpeed, em.RotateMaxSpeed) * Math.PI) / 180, stopped: false,
    };
    if (preAge > 0) p.age = Math.min(preAge, p.life * 0.5);
    c.parts.push(p);
  }

  // -- drawing ---------------------------------------------------------------------------------

  /** Draw items of one layer in creation order. */
  draw(r: ScRenderer, layer: string): void {
    for (const it of this.collect(layer)) it.draw(r);
  }

  /** Draw items of a layer with their sort keys (SC px y of the effect origin). */
  collect(layer: string): DrawItem[] {
    const out: DrawItem[] = [];
    for (const e of this.list) this.collectInst(e, layer, out);
    return out;
  }

  private collectInst(e: EffectInst, layer: string, out: DrawItem[]): void {
    const [ox, oy] = this.art.gameToPx(e.x, e.y, e.z);
    const [, groundY] = this.art.gameToPx(e.x, e.y, 0);
    for (const c of e.comps) {
      const lt = e.t - c.start;
      if (lt < 0) continue;
      if (c.kind === 'nest') {
        if (c.inst && !c.inst.done) this.collectInst(c.inst, layer, out);
        continue;
      }
      if (c.kind === 'swf') {
        if (c.done || c.c.layer !== layer || !c.lib) continue;
        const lib = c.lib, comp = c.c;
        const s = e.scale * ((comp.scale ?? 100) / 100);
        const fps = comp.fps || 30, frames = comp.frames ?? 1;
        let f = Math.floor((lt * fps) / 1000);
        f = e.def.Loop ? f % frames : Math.min(frames - 1, f);
        out.push({ layer, sortY: groundY, draw: (r) => r.draw(lib, comp.export!, f, [s, 0, 0, s, ox, oy]) });
        continue;
      }
      const em = c.e;
      const own = c.c.layer === layer;
      const shadowCopy = this.shadows && !!em.Shadow && layer === 'Shadow' && !own;
      if (!own && !shadowCopy) continue;
      for (const p of c.parts) {
        const item = this.particleItem(p, em, ox, oy, groundY, own ? null : 'shadow');
        if (item) out.push(item);
      }
    }
  }

  private particleItem(p: Particle, em: EmitterDef, ox: number, oy: number, groundY: number,
    mode: 'shadow' | null): DrawItem | null {
    const t = p.age / p.life;
    const sc = p.s0 + (p.s1 - p.s0) * t;
    let alpha = 1;
    const fin = em.FadeInDuration ?? 0, fout = em.FadeOutDuration ?? 0;
    if (fin > 0 && p.age < fin) alpha *= p.age / fin;
    if (fout > 0) alpha *= Math.min(1, (p.life - p.age) / fout);
    if (alpha <= 0.002 || sc <= 0) return null;
    const frames = p.clip.frames ?? 1, fps = p.clip.fps || 30;
    let f = Math.floor((p.age * fps) / 1000);
    f = em.LoopParticleClip ? f % frames : Math.min(frames - 1, f);
    let rot = p.rot;
    if (em.RotateToDirection) {
      const vy = p.vy * this.art.yScale - p.vz * this.zScale;
      if (Math.abs(p.vx) + Math.abs(vy) > 1e-3) rot += Math.atan2(vy, p.vx) + Math.PI / 2;
    }
    const cs = Math.cos(rot) * sc, sn = Math.sin(rot) * sc;
    const lib = p.lib, exp = p.clip.export;
    if (mode === 'shadow') {
      const m: Mat = [cs, sn * 0.5, -sn, cs * 0.5, ox + p.x, oy + p.y * this.art.yScale];
      const col: Col = [0, 0, 0, alpha * ((em.ShadowMulA ?? 60) / 100), 0, 0, 0];
      return { layer: 'Shadow', sortY: groundY, draw: (r) => r.draw(lib, exp, f, m, col) };
    }
    const m: Mat = [cs, sn, -sn, cs, ox + p.x, oy + p.y * this.art.yScale - p.z * this.zScale];
    const col: Col = [1, 1, 1, alpha, 0, 0, 0];
    return { layer: '', sortY: groundY + p.y * this.art.yScale, draw: (r) => r.draw(lib, exp, f, m, col) };
  }
}
