// Character and building view effects of libg 160402020 beyond the deploy, death, attack-start, shooter
// and footstep effects (art.ts, sc/unit_fx.ts): the damage entry's effect on the victim, the melee
// splash's effect at its centre, TargetedHitEffect beams, ShieldLostEffect, ChargeEffect,
// ContinuousEffect, the spawner's SpawnCharacterEffect, the Inferno beam / flame / level-transition
// slots and projectile chain beams (TargettedEffect). Visual only; driven by engine events and the
// per-frame view update. The coverage per card and field is in docs/EFFECTS.md.
//
// Effect play primitives (the manager 0x82dcb0; 0x82dc54 = it + setLoop(0), 0x82dedc = it + setLoop(1),
// both with p13 = 1): with a parent actor and p13 the effect starts at the parent view's sprite (x,
// y ∓ 0.01 world, z) whatever position is passed, and follows it when attached (p8) or when the effect
// has FollowParent; the enemy flag picks EnemyVersion (0x84ddcc: the view's actor is not the viewer's).
//   view vt+0x80 0x84e784: 0x82dcb0(actor, attach 0, p13 1): keeps the effect's own Loop.
//   view vt+0xc0 0x84f11c: 0x82dc54(actor): once.
//   view vt+0x90 0x84e8e0: 0x82dcb0(actor) + target 0x82d484 + offset vt+0x48 + update(1).
//   0x83fcc8 / 0x83b6d8: 0x82dedc(actor, attach 1): looping, attached.
//   world listener vt+0x48 0x850258: 0x82dc54 at a point, no parent, with an angle.
import type { Unit } from '../../../core/src/index.ts';
import { ST_DEAD, ST_DEPLOYING } from '../../../core/src/entities.ts';
import type { EffectPlayer, PlayOptions } from './effects.ts';
import type { AnimFrame } from './anim.ts';
import { nativeAngle } from './anim.ts';
import type { CharacterArt, ClipRef, Manifest } from './manifest.ts';
import type { ScLibrary } from './library.ts';

/** The global damage effect (Tables +0xec0, static name 0x1a5e498 "Damage": effect_Hit1). */
export const DAMAGE_EFFECT = 'Damage';

/** What CharEffects needs from the world renderer (art.ts). */
export interface CharFxHost {
  readonly fx: EffectPlayer;
  readonly manifest: Manifest;
  /** the blue player's 180°-turned view */
  readonly flip: boolean;
  lib(name: string): ScLibrary;
  /** a live actor's drawn sprite position [x, y, z] (logic units), null once its view is gone */
  spritePos(u: Unit): [number, number, number] | null;
  /** the actor's current direction sprite (sc/anim.ts), if it has one */
  sprite(u: Unit): AnimFrame | null | undefined;
  /** the location's water test at a logic point (0x11d9838; the river tiles) */
  isWater?(x: number, y: number): boolean;
  /** the tunnel of a SpawnPathfindSpeed summon ended (view vt+0x170 0x845a8c → vt+0x138(0)) */
  tunnelEnd?(u: Unit): void;
}

function towerEffects(m: Manifest, name: string): Record<string, string> | undefined {
  if (name === 'KingTower') return m.towers.king.effects as Record<string, string> | undefined;
  if (name === 'PrincessTower') return m.towers.princess.effects as Record<string, string> | undefined;
  return undefined;
}

/** DamageEffect(Special) of a character / building / crown tower (0xde0450(d, special)): special only when set. */
function ownDamageEffect(m: Manifest, name: string, special: boolean): string | undefined {
  const fx = m.characters[name]?.effects ?? towerEffects(m, name);
  if (!fx) return undefined;
  return (special && fx.damageEffectSpecial) || fx.damageEffect || undefined;
}

/** UseFallbackDamageEffect (CharacterData +0x138, default true): no own effect → "Damage". */
function withFallback(m: Manifest, name: string, eff: string | undefined): string | undefined {
  if (eff) return eff;
  const ca = m.characters[name] as (CharacterArt & { useFallbackDamageEffect?: boolean }) | undefined;
  return ca?.useFallbackDamageEffect === false ? undefined : DAMAGE_EFFECT;
}

/**
 * The effect a damage entry carries (engine event 'damage' fx kinds, BattleEvent.fx), played on the
 * victim by Health_applyHit 0xfcb29c (`if (entry +0x18) view vt+0xc0`):
 * 1 World_areaDamage 0xf97be8 → "Damage"; 2 / 3 single-target melee 0xfc7080 → the attacker's
 * DamageEffect / DamageEffectSpecial (charging), else "Damage"; 4 projectile (0xf8f618 / 0xf8ff74, the
 * projectile's +0x190 from 0xfc619c: the shooter's DamageEffect, else "Damage"; spells 0xf9f47c and
 * spawned projectiles 0xf9188c: "Damage"); 5 buff damage over time 0xf86668 → BuffData +0x248 HitEffect,
 * else "Damage"; 0 none (area-effect pulses 0xfd068c pass no effect).
 */
export function damageEffectName(m: Manifest, fx: number, src: string): string | undefined {
  switch (fx) {
    case 1: return DAMAGE_EFFECT;
    case 2: case 3: return withFallback(m, src, ownDamageEffect(m, src, fx === 3));
    case 4: return src ? withFallback(m, src, ownDamageEffect(m, src, false)) : DAMAGE_EFFECT;
    case 5: return (m.buffs?.[src] as { hitEffect?: string } | undefined)?.hitEffect || DAMAGE_EFFECT;
    default: return undefined;
  }
}

/**
 * Centre of a named child of a clip frame in the clip's space (SC px): the child's matrix applied to
 * its own frame-0 bounds' centre (0x84eb7c: bounds + child x / y; the child's scale is applied too, A).
 */
export function childCenter(lib: ScLibrary, exp: string, frame: number, name: string): [number, number] | null {
  const clip = lib.clip(exp);
  if (!clip || !clip.names) return null;
  const f = Math.max(0, Math.min(clip.frameCount - 1, frame));
  const bm = lib.banks[clip.bank].m;
  for (let i = clip.frameStart[f]; i < clip.frameStart[f + 1]; i++) {
    const ci = clip.elements[i * 3];
    if (clip.names[ci] !== name) continue;
    const mi = clip.elements[i * 3 + 1];
    const m = mi >= 0 ? bm.subarray(mi * 6, mi * 6 + 6) : [1, 0, 0, 1, 0, 0];
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    accBounds(lib, clip.children[ci], [1, 0, 0, 1, 0, 0], b, 0);
    const cx = b[0] <= b[2] ? (b[0] + b[2]) / 2 : 0, cy = b[0] <= b[2] ? (b[1] + b[3]) / 2 : 0;
    return [m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]];
  }
  return null;
}

/** Bounds of a shape / clip (its frame 0) through `m` (as ScLibrary.frameBounds). */
function accBounds(lib: ScLibrary, id: number, m: number[], b: number[], depth: number): void {
  if (depth > 16) return;
  const shape = lib.shapes.get(id);
  if (shape) {
    for (const cmd of shape) {
      const v = cmd.verts;
      for (let i = 0; i < v.length; i += 4) {
        const x = m[0] * v[i] + m[2] * v[i + 1] + m[4], y = m[1] * v[i] + m[3] * v[i + 1] + m[5];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
    return;
  }
  const clip = lib.clips.get(id);
  if (!clip || clip.frameCount < 1) return;
  const bm = lib.banks[clip.bank].m;
  for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
    const ci = clip.elements[i * 3], mi = clip.elements[i * 3 + 1];
    const c = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
    accBounds(lib, clip.children[ci], [
      m[0] * c[0] + m[2] * c[1], m[1] * c[0] + m[3] * c[1], m[0] * c[2] + m[2] * c[3], m[1] * c[2] + m[3] * c[3],
      m[0] * c[4] + m[2] * c[5] + m[4], m[1] * c[4] + m[3] * c[5] + m[5],
    ], b, depth + 1);
  }
}

/** One Inferno view slot (0x846438(view, i): handle +4, effect +8). */
interface Slot { eff: string | undefined; target: number; handle: number }

/** Inferno level entries (CharacterData +0x2a8, loader 0xdde618): per level its TargettedDamageEffect,
 * DamageLevelTransitionEffect and FlameEffect (level 0 carries "12", level 1 "23", level 2 none). */
function infernoEntry(ca: CharacterArt, lvl: number): { beam?: string; trans?: string; flame?: string } {
  const e = ca.effects ?? {};
  return {
    beam: e[`targettedDamageEffect${lvl + 1}`],
    trans: lvl === 0 ? e.damageLevelTransitionEffect12 : lvl === 1 ? e.damageLevelTransitionEffect23 : undefined,
    flame: e[`flameEffect${lvl + 1}`],
  };
}

/** Engine Inferno ramp → level index (battle.ts execute: VariableDamageTime1 / 2; D). */
export function infernoLevel(u: { rampMs: number; def: { variableDamageTime: [number, number] } }): number {
  const [t1, t2] = u.def.variableDamageTime;
  return u.rampMs < t1 ? 0 : u.rampMs < t1 + t2 ? 1 : 2;
}

/**
 * A death spawn's deploy filter: 0xf83990 puts the dying character's DeathSpawnDeployBaseAnim (+0x288)
 * in the spawn request, else its DeployBaseAnimExportName (0xde1298 -> +0x5b0); 0xf8aac8 gives the new
 * view vt+0x140 (0x846e6c) the spawned character's SpawnDeployBaseAnim (+0x278) if set, else that
 * request clip. vt+0x140 does nothing unless the new actor is in state 4 (or 8), so only members that
 * deploy (a request deploy time, or 0 HP: BattleRam's Barbarians, Balloon / Giant Skeleton bombs) show
 * it. Null: none.
 */
export function deathSpawnFilter(m: Manifest, spawned: string, dying: string): ClipRef | null {
  const own = m.characters[spawned];
  const src = m.characters[dying];
  return own?.spawnDeployBaseAnim ?? src?.deathSpawnDeployBaseAnim ?? src?.deployBaseAnimExportName ?? null;
}

export class CharEffects {
  private readonly h: CharFxHost;
  /** ContinuousEffect handles per actor (0x83fcc8 from the view ctor 0x836e58) */
  private continuous = new Map<number, number>();
  /** previous action per view (+0x4d4) for the charge transition */
  private prevAction = new Map<number, number>();
  /** Inferno slots per view: 0 beam, 1 transition, 2 flame */
  private inferno = new Map<number, [Slot, Slot, Slot]>();
  /** this tick's primary target and next pivot index per attacker (TargetedHitEffect of extra targets) */
  private hitTargets = new Map<number, { tick: number; target: number; next: number }>();
  /** tunnel effect per tunnelling actor (view +0x9b0 handle, +0x9b4 water flag) */
  private tunnels = new Map<number, { water: boolean; handle: number }>();
  /** chain-beam source per projectile (+0x174..+0x180, Projectile_setup 0xf8e6fc / 0xf8f618) */
  private chainFrom = new Map<number, { x: number; y: number; z: number; parent: Unit | null }>();

  constructor(host: CharFxHost) {
    this.h = host;
  }

  /** A new battle: actor ids restart. */
  reset(): void {
    this.continuous.clear();
    this.prevAction.clear();
    for (const s of this.inferno.values()) for (const q of s) if (q.handle) this.h.fx.remove(q.handle);
    this.inferno.clear();
    this.hitTargets.clear();
    this.chainFrom.clear();
    this.tunnels.clear();
  }

  private art(u: Unit): CharacterArt | undefined {
    return this.h.manifest.characters[u.def.name];
  }

  private followOf(u: Unit, eff: string): PlayOptions['follow'] {
    return this.h.manifest.effects[eff]?.FollowParent ? () => this.h.spritePos(u) : undefined;
  }

  /** 0.01 world = 5 logic units in front of the parent (0x82b7ac), −0.01 under the flip */
  private get front(): number { return this.h.flip ? -5 : 5; }

  /** view vt+0xc0 0x84f11c: once, at the actor's sprite, following it with FollowParent. */
  playOnActor(u: Unit, eff: string | undefined, angle?: number): number {
    const fx = this.h.fx;
    if (!eff || !fx.has(eff)) return 0;
    return fx.play(eff, u.x, u.y + this.front, {
      team: u.team as 0 | 1, z: u.z, angle, loop: false, follow: this.followOf(u, eff), filterParent: u.id,
    });
  }

  /** 0x82dedc(actor, attach 1): looping, attached to the actor's sprite. */
  private playAttachedLoop(u: Unit, eff: string, extra: PlayOptions = {}): number {
    const fx = this.h.fx;
    if (!fx.has(eff)) return 0;
    return fx.play(eff, u.x, u.y + this.front, {
      team: u.team as 0 | 1, z: u.z, loop: true, follow: () => this.h.spritePos(u), filterParent: u.id, ...extra,
    });
  }

  // ------------------------------------------------------------------------------------- pivots

  /**
   * 0x84eb7c(view, index, centerFirst): the position of the view sprite's attack pivot child, scaled
   * by the sprite's scale; without centerFirst only attack_pivot_<index+1> (index −1 → 1); with it
   * attack_pivot_center, then attack_pivot, then attack_pivot_1. The x of a non-centre pivot ignores
   * the mirror (|scale x|).
   */
  pivot(u: Unit, index: number, centerFirst: boolean): [number, number] | null {
    const ca = this.art(u);
    const sp = this.h.sprite(u);
    if (!ca || !sp) return null;
    const lib = this.h.lib(ca.sc);
    const s = ca.scale / 100;
    const sx = sp.mirror ? -s : s;
    const names = centerFirst ? ['attack_pivot_center', 'attack_pivot', 'attack_pivot_1'] : [`attack_pivot_${index === -1 ? 1 : index + 1}`];
    for (let k = 0; k < names.length; k++) {
      const c = childCenter(lib, sp.export, sp.frame, names[k]);
      if (!c) continue;
      const center = centerFirst && k === 0;
      return [(center ? sx : Math.abs(sx)) * c[0], s * c[1]];
    }
    return null;
  }

  /** The beam end's pivot on the target (0x82a994: not while jumping, negated under the turned view). */
  private targetPivot(t: Unit): [number, number] | null {
    if (t.jumping) return null;
    const p = this.pivot(t, -1, true);
    return p && this.h.flip ? [-p[0], -p[1]] : p;
  }

  /** The beam's target point: the actor's x, y and z + vt+0xa8 (0xf829ec: 2 × CollisionRadius). */
  private targetPoint(t: Unit): () => [number, number, number] | null {
    return () => (t.state !== ST_DEAD ? [t.x, t.y, t.z + 2 * t.radius] : null);
  }

  /**
   * View vt+0x90 0x84e8e0 (TargetedHitEffect from AttackComp_execute 0xfc619c and, for the extra
   * targets, AttackComp_update 0xfc8fc8): the effect starts at the attacker's sprite, offset by the
   * sprite's attack_pivot_<index+1> or else (0, TargetEffectY); its beam SWFs reach the target.
   */
  playTargeted(a: Unit, t: Unit, eff: string | undefined, index: number): number {
    const fx = this.h.fx;
    if (!eff || !fx.has(eff)) return 0;
    const ca = this.art(a);
    const ty = (ca as { targetEffectY?: number } | undefined)?.targetEffectY ?? 0;
    const offset = this.pivot(a, index, false) ?? [0, ty];
    return fx.play(eff, a.x, a.y + this.front, {
      team: a.team as 0 | 1, z: a.z, follow: this.followOf(a, eff), filterParent: a.id,
      target: this.targetPoint(t), targetPivot: () => this.targetPivot(t), offset,
    });
  }

  // ------------------------------------------------------------------------------------- events

  /** Engine 'hit' / 'shoot' (AttackComp_execute 0xfc619c), after the attacker's state of this step. */
  onAttack(tick: number, a: Unit | undefined, t: Unit | undefined, melee: boolean, special: boolean, x: number, y: number): void {
    if (!a) return;
    const ca = this.art(a);
    if (t) {
      this.hitTargets.set(a.id, { tick, target: t.id, next: 1 });
      // TargetedHitEffect(special) via view vt+0x90 (0xfc64e8); special attacks are not in the engine
      this.playTargeted(a, t, ca?.effects?.targetedHitEffect, -1);
    }
    // melee splash (0xfc7080 → World_areaDamage, then world listener vt+0x48 at the centre): the
    // attacker's DamageEffect(Special) (else "Damage") at the target snapshot (or the attacker with
    // SelfAsAoeCenter), z = snapshot z (attack +0x70) / the attacker's, the attacker's facing angle
    if (melee && a.def.areaDamageRadius > 0) {
      const eff = withFallback(this.h.manifest, a.def.name, ownDamageEffect(this.h.manifest, a.def.name, special));
      const self = a.def.selfAsAoeCenter;
      const fx = this.h.fx;
      if (eff && fx.has(eff)) {
        fx.play(eff, self ? a.x : x, self ? a.y : y, {
          team: a.team as 0 | 1, z: self ? a.z : t ? t.z : 0, angle: nativeAngle(a.dirX, a.dirY), loop: false,
        });
      }
    }
  }

  /**
   * Engine 'damage' (Health_applyHit 0xfcb29c): the entry's effect on the victim's view (vt+0xc0). An
   * Electro Wizard's extra targets also get its TargetedHitEffect (0xfc8fc8, pivot index 1, 2, ...).
   */
  onDamage(tick: number, victim: Unit | undefined, kind: number, src: string, srcUnit: Unit | undefined): void {
    if (!victim) return;
    this.playOnActor(victim, damageEffectName(this.h.manifest, kind, src));
    if (kind === 2 && srcUnit && srcUnit.def.multipleTargets > 1) {
      const h = this.hitTargets.get(srcUnit.id);
      if (h && h.tick === tick && h.target !== victim.id) {
        this.playTargeted(srcUnit, victim, this.art(srcUnit)?.effects?.targetedHitEffect, h.next++);
      }
    }
  }

  /** Engine 'shieldLost' (0xfcb29c → 0xf85730 → view vt+0x110 0x846850): ShieldLostEffect via vt+0xc0. */
  onShieldLost(u: Unit | undefined): void {
    if (u) this.playOnActor(u, this.art(u)?.effects?.shieldLostEffect);
  }

  /**
   * The spawn effect of an actor a spawner or a dying character created (0xf8aac8 → 0xd35ab4 param 6):
   * the source character's SpawnCharacterEffect (data +0x208, 0xde0738) when set, else the new
   * actor's SpawnEffect (0xde048c).
   */
  spawnEffectFor(name: string, src: Unit | undefined): string | undefined {
    const own = this.h.manifest.characters[name]?.effects?.spawnEffect;
    if (!src) return own;
    return this.art(src)?.effects?.spawnCharacterEffect || own;
  }

  /** A projectile appeared (Projectile_setup 0xf8e6fc: +0x174..+0x17c = its start, +0x180 = the shooter). */
  onProjectile(id: number, x: number, y: number, z: number, shooter: Unit | null): void {
    if (!this.chainFrom.has(id)) this.chainFrom.set(id, { x, y, z, parent: shooter });
  }

  /**
   * Engine 'impact' of a single-target projectile with a TargettedEffect (0xf8f618, DragBackSpeed < 1):
   * the projectile view's vt+0xa8 0x84ef20 plays it from the previous hit position (+0x174..+0x17c; the
   * start with the shooter as parent for the first hit, so it starts at the shooter's sprite with the
   * shooter's projectile pivot 0x846ab4) to the target's x, y, z as a fixed point, then the target
   * becomes the next hop's source.
   */
  onChainHit(id: number, eff: string | undefined, team: number, t: Unit | undefined): void {
    const from = this.chainFrom.get(id);
    if (!t) return;
    this.chainFrom.set(id, { x: t.x, y: t.y, z: t.z, parent: null });
    const fx = this.h.fx;
    if (!from || !eff || !fx.has(eff)) return;
    const opts: PlayOptions = { team: team as 0 | 1, z: from.z, targetPoint: [t.x, t.y, t.z] };
    const p = from.parent;
    if (p && p.state !== ST_DEAD) {
      // p13 = 1 with a parent: the shooter's sprite position, following it with FollowParent
      opts.follow = this.followOf(p, eff);
      if (!opts.follow) {
        const sp = this.h.spritePos(p);
        if (sp) { from.x = sp[0]; from.y = sp[1]; opts.z = sp[2]; }
      }
      const pv = this.pivot(p, -1, false);
      if (pv) opts.offset = pv;
    }
    fx.play(eff, from.x, from.y + (p ? this.front : 0), opts);
  }

  /** A projectile view is gone. */
  dropProjectile(id: number): void {
    this.chainFrom.delete(id);
  }

  /** Forget the chain sources of projectiles that left the world (also those without a view). */
  pruneProjectiles(live: readonly { id: number }[]): void {
    if (!this.chainFrom.size) return;
    const ids = new Set(live.map((p) => p.id));
    for (const id of [...this.chainFrom.keys()]) if (!ids.has(id)) this.chainFrom.delete(id);
  }

  // ------------------------------------------------------------------------------------- per frame

  /**
   * The character view update's effect parts for one animated actor (0x840d44): ChargeEffect when the
   * walk branch switches to the charge clip (action 3) while the charge (movement +0x1e0) is ≥ 10000
   * and the previous action (+0x4d4) was not 3: a non-looping effect through vt+0xc0, a looping one
   * attached (0x82dcb0 attach 1, never stopped by the view).
   */
  viewUpdate(u: Unit, af: AnimFrame | null | undefined): void {
    if (!af) return;
    const prev = this.prevAction.get(u.id);
    this.prevAction.set(u.id, af.action);
    if (af.action !== 3 || prev === 3 || u.charge < 10000) return;
    const eff = this.art(u)?.effects?.chargeEffect;
    if (!eff) return;
    const def = this.h.manifest.effects[eff];
    if (!def) return;
    if (!def.Loop) this.playOnActor(u, eff);
    else this.h.fx.play(eff, u.x, u.y + this.front, { team: u.team as 0 | 1, z: u.z, follow: () => this.h.spritePos(u), filterParent: u.id });
  }

  /**
   * Once per frame for every live actor: ContinuousEffect from the view's creation (0x836e58 →
   * 0x83fcc8; looping and attached, so it stops when the actor's view goes, 0x82d300) and the Inferno
   * slots of 0x83b6d8 (view update 0x839b08 outside states 4 and 11).
   */
  update(units: readonly Unit[], filterParents?: (id: number) => void): void {
    const live = new Set<number>();
    for (const u of units) {
      if (u.state === ST_DEAD) continue;
      live.add(u.id);
      const ca = this.art(u);
      if (!ca) continue;
      const ce = ca.effects?.continuousEffect;
      if (ce && !this.continuous.has(u.id)) this.continuous.set(u.id, this.playAttachedLoop(u, ce));
      if (u.def.variableDamage && ca.effects?.targettedDamageEffect1) this.updateInferno(u, ca);
      if (u.tunneling) this.updateTunnel(u, ca);
      else if (this.tunnels.has(u.id)) this.endTunnel(u);
      filterParents?.(u.id);
    }
    for (const id of [...this.tunnels.keys()]) if (!live.has(id)) this.tunnels.delete(id);
    for (const id of [...this.continuous.keys()]) if (!live.has(id)) this.continuous.delete(id);
    for (const id of [...this.prevAction.keys()]) if (!live.has(id)) this.prevAction.delete(id);
    for (const [id, s] of this.inferno) {
      if (live.has(id)) continue;
      for (const q of s) if (q.handle) this.h.fx.remove(q.handle);
      this.inferno.delete(id);
    }
  }

  /**
   * The tunnel view of a SpawnPathfindSpeed summon (Deploy_summon 0xd423bc → view vt+0x168 0x84593c →
   * 0x845944(view, 1)): SpawnPathfindEffect, or its "_water" variant (data +0x218, loader 0xdde618) over
   * water (0x11d9838 at the actor), via 0x82dcb0 on the actor (its sprite position, enemy version) and
   * then made to follow it (0x82cce0(1)); every view update (0x839b08 → 0x83c194) a change of the water
   * flag stops it (0x82e4a4) and starts the other variant (no build's Miner has one: nothing over the
   * river). The tunnel's end (vt+0x170 0x845a8c) stops it and gives the view vt+0x138(0).
   */
  private updateTunnel(u: Unit, ca: CharacterArt): void {
    const water = this.h.isWater ? this.h.isWater(u.x, u.y) : false;
    const t = this.tunnels.get(u.id);
    if (t && t.water === water) return;
    if (t?.handle) this.h.fx.stop(t.handle);
    const eff = water ? ca.effects?.spawnPathfindEffect_water : ca.effects?.spawnPathfindEffect;
    let handle = 0;
    const fx = this.h.fx;
    if (eff && fx.has(eff)) {
      handle = fx.play(eff, u.x, u.y + this.front, { team: u.team as 0 | 1, z: u.z, follow: () => this.h.spritePos(u), filterParent: u.id });
    }
    this.tunnels.set(u.id, { water, handle });
  }

  private endTunnel(u: Unit): void {
    const t = this.tunnels.get(u.id);
    this.tunnels.delete(u.id);
    if (t?.handle) this.h.fx.stop(t.handle);
    this.h.tunnelEnd?.(u);
  }

  /**
   * 0x83b6d8 (attack-sequence data, attack component present): with the attack timer (+0x24) > 0 the
   * level entry of the view's attack sequence index (+0x4cc) gives the beam (slot 0:
   * TargettedDamageEffect), the level transition (slot 1) and the flame (slot 2); otherwise all are
   * null. A slot whose effect differs from the running one deletes it (0x82e160) and, when there is a
   * target (and an effect), starts the new one with 0x82dedc on the actor; the beam and the flame get
   * the target (0x82d484) and the offset (0, TargetEffectY) (vt+0x48). The level is the engine's ramp
   * level (the view's +0x4cc follows the attack sequence index at the attack clip's cycle, A), and a new
   * target restarts the beam and flame (A: the client keeps the slot when the effect is unchanged).
   */
  private updateInferno(u: Unit, ca: CharacterArt): void {
    let s = this.inferno.get(u.id);
    if (!s) {
      s = [{ eff: undefined, target: -1, handle: 0 }, { eff: undefined, target: -1, handle: 0 }, { eff: undefined, target: -1, handle: 0 }];
      this.inferno.set(u.id, s);
    }
    const active = u.state !== ST_DEPLOYING && u.waitTicks <= 0;
    if (!active) return;
    const t = u.target && u.target.state !== ST_DEAD ? u.target : null;
    const attacking = u.atkTimer > 0;
    const lvl = infernoLevel(u);
    const e = attacking ? infernoEntry(ca, lvl) : {};
    const ty = (ca as { targetEffectY?: number }).targetEffectY ?? 0;
    const want: [string | undefined, string | undefined, string | undefined] = [e.beam, e.trans, e.flame];
    const fx = this.h.fx;
    for (let i = 0; i < 3; i++) {
      const q = s[i];
      const targeted = i !== 1;
      const tid = targeted && t ? t.id : -1;
      if (want[i] === q.eff && (!targeted || tid === q.target)) continue;
      if (q.handle) { fx.remove(q.handle); q.handle = 0; }
      q.eff = undefined;
      q.target = -1;
      // slot 1 (transition) starts without a target; slots 0 and 2 need one (0x83b6d8: local_68 != 0)
      if (!want[i] || (targeted && !t)) {
        if (!targeted) q.eff = want[i];
        continue;
      }
      const extra: PlayOptions = targeted && t
        ? { target: this.targetPoint(t), targetPivot: () => this.targetPivot(t), offset: [0, ty] } : {};
      q.handle = this.playAttachedLoop(u, want[i]!, extra);
      q.eff = want[i];
      q.target = tid;
    }
  }
}
