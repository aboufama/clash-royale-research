// BattleArt: game-space helpers on top of ScRenderer + manifest.json — arena alignment,
// background + decorations, towers (King activation, turret aim, princess), units (direction,
// deploy filter, shadows), projectiles and health bars. Depth sorting is left to the caller:
// everything here takes explicit game coordinates and draws immediately.
//
// Game space: integer units, 1000 per tile, x right, +y toward red (screen up), z up.
// SC space: the arena export's pixels (y down). See manifest.arena for the constants.

import type { Col, Mat } from './math.ts';
import { matMul, WHITE } from './math.ts';
import { ScLibraryCache } from './library.ts';
import type { ScLibrary } from './library.ts';
import type { CharacterArt, Manifest } from './manifest.ts';
import { loadManifest } from './manifest.ts';
import type { DrawOptions, ScRenderer } from './renderer.ts';
import { projectileSprite, turretFrame, unitSprite } from './units.ts';
import type { ActionName, UnitSprite } from './units.ts';

export type Team = 0 | 1;

export interface UnitDrawOptions {
  z?: number; // game units above ground (FlyingHeight is added automatically)
  deployMs?: number; // ms since deploy start: plays the deploy filter clip while < its length
  alpha?: number;
  color?: Col;
  loop?: boolean;
  screenAngle?: boolean; // pick directions from the on-screen angle (default: engine angle)
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

  /** Load manifest.json and every library it lists (or only `only`). */
  static async load(baseUrl = 'assets', only?: Iterable<string>): Promise<BattleArt> {
    const m = await loadManifest(baseUrl);
    const libs = new ScLibraryCache(baseUrl);
    await libs.loadAll(only ?? Object.keys(m.libs));
    return new BattleArt(m, libs, baseUrl);
  }

  lib(name: string): ScLibrary {
    const l = this.libs.get(name);
    if (!l) throw new Error(`library ${name} not loaded`);
    return l;
  }

  // -- coordinates -----------------------------------------------------------------------------

  get pxPerTileX(): number { return this.manifest.arena.pxPerTileX; }
  get pxPerTileY(): number { return this.manifest.arena.pxPerTileY; }
  /** on-screen y foreshortening (pxPerTileY / pxPerTileX) */
  get yScale(): number { return this.manifest.arena.pxPerTileY / this.manifest.arena.pxPerTileX; }

  /** Game point (x, y, z) -> arena SC pixels. */
  gameToPx(x: number, y: number, z = 0): [number, number] {
    const a = this.manifest.arena;
    return [
      a.originPx[0] + ((x - a.originGame[0]) / 1000) * a.pxPerTileX,
      a.originPx[1] - ((y - a.originGame[1]) / 1000) * a.pxPerTileY - (z / 1000) * a.zPxPer1000,
    ];
  }

  /** Arena SC pixels -> game (x, y) on the ground. */
  pxToGame(px: number, py: number): [number, number] {
    const a = this.manifest.arena;
    return [
      a.originGame[0] + ((px - a.originPx[0]) / a.pxPerTileX) * 1000,
      a.originGame[1] - ((py - a.originPx[1]) / a.pxPerTileY) * 1000,
    ];
  }

  /** SC-pixel rectangle covering the 18x32-tile battlefield (plus `marginTiles`). */
  fieldRect(marginTiles = 0): [number, number, number, number] {
    const [x0, y0] = this.gameToPx(-marginTiles * 1000, 32000 + marginTiles * 1000);
    const [x1, y1] = this.gameToPx(18000 + marginTiles * 1000, -marginTiles * 1000);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // -- arena -----------------------------------------------------------------------------------

  drawBackground(r: ScRenderer): void {
    const a = this.manifest.arena;
    r.draw(this.lib(a.sc), a.export, 0);
  }

  /** Decorations of one or more layers ('Base', 'Ground', 'Object'), in data order. */
  drawArenaObjects(r: ScRenderer, timeMs: number, layers: string[] = ['Base', 'Ground', 'Object']): void {
    for (const o of this.manifest.arena.objects) {
      if (!layers.includes(o.layer)) continue;
      const [px, py] = this.gameToPx(o.x, 32000 - o.y);
      const frame = o.frames && o.frames > 1 ? Math.floor((timeMs * (o.fps || 30)) / 1000) : 0;
      r.draw(this.lib(o.sc), o.export, frame, [1, 0, 0, 1, px, py]);
    }
  }

  /** Drifting cloud shadows (location Cloud* fields; positions are visual-only randomness). */
  drawClouds(r: ScRenderer, timeMs: number, seed = 1): void {
    const c = this.manifest.arena.clouds;
    if (!c) return;
    const lib = this.lib(c.sc);
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const [fx, fy, fw, fh] = this.fieldRect(6);
    const n = c.count ?? 4;
    for (let i = 0; i < n; i++) {
      const scale = ((c.minscale ?? 100) + rnd() * ((c.maxscale ?? 100) - (c.minscale ?? 100))) / 100;
      const speed = (c.minspeed ?? 30) + rnd() * ((c.maxspeed ?? 30) - (c.minspeed ?? 30)); // px / s (assumed)
      const alpha = ((c.minalpha ?? 10) + rnd() * ((c.maxalpha ?? 10) - (c.minalpha ?? 10))) / 100;
      const flip = c.randomflip && rnd() < 0.5 ? -1 : 1;
      const x = fx + ((rnd() * fw + (timeMs / 1000) * speed) % fw);
      const y = fy + rnd() * fh;
      const frames = lib.frameCount(c.export);
      r.draw(lib, c.export, Math.floor((timeMs * lib.fps(c.export)) / 1000) % frames,
        [scale * flip, 0, 0, scale, x, y], [1, 1, 1, alpha, 0, 0, 0]);
    }
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
  drawKingTower(r: ScRenderer, team: Team, timeMs: number, activationMs?: number, aim?: number,
    destroyed = false): void {
    const t = this.manifest.towers.king;
    const [x, y] = this.towerPos('king', team);
    const [px, py] = this.gameToPx(x, y);
    const lib = this.lib(t.sc);
    if (destroyed) {
      r.draw(lib, t.destroyed, 0, [1, 0, 0, 1, px, py]);
      return;
    }
    const exp = team === 0 ? t.blue : t.red;
    const labels = lib.labels(exp);
    const start = labels.start ?? 1, stop = labels.stop ?? t.frames - 1;
    let frame = labels.idle ?? 0;
    if (activationMs !== undefined) frame = Math.min(stop, start + Math.floor((activationMs * t.fps) / 1000));
    const clock = Math.floor((timeMs * t.fps) / 1000);
    const tf = turretFrame(aim ?? (team === 0 ? Math.PI / 2 : -Math.PI / 2), t.turretFrames);
    const named: DrawOptions['named'] = {
      [t.kingChild]: { lib: this.lib(t.king.sc), export: team === 0 ? t.king.blue : t.king.red, frame, childFrame: clock },
    };
    if (activationMs !== undefined && frame >= stop) {
      named[t.turretChild] = { frame: tf.frame, matrix: tf.mirror ? [-1, 0, 0, 1, 0, 0] : undefined };
    } else {
      named[t.turretChild] = { frame: team === 0 ? 0 : t.turretFrames - 1 };
    }
    r.draw(lib, exp, frame, [1, 0, 0, 1, px, py], WHITE, { childFrame: clock, named });
  }

  /** Princess tower: base, tower princess (character art), top. */
  drawPrincessTower(r: ScRenderer, team: Team, side: 'princessLeft' | 'princessRight', timeMs: number,
    action: ActionName = 'idle', angle?: number, actionMs = timeMs, destroyed = false): void {
    const t = this.manifest.towers.princess;
    const [x, y] = this.towerPos(side, team);
    const [px, py] = this.gameToPx(x, y);
    const lib = this.lib(t.sc);
    if (destroyed) {
      r.draw(lib, t.destroyed, 0, [1, 0, 0, 1, px, py]);
      return;
    }
    const tm = team === 0 ? 'blue' : 'red';
    r.draw(lib, t.base[tm], 0, [1, 0, 0, 1, px, py]);
    const pc = this.manifest.characters[t.character];
    if (pc) {
      const sp = unitSprite(pc, team, action, angle ?? (team === 0 ? Math.PI / 2 : -Math.PI / 2), actionMs);
      if (sp) {
        const s = pc.scale / 100;
        r.draw(this.lib(pc.sc), sp.export, sp.frame, [sp.mirror ? -s : s, 0, 0, s, px, py]);
      }
    }
    r.draw(lib, t.top[tm], 0, [1, 0, 0, 1, px, py]);
  }

  // -- units -----------------------------------------------------------------------------------

  character(name: string): CharacterArt {
    const c = this.manifest.characters[name];
    if (!c) throw new Error(`no character art for ${name}`);
    return c;
  }

  /** Sprite matrix (SC px) for a unit at game (x, y) — exposed for custom drawing. */
  unitMatrix(art: CharacterArt, sp: UnitSprite, x: number, y: number, z = 0): Mat {
    const [px, py] = this.gameToPx(x, y, z + (art.flyingHeight ?? 0));
    const s = art.scale / 100;
    return [sp.mirror ? -s : s, 0, 0, s, px, py];
  }

  /** Draw a unit; returns the sprite used (or null). */
  drawUnit(r: ScRenderer, name: string, team: Team, x: number, y: number, action: ActionName, angle: number,
    actionMs: number, o: UnitDrawOptions = {}): UnitSprite | null {
    const art = this.character(name);
    const sp = unitSprite(art, team, action, angle, actionMs, { loop: o.loop, yScale: o.screenAngle ? this.yScale : undefined });
    if (!sp) return null;
    let m = this.unitMatrix(art, sp, x, y, o.z ?? 0);
    let c: Col = o.color ? [...o.color] as Col : [1, 1, 1, 1, 0, 0, 0];
    if (o.alpha !== undefined) c[3] *= o.alpha;
    if (o.deployMs !== undefined && art.deployBaseAnimExportName) {
      const f = this.filterAt(art.deployBaseAnimExportName.sc, art.deployBaseAnimExportName.export, o.deployMs);
      if (f) {
        m = matMul(m, f.m);
        c = f.c ? colMulTo(c, f.c) : c;
      }
    }
    r.draw(this.lib(art.sc), sp.export, sp.frame, m, c);
    return sp;
  }

  /**
   * Soft shadow silhouette for a unit (call between r.beginShadows() and r.endShadows()).
   * Shape from the data's Shadow* fields: scale, skew (percent of height), offset (px).
   * The exact projection used by the game is not recovered: this is an approximation.
   */
  drawUnitShadow(r: ScRenderer, name: string, team: Team, x: number, y: number, action: ActionName, angle: number,
    actionMs: number, o: UnitDrawOptions = {}): void {
    const art = this.character(name);
    if (art.shadowCustom) {
      const [px, py] = this.gameToPx(x, y);
      const s = art.scale / 100;
      r.draw(this.lib(art.shadowCustom.sc), art.shadowCustom.export, 0, [s, 0, 0, s, px, py]);
      return;
    }
    const sp = unitSprite(art, team, action, angle, actionMs, { loop: o.loop });
    if (!sp) return;
    const [px, py] = this.gameToPx(x, y);
    const s = art.scale / 100;
    const sx = ((art.shadowScaleX ?? 100) / 100) * s * (sp.mirror ? -1 : 1);
    const sy = ((art.shadowScaleY ?? 100) / 100) * s;
    const k = (art.shadowSkew ?? 0) / 100;
    const m: Mat = [sx, 0, -k * sy, sy, px + (art.shadowX ?? 0), py + (art.shadowY ?? 0)];
    r.draw(this.lib(art.sc), sp.export, sp.frame, m);
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

  /** Projectile at game (x, y, z) moving with (vx, vy, vz) (engine units / s). */
  drawProjectile(r: ScRenderer, name: string, team: Team, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, timeMs: number, shadow = true): void {
    const p = this.manifest.projectiles[name];
    if (!p || !p.sc || !p.export) return;
    const lib = this.lib(p.sc);
    const s = (p.scale ?? 100) / 100;
    const sp = projectileSprite(p, team, vx, vy, vz, this.yScale, this.manifest.arena.zPxPer1000 / this.pxPerTileX);
    if (shadow && p.shadow) {
      const [gx, gy] = this.gameToPx(x, y, 0);
      const rot = p.shadowDisableRotate ? 0 : Math.atan2(-vy * this.yScale, vx);
      const cs = Math.cos(rot) * s, sn = Math.sin(rot) * s;
      r.draw(lib, (team === 1 && p.redShadow) ? p.redShadow : p.shadow, 0, [cs, sn, -sn, cs, gx, gy]);
    }
    const [px, py] = this.gameToPx(x, y, z);
    const cs = Math.cos(sp.rotation) * s, sn = Math.sin(sp.rotation) * s;
    const frame = (p.frames ?? 1) > 1 ? sp.frame : Math.floor((timeMs * (p.fps ?? 30)) / 1000);
    r.draw(lib, sp.export, frame, [cs, sn, -sn, cs, px, py]);
  }

  // -- health bars -----------------------------------------------------------------------------

  /**
   * Classic health bar (health_bars.csv: hp_player_* / hp_enemy_*). frac 0..1 selects the `bar`
   * child's frame (100 frames). Placement above the unit is approximate.
   */
  drawHealthBar(r: ScRenderer, type: string, team: Team, px: number, py: number, frac: number,
    level?: number, hp?: number): void {
    const hb = this.manifest.hud.healthBars[type];
    if (!hb) return;
    const exp = (team === 0 ? hb.playerExportName : hb.enemyExportName) as string | undefined;
    if (!exp) return;
    const lib = this.lib(this.manifest.hud.sc);
    const barFrame = Math.max(0, Math.min(99, Math.round(frac * 99)));
    const text: Record<string, string> = {};
    if (level !== undefined) text.level = String(level);
    if (hp !== undefined) text.hpNumber = String(Math.max(0, Math.round(hp)));
    const frames = lib.frameCount(exp);
    r.draw(lib, exp, frames - 1, [1, 0, 0, 1, px, py], WHITE, {
      childFrame: 0,
      named: { bar: { frame: barFrame }, downgrade: { hide: true }, chef_upgrade: { hide: true } },
      text,
    });
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
   * In-hand card: ui.sc `spell_card_ingame` with its `card_image` placeholder replaced by the
   * card icon (ui_spells / IconSWF) and the elixir cost in `elixar_count`. m places the card
   * origin; the card spans about 146 x 198 px at scale 1.
   */
  drawCard(r: ScRenderer, card: string, m: Mat, opts: { elixir?: number; dim?: boolean } = {}): void {
    const c = this.manifest.cards[card];
    const hud = this.libs.get(this.manifest.hud.sc);
    if (!c) return;
    if (!hud || !hud.has('spell_card_ingame')) {
      r.draw(this.lib(c.sc), c.export, 0, m);
      return;
    }
    const rare = c.rarity ?? 'Common';
    const icon = 0.5208; // placeholder 128x156 vs icon 236x300
    r.draw(hud, 'spell_card_ingame', 0, m, opts.dim ? [0.55, 0.55, 0.55, 1, 0, 0, 0] : WHITE, {
      named: {
        card_image: { lib: this.lib(c.sc), export: c.export, frame: 0, matrix: [icon, 0, 0, icon, 0, 0] },
        frame_legendary: { hide: rare !== 'Legendary' },
        frame_champion: { hide: rare !== 'Champion' },
        frame: { hide: rare === 'Legendary' || rare === 'Champion' },
        card_evolution_frame: { hide: true },
        card_evolution: { hide: true },
        dark_elixir_count: { hide: true },
      },
      text: { count: String(opts.elixir ?? c.elixir ?? '') },
    });
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

function colMulTo(p: Col, q: Col): Col {
  return [p[0] * q[0], p[1] * q[1], p[2] * q[2], p[3] * q[3],
    Math.min(255, p[4] + q[4] * p[0]), Math.min(255, p[5] + q[5] * p[1]), Math.min(255, p[6] + q[6] * p[2])];
}
