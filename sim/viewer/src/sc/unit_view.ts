// Character view decisions ported from libg 160402020 (visual only; nothing feeds back into the engine).
//
// Health bar (per frame 0x83c268, clips built by 0x836e58 → 0x83f7a8):
//   The view makes two clips from the actor's health_bars.csv row: +0x460 the NoDamage export
//   (NoDamagePlayerExportName for the viewer's own actors, NoDamageEnemyExportName otherwise; the level
//   badge) and +0x468 the normal bar (PlayerExportName / EnemyExportName); both stop on their last frame,
//   with `buff` and `ammo` hidden and chef_upgrade / chef_upgrade_shield / downgrade / downgrade_shield
//   stopped on their last frame and hidden (0x83f7a8). The bar container +0x618 starts on +0x460.
//   Each frame (0x83c268), with hp / max = the shield and max shield while the shield lasts (health
//   +0x2c / +0x30, 0xf85644 / 0xf856b8), else the hitpoints (max < 2 counts as 1):
//     shieldUp  = shield > 0 || ShowAsShield                         (bVar4)
//     shieldBar = max shield > 0 || ShowAsShield                     (bVar8)
//     always    = own ? ShowOwnAlways : ShowEnemyAlways              (bVar9; replay/spectate modes 3/4: true)
//     lifeBar   = ManaGenerateLimit > 0 || LifeTime > 0 || GrowTime > 0 (bVar1, a non-ghost view)
//     show = (shieldBar && !shieldUp) || always || hp != max || lifeBar   (+ level boost, KingTower3,
//            actor +0x78 == 100 and a debug flag, none of which the engine has)
//   hidden in states 6 (spawn pathfind), 7 (ingame pathfind), 11 (summon delay) or when not alive, and
//   for attached characters (actor +0x180). The container swaps to +0x468 for good the first frame
//   (shieldBar && !shieldUp) || hp != max || lifeBar holds. The `bar` child (of +0x468, frames n)
//   stops on clamp(n − 1 − ⌊hp·99 / max⌋, 0, n − 1). When shieldBar, the current clip's `base` child
//   shows its `shield_champion` and `shield` children while shieldUp (else `level` when it has no
//   `shield`); `prestige` is hidden. A cloned (actor +0x172) building fills from its lifetime instead
//   (health +0x3c · max(n − 1, 99) / LifeTime); the engine has no clones.
//
// Summon reveal (0xd423bc → view vt+0x138 0x846b2c, per frame 0x840d44):
//   0xd423bc calls vt+0x138 on each summoned character's view (none for SpawnPathfindSpeed > 0, which
//   gets vt+0x168): without SummonCharacterSecond and with the first character's DeployTime T > 0, the
//   delay is (DeployDelay₀ · i / SummonNumber) mod T; with a SummonCharacterSecond it is
//   D · a′ / 360 with D = SummonDeployDelay (if ≥ 1) else DeployDelay₀, a = the native angle of the
//   member's formation offset and a′ = 360 − a for the bottom team, a for the top (C division).
//   0x846b2c acts only in state 4 (deploying): a UseAnimator character stores the delay (+0xa28), sets
//   its container alpha to SPELL_DRAG_OBJECT_ALPHA / 100 (client_globals: 50 → byte 127) and makes the
//   deploy filter clip (+0xb08); otherwise it plays SpawnEffect at once (vt+0xc0) and makes the filter.
//   A member that waits out SummonDeployDelay (state 11) is skipped; leaving state 11 for 4 calls
//   vt+0x138(0) (0xf7f2c8 / 0xf800bc). While in state 11 the view is hidden (0x839b08 +0xad5: sprite,
//   shadow +0x338 and attached clips) and so is its health bar (0x83c268).
//   Each frame in state 4, once the deploy elapsed time 0xf8519c (DeployTime − timer +0x15c, clamped
//   to 0..DeployTime, a logic value) reaches the delay while the alpha still differs from its target
//   (0x83c0ac: 1 for these) by more than 0.01, 0x840d44 plays SpawnEffect (vt+0xc0, scale 1; not for a
//   SpawnEffectOnce character other than summon index 0, nor a clone), starts the deploy filter
//   (+0x4c0 = +0xb08, time 0) and restores the alpha.

import { nativeAngle } from './anim.ts';

/** health_bars.csv flags the bar logic reads (manifest hud.healthBars). */
export interface HealthBarFlags {
  showOwnAlways?: boolean;
  showEnemyAlways?: boolean;
  showAsShield?: boolean;
}

export interface BarInput {
  /** the actor belongs to the viewing player (0x84ddcc) */
  own: boolean;
  flags: HealthBarFlags;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  /** data LifeTime (ManaGenerateLimit and GrowTime: no row in this build sets them) */
  lifeTime: number;
  /** states 6 / 7 / 11, dead, or attached to another actor: no bar */
  hidden: boolean;
  /** the container already shows the damaged clip (+0x468) */
  swapped: boolean;
}

export interface BarState {
  visible: boolean;
  /** container on +0x468 after this frame (sticky) */
  swapped: boolean;
  /** values the fill uses: the shield while it lasts */
  hp: number;
  max: number;
  /** bVar8: the shield children of `base` are driven */
  shieldBar: boolean;
  /** bVar4: `shield` / `shield_champion` shown */
  shieldUp: boolean;
}

/** One frame of the health bar logic of 0x83c268 for a troop or building view. */
export function healthBarState(i: BarInput): BarState {
  const shielded = i.shield > 0;
  const hp = shielded ? i.shield : i.hp;
  let max = shielded ? i.maxShield : i.maxHp;
  if (max < 2) max = 1;
  const shieldUp = shielded || !!i.flags.showAsShield;
  const shieldBar = i.maxShield >= 1 || !!i.flags.showAsShield;
  const always = i.own ? !!i.flags.showOwnAlways : !!i.flags.showEnemyAlways;
  const lifeBar = i.lifeTime > 0;
  const damaged = (shieldBar && !shieldUp) || hp !== max || lifeBar;
  const show = damaged || always;
  if (!show || i.hidden) return { visible: false, swapped: i.swapped, hp, max, shieldBar, shieldUp };
  return { visible: true, swapped: i.swapped || damaged, hp, max, shieldBar, shieldUp };
}

/** `bar` frame (0x83c268): clamp(n − 1 − ⌊hp·99 / max⌋, 0, n − 1); frame 0 is full. */
export function barFrame(hp: number, max: number, frames: number): number {
  const top = frames - 1;
  const v = top - (max !== 0 ? Math.trunc((hp * 99) / max) : 0);
  if (v < 1) return 0;
  return v >= top ? top : v;
}

export interface SummonDelayInput {
  /** summon index i (0-based over the whole summon, actor +0x194) */
  index: number;
  /** SummonNumber (0xd423bc param 6, loaded as max(v, 1)) */
  number: number;
  /** the spell has a SummonCharacterSecond (spell +0xb0) */
  hasSecond: boolean;
  /** SummonDeployDelay (spell +0x140) */
  spellDeployDelay: number;
  /** the first character's DeployDelay (+0x5ac), DeployTime (+0x490, 0xde0bd8) and SpawnPathfindSpeed (+0x580) */
  deployDelay0: number;
  deployTime0: number;
  spawnPathfind0: number;
  /** the member's formation offset (0xd42ce0 / 0xe7e8f8, before the deploy-zone clamp) */
  offset: [number, number];
  /** logic team (0 = the bottom side) */
  team: number;
}

/** The delay 0xd423bc passes to view vt+0x138, or null when it does not call it. */
export function summonViewDelay(i: SummonDelayInput): number | null {
  if (i.spawnPathfind0 !== 0) return null;
  if (!i.hasSecond) {
    if (i.deployTime0 <= 0) return null;
    const d = i.number !== 0 ? Math.trunc((i.deployDelay0 * i.index) / i.number) : 0;
    return d - Math.trunc(d / i.deployTime0) * i.deployTime0;
  }
  const a = nativeAngle(i.offset[0], i.offset[1]);
  const ang = i.team === 0 ? 360 - a : a;
  const d = i.spellDeployDelay >= 1 ? i.spellDeployDelay : i.deployDelay0;
  return Math.trunc((d * ang) / 360);
}

/** Container alpha 0x846b2c sets while a UseAnimator view waits: SPELL_DRAG_OBJECT_ALPHA 50 · 0.01 → byte (0x123cbc0). */
export const SUMMON_WAIT_ALPHA = Math.trunc(Math.fround(50 * Math.fround(0.01)) * 255) / 255;

/** Deploy elapsed time 0xf8519c: DeployTime − the deploy timer, clamped to 0..DeployTime. */
export function deployElapsed(deployTime: number, timer: number): number {
  const e = deployTime - timer;
  return e > 0 ? (e < deployTime ? e : deployTime) : 0;
}

// Client-action health bar (csv_client/healthbars.toml; view 0x8405c4 -> component 0x853574):
//   A character whose OnStartingClientActions name ClientActionAddHealthBarPart actions (directly or via
//   ClientActionGroup) gets a "HealthBar" component (ContainerName, 0x83ef30 -> ctor 0x852e80: base
//   position (NewHealthBarOffsetX + NewHealthBarOffsetXBlue / Red for own / enemy, 0), a root sprite in
//   the view's bar holder +0x2f8 at the old bar's anchor, 0x84f740); each action adds a part (0x8645dc):
//   Badge (0x8530e0, at frame 0, its snappoint_for_hp_bar hidden), Bar (0x853204, inserted behind,
//   `bar` at frame 0) or Segmenter, with Conditions / ExcludeConditions as bit masks (0xf739b4: Shield 1,
//   LevelUp 2, LevelDown 4, ActiveChampion 8, Underground 16, Invincible 32) and (OffsetX, OffsetY).
//   With such a component 0x83c268 draws no classic bar and calls 0x8405c4 instead (HideHealthbar only
//   gates the classic one, 0x836e58).

export const BAR_COND: Record<string, number> = { Shield: 1, LevelUp: 2, LevelDown: 4, ActiveChampion: 8, Underground: 16, Invincible: 32 };

/** 0xf739b4: a Conditions / ExcludeConditions list as a bit mask (unknown names add nothing). */
export function condMask(names: readonly string[] | undefined): number {
  let m = 0;
  for (const n of names ?? []) m |= BAR_COND[n.trim()] ?? 0;
  return m;
}

export interface BarPartRef { cond: number; excl: number }

/**
 * Part choice of 0x853574: the first part not excluded ((excl & flags) == 0) whose conditions equal the
 * flags, else the not-excluded part with the most matching bits (popcount(flags & cond), 0x853f58),
 * the earliest on a tie; -1 when every part is excluded.
 */
export function pickPart(parts: readonly BarPartRef[], flags: number): number {
  let best = -1, score = -1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if ((p.excl & flags) !== 0) continue;
    if (p.cond === flags) return i;
    let v = flags & p.cond, c = 0;
    while (v) { c += v & 1; v >>>= 1; }
    if (c > score) { score = c; best = i; }
  }
  return best;
}

/** View fields 0x8405c4 / the component keep between frames. */
export interface NewBarView {
  /** +0x614: the shield seen last (-1 before the first frame) */
  shieldSeen: number;
  /** +0x610: damaged once */
  damaged: boolean;
  /** component +0x38 / +0x3c (badges), +0x40 (bar), +0x44 (level), +0x34 (last frame's flags) */
  prevBadge: number;
  badge: number;
  bar: number;
  level: number;
  flags: number;
}

export function newBarView(): NewBarView {
  return { shieldSeen: -1, damaged: false, prevBadge: -1, badge: -1, bar: -1, level: -1, flags: 0 };
}

export interface NewBarInput {
  own: boolean;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  /** level boost (actor +0x1f8: Chef), active champion (view +0xc84), Underground (actor vt+0x100), Invincible (TAG_NO_DAMAGE) */
  boost: number;
  champion: boolean;
  underground: boolean;
  invincible: boolean;
}

export interface NewBarFrame {
  /** +0x48: badges shown; +0x49: the bar shown */
  show: boolean;
  bar: boolean;
  flags: number;
  /** fill percentages 0x8405c4 passes on: hp·100/max (at least 1), shield·100/max (at least 1 while > 0) */
  hpPct: number;
  shieldPct: number;
}

/**
 * One frame of 0x8405c4: damaged (sticky +0x610) once hp != max or the shield differs from the one seen
 * last (with a max shield); the badges show for an enemy, a level-boosted or champion actor (bVar9) or
 * once damaged, the bar once damaged. (The special-mode gate 0xde09f4 / 0xd34864 and actor +0x171,
 * which hide both, and the ghost views of +0x278 do not occur here.)
 */
export function newBarFrame(v: NewBarView, i: NewBarInput): NewBarFrame {
  let dmg = false;
  if (v.shieldSeen < 0) v.shieldSeen = i.shield;
  else if (i.maxShield >= 1 && i.shield !== v.shieldSeen) { dmg = true; v.shieldSeen = i.shield; }
  if (i.hp !== i.maxHp || v.damaged) dmg = true;
  if (dmg) v.damaged = true;
  const always = i.boost !== 0 || !i.own || i.champion;
  let hpPct = i.maxHp !== 0 ? Math.trunc((i.hp * 100) / i.maxHp) : 0;
  if (hpPct < 2) hpPct = 1;
  let shieldPct = 0;
  if (i.maxShield >= 1) {
    const p = Math.trunc((i.shield * 100) / i.maxShield);
    const lo = i.shield > 0 ? 1 : 0;
    shieldPct = p >= lo ? p : lo;
  }
  const flags = (i.boost > 0 ? 2 : 0) | (i.boost < 0 ? 4 : 0) | (i.shield > 0 ? 1 : 0) | (i.champion ? 8 : 0)
    | (i.underground ? 16 : 0) | (i.invincible ? 32 : 0);
  return { show: dmg || always, bar: dmg, flags, hpPct, shieldPct };
}

export interface NewBarChoice {
  badge: number;
  bar: number;
  /** the badge changed (stops on its last frame) / plays its intro (HasIntroAnim, 0..last once) */
  badgeChanged: boolean;
  intro: boolean;
}

/** The part choice and badge state of 0x853574 for this frame's flags and level (updates `v`). */
export function newBarChoose(v: NewBarView, badges: readonly (BarPartRef & { intro?: boolean })[],
  bars: readonly BarPartRef[], flags: number, level: number): NewBarChoice {
  const levelChanged = v.level >= 0 && v.level !== level;
  const oldLevel = v.level;
  v.level = level;
  const b = badges.length ? pickPart(badges, flags) : -1;
  let changed = false, intro = false;
  if (b === v.badge) {
    intro = b >= 0 && levelChanged;
  } else {
    const before = v.prevBadge;
    v.prevBadge = v.badge;
    v.badge = b;
    changed = before !== b;
    if (b >= 0) {
      intro = levelChanged;
      if (changed && (oldLevel < 0 || oldLevel === level)) {
        intro = !!badges[b].intro && ((v.flags & 1) === 0 || (flags & 1) !== 0);
      }
    }
  }
  const bar = bars.length ? pickPart(bars, flags) : -1;
  v.bar = bar;
  v.flags = flags;
  return { badge: b, bar, badgeChanged: changed, intro };
}
