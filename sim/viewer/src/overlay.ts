// 2D overlay drawn above the world: HP bars, deploy timers, pending plays, clock, crowns,
// and the drag/placement preview with the legal deploy zone.
import { ARENA_H, ARENA_W, ST_DEAD, ST_DEPLOYING, TOWER_KING, TOWER_NONE, type Battle } from '../../core/src/index.ts';
import type { Frame } from './frame.ts';

const BLUE = '#3f8cff';
const RED = '#ff4a4a';

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;
  /** Original art active: health bars and deploy drops are drawn by the art renderer. */
  artMode = false;

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
    c.clearRect(0, 0, cam.width, cam.height);
    if (f.drag) this.drawDeployZone(f, b);

    // pending plays: the game shows a placement marker until the card lands
    for (const cmd of b.commands) {
      const x = cam.sx(cmd.x);
      const y = cam.sy(cmd.y);
      const left = Math.max(0, 20 - (b.tick - cmd.submitTick));
      c.globalAlpha = 0.85;
      c.strokeStyle = cmd.team === 0 ? BLUE : RED;
      c.lineWidth = 2;
      const r = cmd.card.type === 'spell' ? Math.max(cmd.card.spellRadius, cmd.card.spellProjectile?.radius ?? 0) * cam.scale : 12;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(x, y);
      c.arc(x, y, 10, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * left) / 20);
      c.closePath();
      c.fillStyle = 'rgba(255,255,255,.6)';
      c.fill();
      c.globalAlpha = 1;
    }

    for (const u of b.units) {
      if (u.state === ST_DEAD || this.artMode) continue;
      const x = cam.sx(f.ux(u));
      const yb = cam.sy(f.uy(u));
      const lift = u.isAir ? u.def.flyingHeight * cam.scale * 0.35 : 0;
      if (u.tower !== TOWER_NONE) {
        const w = u.tower === TOWER_KING ? 64 : 52;
        const y = yb + (u.team === 0 ? u.radius * cam.scale * 0.9 : -u.radius * cam.scale * 1.6);
        this.bar(x - w / 2, y, w, 8, u.hp / u.maxHp, u.team === 0 ? BLUE : RED);
        c.font = 'bold 10px system-ui';
        c.textAlign = 'center';
        c.fillStyle = '#fff';
        c.strokeStyle = '#000';
        c.lineWidth = 3;
        c.strokeText(String(u.hp), x, y + 7);
        c.fillText(String(u.hp), x, y + 7);
        continue;
      }
      const r = u.radius * cam.scale;
      if (u.state === ST_DEPLOYING) {
        const p = u.deployTotal ? 1 - u.deployTicks / u.deployTotal : 1;
        c.strokeStyle = u.team === 0 ? BLUE : RED;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, yb - lift, r * 0.7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
        c.stroke();
      }
      if (u.hp < u.maxHp || u.shield < u.def.shieldHitpoints) {
        const w = Math.max(18, Math.min(44, r * 2.6));
        this.bar(x - w / 2, yb - lift - r * 2.4 - 6, w, 4, u.hp / u.maxHp, u.team === 0 ? BLUE : RED);
      }
    }

    this.drawClock(f, b);
    if (f.drag) this.drawPreview(f);
    if (b.result) this.drawResult(f, b);
  }

  private bar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,.7)';
    c.fillRect(x - 1, y - 1, w + 2, h + 2);
    c.fillStyle = color;
    c.fillRect(x, y, Math.max(0, Math.min(1, frac)) * w, h);
  }

  private drawDeployZone(f: Frame, b: Battle): void {
    const d = f.drag!;
    if (d.isSpell) return;
    const c = this.ctx;
    const cam = f.cam;
    // shade the area the player cannot deploy to (enemy side, minus pockets)
    c.fillStyle = 'rgba(255,40,40,.18)';
    const enemy = b.players[1 - d.team];
    const pocketLeft = !enemy.princess[0].alive;
    const pocketRight = !enemy.princess[1].alive;
    const yRiver0 = d.team === 0 ? 15000 : 0;
    const yRiver1 = d.team === 0 ? ARENA_H : 17000;
    const half = ARENA_W / 2;
    const pocketEdge = d.team === 0 ? 25000 : 7000;
    const rect = (x0: number, y0: number, x1: number, y1: number) =>
      c.fillRect(cam.sx(x0), cam.sy(y1), (x1 - x0) * cam.scaleX, (y1 - y0) * cam.scaleY);
    for (const [x0, x1, open] of [[0, half, pocketLeft], [half, ARENA_W, pocketRight]] as const) {
      if (!open) rect(x0, yRiver0, x1, yRiver1);
      else if (d.team === 0) rect(x0, pocketEdge, x1, ARENA_H);
      else rect(x0, 0, x1, pocketEdge);
    }
  }

  private drawPreview(f: Frame): void {
    const d = f.drag!;
    const c = this.ctx;
    const cam = f.cam;
    const p = d.snapped ?? { x: d.x, y: d.y };
    const x = cam.sx(p.x);
    const y = cam.sy(p.y);
    c.strokeStyle = d.snapped ? '#ffffff' : '#ff3030';
    c.fillStyle = d.snapped ? 'rgba(255,255,255,.18)' : 'rgba(255,0,0,.2)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, Math.max(8, d.radius * cam.scale), 0, Math.PI * 2);
    c.fill();
    c.stroke();
    if (!d.isSpell && d.snapped) {
      const sw = 1000 * cam.scaleX;
      const sh = 1000 * cam.scaleY;
      c.strokeRect(x - sw / 2, y - sh / 2, sw, sh);
    }
  }

  private drawClock(f: Frame, b: Battle): void {
    const c = this.ctx;
    const cam = f.cam;
    const reg = b.regulationTicks;
    const left = b.tick < reg ? reg - b.tick : reg + b.overtimeTicks - b.tick;
    const secs = Math.max(0, Math.ceil(left / 20));
    const ot = b.tick >= reg;
    const txt = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const x = cam.sx(ARENA_W) - 8;
    const y = cam.sy(ARENA_H) + 8;
    c.textAlign = 'right';
    c.font = 'bold 11px system-ui';
    c.fillStyle = ot ? '#ffcf4a' : '#ddd';
    c.strokeStyle = '#000';
    c.lineWidth = 3;
    const label = ot ? 'Overtime' : 'Time left';
    c.strokeText(label, x, y + 10);
    c.fillText(label, x, y + 10);
    c.font = 'bold 20px system-ui';
    c.fillStyle = '#fff';
    c.strokeText(txt, x, y + 32);
    c.fillText(txt, x, y + 32);
    const rate = b.elixirPerTick() / 178;
    if (rate > 1.5) {
      c.font = 'bold 12px system-ui';
      c.fillStyle = '#e87cff';
      const r = `x${Math.round(rate)} elixir`;
      c.strokeText(r, x, y + 48);
      c.fillText(r, x, y + 48);
    }
    // crowns
    c.textAlign = 'left';
    c.font = 'bold 18px system-ui';
    const cx = cam.sx(0) + 8;
    for (const [team, yy] of [[1, cam.sy(ARENA_H / 2) - 30], [0, cam.sy(ARENA_H / 2) + 46]] as const) {
      const txt2 = `\u{1F451} ${b.players[team].crowns}`;
      c.fillStyle = team === 0 ? '#9cc4ff' : '#ff9c9c';
      c.strokeText(txt2, cx, yy);
      c.fillText(txt2, cx, yy);
    }
  }

  private drawResult(f: Frame, b: Battle): void {
    const c = this.ctx;
    const cam = f.cam;
    const r = b.result!;
    const msg = r.winner === -1 ? 'Draw' : r.winner === 0 ? 'Blue wins' : 'Red wins';
    c.fillStyle = 'rgba(0,0,0,.55)';
    c.fillRect(0, cam.height / 2 - 40, cam.width, 80);
    c.textAlign = 'center';
    c.font = 'bold 32px system-ui';
    c.fillStyle = r.winner === 0 ? '#9cc4ff' : r.winner === 1 ? '#ff9c9c' : '#fff';
    c.fillText(msg, cam.width / 2, cam.height / 2 + 4);
    c.font = '14px system-ui';
    c.fillStyle = '#ddd';
    c.fillText(`${b.players[0].crowns} - ${b.players[1].crowns} (${r.reason})`, cam.width / 2, cam.height / 2 + 28);
  }
}
