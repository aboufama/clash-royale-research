// Maps game coordinates (units, +y toward the red side) to board pixels and back.
// With the original art the ground is foreshortened (arena tiles are 29.85 px wide but
// 24.2 px tall), so x and y scales differ: aspectY = scaleY / scaleX.

export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Camera {
  /** CSS pixels per game unit, horizontally and vertically. */
  scaleX = 1;
  scaleY = 1;
  /** Board pixel of game (0, 0). */
  ox = 0;
  oy = 0;
  width = 1;
  height = 1;
  dpr = 1;
  /** Vertical foreshortening (1 = square tiles). */
  aspectY = 1;
  world: WorldRect = { x0: 0, y0: 0, x1: 18000, y1: 32000 };

  /** Mean scale (for sizes that are not axis-specific). */
  get scale(): number {
    return (this.scaleX + this.scaleY) / 2;
  }

  fit(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    const w = this.world.x1 - this.world.x0;
    const h = (this.world.y1 - this.world.y0) * this.aspectY;
    const s = Math.min(width / w, height / h);
    this.scaleX = s;
    this.scaleY = s * this.aspectY;
    const pw = w * s;
    const ph = h * s;
    const left = (width - pw) / 2;
    const top = (height - ph) / 2;
    this.ox = left - this.world.x0 * this.scaleX;
    this.oy = top + this.world.y1 * this.scaleY;
  }

  sx(x: number): number {
    return this.ox + x * this.scaleX;
  }

  sy(y: number): number {
    return this.oy - y * this.scaleY;
  }

  gx(sx: number): number {
    return (sx - this.ox) / this.scaleX;
  }

  gy(sy: number): number {
    return (this.oy - sy) / this.scaleY;
  }
}
