// BattleArt: game-space helpers on top of ScRenderer + manifest.json — arena alignment,
// background + decorations, towers (King activation, turret aim, princess), units (direction,
// deploy filter, shadows), projectiles and health bars. Depth sorting is left to the caller:
// everything here takes explicit game coordinates and draws immediately.
//
// Game space: integer units, 1000 per tile, x right, +y toward red (screen up), z up.
// SC space: the arena export's pixels (y down). See manifest.arena for the constants.

import type { Col, Mat } from './math.ts';
import { colMul, matMul, WHITE } from './math.ts';
import { emptyLibrary, ScLibraryCache } from './library.ts';
import type { ScLibrary, ShapeCmd } from './library.ts';
import type { BuildingClip, CharacterArt, ClipRef, Manifest } from './manifest.ts';
import { loadManifest } from './manifest.ts';
import type { ClipInst, DrawOptions } from './renderer.ts';
import { ScRenderer } from './renderer.ts';
import { applyFilterColor, filterClipLength, filterFrame } from './area_view.ts';
import { newProjectileViewState, projectileMatrix, projectileView } from './projectile_view.ts';
import type { ProjectileViewFrame } from './projectile_view.ts';
import { turretPose, viewAngle as nativeViewAngle } from './anim.ts';
import { radialFillStrip } from './ui_port.ts';
import { barFrame, healthBarState } from './unit_view.ts';
import type { BarState, HealthBarFlags } from './unit_view.ts';

/** One client-action health bar part as drawn (sc/unit_view.ts; component 0x853574). */
export interface NewBarPartArt {
  exp: string;
  offset: [number, number];
}

/** A client-action health bar's frame for BattleArt.drawNewHealthBar. */
export interface NewBarDraw {
  /** component position x: NewHealthBarOffsetX + NewHealthBarOffsetXBlue / Red (0xde1668, own / enemy) */
  base: number;
  badge: NewBarPartArt | null;
  badgeFrame: number;
  showBadge: boolean;
  bar: NewBarPartArt | null;
  showBar: boolean;
  level: number;
  hpPct: number;
  shieldPct: number;
  /** view +0x470 */
  flash: number;
  /** root x kept from the last frame */
  rootX: number;
}

export type Team = 0 | 1;

/** A sprite chosen by the client's view update (sc/anim.ts animate / ghostSprite / gallerySprite). */
export interface SpriteRef {
  export: string;
  frame: number;
  mirror: boolean;
  /** AttackShakeTime: the direction clip's own position inside the sprite container (0x840d44 @0x842c44) */
  shake?: [number, number];
}

/** The facing a crown tower or building view starts with (blue faces +y, red −y; logic units). */
export function defaultFacing(team: Team): [number, number] {
  return team === 0 ? [0, 256] : [0, -256];
}

export interface UnitDrawOptions {
  z?: number; // game units above ground (FlyingHeight is added automatically)
  deployMs?: number; // ms since deploy start: plays the deploy filter clip while < its length
  /** the clip view vt+0x140 put in the filter slot (a death spawn, 0xf8aac8 -> 0x846e6c); undefined:
   * DeployBaseAnimExportName (vt+0x138 0x846b2c), null: none */
  deployFilter?: ClipRef | null;
  alpha?: number;
  color?: Col;
  /** active buffs with ms since each was applied: their colour filters are combined (Freeze, Rage...) */
  buffs?: { name: string; ms: number }[];
  /** hit filter (DamageExportName_<dir>) and ms since the hit; replaces the deploy filter while it plays */
  damage?: { dir: 'down' | 'left' | 'up' | 'right'; ms: number };
  /** buildings with a labelled clip: label to show / play (e.g. Tesla 'hidden' | 'appear' | 'up' | 'hide',
   * Tombstone 'deploy', bombs 'attack'); `<state>_start`..`<state>_end` ranges play over stateMs */
  state?: string;
  stateMs?: number;
  /** single-clip buildings: frame chosen by the client's clip player (sc/anim.ts animateBuilding) */
  clipFrame?: number;
  /** export + frame + mirror chosen by the client's view update (sc/anim.ts); characters draw nothing without it */
  sprite?: SpriteRef;
  /** the shown clip's instance (sc/movieclip.ts ClipInstances): its nested clips' own playheads */
  inst?: ClipInst;
  /** facing vector (actor +0xf8/+0xfc) for turrets (default: the team's starting facing), and seconds since
   * the last attack (recoil) */
  face?: [number, number];
  sinceAttackS?: number;
  /** the view's shake / recoil offset (battle px) on its sprite entries (0x839b08 from vt+0xf0 / vt+0xf8) */
  shift?: [number, number];
}

export class BattleArt {
  readonly manifest: Manifest;
  readonly libs: ScLibraryCache;
  readonly baseUrl: string;

  constructor(manifest: Manifest, libs: ScLibraryCache, baseUrl: string) {
    this.manifest = manifest;
    this.libs = libs;
    this.baseUrl = baseUrl;
  }

  /**
   * Load manifest.json and the libraries a battle always needs (or only `only`): everything but the
   * character / building libraries, plus the towers' and the arena's. Unit libraries are loaded by
   * prewarm() or on first use (decoded, all of them take ~840 MB of RGBA).
   */
  static async load(baseUrl = 'assets', only?: Iterable<string>): Promise<BattleArt> {
    const m = await loadManifest(baseUrl);
    const libs = new ScLibraryCache(baseUrl);
    await libs.loadAll(only ?? BattleArt.coreLibs(m));
    return new BattleArt(m, libs, baseUrl);
  }

  static coreLibs(m: Manifest): string[] {
    const out = new Set(Object.keys(m.libs).filter((k) => !k.startsWith('chr_') && !k.startsWith('building_')));
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'sc' && typeof v === 'string' && m.libs[v]) out.add(v);
        else walk(v);
      }
    };
    walk(m.towers);
    walk(m.arena);
    return [...out];
  }

  /** Called with each library that finishes loading after startup (the renderer uploads its atlases). */
  onLibLoaded: ((lib: ScLibrary) => void) | null = null;
  private readonly empty = new Map<string, ScLibrary>();

  private readonly requested = new Set<string>();
  private request(name: string): Promise<void> {
    if (!this.manifest.libs[name] || this.libs.get(name)) return Promise.resolve();
    const first = !this.requested.has(name);
    this.requested.add(name);
    return this.libs.load(name).then((lib) => { if (first) this.onLibLoaded?.(lib); }, (err) => console.warn('library', name, err));
  }

  /** A library, or an empty stand-in while it loads in the background (drawing nothing for a moment). */
  lib(name: string): ScLibrary {
    const l = this.libs.get(name);
    if (l) return l;
    this.request(name);
    let e = this.empty.get(name);
    if (!e) { e = emptyLibrary(name); this.empty.set(name, e); }
    return e;
  }

  /** Load the libraries of these characters / projectiles / spells / area effects (resolves when loaded). */
  prewarm(names: Iterable<string>): Promise<void> {
    const m = this.manifest as unknown as Record<string, Record<string, { sc?: string } | undefined> | undefined>;
    const libs = new Set<string>();
    const seen = new Set<unknown>();
    // an entry's own library and those of every effect / emitter it names (hit, death, trail effects)
    const walk = (o: unknown, depth: number): void => {
      if (depth > 6 || o === null || seen.has(o)) return;
      if (typeof o === 'string') {
        const fx = this.manifest.effects[o] ?? this.manifest.emitters[o];
        if (fx) walk(fx, depth + 1);
        return;
      }
      if (typeof o !== 'object') return;
      seen.add(o);
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === 'sc' && typeof v === 'string') libs.add(v);
        else walk(v, depth + 1);
      }
    };
    for (const n of names) {
      for (const table of ['characters', 'projectiles', 'spells', 'areaEffects']) walk(m[table]?.[n], 0);
    }
    return Promise.all([...libs].map((l) => this.request(l))).then(() => undefined);
  }

  // -- coordinates -----------------------------------------------------------------------------
  //
  // libg 160402020 battle view projection FUN_00857ffc, fed world = logic * 0.002 (FUN_00851b54,
  // FUN_00851b84):  sx = ox + 15 * wx,  sy = oy + 12 * (wy - wz / 2),  ox = -(36 >> 1) * 15
  // (0x8578e4, 36 x 64 = the path grid), oy = 0. For the viewer who is logic player 0 (blue, the
  // bottom side; 0xbdeec0 -> 0x856c58 sets ctx+0x1b9) x and y are flipped first (wx' = 36 - wx,
  // wy' = 64 - wy) and the arena clip gets a 180-degree matrix with ty = 768 (0x856c58, 0x8589a4).
  // Location objects are placed once through the same projection while the flag is still clear
  // (0x856088 -> 0x8578e4 -> 0x85868c); 0x856c58 later rotates only the arena clip, so decorations
  // keep their unflipped positions for both players. Per logic unit: 0.03 SC px across, 0.024
  // along, 0.012 per unit of height. The arena export sits at the battle layer origin.

  /** true: the view of logic player 0 (blue at the bottom; the native flipped view). */
  flip = true;

  get pxPerTileX(): number { return 30; }
  get pxPerTileY(): number { return 24; }
  /** SC px per 1000 units of height */
  get zPxPer1000(): number { return 12; }
  /** on-screen y foreshortening (pxPerTileY / pxPerTileX) */
  get yScale(): number { return 0.8; }

  /** Game point (x, y, z) -> battle-layer SC pixels. */
  gameToPx(x: number, y: number, z = 0): [number, number] {
    const wx = this.flip ? 18000 - x : x;
    const wy = this.flip ? 32000 - y : y;
    return [-270 + wx * 0.03, wy * 0.024 - z * 0.012];
  }

  /** Battle-layer SC pixels -> game (x, y) on the ground. */
  pxToGame(px: number, py: number): [number, number] {
    const wx = (px + 270) / 0.03, wy = py / 0.024;
    return this.flip ? [18000 - wx, 32000 - wy] : [wx, wy];
  }

  /** Engine (dx, dy) -> screen-up (dx, dy). */
  viewVec(dx: number, dy: number): [number, number] { return this.flip ? [-dx, dy] : [dx, -dy]; }

  /** Location object (locations/*.csv x, y: logic units, placed unflipped) -> battle-layer SC pixels. */
  decoPx(o: { x: number; y: number }): [number, number] { return [-270 + o.x * 0.03, o.y * 0.024]; }

  /** SC-pixel rectangle covering the 18x32-tile battlefield (plus `marginTiles`). */
  fieldRect(marginTiles = 0): [number, number, number, number] {
    const [ax, ay] = this.gameToPx(-marginTiles * 1000, 32000 + marginTiles * 1000);
    const [bx, by] = this.gameToPx(18000 + marginTiles * 1000, -marginTiles * 1000);
    const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
    return [x0, y0, Math.max(ax, bx) - x0, Math.max(ay, by) - y0];
  }

  // -- arena -----------------------------------------------------------------------------------

  /**
   * The arena clip. With `inst` (its MovieClip instance, made with the battle layer 0x856088 → 0x120cc50)
   * the nested clips (river, flags, crowds) play on their own playheads; without one they loop on one
   * shared clock from the battle's start (gallery).
   */
  drawBackground(r: ScRenderer, timeMs = 0, inst?: ClipInst): void {
    const a = this.manifest.arena;
    const lib = this.lib(a.sc);
    r.draw(lib, a.export, inst ? inst.frame : 0, this.flip ? [-1, 0, 0, -1, 0, 768] : [1, 0, 0, 1, 0, 0], undefined,
      inst ? { inst } : { childFrame: Math.floor((timeMs * (lib.fps(a.export) || 24)) / 1000) });
  }

  /** A decoration at its position: on its clip instance's playheads (`inst`), else on the deco's clock. */
  drawDeco(r: ScRenderer, o: Manifest['arena']['objects'][number], timeMs: number, m?: Mat, inst?: ClipInst): void {
    const [px, py] = this.decoPx(o);
    const t = Math.floor((timeMs * (o.fps || 30)) / 1000);
    if (inst) { r.draw(this.lib(o.sc), o.export, inst.frame, m ?? [1, 0, 0, 1, px, py], undefined, { inst }); return; }
    r.draw(this.lib(o.sc), o.export, o.frames && o.frames > 1 ? t : 0, m ?? [1, 0, 0, 1, px, py], undefined, { childFrame: t });
  }

  /** Decorations of one or more layers ('Base', 'Ground', 'Object'), in data order; `insts` by object index. */
  drawArenaObjects(r: ScRenderer, timeMs: number, layers: string[] = ['Base', 'Ground', 'Object'], insts?: readonly (ClipInst | null)[]): void {
    const objs = this.manifest.arena.objects;
    for (let i = 0; i < objs.length; i++) {
      if (layers.includes(objs[i].layer)) this.drawDeco(r, objs[i], timeMs, undefined, insts?.[i] ?? undefined);
    }
  }

  // -- shadows ---------------------------------------------------------------------------------
  //
  // libg 160402020: every shadow is a second instance of the object's clip in the shadow layer whose
  // matrix FUN_00851d7c resets to identity and sets to
  //   a = ShadowScaleX, d = -ShadowScaleY (|current|), c = ShadowSkew, (tx, ty) = (ShadowX, ShadowY)
  // (all /100 except the pixel offset). For characters/buildings 0xdde618 loads ShadowScaleY as
  // ShadowScaleX when it is 0; a missing ShadowScaleX gives a zero-width (invisible) shadow. The
  // unit's Scale is not applied (the shadow container 0x338 is at scale 1, 0x83ce70). Decorations use
  // the same setter with their decos.csv values (0x84c1b8). Characters with ShadowCustom draw that
  // clip instead, scaled CollisionRadius / 1200 (0x83ce70 blob branch).

  /** Shadow-clip matrix (SC px) at ground pixel (px, py). */
  shadowMatrix(scaleX: number, scaleY: number, skew: number, x: number, y: number, px: number, py: number,
    mirror = false): Mat {
    const a = scaleX / 100;
    return [mirror ? -a : a, 0, skew / 100, -scaleY / 100, px + x, py + y];
  }

  /** Character/building shadow values with the data loader's ShadowScaleY default. */
  private charShadow(o: { shadowScaleX?: number; shadowScaleY?: number; shadowSkew?: number; shadowX?: number;
    shadowY?: number }): [number, number, number, number, number] {
    const sx = o.shadowScaleX ?? 0;
    return [sx, o.shadowScaleY || sx, o.shadowSkew ?? 0, o.shadowX ?? 0, o.shadowY ?? 0];
  }

  /**
   * Composite the shadow layer (call after drawing silhouettes between r.beginShadows() and here).
   * shadow_2d_composite as set up by 0x86beb8 / 0x856088: u_c = (R/510, G/510, B/510, A/128) of the
   * location's Shadow* colour; tap offset 100 / (SHADOW_BLUR_DISTANCE/100 * ShadowOffsetX|Y) texels.
   */
  endShadowPass(r: ScRenderer): void {
    const sh = this.manifest.arena.shadow ?? {};
    const blur = (this.manifest.arena.shadowBlurDistance ?? 170) / 100;
    const offX = sh.ShadowOffsetX ?? 0, offY = sh.ShadowOffsetY ?? 0;
    r.endShadows(
      [(sh.ShadowR ?? 0) / 510, (sh.ShadowG ?? 0) / 510, (sh.ShadowB ?? 0) / 510, (sh.ShadowA ?? 0) / 128],
      [offX ? 100 / (blur * offX) : 0, offY ? 100 / (blur * offY) : 0]);
  }

  /** Decoration shadows (decos.csv Shadow* fields, no ScaleY default); `insts` by object index. */
  drawArenaShadows(r: ScRenderer, timeMs: number, layers: string[] = ['Base', 'Ground', 'Object'], insts?: readonly (ClipInst | null)[]): void {
    const objs = this.manifest.arena.objects;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!layers.includes(o.layer) || !o.shadowScaleX) continue;
      const [px, py] = this.decoPx(o);
      this.drawDeco(r, o, timeMs,
        this.shadowMatrix(o.shadowScaleX, o.shadowScaleY ?? 0, o.shadowSkew ?? 0, o.shadowX ?? 0, o.shadowY ?? 0, px, py), insts?.[i] ?? undefined);
    }
  }

  /**
   * Crown tower shadow: the main export (King: KingTower_*, Princess: StarTower_base_*) plus the tower
   * princess's own shadow (she is a character attached to the tower, at its ground position). The King
   * tower's shadow copy gets the King too (0x836e58 @0x83884c: 0x83f4e4 on the shadow clip puts King_blue /
   * King_red in its king_dummy, driven by the same activation controller, so on the King frame `kingFrame`)
   * and its turret takes the main turret's frame, mirror and recoil every frame (0x8455cc), while 0x8455cc
   * also stops the shadow root on frame 0 (+0x338 vt+0xb8(0)) for every HasRotationOnTimeline building.
   */
  drawTowerShadow(r: ScRenderer, kind: 'king' | 'princessLeft' | 'princessRight', team: Team, timeMs: number,
    kingFrame?: number, face?: [number, number], sinceAttackS?: number, sprite?: SpriteRef,
    insts: { tower?: ClipInst; king?: ClipInst; princess?: ClipInst } = {}): void {
    const king = kind === 'king';
    const t = king ? this.manifest.towers.king : this.manifest.towers.princess;
    const [x, y] = this.towerPos(kind, team);
    const [px, py] = this.gameToPx(x, y);
    const d = t.shadow ?? {};
    const sx = d.ScaleX ?? 0;
    const m = this.shadowMatrix(sx, d.ScaleY || sx, d.Skew ?? 0, d.X ?? 0, d.Y ?? 0, px, py);
    const lib = this.lib(t.sc);
    if (king) {
      const k = this.manifest.towers.king;
      const exp = team === 0 ? k.blue : k.red;
      const kf = kingFrame ?? lib.labels(exp).idle ?? 0;
      const clock = Math.floor((timeMs * k.fps) / 1000);
      const named: DrawOptions['named'] = {
        [k.kingChild]: { lib: this.lib(k.king.sc), export: team === 0 ? k.king.blue : k.king.red, frame: kf, childFrame: clock,
          inst: insts.king },
        [k.turretChild]: this.turretOverride(k.turretFrames, k.turretMovement ?? 0, face ?? defaultFacing(team), sinceAttackS),
      };
      r.draw(lib, exp, 0, m, WHITE, insts.tower ? { inst: insts.tower, named } : { childFrame: clock, named });
      return;
    }
    const p = this.manifest.towers.princess;
    r.draw(lib, p.base[team === 0 ? 'blue' : 'red'], 0, m);
    const pc = this.manifest.characters[p.character];
    if (pc && sprite) {
      const [a, b, c, dx, dy] = this.charShadow(pc);
      r.draw(this.lib(pc.sc), sprite.export, sprite.frame, this.shadowMatrix(a, b, c, dx, dy, px, py, sprite.mirror),
        WHITE, insts.princess ? { inst: insts.princess } : {});
    }
  }

  /**
   * Named override for a `turret` child (FUN_008455cc): frame from the view angle of the facing (0x844f78),
   * mirror and recoil offset (the turret's timeline matrices are translations, so composing the code-set
   * scale sign and offset after them equals the client's setScaleX / position set).
   */
  turretOverride(n: number, turretMovement: number, face: [number, number], sinceAttackS = 1e9): NonNullable<DrawOptions['named']>[string] {
    const p = turretPose(nativeViewAngle(face[0], face[1], this.flip), n, turretMovement, sinceAttackS);
    return { frame: p.frame, matrix: [p.sign, 0, 0, 1, p.ox, p.oy] };
  }

  // -- towers ----------------------------------------------------------------------------------

  towerPos(kind: 'king' | 'princessLeft' | 'princessRight', team: Team): [number, number] {
    const p = this.manifest.towers.positions[kind];
    return team === 0 ? [p[0], p[1]] : [p[0], 32000 - p[1]];
  }

  /**
   * King tower. activationMs: undefined = idle (closed, king idle loop); >= 0 = ms since activation
   * started (doors open, cannon rises; 96 frames at 30 fps = 3.2 s), then held on `stop`.
   * aim: turret angle (engine convention) once active.
   */
  /**
   * King tower clip frame `ms` after activation began, for callers without the client's clip player
   * (art.ts steps the activation controller 0x8643a0 itself): start + ms·fps up to stop; idle before.
   */
  kingFrameAt(activationMs?: number): number {
    const k = this.manifest.towers.king;
    const labels = this.lib(k.sc).labels(k.blue);
    if (activationMs === undefined) return labels.idle ?? 0;
    return Math.min(labels.stop ?? k.frames - 1, (labels.start ?? 1) + Math.floor((activationMs * k.fps) / 1000));
  }

  /**
   * King tower with the King (king_dummy) and turret; `frame` = tower and King clip frame (kingFrameAt /
   * 0x8643a0); `insts` = the tower's and the King's clip instances (their nested clips' playheads), else
   * the nested clips run on the shared clock.
   */
  drawKingTower(r: ScRenderer, team: Team, timeMs: number, frame?: number,
    destroyed = false, face?: [number, number], sinceAttackS?: number, insts: { tower?: ClipInst; king?: ClipInst } = {},
    col: Readonly<Col> = WHITE): void {
    const t = this.manifest.towers.king;
    const [x, y] = this.towerPos('king', team);
    const [px, py] = this.gameToPx(x, y);
    const lib = this.lib(t.sc);
    if (destroyed) {
      r.draw(lib, t.destroyed, 0, [1, 0, 0, 1, px, py]);
      return;
    }
    const exp = team === 0 ? t.blue : t.red;
    if (frame === undefined) frame = lib.labels(exp).idle ?? 0;
    const clock = Math.floor((timeMs * t.fps) / 1000);
    const named: DrawOptions['named'] = {
      [t.kingChild]: { lib: this.lib(t.king.sc), export: team === 0 ? t.king.blue : t.king.red, frame, childFrame: clock, inst: insts.king },
      // HasRotationOnTimeline: the turret follows the facing every frame (FUN_008455cc)
      [t.turretChild]: this.turretOverride(t.turretFrames, t.turretMovement ?? 0, face ?? defaultFacing(team), sinceAttackS),
    };
    // `col`: the buff / effect filter colour of the tower (sc/area_view.ts crownTowerFilterColor, 0x82ebdc)
    r.draw(lib, exp, frame, [1, 0, 0, 1, px, py], col, insts.tower ? { inst: insts.tower, named } : { childFrame: clock, named });
  }

  /** Rubble left by a destroyed tower (manifest towers.*.destroyed; layer Base / Ground: draw it
   * with the ground pass, under units). Same as drawKingTower/drawPrincessTower(..., destroyed=true). */
  drawTowerRuin(r: ScRenderer, kind: 'king' | 'princessLeft' | 'princessRight', team: Team): void {
    const t = kind === 'king' ? this.manifest.towers.king : this.manifest.towers.princess;
    const [x, y] = this.towerPos(kind, team);
    const [px, py] = this.gameToPx(x, y);
    r.draw(this.lib(t.sc), t.destroyed, 0, [1, 0, 0, 1, px, py]);
  }

  /**
   * Princess tower: base, tower princess (her character view's sprite, raised by AttachedCharacterHeight;
   * nothing without one), top.
   */
  drawPrincessTower(r: ScRenderer, team: Team, side: 'princessLeft' | 'princessRight', sprite?: SpriteRef,
    destroyed = false, inst?: ClipInst, col: Readonly<Col> = WHITE): void {
    const t = this.manifest.towers.princess;
    const [x, y] = this.towerPos(side, team);
    const [px, py] = this.gameToPx(x, y);
    const lib = this.lib(t.sc);
    if (destroyed) {
      r.draw(lib, t.destroyed, 0, [1, 0, 0, 1, px, py]);
      return;
    }
    const tm = team === 0 ? 'blue' : 'red';
    r.draw(lib, t.base[tm], 0, [1, 0, 0, 1, px, py], col);
    const pc = this.manifest.characters[t.character];
    if (pc && sprite) {
      // the tower princess is the building's AttachedCharacter, raised by AttachedCharacterHeight
      const [qx, qy] = this.gameToPx(x, y, t.attachedHeight ?? 0);
      const s = pc.scale / 100;
      r.draw(this.lib(pc.sc), sprite.export, sprite.frame, [sprite.mirror ? -s : s, 0, 0, s, qx, qy], col, inst ? { inst } : {});
    }
    r.draw(lib, t.top[tm], 0, [1, 0, 0, 1, px, py], col);
  }

  // -- units -----------------------------------------------------------------------------------

  character(name: string): CharacterArt {
    const c = this.manifest.characters[name];
    if (!c) throw new Error(`no character art for ${name}`);
    return c;
  }

  /** Sprite matrix (SC px) for a unit at game (x, y) — exposed for custom drawing. */
  unitMatrix(art: CharacterArt, sp: SpriteRef, x: number, y: number, z = 0): Mat {
    const [px, py] = this.gameToPx(x, y, z + (art.flyingHeight ?? 0));
    const s = art.scale / 100;
    return [sp.mirror ? -s : s, 0, 0, s, px, py];
  }

  /**
   * Draw a unit with the sprite its view update chose (`o.sprite`; o.inst for its nested clips' playheads);
   * a single-clip building draws through drawBuilding. Returns the sprite drawn (or null).
   */
  drawUnit(r: ScRenderer, name: string, team: Team, x: number, y: number, o: UnitDrawOptions = {}): SpriteRef | null {
    const art = this.character(name);
    const sp = o.sprite;
    if (!sp) return art.clip ? this.drawBuilding(r, name, team, x, y, 0, o) : null;
    const m = this.filterMatrix(art, o, this.unitMatrix(art, sp, x, y, o.z ?? 0), sp.shake);
    if (o.shift) { m[4] += o.shift[0]; m[5] += o.shift[1]; }
    r.draw(this.lib(art.sc), sp.export, sp.frame, m, this.unitColor(o), o.inst ? { inst: o.inst } : {});
    return sp;
  }

  /**
   * Shadow of a unit (call between r.beginShadows() and endShadowPass()): the current sprite frame
   * through shadowMatrix at the ground position, or the ShadowCustom clip at CollisionRadius / 1200.
   */
  drawUnitShadow(r: ScRenderer, name: string, team: Team, x: number, y: number, o: UnitDrawOptions = {}): void {
    const art = this.character(name);
    const [px, py] = this.gameToPx(x, y);
    if (art.shadowCustom) {
      const s = (art.collisionRadius ?? 0) / 1200;
      r.draw(this.lib(art.shadowCustom.sc), art.shadowCustom.export, 0, [s, 0, 0, s, px, py]);
      return;
    }
    const sp = o.sprite;
    if (!sp) {
      if (art.clip) this.drawBuilding(r, name, team, x, y, 0, { ...o, shadow: true });
      return;
    }
    const [a, b, c, dx, dy] = this.charShadow(art);
    if (!a) return;
    r.draw(this.lib(art.sc), sp.export, sp.frame, this.shadowMatrix(a, b, c, dx, dy, px, py, sp.mirror), WHITE,
      o.inst ? { inst: o.inst } : {});
  }

  /**
   * The view's filter slot (+0x4c0): the deploy filter (DeployBaseAnimExportName) or, once hit, the
   * damage filter facing the hit. Played at its own fps until its last frame (0x839b08); each frame
   * the filter's first child matrix F is composed outside the sprite's scale/mirror (0x83d2e0):
   * world = T(position) * F * local. Matrix only: the colour transform is reset to identity. `clipPos` is the
   * clip's own position inside the sprite container (AttackShakeTime), kept under F (0x83d2e0 multiplies the
   * clip's whole matrix).
   */
  filterMatrix(art: CharacterArt, o: UnitDrawOptions, m: Mat, clipPos?: [number, number]): Mat {
    let f: { m: Mat; c: Col | null } | null = null;
    if (o.damage && art.damageFilters) {
      const ref = art.damageFilters[o.damage.dir];
      f = this.filterAt(ref.sc, ref.export, o.damage.ms);
    }
    const deploy = o.deployFilter !== undefined ? o.deployFilter : art.deployBaseAnimExportName;
    if (!f && !o.damage && o.deployMs !== undefined && deploy) {
      f = this.filterAt(deploy.sc, deploy.export, o.deployMs);
    }
    const lx = clipPos ? clipPos[0] : 0, ly = clipPos ? clipPos[1] : 0;
    if (!f) return clipPos ? [m[0], m[1], m[2], m[3], m[4] + lx, m[5] + ly] : m;
    const local: Mat = [m[0], m[1], m[2], m[3], lx, ly];
    return matMul(matMul([1, 0, 0, 1, m[4], m[5]], f.m), local);
  }

  /** Colour transform for a unit from UnitDrawOptions (color, alpha, buff filters). */
  unitColor(o: UnitDrawOptions): Col {
    let c: Col = o.color ? [...o.color] as Col : [1, 1, 1, 1, 0, 0, 0];
    if (o.alpha !== undefined) c[3] *= o.alpha;
    for (const b of o.buffs ?? []) {
      // each buff view's filter multiplies its colour in (0x82ebdc, sc/area_view.ts applyFilterColor)
      const bc = this.buffColor(b.name, b.ms);
      if (bc) c = applyFilterColor(c, bc);
    }
    return c;
  }

  /**
   * Colour of a buff's filter clip (character_buffs FilterFile / FilterExportName: filter_cold for
   * Freeze / Zap stun / Ice Wizard slow, filter_rage, filter_poison) `ms` after the buff's view was
   * made: the filter object 0x82ea34 / 0x82ebdc loops over the clip's length (frame ⌊t·n / D⌋) unless
   * FilterInheritLifeDuration, which plays it once over the buff's time `buffMs`; the colour is its
   * first child's at that frame. Null without a filter, or once a non-looping one has ended.
   */
  buffColor(buff: string, ms: number, buffMs = 0): Col | null {
    const b = this.manifest.buffs?.[buff];
    const f = b?.filter;
    if (!f) return null;
    const lib = this.libs.get(f.sc);
    const clip = lib?.clip(f.export);
    if (!lib || !clip) return null;
    const inherit = !!b.filterInheritLifeDuration;
    const fr = filterFrame(Math.max(0, Math.trunc(ms)), clip.frameCount, inherit ? buffMs : filterClipLength(clip.frameCount, clip.fps), !inherit);
    if (fr === null) return null;
    const i = clip.frameStart[fr];
    if (clip.frameStart[fr + 1] === i) return null;
    const ci = clip.elements[i * 3 + 2];
    if (ci < 0) return null;
    return [...lib.banks[clip.bank].c.subarray(ci * 7, ci * 7 + 7)] as Col;
  }

  /**
   * Building (or any unit whose art is one labelled clip): turret aim for clips with a `turret` child
   * (Cannon, X-Bow: frame, mirror and recoil from the facing, 0x8455cc; the shadow copy's root stopped on
   * frame 0 by the same call), the frame the client's clip player chose (`clipFrame`, sc/anim.ts
   * animateBuilding), or a labelled state (`state` / `stateMs`, gallery only), else frame 0; nested clips
   * on `o.inst`'s playheads (else the shared clock). Direction-clip buildings (Inferno Tower, Mortar) are
   * characters: drawUnit with their sprite. Draws the `top` export too when the data has one.
   */
  drawBuilding(r: ScRenderer, name: string, team: Team, x: number, y: number, timeMs: number,
    o: UnitDrawOptions & { shadow?: boolean } = {}): SpriteRef | null {
    const art = this.character(name);
    const clip: BuildingClip | undefined = team === 1 ? (art.clip?.red ?? art.clip?.blue) : art.clip?.blue;
    if (!clip) return null;
    const lib = this.lib(art.sc);
    const labels = lib.labels(clip.export);
    const fps = clip.fps || 30;
    const clock = Math.floor((timeMs * fps) / 1000);
    let frame = 0;
    const named: DrawOptions['named'] = {};
    if (clip.turretChild) {
      named[clip.turretChild] = this.turretOverride(clip.turretFrames ?? clip.frames, art.turretMovement ?? 0, o.face ?? defaultFacing(team),
        o.sinceAttackS);
      frame = o.shadow ? 0 : o.clipFrame ?? 0;
    } else if (o.clipFrame !== undefined) {
      frame = o.clipFrame;
    } else if (o.state) {
      let st = o.state;
      if (st === 'up' && labels.appear_end !== undefined) st = 'appear_end';
      if (st === 'hidden' && labels.idle !== undefined && labels.appear_start !== undefined) st = 'idle';
      const a = labels[`${st}_start`], b = labels[`${st}_end`];
      if (a !== undefined && b !== undefined) frame = Math.min(b, a + Math.floor(((o.stateMs ?? 0) * fps) / 1000));
      else if (labels[st] !== undefined) frame = labels[st];
    }
    const [px, py] = this.gameToPx(x, y, (o.z ?? 0) + (art.flyingHeight ?? 0));
    const s = art.scale / 100;
    let m: Mat = [s, 0, 0, s, px, py];
    if (o.shadow) {
      const [a, b, c, dx, dy] = this.charShadow(art);
      if (!a) return null;
      const [gx, gy] = this.gameToPx(x, y);
      m = this.shadowMatrix(a, b, c, dx, dy, gx, gy);
    }
    const c = this.unitColor(o);
    if (!o.shadow) m = this.filterMatrix(art, o, m);
    r.draw(lib, clip.export, frame, m, c, o.inst ? { inst: o.inst, named } : { childFrame: clip.turretChild ? frame : clock, named });
    const top = team === 1 ? (art.top?.red ?? art.top?.blue) : art.top?.blue;
    if (top && !o.shadow) r.draw(lib, top.export, 0, m, c);
    return { export: clip.export, frame, mirror: false };
  }

  /** Deploy countdown clock over a deploying unit (ui.sc troopDeployTimer_player / _enemy); frac 0..1. */
  drawDeployTimer(r: ScRenderer, team: Team, px: number, py: number, frac: number, scale = 1): void {
    const lib = this.libs.get(this.manifest.hud.sc);
    const exp = team === 0 ? 'troopDeployTimer_player' : 'troopDeployTimer_enemy';
    if (!lib || !lib.has(exp)) return;
    const end = lib.labels(exp).end ?? lib.frameCount(exp) - 1;
    const f = Math.max(0, Math.min(end, Math.round(frac * end)));
    r.draw(lib, exp, f, [scale, 0, 0, scale, px, py], WHITE, { childFrame: f });
  }

  private thumbRenderer: ScRenderer | null = null;
  private thumbCanvas: HTMLCanvasElement | null = null;
  private thumbCache = new Map<string, Promise<string>>();

  /**
   * Render a card (drawCard: frame + original in-battle icon + elixir cost) into an offscreen canvas
   * and return a PNG data URL for DOM use. width in CSS px (height = width * 168 / 130: the card_item_frame
   * plus the elixir drop below it).
   */
  cardThumbnail(card: string, width = 120, opts: { elixir?: number; dim?: boolean; pixelRatio?: number } = {}): Promise<string> {
    const pr = opts.pixelRatio ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const key = `${card}|${width}|${opts.elixir ?? ''}|${opts.dim ? 1 : 0}|${pr}`;
    let p = this.thumbCache.get(key);
    if (p) return p;
    p = (async () => {
      if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
      const w = Math.round(width * pr), h = Math.round(((width * 168) / 130) * pr);
      if (!this.thumbCanvas) {
        this.thumbCanvas = document.createElement('canvas');
        this.thumbCanvas.width = w;
        this.thumbCanvas.height = h;
        this.thumbRenderer = new ScRenderer(this.thumbCanvas, { alpha: true, antialias: true });
      }
      const cv = this.thumbCanvas, r = this.thumbRenderer!;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const s = w / 130;
      r.begin([0, 0, 0, 0]);
      this.drawCard(r, card, [s, 0, 0, s, w / 2, 81 * s], { elixir: opts.elixir, dim: opts.dim });
      r.end();
      return cv.toDataURL('image/png');
    })();
    this.thumbCache.set(key, p);
    return p;
  }

  private sliceCanvas: HTMLCanvasElement | null = null;
  private sliceRenderer: ScRenderer | null = null;

  /**
   * Render a 9-slice export (sc/ui_common.sc buttons, popup backgrounds) at `scale` device px per SC px
   * into a PNG for CSS border-image: the image covers the frame-0 bounds, `slice` the insets of the
   * clip's scaling grid (top, right, bottom, left, image px) and `size` the bounds in SC px.
   */
  sliceImage(libName: string, exportName: string, scale = 2): { url: string; slice: [number, number, number, number]; size: [number, number] } | null {
    const lib = this.libs.get(libName);
    const b = lib?.frameBounds(exportName, 0);
    if (!lib || !b || typeof document === 'undefined') return null;
    const x0 = Math.floor(b[0]), y0 = Math.floor(b[1]), x1 = Math.ceil(b[2]), y1 = Math.ceil(b[3]);
    const w = Math.max(1, Math.round((x1 - x0) * scale)), h = Math.max(1, Math.round((y1 - y0) * scale));
    // one offscreen context for all of them (browsers cap live WebGL contexts)
    if (!this.sliceCanvas) {
      this.sliceCanvas = document.createElement('canvas');
      this.sliceCanvas.width = w; this.sliceCanvas.height = h;
      this.sliceRenderer = new ScRenderer(this.sliceCanvas, { alpha: true, antialias: true });
    }
    const cv = this.sliceCanvas, r = this.sliceRenderer!;
    cv.width = w; cv.height = h;
    r.begin([0, 0, 0, 0]);
    r.draw(lib, exportName, 0, [scale, 0, 0, scale, -x0 * scale, -y0 * scale]);
    r.end();
    const url = cv.toDataURL('image/png');
    const g = lib.clip(exportName)?.grid ?? [x0, y0, x1, y1];
    const k = (v: number) => Math.max(0, Math.round(v * scale));
    return { url, slice: [k(g[1] - y0), k(x1 - g[2]), k(y1 - g[3]), k(g[0] - x0)], size: [x1 - x0, y1 - y0] };
  }

  /** Matrix + colour of a "filter" clip (single animated element, e.g. the deploy drop/flash). */
  filterAt(libName: string, exportName: string, ms: number): { m: Mat; c: Col | null } | null {
    const lib = this.libs.get(libName);
    const clip = lib?.clip(exportName);
    if (!lib || !clip) return null;
    const f = Math.floor((ms * clip.fps) / 1000);
    if (f >= clip.frameCount) return null;
    const i = clip.frameStart[Math.max(0, f)];
    if (clip.frameStart[f + 1] === i) return null;
    const mi = clip.elements[i * 3 + 1], ci = clip.elements[i * 3 + 2];
    const bank = lib.banks[clip.bank];
    const m: Mat = mi >= 0 ? [...bank.m.subarray(mi * 6, mi * 6 + 6)] as Mat : [1, 0, 0, 1, 0, 0];
    const c: Col | null = ci >= 0 ? [...bank.c.subarray(ci * 7, ci * 7 + 7)] as Col : null;
    return { m, c };
  }

  // -- projectiles -----------------------------------------------------------------------------

  /**
   * Projectile sprite as the client's projectile view draws it (sc/projectile_view.ts, 0x8554b0):
   * the export (RedExportName for the enemy, 0x8545e0) at logic (x, y) and `v.height` world units,
   * container scale v.scale, clip rotation v.rotation degrees, frame v.frame (or `clipFrame` for clips
   * running on their own timeline, e.g. rolling projectiles); nested clips get `childFrame`.
   */
  drawProjectileView(r: ScRenderer, name: string, team: Team, x: number, y: number, v: ProjectileViewFrame,
    clipFrame = 0, childFrame?: number, inst?: ClipInst): void {
    const p = this.manifest.projectiles[name];
    if (!p || !p.sc || !p.export) return;
    const lib = this.lib(p.sc);
    const exp = (team === 1 && p.redExport) ? p.redExport : p.export;
    const [px, py] = this.gameToPx(x, y, v.height / 0.002);
    const frame = v.frame ?? clipFrame;
    r.draw(lib, exp, frame, projectileMatrix(v.rotation, v.scale, px, py), WHITE, inst ? { inst } : { childFrame: childFrame ?? frame });
  }

  /** The projectile's shadow clip at (x, y, 0), rotated like the sprite unless ShadowDisableRotate and not
   * scaled (0x8545e0 / 0x8554b0); draw it inside the shadow pass (silhouette, 0x856a40). With its instance
   * the clip shows the instance's frame (nothing sets it: it plays by itself), else frame 0. */
  drawProjectileShadow(r: ScRenderer, name: string, team: Team, x: number, y: number, v: ProjectileViewFrame,
    inst?: ClipInst): void {
    const p = this.manifest.projectiles[name];
    const exp = (team === 1 && p?.redShadow) ? p.redShadow : p?.shadow;
    if (!p || !p.sc || !exp) return;
    const [gx, gy] = this.gameToPx(x, y, 0);
    r.draw(this.lib(p.sc), exp, inst ? inst.frame : 0, projectileMatrix(v.shadowRotation, 1, gx, gy), WHITE, inst ? { inst } : {});
  }

  /** Gallery helper: a projectile at game (x, y, z) moving with (vx, vy, vz) (engine units / s), through
   * the same view code with a level flight (pitch from vz). */
  drawProjectile(r: ScRenderer, name: string, team: Team, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, timeMs: number, shadow = true): void {
    const p = this.manifest.projectiles[name];
    if (!p || !p.sc || !p.export) return;
    const st = newProjectileViewState();
    const dz = (vz / 1000) * 50; // per tick
    const v = projectileView(p, p.frames ?? 1, st, { x, y, tx: x + vx, ty: y + vy, z: z + dz, prevZ: z, alpha: 0,
      flip: this.flip, own: team === 0, name });
    if (shadow) this.drawProjectileShadow(r, name, team, x, y, v);
    const clip = Math.floor((timeMs * (p.fps ?? 30)) / 1000) % Math.max(1, p.frames ?? 1);
    this.drawProjectileView(r, name, team, x, y, v, clip);
  }

  // -- health bars -----------------------------------------------------------------------------

  private hbCache = new Map<string, number>();

  /**
   * Health bar y offset (SC px) from a view's origin, as the character view's setup 0x836e58 computes it
   * once (@0x838a34): the bounds of the view's reference clip at the view's creation (frame 0, nested clips
   * on frame 0) with its own scale and no translation (wrapper vt+0x1b8 0xd16930 -> 0x123c5ac(clip, no
   * target space) -> 0x125a0f4), its top rounded up (frintp), plus HealthBarOffsetY + HealthBarOffsetYBlue
   * (own view) / Red (0xde1688; the 2v2 terms are 0 in 1v1).
   */
  barOffsetY(libName: string, exportName: string, scale: number, base: number, blue: number, red: number, own: boolean): number {
    const key = `${libName}/${exportName}/${scale}`;
    let top = this.hbCache.get(key);
    if (top === undefined) {
      const lib = this.libs.get(libName);
      const b = lib?.frameBounds(exportName, 0);
      top = b ? Math.ceil(Math.fround(b[1] * scale)) : 0;
      if (lib) this.hbCache.set(key, top);
    }
    return top + base + (own ? blue : red);
  }

  private kingTop: (number | undefined)[] = [];

  /**
   * Tower health bar position (SC px), barOffsetY on the view's reference clip: the princess tower's base
   * (its own export, the BASE sprite of a building with an AttachedCharacter: loader 0xddf8a8 copies
   * Blue/RedExportName to data +712/+720, 0x836e58 measures that clip), the King tower's main clip with
   * the King already in its king_dummy (0x836e58 runs 0x83f4e4 @0x838820 before the query @0x838a34;
   * King_blue / King_red on frame 0).
   */
  towerBarPx(kind: 'king' | 'princessLeft' | 'princessRight', team: Team): [number, number] {
    const [x, y] = this.towerPos(kind, team);
    const [px, py] = this.gameToPx(x, y);
    if (kind === 'king') {
      const k = this.manifest.towers.king;
      let top = this.kingTop[team];
      if (top === undefined) {
        top = this.kingTowerTop(team) ?? undefined;
        this.kingTop[team] = top;
      }
      return [px, py + (top ?? 0) + (team === 0 ? k.healthBarOffsetYBlue ?? 0 : k.healthBarOffsetYRed ?? 0)];
    }
    const t = this.manifest.towers.princess;
    const exp = t.base[team === 0 ? 'blue' : 'red'];
    return [px, py + this.barOffsetY(t.sc, exp, (t.scale ?? 100) / 100, 0, t.healthBarOffsetYBlue ?? 0, t.healthBarOffsetYRed ?? 0, team === 0)];
  }

  /** ceil(top) of KingTower_* frame 0 with King_* (frame 0) in its king_dummy, scale 1; null until loaded. */
  private kingTowerTop(team: Team): number | null {
    const k = this.manifest.towers.king;
    const lib = this.libs.get(k.sc), kl = this.libs.get(k.king.sc);
    const clip = lib?.clip(team === 0 ? k.blue : k.red);
    const kid = kl?.exports.get(team === 0 ? k.king.blue : k.king.red);
    if (!lib || !kl || !clip || kid === undefined) return null;
    const s = (k.scale ?? 100) / 100;
    let top = Infinity;
    const bm = lib.banks[clip.bank].m;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3], mi = clip.elements[i * 3 + 1];
      const cm: Mat = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
      const m = matMul([s, 0, 0, s, 0, 0], cm);
      const b = clip.names?.[ci] === k.kingChild ? idBounds(kl, kid, m) : idBounds(lib, clip.children[ci], m);
      if (b && b[1] < top) top = b[1];
    }
    return top === Infinity ? null : Math.ceil(Math.fround(top));
  }

  /**
   * The reference clip of a character view's health bar (0x836e58 @0x83834c): 0x84a7f8 with angle 0 on the
   * anim set's second entry (slot 1, _idle1_), i.e. direction _1 for both teams of the team's own export
   * (the red export for the enemy); no clip without an idle entry (bounds 0). A view without an anim set
   * (single-clip buildings) measures its clip.
   */
  barRefClip(art: CharacterArt, team: Team): string | null {
    const acts = (team === 1 && art.actionsRed) ? art.actionsRed : art.actions;
    const idle = acts?.idle1;
    if (acts && Object.keys(acts).length) return idle && idle.dirs > 0 ? `${idle.export}_1` : null;
    const clip = team === 1 ? (art.clip?.red ?? art.clip?.blue) : art.clip?.blue;
    return clip ? clip.export : null;
  }

  /** Unit health bar position (SC px) for a unit drawn at game (x, y) and z above its FlyingHeight (barRefClip, barOffsetY). */
  unitBarPx(name: string, team: Team, x: number, y: number, z = 0): [number, number] {
    const art = this.manifest.characters[name];
    const [px, py] = this.gameToPx(x, y, z + (art?.flyingHeight ?? 0));
    if (!art) return [px, py - 50];
    const exp = this.barRefClip(art, team);
    const off = art.healthBarOffsetY ?? 0, own = team === 0;
    if (!exp) return [px, py + off + (own ? art.healthBarOffsetYBlue ?? 0 : art.healthBarOffsetYRed ?? 0)];
    return [px, py + this.barOffsetY(art.sc, exp, art.scale / 100, off, art.healthBarOffsetYBlue ?? 0, art.healthBarOffsetYRed ?? 0, own)];
  }

  /**
   * Crown tower health bar (health_bars.csv Tower / Summoner: ShowOwnAlways and ShowEnemyAlways, the
   * NoDamage export equals the normal one, so the client always shows it). Clip setup 0x83f7a8 / 0x836e58
   * and per-frame 0x83c268 as in drawUnitHealthBar; hpNumber shows the hitpoints (ShowHealthNumber).
   */
  drawTowerHealthBar(r: ScRenderer, type: string, team: Team, px: number, py: number, hp: number, maxHp: number,
    level?: number, hpText?: number, flash = 0): void {
    const hb = this.manifest.hud.healthBars[type];
    if (!hb) return;
    const exp = (team === 0 ? hb.playerExportName : hb.enemyExportName) as string | undefined;
    if (!exp) return;
    this.drawBarClip(r, exp, px, py, healthBarState({ own: team === 0, flags: hb as HealthBarFlags, hp, maxHp, shield: 0,
      maxShield: 0, lifeTime: 0, hidden: false, swapped: true }), level, hpText, flash);
  }

  /** Gallery helper (sc-test.ts): the normal bar of `type` at fill fraction `frac` (hp / max = frac · 10000 / 10000). */
  drawHealthBar(r: ScRenderer, type: string, team: Team, px: number, py: number, frac: number, level?: number, hp?: number): void {
    const hb = this.manifest.hud.healthBars[type];
    const exp = (team === 0 ? hb?.playerExportName : hb?.enemyExportName) as string | undefined;
    if (!exp) return;
    const h = Math.round(Math.max(0, Math.min(1, frac)) * 10000);
    this.drawBarClip(r, exp, px, py, { visible: true, swapped: true, hp: h, max: 10000, shieldBar: false, shieldUp: false }, level, hp);
  }

  /**
   * Troop / building health bar as the character view keeps it (sc/unit_view.ts healthBarState, 0x83c268):
   * the NoDamage export (the level badge) until the first damage, then the normal bar for good; `own` = the
   * viewing player's actor (0x84ddcc) picks the Player / Enemy exports.
   */
  drawUnitHealthBar(r: ScRenderer, type: string, own: boolean, px: number, py: number, st: BarState, level?: number,
    hpText?: number, flash = 0): void {
    const hb = this.manifest.hud.healthBars[type];
    if (!hb || !st.visible) return;
    const exp = (st.swapped ? (own ? hb.playerExportName : hb.enemyExportName)
      : (own ? hb.noDamagePlayerExportName : hb.noDamageEnemyExportName)) as string | undefined;
    if (!exp) return;
    this.drawBarClip(r, exp, px, py, st, level, hpText, flash);
  }

  /**
   * Client-action health bar (sc/unit_view.ts newBarFrame / newBarChoose; component update 0x853574)
   * drawn at the view's bar holder `px, py` (0x84f740: the classic bar's anchor). Root sprite x =
   * −½ · width of the shown bar part (0x123c9e0, its hidden children left out), else `rootX` (kept from
   * the last frame with a bar part). In the root, at the component position (base, 0):
   *   - the badge at ⌊pos + its offset⌋ (setPosition 0x123c550 floors), `level` = the level, its
   *     snappoint_for_hp_bar hidden (0x8530e0); the anchor = pos + offset + (trunc(left + tx),
   *     trunc(top + ty)) of that text field (rect 0x126f52c, instance tx / ty; root scale 1, vt+0x48 /
   *     vt+0x50 read the matrix a / d);
   *   - the bar behind it (addChildAt 0, 0x853204) at ⌊anchor + its offset + (−trunc(left + tx),
   *     trunc(top + ty)) of its snappoint_for_level_bg⌋: `bar` on clamp(n − 1 − ⌊hp%·99 / 100⌋), `bar_temp`
   *     likewise, `bar_shield` shown while shield% > 0 with its own `bar` on clamp(m − 1 − ⌊shield%·99 /
   *     100⌋); additive colour (flash f = view +0x470, heal flash 0): without shield the HP `bar` gets
   *     (f, f, f)·255, with shield the HP bar gets 0 and the shield's `bar` (f, f, f)·255.
   * Returns the root x.
   */
  drawNewHealthBar(r: ScRenderer, px: number, py: number, d: NewBarDraw): number {
    const lib = this.lib(this.manifest.hud.sc);
    const pos: [number, number] = [d.base, 0];
    let ax = pos[0], ay = pos[1];
    let badgeAt: [number, number] | null = null;
    if (d.badge) {
      const bx = pos[0] + d.badge.offset[0], by = pos[1] + d.badge.offset[1];
      badgeAt = [Math.floor(bx), Math.floor(by)];
      ax = bx; ay = by;
      const sp = this.childText(lib, d.badge.exp, 'snappoint_for_hp_bar');
      if (sp) { ax = Math.trunc(sp.rect[0] + sp.tx) + bx; ay = Math.trunc(sp.rect[1] + sp.ty) + by; }
    }
    let rootX = d.rootX;
    let barAt: [number, number] | null = null;
    let hpFrame = 0, shieldFrame = 0, tempFrame = 0;
    const shieldShown = d.shieldPct > 0;
    if (d.bar) {
      const exp = d.bar.exp;
      const n = this.childFrameCount(lib, exp, 'bar');
      const step = Math.trunc((d.hpPct * 99) / 100);
      const clampF = (last: number, v: number) => (v < 1 ? 0 : v >= last ? last : v);
      hpFrame = clampF(n - 1, n - 1 - step);
      const m = this.nestedFrameCount(lib, exp, 'bar_shield', 'bar');
      shieldFrame = clampF(m - 1, m - 1 + Math.trunc((d.shieldPct * -99) / 100));
      const t = this.childFrameCount(lib, exp, 'bar_temp');
      tempFrame = clampF(t - 1, t - 1 - step);
      let sx = 0, sy = 0;
      const sp = this.childText(lib, exp, 'snappoint_for_level_bg');
      if (sp) { sx = -Math.trunc(sp.rect[0] + sp.tx); sy = Math.trunc(sp.rect[1] + sp.ty); }
      barAt = [Math.floor(ax + d.bar.offset[0] + sx), Math.floor(ay + d.bar.offset[1] + sy)];
      rootX = d.showBar ? -0.5 * this.barPartWidth(lib, exp, hpFrame, shieldShown ? shieldFrame : -1, tempFrame) : 0;
    }
    const ox = px + rootX, oy = py;
    if (d.bar && d.showBar && barAt) {
      const f = Math.trunc(Math.min(1, Math.max(0, d.flash)) * 255);
      const add: Col = [1, 1, 1, 1, f, f, f];
      this.drawBarPart(r, lib, d.bar.exp, ox + barAt[0], oy + barAt[1], hpFrame, shieldShown ? shieldFrame : -1, tempFrame,
        shieldShown ? WHITE : add, shieldShown ? add : WHITE);
    }
    if (d.badge && d.showBadge && badgeAt) {
      r.draw(lib, d.badge.exp, d.badgeFrame, [1, 0, 0, 1, ox + badgeAt[0], oy + badgeAt[1]], WHITE, {
        childFrame: d.badgeFrame, named: { snappoint_for_hp_bar: { hide: true } }, text: { level: String(d.level) },
      });
    }
    return rootX;
  }

  /** A named text-field child on frame 0 of an export: its rect and instance translation. */
  private childText(lib: ScLibrary, exp: string, name: string): { rect: [number, number, number, number]; tx: number; ty: number } | null {
    const clip = lib.clip(exp);
    if (!clip) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== name) continue;
      const tf = lib.textFields.get(clip.children[ci]);
      if (!tf) return null;
      const mi = clip.elements[i * 3 + 1];
      const bm = lib.banks[clip.bank].m;
      return { rect: tf.rect, tx: mi >= 0 ? bm[mi * 6 + 4] : 0, ty: mi >= 0 ? bm[mi * 6 + 5] : 0 };
    }
    return null;
  }

  /** Frame count of `inner` inside the named child `outer` of an export (frame 0 of both; 0 when absent). */
  private nestedFrameCount(lib: ScLibrary, exp: string, outer: string, inner: string): number {
    const clip = lib.clip(exp);
    if (!clip) return 0;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== outer) continue;
      const o = lib.clips.get(clip.children[ci]);
      if (!o) return 0;
      for (let j = o.frameStart[0]; j < o.frameStart[1]; j++) {
        const cj = o.elements[j * 3];
        if (o.names?.[cj] === inner) return lib.clips.get(o.children[cj])?.frameCount ?? 1;
      }
      return 0;
    }
    return 0;
  }

  /**
   * One frame-0 child of a bar part export at a time, so its two `bar` clips can take different frames
   * and colours: `bar` (hpFrame, hpAdd), `bar_temp` (tempFrame), `bar_shield` (hidden when shieldFrame
   * < 0; its `bar` on shieldFrame with shieldAdd), the empty snappoint text left out.
   */
  private drawBarPart(r: ScRenderer, lib: ScLibrary, exp: string, x: number, y: number, hpFrame: number, shieldFrame: number,
    tempFrame: number, hpAdd: Readonly<Col>, shieldAdd: Readonly<Col>): void {
    const clip = lib.clip(exp);
    if (!clip) return;
    const bank = lib.banks[clip.bank];
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3], mi = clip.elements[i * 3 + 1], coi = clip.elements[i * 3 + 2];
      const cid = clip.children[ci];
      if (lib.modifiers.has(cid)) continue; // (no bar part export uses masks)
      const name = clip.names?.[ci] ?? null;
      if (name === 'snappoint_for_level_bg') continue;
      const m: Mat = mi >= 0 ? [bank.m[mi * 6], bank.m[mi * 6 + 1], bank.m[mi * 6 + 2], bank.m[mi * 6 + 3],
        bank.m[mi * 6 + 4] + x, bank.m[mi * 6 + 5] + y] : [1, 0, 0, 1, x, y];
      const c: Col = coi >= 0 ? [bank.c[coi * 7], bank.c[coi * 7 + 1], bank.c[coi * 7 + 2], bank.c[coi * 7 + 3],
        bank.c[coi * 7 + 4], bank.c[coi * 7 + 5], bank.c[coi * 7 + 6]] : [...WHITE] as Col;
      if (name === 'bar') r.drawId(lib, cid, hpFrame, m, colMul(c, hpAdd), { childFrame: hpFrame });
      else if (name === 'bar_temp') r.drawId(lib, cid, tempFrame, m, c, { childFrame: tempFrame });
      else if (name === 'bar_shield') {
        if (shieldFrame >= 0) r.drawId(lib, cid, 0, m, c, { childFrame: 0, named: { bar: { frame: shieldFrame, color: [...shieldAdd] as Col } } });
      } else r.drawId(lib, cid, 0, m, c, { childFrame: 0 });
    }
  }

  /** Width (0x123c9e0) of a bar part export as shown: frame-0 shapes, `bar` / `bar_temp` / `bar_shield`'s
   * `bar` on their frames, `bar_shield` left out when hidden (shieldFrame < 0), text fields empty. */
  private barPartWidth(lib: ScLibrary, exp: string, hpFrame: number, shieldFrame: number, tempFrame: number): number {
    const id = lib.exports.get(exp);
    if (id === undefined) return 0;
    const b = [Infinity, -Infinity];
    const walk = (cid: number, frame: number, m: number[], top: boolean, inShield: boolean, depth: number): void => {
      if (depth > 16) return;
      const sh = lib.shapes.get(cid);
      if (sh) {
        for (const cmd of sh) {
          const v = cmd.verts;
          for (let i = 0; i < v.length; i += 4) {
            const xx = m[0] * v[i] + m[2] * v[i + 1] + m[4];
            if (xx < b[0]) b[0] = xx;
            if (xx > b[1]) b[1] = xx;
          }
        }
        return;
      }
      const clip = lib.clips.get(cid);
      if (!clip) return;
      const f = Math.max(0, Math.min(clip.frameCount - 1, frame));
      const bm = lib.banks[clip.bank].m;
      for (let i = clip.frameStart[f]; i < clip.frameStart[f + 1]; i++) {
        const ci = clip.elements[i * 3], mi = clip.elements[i * 3 + 1];
        const name = clip.names?.[ci] ?? null;
        let fr = 0, sh2 = inShield;
        if (top && name === 'bar_shield') { if (shieldFrame < 0) continue; sh2 = true; }
        if (name === 'bar') fr = inShield ? shieldFrame : top ? hpFrame : 0;
        if (top && name === 'bar_temp') fr = tempFrame;
        const cm = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
        const mm = [m[0] * cm[0] + m[2] * cm[1], m[1] * cm[0] + m[3] * cm[1], m[0] * cm[2] + m[2] * cm[3],
          m[1] * cm[2] + m[3] * cm[3], m[0] * cm[4] + m[2] * cm[5] + m[4], m[1] * cm[4] + m[3] * cm[5] + m[5]];
        walk(clip.children[ci], fr, mm, false, sh2, depth + 1);
      }
    };
    walk(id, 0, [1, 0, 0, 1, 0, 0], true, false, 0);
    return b[0] <= b[1] ? b[1] - b[0] : 0;
  }

  /** Health bar clip children the client hides at creation (0x83f7a8) and every frame (`prestige`, 0x83c268). */
  private static readonly BAR_HIDDEN = ['buff', 'ammo', 'chef_upgrade', 'chef_upgrade_shield', 'downgrade',
    'downgrade_shield', 'prestige'];

  /**
   * One health bar clip on its last frame (0x83f7a8 / 0x836e58 stop both clips there): the `bar` child
   * on clamp(n − 1 − ⌊hp·99 / max⌋, 0, n − 1) (n = its frame count; 0x83c268 sets the frame on the
   * normal clip's `bar`), `level` = the level, `hpNumber` → `txt` = the hitpoints when given; a shield
   * bar's `base` shows `shield` / `shield_champion` while the shield lasts.
   */
  private drawBarClip(r: ScRenderer, exp: string, px: number, py: number, st: BarState, level?: number, hpText?: number,
    flash = 0): void {
    const lib = this.lib(this.manifest.hud.sc);
    const named: NonNullable<DrawOptions['named']> = {};
    for (const n of BattleArt.BAR_HIDDEN) named[n] = { hide: true };
    const n = this.childFrameCount(lib, exp, 'bar');
    if (n > 0) {
      named.bar = { frame: barFrame(st.hp, st.max, n) };
      // 0x83c268: the normal clip's `bar` (+0x998) takes the additive colour (f, max(f, heal), f)·255 every
      // frame (f = view +0x470, the heal flash +0xa00 has no supported source); MovieClip vt+0x138 is
      // 0x1252f58 (false), so the colour always applies
      if (st.swapped && flash > 0) {
        const a = Math.trunc(Math.min(1, flash) * 255);
        named.bar.color = [1, 1, 1, 1, a, a, a];
      }
    }
    if (st.shieldBar && this.childFrameCount(lib, exp, 'base') > 0) {
      // the base's `shield` child (all baked shield bars have one; else its `level` would be toggled)
      named.shield = { hide: !st.shieldUp };
      named.shield_champion = { hide: !st.shieldUp };
    }
    const text: Record<string, string> = {};
    if (level !== undefined) text.level = String(level);
    if (hpText !== undefined) text.hpNumber = String(Math.max(0, Math.round(hpText)));
    r.draw(lib, exp, lib.frameCount(exp) - 1, [1, 0, 0, 1, px, py], WHITE, { childFrame: 0, named, text });
  }

  private childFrames = new Map<string, number>();

  /** Frame count of an export's named child on frame 0 (0 when absent; 1 for shapes and text). */
  private childFrameCount(lib: ScLibrary, exp: string, name: string): number {
    const key = `${lib.name}/${exp}/${name}`;
    const hit = this.childFrames.get(key);
    if (hit !== undefined) return hit;
    let v = 0;
    const clip = lib.clip(exp);
    if (clip) {
      for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
        const ci = clip.elements[i * 3];
        if (clip.names?.[ci] !== name) continue;
        v = lib.clips.get(clip.children[ci])?.frameCount ?? 1;
        break;
      }
    }
    if (clip) this.childFrames.set(key, v);
    return v;
  }

  /** Rectangle [x0, y0, x1, y1] (export space) of a named text-field child — the HUD uses
   * text fields as layout placeholders (e.g. HUD_player `cardArea`, `nextCard1`). */
  childRect(libName: string, exportName: string, childName: string): [number, number, number, number] | null {
    const lib = this.libs.get(libName);
    const clip = lib?.clip(exportName);
    if (!lib || !clip) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== childName) continue;
      const tf = lib.textFields.get(clip.children[ci]);
      if (!tf) return null;
      const mi = clip.elements[i * 3 + 1];
      const bm = lib.banks[clip.bank].m;
      const [a, b, c, d, tx, ty] = mi >= 0 ? [...bm.subarray(mi * 6, mi * 6 + 6)] : [1, 0, 0, 1, 0, 0];
      const [l, t, r, bb] = tf.rect;
      const xs = [a * l + c * t + tx, a * r + c * bb + tx], ys = [b * l + d * t + ty, b * r + d * bb + ty];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return null;
  }

  /**
   * In-battle hand card as the client builds it (hand card 0x8e0750 on the card base 0x8b25e8; card
   * visual +0x130 rebuilt by 0x90ab14, element group +0x1d8 by 0x8b293c), back to front:
   *   - the card icon (IconSWF / icon export, 0x90bb28) at the centre of card_item_image's `image`
   *     child bounds (its own scale, no translation: 0x123c5ac with no target space), scaled uniformly
   *     to that width / the icon's width;
   *   - the frame of CardForm BasicForm (0x90acc8 -> 0xdd5058): card_item_frame, card_item_frame_legendary
   *     for legendary cards, card_item_frame_champion for champions, stopped on frame 0;
   *   - card_item_elixir_ingame with `count` = the cost (0x9085e8 with flags 0x8000, 0x908da4);
   *   - the RadialFill card_mask_* (0x8e0b84 -> 0x89f9b4) with `fill` = available / cost while the card
   *     is not affordable (0x8e1408 -> 0x89fd04, drawn by 0x89fd24: sc/ui_port.ts radialFillStrip);
   * everything through the grayscale program while the card cannot be played (0x8e1408 vt+0xd0 ->
   * 0x123c580). m places the card origin (the frame spans x -64..64, y -79.3..81.05 at scale 1).
   */
  drawCard(r: ScRenderer, card: string, m: Mat, opts: { elixir?: number; dim?: boolean; grayscale?: boolean;
    fill?: number | null; noCost?: boolean; alpha?: number; color?: Readonly<Col> } = {}): void {
    const c = this.manifest.cards[card];
    const hud = this.libs.get(this.manifest.hud.sc);
    if (!c) return;
    if (!hud || !hud.has('card_item_frame')) {
      r.draw(this.lib(c.sc), c.export, 0, m);
      return;
    }
    const a = opts.alpha ?? 1;
    // the panel's gain flash adds white to its card children (0x8db8e0 +0xd..+0xf, hud.ts flashed)
    const col: Col = colMul(opts.color ?? WHITE, [1, 1, 1, a, 0, 0, 0]);
    const gray = !!(opts.grayscale ?? opts.dim);
    const rare = c.rarity ?? 'Common';
    const suffix = rare === 'Legendary' ? '_legendary' : rare === 'Champion' ? '_champion' : '';
    const frameExp = hud.has(`card_item_frame${suffix}`) ? `card_item_frame${suffix}` : 'card_item_frame';
    // icon fitted to the card_item_image `image` rect (0x90bb28)
    const lib = this.lib(c.sc);
    const box = this.cardImageRect(hud);
    const ib = lib.frameBounds(c.export, 0);
    if (box && ib && ib[2] > ib[0]) {
      const s = (box[2] - box[0]) / (ib[2] - ib[0]);
      r.draw(lib, c.export, 0, matMul(m, [s, 0, 0, s, (box[0] + box[2]) * 0.5, (box[1] + box[3]) * 0.5]), col, { grayscale: gray });
    }
    r.draw(hud, frameExp, 0, m, col, { grayscale: gray });
    if (!opts.noCost && hud.has('card_item_elixir_ingame')) {
      r.draw(hud, 'card_item_elixir_ingame', 0, m, col, { grayscale: gray, text: { count: String(opts.elixir ?? c.elixir ?? '') } });
    }
    const fill = opts.fill;
    if (fill !== undefined && fill !== null && fill < 1) {
      const maskExp = hud.has(`card_mask${suffix || '_normal'}`) ? `card_mask${suffix || '_normal'}` : 'card_mask_normal';
      const shape = this.firstShapeCmd(hud, maskExp);
      const strip = shape ? radialFillStrip(shape.verts, shape.count, fill) : null;
      if (shape && strip) r.drawImageStrip(hud.textures[shape.tex], strip, m, col, 0, gray);
    }
  }

  private cardImageBox: [number, number, number, number] | null | undefined;

  /** Bounds of card_item_image's `image` child with its own scale and no translation (0x90bb28 / 0x123c5ac). */
  private cardImageRect(hud: ScLibrary): [number, number, number, number] | null {
    if (this.cardImageBox !== undefined) return this.cardImageBox;
    this.cardImageBox = null;
    const clip = hud.clip('card_item_image');
    if (!clip) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== 'image') continue;
      const mi = clip.elements[i * 3 + 1];
      const bm = hud.banks[clip.bank].m;
      const lin: Mat = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], 0, 0] : [1, 0, 0, 1, 0, 0];
      this.cardImageBox = idBounds(hud, clip.children[ci], lin);
      break;
    }
    return this.cardImageBox;
  }

  /** First draw command of the first shape child of an export's frame 0 (RadialFill source, 0x89f9b4). */
  private firstShapeCmd(lib: ScLibrary, exportName: string): ShapeCmd | null {
    const clip = lib.clip(exportName);
    if (!clip) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const sh = lib.shapes.get(clip.children[clip.elements[i * 3]]);
      if (sh && sh.length) return sh[0];
    }
    return null;
  }

  /**
   * Bottom HUD panel (ui.sc HUD_player) with four cards, the next card and the elixir bar.
   * Card placement uses the panel's own `cardArea` / `nextCard1` placeholders; the elixir-bar
   * fill (stretching `bar_body`, moving `bar_end`, spacing the dividers) is an approximation of
   * the game's UI code. m places the panel origin (the panel spans ~1350 x 290 px, most of it
   * a darkening backdrop; the visible panel is ~ x -330..330, y -215..70).
   */
  drawHand(r: ScRenderer, m: Mat, hand: (string | null)[], next: string | null, elixir: number,
    opts: { nextTimer?: string } = {}): void {
    const ui = this.manifest.hud.sc;
    const hud = this.libs.get(ui);
    if (!hud) return;
    const full = 402.3; // bar_bg width: 18 px * 22.35
    const f = Math.max(0, Math.min(10, elixir)) / 10;
    const dividers: Record<string, { matrix: Mat }> = {};
    for (let i = 1; i <= 9; i++) {
      // place divider i at i/10 of the bar (offsets relative to their authored positions)
      const authored = [0.4, 5.4, 10.4, 15.4, 20.4, 25.4, 30.4, 34.6, 39.4][i - 1];
      dividers[`d${i}`] = { matrix: [1, 0, 0, 1, ((i * full) / 10 - 1.5 - authored) / 0.8, 0] };
    }
    r.draw(hud, 'HUD_player', 0, m, WHITE, {
      childFrame: 0,
      named: {
        bar_body: { matrix: [Math.max(0.0001, (f * full) / 18 / 0.399), 0, 0, 1, 0, 0] },
        bar_end: { matrix: [1, 0, 0, 1, (f * full - 5) / 0.399, 0] },
        ghost: { hide: true }, bar_refund: { hide: true }, bar_tip: { hide: true }, bar_flow: { hide: true },
        elixirRequirementBar: { hide: true }, elixir_warning: { hide: true }, ability_location: { hide: true },
        darken: { hide: true },
        ...dividers,
      },
      text: { elixirAmount: String(Math.floor(elixir)), NextSpellTimer: opts.nextTimer ?? '' },
    });
    const area = this.childRect(ui, 'HUD_player', 'cardArea');
    if (area) {
      const w = (area[2] - area[0]) / 4, h = area[3] - area[1];
      const s = h / 198;
      hand.forEach((card, i) => {
        if (!card) return;
        const cx = area[0] + w * (i + 0.5), cy = area[1] + h / 2 + 11.5 * s;
        this.drawCard(r, card, matMul(m, [s, 0, 0, s, cx, cy]));
      });
    }
    const nr = this.childRect(ui, 'HUD_player', 'nextCard1');
    if (nr && next) {
      const s = (nr[3] - nr[1]) / 198;
      this.drawCard(r, next, matMul(m, [s, 0, 0, s, (nr[0] + nr[2]) / 2, (nr[1] + nr[3]) / 2 + 11.5 * s]));
    }
  }
}

/** Bounds of a shape or clip (frame 0) through matrix m. */
function idBounds(lib: ScLibrary, id: number, m: Mat, depth = 0): [number, number, number, number] | null {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (cid: number, mm: Mat, d: number): void => {
    if (d > 16) return;
    const sh = lib.shapes.get(cid);
    if (sh) {
      for (const cmd of sh) {
        const v = cmd.verts;
        for (let i = 0; i < cmd.count; i++) {
          const x = mm[0] * v[i * 4] + mm[2] * v[i * 4 + 1] + mm[4], y = mm[1] * v[i * 4] + mm[3] * v[i * 4 + 1] + mm[5];
          if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
        }
      }
      return;
    }
    const c = lib.clips.get(cid);
    if (!c) return;
    const bm = lib.banks[c.bank].m;
    for (let i = c.frameStart[0]; i < c.frameStart[1]; i++) {
      const mi = c.elements[i * 3 + 1];
      const cm: Mat = mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : [1, 0, 0, 1, 0, 0];
      visit(c.children[c.elements[i * 3]], matMul(mm, cm), d + 1);
    }
  };
  visit(id, m, depth);
  return b[0] <= b[2] ? b : null;
}
