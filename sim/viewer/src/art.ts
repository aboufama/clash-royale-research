// Original-art world renderer: draws the live engine state with the build's own SC2 movie clips
// (baked by tools/art/bake_web.py into sim/viewer/assets/, played by sc/renderer.ts).
//
// Engine -> art mapping (visual only, never feeds back into the simulation):
//   deploying  -> idle pose + the game's deploy filter clip (DeployBaseAnimExportName)
//   attacking  -> attack clip timed so its `action_frame` lands on the engine's hit tick
//   moving     -> run clip looping on simulation time
//   towers     -> King activation clip / turret aimed at the target; Princess idle/attack
//   events     -> the game's own effects (deploy, attack start, hit, projectile hit, death)
import {
  type Battle, KING_ACTIVATING, KING_INACTIVE, type Projectile, ST_DEAD, ST_DEPLOYING, TOWER_KING, TOWER_NONE, type Unit,
} from '../../core/src/index.ts';
import type { Camera } from './camera.ts';
import type { Frame, WorldRenderer } from './frame.ts';
import type { ArtHooks } from './main.ts';
import { actionFrameMs, BattleArt, EffectPlayer, type Mat, ScRenderer } from './sc/index.ts';

type Team = 0 | 1;

export function createArt(_manifest: unknown): ArtHooks {
  const thumbs = new Map<string, string>();
  return {
    async makeRenderer(canvas: HTMLCanvasElement, cam: Camera): Promise<WorldRenderer | null> {
      const art = await BattleArt.load('assets');
      for (const [fam, url] of Object.entries(art.manifest.fonts ?? {})) {
        try {
          const ff = new FontFace(fam, `url(assets/${url})`);
          await ff.load();
          (document.fonts as unknown as { add(f: FontFace): void }).add(ff);
        } catch (err) {
          console.warn('font', fam, err);
        }
      }
      // original card art (frame + icon + elixir cost) for the DOM hands and palette
      await Promise.all(Object.keys(art.manifest.cards).map(async (card) => {
        try { thumbs.set(card, await art.cardThumbnail(card, 120)); } catch (err) { console.warn('card', card, err); }
      }));
      const r = new ScRenderer(canvas);
      r.clearTextCache();
      return new ArtWorld(art, r, cam, canvas);
    },
    cardImage(card: string): string | null {
      return thumbs.get(card) ?? null;
    },
  };
}

interface DrawItem { y: number; draw: () => void }

export class ArtWorld implements WorldRenderer {
  private art: BattleArt;
  private r: ScRenderer;
  private cam: Camera;
  private canvas: HTMLCanvasElement;
  private fx: EffectPlayer;
  private lastNow = 0;
  /** Running area-effect visuals by engine AEO id. */
  private aeoFx = new Map<number, { stop(): void }>();
  /** SC px -> CSS px scale and offset (screen = s * px + v). */
  private s = 1;
  private vx = 0;
  private vy = 0;

  constructor(art: BattleArt, r: ScRenderer, cam: Camera, canvas: HTMLCanvasElement) {
    this.art = art;
    this.r = r;
    this.cam = cam;
    this.canvas = canvas;
    this.fx = new EffectPlayer(art, 7);
    // Show the field plus a margin of the stadium, with the art's foreshortening.
    cam.aspectY = art.yScale;
    cam.world = { x0: -1200, y0: -2200, x1: 19200, y1: 32800 };
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.cam.fit(width, height, dpr);
    // Derive the SC-pixel view from the camera: gameToPx is affine with the same scales.
    const a = this.art.manifest.arena;
    this.s = (this.cam.scaleX * 1000) / a.pxPerTileX;
    this.vx = this.cam.ox - this.s * (a.originPx[0] - (a.originGame[0] * a.pxPerTileX) / 1000);
    this.vy = this.cam.oy - this.s * (a.originPx[1] + (a.originGame[1] * a.pxPerTileY) / 1000);
  }

  // ---------------------------------------------------------------- events -> effects

  onEvents(f: Frame): void {
    const b = f.battle;
    const m = this.art.manifest;
    for (const e of b.events) {
      const team = e.team as Team;
      if (e.type === 'spawn') {
        const ca = m.characters[e.name];
        const eff = ca?.effects?.spawnEffect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'hit') {
        const u = b.units.find((q) => q.id === e.id);
        const ca = u ? m.characters[u.def.name] : null;
        const eff = ca?.effects?.damageEffect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'shoot') {
        const u = b.units.find((q) => q.id === e.id);
        const ca = u ? m.characters[u.def.name] : null;
        const eff = (ca?.effects?.projectileEffect ?? ca?.effects?.attackStartEffect) as string | undefined;
        if (u && eff && this.fx.has(eff)) this.fx.play(eff, u.x, u.y, { team });
      } else if (e.type === 'impact') {
        const p = m.projectiles[e.name] ?? (m.spells[e.name] ? m.projectiles[m.spells[e.name].projectile ?? ''] : undefined);
        const eff = p?.hitEffect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'death' || e.type === 'tower') {
        const ca = m.characters[e.name];
        let eff = ca?.effects?.deathEffect as string | undefined;
        if (e.type === 'tower') eff = (e.name === 'KingTower' ? m.towers.king.effects?.deathEffect : m.towers.princess.effects?.deathEffect) as string | undefined;
        // tower rubble is drawn by drawTowerRuin, so skip the effect's permanent particles
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team, skipPersistent: e.type === 'tower' });
      } else if (e.type === 'aoe') {
        const a = b.areaEffects.find((q) => q.id === e.id);
        const h = this.art.playAreaEffect(this.fx, e.name, e.x, e.y, {
          team, radius: a?.def.radius, durationMs: a ? a.def.lifeDuration : undefined,
        });
        if (h.handles.length) this.aeoFx.set(e.id, h);
      } else if (e.type === 'cast') {
        const sp = m.spells[e.name];
        const eff = sp?.effect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      }
    }
  }

  // ---------------------------------------------------------------- frame

  draw(f: Frame): void {
    const art = this.art;
    const r = this.r;
    const b = f.battle;
    const m = art.manifest;
    const now = f.now;
    const dt = this.lastNow ? Math.min(100, now - this.lastNow) : 0;
    this.lastNow = now;
    this.fx.update(dt);
    const sim = f.simMs;
    const dpr = this.cam.dpr;

    r.begin([0.05, 0.08, 0.05, 1]);
    r.setView(this.s * dpr, 0, 0, this.s * dpr, this.vx * dpr, this.vy * dpr);
    art.drawBackground(r);
    art.drawArenaObjects(r, sim, ['Base']);
    // destroyed towers leave the game's rubble on the ground layer
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state !== ST_DEAD) continue;
      const kind = u.tower === TOWER_KING ? 'king' : u.x < 9000 ? 'princessLeft' : 'princessRight';
      art.drawTowerRuin(r, kind, u.team as Team);
    }
    this.fx.draw(r, 'Ground');
    this.fx.draw(r, 'GroundAbility');
    // stop area-effect visuals whose engine object has expired
    if (this.aeoFx.size) {
      for (const [id, h] of this.aeoFx) if (!b.areaEffects.some((q) => q.id === id)) { h.stop(); this.aeoFx.delete(id); }
    }

    // unit shadows
    const sh = m.arena.shadow;
    r.beginShadows();
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.state === ST_DEPLOYING || u.tunneling) continue;
      const ca = m.characters[u.def.name];
      if (!ca) continue;
      const st = this.unitState(u, f);
      art.drawUnitShadow(r, u.def.name, u.team as Team, f.ux(u), f.uy(u), st.action, st.angle, st.ms);
    }
    this.fx.draw(r, 'Shadow');
    r.endShadows([(sh.ShadowR ?? 0) / 255, (sh.ShadowG ?? 0) / 255, (sh.ShadowB ?? 0) / 255, (sh.ShadowA ?? 50) / 100], 2.5);
    this.fx.draw(r, 'Base');

    const items: DrawItem[] = [];
    const ypx = (x: number, y: number, z = 0) => art.gameToPx(x, y, z)[1];

    // towers
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state === ST_DEAD) continue;
      const team = u.team as Team;
      const dead = false;
      const py = ypx(u.x, u.y);
      if (u.tower === TOWER_KING) {
        let act: number | undefined;
        if (u.kingState === KING_ACTIVATING) act = (66 - u.kingTicks) * 50 + f.alpha * 50;
        else if (u.kingState !== KING_INACTIVE) act = 3300 + sim;
        const aim = u.target && u.kingState !== KING_INACTIVE ? Math.atan2(u.target.y - u.y, u.target.x - u.x) : undefined;
        items.push({ y: py, draw: () => art.drawKingTower(r, team, sim, act, aim, dead) });
      } else {
        const side = u.x < 9000 ? 'princessLeft' : 'princessRight';
        const atk = this.attackPhase(u, f);
        const aim = u.target ? Math.atan2(u.target.y - u.y, u.target.x - u.x) : team === 0 ? Math.PI / 2 : -Math.PI / 2;
        items.push({ y: py, draw: () => art.drawPrincessTower(r, team, side, sim, atk === null ? 'idle' : 'attack', aim, atk ?? sim, dead) });
      }
    }
    // arena decorations on the object layer
    for (const o of m.arena.objects) {
      if (o.layer !== 'Object') continue;
      const [px, py] = art.gameToPx(o.x, 32000 - o.y);
      items.push({ y: py, draw: () => r.draw(art.lib(o.sc), o.export, 0, [1, 0, 0, 1, px, py]) });
    }
    // units (0-HP actors such as death bombs and the Rage bottle are drawn too)
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling) continue;
      const ca = m.characters[u.def.name];
      const x = f.ux(u);
      const y = f.uy(u);
      const team = u.team as Team;
      if (!ca) {
        const [px, py] = art.gameToPx(x, y, u.def.flyingHeight);
        const rr = (u.radius / 1000) * art.pxPerTileX;
        items.push({ y: py, draw: () => r.drawRect(px - rr, py - rr, 2 * rr, 2 * rr, team === 0 ? [0.25, 0.5, 1, 0.8] : [1, 0.3, 0.3, 0.8]) });
        continue;
      }
      const st = this.unitState(u, f);
      const flying = u.def.flyingHeight > 0;
      const py = ypx(x, y) + (flying ? 2000 : 0);
      const buffs = u.buffs.length ? u.buffs.map((q) => ({ name: q.def.name, ms: (b.tick - q.startTick) * 50 + f.alpha * 50 })) : undefined;
      const flashMs = b.tick - u.lastHurtTick < 10 ? (b.tick - u.lastHurtTick) * 50 + f.alpha * 50 : undefined;
      const o: Parameters<BattleArt['drawUnit']>[8] = { deployMs: st.deployMs, buffs, flashMs };
      if (u.def.hides) {
        // Tesla: closed while hidden, rising for UpTimeMs, then up
        if (u.hidden && u.upMs > 0) { o.state = 'appear'; o.stateMs = u.upMs + f.alpha * 50; } else o.state = u.hidden ? 'hidden' : 'up';
      }
      items.push({ y: py, draw: () => { art.drawUnit(r, u.def.name, team, x, y, st.action, st.angle, st.ms, o); } });
    }
    // projectiles
    for (const p of b.projectiles) {
      const x = f.px(p);
      const y = f.py(p);
      const z = this.projectileZ(p, x, y);
      const vx = p.tx - p.x;
      const vy = p.ty - p.y;
      const py = ypx(x, y) + 1500;
      const team = p.team as Team;
      const name = p.def.name;
      if (!m.projectiles[name]) continue;
      items.push({ y: py, draw: () => art.drawProjectile(r, name, team, x, y, z, vx, vy, 0, sim - p.born * 50) });
    }
    for (const it of this.fx.collect('Object')) items.push({ y: it.sortY, draw: () => it.draw(r) });
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    this.fx.draw(r, 'Above');

    // deploy clocks over deploying troops and buildings (ui troopDeployTimer)
    for (const u of b.units) {
      if (u.state !== ST_DEPLOYING || u.tower !== TOWER_NONE || u.tunneling || u.deployTotal <= 0 || u.maxHp <= 0) continue;
      const [sx, sy] = art.gameToPx(f.ux(u), f.uy(u), u.def.flyingHeight);
      const frac = Math.min(1, ((u.deployTotal - u.deployTicks) + f.alpha) / u.deployTotal);
      art.drawDeployTimer(r, u.team as Team, sx, sy - 45, frac);
    }

    // health bars (original HUD art)
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.maxHp <= 0 || u.tunneling) continue;
      const team = u.team as Team;
      if (u.tower !== TOWER_NONE) {
        const king = u.tower === TOWER_KING;
        const kind = king ? 'king' : u.x < 9000 ? 'princessLeft' : 'princessRight';
        const [sx, sy] = art.towerBarPx(kind, team);
        const type = (king ? m.towers.king.healthBar : m.towers.princess.healthBar) ?? (king ? 'Summoner' : 'Tower');
        art.drawHealthBar(r, type, team, sx, sy, u.hp / u.maxHp, u.def.level, u.hp);
        continue;
      }
      if (u.hp >= u.maxHp && u.shield >= u.def.shieldHitpoints) continue;
      const ca = m.characters[u.def.name];
      if (ca?.hideHealthbar) continue;
      const [sx, sy] = art.unitBarPx(u.def.name, team, f.ux(u), f.uy(u));
      art.drawHealthBar(r, (ca?.healthBar as string | undefined) ?? 'Medium', team, sx, sy, u.hp / u.maxHp, u.def.level);
    }
    r.end();
  }

  /** Engine state -> clip, angle and clip time. */
  private unitState(u: Unit, f: Frame): { action: string; angle: number; ms: number; deployMs?: number } {
    const angle = Math.atan2(u.dirY, u.dirX);
    if (u.state === ST_DEPLOYING) {
      const elapsed = (u.deployTotal - u.deployTicks) * 50 + f.alpha * 50;
      return { action: 'idle', angle, ms: 0, deployMs: elapsed };
    }
    const atk = this.attackPhase(u, f);
    if (atk !== null) return { action: 'attack', angle, ms: atk };
    if (u.moving) return { action: 'run', angle, ms: f.simMs + (u.id % 7) * 61 };
    return { action: 'idle', angle, ms: f.simMs };
  }

  /**
   * Attack clip time so that the clip's action_frame coincides with the engine hit: the timer
   * crosses a multiple of HitSpeed on the hit tick. Follow-through after a hit, wind-up before
   * the next one, idle in between. null = not attacking.
   */
  private attackPhase(u: Unit, f: Frame): number | null {
    if (!u.locked && !u.hitStarted && f.battle.tick - u.lastHitTick > 20) return null;
    const ca = this.art.manifest.characters[u.def.name] ?? (u.tower ? this.art.manifest.characters[this.art.manifest.towers.princess.character as string] : undefined);
    const HS = u.def.hitSpeed;
    if (!ca || HS <= 0) return null;
    const af = actionFrameMs(ca, 'attack1', u.team as Team) ?? Math.min(HS, u.def.loadTime);
    const act = (ca.actions as Record<string, { frames: number; fps: number }> | undefined)?.attack1 ?? (ca.actionsRed as Record<string, { frames: number; fps: number }> | undefined)?.attack1;
    const len = act ? (act.frames / act.fps) * 1000 : HS;
    const sinceHit = (f.battle.tick - u.lastHitTick) * 50 + f.alpha * 50;
    if (u.lastHitTick >= 0 && sinceHit < len - af) return af + sinceHit;
    if (!u.locked && !u.hitStarted) return null;
    const until = HS - (u.atkTimer % HS) - f.alpha * 50;
    if (until <= af) return Math.max(0, af - until);
    return null;
  }

  /** Visual arc height of a projectile (A: parabola scaled by the data's Gravity). */
  private projectileZ(p: Projectile, x: number, y: number): number {
    const pa = this.art.manifest.projectiles[p.def.name];
    const g = (pa?.gravity as number | undefined) ?? 0;
    const total = Math.hypot(p.tx - p.startX, p.ty - p.startY) || 1;
    const done = Math.min(total, Math.hypot(x - p.startX, y - p.startY));
    const q = done / total;
    const z0 = p.spell ? 3500 : 900;
    const base = z0 * (1 - q) + 300 * q;
    return base + (total * g) / 1500 * 4 * q * (1 - q);
  }
}

export type { Mat };
