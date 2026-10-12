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
  /** Draw logic x right-to-left (the blue player's native view is the red view turned 180 degrees). */
  mirrorX = false;
  world: WorldRect = { x0: 0, y0: 0, x1: 18000, y1: 32000 };
  /** Explicit game -> board mapping (screen = a * game + b per axis), set by the art renderer to
   * the client's stage framing (sc/ui_port.ts stageLayout); null = fit `world` to the board. */
  affine: { ax: number; bx: number; ay: number; by: number } | null = null;

  /** Use an explicit affine mapping (keeps scaleX/scaleY as the per-axis magnitudes). */
  setAffine(ax: number, bx: number, ay: number, by: number): void {
    this.affine = { ax, bx, ay, by };
    this.scaleX = Math.abs(ax);
    this.scaleY = Math.abs(ay);
  }

  /** Mean scale (for sizes that are not axis-specific). */
  get scale(): number {
    return (this.scaleX + this.scaleY) / 2;
  }

  fit(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.affine) return;
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
    if (this.affine) return this.affine.ax * x + this.affine.bx;
    return this.ox + this.mx(x) * this.scaleX;
  }

  private mx(x: number): number {
    return this.mirrorX ? this.world.x0 + this.world.x1 - x : x;
  }

  sy(y: number): number {
    if (this.affine) return this.affine.ay * y + this.affine.by;
    return this.oy - y * this.scaleY;
  }

  gx(sx: number): number {
    if (this.affine) return (sx - this.affine.bx) / this.affine.ax;
    return this.mx((sx - this.ox) / this.scaleX);
  }

  gy(sy: number): number {
    if (this.affine) return (sy - this.affine.by) / this.affine.ay;
    return (this.oy - sy) / this.scaleY;
  }
}
