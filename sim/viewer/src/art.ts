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
  /** Client view state per unit (sc/anim.ts) and this frame's chosen sprite. */
  private anims = new Map<number, AnimState>();
  private sprites = new Map<number, AnimFrame | null>();
  /** Single-clip buildings (sc/anim.ts animateBuilding): clip player per unit, this frame's frame,
   * and collections seen since the last frame. */
  private bAnims = new Map<number, BuildingAnim>();
  private clipFrames = new Map<number, number>();
  private collected = new Set<number>();
  /** King activation controller 0x8643a0 per King tower: the tower and King clips (same labels and
   * length, so one player) and whether it has started. */
  private kingClips = new Map<number, { clip: ClipPlayer; activated: boolean }>();
  private lastSim = -1;
  /** Hit filter per unit (direction picked from the hit vector, sim ms it started) and hits seen. */
  private hits = new Map<number, { dir: 'down' | 'left' | 'up' | 'right'; start: number }>();
  private hitVec = new Map<number, [number, number]>();
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
    cam.mirrorX = art.flip; // the blue player's native view runs logic x right-to-left
    // Width: the client's stage is 1024 / min(h/w, 1.77) SC px wide (content scale 0x772a70), i.e.
    // 578.5 px on any phone taller than 16:9, centred on the battle layer (cloud wrap 0x85751c);
    // 0.03 px per unit -> +-9642 units around x = 9000. Height: the field plus a stadium margin.
    const half = 1024 / 1.77 / 2 / 0.03;
    cam.world = { x0: 9000 - half, y0: -2200, x1: 9000 + half, y1: 32800 };
  }

  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.cam.fit(width, height, dpr);
    // Derive the SC-pixel view from the camera: gameToPx is affine with the same scales.
    this.s = (this.cam.scaleX * 1000) / this.art.pxPerTileX;
    const [px, py] = this.art.gameToPx(9000, 16000);
    this.vx = this.cam.sx(9000) - this.s * px;
    this.vy = this.cam.sy(16000) - this.s * py;
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
      } else if (e.type === 'appear' || e.type === 'hide') {
        // view vt+0x80 with AppearEffect (0xf8247c) / HideEffect (0xf81b3c)
        const eff = m.characters[e.name]?.effects?.[e.type === 'appear' ? 'appearEffect' : 'hideEffect'] as string | undefined;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'collect') {
        this.collected.add(e.id);
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
    this.updateAnims(f, sim);
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
    this.fx.draw(r, 'Shadow');
    art.endShadowPass(r);
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
      }));
    }
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
