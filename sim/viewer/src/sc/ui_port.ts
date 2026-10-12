// In-battle UI logic ported from the decompiled client (libg 160402020). Pure functions and small
// state machines, no rendering: sim/viewer/src/hud.ts and art.ts draw with the game's own exports.
//
//   stageLayout          content scale 0x772a70, battle layer scale/position 0xbdefac
//   DeployAreaGrid       red "illegal area" overlay: stamps 0x869d44, tiles/borders 0x86a610
//   deployAreaShown      which selected card shows the overlay (0x8cb0f4 mode logic)
//   indicatorRadius      drag radius indicator size (SpellData +0x180/+0x184/+0x188, 0xe7ee04)
//   ringStrip            radius indicator mesh (0xcf0838 -> 0xcf152c, texture image/range.png)
//   DeployTimer          troopDeployTimer clock (ctor 0x8d9748, update 0x8d9ad0)
//   uiEase               value ease with overshoot (0x1433fb0)
//   ElixirBar            HUD_player elixir bar state (0x8da088 setup, 0x8dbebc update) and its refund flash
//   UiBar, refundBar     one stretched bar of the elixir bar (0x8b2368 / 0x8b2490 / 0x8b2408 / 0x8b2520)
//   barTipX              bar_tip position after a change (0x8dbebc)
//   elixirDropXs         Elixir_bar_drop_anim of a spend (0x85ada8 -> 0x8d144c -> 0x8dcbf4)
//   elixirGainText/Export, PanelFlash  elixir gain floats (battle screen vt+0x398 0xbe4a8c, 0x8dce48)
//   regenBadgeText       elixirRegen badge text (0x8d38c4 -> 0x8d5158)
//   cardSlot             hand card placement in cardArea (0x8da088)
//   HandCard, cardEntry  hand card cycle: hide after a play, deal from the next card (0x8e0b84, 0x8e1408)
//   nextCardTimer        next card grayscale + NextSpellTimer while the hand timer runs (0x8dc37c)
//   dropWaits, dropWaitStep  releasing a card a moment before it is affordable (0x8e2c04, 0x8e2d50,
//                        0x8e1408 +0x324; MAX_SPELL_PENDING_TIME)
//   HandWiggle           full-elixir hand card shake (list 0x907230: add 0x907654, remove 0x9077f0,
//                        update 0x907ab0, matrix 0x123e8b4), spellInstanceId (LogicData +0x40)
//   PENDING_GHOST_S      lifetime cap of a released play's leftover preview (0x8dd4cc)
//   radialFillStrip      RadialFill card mask while a card is unaffordable (ctor 0x89f9b4, draw 0x89fd24)
//   elixirRequirement    selected card's cost on the elixir bar (0x8dbebc, elixirRequirementBar)
//   battleClock          the HUD time update's clock (0x8d38c4 on the battle timeline 0xd56070)
//   postEndTicks         the battle ticks run after the end until the end screen (0x10ca9a0 / 0xd3581c)
//   topRightFade         HUD_topRight's alpha in the HUD update 0x8d1e6c (fade out once input is blocked)
//   HandPanelSlide       HUD_player's slide-in (0x8db8e0 +0x21c / +0x274) and the hand update gate (0x8dc37c)
//   defaultFloaterPos    the popup manager's default floater point (0x88ca58)

// -- stage --------------------------------------------------------------------------------------

/** Client globals the layout reads (client_globals.csv). */
export const CLIENT_GLOBALS = {
  BACKGROUND_Y_SIZE: 1120,
  BACKGROUND_Y_OFFSET: 90,
  SPELL_DRAG_OBJECT_ALPHA: 50,
  SPELL_DRAG_NAME_Y_POS: -30,
};

export interface StageLayout {
  /** stage size in SC px */
  stageW: number;
  stageH: number;
  /** CSS px per stage px */
  k: number;
  /** battle layer scale (stage px per battle-layer px) and the stage position of its origin
   * (battle-layer px (0, 0) = the arena's horizontal centre on its far edge) */
  battleScale: number;
  battleX: number;
  battleY: number;
}

/**
 * Stage and battle-layer placement for a viewport of cssW x cssH.
 * Content scale 0x772a70: min(h/w, 1.77) * w / 1024 device px per SC px, i.e. the stage is
 * 1024 / min(h/w, 1.77) SC px wide (safe-area insets ignored).
 * Battle layer 0xbdefac (normal battle): scale = stageH / BACKGROUND_Y_SIZE, or stageW /
 * (BACKGROUND_Y_SIZE / 2) when stageW / stageH < 0.5; margin = BACKGROUND_Y_OFFSET, or
 * 0.75 * offset + (stageH - scale * size) / 2 on those tall screens; the layer sits at
 * (0, scale * margin - stageH / 2) inside the camera container placed at the stage centre
 * (0xbde180), whose steady-state zoom is 1 (0xbe4464: DEFAULT_MAP_WIDTH_TILES / map width).
 */
export function stageLayout(cssW: number, cssH: number, g = CLIENT_GLOBALS): StageLayout {
  const w = Math.max(1, cssW), h = Math.max(1, cssH);
  const ratio = Math.min(h / w, 1.77);
  const stageW = 1024 / ratio;
  const stageH = h * (stageW / w);
  const size = g.BACKGROUND_Y_SIZE;
  let scale = stageH / size;
  let margin = g.BACKGROUND_Y_OFFSET;
  if (stageW / stageH < 0.5) {
    scale = stageW / (size * 0.5);
    margin = margin * 0.75 + (stageH - scale * size) * 0.5;
  }
  return { stageW, stageH, k: w / stageW, battleScale: scale, battleX: stageW * 0.5, battleY: scale * margin };
}

// -- deploy area (illegal area overlay) ----------------------------------------------------------

/** One actor as the overlay sees it (class-5 actors: characters, buildings, towers). */
export interface AreaActor {
  x: number;
  y: number;
  team: number;
  alive: boolean;
  isBuilding: boolean;
  isSummoner: boolean; // IsSummoner (+0x572)
  captureTower?: boolean; // CaptureTower (+0x544)
  noDeployW: number; // NoDeploySizeW (+0x80c)
  noDeployH: number; // NoDeploySizeH (+0x810)
}

/** Border piece indices of 0x86af30 (deployArea_* exports in this order, FUN_008699d8). */
export const DEPLOY_AREA_PIECES = [
  'deployArea_side_top', 'deployArea_side_right', 'deployArea_side_bottom', 'deployArea_side_left',
  'deployArea_corner_rightTop', 'deployArea_corner_rightBottom', 'deployArea_corner_leftBottom', 'deployArea_corner_leftTop',
  'deployArea_innerCorner_topRight', 'deployArea_innerCorner_bottomRight', 'deployArea_innerCorner_bottomLeft',
  'deployArea_innerCorner_topLeft',
] as const;

export interface AreaTile {
  col: number;
  row: number;
  /** base tile scale: 1 while blocked, timer * 4.1667 clamped while it shrinks away */
  scale: number;
  /** border pieces (indices into DEPLOY_AREA_PIECES) in the client's draw order */
  pieces: number[];
}

const trunc = Math.trunc;

/**
 * The battle layer's deploy-area child (vtable 0x188f318). A grid of (map width / 2) x (map
 * height / 2) tiles; every frame (0x869d44) the enemy's buildings / summoners with a
 * NoDeploySize stamp their rectangle as blocked, a capture tower stamps blocked for the enemy and
 * clear for its owner; a FullLaneDeploy card extends stamped rows to the whole row; outside special
 * modes the first and last 7 tiles of the enemy back row are cleared. A tile that stops being
 * blocked gets a shrink timer of 0.24 + 0.04 * |rows/2 - row| s (the pocket opens from the river
 * outwards). Drawing (0x86a610): deployArea_base at every blocked or shrinking tile centre, then
 * the side/corner/inner-corner pieces chosen from the 8 neighbours.
 */
export class DeployAreaGrid {
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array; // +0x138
  readonly touched: Uint8Array; // +0x140
  readonly timer: Float32Array; // +0x130
  /** +0x168 mode (0x86ada0): 1 shortens stamps by 12 */
  mode = 0;

  constructor(mapW = 36, mapH = 64) {
    this.cols = trunc(mapW / 2);
    this.rows = trunc(mapH / 2);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.touched = new Uint8Array(n);
    this.timer = new Float32Array(n);
  }

  setMode(m: number): void {
    if (m === this.mode) return;
    this.mode = m;
    this.blocked.fill(0);
  }

  /**
   * @param flip the viewer is logic player 0 (0x858430: battle layer +0x1b9)
   * @param fullLane the selected card has FullLaneDeploy (SpellData +0x17f)
   * @param coop 2v2 (0xd36e90): summoners stamp twice as wide
   * @param special a mode where the back-row corners are not cleared (0xd36084)
   */
  update(dt: number, actors: readonly AreaActor[], myTeam: number, flip: boolean,
    o: { fullLane?: boolean; coop?: boolean; special?: boolean } = {}): void {
    const { cols, rows, blocked, touched, timer } = this;
    touched.fill(0);
    for (const a of actors) {
      if (!a.alive) continue;
      let W = 0, H = 0, value = 1;
      if (a.captureTower) {
        value = a.team === myTeam ? 0 : 1;
        W = a.noDeployW;
        H = a.noDeployH;
      } else if ((a.isBuilding || a.isSummoner) && a.team !== myTeam && a.noDeployW > 0) {
        W = a.noDeployW;
        H = a.noDeployH;
        if (this.mode === 1) H -= 12;
        else if (o.coop && a.isSummoner) W <<= 1;
      } else continue;
      if (W === 0 || H === 0) continue;
      const cx = trunc(a.x / 500), cy = trunc(a.y / 500);
      const c0 = this.lo(cx - W, cols), c1 = this.hi(cx + W, cols);
      const r0 = this.lo(cy - H, rows), r1 = this.hi(cy + H, rows);
      if (r0 > r1 || c0 > c1) continue;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          blocked[i] = value;
          touched[i] = 1;
          timer[i] = 0;
        }
      }
    }
    if (o.fullLane) {
      for (let r = 0; r < rows; r++) {
        let hit = false;
        for (let c = 0; c < cols; c++) if (blocked[r * cols + c] && touched[r * cols + c]) { hit = true; break; }
        if (!hit) continue;
        for (let c = 0; c < cols; c++) { const i = r * cols + c; blocked[i] = 1; touched[i] = 1; timer[i] = 0; }
      }
    }
    if (!o.special) {
      const base = flip ? (rows - 1) * cols : 0;
      for (let k = 0; k < 7; k++) {
        blocked[base + k] = 0; timer[base + k] = 0;
        blocked[base + cols - 1 - k] = 0; timer[base + cols - 1 - k] = 0;
      }
    }
    const half = trunc(rows / 2);
    for (let i = cols * rows - 1; i >= 0; i--) {
      if (blocked[i] === 0) {
        if (timer[i] > 0) { timer[i] -= dt; if (timer[i] < 0) timer[i] = 0; }
      } else if (touched[i] === 0) {
        blocked[i] = 0;
        const row = trunc(i / cols);
        timer[i] = Math.abs(half - row) * 0.04 + 0.24;
      }
    }
  }

  /** first tile of a stamp: (v + 1) / 2 truncated toward zero, 0 below -1, clamped to n - 1 */
  private lo(v: number, n: number): number {
    if (v + 1 <= -2) return 0;
    return Math.min(trunc((v + 1) / 2), n - 1);
  }

  /** last tile of a stamp: (v - 1) / 2 truncated toward zero, 0 below -1, clamped to n - 1 */
  private hi(v: number, n: number): number {
    if (v - 1 <= -2) return 0;
    return Math.min(trunc((v - 1) / 2), n - 1);
  }

  private on(c: number, r: number): boolean {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return false;
    const i = r * this.cols + c;
    return this.blocked[i] !== 0 || this.timer[i] > 0;
  }

  /** Tiles to draw this frame (0x86a610). `flip` picks screen up/right in tile steps. */
  tiles(flip: boolean): AreaTile[] {
    const out: AreaTile[] = [];
    const U = flip ? 1 : -1; // row step toward screen top
    const R = flip ? -1 : 1; // column step toward screen right
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const i = row * this.cols + col;
        if (!this.blocked[i] && !(this.timer[i] > 0)) continue;
        let scale = 1;
        if (!this.blocked[i]) scale = Math.max(0, Math.min(1, this.timer[i] * 4.166667));
        const up = this.on(col, row + U), down = this.on(col, row - U);
        const right = this.on(col + R, row), left = this.on(col - R, row);
        const ur = this.on(col + R, row + U), dr = this.on(col + R, row - U);
        const dl = this.on(col - R, row - U), ul = this.on(col - R, row + U);
        const b16 = up || ur || right, b17 = left || ul || up;
        const b15 = down || dr || right, b18 = down || dl || left;
        const p: number[] = [];
        if (!up && b16 && b17) p.push(0);
        if (!right && b16 && b15) p.push(1);
        if (!down && b18 && b15) p.push(2);
        if (!left && b18 && b17) p.push(3);
        if (!b16) p.push(4);
        if (!b15) p.push(5);
        if (!b17) p.push(7);
        if (!b18) p.push(6);
        if (up && !ur && right) p.push(8);
        if (down && !dr && right) p.push(9);
        if (left && !ul && up) p.push(11);
        if (down && !dl && left) p.push(10);
        out.push({ col, row, scale, pieces: p });
      }
    }
    return out;
  }
}

/**
 * Overlay alpha step (0x8caf60): +6/s while shown, -6/s otherwise, kept in 0..1.
 */
export function deployAreaAlpha(alpha: number, shown: boolean, dt: number): number {
  return Math.max(0, Math.min(1, alpha + (shown ? 6 : -6) * dt));
}

/** SpellData fields the HUD reads for the selected card. */
export interface UiSpell {
  summonCharacter: boolean; // SummonCharacter / SummonCharacterSecond (0xe7e840)
  radius: number; // Radius (+0x158)
  canDeployOnEnemySide: boolean; // +0x172
  spellAsDeploy: boolean; // +0x17c
  onlyOwnTroops: boolean; // +0x170
  hasProjectile: boolean; // Projectile (+0xc0)
  touchdownLimitedDeploy?: boolean; // +0x173
}

/**
 * Whether selecting this card shows the illegal-area overlay (0x8cb0f4, state +0x368+8): summon
 * cards that cannot deploy on the enemy side, SpellAsDeploy projectiles (The Log), and other
 * SpellAsDeploy spells limited to the own side; not ordinary spells.
 */
export function deployAreaShown(s: UiSpell | null): boolean {
  if (!s) return false;
  let mode: number;
  let flag = 0;
  if (s.summonCharacter) {
    mode = s.canDeployOnEnemySide ? 1 : 2;
    if (s.radius > 0) {
      if (!s.canDeployOnEnemySide) mode = 3;
      else return false; // the native code leaves the flag unchanged here (A: treated as hidden)
    }
  } else if (s.hasProjectile && s.spellAsDeploy) {
    mode = 0;
    flag = 1;
  } else if (s.onlyOwnTroops) {
    mode = 1;
  } else {
    mode = !s.canDeployOnEnemySide && s.spellAsDeploy ? 3 : 0;
  }
  return mode === 2 || mode === 3 || mode === 4 || flag === 1;
}

// -- radius indicator -----------------------------------------------------------------------------

export interface IndicatorInput {
  radius: number; // SpellData Radius
  projectile: { radius: number; radiusY: number; aeoRadius?: number } | null;
  /** the summoned character (SummonCharacter) */
  summon: { speed: number; range: number; minimumRange: number; collisionRadius: number;
    projectileMaxDistance?: number } | null;
  aeoRadius: number; // AreaEffectObject Radius
  hideRadiusIndicator: boolean;
}

/**
 * Radius the drag preview shows (SpellData +0x180, set at load by 0xe7ee04): Radius; else the
 * projectile's Radius (or its area effect's); else for a summoned turret (Speed 0, Range >= 1)
 * CollisionRadius + Range, capped by the projectile's MaxDistance + CollisionRadius, with
 * MinimumRange as the inner radius (+0x188); else the AreaEffectObject's Radius. `length` is the
 * spell projectile's RadiusY (0x8e4eb4 passes it to the indicator as a length).
 */
export function indicatorRadius(s: IndicatorInput): { radius: number; minRadius: number; length: number } {
  const length = s.projectile?.radiusY ?? 0;
  if (s.radius !== 0) return { radius: s.radius, minRadius: 0, length };
  if (s.projectile) {
    const r = s.projectile.radius || s.projectile.aeoRadius || 0;
    if (r !== 0) return { radius: r, minRadius: 0, length };
  }
  const c = s.summon;
  if (c && c.speed === 0 && c.range >= 1) {
    let r = c.collisionRadius + c.range;
    const md = c.projectileMaxDistance ?? 0;
    if (md !== 0 && md < r) r = md + c.collisionRadius;
    if (r !== 0) return { radius: r, minRadius: c.minimumRange, length };
  }
  return { radius: s.aeoRadius, minRadius: 0, length };
}

/**
 * Ring mesh of the radius indicator, battle-layer px around (0, 0), as a triangle strip
 * [x, y, u, v] * n alternating outer and inner points (0xcf152c): segments = R * 0.1309 + 0.99,
 * at least 64 (step 2pi/64) and at most 100 (step 2pi/100); y = sin * r / 1.25; u, v = 0 on the
 * outer edge (the bright end of image/range.png) and 1 on the inner edge. `band` follows 0xcf0838:
 * the texture height (32 px), or R / 2 when R - 32 <= R / 2. A negative band (min-range ring) grows
 * outwards from R.
 */
export function ringStrip(R: number, band: number, yDiv = 1.25): Float32Array {
  const fn = R * 0.1308997 + 0.99;
  const nRaw = trunc(fn);
  let n = 64;
  let step = 0.09817477;
  const s0 = 6.2831855 / nRaw;
  if (s0 <= 0.09817477) { step = s0; n = nRaw; }
  const count = Math.min(n, 100);
  if (n >= 101) step = 0.06283186;
  const inner = R - band;
  const out = new Float32Array((count * 2 + 2) * 4);
  out.set([R, 0, 0, 0, inner, 0, 1, 1], 0);
  for (let i = 1; i <= count; i++) {
    const a = step * i;
    const c = Math.cos(a), s = Math.sin(a) / yDiv;
    out.set([c * R, s * R, 0, 0, c * inner, s * inner, 1, 1], i * 8);
  }
  return out;
}

/** Band width for a ring of radius R px (0xcf0838): texture height, or R / 2 when R is small. */
export function ringBand(R: number, texH = 32): number {
  return R - texH <= R * 0.5 ? R * 0.5 : texH;
}

// -- deploy timer ---------------------------------------------------------------------------------

/**
 * troopDeployTimer clock (vtable 0x1899058). Created with total = DeployTime / 1000 s and a delay;
 * state 1: t = clamp(t + dt, -delay, total), visible once t >= 0, frame = (int)(t * E / total + 0.5)
 * with E the `end` label; a tick sound every total / 4. At t = total: t = 0, total = frame
 * duration * (frames - 1 - E) and state 2 plays the outro: frame = E + (int)(t * (frames - 1 - E) /
 * total + 0.5). When that ends the clip hides and the object is removed (state 3).
 */
export class DeployTimer {
  state = 1;
  t: number;
  total: number;
  readonly delay: number;
  frame = 0;
  visible = false;
  ticks = 0;
  private tick = 0;

  readonly end: number;
  readonly frames: number;
  readonly fps: number;

  constructor(totalS: number, delayS: number, end: number, frames: number, fps: number) {
    this.end = end;
    this.frames = frames;
    this.fps = fps;
    this.t = -delayS;
    this.total = totalS - delayS;
    this.delay = delayS;
  }

  /** Advance by dt seconds; false once finished (remove it). */
  update(dt: number): boolean {
    if (this.state === 2) {
      const t = Math.min(this.total, Math.max(0, this.t + dt));
      this.t = t;
      if (t < this.total) {
        this.frame = this.end + trunc((t * (this.frames - 1 - this.end)) / this.total + 0.5);
      } else {
        this.visible = false;
        this.state = 3;
      }
    } else if (this.state === 1) {
      const t = Math.min(this.total, Math.max(-this.delay, this.t + dt));
      this.t = t;
      this.visible = t >= 0;
      if (t < 0) return true;
      if (t < this.total) {
        this.frame = trunc((t * this.end) / this.total + 0.5);
        this.tick -= dt;
        if (this.tick <= 0) { this.ticks++; this.tick = this.total * 0.25; }
      } else {
        this.t = 0;
        this.total = (1 / this.fps) * (this.frames - 1 - this.end);
        this.frame = this.end;
        this.state = 2;
      }
    }
    return this.state !== 3;
  }
}

// -- elixir bar -----------------------------------------------------------------------------------

/**
 * Ease with overshoot (0x1433fb0): t < 0 -> from; t < a: linear from `from` to `to + s` (s = |amp|
 * signed by to - from); a <= t < a + b: to + sin((t - a) * (pi/2) / a + pi/2) * (1 - (t - a) / b) * s;
 * after that `to`.
 */
export function uiEase(from: number, to: number, t: number, a: number, amp: number, b: number): number {
  const s = to - from >= 0 ? Math.abs(amp) : -Math.abs(amp);
  if (t < 0) return from;
  if (t < a) return ((to - from + s) * t) / a + from;
  if (t < b + a) return to + Math.sin(((t - a) * 1.5707964) / a + 1.5707964) * (1 - (t - a) / b) * s;
  return to;
}

/**
 * HUD_player elixir bar (0x8dbebc each frame). `whole` = available whole elixir (0xfa1c84),
 * `hundredths` = available elixir in 1/100 (0xfa1d10). The `ghost` bar follows hundredths / (max *
 * 100); the main bar (bar_body + bar_end) and the number show whole elixir: when it changes the number
 * is replaced and a 0.255 s bounce starts (number scale 1 +- 0.08 sin(36.96 t)), the bar easing from
 * (n - 1) / max to n / max with uiEase(t' = 1 - 3.92 * timer, a = 0.25, amp = 0.02, b = 0.75); bar_tip
 * replays at the new end. bar_flow shows (and elixir_warning plays) when full.
 * Refund flash: when whole elixir rises by more than 1 (a play that failed at its commit gives its
 * reserved elixir back; also the first update, since the setup 0x8da088 sets +0x260 = -1), bar_refund
 * (+0x1f0) shows the refund bar (+0x1c0: bar_body_refund / bar_end_refund) from the old count to the
 * new one (x = old * len / max - 7, length = len / max * rise, fill 1) and fades over 0.25 s: timer
 * +0x214 = 0.25 at the rise, then each frame t = max(0, t - dt), alpha = 1 - (1 - 4 t)^2 (0x123cbc0),
 * hidden on the frame after t reached 0.
 */
export class ElixirBar {
  last = -1; // +0x260 (0x8da088: -1)
  timer = 0; // +0x218
  fill = 0; // main bar fraction (+0x1b0 helper)
  ghost = 0; // ghost fraction (+0x1b8)
  textScaleX = 1;
  textScaleY = 1;
  full = false;
  /** bar_tip replay started this frame (x fraction) */
  tipAt: number | null = null;
  /** set when bar_flow / elixir_warning restart (became full) */
  flowStarted = false;
  /** bar_refund visible (+0x1f0 +8) */
  refundShown = false;
  /** refund timer (+0x214) */
  refundT = 0;
  /** bar_refund alpha byte (0x123cbc0) */
  refundAlpha = 0;
  /** whole elixir before the last refund (the refund bar's start, 0x8b2520) and the rise (+0x208) */
  refundFrom = 0;
  refund = 0;
  /** a refund started this frame (place the refund bar) */
  refundStarted = false;

  readonly max: number;

  constructor(max = 10) { this.max = max; }

  update(dt: number, whole: number, hundredths: number): void {
    const max = this.max;
    this.ghost = hundredths / (max * 100);
    this.flowStarted = false;
    const isFull = max * 100 <= hundredths;
    if (isFull !== this.full) { this.full = isFull; if (isFull) this.flowStarted = true; }
    if (this.timer > 0) {
      const t = Math.max(0, this.timer - dt);
      this.timer = t;
      const s = Math.sin(t * 36.959915);
      this.textScaleX = s * 0.08 + 1;
      this.textScaleY = 1 - s * 0.08;
      const to = this.last / max, from = (this.last - 1) / max;
      this.fill = uiEase(from, to, t * -3.9215686 + 1, 0.25, Math.abs(to - from) * 0.2, 0.75);
    } else {
      this.textScaleX = this.textScaleY = 1;
    }
    this.tipAt = null;
    this.refundStarted = false;
    const rise = whole - this.last;
    if (rise !== 0) {
      if (rise > 1) {
        this.refundStarted = true;
        this.refund = rise;
        this.refundFrom = this.last;
        this.refundShown = true;
        this.refundT = 0.25;
      }
      this.last = whole;
      this.timer = 0.255;
      this.tipAt = Math.max(0, Math.min(1, whole / max));
    }
    if (this.refundShown) {
      if (this.refundT > 0) {
        const t = Math.max(0, f32(this.refundT - dt));
        this.refundT = t;
        const k = f32(f32(t * -4) + 1);
        const a = f32(1 - f32(k * k));
        this.refundAlpha = a < 0 ? 0 : Math.trunc(f32((a > 1 ? 1 : a) * 255));
      } else {
        this.refundShown = false;
      }
    }
  }
}

/**
 * One bar of the elixir bar (object 0x8b2368, 0x30 bytes): a body clip stretched in x and an optional
 * end cap at the body's right edge. The constructor 0x8b2368(len, body, end) keeps the body's width
 * (+0x18, 0x123c9e0: its bounds in the parent's space), its scale x (+0x1c, 0x123cc04), len (+0x20),
 * the end's width (+0x24, 0 without one) and fill 0 (+0x28). Every setter re-applies
 *   body scale x = ((len - end width) * fill * scale x) / width        (0x123c570)
 * and puts the end at the right edge of the body's bounds in the parent's space (0x123c5ac). setFill
 * 0x8b2490, setLength 0x8b2408, setX 0x8b2520 (the body's x); 0x8b2400 = len, 0x8b2514 = body x.
 * Body: its x, scale x and local bounds x0..x1 (in its own space, before its matrix).
 */
export class UiBar {
  len: number; // +0x20
  readonly endW: number; // +0x24
  fill = 0; // +0x28
  bodyX: number; // body +0x20
  bodyScale: number; // body +0x10
  private readonly w0: number; // +0x18
  private readonly s0: number; // +0x1c
  private readonly lx0: number;
  private readonly lx1: number;

  constructor(len: number, body: { x: number; scale: number; x0: number; x1: number }, endW = 0) {
    this.len = len;
    this.endW = endW;
    this.bodyX = body.x;
    this.bodyScale = body.scale;
    this.s0 = body.scale;
    this.lx0 = body.x0;
    this.lx1 = body.x1;
    this.w0 = Math.abs(body.scale) * (body.x1 - body.x0);
  }

  private apply(): void {
    this.bodyScale = this.w0 ? f32(f32(f32(f32(this.len - this.endW) * this.fill) * this.s0) / this.w0) : 0;
  }

  setFill(f: number): void { this.fill = f; this.apply(); }

  setLength(len: number): void { this.len = len; this.apply(); }

  setX(x: number): void { this.bodyX = x; this.apply(); }

  /** x of the end cap: the right edge of the body's bounds in the parent's space. */
  get endX(): number {
    const a = this.bodyX + this.bodyScale * this.lx0, b = this.bodyX + this.bodyScale * this.lx1;
    return a > b ? a : b;
  }
}

/**
 * The refund bar of a refund (0x8dbebc): setX(old * (len / max) - 7), setLength((len / max) * rise),
 * setFill(1), `len` = the main bar's length (0x8b2400).
 */
export function refundBar(bar: UiBar, mainLen: number, max: number, from: number, rise: number): void {
  const per = f32(mainLen / max);
  bar.setX(f32(f32(f32(from) * per) - 7));
  bar.setLength(f32(per * rise));
  bar.setFill(1);
}

/** bar_tip x after a change of whole elixir (0x8dbebc): clamp(whole / max, 0, 1) * len + 2 + body x. */
export function barTipX(whole: number, max: number, len: number, bodyX: number): number {
  const q = f32(whole / max);
  const k = q >= 0 ? (q <= 1 ? q : 1) : 0;
  return f32(f32(f32(k * len) + 2) + bodyX);
}

/**
 * Elixir_bar_drop_anim of a spend (0x8dcbf4 from the unit view's card-deploy handler 0x85ada8 ->
 * 0x8d144c): `n` = the play's elixir cost, one clip each, the first at the elixir_bar's position in
 * HUD_player (+0x1a8 +0x20 / +0x24), each next one `w` further right (0x123c9e0: the clip's width at
 * its first frame); each plays 0..frames-1 once (0x1241f50) as a HUD_player child (elixir_bar +0x38)
 * and the HUD_player update 0x8db8e0 deletes it once it stopped (+0x4d == 2). Returns the x of each.
 */
export function elixirDropXs(n: number, barX: number, w: number): number[] {
  const xs: number[] = [];
  let x = barX;
  for (let i = 0; i < n; i++) { xs.push(x); x = f32(w + x); }
  return xs;
}

/**
 * Text of an elixir gain float (battle screen listener vt+0x398 0xbe4a8c): amount in 1/10000 elixir;
 * "%d" of amount / 10000 when amount % 10000 is within +-999, else "%d.%d" with the tenths
 * ((amount % 10000) / 1000), both truncated toward zero.
 */
export function elixirGainText(amount: number): string {
  const whole = Math.trunc(amount / 10000);
  const rem = amount - whole * 10000;
  if (rem + 999 >= 0 && rem + 999 < 1999) return String(whole);
  return `${whole}.${Math.trunc(rem / 1000)}`;
}

/**
 * Export of an elixir gain float (0xbe4a8c): elixir_float_txt for side -1 (the Elixir Collector's
 * collection, 0xf800bc), else elixir_float_txt_blue when the side's parity is the HUD player's team
 * (0xd39718 of the home player), else elixir_float_txt_red.
 */
export function elixirGainExport(side: number, homeTeam: number): string {
  if (side === -1) return 'elixir_float_txt';
  return (side < 0 ? -(side & 1) : side & 1) === homeTeam ? 'elixir_float_txt_blue' : 'elixir_float_txt_red';
}

/**
 * HUD_player gain flash: 0xbe4a8c (side >= 0) calls 0x8dce48 on the receiving player's panel, which
 * sets +0x27c = 0.4; each HUD_player update 0x8db8e0 does t = max(0, t - dt) and gives the HUD_player
 * clip the additive colour (r, g, b) = (int)(min(1, t / 2) * 255).
 */
export class PanelFlash {
  t = 0; // +0x27c
  add = 0; // HUD_player +0xd..+0xf

  start(): void { this.t = f32(0.4); }

  update(dt: number): void {
    const t = Math.max(0, f32(this.t - dt));
    this.t = t;
    const v = f32(t * 0.5);
    this.add = v >= 0 ? Math.trunc(f32((v <= 1 ? v : 1) * 255)) : 0;
  }
}

/**
 * The elixir speed badge `elixirRegen` of HUD_topRight / HUD_topRight_overtime (the HUD time update
 * 0x8d38c4, not while the battle is over or on its first update): hidden while the phase's visible rate
 * (x10, 0xd56780) is below 11; otherwise when the rate changed or the badge is hidden, 0x8d5158 sets its
 * child `elixir`'s txt to "x%d" (rate / 10) or "x%d.%d" (rate / 10, rate % 10), shows it and plays it
 * 0..frames-1 once.
 */
export function regenBadgeText(rate10: number): string {
  const q = Math.trunc(rate10 / 10), r = rate10 - q * 10;
  return r === 0 ? `x${q}` : `x${q}.${r}`;
}

// -- hand ------------------------------------------------------------------------------------------

/**
 * Card slot i (0..3) in HUD_player's cardArea rect [x0, y0, x1, y1] (0x8da088 -> 0x8e2eb0): x = x0 + W *
 * (i / 4 + 0.125), y = the rect's middle, scale (+0x2c4) = rect height / card height. The card height is
 * the hand card's own height when the HUD builds it (vt+0x68, 0x123ca58), before it holds a card: the
 * empty card visual is just card_item_frame (0x8b25e8 -> 0x90ab14 -> 0x90acc8 with no spell).
 */
export function cardSlot(area: readonly [number, number, number, number], i: number, cardH: number): { x: number; y: number; s: number } {
  const W = area[2] - area[0], H = area[3] - area[1];
  return { x: area[0] + W * (i / 4 + 0.125), y: area[1] + H * 0.5, s: H / cardH };
}

/** Selected card raise (0x8e1408): the slot y moves by -17 px (own hand) over 0.24 s with uiEase(.., 0.2, 5, 0.8). */
export function cardRaise(baseY: number, t: number, selected: boolean, top = false): number {
  const d = top ? 17 : -17;
  const k = Math.max(0, Math.min(1, t * 4.166667));
  return selected ? uiEase(baseY, baseY + d, k, 0.2, 5, 0.8) : uiEase(baseY + d, baseY, k, 0.2, 5, 0.8);
}

/** Start transform of a hand card's entry: the 0x8e0a80 matrix (scale x, scale y, x, y). */
export interface CardStart { x: number; y: number; sx: number; sy: number }

/**
 * The hand card's entry transform (0x8e1408 while the entry timer t (+0x350) < D (+0x354)): with
 * k = clamp(t / D, 0, 1) and k4 = clamp(4t / D, 0, 1), x = uiEase(start x, slot x, k, 1/3, 20, 2/3),
 * y = start y + k4 (slot y - start y), scale x / y = start scale x / y + k4 (slot scale - start). null
 * while t < 0 (alpha 0: the battle-start delays).
 */
export function cardEntry(t: number, dur: number, from: CardStart, toX: number, toY: number, toS: number):
  { x: number; y: number; sx: number; sy: number } | null {
  if (t < 0) return null;
  const k = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 1;
  const k4 = dur > 0 ? Math.max(0, Math.min(1, (t * 4) / dur)) : 1;
  return {
    x: uiEase(from.x, toX, k, 1 / 3, 20, 2 / 3),
    y: from.y + k4 * (toY - from.y),
    sx: from.sx + k4 * (toS - from.sx),
    sy: from.sy + k4 * (toS - from.sy),
  };
}

/**
 * One hand card's cycle state (card object 0x8e0750), advanced once per frame in the order of the hand
 * update 0x8dc37c -> 0x8e1408:
 *  - deal(D, delay): 0x8e0a80 (entry duration D, armed +0x31e) and 0x8e0aa8 (t = -delay), called only by
 *    the HUD setup 0x8da088 (D = 0.375 s, delay 0.6 + 0.18 i).
 *  - played(): a placement from this slot succeeded (release 0x8e2c04 -> 0x8e1fb8 -> 0xbe1634 ->
 *    0x8d5438 -> 0x8e2868): hide timer +0x29c = 3 s. The card returns to its slot (0x8e1004) but stays
 *    invisible.
 *  - update(dt, card): `card` is the slot's deck index in the logic hand (0xf9dd98, -1 = empty). On a
 *    change (0x8e0b84, before the timers): an armed card that showed a card restarts its entry (t = -0,
 *    with the deal sound +0x31f on the first shown frame; empty -> card keeps the running t), a selected
 *    card is deselected (+0x319 = 0, raise timer +0x320 = 0) and the hide timer is cleared. Then, only
 *    while it holds a card, t += dt while t < D (the raise timer is held at 0.24 once t >= 0); the hide
 *    timer counts down; visible (+0x8) = holds a card and the hide timer has run out (<= 0); the
 *    selection raise advances only after the entry (t >= D, raise timer < 0.24) and not while dragged.
 */
export class HandCard {
  card = -1; // +0x260 card reference (deck index)
  t = 0; // +0x350
  dur = 0; // +0x354
  armed = false; // +0x31e
  hideT = 0; // +0x29c
  visible = false; // +0x8
  selected = false; // +0x319
  raiseT = 1; // +0x320
  /** elixir wait after a release (+0x324, s): see dropWaits / dropWaitStep */
  waitT = 0;

  deal(dur: number, delay: number): void {
    this.dur = dur;
    this.t = -delay;
    this.armed = true;
  }

  played(): void {
    this.hideT = 3;
  }

  /**
   * Returns true when the slot's card changed this frame (selection dropped). `dragging`: the card is
   * held by the pointer (+0x318), which pauses the selection raise.
   */
  update(dt: number, card: number, dragging = false): boolean {
    let changed = false;
    if (card !== this.card) {
      changed = true;
      if (this.armed && this.card !== -1) this.t = -0;
      if (this.selected) { this.selected = false; this.raiseT = 0; }
      this.hideT = 0;
      this.card = card;
    }
    const has = card !== -1;
    if (has && this.t < this.dur) {
      this.t += dt;
      if (this.t >= 0) this.raiseT = 0.24;
    }
    let visible = has;
    if (this.hideT > 0) {
      this.hideT -= dt;
      if (this.hideT > 0) visible = false;
    }
    this.visible = visible;
    if (!dragging && this.t >= this.dur && this.raiseT < 0.24) this.raiseT += dt;
    return changed;
  }

  /** Select / deselect (the tap toggle and drag start): the raise animation restarts. */
  select(on: boolean): void {
    if (this.selected !== on) { this.selected = on; this.raiseT = 0; }
  }
}

/**
 * Next card state from the hand timer (player +0x208, ms) in the hand update 0x8dc37c: the next card is
 * drawn in grayscale (vt+0xd0 -> 0x123c580) and HUD_player's NextSpellTimer shows (timer + 999) / 1000
 * seconds while the timer runs; both go away at 0.
 */
export function nextCardTimer(timerMs: number): { gray: boolean; text: string | null } {
  if (timerMs <= 0) return { gray: false, text: null };
  return { gray: true, text: String(Math.floor((timerMs + 999) / 1000)) };
}

// -- releasing a card before it is affordable ------------------------------------------------------

const f32 = Math.fround;

/**
 * Client global MAX_SPELL_PENDING_TIME (client_globals.csv: 1200 ms); its loader 0xdf3394 stores
 * value · 0.001 as a float at client globals +0x1b8, read only by 0x8e2c04 and 0x8e2d50.
 */
export const MAX_SPELL_PENDING_TIME_S = f32(1200 * f32(0.001));

/**
 * 0x8e2d50: will the card be affordable within MAX_SPELL_PENDING_TIME − 0.1 s? `hundredths` is the
 * available elixir in 1/100 (0xfa1d10: min(elixir − pending, MAX_MANA) / 100, 0 below 1), `msPerElixir`
 * 0xfa3e28 = the timeline's full-bar time (0xd448b0) / MAX_MANA, integer. With w = (int)((T − 0.1) · 1000)
 * in float (1100), the elixir gained meanwhile is (w · 100) / msPerElixir (integer division).
 */
export function affordableSoon(hundredths: number, cost: number, msPerElixir: number, pendingS = MAX_SPELL_PENDING_TIME_S): boolean {
  let h = hundredths;
  const t = f32(pendingS + f32(-0.1));
  if (t > 0 && msPerElixir !== 0) h += Math.trunc((Math.trunc(f32(t * 1000)) * 100) / msPerElixir);
  return cost * 100 <= h;
}

/**
 * The hand card's touch end 0x8e2c04 decides between releasing now (0x8e29f4 -> 0x8e1fb8 -> the play
 * submit 0xbe1634) and waiting for the elixir: it waits (timer +0x324 = MAX_SPELL_PENDING_TIME, the card
 * stays in drag mode with its drag preview, after 0x8d112c has flushed any other card's wait) when the
 * time is > 0, the card is not affordable now (+0x31a, set by the last 0x8e1408 from the HUD's elixir:
 * cost · 100 <= hundredths), it will be within the time (0x8e2d50), and the drop is not in the own back
 * rows (0xbe1500: logic y past Globals +0x1c8 rows from the own edge, the same line where the dragged
 * card's visual finishes shrinking in 0x8e1fb8; or a tutorial gate).
 */
export function dropWaits(affordableNow: boolean, soon: boolean, inBackRows: boolean, pendingS = MAX_SPELL_PENDING_TIME_S): boolean {
  return pendingS > 0 && !affordableNow && soon && !inBackRows;
}

/**
 * One frame of a waiting card (0x8e1408, after the drag update): t = max(0, t − dt); when it reaches 0
 * or the card is affordable this frame (+0x31a), t = 0 and the card is released at its touch-end point
 * (+0x328: 0x8e29f4 -> 0x8e1fb8(0, card, 1) -> 0xbe1634, whose command 0xcc4658 the logic validates
 * with the play check 0xd77504), then returned to its slot by 0x8e1004(success). Nothing happens while
 * t <= 0.
 */
export function dropWaitStep(t: number, dt: number, affordable: boolean): { t: number; release: boolean } {
  if (!(t > 0)) return { t, release: false };
  const n = Math.max(0, f32(t - dt));
  if (n === 0 || affordable) return { t: 0, release: true };
  return { t: n, release: false };
}

/**
 * A released play's leftover preview (0xbe1aa8 builds it from the drag preview: the ghost characters,
 * the radius ring, the card's indicator clips and the spell_placement_text name; not the footprint) is
 * dropped when its cast arrives (0xbe5b4c), and at the latest once it has lived this long: 0x8dd4cc adds
 * the battle screen's frame dt to +0x78 and removes it at 3 s (0x8dd2a0, then 0x8dd174 next frame).
 */
export const PENDING_GHOST_S = 3;

// -- full-elixir hand wiggle ----------------------------------------------------------------------

/**
 * Named rows of the build's card tables in file order (csv_logic/spells_characters.csv,
 * spells_buildings.csv, spells_other.csv; rows with an empty Name continue the previous row and get no
 * instance). A card's LogicData global ID (+0x40, 0xe0b624) is table class · 1000000 + this index
 * (0xfdb6fc: id % 1000000; Knight 26000000, Wizard 26000017, Cannon 27000000, Fireball 28000000).
 */
const SPELL_TABLE_ROWS = [
  'Knight|Archer|Goblins|Giant|Pekka|Minions|Balloon|Witch|Barbarians|Golem|Skeletons|Valkyrie|SkeletonArmy|Bomber|' +
  'Musketeer|BabyDragon|Prince|Wizard|MiniPekka|SpearGoblins|GiantSkeleton|HogRider|MinionHorde|IceWizard|RoyalGiant|' +
  'SkeletonWarriors|Princess|DarkPrince|ThreeMusketeers|LavaHound|IceSpirits|FireSpirits|Miner|ZapMachine|Bowler|' +
  'RageBarbarian|BattleRam|InfernoDragon|IceGolemite|MegaMinion|BlowdartGoblin|GoblinGang|ElectroWizard|AngryBarbarians|' +
  'Hunter|AxeMan|Assassin|RoyalRecruits|DarkWitch|Bats|Ghost|RamRider|MiniSparkys|Rascals|MovingCannon|MegaKnight|' +
  'SkeletonBalloon|DartBarrell|Wallbreakers|RoyalHogs|GoblinGiant|Fisherman|EliteArcher|ElectroDragon|Firecracker|' +
  'MightyMiner|SuperWitch|ElixirGolem|BattleHealer|SkeletonKing|SuperLavaHound|SuperEliteArcher|ArcherQueen|' +
  'SuperHogRider|GoldenKnight|SuperIceGolemite|CHAR_DISABLED_1|Monk|SuperArcher|RoyalRecruits_Chess|SkeletonDragons|' +
  'SuperHogRiderTerry|SuperMiniPekka|WitchMother|ElectroSpirit|ElectroGiant|PrinceBuff|Phoenix|CHAR_DISABLED_3|' +
  'CHAR_DISABLED_4|CHAR_DISABLED_5|CHAR_DISABLED_6|CHAR_DISABLED_7|LittlePrince|TriWizards|GoblinDemolisher|' +
  'GoblinMachine|SuspiciousBush|SuperKnight|Goblinstein|SkeletonWarriors_SpookyChess|GiantBuffer|Berserker|BossBandit|' +
  'MergeMaiden_Normal|MergeMaiden_Mounted|Ronin|MinionGiant',
  'Cannon|GoblinHut|Mortar|InfernoTower|BombTower|BarbarianHut|Tesla|Elixir Collector|Xbow|Tombstone|FirespiritHut|' +
  'BarbarianLauncher|GoblinCage|GoblinDrill|GoblinPartyHut|DarkElixir_Bottle|ElixirBarrel|GoblinRocketSilo',
  'Fireball|Arrows|Rage|Rocket|GoblinBarrel|Freeze|Mirror|Lightning|Zap|Poison|Graveyard|Log|Tornado|Clone|Earthquake|' +
  'BarbLog|Heal|Snowball|RoyalDelivery|GlobalClone|GoblinPartyRocket|WarmSpell|GlobalLightning|DarkMagic|GoblinCurse|' +
  'MergeMaiden|Vines',
];
let spellRowIndex: Map<string, number> | null = null;

/** Instance part of a card's global ID (its row among the named rows of its table), or 0 if unknown. */
export function spellInstanceId(card: string): number {
  if (!spellRowIndex) {
    spellRowIndex = new Map();
    for (const t of SPELL_TABLE_ROWS) t.split('|').forEach((n, i) => { if (!spellRowIndex!.has(n)) spellRowIndex!.set(n, i); });
  }
  return spellRowIndex.get(card) ?? 0;
}

/** Rotation and scale of a display object's matrix (0x123e8b4): angle in degrees. */
export function rotScale(deg: number, sx: number, sy: number): [number, number, number, number] {
  const r = f32(f32(deg) * f32(0.017453292));
  const c = f32(Math.cos(r)), s = f32(Math.sin(r));
  return [c * sx, s * sy, -(sx * s), c * sy];
}

interface WiggleEntry { key: number; slot: number; sx: number; sy: number; end: number }

/**
 * The battle HUD's wiggle list (HUD +0x280, constructed by 0x907230 with its clock +0x20 = 0). Each frame
 * the hand update 0x8dc37c, for slots 0..3 before that slot's card update 0x8e1408, removes the slot's
 * card (0x9077f0: matrix back to rotation 0 at its stored scale) when the slot is empty or the available
 * elixir (0xfa1d10, hundredths) is below MAX_MANA · 100, and otherwise adds it (0x907654(card scale +0x2c4,
 * the same, list, card, its SpellData, -1): appended only if the card is not in the list, end time 0 =
 * never; a non-negative index i would end it at clock + 0.112199746 i). After the four slots 0x907ab0
 * runs once: clock += dt, and every entry's matrix becomes rotation(sin(clock · 28 + (id % 10000) · 123) ·
 * 0.45°) · scale(sx, sy) (0x123e8b4), id = the SpellData global ID; entries past their end are removed and
 * reset to rotation 0. The card update writes the card's scale before that (vt+0x30 and the entry's
 * vt+0x38 / vt+0x40), so a listed card shows the stored scale. The entry keeps the card data it was added
 * with until it is removed.
 */
export class HandWiggle {
  clock = 0; // +0x20
  private entries: WiggleEntry[] = []; // +0x08..+0x18, 32-byte records {data, card, sx, sy, end}
  /** angle (degrees) of each listed slot after the last update */
  private angles = new Map<number, number>();

  add(slot: number, sx: number, sy: number, key: number, index = -1): void {
    if (this.entries.some((e) => e.slot === slot)) return;
    const end = index > -1 ? f32(this.clock + f32(index * f32(0.112199746))) : 0;
    this.entries.push({ key, slot, sx, sy, end });
  }

  remove(slot: number): void {
    const i = this.entries.findIndex((e) => e.slot === slot);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.angles.delete(slot);
  }

  update(dt: number): void {
    this.clock = f32(this.clock + dt);
    for (let i = 0; i < this.entries.length;) {
      const e = this.entries[i];
      const a = f32(f32(Math.sin(f32(f32(this.clock * 28) + (e.key % 10000) * 123))) * f32(0.45));
      this.angles.set(e.slot, a);
      if (e.end > 0 && e.end < this.clock) {
        this.entries.splice(i, 1);
        this.angles.delete(e.slot);
        continue;
      }
      i++;
    }
  }

  /** The slot's wiggle (angle in degrees and the stored scale), or null when it is not listed. */
  of(slot: number): { deg: number; sx: number; sy: number } | null {
    const e = this.entries.find((q) => q.slot === slot);
    if (!e) return null;
    return { deg: this.angles.get(slot) ?? 0, sx: e.sx, sy: e.sy };
  }

  reset(): void {
    this.clock = 0;
    this.entries = [];
    this.angles.clear();
  }
}

// -- radial fill (card mask) -----------------------------------------------------------------------

/**
 * RadialFill (vtable 0x1895218): the client's card mask `card_mask_normal` / `_legendary` / `_champion`
 * built from the clip's first shape command (ctor 0x89f9b4: at least 3 vertices). The bounding box of
 * its vertices (x, y and u, v) gives 8 rim points counter-clockwise from the top middle: top middle,
 * top left, left middle, bottom left, bottom middle, bottom right, right middle, top right, plus the
 * centre. With fill f in 0..1 (0x89fd04 clamps) the draw (0x89fd24) emits nothing when
 * k = trunc(8 f) > 7, else a triangle strip  S, C, P[k+1], C, ..., P[8 mod 8], C  with
 * S = lerp(P[k], P[k+1], clamp(8 f - k, 0, 1)): the part not yet filled, the filled sector growing
 * counter-clockwise from 12 o'clock. Returns [x, y, u, v] * n (shape space) or null.
 */
export function radialFillStrip(verts: ArrayLike<number>, count: number, fill: number): Float32Array | null {
  if (count < 3) return null;
  let x0 = Infinity, y0 = Infinity, u0 = Infinity, v0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = verts[i * 4], y = verts[i * 4 + 1], u = verts[i * 4 + 2], v = verts[i * 4 + 3];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const mx = x1 + (x0 - x1) * 0.5, my = y0 + (y1 - y0) * 0.5;
  const mu = u1 + (u0 - u1) * 0.5, mv = v0 + (v1 - v0) * 0.5;
  const P: number[][] = [
    [mx, y0, mu, v0], [x0, y0, u0, v0], [x0, my, u0, mv], [x0, y1, u0, v1],
    [mx, y1, mu, v1], [x1, y1, u1, v1], [x1, my, u1, mv], [x1, y0, u1, v0],
  ];
  const C = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (u0 + u1) * 0.5, (v0 + v1) * 0.5];
  const f = Math.max(0, Math.min(1, fill));
  const k = Math.trunc(f * 8);
  if (k > 7) return null;
  const t = Math.max(0, Math.min(1, (f - k * 0.125) * 8));
  const a = P[k], b = P[(k + 1) & 7];
  const out = new Float32Array((18 - 2 * k) * 4);
  let o = 0;
  const put = (q: ArrayLike<number>) => { out[o++] = q[0]; out[o++] = q[1]; out[o++] = q[2]; out[o++] = q[3]; };
  put([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
  put(C);
  for (let i = 0; k + i + 1 <= 8; i++) {
    put(P[(k + i + 1) & 7]);
    put(C);
  }
  return out;
}

// -- HUD clock, HUD_topRight fade, hand panel slide ----------------------------------------------

/** What battleClock reads of the battle (core Battle fields). */
export interface ClockBattle {
  tick: number;
  regulationTicks: number;
  overtimeTicks: number;
  /** the timeline entered its overtime section (Battle.overtime, 0xd56738) */
  overtime: boolean;
  result: { tick: number } | null;
}

/**
 * The clock of the HUD time update 0x8d38c4: the timeline's section (0xd56738: overtime only once
 * 0xd33f74 let it advance there with equal crowns) and its seconds left, ceil(max(0, len − elapsed) /
 * 1000) (0xd566d8). The battle tick 0xd33f74, and with it the timeline (0xd56070), keeps running after
 * the end until EndScreenDelay (the battle manager stops it at 0xd3581c), so after the end the clock counts
 * `ticksSinceEnd` ticks past the end tick (whether or not the engine steps its post-end world,
 * BattleConfig.postEnd); a section that ran out stays at 0.
 */
export function battleClock(b: ClockBattle, ticksSinceEnd = 0): { ot: boolean; msLeft: number; secs: number } {
  const ot = b.overtime;
  const elapsed = b.result ? b.result.tick + 1 + Math.max(0, ticksSinceEnd) : b.tick;
  const end = ot ? b.regulationTicks + b.overtimeTicks : b.regulationTicks;
  const msLeft = Math.max(0, (end - elapsed) * 50);
  return { ot, msLeft, secs: Math.floor((msLeft + 999) / 1000) };
}

/**
 * The battle ticks the battle manager still runs after the end: the end tick sets the ms since the end
 * (+0x198) to 1 (0xd3e360), each later battle tick adds 50 (0xd33f74), and 0x10ca9a0 stops ticking once
 * 0xd3581c finds it at EndScreenDelay; the timeline, and the HUD clock with it (0x8d38c4), stops there
 * (80 ticks for 4000 ms), while the result screen shows.
 */
export function postEndTicks(endScreenDelay: number): number {
  return Math.max(0, Math.ceil((endScreenDelay - 1) / 50));
}

/**
 * HUD_topRight's alpha byte in the HUD update 0x8d1e6c: byte / 255 − 2 dt while battle input is blocked
 * (battle screen 0xbe4400: the intro before its actionFrame, the result screen, or the battle over), else
 * byte / 255 + 4 dt, stored by 0x123cbc0 as (int)(clamp(a, 0, 1) · 255). The setup 0x8cf3b8 starts it at
 * 0. HUD_topRight_overtime (+0x158) has no fade.
 */
export function topRightFade(byte: number, dt: number, blocked: boolean): number {
  const a = blocked ? f32(f32(byte * f32(1 / 255)) - f32(dt + dt)) : f32(f32(dt * 4) + f32(byte * f32(1 / 255)));
  if (a < 0) return 0;
  return Math.trunc(f32((a > 1 ? 1 : a) * 255));
}

/**
 * HUD_player's slide (0x8db8e0). The panel is shown (+0xea) unless battle input is blocked (0xbe4400 /
 * 0xbe42e0 / 0xbe42f0) or the HUD is hidden (+0x29c); t (+0x21c, 0 at the setup 0x8da088) moves by
 * speed (+0x274 = 4, 0x8d9d30) · dt toward 1 when shown and 0 when not, clamped. The panel clip's y is
 * u²(3 − 2u) · dist with u = 1 − t (dist = vt+0x68: the panel's bounds height at setup, negative for a
 * top panel) and its alpha 1 while t > 0, else 0. The hand update 0x8dc37c runs its per-card part (card
 * updates, wiggle entries, next card, NextSpellTimer) only while t >= 0.4 and shown; otherwise only the
 * wiggle list advances. The first time t reaches 0.3 (+0xeb) the panel plays a sound (not played here).
 */
export class HandPanelSlide {
  t = 0; // +0x21c
  shown = false; // +0xea
  speed = 4; // +0x274

  update(dt: number, shown: boolean): void {
    this.shown = shown;
    const v = f32(this.t + f32(this.speed * (shown ? dt : -dt)));
    this.t = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** the panel clip's y offset for a slide distance */
  offset(dist: number): number {
    const u = f32(1 - this.t);
    return f32(f32(f32(u * u) * dist) * f32(3 - f32(u + u)));
  }

  get visible(): boolean { return this.t > 0; }

  /** 0x8dc37c's gate for the per-card hand update */
  get handLive(): boolean { return this.t >= 0.4 && this.shown; }
}

/**
 * The popup manager's default floater point 0x88ca58 (used by battle screen vt+0x230 0xbe8910): stage
 * size minus the safe-area insets (none here), times (0.5, 0.3), floored.
 */
export function defaultFloaterPos(stageW: number, stageH: number): [number, number] {
  return [Math.floor(f32(Math.trunc(stageW) * 0.5)), Math.floor(f32(Math.trunc(stageH) * f32(0.3)))];
}
