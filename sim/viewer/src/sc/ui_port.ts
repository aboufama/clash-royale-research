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
//   ElixirBar            HUD_player elixir bar state (0x8da088 setup, 0x8dbebc update, bar 0x8b2368)
//   cardSlot             hand card placement in cardArea (0x8da088)
//   radialFillStrip      RadialFill card mask while a card is unaffordable (ctor 0x89f9b4, draw 0x89fd24)
//   elixirRequirement    selected card's cost on the elixir bar (0x8dbebc, elixirRequirementBar)

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
 */
export class ElixirBar {
  last = 0; // +0x260
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
    if (whole - this.last !== 0) {
      this.last = whole;
      this.timer = 0.255;
      this.tipAt = Math.max(0, Math.min(1, whole / max));
    }
  }
}

// -- hand ------------------------------------------------------------------------------------------

/**
 * Card slot i (0..3) in HUD_player's cardArea rect [x0, y0, x1, y1] (0x8da088): x = x0 + W * (i / 4 +
 * 0.125), y = the rect's middle, scale = rect height / card height.
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
