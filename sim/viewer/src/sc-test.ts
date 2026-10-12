// SC art gallery / visual test page for the baked original art (sim/viewer/sc-test.html).
//
//   cd sim && npx esbuild viewer/src/sc-test.ts --bundle --format=esm --outfile=viewer/dist/sc-test.js \
//       --servedir=viewer --serve=8090        then open http://localhost:8090/sc-test.html
//
// Modes (?mode=): arena (default: arena + towers + every unit fighting, projectiles, effects, plus
// 16-direction galleries of run / attack / idle around the field), units (&action=run1|attack1|idle1),
// fx (every baked effect looping), hud (cards, HUD panels, health bars),
// compare (&lib=&export=&frame=&scale=&ox=&oy=&w=&h= : one clip, for pixel comparison with render.py).
// all (every baked unit/building, area effects, buffs, ruins, deploy timers, card thumbnails),
// ?t=<ms> freezes time (effects are simulated up to t deterministically); ?shot hides the overlay box.

import {
  BattleArt, EffectPlayer, ScRenderer, actionFrameMs, pickDirection,
} from './sc/index.ts';
import type { Col, Mat, Team } from './sc/index.ts';
import { AreaViews, type AeoActor } from './sc/area_view.ts';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'arena';
const frozen = params.has('t') ? Number(params.get('t')) : null;
if (params.has('shot')) document.body.classList.add('shot');

const canvas = document.getElementById('c') as HTMLCanvasElement;
const labelCanvas = document.createElement('canvas');
labelCanvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none';
document.body.appendChild(labelCanvas);
const lg = labelCanvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;

interface Label { x: number; y: number; text: string; color?: string; size?: number }
let labels: Label[] = [];

// camera: world (SC px) point at the screen centre + zoom
const cam = { x: 0, y: 380, zoom: 1 };
let fitRect: [number, number, number, number] | null = null;

function resize(): void {
  const dpr = Number(params.get('dpr') ?? window.devicePixelRatio ?? 1);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  for (const c of [canvas, labelCanvas]) {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
}

function fit(rect: [number, number, number, number]): void {
  fitRect = rect;
  resize();
  const [x, y, w, h] = rect;
  cam.x = x + w / 2;
  cam.y = y + h / 2;
  cam.zoom = Math.min(canvas.width / w, canvas.height / h);
}

function viewMatrix(): Mat {
  const z = cam.zoom;
  return [z, 0, 0, z, canvas.width / 2 - cam.x * z, canvas.height / 2 - cam.y * z];
}

// pan / zoom
let drag: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dpr = canvas.width / canvas.clientWidth;
  cam.x -= ((e.clientX - drag[0]) * dpr) / cam.zoom;
  cam.y -= ((e.clientY - drag[1]) * dpr) / cam.zoom;
  drag = [e.clientX, e.clientY];
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dpr = canvas.width / canvas.clientWidth;
  const mx = e.clientX * dpr, my = e.clientY * dpr;
  const wx = cam.x + (mx - canvas.width / 2) / cam.zoom, wy = cam.y + (my - canvas.height / 2) / cam.zoom;
  cam.zoom *= Math.exp(-e.deltaY * 0.0015);
  cam.x = wx - (mx - canvas.width / 2) / cam.zoom;
  cam.y = wy - (my - canvas.height / 2) / cam.zoom;
}, { passive: false });
window.addEventListener('resize', () => { if (fitRect) fit(fitRect); });

function drawLabels(): void {
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  const v = viewMatrix();
  const dpr = canvas.width / canvas.clientWidth;
  for (const l of labels) {
    const sx = v[0] * l.x + v[4], sy = v[3] * l.y + v[5];
    if (sx < -200 || sy < -50 || sx > labelCanvas.width + 50 || sy > labelCanvas.height + 50) continue;
    lg.font = `${Math.round((l.size ?? 11) * dpr * Math.min(1.6, Math.max(0.7, cam.zoom)))}px system-ui, sans-serif`;
    lg.lineWidth = 3 * dpr;
    lg.strokeStyle = 'rgba(0,0,0,.75)';
    lg.strokeText(l.text, sx, sy);
    lg.fillStyle = l.color ?? '#fff';
    lg.fillText(l.text, sx, sy);
  }
}

// ---------------------------------------------------------------------------------------------

const art = await BattleArt.load('assets');
const m = art.manifest;
const r = new ScRenderer(canvas);
(window as unknown as { scTest: unknown }).scTest = { art, r, cam };

for (const [fam, url] of Object.entries(m.fonts ?? {})) {
  try {
    const ff = new FontFace(fam, `url(assets/${url})`);
    await ff.load();
    (document.fonts as unknown as { add(f: FontFace): void }).add(ff);
  } catch (err) {
    console.warn('font', fam, err);
  }
}
r.clearTextCache();

// galleries / arena fighters: the original 22-unit set (all characters with ?set=all)
const ARENA_SET = ['Knight', 'Archer', 'Giant', 'Musketeer', 'MiniPekka', 'Valkyrie', 'BabyDragon', 'Minion', 'Skeleton',
  'Goblin', 'SpearGoblin', 'Bomber', 'Wizard', 'Barbarian', 'Pekka', 'MegaMinion', 'Princess', 'BlowdartGoblin',
  'RoyalGiant', 'Bat', 'DartBarrell', 'AngryBarbarian'];
const chars = params.get('set') === 'all'
  ? Object.keys(m.characters).filter((n) => n !== m.towers.princess.character && m.characters[n].actions && Object.keys(m.characters[n].actions).length)
  : ARENA_SET.filter((n) => m.characters[n]);
const fx = new EffectPlayer(art, 7);
const A = art.yScale;

type Drawable = { y: number; draw: () => void };

// -- arena mode: units fighting on the field --------------------------------------------------

interface Fighter { name: string; team: Team; x: number; y: number; tx: number; ty: number; phase: number }
const fighters: Fighter[] = [];
{
  const per = Math.ceil(chars.length / 2);
  chars.forEach((name, i) => {
    const row = Math.floor(i / per), col = i % per;
    const x = 1200 + col * (15600 / Math.max(1, per - 1));
    const yb = row === 0 ? 10000 : 12600;
    const yr = 32000 - yb;
    fighters.push({ name, team: 0, x, y: yb, tx: x, ty: yr, phase: i * 137 });
    fighters.push({ name, team: 1, x, y: yr, tx: x, ty: yb, phase: i * 137 + 400 });
  });
}
const CYCLE = 9000; // ms: deploy (1 s), fight, die, pause

interface Shot { proj: string; team: Team; x0: number; y0: number; z0: number; x1: number; y1: number; t0: number; dur: number; arc: number }
let shots: Shot[] = [];

function fighterState(f: Fighter, t: number): { action: string; ms: number; deployMs?: number; dead: boolean } {
  const lt = (t + f.phase) % CYCLE;
  if (lt < 1000) return { action: 'idle1', ms: lt, deployMs: lt, dead: false };
  if (lt < 7500) return { action: 'attack1', ms: (lt - 1000) % (m.characters[f.name].hitSpeed as number ?? 1200), dead: false };
  return { action: 'idle1', ms: 0, dead: true };
}

function fireEvents(t0: number, t1: number): void {
  // character events: deploy, attack hits / projectile launches, death
  for (const f of fighters) {
    const ca = m.characters[f.name];
    const hitSpeed = (ca.hitSpeed as number) ?? 1200;
    const hitMs = actionFrameMs(ca, 'attack1', f.team) ?? (ca.loadTime as number ?? 500);
    const crossed = (at: number) => {
      const a = (t0 + f.phase) % CYCLE, b = (t1 + f.phase) % CYCLE;
      return a <= b ? at > a && at <= b : at > a || at <= b;
    };
    if (crossed(0.01) && ca.effects?.spawnEffect) fx.play(ca.effects.spawnEffect, f.x, f.y, { team: f.team });
    if (crossed(7500) && ca.effects?.deathEffect) fx.play(ca.effects.deathEffect, f.x, f.y, { team: f.team, z: (ca.flyingHeight as number) ?? 0 });
    for (let k = 1000 + hitMs; k < 7500; k += hitSpeed) {
      if (!crossed(k)) continue;
      const pname = (ca.projectile as string | undefined);
      if (pname && m.projectiles[pname]?.export) {
        const p = m.projectiles[pname];
        const dist = Math.hypot(f.tx - f.x, f.ty - f.y);
        const speed = ((p.speed ?? 600) / 60) * 1000; // units / s (data: tiles per minute)
        shots.push({ proj: pname, team: f.team, x0: f.x, y0: f.y, z0: (ca.projectileStartZ as number ?? 500) + ((ca.flyingHeight as number) ?? 0),
          x1: f.tx, y1: f.ty, t0: t1, dur: (dist / speed) * 1000, arc: (p.gravity ?? 0) * 12 + (p.constantHeight ?? 0) });
      } else if (ca.effects?.damageEffect) {
        fx.play(ca.effects.damageEffect, f.tx, f.ty, { team: f.team });
      }
      if (ca.effects?.attackStartEffect) fx.play(ca.effects.attackStartEffect, f.x, f.y, { team: f.team });
    }
  }
  // spells: Fireball every 6 s on the red side, Arrows on the blue side (offset 3 s)
  const spellAt = (period: number, off: number) => Math.floor((t1 - off) / period) > Math.floor((t0 - off) / period);
  if (m.spells.Fireball && spellAt(6000, 500)) {
    const p = m.projectiles[m.spells.Fireball.projectile ?? ''];
    if (p) shots.push({ proj: m.spells.Fireball.projectile!, team: 0, x0: 9000, y0: 3000, z0: 2000, x1: 9000, y1: 24500, t0: t1, dur: 2100, arc: 4000 });
  }
  if (m.spells.Arrows && spellAt(6000, 3500)) {
    const pn = m.spells.Arrows.projectile ?? '';
    const card = m.cards.Arrows as { radius?: number; projectileWaves?: number; projectileWaveInterval?: number; multipleProjectiles?: number };
    const rad = card?.radius ?? 3500;
    if (m.spells.Arrows.effect) fx.play(m.spells.Arrows.effect, 9000, 29000, { team: 1 });
    for (let w = 0; w < (card?.projectileWaves ?? 3); w++) {
      for (let i = 0; i < (card?.multipleProjectiles ?? 10); i++) {
        const a = (i / 10) * Math.PI * 2 + w, rr = rad * Math.sqrt(((i * 7 + w * 3) % 10) / 10);
        shots.push({ proj: pn, team: 1, x0: 9000 + (i - 5) * 150, y0: 29000, z0: 2500, x1: 9000 + Math.cos(a) * rr,
          y1: 8000 + Math.sin(a) * rr, t0: t1 + w * (card?.projectileWaveInterval ?? 200), dur: 1900, arc: 5000 });
      }
    }
  }
}

function shotPos(s: Shot, t: number): [number, number, number, number, number, number] {
  const u = Math.max(0, Math.min(1, (t - s.t0) / s.dur));
  const x = s.x0 + (s.x1 - s.x0) * u, y = s.y0 + (s.y1 - s.y0) * u;
  const z = s.z0 * (1 - u) + s.arc * 4 * u * (1 - u);
  const d = s.dur / 1000;
  const vx = (s.x1 - s.x0) / d, vy = (s.y1 - s.y0) / d;
  const vz = (-s.z0 + s.arc * 4 * (1 - 2 * u)) / d;
  return [x, y, z, vx, vy, vz];
}

function updateShots(t: number): void {
  for (const s of shots) {
    if (t >= s.t0 + s.dur) {
      const p = m.projectiles[s.proj];
      if (p?.hitEffect) fx.play(p.hitEffect, s.x1, s.y1, { team: s.team });
    }
  }
  shots = shots.filter((s) => t < s.t0 + s.dur);
}

// -- gallery helpers ------------------------------------------------------------------------------

const DIR_ANGLES: number[] = []; // 16 directions, engine angles, starting at "up" going clockwise
for (let k = 0; k < 16; k++) DIR_ANGLES.push(Math.PI / 2 - (k * Math.PI) / 8);

function galleryBlock(action: string, x0: number, y0: number, cellW: number, cellH: number, t: number, out: Drawable[],
  team: Team = 0): void {
  chars.forEach((name, row) => {
    const ca = m.characters[name];
    const y = y0 + row * cellH + cellH * 0.72;
    labels.push({ x: x0 - 6 - 70, y: y - 10, text: name, size: 10 });
    for (let k = 0; k < 16; k++) {
      const x = x0 + k * cellW + cellW / 2;
      const [gx, gy] = art.pxToGame(x, y);
      const ang = DIR_ANGLES[k];
      out.push({ y, draw: () => { art.drawUnit(r, name, team, gx, gy, action, ang, t, { loop: true, z: -((ca.flyingHeight as number) ?? 0) * 0.5 }); } });
    }
  });
  for (let k = 0; k < 16; k++) {
    const pd = pickDirection(DIR_ANGLES[k], 9);
    labels.push({ x: x0 + k * cellW + cellW / 2 - 10, y: y0 - 4, text: `${pd.dir}${pd.mirror ? 'm' : ''}`, size: 9, color: '#ffd' });
  }
}

// -- scene ----------------------------------------------------------------------------------------

let last = 0;
let simT = 0;
const t0 = performance.now();

function drawArenaScene(t: number): void {
  labels = [];
  const items: Drawable[] = [];
  art.drawBackground(r, t);
  art.drawArenaObjects(r, t, ['Base']);
  fx.draw(r, 'Ground');
  fx.draw(r, 'GroundAbility');

  // shadows
  r.beginShadows();
  art.drawArenaShadows(r, t);
  for (const f of fighters) {
    const st = fighterState(f, t);
    if (st.dead || st.deployMs !== undefined) continue;
    const ang = Math.atan2(f.ty - f.y, f.tx - f.x);
    art.drawUnitShadow(r, f.name, f.team, f.x, f.y, st.action, ang, st.ms);
  }
  fx.draw(r, 'Shadow');
  art.endShadowPass(r);
  fx.draw(r, 'Base');

  // towers
  const actT = t % 8000;
  for (const team of [0, 1] as Team[]) {
    const [kx, ky] = art.towerPos('king', team);
    const kpy = art.gameToPx(kx, ky)[1];
    const activation = team === 1 ? (actT > 1000 ? actT - 1000 : undefined) : undefined;
    const aim = team === 1 ? -Math.PI / 2 + Math.sin(t / 900) * 1.2 : undefined;
    const ruins = params.has('ruins') && team === 1;
    if (ruins) art.drawTowerRuin(r, 'king', team);
    else items.push({ y: kpy, draw: () => art.drawKingTower(r, team, t, art.kingFrameAt(activation), aim) });
    for (const side of ['princessLeft', 'princessRight'] as const) {
      const [px, py] = art.towerPos(side, team);
      const tpy = art.gameToPx(px, py)[1];
      const attacking = Math.floor(t / 3000) % 2 === 1;
      if (ruins && side === 'princessLeft') {
        art.drawTowerRuin(r, side, team);
        continue;
      }
      items.push({ y: tpy, draw: () => art.drawPrincessTower(r, team, side, t, attacking ? 'attack' : 'idle', team === 0 ? Math.PI / 2 : -Math.PI / 2, t % 1200) });
    }
  }
  // decorations on the Object layer
  for (const o of m.arena.objects) {
    if (o.layer !== 'Object') continue;
    const [px, py] = art.decoPx(o);
    items.push({ y: py, draw: () => r.draw(art.lib(o.sc), o.export, 0, [1, 0, 0, 1, px, py]) });
  }
  // fighters
  for (const f of fighters) {
    const st = fighterState(f, t);
    if (st.dead) continue;
    const ang = Math.atan2(f.ty - f.y, f.tx - f.x);
    const [, py] = art.gameToPx(f.x, f.y);
    items.push({ y: py, draw: () => { art.drawUnit(r, f.name, f.team, f.x, f.y, st.action, ang, st.ms, { deployMs: st.deployMs }); } });
  }
  // projectiles
  for (const s of shots) {
    if (t < s.t0) continue;
    const [x, y, z, vx, vy, vz] = shotPos(s, t);
    const [, py] = art.gameToPx(x, y);
    items.push({ y: py + 1000, draw: () => art.drawProjectile(r, s.proj, s.team, x, y, z, vx, vy, vz, t - s.t0) });
  }
  for (const it of fx.collect('Object')) items.push({ y: it.sortY, draw: () => it.draw(r) });

  // galleries around the field
  galleryBlock('run1', -1180, -380, 52, 66, t, items);
  galleryBlock('attack1', 340, -380, 52, 66, t, items);
  galleryBlock('idle1', -420, 1180, 52, 66, t, items, 1);
  labels.push({ x: -1180, y: -420, text: 'run1 (blue), 16 directions', size: 14, color: '#ffd' });
  labels.push({ x: 340, y: -420, text: 'attack1 (blue), 16 directions', size: 14, color: '#ffd' });
  labels.push({ x: -420, y: 1140, text: 'idle1 (red), 16 directions', size: 14, color: '#ffd' });
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();
  fx.draw(r, 'Above');

  // projectile showcase above the field (drawn on top): each one spins through its directions
  const projNames = Object.keys(m.projectiles).filter((p) => m.projectiles[p].export);
  const PC = 14, prow = Math.ceil(projNames.length / PC);
  r.drawRect(-330, -450, 660, prow * 100 + 40, [0.08, 0.1, 0.08, 0.8]);
  labels.push({ x: -320, y: -456, text: 'projectiles (velocity direction rotating; shadow below)', size: 12, color: '#ffd' });
  projNames.forEach((p, i) => {
    const x = -305 + (i % PC) * 47, y = -400 + Math.floor(i / PC) * 100;
    const [gx, gy] = art.pxToGame(x, y + 40);
    const ang = t / 900 + i * 0.7;
    labels.push({ x: x - 22, y: y + 58 - (i % 2) * 9, text: p, size: 6 });
    art.drawProjectile(r, p, 0, gx, gy, 2300, Math.cos(ang) * 1000, Math.sin(ang) * 1000, Math.sin(ang * 0.7) * 600, t, true);
  });

  // health bars over towers + a few units
  for (const team of [0, 1] as Team[]) {
    for (const side of ['princessLeft', 'princessRight'] as const) {
      const [px, py] = art.towerPos(side, team);
      const [sx, sy] = art.gameToPx(px, py);
      const off = (team === 0 ? m.towers.princess.healthBarOffsetYBlue : m.towers.princess.healthBarOffsetYRed) ?? 0;
      art.drawHealthBar(r, m.towers.princess.healthBar ?? 'Tower', team, sx, sy - 70 + (team === 0 ? off * 0.0 : 0), 0.6 + 0.4 * Math.abs(Math.sin(t / 3000)), 11, 2534);
    }
    const [kx, ky] = art.towerPos('king', team);
    const [sx, sy] = art.gameToPx(kx, ky);
    art.drawHealthBar(r, m.towers.king.healthBar ?? 'Summoner', team, sx, sy - 95, 1, 11, 4824);
  }
  for (const f of fighters.slice(0, 8)) {
    const st = fighterState(f, t);
    if (st.dead) continue;
    const ca = m.characters[f.name];
    const [sx, sy] = art.gameToPx(f.x, f.y, (ca.flyingHeight as number) ?? 0);
    art.drawHealthBar(r, (ca.healthBar as string) ?? 'Medium', f.team, sx, sy - 50 - ((ca.healthBarOffsetY as number) ?? 0) * 0.5, 0.75, 11);
  }
}

function drawUnitsMode(t: number): void {
  labels = [];
  const action = params.get('action') ?? 'run1';
  const team = (Number(params.get('team') ?? 0) ? 1 : 0) as Team;
  const items: Drawable[] = [];
  const cellW = 64, cellH = 90;
  r.drawRect(-140, -60, 16 * cellW + 160, chars.length * cellH + 80, [0.38, 0.5, 0.28, 1]);
  galleryBlock(action, 0, 0, cellW, cellH, t, items, team);
  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();
}

const fxNames = Object.keys(m.effects).filter((n) => m.effects[n].components.length).sort();
const fxCells = fxNames.map((name, i) => ({ name, x: (i % 10) * 150 + 75, y: Math.floor(i / 10) * 150 + 110 }));
let fxNext = 0;
function fxEvents(t: number): void {
  // replay every effect every 3 s
  while (fxNext <= t) {
    for (const c of fxCells) {
      const [gx, gy] = art.pxToGame(c.x, c.y);
      fx.play(c.name, gx, gy, { team: 0 });
    }
    fxNext += 3000;
  }
}

function drawFxMode(_t: number): void {
  labels = [];
  r.drawRect(0, 0, 1500, Math.ceil(fxCells.length / 10) * 150 + 20, [0.38, 0.5, 0.28, 1]);
  for (const c of fxCells) {
    labels.push({ x: c.x - 70, y: c.y + 30, text: c.name, size: 8 });
    r.drawRect(c.x - 2, c.y - 2, 4, 4, [1, 0, 0, 1]);
  }
  fx.draw(r, 'Ground');
  fx.draw(r, 'GroundAbility');
  r.beginShadows();
  fx.draw(r, 'Shadow');
  art.endShadowPass(r);
  for (const layer of ['Base', 'Object', 'Above']) fx.draw(r, layer);
}

function drawHudMode(t: number): void {
  labels = [];
  const hud = art.lib(m.hud.sc);
  r.drawRect(-20, -20, 1400, 1100, [0.2, 0.25, 0.2, 1]);
  // in-hand cards (spell_card_ingame + icon)
  Object.keys(m.cards).forEach((c, i) => {
    const x = 70 + (i % 12) * 105, y = 90 + Math.floor(i / 12) * 150;
    art.drawCard(r, c, [0.65, 0, 0, 0.65, x, y]);
    labels.push({ x: x - 40, y: y + 72, text: `${c} (${m.cards[c].elixir}, ${m.cards[c].rarity})`, size: 9 });
  });
  // bottom panel with a hand, next card and elixir
  const elixir = (t / 1000 / 2.8 + 3.3) % 10;
  const hand = ['Knight', 'Fireball', 'Musketeer', 'Arrows'].filter((c) => m.cards[c]);
  art.drawHand(r, [1, 0, 0, 1, 360, 560], hand, m.cards.Giant ? 'Giant' : null, elixir);
  labels.push({ x: 40, y: 660, text: `HUD_player via drawHand (elixir ${elixir.toFixed(1)})`, size: 10 });
  // top-right timer / top-left names
  r.draw(hud, 'HUD_topRight', 0, [1, 0, 0, 1, 1250, 380], [1, 1, 1, 1, 0, 0, 0], { text: { timeLeft: '2:47' } });
  labels.push({ x: 1060, y: 470, text: 'HUD_topRight (timer)', size: 10 });
  r.draw(hud, 'HUD_topLeft', 0, [1, 0, 0, 1, 840, 380], [1, 1, 1, 1, 0, 0, 0], { text: { enemyName: 'Opponent', enemyClan: 'Clan' } });
  // other HUD exports
  const ex = m.hud.exports.filter((e) => !['HUD_player', 'HUD_topRight', 'HUD_topLeft', 'spell_card_ingame'].includes(e));
  ex.forEach((e, i) => {
    const x = 80 + (i % 8) * 165, y = 740 + Math.floor(i / 8) * 85;
    r.draw(hud, e, Math.floor((t * hud.fps(e)) / 1000), [0.6, 0, 0, 0.6, x, y]);
    labels.push({ x: x - 70, y: y + 36, text: e, size: 8 });
  });
  // health bars
  const types = Object.keys(m.hud.healthBars);
  types.forEach((ty, i) => {
    const x = 80 + (i % 7) * 185, y = 1020 + Math.floor(i / 7) * 40;
    art.drawHealthBar(r, ty, 0, x, y, (Math.sin(t / 1000 + i) + 1) / 2, 11, 1234);
    art.drawHealthBar(r, ty, 1, x + 85, y, (Math.cos(t / 1000 + i) + 1) / 2, 11, 1234);
    labels.push({ x: x - 40, y: y + 18, text: ty, size: 8 });
  });
}

// -- "all" mode: every baked unit / building, area effects, buffs, ruins, deploy timers, thumbnails --

const allUnits = Object.keys(m.characters);
const COLS = 10, CW = 130, CH = 135;
const unitRows = Math.ceil(allUnits.length / COLS);
const aeoNames = Object.keys(m.areaEffects ?? {});
const AEO_Y = unitRows * CH + 120, AW = 260, AH = 230;
const BUFF_Y = AEO_Y + Math.ceil(aeoNames.length / 5) * AH + 80;
const buffNames = Object.keys(m.buffs ?? {});
const aeoPeriod = (n: string) => Math.max(1500, ((m.areaEffects?.[n]?.lifeDuration as number) ?? 0) + 1200);
const aeoNext = new Map<string, number>();

function aeoCell(i: number): [number, number] {
  return [(i % 5) * AW + AW / 2, AEO_Y + Math.floor(i / 5) * AH + AH / 2];
}

// area-effect object views (sc/area_view.ts) on stand-in actors that live for their LifeDuration
const aeoViews = new AreaViews(fx, m, art.flip);
const aeoLive: (AeoActor & { until: number })[] = [];
let aeoSeq = 1;

function allEvents(t: number): void {
  aeoNames.forEach((n, i) => {
    let next = aeoNext.get(n) ?? 0;
    while (next <= t) {
      const [cx, cy] = aeoCell(i);
      const [gx, gy] = art.pxToGame(cx, cy);
      const a = m.areaEffects![n];
      const life = (a.lifeDuration as number | undefined) ?? 0;
      const id = aeoSeq++;
      aeoLive.push({ id, x: gx, y: gy, life, def: { name: n, lifeDuration: life }, until: next + life });
      aeoViews.create(aeoViews, id, n, 0, gx, gy, 0, life);
      if (a.projectile && m.projectiles[a.projectile]?.hitEffect) fx.play(m.projectiles[a.projectile].hitEffect!, gx, gy, { loop: false });
      next += aeoPeriod(n);
    }
    aeoNext.set(n, next);
  });
  for (let k = aeoLive.length - 1; k >= 0; k--) if (aeoLive[k].until < t) aeoLive.splice(k, 1);
  aeoViews.update(aeoViews, aeoLive);
}

function drawAllMode(t: number): void {
  labels = [];
  const total = BUFF_Y + 420;
  r.drawRect(-20, -60, COLS * CW + 60, total, [0.38, 0.5, 0.28, 1]);
  labels.push({ x: 0, y: -30, text: `${allUnits.length} characters / buildings (blue: attack or default state, aim rotating; red right)`, size: 13, color: '#ffd' });
  const items: { y: number; draw: () => void }[] = [];
  allUnits.forEach((n, i) => {
    const cx = (i % COLS) * CW + CW / 2, cy = Math.floor(i / COLS) * CH + CH * 0.62;
    const a = m.characters[n];
    labels.push({ x: cx - CW / 2 + 4, y: cy + CH * 0.36, text: n, size: 9 });
    const ang = (t / 1400) % (Math.PI * 2);
    for (const team of [0, 1] as Team[]) {
      const [gx, gy] = art.pxToGame(cx + (team === 0 ? -26 : 26), cy);
      const isB = a.kind === 'building' || !!a.clip;
      let state: string | undefined;
      let stateMs = 0;
      if (a.clip?.blue?.labels) {
        const lb = Object.values(a.clip.blue.labels);
        const cyc = ['appear', 'up', 'hide', 'hidden', 'deploy', 'attack', 'idle'].filter((x) => lb.includes(`${x}_start`) || lb.includes(x) || (x === 'up' && lb.includes('appear_end')) || (x === 'hidden' && lb.includes('idle')));
        if (cyc.length) {
          const k = Math.floor(t / 1200) % cyc.length;
          state = cyc[k];
          stateMs = t % 1200;
        }
      }
      const z = -((a.flyingHeight as number) ?? 0) * 0.6;
      items.push({ y: cy + (team ? 0.1 : 0), draw: () => {
        if (isB) art.drawBuilding(r, n, team, gx, gy, t, { aim: team === 0 ? ang : -ang, state, stateMs, z, action: 'attack', actionMs: t % 1500 });
        else art.drawUnit(r, n, team, gx, gy, 'attack', team === 0 ? -Math.PI / 4 : Math.PI * 0.75, t % ((a.hitSpeed as number) ?? 1200), { z });
      } });
    }
  });
  items.sort((p, q) => p.y - q.y);
  for (const it of items) it.draw();

  // area effects
  labels.push({ x: 0, y: AEO_Y - 30, text: 'area effects (looping at their data radius / lifetime; ellipse = Radius)', size: 13, color: '#ffd' });
  aeoNames.forEach((n, i) => {
    const [cx, cy] = aeoCell(i);
    const a = m.areaEffects![n];
    const rad = (a.radius as number) ?? 1000;
    // radius marker: 32 dots on the ground ellipse
    for (let k = 0; k < 32; k++) {
      const th = (k / 32) * Math.PI * 2;
      const [gx, gy] = art.pxToGame(cx, cy);
      const [px, py] = art.gameToPx(gx + Math.cos(th) * rad, gy + Math.sin(th) * rad);
      r.drawRect(px - 1.5, py - 1.5, 3, 3, [1, 1, 1, 0.8]);
    }
    labels.push({ x: cx - AW / 2 + 6, y: cy + AH / 2 - 8, text: `${n} r=${rad} life=${a.lifeDuration ?? '-'}`, size: 9 });
  });
  fx.draw(r, 'Ground');
  fx.draw(r, 'GroundAbility');
  r.beginShadows();
  fx.draw(r, 'Shadow');
  art.endShadowPass(r);
  for (const layer of ['Base', 'Object', 'Above']) fx.draw(r, layer);

  // buffs on a Knight, ruins, deploy timers
  labels.push({ x: 0, y: BUFF_Y - 30, text: 'buff colour filters (Knight), hit flash, tower ruins, deploy timers', size: 13, color: '#ffd' });
  [...buffNames, 'flash'].forEach((b, i) => {
    const cx = 60 + i * 95, cy = BUFF_Y + 90;
    const [gx, gy] = art.pxToGame(cx, cy);
    const o = b === 'flash' ? { flashMs: t % 600 } : { buffs: [{ name: b, ms: t % 3000 }] };
    art.drawUnit(r, 'Knight', 0, gx, gy, 'run', -Math.PI / 2, t, o);
    labels.push({ x: cx - 40, y: cy + 40, text: b, size: 9 });
  });
  const ruinY = BUFF_Y + 270;
  const k = m.towers.king, pr = m.towers.princess;
  r.draw(art.lib(k.sc), k.destroyed, 0, [1, 0, 0, 1, 120, ruinY]);
  r.draw(art.lib(pr.sc), pr.destroyed, 0, [1, 0, 0, 1, 300, ruinY]);
  for (const ex of ['kingtower_destroyed', 'princesstower_destroyed']) {
    // shark-skin ruins (not the default), shown small for reference
    if (art.lib(k.sc).has(ex)) r.draw(art.lib(k.sc), ex, 0, [0.4, 0, 0, 0.4, ex.startsWith('king') ? 800 : 870, ruinY]);
  }
  labels.push({ x: 60, y: ruinY + 70, text: `${k.destroyed}`, size: 9 });
  labels.push({ x: 250, y: ruinY + 70, text: `${pr.destroyed}`, size: 9 });
  [0.15, 0.5, 0.85].forEach((f, i) => {
    art.drawDeployTimer(r, 0, 480 + i * 90, ruinY, (f + t / 4000) % 1);
    art.drawDeployTimer(r, 1, 480 + i * 90, ruinY + 70, (f + t / 4000) % 1);
  });
  labels.push({ x: 440, y: ruinY + 110, text: 'troopDeployTimer_player / _enemy', size: 9 });
}

// card thumbnails (data URLs) shown as DOM images, proving the cardThumbnail path
if (mode === 'all' || mode === 'hud') {
  const strip = document.createElement('div');
  strip.style.cssText = 'position:fixed;right:8px;top:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:46vw;justify-content:flex-end;pointer-events:none';
  document.body.appendChild(strip);
  const names = Object.keys(m.cards).slice(0, mode === 'all' ? 70 : 12);
  void Promise.all(names.map((c) => art.cardThumbnail(c, mode === 'all' ? 44 : 64, { pixelRatio: 1 }))).then((urls) => {
    urls.forEach((u, i) => {
      const img = new Image();
      img.src = u;
      img.title = names[i];
      strip.appendChild(img);
    });
    (window as unknown as { scThumbs: number }).scThumbs = urls.length;
  });
}

function drawCompare(): void {
  const lib = art.lib(params.get('lib') ?? 'chr_knight');
  const s = Number(params.get('scale') ?? 2);
  const ox = Number(params.get('ox') ?? 100), oy = Number(params.get('oy') ?? 150);
  r.setView(1, 0, 0, 1, 0, 0);
  r.draw(lib, params.get('export') ?? 'Knight_run1_5', Number(params.get('frame') ?? 0), [s, 0, 0, s, ox, oy]);
}

function frame(now: number): void {
  resize();
  const t = frozen ?? now - t0;
  const bg = params.get('bg')?.split(',').map(Number) as [number, number, number, number] | undefined;
  r.begin(bg ?? [0.11, 0.16, 0.11, 1]);
  if (mode === 'compare') {
    drawCompare();
    r.end();
    (window as unknown as { scReady: boolean }).scReady = true;
    return;
  }
  // advance the simulation in fixed steps
  const step = 1000 / 60;
  while (simT + step <= t) {
    const nt = simT + step;
    if (mode === 'arena') {
      fireEvents(simT, nt);
      updateShots(nt);
    } else if (mode === 'all') {
      allEvents(simT);
    } else if (mode === 'fx') {
      fxEvents(simT);
    }
    fx.update(step);
    simT = nt;
  }
  r.setView(...viewMatrix());
  if (mode === 'arena') drawArenaScene(t);
  else if (mode === 'units') drawUnitsMode(t);
  else if (mode === 'fx') drawFxMode(t);
  else if (mode === 'hud') drawHudMode(t);
  else if (mode === 'all') drawAllMode(t);
  r.end();
  drawLabels();
  if (now - last > 500) {
    last = now;
    statsEl.textContent = ` ${r.stats.drawCalls} draw calls, ${r.stats.triangles} tris, ${fx.count} effects`;
  }
  (window as unknown as { scReady: boolean }).scReady = true;
  if (frozen === null) requestAnimationFrame(frame);
}

if (mode === 'arena') fit([-1320, -480, 2640, 2440]);
else if (mode === 'units') fit([-150, -70, 16 * 64 + 170, chars.length * 90 + 90]);
else if (mode === 'fx') fit([0, 0, 1500, Math.ceil(fxCells.length / 10) * 150 + 20]);
else if (mode === 'hud') fit([-20, -20, 1400, 1120]);
else if (mode === 'all') fit([-20, -60, COLS * CW + 60, BUFF_Y + 420]);
else resize();
const zoomParam = params.get('zoom');
if (zoomParam) {
  const [zx, zy, zz] = zoomParam.split(',').map(Number);
  cam.x = zx; cam.y = zy; cam.zoom = zz;
}
if (frozen !== null) {
  // simulate deterministically up to t, then draw once
  requestAnimationFrame(() => frame(frozen));
} else {
  requestAnimationFrame(frame);
}
