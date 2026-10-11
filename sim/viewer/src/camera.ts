// Maps game coordinates (units, +y toward the red side) to board pixels and back.
// The visible world rectangle can include arena surroundings (art margins).

export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Camera {
  /** CSS pixels per game unit. */
  scale = 1;
  /** Board pixel of game (0, 0). */
  ox = 0;
  oy = 0;
  width = 1;
  height = 1;
  dpr = 1;
  world: WorldRect = { x0: 0, y0: 0, x1: 18000, y1: 32000 };

  fit(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    const w = this.world.x1 - this.world.x0;
    const h = this.world.y1 - this.world.y0;
    this.scale = Math.min(width / w, height / h);
    const pw = w * this.scale;
    const ph = h * this.scale;
    const left = (width - pw) / 2;
    const top = (height - ph) / 2;
    // screen x = ox + x*scale ; screen y = oy - y*scale
    this.ox = left - this.world.x0 * this.scale;
    this.oy = top + this.world.y1 * this.scale;
  }

  sx(x: number): number {
    return this.ox + x * this.scale;
  }

  sy(y: number): number {
    return this.oy - y * this.scale;
  }

  gx(sx: number): number {
    return (sx - this.ox) / this.scale;
  }

  gy(sy: number): number {
    return (this.oy - sy) / this.scale;
  }
}
