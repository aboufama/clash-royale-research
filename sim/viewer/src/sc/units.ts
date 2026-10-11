// Unit / projectile sprite selection.
//
// Engine convention: +y points from the blue side (screen bottom) to the red side (screen top);
// angle 0 = +x (screen right), +pi/2 = toward red (screen up).
// Art convention: export suffix 1 faces screen up (away), the middle suffix faces screen right,
// suffix N faces screen down (toward the camera); N authored directions span 180 degrees and the
// left half is a horizontal mirror of 2..N-1 (N = 9 -> 16 directions, N = 18 -> 34).

import type { ActionArt, CharacterArt, ProjectileArt } from './manifest.ts';

export interface DirPick {
  dir: number; // 1..N
  mirror: boolean;
}

/** Nearest authored direction for an engine angle (radians). */
export function pickDirection(angleRad: number, nDirs: number): DirPick {
  // phi: 0 = screen up, pi/2 = right, pi = down; negative = left half
  let phi = Math.PI / 2 - angleRad;
  phi = Math.atan2(Math.sin(phi), Math.cos(phi)); // -pi..pi
  const mirror = phi < 0;
  const a = Math.abs(phi); // 0..pi
  const step = Math.PI / (nDirs - 1);
  const k = Math.round(a / step);
  const dir = Math.min(nDirs, Math.max(1, k + 1));
  return { dir, mirror: mirror && dir !== 1 && dir !== nDirs };
}

/** Convert an engine (tile-space) angle to the on-screen angle given the arena's y foreshortening. */
export function screenAngle(angleRad: number, yScale: number): number {
  return Math.atan2(Math.sin(angleRad) * yScale, Math.cos(angleRad));
}

export type ActionName = 'idle' | 'run' | 'attack' | 'deploy' | string;

export interface UnitSprite {
  export: string;
  frame: number;
  mirror: boolean;
  dir: number;
  action: string; // resolved action key, e.g. "attack1"
  frames: number;
  fps: number;
  /** true once a non-looping action has reached its last frame */
  done: boolean;
}

export function resolveAction(art: CharacterArt, team: 0 | 1, action: ActionName): [string, ActionArt] | null {
  const acts = (team === 1 && art.actionsRed) ? art.actionsRed : art.actions;
  const tryKeys = [action, `${action}1`];
  if (action === 'deploy' || action === 'walk') tryKeys.push(action === 'walk' ? 'run1' : 'idle1');
  tryKeys.push('idle1', 'run1');
  for (const k of tryKeys) if (acts[k]) return [k, acts[k]];
  const first = Object.keys(acts)[0];
  return first ? [first, acts[first]] : null;
}

/**
 * Pick export + frame for a unit.
 * @param timeMs time since the action started (looping actions wrap, `attack` clamps unless loop)
 */
export function unitSprite(art: CharacterArt, team: 0 | 1, action: ActionName, angleRad: number, timeMs: number,
  opts: { loop?: boolean; yScale?: number } = {}): UnitSprite | null {
  const r = resolveAction(art, team, action);
  if (!r) return null;
  const [key, a] = r;
  const ang = opts.yScale ? screenAngle(angleRad, opts.yScale) : angleRad;
  const { dir, mirror } = pickDirection(ang, a.dirs);
  const loop = opts.loop ?? !key.startsWith('attack');
  let frame = Math.floor((Math.max(0, timeMs) * a.fps) / 1000);
  let done = false;
  if (loop) frame %= a.frames;
  else if (frame >= a.frames - 1) {
    frame = a.frames - 1;
    done = true;
  }
  return { export: `${a.export}_${dir}`, frame, mirror, dir, action: key, frames: a.frames, fps: a.fps, done };
}

/** Milliseconds from the start of an action to its `action_frame` label (the hit), if any. */
export function actionFrameMs(art: CharacterArt, action = 'attack1', team: 0 | 1 = 0): number | null {
  const r = resolveAction(art, team, action);
  if (!r || r[1].actionFrame === undefined) return null;
  return (r[1].actionFrame * 1000) / r[1].fps;
}

export interface ProjectileSprite {
  export: string;
  frame: number;
  /** 2D rotation (radians, screen space, y down) to apply to the clip */
  rotation: number;
  mirror: boolean;
}

/**
 * Projectile clip frame + rotation from its velocity. vx, vy in engine units (+y toward red),
 * vz up. Clips with N > 1 frames are drawn facing screen right and their frames encode the
 * pitch toward/away from the camera (frame 0 = away, N-1 = toward); use360Frames clips encode a
 * full turn. This mapping is an approximation (see tools/art/README.md).
 */
export function projectileSprite(p: ProjectileArt, team: 0 | 1, vx: number, vy: number, vz: number,
  yScale = 0.81, zScale = 0.585): ProjectileSprite {
  const exp = (team === 1 && p.redExport) ? p.redExport : (p.export ?? '');
  const n = p.frames ?? 1;
  const sx = vx, sy = -(vy * yScale + vz * zScale); // screen-space velocity (y down)
  const rotation = Math.atan2(sy, sx);
  if (n <= 1) return { export: exp, frame: 0, rotation, mirror: false };
  const len = Math.hypot(vx, vy, vz) || 1;
  // component toward the camera: camera looks along +y (toward red) and down
  const toward = (-vy * zScale + vz * yScale) / len; // -1 away .. +1 toward
  if (p.use360Frames) {
    const ang = Math.atan2(sy, sx); // full turn
    const f = Math.round(((ang + Math.PI) / (2 * Math.PI)) * (n - 1));
    return { export: exp, frame: f, rotation: 0, mirror: false };
  }
  const f = Math.round(((toward + 1) / 2) * (n - 1));
  return { export: exp, frame: Math.min(n - 1, Math.max(0, f)), rotation, mirror: false };
}

/** Turret clip frame (36 frames over 180 degrees, up -> right -> down) and mirror for an aim angle. */
export function turretFrame(angleRad: number, frames = 36): { frame: number; mirror: boolean } {
  let phi = Math.PI / 2 - angleRad;
  phi = Math.atan2(Math.sin(phi), Math.cos(phi));
  const f = Math.round((Math.abs(phi) / Math.PI) * (frames - 1));
  return { frame: Math.min(frames - 1, f), mirror: phi < 0 };
}
