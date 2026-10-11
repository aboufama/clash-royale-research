// Placeholder world renderer (Canvas 2D shapes). Used only when the baked original art
// is missing; the art renderer (art.ts) replaces it.
import { ARENA_H, ARENA_W, CELL, GRID_H, GRID_W, ST_DEAD, TOWER_NONE } from '../../core/src/index.ts';
import type { Frame, WorldRenderer } from './frame.ts';

export class PlaceholderRenderer implements WorldRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  draw(f: Frame): void {
    const c = this.ctx;
    const cam = f.cam;
    const b = f.battle;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#0d1a10';
    c.fillRect(0, 0, cam.width, cam.height);
    const flags = b.arena.flags;
    const sw = CELL * cam.scaleX;
    const sh = CELL * cam.scaleY;
    for (let cy = 0; cy < GRID_H; cy++) {
      for (let cx = 0; cx < GRID_W; cx++) {
        const fl = flags[cy * GRID_W + cx];
        const tile = ((cx >> 1) + (cy >> 1)) & 1;
        c.fillStyle = fl & 32 ? '#2f7fd6' : fl & 16 ? '#3d4a35' : fl & 3 ? (tile ? '#c9a46a' : '#d2ae75') : tile ? '#79b84a' : '#83c254';
        c.fillRect(cam.sx(cx * CELL), cam.sy((cy + 1) * CELL), sw + 0.5, sh + 0.5);
      }
    }
    c.strokeStyle = 'rgba(0,0,0,.25)';
    c.strokeRect(Math.min(cam.sx(0), cam.sx(ARENA_W)), cam.sy(ARENA_H), ARENA_W * cam.scaleX, ARENA_H * cam.scaleY);

    // ground units, then air
    for (const air of [false, true]) {
      for (const u of b.units) {
        if (u.isAir !== air) continue;
        const x = cam.sx(f.ux(u));
        const y = cam.sy(f.uy(u));
        const r = Math.max(3, u.radius * cam.scale);
        const dead = u.state === ST_DEAD;
        if (u.tower !== TOWER_NONE) {
          c.fillStyle = dead ? '#555' : u.team === 0 ? '#2d5fb8' : '#b83030';
          c.fillRect(x - r, y - r, 2 * r, 2 * r);
          c.strokeStyle = '#000';
          c.strokeRect(x - r, y - r, 2 * r, 2 * r);
          continue;
        }
        if (air) {
          c.fillStyle = 'rgba(0,0,0,.25)';
          c.beginPath();
          c.ellipse(x, y + 4, r, r * 0.6, 0, 0, Math.PI * 2);
          c.fill();
        }
        const oy = air ? -u.def.flyingHeight * cam.scale * 0.35 : 0;
        c.globalAlpha = u.state === 0 ? 0.5 : 1;
        c.fillStyle = u.team === 0 ? '#4a8dff' : '#ff5a5a';
        c.beginPath();
        c.arc(x, y + oy, r, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#000';
        c.stroke();
        const len = Math.hypot(u.dirX, u.dirY) || 1;
        c.beginPath();
        c.moveTo(x, y + oy);
        c.lineTo(x + (u.dirX / len) * r, y + oy - (u.dirY / len) * r);
        c.stroke();
        c.globalAlpha = 1;
        c.fillStyle = '#fff';
        c.font = `${Math.max(8, r * 0.8)}px sans-serif`;
        c.textAlign = 'center';
        c.fillText(u.def.name.slice(0, 4), x, y + oy + 3);
      }
    }
    for (const p of b.projectiles) {
      const x = cam.sx(f.px(p));
      const y = cam.sy(f.py(p));
      c.fillStyle = p.spell ? '#ffb000' : '#fff8b0';
      c.beginPath();
      c.arc(x, y, p.spell ? 6 : 3, 0, Math.PI * 2);
      c.fill();
    }
  }
}
