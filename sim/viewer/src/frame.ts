// Per-render-frame view of the battle shared by the world renderers and the overlay.
import type { Battle, Projectile, Unit } from '../../core/src/index.ts';
import type { Camera } from './camera.ts';

export interface DragPreview {
  team: number;
  card: string;
  /** game position (raw, unsnapped) */
  x: number;
  y: number;
  /** snapped position or null if illegal */
  snapped: { x: number; y: number } | null;
  radius: number;
  isSpell: boolean;
}

export class Frame {
  battle!: Battle;
  cam!: Camera;
  /** 0..1 progress from the previous tick to the current one (interpolation). */
  alpha = 0;
  /** wall-clock ms (animations) */
  now = 0;
  /** Simulation time in ms including the interpolation fraction. */
  simMs = 0;
  prevPos = new Map<number, number>(); // id -> packed x*65536+y (both < 65536)
  /** Tick-start attack timer and walk clock per unit (the client's +0x34 / movement +0x210 snapshots). */
  prevAtk = new Map<number, number>();
  prevWalk = new Map<number, number>();
  /** Tick-start actor z per unit (the actor's +0x90 snapshot, 0xf95ac4). */
  prevZ = new Map<number, number>();
  drag: DragPreview | null = null;

  /** Interpolated unit position. */
  ux(u: Unit): number {
    const p = this.prevPos.get(u.id);
    if (p === undefined) return u.x;
    const px = Math.floor(p / 65536);
    return px + (u.x - px) * this.alpha;
  }

  uy(u: Unit): number {
    const p = this.prevPos.get(u.id);
    if (p === undefined) return u.y;
    const py = p % 65536;
    return py + (u.y - py) * this.alpha;
  }

  /**
   * Interpolated actor z as the character view takes it (0x84d738): the view's getPrevZ / getZ
   * (0x84f630 -> 0xf95b54, 0x84f618 -> 0xf942a8) give the tick-start and current actor z, kept as is
   * when equal, else (int)((1 − alpha)·prev + alpha·z), truncated toward zero.
   */
  uz(u: Unit): number {
    const p = this.prevZ.get(u.id);
    if (p === undefined || p === u.z) return u.z;
    return Math.trunc((1 - this.alpha) * p + this.alpha * u.z);
  }

  px(p: Projectile): number {
    const q = this.prevPos.get(p.id);
    if (q === undefined) return p.x;
    const qx = Math.floor(q / 65536);
    return qx + (p.x - qx) * this.alpha;
  }

  py(p: Projectile): number {
    const q = this.prevPos.get(p.id);
    if (q === undefined) return p.y;
    const qy = q % 65536;
    return qy + (p.y - qy) * this.alpha;
  }

  /** Record positions before stepping (call once per engine tick). */
  snapshot(b: Battle): void {
    this.prevPos.clear();
    this.prevAtk.clear();
    this.prevWalk.clear();
    this.prevZ.clear();
    for (const u of b.units) {
      this.prevPos.set(u.id, u.x * 65536 + u.y);
      this.prevZ.set(u.id, u.z);
      this.prevAtk.set(u.id, u.atkTimer);
      this.prevWalk.set(u.id, u.walkMs);
    }
    for (const p of b.projectiles) this.prevPos.set(p.id, p.x * 65536 + p.y);
  }
}

export interface WorldRenderer {
  resize(width: number, height: number, dpr: number): void;
  draw(f: Frame): void;
  /** Notify of engine events (effects). */
  onEvents?(f: Frame): void;
}
