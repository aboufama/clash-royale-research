// The client's projectile view, ported from libg 160402020 (visual only; never feeds the engine).
//
// View class vtable 0x188dd20: ctor 0x854598 (angle -1, scale factor 1), setup 0x8545e0, per-frame
// update vt+0x208 = 0x8554b0, layer vt+0x220 = 10 ('Object', 0xe22490), trail effect 0x8545e0 /
// 0x855b98, shadow 0x855304, HideWhenDelayed 0x855078. The logic height it reads is the projectile
// actor's z, written by Projectile_update 0xf90708 through the arc 0xf927ec (ported here too, because
// the engine does not store a projectile z yet).
//
// Per frame (0x8554b0), with (x, y) the projectile's logic position, (tx, ty) its homing target's
// position or its aim point (0xf8fc44 / 0xf8fc88), z / prevZ the logic height this tick / last tick:
//   angle  = atan2(ty − y, tx − x) · 57.297466 deg, updated only while (tx−x)² + (ty−y)² exceeds
//            MinimumLengthForVisualAngleCalculation² (pd+0x344, default 0), else the last value
//            (−1 before the first update); +180 in the flipped (blue) view (0x84f424)
//   dz     = (z − prevZ) · 0.002 (world units per tick)
//   height = prevZ · 0.002 + alpha · dz (+ |sin(dist / Speed · 0.4)| for BowlerProjectile only)
//   frame  = (not rolling, 0xe5a908) without use360Frames: ⌊n/2 + atan(dz) · n · 0.3501401⌋ clamped to
//            0..n−1 (the frames are the pitch); with use360Frames: the angle gets +90 (own side) or +270,
//            frame = ⌊n/360 · (atan2(dz, Speed · 0.002) deg + 270)⌋ mod n, mirrored (n−1−f) for the enemy;
//            rolling projectiles keep their clip playing on its own timeline
//   scale  = Scale/100 · (1 + clamp(height · 0.02, 0, 0.5)) on the sprite container (0x123c564),
//            the rotation on the clip inside it (0xd16728 → 0x123e8b4: [cos, sin, −sin, cos], degrees,
//            clockwise on screen), so the drawn matrix is [s·cos, s·sin, −s·sin, s·cos, px, py]
//   shadow = ShadowExportName (RedShadowExportName for the enemy) at (x, y, 0), rotated by the same
//            angle unless ShadowDisableRotate, unscaled, drawn into the shadow silhouette (0x856a40)
// The angle is taken in logic space, not on screen, so the arena's 0.8 foreshortening is ignored.

import { idiv, isqrt } from '../../../core/src/math.ts';
import type { ProjectileArt } from './manifest.ts';

/** Degrees per radian as the client writes it (0x8554b0). */
export const RAD2DEG = 57.297466;

/**
 * Logic arc height of a projectile, FUN_00f927ec(p, x, y): with T = max(|aim − start| / Speed, 1) and
 * t = |(x, y) − start| / Speed (integer ticks, Speed < 2 counts as 1),
 *   z = (aimZ − startZ) · t / T + startZ + (t − T) · t · ⌊Gravity · −500 / 1000⌋.
 * The aim is the homing target's position when the projectile homes on a live target, else its aim
 * point; aimZ is the target's z for homing projectiles (0xf91378) and 0 otherwise (ctor 0xf8d6e8).
 */
export function arcHeight(startX: number, startY: number, startZ: number, aimX: number, aimY: number, aimZ: number,
  x: number, y: number, speed: number, gravity: number): number {
  const sp = speed < 2 ? 1 : speed;
  let T = idiv(isqrt((aimX - startX) ** 2 + (aimY - startY) ** 2), sp);
  if (T < 2) T = 1;
  const t = idiv(isqrt((x - startX) ** 2 + (y - startY) ** 2), sp);
  const lin = idiv((aimZ - startZ) * t, T);
  return lin + startZ + (t - T) * t * idiv(gravity * -500, 1000);
}

/**
 * FUN_00e5a908: piercing/rolling projectiles (ProjectileRadius > 0 and a straight ranged flight,
 * CheckCollisions or Scatter mode 1). Their clip is not frame-stepped by pitch.
 */
export function isRolling(p: ProjectileArt): boolean {
  const pr = (p.projectileRadius as number | undefined) ?? 0;
  if (pr <= 0) return false;
  const homing = !!p.homing;
  const range = (p.projectileRange as number | undefined) ?? 0;
  if ((homing || range < 1) && !p.checkCollisions) return p.scatter === 'Circle';
  return true;
}

export interface ProjectileViewState {
  /** last angle in degrees (logic space), −1 before the first update (ctor 0x854598) */
  angle: number;
}

export function newProjectileViewState(): ProjectileViewState {
  return { angle: -1 };
}

export interface ProjectileViewInput {
  /** logic position this tick (not interpolated) and the target/aim point (0xf8fc44 / 0xf8fc88) */
  x: number; y: number;
  tx: number; ty: number;
  /** logic height this tick and last tick */
  z: number; prevZ: number;
  /** interpolation fraction 0..1 between the last tick and this one */
  alpha: number;
  /** distance (logic units) from the start point to the drawn position (BowlerProjectile bounce) */
  distFromStart?: number;
  /** true in the flipped (blue player's) view: angles turn by 180 degrees (0x84f424) */
  flip: boolean;
  /** true when the projectile belongs to the viewing player (0x84ddcc): blue export, +90 for 360 frames */
  own: boolean;
  /** the projectile's name (only "BowlerProjectile" bounces) */
  name?: string;
}

export interface ProjectileViewFrame {
  /** clip rotation in degrees, clockwise on screen */
  rotation: number;
  /** frame to show (gotoAndStop), or null when the clip runs on its own timeline (rolling) */
  frame: number | null;
  /** sprite container scale */
  scale: number;
  /** drawn height in world units (logic · 0.002) */
  height: number;
  /** shadow rotation in degrees (0 with ShadowDisableRotate) */
  shadowRotation: number;
}

/** One view update (0x8554b0). `frames` is the clip's frame count (+0xbe). Mutates `s.angle`. */
export function projectileView(p: ProjectileArt, frames: number, s: ProjectileViewState, i: ProjectileViewInput): ProjectileViewFrame {
  const speed = Math.max((p.speed as number | undefined) ?? 0, 0.1);
  const dzw = i.z * 0.002 - i.prevZ * 0.002;
  let bounce = 0;
  if (isRolling(p) && i.name === 'BowlerProjectile') bounce = Math.abs(Math.sin(((i.distFromStart ?? 0) / speed) * 0.4));
  const dx = i.tx - i.x, dy = i.ty - i.y;
  const minLen = (p.minimumLengthForVisualAngleCalculation as number | undefined) ?? 0;
  if (minLen * minLen < dx * dx + dy * dy) s.angle = Math.atan2(dy, dx) * RAD2DEG;
  const height = i.prevZ * 0.002 + i.alpha * dzw + bounce;
  let rot = i.flip ? s.angle + 180 : s.angle;
  let frame: number | null = null;
  const n = frames;
  if (!isRolling(p) && n > 0) {
    if (!p.use360Frames) {
      const f = Math.trunc(n / 2 + Math.atan(dzw) * n * 0.3501401);
      frame = f >= n - 1 ? n - 1 : f < 1 ? 0 : f;
    } else {
      rot += i.own ? 90 : 270;
      const pitch = Math.atan2(dzw, speed * 0.002) * RAD2DEG;
      const v = Math.trunc(n * 0.0027777778 * (pitch + 270));
      let f = v - Math.trunc(v / n) * n;
      if (!i.own) f = n - 1 - f;
      frame = f;
    }
  }
  const c = Math.min(0.5, Math.max(0, height * 0.02));
  const scale = (c * 0.01 + 0.01) * ((p.scale as number | undefined) ?? 100);
  return { rotation: rot, frame, scale, height, shadowRotation: p.shadowDisableRotate ? 0 : rot };
}

/** Matrix of the projectile sprite: container [s,0,0,s,px,py] times clip rot(deg). */
export function projectileMatrix(rotationDeg: number, scale: number, px: number, py: number): [number, number, number, number, number, number] {
  const a = rotationDeg * 0.017453292;
  const c = Math.cos(a), s = Math.sin(a);
  return [scale * c, scale * s, -scale * s, scale * c, px, py];
}
