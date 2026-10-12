// In-battle UI that lives in the battle layer or follows battle positions, drawn with the
// client's own exports (libg 160402020): the illegal-area overlay (battle layer child 7,
// deployArea_*), the card drag preview (0x8e3fd4 class: ghost units, spell_placement_NxN footprint,
// IndicatorEffect clip, image/range.png radius ring, spell_placement_text name), the deploy timers
// (troopDeployTimer_*, children of the HUD layer) and the HUD itself (hud.ts).
// Pure logic is in sc/ui_port.ts; art.ts calls the draw passes in the client's order.
import { type Battle, type CardDef, ST_DEAD, TOWER_NONE, type UnitDef } from '../../core/src/index.ts';
import { formationOffset } from '../../core/src/formation.ts';
import type { Frame } from './frame.ts';
import { Hud } from './hud.ts';
import type { Col, Mat } from './sc/math.ts';
import { WHITE } from './sc/math.ts';
import type { BattleArt } from './sc/battle_art.ts';
import type { ScLibrary } from './sc/library.ts';
import type { ScRenderer } from './sc/renderer.ts';
import { ClipPlayer } from './sc/anim.ts';
import { Announcements } from './sc/announce.ts';
import {
  type AreaActor, CLIENT_GLOBALS, DEPLOY_AREA_PIECES, DeployAreaGrid, deployAreaAlpha, deployAreaShown, DeployTimer,
  indicatorRadius, ringBand, ringStrip, type UiSpell,
} from './sc/ui_port.ts';

type Team = 0 | 1;
type Row = Record<string, unknown>;

/** What main.ts is dragging this frame (null when nothing). */
export interface PreviewInput {
  team: number;
  card: string;
  /** hand slot (-1: sandbox palette) */
  slot: number;
  /** snapped logic position (the deploy check 0xf9e16c prediction) */
  x: number;
  y: number;
  /** preview alpha: 1 - the dragged card's scale (0x8e1fb8); 0 while the card is over the hand */
  alpha: number;
}

/** A play released and waiting for its commit: the footprint plays `release`, then `remove` (A). */
interface PendingMark { card: string; team: number; x: number; y: number; clip: ClipPlayer; exp: string; removing: boolean;
  submitTick: number }

interface GhostUnit { def: UnitDef; x: number; y: number; angle: number }

const num = (r: Row | undefined, k: string): number => (r && typeof r[k] === 'number' ? r[k] as number : 0);
const flag = (r: Row | undefined, k: string): boolean => !!(r && r[k] === true);

export class BattleUi {
  readonly art: BattleArt;
  readonly hud: Hud;
  readonly grid = new DeployAreaGrid(36, 64);
  areaAlpha = 0;
  preview: PreviewInput | null = null;
  private timers: { t: DeployTimer; x: number; y: number; team: Team }[] = [];
  /** elixir cost texts of the own summons (0x85ada8 -> 0xbe5898, list +0x400 of the battle screen) */
  private floats: { x: number; y: number; text: string; clip: ClipPlayer }[] = [];
  private range: ImageBitmap | null = null;
  private footprint: { exp: string; clip: ClipPlayer; scale: number } | null = null;
  private indicatorClip: ClipPlayer | null = null;
  private previewCard: string | null = null;
  private mana = { alpha: 0, shown: -1, flashT: 1000 };
  private pending: PendingMark[] = [];

  constructor(art: BattleArt) {
    this.art = art;
    this.hud = new Hud(art);
  }

  /** Timed announcements of the HUD time update 0x8d38c4 (countdown, 60/30 s, elixir speed, extra time). */
  private announce: Announcements | null = null;

  private announcer(): Announcements | null {
    const ui = this.ui;
    if (!this.announce && ui) {
      const texts = this.art.manifest.hud.texts ?? {};
      this.announce = new Announcements(ui, (id, vars = {}) => {
        let s = texts[id] ?? '';
        for (const [k, v] of Object.entries(vars)) s = s.replace(`<${k}>`, String(v));
        return s;
      });
    }
    return this.announce;
  }

  /** New battle: drop timers, pending marks and the overlay state. */
  reset(): void {
    this.timers = [];
    this.floats = [];
    this.handPlays = [];
    this.announce = null;
    this.pending = [];
    this.preview = null;
    this.areaAlpha = 0;
    this.grid.blocked.fill(0);
    this.grid.timer.fill(0);
    this.hud.reset();
  }

  async load(): Promise<void> {
    const url = this.art.manifest.hud.rangeImage;
    if (!url) return;
    try {
      const res = await fetch(`${this.art.baseUrl.replace(/\/$/, '')}/${url}`);
      if (res.ok) this.range = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    } catch (e) {
      console.warn('range.png', e);
    }
  }

  private get ui(): ScLibrary | undefined { return this.art.libs.get(this.art.manifest.hud.sc); }

  get layout() { return this.hud.layout; }

  resize(cssW: number, cssH: number): void { this.hud.resize(cssW, cssH); }

  /** Battle-layer px -> stage px. */
  toStage(px: number, py: number): [number, number] {
    const L = this.layout;
    return [L.battleX + L.battleScale * px, L.battleY + L.battleScale * py];
  }

  // ---------------------------------------------------------------- data

  private raw(card: string): Row | undefined {
    return (this.cardsData()[card] as Row | undefined);
  }

  private cardsData(): Record<string, unknown> {
    return (this.battleRef?.defs.data.cards ?? {}) as Record<string, unknown>;
  }

  private battleRef: Battle | null = null;

  /** SpellData fields of a card for the overlay rule (0x8cb0f4). */
  spellOf(card: CardDef): UiSpell {
    const r = this.raw(card.name);
    return {
      summonCharacter: card.spec.main !== null || card.spec.second !== null || card.spec.list.length > 0,
      radius: num(r, 'Radius'), canDeployOnEnemySide: card.canDeployOnEnemySide, spellAsDeploy: card.spellAsDeploy,
      onlyOwnTroops: flag(r, 'OnlyOwnTroops'), hasProjectile: card.spellProjectile !== null,
      touchdownLimitedDeploy: flag(r, 'TouchdownLimitedDeploy'),
    };
  }

  /** Radius ring (battle-layer px) for a card, or null (HideRadiusIndicator / no radius). */
  ringOf(card: CardDef): { R: number; minR: number } | null {
    const b = this.battleRef;
    if (!b) return null;
    const r = this.raw(card.name);
    if (flag(r, 'HideRadiusIndicator')) return null;
    const data = b.defs.data as unknown as { projectiles: Record<string, Row>; units: Record<string, Row>; areaEffects: Record<string, Row> };
    const pn = typeof r?.Projectile === 'string' ? r.Projectile as string : null;
    const pr = pn ? data.projectiles[pn] : undefined;
    const aeoName = typeof pr?.SpawnAreaEffectObject === 'string' ? pr.SpawnAreaEffectObject as string : null;
    const sc = card.spec.main ?? card.spec.second ?? null;
    const ur = sc ? data.units[sc.name] : undefined;
    const upn = typeof ur?.Projectile === 'string' ? ur.Projectile as string : null;
    const cardAeo = typeof r?.AreaEffectObject === 'string' ? data.areaEffects[r.AreaEffectObject as string] : undefined;
    const ind = indicatorRadius({
      radius: num(r, 'Radius'),
      projectile: pr ? { radius: num(pr, 'Radius'), radiusY: num(pr, 'RadiusY'), aeoRadius: aeoName ? num(data.areaEffects[aeoName], 'Radius') : 0 } : null,
      summon: sc ? { speed: num(ur, 'Speed'), range: num(ur, 'Range'), minimumRange: num(ur, 'MinimumRange'),
        collisionRadius: num(ur, 'CollisionRadius'), projectileMaxDistance: upn ? num(data.projectiles[upn], 'MaxDistance') : 0 } : null,
      aeoRadius: num(cardAeo, 'Radius'),
      hideRadiusIndicator: false,
    });
    if (!(ind.radius > 0)) return null;
    return { R: ind.radius * 0.03, minR: ind.minRadius * 0.03 };
  }

  // ---------------------------------------------------------------- per frame

  /** Engine events of the last tick: card commits start deploy timers (0xbe5b4c -> 0x8d5d24). */
  onEvents(b: Battle): void {
    this.battleRef = b;
    const ui = this.ui;
    if (!ui) return;
    for (const e of b.events) {
      if (e.type !== 'cast') continue;
      const card = b.defs.card(e.name, b.levels[e.team]);
      const d = card.spec.main ?? card.spec.second ?? card.spec.list[0] ?? null;
      const n = card.spec.main ? card.spec.number : card.spec.second ? card.spec.secondCount : card.spec.list.length;
      const own = e.team === this.hud.team;
      for (const pm of this.pending) {
        if (!pm.removing && pm.team === e.team && pm.card === e.name) {
          pm.removing = true;
          const l = ui.labels(pm.exp);
          pm.clip.playRange(l.remove ?? 0, l.remove_end ?? pm.clip.frames - 1, false);
          break;
        }
      }
      // the own summon's elixir cost floats up from the deploy point when its characters appear: the
      // unit view's card-deploy handler 0x85ada8 -> 0xbe5898 (elixir_float_txt, icon/txt = "-<cost>",
      // played once, then removed); spells have no character view and show none
      const hp = own ? this.handPlays.findIndex((q) => q.team === e.team && q.card === e.name) : -1;
      if (hp >= 0) this.handPlays.splice(hp, 1);
      if (hp >= 0 && d && n > 0 && card.cost >= 1 && ui.has('elixir_float_txt')) {
        const clip = new ClipPlayer(ui.frameCount('elixir_float_txt'), ui.fps('elixir_float_txt') || 30);
        clip.playRange(0, clip.frames - 1, false);
        this.floats.push({ x: e.x, y: e.y, text: `-${card.cost}`, clip });
      }
      if (!d || n <= 0 || d.spawnPathfindSpeed !== 0) continue;
      const exp = own ? 'troopDeployTimer_player' : 'troopDeployTimer_enemy';
      if (!ui.has(exp)) continue;
      const end = ui.labels(exp).end ?? ui.frameCount(exp) - 1;
      this.timers.push({ t: new DeployTimer(d.deployTime / 1000, 0, end, ui.frameCount(exp), ui.fps(exp)), x: e.x, y: e.y,
        team: e.team as Team });
    }
  }

  /**
   * Release of a valid play. The client draws nothing here: the footprint (spell_placement_NxN) is a
   * child of the drag preview container (0x8e4eb4 adds it to +0x78 with playLabels("appear",
   * "appear_end")) and goes away with the preview on release; the binary has no "release_end",
   * "remove" or "remove_end" label strings, so those ranges of the clip are never played.
   */
  markPending(team: number, card: string, x: number, y: number, tick: number): void {
    void x; void y; void tick;
    // remembered so the commit's cost float is shown for hand plays only (not sandbox spawns)
    this.handPlays.push({ team, card });
  }

  private handPlays: { team: number; card: string }[] = [];

  /** Footprint clip of a card (0x8e4eb4: TileSize of a building, capped at 4; 1x1 otherwise; none without ghosts). */
  private footprintExport(cardName: string): string | null {
    const b = this.battleRef;
    if (!b) return null;
    const card = b.defs.card(cardName, 11);
    const ghosts = this.ghostDefs(card);
    if (!ghosts.length) return null;
    const d = ghosts[0];
    let size = 1;
    const target = d.kind === 'building' ? d : d.spawnPathfindMorph?.kind === 'building' ? d.spawnPathfindMorph : null;
    if (target) size = Math.max(1, Math.min(4, this.tileSize(target)));
    return `spell_placement_${size}x${size}`;
  }

  private tileSize(d: UnitDef): number {
    return d.tileSizeOverride > 0 ? d.tileSizeOverride : Math.trunc((d.collisionRadius + 499) / 500) + 1;
  }

  /** Characters the preview shows (0x8e4348): the summons, else the spell projectile's spawn. */
  private ghostDefs(card: CardDef): UnitDef[] {
    const out: UnitDef[] = [];
    const sp = card.spec;
    if (sp.main) for (let i = 0; i < sp.number; i++) out.push(sp.main);
    if (sp.second) for (let i = 0; i < sp.secondCount; i++) out.push(sp.second);
    for (const u of sp.list) out.push(u);
    if (!out.length && card.spellProjectile?.spawnUnit) {
      for (let i = 0; i < card.spellProjectile.spawnCount; i++) out.push(card.spellProjectile.spawnUnit);
    }
    return out;
  }

  /** Ghost positions: drop + Deploy_formationOffset (0xd42ce0) with the summon's ring radius, facing the enemy King. */
  private ghosts(b: Battle, card: CardDef, team: number, x: number, y: number): GhostUnit[] {
    const defs = this.ghostDefs(card);
    if (!defs.length) return [];
    const sp = card.spec;
    const d0 = defs[0];
    const r = sp.radius !== 0 ? sp.radius : d0.spawnRadius !== 0 ? d0.spawnRadius : d0.collisionRadius;
    const lane = (b as unknown as { laneOf(x: number, y: number): number }).laneOf(x, y);
    const n1 = sp.main ? sp.number : defs.length;
    const nCircle = sp.main || sp.second ? (sp.main ? sp.number : 0) + (sp.second ? sp.secondCount : 0) : defs.length;
    const king = b.players[1 - team].king;
    const out: GhostUnit[] = [];
    defs.forEach((def, i) => {
      let ox = 0, oy = 0;
      if (i < nCircle) {
        [ox, oy] = formationOffset(i, n1, r, sp.width, team === 0, lane, d0.spawnAngleShift, sp.second ? sp.secondCount : 0,
          b.laneSeqDeploy);
      } else {
        const k = i - nCircle;
        ox = (team === 0 ? -1 : 1) * (sp.offsetsX[k] ?? 0);
        oy = (team === 0 ? -1 : 1) * (sp.offsetsY[k] ?? 0);
      }
      const gx = x + ox, gy = y + oy;
      out.push({ def, x: gx, y: gy, angle: Math.atan2(king.y - gy, king.x - gx) });
    });
    return out;
  }

  private lastNow = -1;

  /**
   * Advance the UI: deploy timers and pending marks on simulation time (`simDt` s, so pause and speed
   * apply), the overlay, HUD and preview animations on wall-clock time like the client's UI.
   */
  update(simDt: number, f: Frame): void {
    const b = f.battle;
    const dt = this.lastNow < 0 ? 0 : Math.min(0.25, Math.max(0, (f.now - this.lastNow) / 1000));
    this.lastNow = f.now;
    this.battleRef = b;
    const ui = this.ui;
    const team = this.hud.team;
    // overlay (0x869d44): class-5 actors with their data's NoDeploySize / CaptureTower
    const actors: AreaActor[] = [];
    for (const u of b.units) {
      actors.push({ x: u.x, y: u.y, team: u.team, alive: u.state !== ST_DEAD, isBuilding: u.isBuilding || u.tower !== TOWER_NONE,
        isSummoner: u.def.isSummoner, noDeployW: u.def.noDeployW, noDeployH: u.def.noDeployH });
    }
    const p = b.players[team];
    const sel = this.preview ? b.defs.card(this.preview.card, b.levels[team])
      : this.hud.selected >= 0 ? p.deck[p.hand[this.hud.selected]] ?? null : null;
    const fullLane = sel ? flag(this.raw(sel.name), 'FullLaneDeploy') : false;
    this.grid.update(dt, actors, team, this.art.flip, { fullLane });
    this.areaAlpha = deployAreaAlpha(this.areaAlpha, deployAreaShown(sel ? this.spellOf(sel) : null), dt);
    // deploy timers (0x8d9ad0)
    this.timers = this.timers.filter((tm) => tm.t.update(simDt));
    // cost texts: UI clips on the wall clock, removed once played through
    this.floats = this.floats.filter((fl) => { const was = fl.clip.playing; fl.clip.advance(dt); return was; });
    this.hud.update(dt, b);
    this.announcer()?.update(dt, b);
    // preview clips
    const pv = this.preview;
    if (!pv || !ui) {
      this.footprint = null;
      this.indicatorClip = null;
      this.previewCard = null;
      this.mana = { alpha: 0, shown: -1, flashT: 1000 };
    } else {
      if (this.previewCard !== pv.card) {
        this.previewCard = pv.card;
        const exp = this.footprintExport(pv.card);
        this.footprint = null;
        if (exp && ui.has(exp)) {
          const clip = new ClipPlayer(ui.frameCount(exp), ui.fps(exp));
          const l = ui.labels(exp);
          clip.playRange(l.appear ?? 0, l.appear_end ?? clip.frames - 1, false);
          const card = b.defs.card(pv.card, 11);
          const d = this.ghostDefs(card)[0];
          const ts = d && d.kind === 'building' ? this.tileSize(d) : 1;
          const n = Math.max(1, Math.min(4, ts));
          this.footprint = { exp, clip, scale: ts / n };
        }
        const ind = this.art.manifest.cards[pv.card]?.indicator as { sc: string; export: string; frames?: number; fps?: number } | undefined;
        this.indicatorClip = ind ? new ClipPlayer(ind.frames ?? 1, ind.fps ?? 30) : null;
        this.indicatorClip?.playRange(0, (ind?.frames ?? 1) - 1, true);
        this.mana = { alpha: 0, shown: -1, flashT: 1000 };
      }
      this.footprint?.clip.advance(dt);
      this.indicatorClip?.advance(dt);
      // mana counter (0x8e5ccc): "elixir/cost" while short of elixir, flashing on each change, fading at 3/s
      const card = b.defs.card(pv.card, b.levels[pv.team]);
      const pl = b.players[pv.team];
      const have = b.infiniteElixir ? 10 : Math.max(0, Math.min(10, Math.floor((pl.elixir - pl.pending) / 10000)));
      const cost = Math.min(10, card.cost);
      this.mana.flashT += dt;
      if (have <= cost && have !== this.mana.shown) {
        if (this.mana.shown === -1) this.mana.alpha = have < cost ? 1 : 0;
        this.mana.flashT = this.mana.shown === -1 ? 1000 : 0;
        this.mana.shown = have;
      }
      if (have >= cost) this.mana.alpha = Math.max(0, this.mana.alpha - 3 * dt);
    }
    for (const pm of this.pending) pm.clip.advance(simDt);
    this.pending = this.pending.filter((pm) => !(pm.removing && !pm.clip.playing) && b.tick - pm.submitTick < 200);
  }

  // ---------------------------------------------------------------- battle-layer passes

  /** Illegal-area overlay (battle layer child 7): bases, then border pieces (0x86a610). */
  drawArea(r: ScRenderer): void {
    const ui = this.ui;
    if (!ui || this.areaAlpha <= 0) return;
    const col: Col = [1, 1, 1, this.areaAlpha, 0, 0, 0];
    const tiles = this.grid.tiles(this.art.flip);
    const at = (t: { col: number; row: number }) => this.art.gameToPx(t.col * 1000 + 500, t.row * 1000 + 500);
    for (const t of tiles) {
      const [px, py] = at(t);
      r.draw(ui, 'deployArea_base', 0, [t.scale, 0, 0, t.scale, px, py], col);
    }
    for (const t of tiles) {
      if (!t.pieces.length) continue;
      const [px, py] = at(t);
      for (const k of t.pieces) r.draw(ui, DEPLOY_AREA_PIECES[k], 0, [1, 0, 0, 1, px, py], col);
    }
  }

  /** Ground part of the drag preview container: footprint, indicator clip, radius ring (0x8e4eb4). */
  drawPreviewGround(r: ScRenderer): void {
    const ui = this.ui;
    const b = this.battleRef;
    if (!ui || !b) return;
    for (const pm of this.pending) {
      const [px, py] = this.art.gameToPx(pm.x, pm.y);
      r.draw(ui, pm.exp, pm.clip.frame, [1, 0, 0, 1, px, py]);
    }
    const pv = this.preview;
    if (!pv || pv.alpha <= 0.01) return;
    const card = b.defs.card(pv.card, b.levels[pv.team]);
    const [px, py] = this.art.gameToPx(pv.x, pv.y);
    const col: Col = [1, 1, 1, pv.alpha, 0, 0, 0];
    const ring = this.ringOf(card);
    if (ring && this.range) {
      const verts = ringStrip(ring.R, ringBand(ring.R, this.range.height));
      r.drawImageStrip(this.range, verts, [1, 0, 0, 1, px, py], col);
      if (ring.minR > 0) r.drawImageStrip(this.range, ringStrip(ring.minR, -ringBand(ring.R, this.range.height)), [1, 0, 0, 1, px, py], col);
    }
    const ind = this.art.manifest.cards[pv.card]?.indicator as { sc: string; export: string } | undefined;
    if (ind && this.indicatorClip) {
      const lib = this.art.lib(ind.sc);
      if (lib) r.draw(lib, ind.export, this.indicatorClip.frame, [1, 0, 0, 1, px, py], col);
    }
    if (this.footprint) {
      const s = this.footprint.scale;
      // building footprint centring offset (+0xf0/+0xf4): the snapped position is already the footprint centre
      r.draw(ui, this.footprint.exp, this.footprint.clip.frame, [s, 0, 0, s, px, py], col);
    }
  }

  /** Ghost units of the preview (real actor views at SPELL_DRAG_OBJECT_ALPHA, 0x84f538). */
  ghostUnits(): { def: UnitDef; team: Team; x: number; y: number; angle: number; alpha: number }[] {
    const b = this.battleRef;
    const pv = this.preview;
    if (!b || !pv || pv.alpha <= 0.01) return [];
    const card = b.defs.card(pv.card, b.levels[pv.team]);
    // characters with health: ALPHA * 0.0015 + 0.85; others ALPHA * 0.01
    const a = CLIENT_GLOBALS.SPELL_DRAG_OBJECT_ALPHA;
    return this.ghosts(b, card, pv.team, pv.x, pv.y).map((g) => ({
      def: g.def, team: pv.team as Team, x: g.x, y: g.y, angle: g.angle,
      alpha: pv.alpha * (g.def.hitpoints > 0 ? a * 0.0015 + 0.85 : a * 0.01),
    }));
  }

  // ---------------------------------------------------------------- stage pass

  private manaInfo: { id: number; m: Mat } | null | undefined;

  /** The `mana` child of spell_placement_text: clip id and matrix. */
  private manaChild(ui: ScLibrary): { id: number; m: Mat } | null {
    if (this.manaInfo !== undefined) return this.manaInfo;
    this.manaInfo = null;
    const clip = ui.clip('spell_placement_text');
    if (!clip) return null;
    for (let i = clip.frameStart[0]; i < clip.frameStart[1]; i++) {
      const ci = clip.elements[i * 3];
      if (clip.names?.[ci] !== 'mana') continue;
      const mi = clip.elements[i * 3 + 1];
      const bm = ui.banks[clip.bank].m;
      this.manaInfo = { id: clip.children[ci], m: mi >= 0 ? [...bm.subarray(mi * 6, mi * 6 + 6)] as Mat : [1, 0, 0, 1, 0, 0] };
    }
    return this.manaInfo;
  }

  /** HUD layer: HUD elements, deploy timers and the drag name text, in stage px (view set here). */
  drawStage(r: ScRenderer, dpr: number): void {
    const ui = this.ui;
    const b = this.battleRef;
    if (!ui || !b) return;
    const [centreX, riverY] = this.toStage(...this.art.gameToPx(9000, 16000));
    this.hud.draw(r, b, dpr, riverY);
    // deploy timers: logic -> stage, truncated to whole stage px (0x8583bc), scale 1
    for (const tm of this.timers) {
      if (!tm.t.visible) continue;
      const [sx, sy] = this.toStage(...this.art.gameToPx(tm.x, tm.y));
      const exp = tm.team === this.hud.team ? 'troopDeployTimer_player' : 'troopDeployTimer_enemy';
      r.draw(ui, exp, tm.t.frame, [1, 0, 0, 1, Math.trunc(sx), Math.trunc(sy)], WHITE, { childFrame: tm.t.frame });
    }
    // own plays' elixir cost texts, in the same container as the timers (+0x300), added after them
    for (const fl of this.floats) {
      const [sx, sy] = this.toStage(...this.art.gameToPx(fl.x, fl.y));
      r.draw(ui, 'elixir_float_txt', fl.clip.frame, [1, 0, 0, 1, Math.trunc(sx), Math.trunc(sy)], WHITE,
        { childFrame: fl.clip.frame, text: { txt: fl.text } });
    }
    // timed announcements, children the HUD adds at the arena centre (_DAT_01a57004/8)
    this.announce?.draw(r, [Math.trunc(centreX), Math.trunc(riverY)]);
    // drag name text (spell_placement_text): projected drop point, y + SPELL_DRAG_NAME_Y_POS / layer scale
    const pv = this.preview;
    if (pv && pv.alpha > 0.01 && ui.has('spell_placement_text')) {
      const [sx, sy] = this.toStage(...this.art.gameToPx(pv.x, pv.y));
      const yOff = CLIENT_GLOBALS.SPELL_DRAG_NAME_Y_POS / this.layout.battleScale;
      const card = b.defs.card(pv.card, b.levels[pv.team]);
      const name = (this.raw(pv.card)?._displayName as string | undefined) ?? pv.card;
      const lvl = (this.art.manifest.hud.texts?.TID_SPELL_ITEM_LEVEL_SHORT ?? 'lvl.<NUMBER>').replace('<NUMBER>', String(card.level));
      const flash = this.mana.flashT < 0.28 ? Math.min(1, Math.max(0, Math.sin(Math.min(1, this.mana.flashT * 3.5714285) * Math.PI) * 0.5)) * 255 : 0;
      const m: Mat = [1, 0, 0, 1, sx, sy + yOff];
      r.draw(ui, 'spell_placement_text', 0, m, [1, 1, 1, pv.alpha, 0, 0, 0], {
        named: { mana: { hide: true } },
        text: { txt: name, level: lvl },
      });
      const mc = this.manaChild(ui);
      if (this.mana.alpha > 0 && mc) {
        // the mana child ("have/cost" + elixir drop) has its own `txt`: draw it on its own
        const pl = b.players[pv.team];
        const have = b.infiniteElixir ? 10 : Math.max(0, Math.min(10, Math.floor((pl.elixir - pl.pending) / 10000)));
        const mm: Mat = [m[0] * mc.m[0], 0, 0, m[3] * mc.m[3], m[4] + mc.m[4], m[5] + mc.m[5]];
        r.drawId(ui, mc.id, 0, mm, [1, 1, 1, pv.alpha * this.mana.alpha, flash, flash, flash], {
          text: { txt: `${Math.min(have, card.cost)}/${Math.min(10, card.cost)}` },
        });
      }
    }
  }
}
