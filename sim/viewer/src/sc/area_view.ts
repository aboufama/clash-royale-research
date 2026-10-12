// The client's area-effect object view and buff views, ported from libg 160402020 (visual only; never
// feeds the engine). Decompiles: work/native/decomp_aoe/.
//
// Area-effect object view. The battle layer's view factory 0x84fc88 makes a view for every actor the
// world adds, by its class (actor vt+0x10): 1 → 0x84b9e8, 4 projectile → 0x854598, 6 → 0x852438, 5
// characters → 0x836860 / 0x85ab1c, anything else (class 3 = AreaEffectObject, vt+0x10 0xf7b3cc) →
// operator new(0x328) + ctor 0x833b84, vtable 0x188c8f8 (per-frame vt+0x208 0x8342c8, removal vt+0x10
// 0x834038, layer vt+0x220 0x84f530 = 10 'Object', projectile deflection vt+0x58 0x834104).
// AreaEffectData (loader 0xdc2e74): +0x98 FileName, +0xa8 ExportName, +0xc0 LoopingEffect, +0xc8
// ScaledEffect, +0xd0 OneShotEffect, +0xd8 HitEffect, +0xe0 NoFollowObjectEffect, +0x148 LifeDuration,
// +0x15d Clone, +0x1a0 FollowBehaviour, +0x1c8 ScaledEffectFollowAeO, +0x1e8 ParentLoopingEffectToSelf,
// +0x178/+0x184 DeflectionFBEffect list (0xdc280c).
//
// Constructor 0x833b84, at the actor's logic x, y, z (Actor_getX/Y/Z), enemy version for the opponent
// (0x84ddcc), every effect's SWF hold-and-fade time E = 200 ms (0x82ccd0, effect +0x9c):
//   LoopingEffect → 0x82dedc (setLoop 1), parent = the area-effect actor, attached (follows its sprite,
//     y + 0.01 world), handle +0x308;
//   OneShotEffect → 0x82dc54 (setLoop 0), no parent, handle +0x30c;
//   ScaledEffect  → 0x82dc54 (setLoop 0, so a Loop flag in its data is overridden), parent = the actor,
//     attached only when the actor follows a target (+0x138), handle +0x310; its SWF length
//     D = life − 200 (0x82ccd8, effect +0x98; life = 0xf79d50: actor +0x114 when set, else LifeDuration),
//     so its own SWF clips are stretched over the object's life and then fade over the last 200 ms;
//     with client globals +0x198 = 2 and Clone (or the name ArcherQueenCloak) its render mode +0xbc = 2;
//   then 0x833e34: FileName + ExportName (both set) → that clip is added to the GO_SPRITE (layer 10).
// The effects of a parented call start at the parent's sprite with y ∓ 0.01 world (0x82b7ac); an
// unattached parented effect keeps that start, and follows only with its data's FollowParent.
// The variant index passed with each call is the actor's +0x110 (prestige variants, 0xe2212c..0xe2213c);
// the sandbox has none (variant 0). 0x82dedc's screen-shake flag is that same value ≠ 0, so the Looping
// and NoFollow effects start no shake with variant 0 (no supported looping effect has ShakeScreen, so
// the effect player's unconditional shake makes no difference here).
//
// Per frame 0x8342c8: the GO_SPRITE goes to the interpolated actor position (0x84d738). With a followed
// target (+0x138, AreaEffect_update 0xf7a34c moves the object onto it): the LoopingEffect is re-parented
// to the target (to the object itself with ParentLoopingEffectToSelf) and attached, the OneShotEffect
// to the target, the ScaledEffect to the object (ScaledEffectFollowAeO) or the target; each re-parented
// handle is remembered (+0x318 / +0x31c / +0x320). The NoFollowObjectEffect (+0x314) is stopped (0x82e4a4)
// as soon as there is a target — the client then clears the ScaledEffect handle +0x310, not +0x314 —
// and while there is none it is (re)started when not running: 0x82dedc at the actor, parent the actor,
// attached, setVisible(1) (vt+0x60), E = 200. With the expire flag +0x118 (set only by the tiebreak's
// field clear 0x10cad30 → 0xf7b458) every frame runs 0x833ea8: setLoop(0) and setVisible(0) on the
// Looping, Scaled, OneShot and NoFollow effects.
// Removal (vt+0x10 0x834038, when the actor leaves the world): 0x833ea8 if the expire flag is set, then
// the re-parented handles, the NoFollow and the ScaledEffect are deleted at once (0x82e160); the
// LoopingEffect is stopped by the effect manager's parent-removed notice (0x82d300: an attached looping
// effect whose parent goes runs 0x82d074 stop), so its clips play out their loop and fade over E; the
// OneShotEffect plays out.
// Pulses (AreaEffect_update 0xf7a34c, at the end of every pulse tick, with or without targets): a
// HitEffect plays through the view's vt+0x80 (0x84e784: at the actor's x, y, z, parent the actor, not
// attached, the effect's own Loop); for per-target projectiles (TargetProjectiles) the HitEffect is
// also handed to Projectile_setup.
//
// Buff views (character view update 0x839b08 → 0x835788 each frame: one buff view per buff instance,
// matched by instance; ctor 0x8348c8, per-frame 0x834f74, removal 0x834e54). BuffData (reader
// 0xddb0d8): +0x90 Effect, +0x98 MarkEffect, +0xa0 TopEffect, +0x100 Scale, +0x138
// FilterAffectsTransformation, +0x139 FilterInheritLifeDuration, +0x150 ContinuousEffect, +0x158
// LoopContinuousEffect, +0x160 PreContinuousEffect, +0x1e0 FilterFile, +0x1f0 FilterExportName,
// +0x250 ShadowAlpha, +0x260 EffectScale, +0x268 ContinuousEffectScale.
//   Effect → 0x82dcb0 at the actor's x, y, z, parent the actor, not attached (so it follows only with
//     its FollowParent), its own Loop; EffectScale replaces the effect scale (0x82ccf8, effect +0x90);
//     deleted at once when the buff view goes (0x834e54 → 0x82e160);
//   filter → 0x82ea34(actor, FilterFile, FilterExportName, loop = !FilterInheritLifeDuration,
//     FilterAffectsTransformation, D = FilterInheritLifeDuration ? the buff instance's time (+8) : −1 =
//     the clip's length); its update 0x82ebdc (vt+0x18, dt ms) picks frame ⌊t·n / max(D, 1)⌋ (looping:
//     t mod D; capped at n − 1, below 1 → 0; not looping: done once t >= D), and multiplies the clip's
//     first child's colour into each sprite of the actor's view: add = min(255, add + add'), mul =
//     mul·mul'/255, alpha = alpha·alpha'/255 (crown towers, vt+0x170 = 1, keep their alpha and skip
//     the transform), FilterAffectsTransformation also concatenates the child's matrix; t += dt after.
//   ContinuousEffect / PreContinuousEffect / TopEffect / SwitchTeam effects: no supported buff has one.
// MarkEffect: the only reference found is the asset preload 0xe6d00c; no battle view plays it.

import type { EffectPlayer } from './effects.ts';
import type { AreaEffectArt, BuffArt, EffectDef, Manifest } from './manifest.ts';
import type { Col } from './math.ts';

/** 0x833b84 / 0x8342c8: every effect the area-effect view starts gets this SWF hold-and-fade time. */
export const AEO_FADE_MS = 200;

export type AeoSlot = 'looping' | 'oneShot' | 'scaled';

/** One effect call of the area-effect view constructor 0x833b84. */
export interface AeoEffectCall {
  slot: AeoSlot;
  effect: string;
  /** setLoop after creation: 0x82dedc → true, 0x82dc54 → false */
  loop: boolean;
  /** parent = the area-effect actor (start at its sprite, y ∓ 0.01 world) */
  parented: boolean;
  /** attach flag passed to 0x82dcb0 (the effect also follows with its data's FollowParent) */
  attach: boolean;
  /** SWF length D (−1: each clip's own) and hold-and-fade time E */
  swfLength: number;
  swfFade: number;
}

/**
 * The effects 0x833b84 starts, in its order. `life` = 0xf79d50 (actor +0x114 when ≥ 0, else
 * LifeDuration); `hasTarget` = actor +0x138 (the followed actor).
 */
export function aeoViewEffects(a: AreaEffectArt, life: number, hasTarget = false): AeoEffectCall[] {
  const e = a.effects ?? {};
  const out: AeoEffectCall[] = [];
  if (e.loopingEffect) {
    out.push({ slot: 'looping', effect: e.loopingEffect, loop: true, parented: true, attach: true, swfLength: -1, swfFade: AEO_FADE_MS });
  }
  if (e.oneShotEffect) {
    out.push({ slot: 'oneShot', effect: e.oneShotEffect, loop: false, parented: false, attach: false, swfLength: -1, swfFade: AEO_FADE_MS });
  }
  if (e.scaledEffect) {
    out.push({ slot: 'scaled', effect: e.scaledEffect, loop: false, parented: true, attach: hasTarget,
      swfLength: life - AEO_FADE_MS, swfFade: AEO_FADE_MS });
  }
  return out;
}

/** The engine's view of an area effect object this module needs. */
export interface AeoActor {
  id: number;
  x: number;
  y: number;
  /** remaining life ms (actor +0x100) */
  life: number;
  def: { name: string; lifeDuration: number };
}

interface AeoView {
  id: number;
  name: string;
  team: 0 | 1;
  x: number;
  y: number;
  z: number;
  looping: number;
  oneShot: number;
  scaled: number;
  noFollow: number;
  /** +0x318 / +0x31c / +0x320: handles re-parented to a target (deleted at removal) */
  reparented: number[];
  /** the actor has left the world (its attached looping effect stops) */
  gone: boolean;
  /** 0x833ea8 ran (expire flag): every effect it touched is invisible */
  hidden: boolean;
}

/**
 * Area-effect object views by engine id. `create` is the factory call (0x84fc88 → 0x833b84) for an
 * engine 'aoe' event, `pulse` the end-of-pulse HitEffect ('aoePulse'), `update` the per-frame view
 * update 0x8342c8 and, for objects the engine no longer has, the removal 0x834038.
 */
export class AreaViews {
  private views = new Map<number, AeoView>();
  private battle: unknown = null;
  private readonly fx: EffectPlayer;
  private readonly manifest: Manifest;
  private readonly flip: boolean;

  constructor(fx: EffectPlayer, manifest: Manifest, flip: boolean) {
    this.fx = fx;
    this.manifest = manifest;
    this.flip = flip;
  }

  get size(): number { return this.views.size; }

  /** A new battle: actor ids restart; the old views are dropped (their effects run out). */
  reset(battle: unknown): void {
    if (this.battle === battle) return;
    this.battle = battle;
    this.views.clear();
  }

  /** 0x833b84 for an area effect object the world just added (logic x, y, z; life per 0xf79d50). */
  create(battle: unknown, id: number, name: string, team: 0 | 1, x: number, y: number, z: number, life: number): void {
    this.reset(battle);
    if (this.views.has(id)) return;
    const a = this.manifest.areaEffects?.[name];
    const v: AeoView = { id, name, team, x, y, z, looping: 0, oneShot: 0, scaled: 0, noFollow: 0, reparented: [], gone: false, hidden: false };
    this.views.set(id, v);
    if (!a) return;
    for (const c of aeoViewEffects(a, life, false)) {
      const h = this.start(v, c.effect, c.loop, c.parented, c.attach, c.swfLength, c.swfFade);
      if (c.slot === 'looping') v.looping = h;
      else if (c.slot === 'oneShot') v.oneShot = h;
      else v.scaled = h;
    }
  }

  /** End of an area-effect pulse (0xf7a34c): HitEffect through view vt+0x80 (0x84e784). */
  pulse(id: number): void {
    const v = this.views.get(id);
    const hit = v && this.manifest.areaEffects?.[v.name]?.effects?.hitEffect;
    if (!v || !hit) return;
    // 0x84e784 → 0x82dcb0(..., parent = the actor, attach 0, angle 0, 1, 1, variant 0, 1): the effect's own Loop
    this.start(v, hit, undefined, true, false, -1, 0);
  }

  /**
   * Per frame: the view update 0x8342c8 for live objects (no followed targets in the engine: +0x138 = 0,
   * so only the NoFollowObjectEffect path runs) and the removal 0x834038 for objects that left the
   * world. `tiebreakClear` marks removals by the tiebreak's field clear (0x10cad30 sets the expire flag).
   */
  update(battle: unknown, live: readonly AeoActor[], tiebreakClear = false): void {
    this.reset(battle);
    if (!this.views.size) return;
    for (const v of this.views.values()) {
      if (live.some((a) => a.id === v.id)) this.frame(v);
      else this.removeView(v, tiebreakClear);
    }
  }

  private frame(v: AeoView): void {
    const fx = this.fx;
    if (v.noFollow && !fx.alive(v.noFollow)) v.noFollow = 0;
    if (!v.noFollow) {
      const eff = this.manifest.areaEffects?.[v.name]?.effects?.noFollowObjectEffect;
      if (eff) v.noFollow = this.start(v, eff, true, true, true, -1, AEO_FADE_MS);
    }
  }

  /** 0x834038 */
  private removeView(v: AeoView, expired: boolean): void {
    const fx = this.fx;
    if (expired) {
      // 0x833ea8: setLoop(0) + setVisible(0) on +0x308, +0x310, +0x30c, +0x314 (here a stop and the
      // `hidden` flag: nothing of them is drawn again either way)
      for (const h of [v.looping, v.scaled, v.oneShot, v.noFollow]) if (h) fx.stop(h);
      v.hidden = true;
    }
    for (const h of [...v.reparented, v.noFollow, v.scaled]) if (h) fx.remove(h);
    // the attached LoopingEffect sees its parent go (0x82d300) through its follow callback
    v.gone = true;
    this.views.delete(v.id);
  }

  /**
   * One 0x82dcb0 call for view `v`: at the actor's logic position, or (parented) at its sprite with
   * y ∓ 0.01 world; attached effects follow the actor until it goes.
   */
  private start(v: AeoView, effect: string, loop: boolean | undefined, parented: boolean, attach: boolean,
    swfLength: number, swfFade: number): number {
    const def: EffectDef | undefined = this.manifest.effects[effect];
    if (!def) return 0;
    const front = parented ? (this.flip ? -5 : 5) : 0; // 0.01 world = 5 logic units
    const follows = parented && (attach || !!def.FollowParent);
    const follow = follows ? () => (v.gone ? null : [v.x, v.y, v.z] as [number, number, number]) : undefined;
    return this.fx.play(effect, v.x, v.y + front, {
      team: v.team, z: v.z, loop, follow, swfLength, swfFade, hidden: () => v.hidden,
    });
  }
}

// ---------------------------------------------------------------------------------- buff views

/** The engine's buff instance as the buff views see it (matched by object identity, like 0x835788). */
export interface BuffInstLike { def: { name: string } }

export interface BuffUnit {
  id: number;
  team: number;
  buffs: readonly BuffInstLike[];
}

interface BuffView {
  unit: number;
  inst: BuffInstLike;
  /** sim ms of the frame the view was made in: the filter's t is the time since */
  t0: number;
  effect: number;
}

/**
 * Buff views of every unit (0x835788 / 0x8348c8 / 0x834e54): starts each new buff instance's Effect
 * on the unit and deletes it with the view; `filterTime` gives the filter clock of 0x82ebdc.
 */
export class BuffViews {
  private views = new Map<BuffInstLike, BuffView>();
  private battle: unknown = null;
  private readonly fx: EffectPlayer;
  private readonly manifest: Manifest;
  private readonly flip: boolean;

  constructor(fx: EffectPlayer, manifest: Manifest, flip: boolean) {
    this.fx = fx;
    this.manifest = manifest;
    this.flip = flip;
  }

  get size(): number { return this.views.size; }

  /**
   * Match the views to the units' buff instances at sim time `simMs`. `pos(u)` is the unit's drawn
   * position [x, y, z] (logic units) while its view lives, else null; units not listed lose their views.
   */
  sync(battle: unknown, units: readonly BuffUnit[], simMs: number, pos: (u: BuffUnit) => [number, number, number] | null): void {
    if (this.battle !== battle) { this.battle = battle; this.views.clear(); }
    const seen = new Set<BuffInstLike>();
    for (const u of units) {
      if (!u.buffs.length || !pos(u)) continue;
      for (const q of u.buffs) {
        seen.add(q);
        if (!this.views.has(q)) this.views.set(q, { unit: u.id, inst: q, t0: simMs, effect: this.startEffect(u, q, pos) });
      }
    }
    for (const [q, v] of this.views) {
      if (seen.has(q)) continue;
      if (v.effect) this.fx.remove(v.effect); // 0x834e54 → 0x82e160
      this.views.delete(q);
    }
  }

  /** ms since the buff instance's view was made (the filter's t before this frame's dt), or 0. */
  filterTime(q: BuffInstLike, simMs: number): number {
    const v = this.views.get(q);
    return v ? Math.max(0, simMs - v.t0) : 0;
  }

  /** 0x8348c8: Effect at the unit's sprite, parent the unit, not attached (follows with FollowParent). */
  private startEffect(u: BuffUnit, q: BuffInstLike, pos: (u: BuffUnit) => [number, number, number] | null): number {
    const b: BuffArt | undefined = this.manifest.buffs?.[q.def.name];
    const eff = b?.effect;
    const def = eff ? this.manifest.effects[eff] : undefined;
    const p = pos(u);
    if (!eff || !def || !p) return 0;
    const front = this.flip ? -5 : 5;
    const follow = def.FollowParent ? () => pos(u) : undefined;
    const es = (b?.effectScale as number | undefined) ?? 0;
    // EffectScale replaces the effect's Scale (0x82ccf8 sets effect +0x90)
    const scale = es ? (es * 0.01) / (def.Scale ? def.Scale * 0.01 : 1) : undefined;
    return this.fx.play(eff, p[0], p[1] + front, { team: u.team === 1 ? 1 : 0, z: p[2], follow, scale });
  }
}

// ---------------------------------------------------------------------------------- buff filter

/** Clip length the filter object takes for D = −1 (0x82ea34): (int)(frame time · (frames · 1000)), float32. */
export function filterClipLength(frames: number, fps: number): number {
  return Math.trunc(Math.fround(Math.fround(1 / (fps || 30)) * (frames * 1000)));
}

/**
 * 0x82ebdc: the frame of a buff filter clip `t` ms after its view was made, or null once a
 * non-looping filter is done. `dur` = D (the clip's length unless FilterInheritLifeDuration gave the
 * buff's time).
 */
export function filterFrame(t: number, frames: number, dur: number, loop: boolean): number | null {
  if (!loop) {
    if (dur <= t) return null;
  } else if (dur) {
    t %= dur;
  }
  const d = dur < 2 ? 1 : dur;
  const f = Math.trunc((t * frames) / d);
  if (f < 1) return 0;
  return Math.min(f, frames - 1);
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * 0x82ebdc's colour step: the filter clip's first child colour `f` multiplied into a sprite colour
 * `c` with the client's byte arithmetic (adds summed and capped, multipliers and alpha ×/255);
 * `keepAlpha` for crown towers (actor vt+0x170 = 1).
 */
export function applyFilterColor(c: Readonly<Col>, f: Readonly<Col>, keepAlpha = false): Col {
  let r = Math.round(c[4]) + Math.round(f[4]), g = Math.round(c[5]) + Math.round(f[5]), b = Math.round(c[6]) + Math.round(f[6]);
  if (r + g + b !== 0) { r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b); }
  const mul = (i: number) => Math.trunc((byte(c[i]) * byte(f[i])) / 255) / 255;
  return [mul(0), mul(1), mul(2), keepAlpha ? c[3] : mul(3), r, g, b];
}
