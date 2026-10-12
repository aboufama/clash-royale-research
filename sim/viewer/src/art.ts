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
  type Battle, KING_ACTIVATING, KING_INACTIVE, type Projectile, ST_DEAD, ST_DEPLOYING, TOWER_KING, TOWER_NONE, TOWER_PRINCESS,
  type Unit,
} from '../../core/src/index.ts';
import type { Camera } from './camera.ts';
import type { Frame, WorldRenderer } from './frame.ts';
import type { ArtHooks } from './main.ts';
import {
  actionFrameMs, animate, animateBuilding, type AnimFrame, type AnimState, BattleArt, type BuildingAnim, ClipPlayer, EffectPlayer,
  type Mat, nativeAngle, newAnimState, newBuildingAnim, ScRenderer,
} from './sc/index.ts';
import { arcHeight, isRolling, newProjectileViewState, projectileView } from './sc/projectile_view.ts';
import { BattleUi } from './battle_ui.ts';
import type { ProjectileViewFrame, ProjectileViewState } from './sc/projectile_view.ts';

type Team = 0 | 1;

/** Per engine projectile: the client's projectile view (sc/projectile_view.ts, 0x8545e0 / 0x8554b0). */
interface ProjView {
  name: string;
  state: ProjectileViewState;
  /** logic height this tick and last tick, and the tick they belong to */
  z: number;
  prevZ: number;
  tick: number;
  startX: number;
  startY: number;
  /** estimated start/aim heights when the engine stores no z (0xf8e4c8 / 0xf9f47c) */
  startZ: number;
  /** clip running on its own timeline (rolling projectiles), ms since the view was made */
  clip: ClipPlayer | null;
  ageMs: number;
  /** this frame's view, drawn position and height (logic) */
  v: ProjectileViewFrame | null;
  x: number;
  y: number;
  /** attached TrailEffect (0x8545e0 → 0x82dcb0, follows the sprite) */
  trail: number;
  seen: boolean;
}

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
      const world = new ArtWorld(art, r, cam, canvas);
      await world.ui.load();
      return world;
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
  /** Client view state per unit (sc/anim.ts) and this frame's chosen sprite. */
  private anims = new Map<number, AnimState>();
  private sprites = new Map<number, AnimFrame | null>();
  /** Single-clip buildings (sc/anim.ts animateBuilding): clip player per unit, this frame's frame,
   * and collections seen since the last frame. */
  private bAnims = new Map<number, BuildingAnim>();
  private clipFrames = new Map<number, number>();
  private collected = new Set<number>();
  /** facing at each unit's path search since the last frame (engine 'path' events) */
  private pathFacing = new Map<number, [number, number]>();
  /** King activation controller 0x8643a0 per King tower: the tower and King clips (same labels and
   * length, so one player) and whether it has started. */
  private kingClips = new Map<number, { clip: ClipPlayer; activated: boolean }>();
  private lastSim = -1;
  /** Hit filter per unit (direction picked from the hit vector, sim ms it started) and hits seen. */
  private hits = new Map<number, { dir: 'down' | 'left' | 'up' | 'right'; start: number }>();
  private hitVec = new Map<number, [number, number]>();
  /** Client projectile views by engine projectile id. */
  private projViews = new Map<number, ProjView>();
  private lastFxSim = -1;
  /** In-battle UI: HUD, illegal-area overlay, drag preview, deploy timers (battle_ui.ts). */
  readonly ui: BattleUi;
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
    this.ui = new BattleUi(art);
    cam.aspectY = art.yScale;
    cam.mirrorX = art.flip; // the blue player's native view runs logic x right-to-left
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // The client's stage and battle layer placement (sc/ui_port.ts stageLayout: content scale
    // 0x772a70, battle layer scale/position 0xbdefac); the camera maps input with the same transform.
    this.ui.resize(width, height);
    const L = this.ui.layout;
    this.s = L.k * L.battleScale;
    this.vx = L.k * L.battleX;
    this.vy = L.k * L.battleY;
    const fl = this.art.flip ? -1 : 1;
    const [x0, y0] = this.art.gameToPx(0, 0);
    this.cam.setAffine(this.s * 0.03 * fl, this.vx + this.s * x0, this.s * 0.024 * fl, this.vy + this.s * y0);
    this.cam.fit(width, height, dpr);
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
      } else if (e.type === 'hit' || e.type === 'impact') {
        // hit vector for the damage filter: melee = victim - attacker, projectile = travel direction
        // into the impact point (or impact -> victim for splash)
        const src = e.type === 'hit' ? b.units.find((q) => q.id === e.id) : null;
        const pp = e.type === 'impact' ? f.prevPos.get(e.id) : undefined;
        for (const v of b.units) {
          if (v.lastHurtTick !== b.tick || v.team === e.team) continue;
          let dx = 0, dy = 0;
          if (src) {
            if (v.x !== e.x || v.y !== e.y) continue;
            dx = v.x - src.x; dy = v.y - src.y;
          } else {
            dx = v.x - e.x; dy = v.y - e.y;
            if (!dx && !dy && pp !== undefined) { dx = e.x - Math.floor(pp / 65536); dy = e.y - (pp % 65536); }
          }
          if (dx || dy) this.hitVec.set(v.id, [dx, dy]);
        }
      }
      if (e.type === 'hit') {
        const u = b.units.find((q) => q.id === e.id);
        const ca = u ? m.characters[u.def.name] : null;
        const eff = ca?.effects?.damageEffect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'shoot') {
        const u = b.units.find((q) => q.id === e.id);
        const ca = u ? m.characters[u.def.name] : null;
        const eff = (ca?.effects?.projectileEffect ?? ca?.effects?.attackStartEffect) as string | undefined;
        if (u && eff && this.fx.has(eff)) this.fx.play(eff, u.x, u.y, { team });
      }
      if (e.type === 'impact') {
        // HitEffect at the aim point, z = the projectile's height on arrival (0 unless ConstantHeight),
        // angle = the start -> hit direction (0xf9188c -> 0xf8f978 -> world listener vt+0x48 0x850258)
        const pv = this.projViews.get(e.id);
        const p = (pv ? m.projectiles[pv.name] : undefined) ?? m.projectiles[e.name] ??
          (m.spells[e.name] ? m.projectiles[m.spells[e.name].projectile ?? ''] : undefined);
        const eff = p?.hitEffect;
        const ang = pv && (e.x !== pv.startX || e.y !== pv.startY) ? nativeAngle(e.x - pv.startX, e.y - pv.startY) : 0;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team, angle: ang });
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
      } else if (e.type === 'appear' || e.type === 'hide') {
        // view vt+0x80 with AppearEffect (0xf8247c) / HideEffect (0xf81b3c)
        const eff = m.characters[e.name]?.effects?.[e.type === 'appear' ? 'appearEffect' : 'hideEffect'] as string | undefined;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'collect') {
        this.collected.add(e.id);
      } else if (e.type === 'path') {
        if (!this.pathFacing.has(e.id)) this.pathFacing.set(e.id, [e.x, e.y]);
      } else if (e.type === 'cast') {
        const sp = m.spells[e.name];
        const eff = sp?.effect;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      }
    }
    this.ui.onEvents(b);
  }

  // ---------------------------------------------------------------- frame

  draw(f: Frame): void {
    const art = this.art;
    const r = this.r;
    const b = f.battle;
    const m = art.manifest;
    const now = f.now;
    this.lastNow = now;
    const sim = f.simMs;
    // projectile views first (0x8554b0), so attached trails follow this frame's sprite position; the
    // effects then advance on simulation time (pausing freezes them, speed scales them)
    this.updateProjectiles(f);
    const fxDt = this.lastFxSim < 0 ? 0 : Math.min(250, Math.max(0, sim - this.lastFxSim));
    this.lastFxSim = sim;
    this.fx.update(fxDt);
    // screen shake of the battle layer (0x856f28), in SC px
    const [shx, shy] = this.fx.shakeOffset(fxDt / 1000);
    this.updateAnims(f, sim);
    this.ui.update(fxDt / 1000, f);
    const dpr = this.cam.dpr;

    r.begin([0.05, 0.08, 0.05, 1]);
    r.setView(this.s * dpr, 0, 0, this.s * dpr, (this.vx + this.s * shx) * dpr, (this.vy + this.s * shy) * dpr);
    art.drawBackground(r);
    art.drawArenaObjects(r, sim, ['Base']);
    // destroyed towers leave the game's rubble on the ground layer
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state !== ST_DEAD) continue;
      const kind = u.tower === TOWER_KING ? 'king' : u.x < 9000 ? 'princessLeft' : 'princessRight';
      art.drawTowerRuin(r, kind, u.team as Team);
    }
    // effect layers in the client's order (0xe22490 / 0x856f28): Base (3) under the shadow composite
    // (4), then Ground (8), GroundAbility (9), Object (10, sorted with the actors), Above (11)
    this.fx.draw(r, 'Base');
    // stop area-effect visuals whose engine object has expired
    if (this.aeoFx.size) {
      for (const [id, h] of this.aeoFx) if (!b.areaEffects.some((q) => q.id === id)) { h.stop(); this.aeoFx.delete(id); }
    }

    // shadow layer: decorations, crown towers, units (one silhouette buffer, one composite)
    r.beginShadows();
    art.drawArenaShadows(r, sim);
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state === ST_DEAD) continue;
      const team = u.team as Team;
      if (u.tower === TOWER_KING) {
        art.drawTowerShadow(r, 'king', team, sim, this.kingClips.get(u.id)?.clip.frame);
      } else {
        const aim = u.target ? Math.atan2(u.target.y - u.y, u.target.x - u.x) : undefined;
        art.drawTowerShadow(r, u.x < 9000 ? 'princessLeft' : 'princessRight', team, sim, undefined, aim,
          this.sprites.get(u.id) ?? undefined);
      }
    }
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling) continue;
      const ca = m.characters[u.def.name];
      if (!ca) continue;
      const st = this.unitState(u, f);
      art.drawUnitShadow(r, u.def.name, u.team as Team, f.ux(u), f.uy(u), st.action, st.angle, st.ms,
        { sprite: this.sprites.get(u.id) ?? undefined, clipFrame: this.clipFrames.get(u.id) });
    }
    // projectile shadows go into the same silhouette (0x855304 -> 0x856a40)
    for (const p of b.projectiles) {
      const pv = this.projViews.get(p.id);
      if (pv?.v) art.drawProjectileShadow(r, pv.name, p.team as Team, pv.x, pv.y, pv.v);
    }
    // drag preview ghosts are real actor views: their shadows join the silhouette buffer (A)
    const ghosts = this.ui.ghostUnits().filter((g) => m.characters[g.def.name]);
    for (const g of ghosts) art.drawUnitShadow(r, g.def.name, g.team, g.x, g.y, 'idle', g.angle, 0);
    this.fx.draw(r, 'Shadow');
    art.endShadowPass(r);
    // battle layer child 7 (after the shadow composite, before Ground effects): the illegal-area
    // overlay (0x86a610), then the drag preview's ground parts (container layer A)
    this.ui.drawArea(r);
    this.ui.drawPreviewGround(r);
    this.fx.draw(r, 'Ground');
    this.fx.draw(r, 'GroundAbility');

    const items: DrawItem[] = [];
    const ypx = (x: number, y: number, z = 0) => art.gameToPx(x, y, z)[1];

    // towers
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state === ST_DEAD) continue;
      const team = u.team as Team;
      const dead = false;
      const py = ypx(u.x, u.y);
      if (u.tower === TOWER_KING) {
        const kf = this.kingClips.get(u.id)?.clip.frame;
        const aim = u.target && u.kingState !== KING_INACTIVE ? Math.atan2(u.target.y - u.y, u.target.x - u.x) : undefined;
        const face: [number, number] = [u.dirX, u.dirY];
        const since = u.lastHitTick >= 0 ? (b.tick - u.lastHitTick + f.alpha) * 0.05 : 1e9;
        items.push({ y: py, draw: () => art.drawKingTower(r, team, sim, kf, aim, dead, face, since) });
      } else {
        const side = u.x < 9000 ? 'princessLeft' : 'princessRight';
        const atk = this.attackPhase(u, f);
        const aim = u.target ? Math.atan2(u.target.y - u.y, u.target.x - u.x) : team === 0 ? Math.PI / 2 : -Math.PI / 2;
        const sp = this.sprites.get(u.id) ?? undefined;
        items.push({ y: py, draw: () => art.drawPrincessTower(r, team, side, sim, atk === null ? 'idle' : 'attack', aim, atk ?? sim, dead, sp) });
      }
    }
    // arena decorations on the object layer
    for (const o of m.arena.objects) {
      if (o.layer !== 'Object') continue;
      const [px, py] = art.decoPx(o);
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
      // sort key: ground-projected y, +48 px when z > 0 (0x851b84: actor vt+0x108 = z > 0)
      const py = ypx(x, y) + (flying ? 48 : 0);
      const buffs = u.buffs.length ? u.buffs.map((q) => ({ name: q.def.name, ms: (b.tick - q.startTick) * 50 + f.alpha * 50 })) : undefined;
      const hit = this.hits.get(u.id);
      const damage = hit ? { dir: hit.dir, ms: sim - hit.start } : undefined;
      const o: Parameters<BattleArt['drawUnit']>[8] = { deployMs: st.deployMs, buffs, damage, sprite: this.sprites.get(u.id) ?? undefined,
        face: [u.dirX, u.dirY], sinceAttackS: u.lastHitTick >= 0 ? (b.tick - u.lastHitTick + f.alpha) * 0.05 : 1e9,
        clipFrame: this.clipFrames.get(u.id) };
      items.push({ y: py, draw: () => { art.drawUnit(r, u.def.name, team, x, y, st.action, st.angle, st.ms, o); } });
    }
    // projectiles: Object layer, sorted by the ground-projected y like the actors (setPos3D 0x851b84;
    // the +48 for z > 0 applies to characters only); HideWhenDelayed hides the sprite (not its shadow)
    // while the start delay runs (0x855078)
    for (const p of b.projectiles) {
      const pv = this.projViews.get(p.id);
      const v = pv?.v;
      if (!pv || !v) continue;
      const pa = m.projectiles[pv.name];
      if (pa?.hideWhenDelayed && p.delay > 0) continue;
      const team = p.team as Team;
      const fps = pa?.fps || 30;
      const clipFrame = pv.clip ? pv.clip.frame : 0;
      const child = Math.floor((pv.ageMs * fps) / 1000);
      const x = pv.x, y = pv.y;
      items.push({ y: ypx(x, y), draw: () => art.drawProjectileView(r, pv.name, team, x, y, v, clipFrame, child) });
    }
    for (const it of this.fx.collect('Object')) items.push({ y: it.sortY, draw: () => it.draw(r) });
    // drag preview ghost units, sorted with the actors
    for (const g of ghosts) {
      const py = ypx(g.x, g.y) + (g.def.flyingHeight > 0 ? 48 : 0);
      items.push({ y: py, draw: () => { art.drawUnit(r, g.def.name, g.team, g.x, g.y, 'idle', g.angle, 0, { alpha: g.alpha }); } });
    }
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    this.fx.draw(r, 'Above');

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
    // HUD layer (battle screen +0x300): HUD elements, deploy timers (0x8d9748) and the drag name text
    this.ui.drawStage(r, dpr);
    r.end();
  }

  /**
   * Run the client's character view update (sc/anim.ts, FUN_00840d44) for every unit with direction
   * clips, and for the princess on each Princess tower (an attached character driven by the tower).
   */
  private updateAnims(f: Frame, sim: number): void {
    const b = f.battle;
    const m = this.art.manifest;
    const dt = this.lastSim < 0 ? 0 : Math.max(0, (sim - this.lastSim) / 1000);
    this.lastSim = sim;
    this.sprites.clear();
    const seen = new Set<number>();
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.tunneling) continue;
      let ca = m.characters[u.def.name];
      if (u.tower === TOWER_PRINCESS) ca = m.characters[m.towers.princess.character as string];
      else if (u.tower !== TOWER_NONE) continue;
      if (!ca || !ca.actions || !Object.keys(ca.actions).length) continue;
      let s = this.anims.get(u.id);
      if (!s) { s = newAnimState(); this.anims.set(u.id, s); }
      seen.add(u.id);
      const walker = u.def.speed > 0 && !u.isBuilding && u.tower === TOWER_NONE;
      const state = u.state === ST_DEPLOYING ? 4 : u.jumping ? 5 : u.locked ? 2 : walker ? 1 : 0;
      this.sprites.set(u.id, animate(ca, u.team as Team, s, {
        state, dirX: u.dirX, dirY: u.dirY, id: u.id, walker, charge: u.charge,
        walk: u.walkMs, walkPrev: f.prevWalk.get(u.id) ?? u.walkMs,
        atk: u.atkTimer, atkPrev: f.prevAtk.get(u.id) ?? u.atkTimer, finish: u.finishMs,
        alpha: f.alpha, dt, clock: sim / 1000, flip: this.art.flip,
        // the tower princess swings on the Princess tower's attack timer (A: the attached actor's own
        // attack component is not modelled)
        hitSpeed: u.tower === TOWER_PRINCESS ? u.def.hitSpeed : undefined,
        pathFacing: this.pathFacing.get(u.id),
      }));
    }
    this.pathFacing.clear();
    for (const id of this.anims.keys()) if (!seen.has(id)) this.anims.delete(id);
    // buildings drawn from one labelled clip (no anim set, no turret): the client's clip player
    this.clipFrames.clear();
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.tunneling || u.tower !== TOWER_NONE) continue;
      const ca = m.characters[u.def.name];
      const clip = u.team === 1 ? (ca?.clip?.red ?? ca?.clip?.blue) : ca?.clip?.blue;
      if (!ca || !clip || clip.turretChild) continue;
      const lib = this.art.lib(ca.sc);
      const labels = lib.labels(clip.export);
      let s = this.bAnims.get(u.id);
      if (!s) { s = newBuildingAnim(ca, labels, clip.frames, clip.fps || 30); this.bAnims.set(u.id, s); }
      seen.add(u.id);
      this.clipFrames.set(u.id, animateBuilding(ca, u.def.name, labels, s, {
        state: u.state === ST_DEPLOYING ? 4 : u.locked ? 2 : 0, deployLeft: u.deployTicks * 50,
        deployTime: (ca.deployTime as number | undefined) ?? u.deployTotal * 50, hideT: u.hideT, manaT: u.manaT,
        collected: this.collected.has(u.id), dt,
      }));
    }
    this.collected.clear();
    for (const id of this.bAnims.keys()) if (!seen.has(id)) this.bAnims.delete(id);
    // King activation (0x864224 setup, 0x8643a0 per frame): idle while the INACTIVE tag is set; when it
    // clears (activation begins) the clips play start..stop once (no start delay outside 2v2); a King
    // already active when its view is made jumps to stop
    const kt = m.towers.king;
    for (const u of b.units) {
      if (u.tower !== TOWER_KING || u.state === ST_DEAD) continue;
      const labels = this.art.lib(kt.sc).labels(u.team === 0 ? kt.blue : kt.red);
      const idle = labels.idle ?? 0, start = labels.start ?? 1, stop = labels.stop ?? kt.frames - 1;
      let c = this.kingClips.get(u.id);
      if (!c) {
        const clip = new ClipPlayer(kt.frames, kt.fps || 30);
        const active = u.kingState !== KING_INACTIVE && u.kingState !== KING_ACTIVATING;
        clip.gotoAndStop(active ? stop : idle);
        c = { clip, activated: active };
        this.kingClips.set(u.id, c);
      }
      const inactive = u.kingState === KING_INACTIVE;
      if (!inactive && !c.activated) { c.activated = true; c.clip.playRange(start, stop, false); }
      else if (inactive && c.activated) { c.activated = false; c.clip.gotoAndStop(idle); }
      c.clip.advance(dt);
    }
    // damage filter (0x83e3d8): quadrant of the hit vector's native angle, offset 135 (flipped view)
    // or 315 degrees: 0 _down, 1 _left, 2 _up, 3 _right; restarts on every hit
    const dirs = ['down', 'left', 'up', 'right'] as const;
    for (const [id, v] of this.hitVec) {
      const a = nativeAngle(v[0], v[1]);
      const q = Math.trunc((((a + (this.art.flip ? 135 : 315) + 360) % 360)) / 90);
      this.hits.set(id, { dir: dirs[q], start: b.tick * 50 });
    }
    this.hitVec.clear();
    for (const [id, h] of this.hits) if (sim - h.start > 5000 || !b.units.some((q) => q.id === id)) this.hits.delete(id);
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

  /**
   * The client's projectile views (sc/projectile_view.ts): made when a projectile appears (TrailEffect
   * attached, following the drawn sprite), updated every frame from the engine's logic position and
   * height (Projectile z, or the ported arc 0xf927ec when the engine has none), dropped when the
   * projectile is gone (its trail then stops; a rolling projectile plays its DeathEffect).
   */
  private updateProjectiles(f: Frame): void {
    const b = f.battle;
    const m = this.art.manifest;
    for (const pv of this.projViews.values()) pv.seen = false;
    this.frame = f;
    const dt = this.lastProjSim < 0 ? 0 : Math.max(0, f.simMs - this.lastProjSim);
    this.lastProjSim = f.simMs;
    for (const p of b.projectiles) {
      const pa = m.projectiles[p.def.name];
      if (!pa || !pa.sc || !pa.export) continue;
      let pv = this.projViews.get(p.id);
      const ez = (p as unknown as { z?: number }).z;
      if (!pv) {
        const startZ = typeof (p as unknown as { startZ?: number }).startZ === 'number'
          ? (p as unknown as { startZ: number }).startZ : this.estimateStartZ(p, b);
        const z0 = typeof ez === 'number' ? ez : startZ;
        const frames = Math.max(1, pa.frames ?? 1);
        pv = {
          name: p.def.name, state: newProjectileViewState(), z: z0, prevZ: z0, tick: b.tick,
          startX: p.startX, startY: p.startY, startZ,
          clip: null, ageMs: 0, v: null, x: p.x, y: p.y, trail: 0, seen: true,
        };
        if (isRolling(pa)) pv.clip = new ClipPlayer(frames, pa.fps || 30);
        this.projViews.set(p.id, pv);
        const trail = pa.trailEffect;
        if (trail && this.fx.has(trail)) {
          const view = pv;
          const fdx = p.tx - p.startX, fdy = p.ty - p.startY;
          const flight = fdx || fdy ? nativeAngle(fdx, fdy) : 0;
          view.trail = this.fx.play(trail, p.x, p.y, {
            team: p.team as Team, z: z0,
            follow: () => (this.projViews.get(p.id) === view && view.v ? [view.x, view.y, view.v.height / 0.002] : null),
            parentAngle: () => flight,
          });
        }
      } else {
        pv.ageMs += dt;
        if (pv.clip) pv.clip.advance(dt / 1000);
      }
      pv.seen = true;
      // logic height of this tick and the last one (the actor's +0x8c / +0x90)
      if (pv.tick !== b.tick) {
        pv.prevZ = pv.tick === b.tick - 1 ? pv.z : this.logicZ(p, pv, true);
        pv.z = typeof ez === 'number' ? ez : this.logicZ(p, pv, false);
        pv.tick = b.tick;
      }
      // the angle aims at the homing target's current position, else the aim point (0xf8fc44 / 0xf8fc88)
      const t = p.target;
      const live = t && pa.homing && t.state !== ST_DEAD;
      const tx = live ? t.x : p.tx, ty = live ? t.y : p.ty;
      pv.x = f.px(p);
      pv.y = f.py(p);
      pv.v = projectileView(pa, Math.max(1, pa.frames ?? 1), pv.state, {
        x: p.x, y: p.y, tx, ty, z: pv.z, prevZ: pv.prevZ, alpha: f.alpha,
        distFromStart: Math.hypot(pv.x - pv.startX, pv.y - pv.startY),
        flip: this.art.flip, own: p.team === 0, name: pv.name,
      });
    }
    for (const [id, pv] of this.projViews) {
      if (pv.seen) continue;
      this.projViews.delete(id);
      // a rolling projectile ends with its DeathEffect where it stopped (A: the death call site is not traced)
      const pa = m.projectiles[pv.name];
      const de = pa?.deathEffect;
      if (de && this.fx.has(de)) {
        const ang = nativeAngle(pv.x - pv.startX, pv.y - pv.startY);
        this.fx.play(de, pv.x, pv.y, { team: 0, angle: pv.x !== pv.startX || pv.y !== pv.startY ? ang : 0 });
      }
    }
  }
  private lastProjSim = -1;

  /** Logic height by the arc 0xf927ec from the engine's start/aim (fallback when Projectile has no z). */
  private logicZ(p: Projectile, pv: ProjView, prev: boolean): number {
    const pa = this.art.manifest.projectiles[pv.name];
    let x = p.x, y = p.y;
    if (prev) {
      const q = this.frame?.prevPos.get(p.id);
      if (q !== undefined) { x = Math.floor(q / 65536); y = q % 65536; }
    }
    const t = p.target;
    const homing = !!pa?.homing && !!t;
    const aimZ = homing && t ? t.def.flyingHeight : 0;
    return arcHeight(p.startX, p.startY, pv.startZ, p.tx, p.ty, aimZ, x, y, (pa?.speed as number | undefined) ?? p.def.speed,
      (pa?.gravity as number | undefined) ?? 0);
  }
  private frame: Frame | null = null;

  /**
   * Start height when the engine gives none: shooter z + ProjectileStartZ (0xf8e4c8); spells from the
   * King tower 3 × its CollisionRadius, SpellAsDeploy 5 × (0xf9f47c); spawned projectiles 0.
   */
  private estimateStartZ(p: Projectile, b: Frame['battle']): number {
    const m = this.art.manifest;
    if (Object.values(m.projectiles).some((q) => q.spawnProjectile === p.def.name)) return 0;
    if (p.spell) {
      const king = b.players[p.team]?.king;
      const r = king?.radius || m.towers.king.collisionRadius || 1400;
      return r * 3;
    }
    const u = b.units.find((q) => q.id === p.sourceId);
    if (!u) return 0;
    let z0 = 0;
    if (u.tower === TOWER_KING) z0 = m.towers.king.projectileStartZ ?? 0;
    else if (u.tower === TOWER_PRINCESS) z0 = m.towers.princess.projectileStartZ ?? 0;
    else z0 = (m.characters[u.def.name]?.projectileStartZ as number | undefined) ?? 0;
    return u.def.flyingHeight + z0;
  }
}

export type { Mat };
