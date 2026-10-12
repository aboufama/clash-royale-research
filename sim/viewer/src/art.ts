// Original-art world renderer: draws the live engine state with the build's own SC2 movie clips
// (baked by tools/art/bake_web.py into sim/viewer/assets/, played by sc/renderer.ts).
//
// Engine -> art mapping (visual only, never feeds back into the simulation): every character view runs
// the client's view update (sc/anim.ts, 0x840d44: action, direction, frame), single-clip buildings their
// clip player, the King tower its activation controller; nested clips play on per-view instances
// (sc/movieclip.ts ClipInstances); engine events drive the game's own effects, filters and hit wobbles.
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
  animate, animateBuilding, type AnimFrame, type AnimState, BattleArt, type BuildingAnim, ClipPlayer, EffectPlayer,
  type Mat, nativeAngle, newAnimState, newBuildingAnim, ScRenderer, viewAngle,
} from './sc/index.ts';
import { ghostSprite, turretPose, vecSetLength } from './sc/anim.ts';
import { ClipInstances, McNode } from './sc/movieclip.ts';
import type { UnitDrawOptions } from './sc/battle_art.ts';
import type { ScLibrary } from './sc/library.ts';
import type { CharacterArt } from './sc/manifest.ts';
import { arcHeight, isRolling, newProjectileViewState, projectileView } from './sc/projectile_view.ts';
import { condMask, dashPull, deployElapsed, healthBarState, joltStep, jumpMoveSpeed, newBarChoose, newBarFrame, newBarView,
  SUMMON_WAIT_ALPHA, summonViewDelay } from './sc/unit_view.ts';
import type { Jolt } from './sc/unit_view.ts';
import type { BarPartRef, HealthBarFlags, NewBarView } from './sc/unit_view.ts';
import { BattleUi } from './battle_ui.ts';
import { Clouds } from './sc/clouds.ts';
import { UnitFx } from './sc/unit_fx.ts';
import { applyPanelSkin } from './panel_skin.ts';
import type { ProjectileViewFrame, ProjectileViewState } from './sc/projectile_view.ts';
import { applyFilterColor, AreaViews, BuffViews, crownTowerFilterColor } from './sc/area_view.ts';
import { CharEffects, deathSpawnFilter } from './sc/char_effects.ts';
import { type Col, WHITE } from './sc/math.ts';
import type { ClipRef } from './sc/manifest.ts';
import { versionedUrl } from './sc/asset_fetch.ts';

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
  /** clip instances of the sprite and shadow exports (nested clips' playheads; the shadow root plays on its
   * own: 0x8545e0 makes it and nothing sets its frame) */
  ci: ClipInstances;
  inst: McNode | null;
  shadowInst: McNode | null;
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
          const ff = new FontFace(fam, `url(${versionedUrl(`assets/${url}`)})`);
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
  /** Hit filter per unit (direction picked from the hit vector, sim ms it started) and this step's view hit calls. */
  private hits = new Map<number, { dir: 'down' | 'left' | 'up' | 'right'; start: number }>();
  private hitVec = new Map<number, [number, number]>();
  /**
   * Clip instances per view (sc/movieclip.ts ClipInstances; units, buildings, crown towers, projectiles,
   * drag-preview ghosts): nested clips play on their own playheads. instNow: this frame's shown instance
   * per actor (sprite and shadow share it); kingNow: the King tower's tower and King clips.
   */
  private insts = new Map<number, ClipInstances>();
  private instNow = new Map<number, McNode | null>();
  private kingNow = new Map<number, { tower: McNode | null; king: McNode | null }>();
  private ghostInsts = new Map<string, { ci: ClipInstances; anim: BuildingAnim | null; seen: boolean }>();
  /** turret child of a building / King tower instance (0x8455cc), cached by instance */
  private turretKids = new WeakMap<McNode, McNode | null>();
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
  /**
   * AttackDashTime lunge per view (0x845ce8, view vt+0x40): the point +0xa30 / +0xa34 (= +0xa38 / +0xa3c)
   * the view is pulled toward, the timer +0xa48 (ms, counted down by the frame dt in 0x839b08) and
   * AttackDashTime.
   */
  private dashes = new Map<number, { x: number; y: number; t: number; d: number }>();
  /**
   * The view's shake / recoil (0x839b08 from vt+0xf0 0x83e488 and vt+0xf8 0x83e4d8): timers +0x9f0 (shake,
   * 0.1 s) and +0x9f4 (recoil, 0.25 s), the vector +0x9f8 / +0x9fc, and this frame's offset (battle px).
   */
  private jolts = new Map<number, Jolt>();
  /** C rand() stand-in for the AttackShakeTime jitter (xorshift; the client's libc sequence is not reproducible) */
  private randState = 0x2545f491;
  private readonly rand = (): number => {
    let x = this.randState;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.randState = x;
    return x >>> 1;
  };
  /** the battle's raw data rows by unit name (view-only character columns the engine does not keep) */
  private rawRows = new Map<string, { vhs: [number, number, number] | null; shake: number; dash: number }>();
  /** MovieClip instances of the arena clip and of each location object (0x856088; nested clips' playheads) */
  private arenaInst: McNode | null = null;
  private decoInsts: (McNode | null)[] = [];
  private arenaFor: unknown = null;
  private lastArenaSim = -1;
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
        return fr && fr.battle.units.includes(u) && u.state !== ST_DEAD ? [this.viewX(u, fr), this.viewY(u, fr), fr.uz(u)] : null;
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
    // logic-side effects of this step: GenericDie, the crowd reactions, the King activation (sc/char_effects.ts)
    this.charFx.onStep(b, (id) => this.byId.get(id));
    // the lethal damage entry's vector (health +0x18 = its native angle, set by 0xfcb29c when the hit kills;
    // later entries skip the dead actor): the first 'damage' event of an actor after its death event
    let died: Set<number> | null = null;
    for (const e of b.events) {
      if (e.type === 'death' || e.type === 'tower') (died ??= new Set()).add(e.id);
      else if (e.type === 'damage' && died?.has(e.id) && !this.stepVec.has(e.id)) this.stepVec.set(e.id, [e.vx ?? 0, e.vy ?? 0]);
    }
    for (const e of b.events) {
      const team = e.team as Team;
      if (e.type === 'spawn') {
        this.onSpawn(b, e.id, e.name, team, e.x, e.y, e.tick, e.src, e.pid);
      } else if (e.type === 'wobble') {
        // the victim view's vt+0xe8 (0x83e3d8): the damage filter facing this call's vector; the last call wins
        this.hitVec.set(e.id, [e.vx ?? 0, e.vy ?? 0]);
      } else if (e.type === 'dash') {
        this.dashStart(b, e.id, e.x, e.y, e.vx ?? 0, e.vy ?? 0, e.r ?? 0);
      } else if (e.type === 'shake') {
        this.jolt(this.byId.get(e.id), e.vx ?? 0, e.vy ?? 0, false);
      }
      if (e.type === 'hit' || e.type === 'shoot') {
        // AttackComp_execute 0xfc619c: TargetedHitEffect (view vt+0x90, pivot index = execute's slot: −1 for a
        // single target, 0, 1, ... for a MultipleTargets attack's target and extra targets, in that order:
        // 0xfc7e20 → 0xfc8ef4) and a melee splash's DamageEffect at its centre (sc/char_effects.ts); the
        // victims' effects come with the 'damage' events
        const a = this.byId.get(e.id);
        let slot = -1;
        if (a && a.def.multipleTargets >= 2) {
          const k = `${e.tick}:${e.id}`;
          slot = this.slotTick.key === k ? ++this.slotTick.n : 0;
          this.slotTick = { key: k, n: slot };
        }
        this.charFx.onAttack(e.tick, a, e.src !== undefined ? this.byId.get(e.src) : undefined,
          e.type === 'hit', e.fx === 1, e.x, e.y, slot, e.cancelled === true);
      } else if (e.type === 'damage') {
        this.charFx.onDamage(e.tick, this.byId.get(e.id), e.fx ?? 0, e.name, e.src !== undefined ? this.byId.get(e.src) : undefined);
      } else if (e.type === 'shieldLost') {
        this.charFx.onShieldLost(this.byId.get(e.id));
      }
      if (e.type === 'shoot') this.shooterEffects(b, e.id);
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
  /** the attacker and tick of the last 'hit' / 'shoot' event and its slot (MultipleTargets slots) */
  private slotTick = { key: '', n: -1 };

  /**
   * View vt+0x40 0x845ce8 (AttackComp_update 0xfc7e20, engine event 'dash'): the lunge point = the target's
   * position + (attacker − target) set to the target's collision radius (Vec_setLength 0x1294d74, target
   * vt+0xa0), i.e. the point of its circle facing the attacker; the timer +0xa48 = 2 · AttackDashTime.
   */
  private dashStart(b: Battle, id: number, tx: number, ty: number, vx: number, vy: number, r: number): void {
    const u = this.byId.get(id);
    const d = u ? this.rawRow(b, u.def.name).dash : 0;
    if (!u || d <= 0) return;
    const [sx, sy] = vecSetLength(vx, vy, r);
    this.dashes.set(id, { x: tx + sx, y: ty + sy, t: 2 * d, d });
  }

  /**
   * View vt+0xf0 0x83e488 (shake: ShakesTargets, 0xf90640) / vt+0xf8 0x83e4d8 (recoil): not for buildings;
   * stores the vector (+0x9f8 / +0x9fc) and starts the 0.1 s (+0x9f0) or 0.25 s (+0x9f4) timer.
   */
  private jolt(u: Unit | undefined, vx: number, vy: number, recoil: boolean): void {
    if (!u || u.isBuilding || u.tower !== TOWER_NONE) return;
    let j = this.jolts.get(u.id);
    if (!j) { j = { t0: 0, t1: 0, vx: 0, vy: 0, ox: 0, oy: 0 }; this.jolts.set(u.id, j); }
    j.vx = vx; j.vy = vy;
    if (recoil) j.t1 = 0.25; else j.t0 = Math.fround(0.1);
  }

  /** The per-frame part of 0x839b08 for the dash and jolt timers (sc/unit_view.ts), `dt` the frame's seconds (float32). */
  private viewTimers(dt: number): void {
    for (const [id, d] of this.dashes) {
      // +0xa48 = (int)max(0, +0xa48 − dt·1000)
      d.t = Math.trunc(Math.max(0, Math.fround(d.t - Math.fround(dt * 1000))));
      if (d.t <= 0) this.dashes.delete(id);
    }
    for (const [id, j] of this.jolts) {
      if (!this.byId.has(id)) { this.jolts.delete(id); continue; } // the view is gone with its actor
      joltStep(j, dt, this.art.flip);
    }
  }

  /** This frame's jolt offset of a view's sprite entries and bar holder (battle px), if any. */
  private shiftOf(u: Unit): [number, number] | undefined {
    const j = this.jolts.get(u.id);
    return j && (j.ox !== 0 || j.oy !== 0) ? [j.ox, j.oy] : undefined;
  }

  /**
   * The view position the client draws a character at (0x84d738): the tick-start and current logic positions,
   * each pulled toward the lunge point while the dash timer runs (0x846f98 / 0x847068 / 0x847138 / 0x847208:
   * u = max(0, 100 − |t − D|·100 / D); for u ≥ 2, p + (point − p)·(u >> 1) / 100, integer), then interpolated.
   */
  private viewX(u: Unit, f: Frame): number {
    const d = this.dashes.get(u.id);
    if (d === undefined) return f.ux(u);
    const q = f.prevPos.get(u.id);
    const p = q === undefined ? u.x : Math.floor(q / 65536);
    const a = dashPull(p, d.x, d.t, d.d), c = dashPull(u.x, d.x, d.t, d.d);
    return a + (c - a) * f.alpha;
  }

  private viewY(u: Unit, f: Frame): number {
    const d = this.dashes.get(u.id);
    if (d === undefined) return f.uy(u);
    const q = f.prevPos.get(u.id);
    const p = q === undefined ? u.y : q % 65536;
    const a = dashPull(p, d.y, d.t, d.d), c = dashPull(u.y, d.y, d.t, d.d);
    return a + (c - a) * f.alpha;
  }

  /** View-only columns of a character's data row (the battle's gamedata): VisualHitSpeed per entry, AttackShakeTime, AttackDashTime. */
  private rawRow(b: Battle, name: string): { vhs: [number, number, number] | null; shake: number; dash: number } {
    let r = this.rawRows.get(name);
    if (r) return r;
    const row = (b.defs.data.units[name] ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof row[k] === 'number' ? row[k] as number : 0);
    // 0xdde618: entries 2 / 3 copy the VisualHitSpeed of the entry before when theirs is 0
    const v1 = n('VisualHitSpeed'), v2 = n('VisualHitSpeed2') || v1, v3 = n('VisualHitSpeed3') || v2;
    r = { vhs: v1 ? [v1, v2, v3] : null, shake: n('AttackShakeTime'), dash: n('AttackDashTime') };
    this.rawRows.set(name, r);
    return r;
  }

  /** A new battle: actor ids restart, so drop the per-actor view state. */
  private battleState(b: Battle): void {
    if (this.stateFor === b) return;
    this.stateFor = b;
    this.views.clear();
    this.insts.clear();
    this.instNow.clear();
    this.kingNow.clear();
    this.byId.clear();
    this.projById.clear();
    this.muzzled.clear();
    this.charFx.reset();
    this.dashes.clear();
    this.jolts.clear();
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
      return live && f ? [this.viewX(u, f), this.viewY(u, f), f.uz(u)] as [number, number, number] : null;
    } : undefined;
    // the parent view gives PivotClip / ParentLookAtOffsetRadius their offsets (0x82bf10 @0x82c2ac)
    this.fx.play(eff, u.x, u.y + front, { team: u.team as Team, z: u.z, follow, filterParent: u.id, parentView: this.charFx.parentView(u) });
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
   * flyer), angle = health +0x18 (0xfcc040), the native angle (0x1294e04) of the lethal damage entry's
   * vector (+0x10: the recorded 'damage' event's vx / vy; 0 for area damage, decay and other deaths);
   * once (0x850504 plays through 0x82dc54, setLoop 0). Tower rubble is drawn by drawTowerRuin, so a
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
    // the views' dash and jolt timers (0x839b08), before anything reads a view position this frame
    this.viewTimers(Math.fround(fxDt / 1000));
    // area-effect views: per-frame update 0x8342c8, removal 0x834038 for objects that left the world
    // (the tiebreak's field clear 0x10cad30 sets their expire flag)
    this.areaViews.update(b, b.areaEffects, b.tiebreakMs > 0 && b.tiebreakMs <= 1500);
    // buff views (0x839b08 -> 0x835788): each new buff instance starts its Effect on the actor's sprite,
    // deleted with the instance (0x8348c8 / 0x834e54); the filter clock starts with the view
    this.buffViews.sync(b, b.units, sim, (q) => {
      const fr = this.frame, u = q as Unit;
      return fr && fr.battle.units.includes(u) && u.state !== ST_DEAD ? [this.viewX(u, fr), this.viewY(u, fr), fr.uz(u)] : null;
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
    this.arenaClips(sim);
    art.drawBackground(r, sim, this.arenaInst ?? undefined);
    art.drawArenaObjects(r, sim, ['Base'], this.decoInsts);
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
    art.drawArenaShadows(r, sim, undefined, this.decoInsts);
    for (const u of b.units) {
      if (u.tower === TOWER_NONE || u.state === ST_DEAD) continue;
      const team = u.team as Team;
      if (u.tower === TOWER_KING) {
        const kn = this.kingNow.get(u.id);
        art.drawTowerShadow(r, 'king', team, sim, this.kingClips.get(u.id)?.clip.frame, [u.dirX, u.dirY], this.sinceAttack(u, b, f),
          undefined, { tower: kn?.tower ?? undefined, king: kn?.king ?? undefined });
      } else {
        art.drawTowerShadow(r, u.x < 9000 ? 'princessLeft' : 'princessRight', team, sim, undefined, undefined, undefined,
          this.sprites.get(u.id) ?? undefined, { princess: this.instNow.get(u.id) ?? undefined });
      }
    }
    for (const u of b.units) {
      // state 11 (summon delay) hides the view, its shadow container included (0x839b08 +0xad5 -> +0x340)
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling || u.waitTicks > 0) continue;
      if (!m.characters[u.def.name]) continue;
      art.drawUnitShadow(r, u.def.name, u.team as Team, this.viewX(u, f), this.viewY(u, f), {
        sprite: this.sprites.get(u.id) ?? undefined, inst: this.instNow.get(u.id) ?? undefined,
        clipFrame: this.clipFrames.get(u.id), face: [u.dirX, u.dirY], sinceAttackS: this.sinceAttack(u, b, f),
      });
    }
    // projectile shadows go into the same silhouette (0x855304 -> 0x856a40)
    for (const p of b.projectiles) {
      const pv = this.projViews.get(p.id);
      if (pv?.v) art.drawProjectileShadow(r, pv.name, p.team as Team, pv.x, pv.y, pv.v, pv.shadowInst ?? undefined);
    }
    // drag preview ghosts are real actor views: their shadows join the silhouette buffer (A)
    const ghosts = this.ghostViews(sim);
    for (const g of ghosts) art.drawUnitShadow(r, g.u.def.name, g.u.team, g.u.x, g.u.y, g.o);
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
      const py = ypx(u.x, u.y);
      if (u.tower === TOWER_KING) {
        const kf = this.kingClips.get(u.id)?.clip.frame;
        const face: [number, number] = [u.dirX, u.dirY];
        const since = this.sinceAttack(u, b, f);
        const kn = this.kingNow.get(u.id);
        const col = this.towerColor(u, sim);
        items.push({ y: py, draw: () => art.drawKingTower(r, team, sim, kf, false, face, since,
          { tower: kn?.tower ?? undefined, king: kn?.king ?? undefined }, col) });
      } else {
        const side = u.x < 9000 ? 'princessLeft' : 'princessRight';
        const sp = this.sprites.get(u.id) ?? undefined;
        const inst = this.instNow.get(u.id) ?? undefined;
        const col = this.towerColor(u, sim);
        items.push({ y: py, draw: () => art.drawPrincessTower(r, team, side, sp, false, inst, col) });
      }
    }
    // arena decorations on the object layer
    m.arena.objects.forEach((o, i) => {
      if (o.layer !== 'Object') return;
      const py = art.decoPx(o)[1];
      const inst = this.decoInsts[i] ?? undefined;
      items.push({ y: py, draw: () => art.drawDeco(r, o, sim, undefined, inst) });
    });
    // units (0-HP actors such as death bombs and the Rage bottle are drawn too)
    for (const u of b.units) {
      if (u.tower !== TOWER_NONE || u.state === ST_DEAD || u.tunneling || u.waitTicks > 0) continue;
      const ca = m.characters[u.def.name];
      const x = this.viewX(u, f);
      const y = this.viewY(u, f);
      const team = u.team as Team;
      if (!ca) {
        const [px, py] = art.gameToPx(x, y, u.def.flyingHeight);
        const rr = (u.radius / 1000) * art.pxPerTileX;
        items.push({ y: py, draw: () => r.drawRect(px - rr, py - rr, 2 * rr, 2 * rr, team === 0 ? [0.25, 0.5, 1, 0.8] : [1, 0.3, 0.3, 0.8]) });
        continue;
      }
      const py = this.sortKey(u, x, y);
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
      const o: UnitDrawOptions = { z: lift, deployMs, deployFilter: view?.filter, alpha, buffs, damage,
        sprite: this.sprites.get(u.id) ?? undefined, inst: this.instNow.get(u.id) ?? undefined,
        face: [u.dirX, u.dirY], sinceAttackS: this.sinceAttack(u, b, f),
        clipFrame: this.clipFrames.get(u.id), color: this.effectFilters(u), shift: this.shiftOf(u) };
      items.push({ y: py, draw: () => { art.drawUnit(r, u.def.name, team, x, y, o); } });
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
      const x = pv.x, y = pv.y, inst = pv.inst ?? undefined;
      items.push({ y: ypx(x, y), draw: () => art.drawProjectileView(r, pv.name, team, x, y, v, clipFrame, child, inst) });
    }
    for (const it of this.fx.collect('Object')) items.push({ y: it.sortY, draw: () => it.draw(r) });
    // drag preview ghost units, sorted with the actors
    for (const g of ghosts) {
      const py = ypx(g.u.x, g.u.y) + (g.u.def.flyingHeight > 0 ? 48 : 0);
      items.push({ y: py, draw: () => { art.drawUnit(r, g.u.def.name, g.u.team, g.u.x, g.u.y, g.o); } });
    }
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();
    // layer 11: the clouds were added first, then the Above effects in creation order
    this.clouds?.draw(r);
    this.fx.draw(r, 'Above');

    // health bars: battle layer 12 (0x836e58 adds each view's bar holder +0x618 with 0x8569f0(…, 0xc)),
    // re-sorted every frame by the owner's sort key (0x856f28 -> 0x856a88: selection sort on vt+0x168,
    // the key setPos3D 0x851b84 gives the holder through 0x8408f0: ground y, +48 for an air character);
    // equal keys keep the actors' creation order (A: the client breaks ties by the nodes' addresses).
    // Per-frame logic 0x83c268 (sc/unit_view.ts healthBarState) on the original HUD art.
    const bars = this.barItems;
    bars.length = 0;
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.maxHp <= 0) continue;
      const team = u.team as Team;
      if (u.tower !== TOWER_NONE) {
        const king = u.tower === TOWER_KING;
        const kind = king ? 'king' : u.x < 9000 ? 'princessLeft' : 'princessRight';
        const [sx, sy] = art.towerBarPx(kind, team);
        const type = (king ? m.towers.king.healthBar : m.towers.princess.healthBar) ?? (king ? 'Summoner' : 'Tower');
        const flash = this.barFlash(u, sim);
        bars.push({ y: ypx(u.x, u.y), draw: () => art.drawTowerHealthBar(r, type, team, sx, sy, u.hp, u.maxHp, u.def.level, u.hp, flash) });
        continue;
      }
      const ca = m.characters[u.def.name];
      const key = this.sortKey(u, this.viewX(u, f), this.viewY(u, f));
      // a "HealthBar" component (client-action bar): 0x83c268 updates it (0x8405c4) and draws no classic bar
      const nbs = this.newBarSpec(u.def.name);
      if (nbs) {
        const d = this.newBarDraw(u, nbs, sim, f);
        if (d) bars.push({ y: key, draw: d });
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
      // the bar container follows BASE_SPRITE (or GO_SPRITE) with its z (0x8408f0 -> 0x851b84), moved by the
      // view's jolt offset (0x839b08 -> 0x851d54 on +0x618)
      const [sx, sy] = this.barShift(u, art.unitBarPx(u.def.name, team, this.viewX(u, f), this.viewY(u, f), f.uz(u) - u.def.flyingHeight));
      const hpText = (ca?.showHealthNumber as boolean | undefined) ? st.hp : undefined;
      const flash = this.barFlash(u, sim);
      bars.push({ y: key, draw: () => art.drawUnitHealthBar(r, type, team === 0, sx, sy, st, u.def.level, hpText, flash) });
    }
    // stable: equal keys keep the push order
    for (let i = 0; i < bars.length; i++) bars[i].i = i;
    bars.sort((p, q) => p.y - q.y || (p.i ?? 0) - (q.i ?? 0));
    for (const it of bars) it.draw();
    // HUD layer (battle screen +0x300): HUD elements, deploy timers (0x8d9748) and the drag name text
    r.textStageScale = null; // the HUD's view is the stage scale itself
    this.ui.drawStage(r, dpr);
    r.end();
  }

  private barItems: { y: number; i?: number; draw: () => void }[] = [];

  /** A bar holder position plus the view's jolt offset (0x839b08: 0x851d54(+0x638 + x, +0x63c + y, +0x618)). */
  private barShift(u: Unit, p: [number, number]): [number, number] {
    const j = this.jolts.get(u.id);
    return j ? [p[0] + j.ox, p[1] + j.oy] : p;
  }

  /**
   * The arena clip and each location object's clip as MovieClip instances made with the battle layer
   * (0x856088: 0x120cc50 for the arena, 0x8578e4 for the objects), playing from frame 0, advanced by the
   * render each frame (0x123f55c): their nested clips (river, banners, crowds) keep their own playheads. A
   * deco's shadow copy shares its instance (the client's second copy advances identically, A).
   */
  private arenaClips(sim: number): void {
    const art = this.art, a = art.manifest.arena;
    const lib = art.lib(a.sc);
    if (this.arenaFor !== this.stateFor || this.arenaInst === null || this.arenaInst.lib !== lib) {
      this.arenaFor = this.stateFor;
      this.arenaInst = McNode.of(lib, a.export);
      this.decoInsts = a.objects.map((o) => McNode.of(art.lib(o.sc), o.export));
      this.lastArenaSim = sim;
    }
    const dt = Math.max(0, (sim - this.lastArenaSim) / 1000);
    this.lastArenaSim = sim;
    this.arenaInst?.advance(dt);
    a.objects.forEach((o, i) => {
      let n = this.decoInsts[i];
      const l = art.lib(o.sc);
      if (!n || n.lib !== l) { n = McNode.of(l, o.export); this.decoInsts[i] = n; }
      n?.advance(dt);
    });
  }

  /** Sort key of an actor's nodes (setPos3D 0x851b84): ground-projected y, +48 px for an air character
   * (vt+0x108 0xf826e8 = FlyingHeight > 0 without the TAG_FORCE_IS_AIR / _GROUND status tags; a river
   * jump's z does not count). */
  private sortKey(u: Unit, x: number, y: number): number {
    return this.art.gameToPx(x, y)[1] + (u.def.flyingHeight > 0 ? 48 : 0);
  }

  /** Seconds since the last attack for the turret recoil (view +0x330, reset by the attack callback 0x846ab4). */
  private sinceAttack(u: Unit, b: Battle, f: Frame): number {
    return u.lastHitTick >= 0 ? (b.tick - u.lastHitTick + f.alpha) * 0.05 : 1e9;
  }

  /**
   * Drag-preview ghost views (0x8e4eb4): the preview actor faces the enemy King, its view is updated with
   * dt 0 (vt+0x208(0, 1)): a direction-clip character shows the idle action's first frame in the picked
   * direction (sc/anim.ts ghostSprite), a single-clip building the frame its clip player gives a state-0
   * actor (animateBuilding: e.g. Tesla's hide_start), a turret building its turret on that facing. The
   * views render every frame, so their nested clips play (instances kept per ghost slot while it lasts).
   */
  private ghostViews(sim: number): { u: ReturnType<BattleUi['ghostUnits']>[number]; o: UnitDrawOptions }[] {
    const art = this.art;
    const m = art.manifest;
    const dt = this.lastGhostSim < 0 ? 0 : Math.max(0, (sim - this.lastGhostSim) / 1000);
    this.lastGhostSim = sim;
    for (const g of this.ghostInsts.values()) g.seen = false;
    const out: { u: ReturnType<BattleUi['ghostUnits']>[number]; o: UnitDrawOptions }[] = [];
    this.ui.ghostUnits().forEach((g, i) => {
      const ca = m.characters[g.def.name];
      if (!ca) return;
      const key = `${g.team}:${i}:${g.def.name}`;
      let gi = this.ghostInsts.get(key);
      if (!gi) { gi = { ci: new ClipInstances(), anim: null, seen: true }; this.ghostInsts.set(key, gi); }
      gi.seen = true;
      const lib = art.lib(ca.sc);
      const o: UnitDrawOptions = { alpha: g.alpha, face: [g.dirX, g.dirY] };
      const sp = ghostSprite(ca, g.team, g.dirX, g.dirY, art.flip);
      const clip = g.team === 1 ? (ca.clip?.red ?? ca.clip?.blue) : ca.clip?.blue;
      if (sp) {
        o.sprite = sp;
        o.inst = gi.ci.show(lib, sp.export, sp.frame, dt) ?? undefined;
      } else if (clip) {
        let frame = 0;
        if (!clip.turretChild) {
          const labels = lib.labels(clip.export);
          if (!gi.anim) gi.anim = newBuildingAnim(ca, labels, clip.frames, clip.fps || 30);
          frame = animateBuilding(ca, g.def.name, labels, gi.anim, { state: 0, deployLeft: 0, deployTime: (ca.deployTime as number | undefined) ?? 0,
            hideT: 0, manaT: 0, collected: false, dt: 0 });
          o.inst = gi.ci.show(lib, clip.export, frame, dt) ?? undefined;
        } else {
          o.inst = this.turretInst(gi.ci, lib, clip.export, ca, [g.dirX, g.dirY], dt) ?? undefined;
          frame = o.inst ? (o.inst as McNode).frame : 0;
        }
        o.clipFrame = frame;
      }
      out.push({ u: g, o });
    });
    for (const [k, g] of this.ghostInsts) if (!g.seen) this.ghostInsts.delete(k);
    return out;
  }
  private lastGhostSim = -1;

  private instsOf(id: number): ClipInstances {
    let ci = this.insts.get(id);
    if (!ci) { ci = new ClipInstances(); this.insts.set(id, ci); }
    return ci;
  }

  /** The `turret` child instance of a building / King tower clip (0x8455cc finds it by name), cached. */
  private turretKid(n: McNode): McNode | null {
    let k = this.turretKids.get(n);
    if (k === undefined) { k = n.child('turret'); this.turretKids.set(n, k); }
    return k;
  }

  /**
   * A HasRotationOnTimeline building's clip instance this frame: made playing from its start, children
   * too (0x836e58 -> wrapper vt+0x1e0 = 0x12437b8: the root plays its frames once), the turret stopped on
   * the frame of the facing every frame (0x8455cc -> 0x1242234), then the render advance.
   */
  private turretInst(ci: ClipInstances, lib: ScLibrary, exp: string, ca: CharacterArt, face: [number, number], dt: number): McNode | null {
    const fresh = !ci.has(exp);
    const n = ci.get(lib, exp);
    if (!n) return null;
    if (fresh) n.playAll();
    const t = this.turretKid(n);
    if (t) t.gotoAndStop(turretPose(viewAngle(face[0], face[1], this.art.flip), t.frames, ca.turretMovement ?? 0, 1e9).frame);
    n.advance(dt);
    return n;
  }

  /**
   * Effect Filter components recolouring this actor's sprites (0x82ebdc, e.g. the ChargeEffect's
   * filter_protection): each multiplies the colour in with the buff filters' arithmetic
   * (sc/area_view.ts applyFilterColor; alpha kept for crown towers). Undefined: none.
   */
  /**
   * A crown tower's colour: its buff filters (each on its buff view's clock, 0x82ebdc) and effect Filter
   * components multiplied in with the crown-tower branch that keeps alpha (sc/area_view.ts).
   */
  private towerColor(u: Unit, sim: number): Readonly<Col> {
    const efc = this.effectFilters(u);
    const art = this.art;
    const buffs = u.buffs.map((q) => art.buffColor(q.def.name, this.buffViews.filterTime(q, sim)));
    return crownTowerFilterColor(buffs, efc ?? WHITE) ?? efc ?? WHITE;
  }

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
  private newBarDraw(u: Unit, spec: NewBarSpec, sim: number, f: Frame): (() => void) | null {
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
    if (u.waitTicks > 0) return null;
    const [sx, sy] = this.barShift(u, art.unitBarPx(u.def.name, team, this.viewX(u, f), this.viewY(u, f), f.uz(u) - u.def.flyingHeight));
    const part = (p: NewBarPartSpec | undefined) => (p ? { exp: exp(p), offset: p.offset } : null);
    const d = {
      base: own ? spec.base[0] : spec.base[1], badge: part(spec.badges[ch.badge]), badgeFrame, showBadge: fr.show,
      bar: part(spec.bars[ch.bar]), showBar: fr.bar, level, hpPct: fr.hpPct, shieldPct: fr.shieldPct,
      flash: this.barFlash(u, sim), rootX: view.nbRootX,
    };
    return () => { view.nbRootX = art.drawNewHealthBar(r, sx, sy, d); };
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
    this.instNow.clear();
    this.kingNow.clear();
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
      const raw = u.tower === TOWER_NONE ? this.rawRow(b, u.def.name) : null;
      const vhs = raw?.vhs ?? null;
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
        scale: buffTimeScale(u),
        // the attack frame's VisualHitSpeed branch (0x845244) and the view's sequence index +0x4cc (the
        // engine's index each frame, sc/char_effects.ts infernoLevel)
        visualHitSpeed: vhs ? vhs[0] : 0, visualHitSpeedCur: vhs ? vhs[Math.min(2, Math.max(0, u.seqIndex))] : 0,
        seqMode: u.tower === TOWER_NONE && u.def.seqMode !== 0,
        attackShakeTime: raw?.shake ?? 0, battleOver: b.result !== null, rand: this.rand,
      });
      this.sprites.set(u.id, af);
      // the shown direction clip's instance: stopped on this frame, its nested clips advanced by the render
      // (0x123f55c); a view hidden in state 11 is not rendered, so its clips keep their playheads
      if (af && u.waitTicks <= 0) this.instNow.set(u.id, this.instsOf(u.id).show(this.art.lib(ca.sc), af.export, af.frame, dt));
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
        // 0x83e524 passes the buffs' AudioPitchModifier product as the effect speed +0xb0 (sound pitch)
        if (u.tower === TOWER_PRINCESS) {
          if (eff && this.fx.has(eff)) {
            this.fx.play(eff, u.x, u.y, { team: u.team as Team, z: (m.towers.princess.attachedHeight as number | undefined) ?? 0, loop: false,
              soundPitch: this.charFx.attackStartPitch(u) });
          }
        } else {
          this.charFx.playOnActor(u, eff, undefined, this.charFx.attackStartPitch(u));
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
      const frame = animateBuilding(ca, u.def.name, labels, s, {
        state: u.state === ST_DEPLOYING ? 4 : u.locked ? 2 : 0, deployLeft: u.deployTicks * 50,
        deployTime: (ca.deployTime as number | undefined) ?? u.deployTotal * 50, hideT: u.hideT, manaT: u.manaT,
        collected: this.collected.has(u.id), dt,
      });
      this.clipFrames.set(u.id, frame);
      if (u.waitTicks <= 0) this.instNow.set(u.id, this.instsOf(u.id).show(lib, clip.export, frame, dt));
    }
    // HasRotationOnTimeline buildings (Cannon, X-Bow): the root plays once from its creation, the turret
    // follows the facing (0x8455cc); the root frame is the instance's
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.tunneling || u.tower !== TOWER_NONE || u.waitTicks > 0) continue;
      const ca = m.characters[u.def.name];
      const clip = u.team === 1 ? (ca?.clip?.red ?? ca?.clip?.blue) : ca?.clip?.blue;
      if (!ca || !clip || !clip.turretChild) continue;
      seen.add(u.id);
      const n = this.turretInst(this.instsOf(u.id), this.art.lib(ca.sc), clip.export, ca, [u.dirX, u.dirY], dt);
      this.instNow.set(u.id, n);
      if (n) this.clipFrames.set(u.id, n.frame);
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
      // the tower and King clip instances on the controller's frame; the turret on the facing (0x8455cc)
      seen.add(u.id);
      const ci = this.instsOf(u.id);
      const tower = ci.get(this.art.lib(kt.sc), u.team === 0 ? kt.blue : kt.red);
      if (tower) {
        const tk = this.turretKid(tower);
        if (tk) tk.gotoAndStop(turretPose(viewAngle(u.dirX, u.dirY, this.art.flip), tk.frames, kt.turretMovement ?? 0, 1e9).frame);
        tower.gotoAndStop(c.clip.frame);
        tower.advance(dt);
      }
      const king = ci.show(this.art.lib(kt.king.sc), u.team === 0 ? kt.king.blue : kt.king.red, c.clip.frame, dt);
      this.kingNow.set(u.id, { tower, king });
    }
    for (const id of this.insts.keys()) if (!seen.has(id)) this.insts.delete(id);
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
   * vtb8; undefined below speed 1 (the client skips the landing cap).
   */
  private jumpLeft(u: Unit, w: number): number | undefined {
    const speed = jumpMoveSpeed(u);
    if (speed < 1 || !u.path.length) return undefined;
    const cell = u.path[u.path.length - 1];
    const dx = (cell % w) * 500 - u.x;
    const dy = Math.floor(cell / w) * 500 - u.y;
    const d = Math.abs(dx) > 46340 || Math.abs(dy) > 46340 || dx * dx + dy * dy > 0x7fffffff ? isqrt(0x7fffffff) : isqrt(dx * dx + dy * dy);
    return idiv(d, speed);
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
          team: p.team as Team, ci: new ClipInstances(), inst: null, shadowInst: null,
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
      // the sprite clip on the view's frame (pitch frame, or the rolling clip's own timeline), its nested
      // clips advanced by the render; the shadow clip plays by itself
      const lib = this.art.lib(pa.sc);
      const sdt = pv.ageMs > 0 ? dt / 1000 : 0;
      pv.inst = pv.ci.show(lib, (p.team === 1 && pa.redExport) ? pa.redExport : pa.export, pv.v.frame ?? (pv.clip ? pv.clip.frame : 0), sdt);
      const sexp = (p.team === 1 && pa.redShadow) ? pa.redShadow : pa.shadow;
      pv.shadowInst = sexp ? pv.ci.get(lib, sexp) : null;
      pv.shadowInst?.advance(sdt);
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

/**
 * The buff time scale of a 50 ms step (Buff_timeScale 0xfc27b8, as the engine's attack clock step):
 * 50 · max(100, strongest haste)/100 · clamp(100 + strongest slow, 0..100)/100 with truncation; 0 while
 * frozen or stunned.
 */
export function buffTimeScale(u: Unit): number {
  if (u.buffs.length === 0) return 50;
  let haste = 100, slow = 0;
  for (const b of u.buffs) {
    const m = b.def.hitSpeedMul;
    if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
  }
  return idiv(idiv(50 * haste, 100) * Math.min(100, Math.max(0, 100 + slow)), 100);
}

export type { Mat };
