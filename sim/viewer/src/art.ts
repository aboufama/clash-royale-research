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
import type { SummonSpec } from '../../core/src/data.ts';
import { formationOffset } from '../../core/src/formation.ts';
import { idiv, isqrt } from '../../core/src/math.ts';
import type { Camera } from './camera.ts';
import type { Frame, WorldRenderer } from './frame.ts';
import type { ArtHooks } from './main.ts';
import {
  actionFrameMs, animate, animateBuilding, type AnimFrame, type AnimState, BattleArt, type BuildingAnim, ClipPlayer, EffectPlayer,
  type Mat, nativeAngle, newAnimState, newBuildingAnim, ScRenderer,
} from './sc/index.ts';
import { ghostSprite } from './sc/anim.ts';
import { arcHeight, isRolling, newProjectileViewState, projectileView } from './sc/projectile_view.ts';
import { condMask, deployElapsed, healthBarState, newBarChoose, newBarFrame, newBarView, SUMMON_WAIT_ALPHA,
  summonViewDelay } from './sc/unit_view.ts';
import type { BarPartRef, HealthBarFlags, NewBarView } from './sc/unit_view.ts';
import { BattleUi } from './battle_ui.ts';
import { Clouds } from './sc/clouds.ts';
import { UnitFx } from './sc/unit_fx.ts';
import { applyPanelSkin } from './panel_skin.ts';
import type { ProjectileViewFrame, ProjectileViewState } from './sc/projectile_view.ts';
import { applyFilterColor, AreaViews, BuffViews } from './sc/area_view.ts';
import { CharEffects, deathSpawnFilter } from './sc/char_effects.ts';
import type { Col } from './sc/math.ts';
import type { ClipRef } from './sc/manifest.ts';

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
  /** p->shooter (+0xf0): an out-and-back projectile back without it plays its PingpongDeathEffect */
  shooter: Unit | null;
  team: Team;
}

/**
 * Character view state this port keeps beside sc/anim.ts (sc/unit_view.ts): the health bar container's
 * clip (+0x618 on +0x460 or +0x468), the summon reveal (+0xa28 delay, container alpha, 0x846b2c /
 * 0x840d44) and the deploy filter slot's start (+0x4c0 / +0x4c8).
 */
interface UnitView {
  barSwapped: boolean;
  /** made by a cast's Deploy_summon 0xd423bc (index i = actor +0x194, the member's DeployTime ms) */
  summon: boolean;
  index: number;
  deployTime: number;
  /** vt+0x138 delay and whether the container waits at SUMMON_WAIT_ALPHA for it */
  delay: number;
  waiting: boolean;
  /** in state 11 (summon delay) last frame */
  wasWaiting: boolean;
  /** sim ms the deploy filter started (null: none) */
  filterStart: number | null;
  /** the filter clip vt+0x140 gave a death spawn (0xf8aac8; null: none); undefined: the unit's own */
  filter?: ClipRef | null;
  /** client-action health bar state (view +0x610 / +0x614 and the component, sc/unit_view.ts) */
  nb: NewBarView | null;
  /** its root sprite x and each badge clip's frame (stopped, or playing its intro from `playFrom` sim ms) */
  nbRootX: number;
  nbBadges: Map<number, { frame: number; playFrom: number | null }>;
}

/** A character's client-action health bar parts (OnStartingClientActions -> ClientActionAddHealthBarPart). */
interface NewBarPartSpec extends BarPartRef {
  blue: string;
  red: string;
  offset: [number, number];
  intro: boolean;
}
interface NewBarSpec {
  /** NewHealthBarOffsetX + NewHealthBarOffsetXBlue / Red (0xde1668: own / enemy) */
  base: [number, number];
  badges: NewBarPartSpec[];
  bars: NewBarPartSpec[];
}

/** The cast whose Deploy_summon 0xd423bc spawns follow in this step's events. */
interface CastCtx { tick: number; team: number; card: string; x: number; y: number; next: number }

export function createArt(_manifest: unknown): ArtHooks {
  const thumbs = new Map<string, string>();
  let artRef: BattleArt | null = null;
  const pending = new Set<string>();
  return {
    async makeRenderer(canvas: HTMLCanvasElement, cam: Camera): Promise<WorldRenderer | null> {
      const art = await BattleArt.load('assets');
      artRef = art;
      await art.prewarm(pending);
      for (const [fam, url] of Object.entries(art.manifest.fonts ?? {})) {
        try {
          const ff = new FontFace(fam, `url(assets/${url})`);
          await ff.load();
          (document.fonts as unknown as { add(f: FontFace): void }).add(ff);
        } catch (err) {
          console.warn('font', fam, err);
        }
      }
      // the simulator panel wears the game's ui_common buttons and popup bodies
      try { applyPanelSkin(art); } catch (err) { console.warn('panel skin', err); }
      // original card art (frame + icon + elixir cost) for the DOM hands and palette
      await Promise.all(Object.keys(art.manifest.cards).map(async (card) => {
        try { thumbs.set(card, await art.cardThumbnail(card, 120)); } catch (err) { console.warn('card', card, err); }
      }));
      // the visible canvas is redrawn every frame: no preserved drawing buffer (a full-screen copy per
      // frame on mobile GPUs; nothing reads it back) and no MSAA (sprite edges come from texture alpha:
      // renders with and without it match, minus a multisample resolve per frame)
      const r = new ScRenderer(canvas, { preserveDrawingBuffer: false, antialias: false });
      r.clearTextCache();
      r.textTable = art.manifest.hud.texts ?? null;
      // upload the loaded atlases up front, and each later library as it arrives: a card's first
      // appearance would otherwise stall that frame on the upload
      for (const lib of art.libs.loaded()) r.preload(lib);
      art.onLibLoaded = (lib) => r.preload(lib);
      const world = new ArtWorld(art, r, cam, canvas);
      await world.ui.load();
      return world;
    },
    cardImage(card: string): string | null {
      return thumbs.get(card) ?? null;
    },
    prewarm(names: Iterable<string>): void {
      if (artRef) void artRef.prewarm(names);
      else for (const n of names) pending.add(n);
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
  /** Area-effect object views (0x833b84) and buff views (0x8348c8), sc/area_view.ts. */
  private areaViews: AreaViews;
  private buffViews: BuffViews;
  /** character / building view effects beyond the ones here (sc/char_effects.ts, docs/EFFECTS.md) */
  private charFx: CharEffects;
  /** actors that effects with Filter components may recolour this frame */
  private filterParents = new Set<number>();
  /** Client view state per unit (sc/anim.ts) and this frame's chosen sprite. */
  private anims = new Map<number, AnimState>();
  /** footstep effects of the character view update (sc/unit_fx.ts) */
  private unitFx = new UnitFx();
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
  /** Character view state per unit (health bar clip, summon reveal, deploy filter). */
  private views = new Map<number, UnitView>();
  private cast: CastCtx | null = null;
  /** Projectiles whose shooter effect has played (0xfc619c -> 0xf85244, once per projectile). */
  private muzzled = new Set<number>();
  /** This step's damage direction per victim (the Damage_enqueue vector: health +0x18 on the lethal entry). */
  private stepVec = new Map<number, [number, number]>();
  /** Actors by id as of the last onEvents (plus this step's), so a death can read the dead actor. */
  private byId = new Map<number, Unit>();
  /** Projectiles by id as of the last onEvents (a projectile spawn's own one left the world this step). */
  private projById = new Map<number, Projectile>();
  /** location cloud shadows (battle layer 11), built for each battle */
  private clouds: Clouds | null = null;
  private cloudsFor: unknown = null;
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
    this.areaViews = new AreaViews(this.fx, art.manifest, art.flip);
    this.buffViews = new BuffViews(this.fx, art.manifest, art.flip);
    this.charFx = new CharEffects({
      fx: this.fx, manifest: art.manifest, flip: art.flip, lib: (n) => art.lib(n),
      spritePos: (u) => {
        const fr = this.frame;
        return fr && fr.battle.units.includes(u) && u.state !== ST_DEAD ? [fr.ux(u), fr.uy(u), fr.uz(u)] : null;
      },
      sprite: (u) => this.sprites.get(u.id),
      isWater: (x, y) => this.frame?.battle.arena.isWaterAt(x, y) ?? false,
      tunnelEnd: (u) => {
        // vt+0x170 0x845a8c -> vt+0x138(0): the summon reveal (UseAnimator) or its SpawnEffect now
        const v = this.views.get(u.id) ?? this.newView(u);
        v.summon = true;
        v.index = 0;
        v.deployTime = u.deployTotal * 50;
        v.filterStart = null;
        this.viewDelay(u, v, 0);
      },
    });
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
    this.stepVec.clear();
    this.battleState(b);
    // actors of the last step and this one: one that died this step has left b.units but keeps its state
    for (const u of b.units) this.byId.set(u.id, u);
    for (const e of b.events) {
      const team = e.team as Team;
      if (e.type === 'spawn') {
        this.onSpawn(b, e.id, e.name, team, e.x, e.y, e.tick, e.src, e.pid);
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
      if (e.type === 'hit' || e.type === 'shoot') {
        // AttackComp_execute 0xfc619c: TargetedHitEffect (view vt+0x90) and a melee splash's DamageEffect
        // at its centre (sc/char_effects.ts); the victims' effects come with the 'damage' events
        this.charFx.onAttack(e.tick, this.byId.get(e.id), e.src !== undefined ? this.byId.get(e.src) : undefined,
          e.type === 'hit', e.fx === 1, e.x, e.y);
      } else if (e.type === 'damage') {
        this.charFx.onDamage(e.tick, this.byId.get(e.id), e.fx ?? 0, e.name, e.src !== undefined ? this.byId.get(e.src) : undefined);
      } else if (e.type === 'shieldLost') {
        this.charFx.onShieldLost(this.byId.get(e.id));
      }
      if (e.type === 'hit') {
        const u = b.units.find((q) => q.id === e.id);
        // single-target melee (0xfc7080): the damage carries (target snapshot − attacker); a melee splash
        // goes through World_areaDamage 0xf97be8, which passes none
        if (u && u.def.areaDamageRadius <= 0) {
          const v = u.target && u.target.lastHurtTick === b.tick ? u.target
            : [...this.byId.values()].find((q) => q.lastHurtTick === b.tick && q.team !== u.team && q.x === e.x && q.y === e.y);
          if (v) this.stepVec.set(v.id, [u.tsx - u.x, u.tsy - u.y]);
        }
      } else if (e.type === 'shoot') {
        this.shooterEffects(b, e.id);
      }
      if (e.type === 'impact') {
        // HitEffect at the aim point, z = the projectile's height on arrival (0 unless ConstantHeight),
        // angle = the start -> hit direction (0xf9188c -> 0xf8f978 -> world listener vt+0x48 0x850258)
        const pv = this.projViews.get(e.id);
        const p = (pv ? m.projectiles[pv.name] : undefined) ?? m.projectiles[e.name] ??
          (m.spells[e.name] ? m.projectiles[m.spells[e.name].projectile ?? ''] : undefined);
        // a piercing projectile (0xe5a908) plays its DeathEffect there instead (0xf9188c +0x130)
        const eff = p && isRolling(p) ? p.deathEffect : p?.hitEffect;
        const ang = pv && (e.x !== pv.startX || e.y !== pv.startY) ? nativeAngle(e.x - pv.startX, e.y - pv.startY) : 0;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team, angle: ang, z: e.z ?? 0, loop: false });
        // chain beam of a single-target hit (0xf8f618: TargettedEffect from the previous hit position)
        if (p?.targettedEffect && !((p.radius as number | undefined) ?? 0) && e.src !== undefined && e.src >= 0) {
          if (pv) this.charFx.onProjectile(e.id, pv.startX, pv.startY, pv.startZ, pv.shooter);
          this.charFx.onChainHit(e.id, p.targettedEffect as string, team, this.byId.get(e.src));
        }
        // a single-target hit (0xf9188c -> 0xf8f618) carries (aim − start); a splash (0xf8f03c ->
        // World_areaDamage) passes none
        if (pv && !((p?.radius as number | undefined) ?? 0)) {
          for (const v of this.byId.values()) {
            if (v.lastHurtTick === b.tick && v.team !== e.team && v.x === e.x && v.y === e.y) this.stepVec.set(v.id, [e.x - pv.startX, e.y - pv.startY]);
          }
        }
      } else if (e.type === 'death' || e.type === 'tower') {
        this.deathEffect(b, e.id, e.name, e.type === 'tower', team, e.x, e.y);
      } else if (e.type === 'aoe') {
        // the world adds the area effect object at the end of the tick: view factory 0x84fc88 -> 0x833b84
        const a = b.areaEffects.find((q) => q.id === e.id);
        const life = a ? a.def.lifeDuration : (m.areaEffects?.[e.name]?.lifeDuration ?? 0);
        this.areaViews.create(b, e.id, e.name, team, e.x, e.y, 0, life);
      } else if (e.type === 'aoePulse') {
        this.areaViews.pulse(e.id);
      } else if (e.type === 'appear' || e.type === 'hide') {
        // view vt+0x80 with AppearEffect (0xf8247c) / HideEffect (0xf81b3c)
        const eff = m.characters[e.name]?.effects?.[e.type === 'appear' ? 'appearEffect' : 'hideEffect'] as string | undefined;
        const u = this.byId.get(e.id);
        if (u) this.playOnView(u, eff);
        else if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team });
      } else if (e.type === 'landing') {
        // Actor_setState 0xf7f2c8 leaving the jump state: view vt+0x80 with LandingEffect (CharacterData +0x100)
        const u = this.byId.get(e.id);
        if (u) this.playOnView(u, m.characters[e.name]?.effects?.landingEffect as string | undefined);
      } else if (e.type === 'collect') {
        this.collected.add(e.id);
      } else if (e.type === 'path') {
        if (!this.pathFacing.has(e.id)) this.pathFacing.set(e.id, [e.x, e.y]);
      } else if (e.type === 'cast') {
        // Tower_castSpell 0xf9f47c: SpellData +0x110 Effect through the world listener vt+0x48 0x850258 ->
        // 0x82dc54 (setLoop 0) at the target, z 0, angle 0, no parent; every card (troops: CharacterDeploy)
        const eff = (m.spells[e.name]?.effect ?? m.cards[e.name]?.effect) as string | undefined;
        if (eff && this.fx.has(eff)) this.fx.play(eff, e.x, e.y, { team, loop: false });
        this.cast = { tick: e.tick, team: e.team, card: e.name, x: e.x, y: e.y, next: 0 };
      }
    }
    this.ui.onEvents(b);
    this.byId.clear();
    for (const u of b.units) this.byId.set(u.id, u);
    this.projById.clear();
    for (const p of b.projectiles) this.projById.set(p.id, p);
    // the client's view update runs at least once per tick; several engine steps per rendered frame
    // (speed > 1) must not skip a reveal: run it here too, at the time this tick starts showing
    this.updateViews(b, b.tick * 50, 0);
  }

  /**
   * A new actor. Members of a cast's summon (Deploy_summon 0xd423bc: created after the cast event, in
   * index order) get the view delay of vt+0x138 (0x846b2c, sc/unit_view.ts summonViewDelay) when they
   * start in state 4: a UseAnimator view waits at SUMMON_WAIT_ALPHA for it (revealed by updateViews), any
   * other plays its SpawnEffect now (vt+0xc0 0x84f11c: the actor's x, y, z). A member waiting out
   * SummonDeployDelay (state 11) gets vt+0x138(0) when it leaves that state. Other spawns (spawners,
   * death spawns, projectile spawns) come through 0xd35ab4 with param 7 clear: the world listener vt+0x48
   * plays the SpawnEffect at (x, y, FlyingHeight), angle 0, not attached; for a spawner's or a dying
   * character's spawn (0xf8aac8, `src`) its SpawnCharacterEffect replaces it when set (sc/char_effects.ts).
   */
  private onSpawn(b: Battle, id: number, name: string, team: Team, x: number, y: number, tick: number, src?: number, pid?: number): void {
    const m = this.art.manifest;
    const u = b.units.find((q) => q.id === id);
    const c = this.cast;
    if (u && c && c.tick === tick && c.team === u.team && u.card === c.card) {
      const v = this.newView(u);
      const index = c.next++;
      const card = b.defs.card(c.card, b.levels[u.team]);
      const sp = card.spec;
      // SpawnPathfindSpeed: 0xd423bc calls vt+0x168 (the tunnel view: SpawnPathfindEffect, sc/char_effects.ts)
      // instead of vt+0x138, and 0xd35ab4 plays no SpawnEffect (param 7 set); the tunnel's end gives
      // vt+0x138(0) (charFx tunnelEnd)
      if (u.def.spawnPathfindSpeed !== 0) return;
      v.summon = true;
      v.index = index;
      const entry = card.summon.find((s) => s.unit === u.def) ?? null;
      v.deployTime = Math.round((entry && entry.deployTime >= 0 ? entry.deployTime : u.def.deployTime) / 50) * 50;
      if (u.waitTicks <= 0) this.summonDelay(u, v, b, c, sp, v.index);
      return;
    }
    const v = this.newView(u);
    const from = src !== undefined ? this.byId.get(src) : undefined;
    // the deploy filter of vt+0x140, which updateViews starts with the member's deploy (state 4): a dying
    // character's spawn (sc/char_effects.ts deathSpawnFilter); a projectile's (0xf9188c) its
    // SpawnDeployBaseAnim (+0x158) or none
    if (u && from && from.state === ST_DEAD) v.filter = deathSpawnFilter(m, u.def.name, from.def.name);
    const proj = pid !== undefined ? this.projById.get(pid) : undefined;
    if (u && pid !== undefined) v.filter = (proj && m.projectiles[proj.def.name]?.spawnDeployBaseAnim) ?? null;
    const eff = this.charFx.spawnEffectFor(name, from);
    const ch = u ? u.def.flyingHeight : 0;
    if (eff && this.fx.has(eff)) this.fx.play(eff, x, y, { team, z: ch, loop: false });
  }

  private stateFor: unknown = null;

  /** A new battle: actor ids restart, so drop the per-actor view state. */
  private battleState(b: Battle): void {
    if (this.stateFor === b) return;
    this.stateFor = b;
    this.views.clear();
    this.byId.clear();
    this.projById.clear();
    this.muzzled.clear();
    this.charFx.reset();
    this.cast = null;
  }

  private newView(u: Unit | undefined): UnitView {
    const v: UnitView = { barSwapped: false, summon: false, index: 0, deployTime: 0, delay: 0, waiting: false, wasWaiting: false,
      filterStart: null, nb: null, nbRootX: 0, nbBadges: new Map() };
    if (u) {
      v.wasWaiting = u.waitTicks > 0;
      this.views.set(u.id, v);
    }
    return v;
  }

  /** Deploy_summon 0xd423bc's vt+0x138 call for summon member `i` and its view's answer (0x846b2c). */
  private summonDelay(u: Unit, v: UnitView, b: Battle, c: CastCtx, sp: SummonSpec, i: number): void {
    const n1 = sp.main ? sp.number : 0;
    const nCircle = n1 + (sp.second ? sp.secondCount : 0);
    const d0 = (nCircle > 0 ? sp.main ?? sp.second : sp.list[0]) ?? u.def;
    let off: [number, number];
    if (i < nCircle) {
      const r = sp.radius !== 0 ? sp.radius : d0.spawnRadius !== 0 ? d0.spawnRadius : d0.collisionRadius;
      off = formationOffset(i, sp.number, r, sp.width, c.team === 0, b.laneOf(c.x, c.y), d0.spawnAngleShift, sp.secondCount, b.laneSeqDeploy);
    } else {
      const k = i - nCircle;
      const sx = sp.offsetsX[k] ?? 0, sy = sp.offsetsY[k] ?? 0;
      off = c.team === 0 ? [-sx, -sy] : [sx, sy];
    }
    const delay = summonViewDelay({
      index: i, number: sp.number, hasSecond: !!sp.second, spellDeployDelay: sp.deployDelay, deployDelay0: d0.deployDelay,
      deployTime0: d0.deployTime, spawnPathfind0: d0.spawnPathfindSpeed, offset: off, team: c.team,
    });
    if (delay !== null) this.viewDelay(u, v, delay);
  }

  /** View vt+0x138 (0x846b2c): only in state 4; UseAnimator waits for the delay at half alpha, others spawn now. */
  private viewDelay(u: Unit, v: UnitView, delay: number): void {
    if (u.state !== ST_DEPLOYING || u.waitTicks > 0) return;
    const ca = this.art.manifest.characters[u.def.name];
    if (ca?.useAnimator) {
      v.delay = delay;
      v.waiting = true;
      return;
    }
    this.playOnActor(u, ca?.effects?.spawnEffect);
  }

  /**
   * View vt+0x80 (0x84e784 -> 0x82dcb0 with the actor as parent and attach flag set): the effect starts at
   * the actor's sprite (0x82b7ac: the view's sprite x, y ∓ 0.01 world so it sorts in front, z) and keeps
   * following it only with the effect's FollowParent (+0xac, 0xe2202c); a followed looping effect stops
   * when the actor goes (0x82d300). The sprite's position is taken as the actor's logic position (A: the
   * client reads the last drawn, interpolated one).
   */
  private playOnView(u: Unit, eff: string | undefined): void {
    const fx = this.art.manifest.effects;
    if (!eff || !fx[eff]) return;
    const front = this.art.flip ? -5 : 5; // 0.01 world = 5 logic units
    const follow = fx[eff].FollowParent ? () => {
      const f = this.frame;
      const live = f && f.battle.units.includes(u) && u.state !== ST_DEAD;
      return live && f ? [f.ux(u), f.uy(u), f.uz(u)] as [number, number, number] : null;
    } : undefined;
    this.fx.play(eff, u.x, u.y + front, { team: u.team as Team, z: u.z, follow, filterParent: u.id });
  }

  /**
   * View vt+0xc0 (0x84f11c -> 0x82dc54 with the actor as parent, p13 set): like vt+0x80 (the actor's
   * sprite, following it with FollowParent) but always once (setLoop 0); sc/char_effects.ts.
   */
  private playOnActor(u: Unit, eff: string | undefined, angle?: number): void {
    this.charFx.playOnActor(u, eff, angle);
  }

  /**
   * Shooter effect of each projectile the attack just made (AttackComp_execute 0xfc619c -> 0xf85244): the
   * projectile's OverrideShooterProjectileEffect (projectile data +0x348), else the shooter's
   * ProjectileEffect (character data +0x108; +0x110 ProjectileEffectSpecial for a special attack,
   * 0xde0438), played by the world listener vt+0x48 (0x850258) at the projectile's x, y, z right after
   * Projectile_init (its start) with the shooter's facing angle (0x1294e04 on actor +0xf8), not attached,
   * once (0x850258 plays through 0x82dc54, setLoop 0).
   * Crown towers use their building row (KingTower: King_attack, PrincessTower: ArcherTowerAttack).
   */
  private shooterEffects(b: Battle, id: number): void {
    const m = this.art.manifest;
    const u = b.units.find((q) => q.id === id);
    if (!u) return;
    const fx = u.tower === TOWER_KING ? m.towers.king.effects : u.tower === TOWER_PRINCESS ? m.towers.princess.effects
      : m.characters[u.def.name]?.effects;
    for (const p of b.projectiles) {
      if (p.sourceId !== id || p.spell || this.muzzled.has(p.id)) continue;
      this.muzzled.add(p.id);
      this.charFx.onProjectile(p.id, p.startX, p.startY, p.startZ, p.shooter ?? u);
      const eff = (m.projectiles[p.def.name]?.overrideShooterProjectileEffect as string | undefined) ?? fx?.projectileEffect;
      if (eff && this.fx.has(eff)) {
        this.fx.play(eff, p.startX, p.startY, { team: u.team as Team, z: p.startZ, angle: nativeAngle(u.dirX, u.dirY), loop: false });
      }
    }
  }

  /**
   * Death effect (character death 0xf83990 -> world listener vt+0x60 0x850504; a crown tower's 0xfa3d08
   * ends there too in this mode): the first DeathEffectOverride among the actor's buffs (0xfc2288, buff
   * data +0x1b0) else its DeathEffect (vt+0x158), at the actor's x, y and z (0xf942a8: FlyingHeight for a
   * flyer), angle = health +0x18 (0xfcc040), the native angle of the lethal damage's direction
   * (0xfcb29c); none when the damage carried no direction; once (0x850504 plays through 0x82dc54,
   * setLoop 0). Tower rubble is drawn by drawTowerRuin, so a
   * tower's effect skips its permanent particles.
   */
  private deathEffect(b: Battle, id: number, name: string, tower: boolean, team: Team, x: number, y: number): void {
    const m = this.art.manifest;
    const u = this.byId.get(id);
    let eff = (tower ? (name === 'KingTower' ? m.towers.king.effects?.deathEffect : m.towers.princess.effects?.deathEffect)
      : m.characters[name]?.effects?.deathEffect) as string | undefined;
    for (const q of u?.buffs ?? []) {
      const o = m.buffs?.[q.def.name]?.deathEffectOverride as string | undefined;
      if (o) { eff = o; break; }
    }
    const v = this.stepVec.get(id);
    const angle = v ? nativeAngle(v[0], v[1]) : 0;
    if (eff && this.fx.has(eff)) this.fx.play(eff, x, y, { team, z: u ? u.z : 0, angle, skipPersistent: tower, loop: false });
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
    // area-effect views: per-frame update 0x8342c8, removal 0x834038 for objects that left the world
    // (the tiebreak's field clear 0x10cad30 sets their expire flag)
    this.areaViews.update(b, b.areaEffects, b.tiebreakMs > 0 && b.tiebreakMs <= 1500);
    // buff views (0x839b08 -> 0x835788): each new buff instance starts its Effect on the actor's sprite,
    // deleted with the instance (0x8348c8 / 0x834e54); the filter clock starts with the view
    this.buffViews.sync(b, b.units, sim, (q) => {
      const fr = this.frame, u = q as Unit;
      return fr && fr.battle.units.includes(u) && u.state !== ST_DEAD ? [fr.ux(u), fr.uy(u), fr.uz(u)] : null;
    });
    this.fx.update(fxDt);
    // battle layer update (0x856f28): cloud shadows, then the screen shake (SC px)
    if (this.cloudsFor !== b) { this.cloudsFor = b; this.clouds = new Clouds(art, this.ui.layout.stageW); }
    this.battleState(b);
    this.clouds?.update(fxDt / 1000, this.ui.layout.stageW);
    const [shx, shy] = this.fx.shakeOffset(fxDt / 1000);
    this.updateViews(b, sim, f.alpha);
    this.updateAnims(f, sim);
    // ContinuousEffect and the Inferno beam slots (sc/char_effects.ts)
    this.charFx.update(b.units);
    this.filterParents = this.fx.filterParents();
    this.ui.update(fxDt / 1000, f);
    const dpr = this.cam.dpr;

    r.begin([0.05, 0.08, 0.05, 1]);
    // text in the battle layer is laid out and rasterised at the stage scale, then scaled with the layer
    // (0x126ab4c: glyph size = stage scale x field size; sc/text.ts)
    r.textStageScale = this.ui.layout.k * dpr;
    r.setView(this.s * dpr, 0, 0, this.s * dpr, (this.vx + this.s * shx) * dpr, (this.vy + this.s * shy) * dpr);
    art.drawBackground(r, sim);
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
      // state 11 (summon delay) hides the view, its shadow container included (0x839b08 +0xad5 -> +0x340)
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling || u.waitTicks > 0) continue;
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
    for (const g of ghosts) {
      const sprite = ghostSprite(art.character(g.def.name), g.team, g.dirX, g.dirY, art.flip) ?? undefined;
      art.drawUnitShadow(r, g.def.name, g.team, g.x, g.y, 'idle', g.angle, 0, { sprite });
    }
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
      const py = art.decoPx(o)[1];
      items.push({ y: py, draw: () => art.drawDeco(r, o, sim) });
    }
    // units (0-HP actors such as death bombs and the Rage bottle are drawn too)
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling || u.waitTicks > 0) continue;
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
      // sort key: ground-projected y, +48 px for an air actor (0x851b84: vt+0x108 0xf826e8 = FlyingHeight > 0
      // without the TAG_FORCE_IS_AIR / _GROUND status tags; a river jump's z does not count)
      const py = ypx(x, y) + (flying ? 48 : 0);
      // buff filters run on their view's clock (0x82ebdc: t from the buff view's creation)
      const buffs = u.buffs.length ? u.buffs.map((q) => ({ name: q.def.name, ms: this.buffViews.filterTime(q, sim) })) : undefined;
      const hit = this.hits.get(u.id);
      const damage = hit ? { dir: hit.dir, ms: sim - hit.start } : undefined;
      // GO_SPRITE at the interpolated actor z (0x84d738), which the river jump lifts (0xfd0320); the
      // shadow stays at z 0 (0x84d738 places entry +0x18 at the node's x, y and 0) and keeps its size
      // (0x83ce70 shrinks it only for JumpHeight > 0 with DashCooldown > 0)
      const lift = f.uz(u) - u.def.flyingHeight;
      // the deploy filter slot plays from its start (0x839b08: +0x4c8 += dt) to its last frame; a summon
      // member waiting for its reveal sits at SUMMON_WAIT_ALPHA (0x846b2c, applied by 0x839b08 -> 0x851378)
      const view = this.views.get(u.id);
      const deployMs = view?.filterStart != null ? sim - view.filterStart : undefined;
      const alpha = view?.waiting ? SUMMON_WAIT_ALPHA : undefined;
      const o: Parameters<BattleArt['drawUnit']>[8] = { z: lift, deployMs, deployFilter: view?.filter, alpha, buffs, damage, sprite: this.sprites.get(u.id) ?? undefined,
        face: [u.dirX, u.dirY], sinceAttackS: u.lastHitTick >= 0 ? (b.tick - u.lastHitTick + f.alpha) * 0.05 : 1e9,
        clipFrame: this.clipFrames.get(u.id), color: this.effectFilters(u) };
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
      // the client's direction pick for the preview actor's facing (sc/anim.ts ghostSprite)
      const sprite = ghostSprite(art.character(g.def.name), g.team, g.dirX, g.dirY, art.flip) ?? undefined;
      items.push({ y: py, draw: () => { art.drawUnit(r, g.def.name, g.team, g.x, g.y, 'idle', g.angle, 0, { alpha: g.alpha, sprite }); } });
    }
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    // layer 11: the clouds were added first, then the Above effects in creation order
    this.clouds?.draw(r);
    this.fx.draw(r, 'Above');

    // health bars (original HUD art; per-frame logic 0x83c268, sc/unit_view.ts healthBarState)
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.maxHp <= 0) continue;
      const team = u.team as Team;
      if (u.tower !== TOWER_NONE) {
        const king = u.tower === TOWER_KING;
        const kind = king ? 'king' : u.x < 9000 ? 'princessLeft' : 'princessRight';
        const [sx, sy] = art.towerBarPx(kind, team);
        const type = (king ? m.towers.king.healthBar : m.towers.princess.healthBar) ?? (king ? 'Summoner' : 'Tower');
        art.drawTowerHealthBar(r, type, team, sx, sy, u.hp, u.maxHp, u.def.level, u.hp, this.barFlash(u, sim));
        continue;
      }
      const ca = m.characters[u.def.name];
      // a "HealthBar" component (client-action bar): 0x83c268 updates it (0x8405c4) and draws no classic bar
      const nbs = this.newBarSpec(u.def.name);
      if (nbs) {
        this.drawNewBar(u, nbs, sim, f);
        continue;
      }
      // HideHealthbar: no bar clips (0x836e58)
      if (ca?.hideHealthbar) continue;
      const type = (ca?.healthBar as string | undefined) ?? 'Medium';
      const row = m.hud.healthBars[type];
      if (!row) continue;
      const view = this.views.get(u.id) ?? this.newView(u);
      // the viewer is logic player 0 (blue): own = team 0 (0x84ddcc)
      const st = healthBarState({
        own: team === 0, flags: row as HealthBarFlags, hp: u.hp, maxHp: u.maxHp, shield: u.shield, maxShield: u.def.shieldHitpoints,
        lifeTime: u.def.lifeTime, hidden: u.tunneling || u.waitTicks > 0, swapped: view.barSwapped,
      });
      view.barSwapped = st.swapped;
      if (!st.visible) continue;
      // the bar container follows BASE_SPRITE (or GO_SPRITE) with its z (0x8408f0 -> 0x851b84)
      const [sx, sy] = art.unitBarPx(u.def.name, team, f.ux(u), f.uy(u), f.uz(u) - u.def.flyingHeight);
      art.drawUnitHealthBar(r, type, team === 0, sx, sy, st, u.def.level,
        (ca?.showHealthNumber as boolean | undefined) ? st.hp : undefined, this.barFlash(u, sim));
    }
    // HUD layer (battle screen +0x300): HUD elements, deploy timers (0x8d9748) and the drag name text
    r.textStageScale = null; // the HUD's view is the stage scale itself
    this.ui.drawStage(r, dpr);
    r.end();
  }

  /**
   * Effect Filter components recolouring this actor's sprites (0x82ebdc, e.g. the ChargeEffect's
   * filter_protection): each multiplies the colour in with the buff filters' arithmetic
   * (sc/area_view.ts applyFilterColor; alpha kept for crown towers). Undefined: none.
   */
  private effectFilters(u: Unit): Col | undefined {
    if (!this.filterParents.has(u.id)) return undefined;
    const fs = this.fx.filters(u.id);
    if (!fs.length) return undefined;
    let c: Col = [1, 1, 1, 1, 0, 0, 0];
    for (const q of fs) c = applyFilterColor(c, q, u.tower !== TOWER_NONE);
    return c;
  }

  /**
   * Health bar flash, view +0x470: every damage entry the actor survives sets it to 1.0 (0xfcb29c ->
   * view vt+0x20 0x840a2c) and the view update takes 4·dt (s) off it each frame down to 0 (0x839b08),
   * i.e. 1 − 4·(time since the hit) on the visual clock. Engine damage marks lastHurtTick.
   */
  private barFlash(u: Unit, sim: number): number {
    const t = sim - u.lastHurtTick * 50;
    return t >= 0 && t < 250 ? 1 - t / 250 : 0;
  }

  private newBarSpecs = new Map<string, NewBarSpec | null>();

  /**
   * A character's client-action health bar (csv_client/healthbars.toml): its OnStartingClientActions
   * flattened through ClientActionGroup's ClientActions in list order; each ClientActionAddHealthBarPart
   * (0x8645dc) adds a Badge or a Bar with its Conditions / ExcludeConditions masks (0xf739b4), offset and
   * Blue / Red exports. Null without parts (the classic bar). Segmenter parts (0x853318) are not used by
   * a supported card.
   */
  private newBarSpec(name: string): NewBarSpec | null {
    if (this.newBarSpecs.has(name)) return this.newBarSpecs.get(name)!;
    const m = this.art.manifest;
    const ca = m.characters[name] as Record<string, unknown> | undefined;
    const acts = (ca?.onStartingClientActions as string[] | undefined) ?? [];
    const parts = m.hud.healthBarParts ?? {};
    const badges: NewBarPartSpec[] = [], bars: NewBarPartSpec[] = [];
    const visit = (n: string, depth: number): void => {
      const a = parts[n.trim()];
      if (!a || depth > 8) return;
      if (a.classType === 'ClientActionGroup') {
        for (const c of (a.clientActions as string[] | undefined) ?? []) visit(c, depth + 1);
        return;
      }
      if (a.classType !== 'ClientActionAddHealthBarPart') return;
      const p: NewBarPartSpec = {
        cond: condMask(a.conditions as string[] | undefined), excl: condMask(a.excludeConditions as string[] | undefined),
        blue: (a.blueExportName as string | undefined) ?? '', red: (a.redExportName as string | undefined) ?? '',
        offset: [Number(a.offsetX ?? 0) || 0, Number(a.offsetY ?? 0) || 0],
        intro: a.hasIntroAnim === true || a.hasIntroAnim === 'true',
      };
      if (a.partType === 'Badge') badges.push(p);
      else if (a.partType === 'Bar') bars.push(p);
    };
    for (const n of acts) visit(n, 0);
    const x = Number(ca?.newHealthBarOffsetX ?? 0) || 0;
    const spec = badges.length || bars.length ? {
      base: [x + (Number(ca?.newHealthBarOffsetXBlue ?? 0) || 0), x + (Number(ca?.newHealthBarOffsetXRed ?? 0) || 0)] as [number, number],
      badges, bars,
    } : null;
    this.newBarSpecs.set(name, spec);
    return spec;
  }

  /**
   * One frame of a client-action health bar (0x8405c4 -> 0x853574, sc/unit_view.ts): the shown flags
   * and percentages, the part choice, the badge clip's frame (stopped on its last frame when the badge
   * changes, its intro played 0..last when chosen with HasIntroAnim), drawn by BattleArt.drawNewHealthBar
   * at the bar holder (the classic anchor, 0x84f740). Underground = tunnelling and the holder hidden in
   * state 11 are not traced (A).
   */
  private drawNewBar(u: Unit, spec: NewBarSpec, sim: number, f: Frame): void {
    const art = this.art, r = this.r;
    const team = u.team as Team;
    const own = team === 0;
    const view = this.views.get(u.id) ?? this.newView(u);
    if (!view.nb) view.nb = newBarView();
    const nb = view.nb;
    const fr = newBarFrame(nb, {
      own, hp: u.hp, maxHp: u.maxHp, shield: u.shield, maxShield: u.def.shieldHitpoints, boost: 0, champion: false,
      underground: u.tunneling, invincible: false,
    });
    const level = u.def.level;
    const ch = newBarChoose(nb, spec.badges, spec.bars, fr.flags, level);
    const lib = art.lib(art.manifest.hud.sc);
    const exp = (p: NewBarPartSpec) => (own ? p.blue : p.red);
    let badgeFrame = 0;
    if (ch.badge >= 0) {
      const e = exp(spec.badges[ch.badge]);
      const last = Math.max(0, lib.frameCount(e) - 1);
      let st = view.nbBadges.get(ch.badge);
      if (!st) { st = { frame: 0, playFrom: null }; view.nbBadges.set(ch.badge, st); } // 0x8530e0: frame 0
      if (ch.intro) { st.playFrom = sim; st.frame = 0; } else if (ch.badgeChanged) { st.playFrom = null; st.frame = last; }
      badgeFrame = st.playFrom !== null ? Math.min(last, Math.floor(((sim - st.playFrom) * lib.fps(e)) / 1000)) : st.frame;
    }
    if (u.waitTicks > 0) return;
    const [sx, sy] = art.unitBarPx(u.def.name, team, f.ux(u), f.uy(u), f.uz(u) - u.def.flyingHeight);
    const part = (p: NewBarPartSpec | undefined) => (p ? { exp: exp(p), offset: p.offset } : null);
    view.nbRootX = art.drawNewHealthBar(r, sx, sy, {
      base: own ? spec.base[0] : spec.base[1], badge: part(spec.badges[ch.badge]), badgeFrame, showBadge: fr.show,
      bar: part(spec.bars[ch.bar]), showBar: fr.bar, level, hpPct: fr.hpPct, shieldPct: fr.shieldPct,
      flash: this.barFlash(u, sim), rootX: view.nbRootX,
    });
  }

  /**
   * The deploy part of the character view update for each troop / building (0x840d44 state 4 with
   * 0x846b2c's delay, sc/unit_view.ts): a summon member leaving state 11 gets vt+0x138(0); a waiting
   * UseAnimator view is revealed once the deploy elapsed time 0xf8519c (a logic value: DeployTime − the
   * timer) reaches its delay: SpawnEffect via vt+0xc0 (not for a SpawnEffectOnce character other than
   * summon index 0), the deploy filter starts and the alpha returns to 1; out of state 4 the alpha is
   * restored every frame without an effect. Other views keep the deploy filter from their deploy start:
   * single-clip buildings take it in 0x840d44's first branch while in state 4; actors not made by a
   * cast's summon (0xd35ab4 with param 7 clear) are not traced further (A).
   */
  private updateViews(b: Battle, sim: number, alpha: number): void {
    const m = this.art.manifest;
    const live = new Set<number>();
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD) continue;
      live.add(u.id);
      const v = this.views.get(u.id) ?? this.newView(u);
      const waiting11 = u.state === ST_DEPLOYING && u.waitTicks > 0;
      if (v.summon && v.wasWaiting && !waiting11 && u.state === ST_DEPLOYING) this.viewDelay(u, v, 0); // 0xf7f2c8 11 -> 4
      v.wasWaiting = waiting11;
      if (v.waiting) {
        if (u.state !== ST_DEPLOYING) {
          v.waiting = false; // 0x840d44: out of state 4 the alpha follows 0x83c0ac again
        } else if (!waiting11 && deployElapsed(v.deployTime, (u.deployTicks - u.waitTicks) * 50) >= v.delay) {
          v.waiting = false;
          const ca = m.characters[u.def.name];
          if (!ca?.spawnEffectOnce || v.index === 0) this.playOnActor(u, ca?.effects?.spawnEffect);
          v.filterStart = sim;
        }
      } else if (v.filterStart === null && u.state === ST_DEPLOYING && !waiting11 && !u.tunneling
        && (!v.summon || !m.characters[u.def.name]?.useAnimator)) {
        // from the deploy start (state 4): views without an anim set take the filter in 0x840d44's first
        // branch; the rest as before (not traced)
        const total = v.summon ? v.deployTime / 50 : u.deployTotal;
        v.filterStart = sim - ((total - (u.deployTicks - u.waitTicks)) * 50 + alpha * 50);
      }
    }
    for (const id of this.views.keys()) if (!live.has(id)) this.views.delete(id);
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
      const af = animate(ca, u.team as Team, s, {
        state, dirX: u.dirX, dirY: u.dirY, id: u.id, walker, charge: u.charge,
        walk: u.walkMs, walkPrev: f.prevWalk.get(u.id) ?? u.walkMs,
        atk: u.atkTimer, atkPrev: f.prevAtk.get(u.id) ?? u.atkTimer, finish: u.finishMs,
        alpha: f.alpha, dt, clock: sim / 1000, flip: this.art.flip,
        // the tower princess swings on the Princess tower's attack timer (A: the attached actor's own
        // attack component is not modelled)
        hitSpeed: u.tower === TOWER_PRINCESS ? u.def.hitSpeed : undefined,
        pathFacing: this.pathFacing.get(u.id),
        jumpLeft: state === 5 ? this.jumpLeft(u, b.arena.w) : undefined,
      });
      this.sprites.set(u.id, af);
      // MoveEffect on the run clip's action_frame1 / 2 and the location's WalkEffect (0x840d44)
      this.unitFx.step(this.fx, ca, { id: u.id, team: u.team, x: u.x, y: u.y, z: u.z, dirX: u.dirX, dirY: u.dirY, walker }, af,
        (m.arena as { walkEffect?: string }).walkEffect);
      // 0x840d44 -> 0x83e524: AttackStartEffect (de05a8 with 0: never the Special one; attack sequences
      // of data +0x3d4 are not in the engine) when the swing flag rises, via vt+0xc0 at the actor's x, y,
      // z (the tower princess: her tower's x, y at AttachedCharacterHeight); its buff-scaled speed
      // (0x82ccf0, effect +0xb0) only changes the effect's sound (0x82bf10)
      // ChargeEffect on entering the charge clip (0x840d44 @0x841c78, sc/char_effects.ts)
      if (u.tower === TOWER_NONE) this.charFx.viewUpdate(u, af);
      if (af?.attackStart) {
        const eff = ca.effects?.attackStartEffect;
        if (u.tower === TOWER_PRINCESS) {
          if (eff && this.fx.has(eff)) this.fx.play(eff, u.x, u.y, { team: u.team as Team, z: (m.towers.princess.attachedHeight as number | undefined) ?? 0, loop: false });
        } else {
          this.playOnActor(u, eff);
        }
      }
    }
    this.pathFacing.clear();
    for (const id of this.anims.keys()) if (!seen.has(id)) this.anims.delete(id);
    this.unitFx.prune(this.fx, seen);
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

  /**
   * Steps left in a river jump as the character view takes them (0x84440c -> 0xfce8b8): the distance
   * from the actor's logic position to the path's landing cell (movement +0x3c[0], set by 0xfcf594)
   * at cell × 500 (the cell corner, not its centre), saturating isqrt (0x1294e10), ÷ the move speed
   * vtb8 (JumpSpeed in state 5); undefined below speed 1 (the client skips the landing cap).
   */
  private jumpLeft(u: Unit, w: number): number | undefined {
    const speed = u.def.jumpSpeed;
    if (speed < 1 || !u.path.length) return undefined;
    const cell = u.path[u.path.length - 1];
    const dx = (cell % w) * 500 - u.x;
    const dy = Math.floor(cell / w) * 500 - u.y;
    const d = Math.abs(dx) > 46340 || Math.abs(dy) > 46340 || dx * dx + dy * dy > 0x7fffffff ? isqrt(0x7fffffff) : isqrt(dx * dx + dy * dy);
    return idiv(d, speed);
  }

  /** Engine state -> clip, angle and clip time. */
  private unitState(u: Unit, f: Frame): { action: string; angle: number; ms: number } {
    const angle = Math.atan2(u.dirY, u.dirX);
    if (u.state === ST_DEPLOYING) return { action: 'idle', angle, ms: 0 };
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
          clip: null, ageMs: 0, v: null, x: p.x, y: p.y, trail: 0, seen: true, shooter: p.shooter,
          team: p.team as Team,
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
      this.charFx.dropProjectile(id);
      // (a piercing projectile's DeathEffect plays at its last hit, the 'impact' event: 0xf9188c)
      // an out-and-back projectile back at its start without its shooter (Projectile_update 0xf90708,
      // p->shooter cleared) plays PingpongDeathEffect (+0x1c8) through its view's vt+0x80 0x84e784: at the
      // projectile's sprite, not following it (the view goes with the projectile)
      const pa = m.projectiles[pv.name];
      const pde = pa?.pingpongDeathEffect as string | undefined;
      if (pde && this.fx.has(pde) && (!pv.shooter || pv.shooter.state === ST_DEAD)) {
        this.fx.play(pde, pv.x, pv.y + (this.art.flip ? -5 : 5), { team: pv.team, z: pv.v ? pv.v.height / 0.002 : 0 });
      }
    }
    this.charFx.pruneProjectiles(b.projectiles);
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
    const aimZ = homing && t ? t.z : 0;
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
