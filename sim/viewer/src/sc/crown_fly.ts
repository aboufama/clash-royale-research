// Crown flight of the battle HUD (libg 160402020): when a crown tower falls, a star rises at the tower
// and flies to the crown counter of HUD_rightMiddle, and the counter only counts it once it lands.
//
//   0x8d0dd8  (from the battle screen setup 0xbde180 -> 0x8d0d08) builds one flight per crown tower:
//             logic team 0's King (0xd35d5c), its Princess towers (0xd3c460), then team 1's, each with
//             0x8d5804: a tower of the HUD player's side gives the enemy a crown (star_appear_enemy, to
//             crowns_red/starEnemy, +0xb1 = 0), any other tower the player (star_appear, to
//             crowns_blue/starPlayer, +0xb1 = 1). The flight object 0x8dd754 (0xb8 bytes, vtable
//             0x18993c0) is added to the HUD as a child and a 24-byte record 0x8dda9c {flight, tower
//             id, team, tower x / y} goes into HUD +0x1d0. The clip comes from sc/effects.sc
//             (0x1a5e908), set stopped (+0x4d = 2); +0x80 = its "startMove" frame (0x123f3c0), +0x84 =
//             its frame count, +0x8c = frame time * frame count; hidden.
//   0x8d2de0  the HUD crown update (from the HUD update 0x8d1e6c) runs 0x8ddb58 for every record, then
//             0x8dd90c for every flight, counting the flights still shown per side; a flight that
//             landed this frame (0x8dda74) plays its target star clip 0..n-1 once (0x1241f50). The
//             counters show crowns (0xfa4038) minus the flights of that side still in the air
//             (scoreEnemy +0x190, scorePlayer +0x198 via 0x126f2d8). The crown-score prints of the same
//             update take the full crown counts (sc/announce.ts ScorePrint).
//   0x8ddb58  a record whose flight is neither flying (0x8dda84) nor done (0x8dda64) and whose tower is
//             gone (0x8ddc70) starts it (0x8dd8f0) at the tower's position projected to the stage
//             (0x8583bc, whole stage px) and taken into the HUD's space (0x123c788).
//   0x8ddc70  outside 2v2: the tower is gone when its team's King is dead (King vt+0x138 false: all of
//             that team's crowns fly) or when it is neither that King nor in the team's Princess list.
//   0x8dd90c  see CrownFly.update.
//   0x8d1e6c  HUD_rightMiddle (+0x160) alpha: see CrownPanelFade.

const f32 = Math.fround;
const INV255 = f32(0.003921569);

/** The flight clip's timing: frame count (+0x84), frame rate and its "startMove" frame (+0x80). */
export interface FlyClip { frames: number; fps: number; startMove: number }

/**
 * One crown flight (0x8dd754). start() is 0x8dd8f0, update() 0x8dd90c; flying 0x8dda84, done 0x8dda64,
 * takeLanded 0x8dda74. Times are float32 like the client's.
 */
export class CrownFly {
  /** +0xb1: the flight goes to the HUD player's counter (crowns_blue/starPlayer) */
  readonly player: boolean;
  readonly n: number; // +0x84
  readonly startMove: number; // +0x80
  readonly total: number; // +0x8c
  t = 0; // +0x88
  moveT = 0; // +0x90
  active = false; // +0xb0
  visible = false; // +8 (hidden by the constructor)
  frame = 0; // the clip's stopped frame (0x1242234)
  private landed = false; // +0xb2
  private sx = 0; // +0xa8
  private sy = 0; // +0xac
  x = 0;
  y = 0;

  constructor(player: boolean, clip: FlyClip) {
    this.player = player;
    this.n = clip.frames;
    this.startMove = clip.startMove;
    this.total = f32(f32(1 / (clip.fps || 30)) * this.n);
  }

  /** 0x8dd8f0: t = 0, active, move timer 0, start position = the projected tower position. */
  start(x: number, y: number): void {
    this.t = 0;
    this.active = true;
    this.moveT = 0;
    this.sx = x;
    this.sy = y;
  }

  /**
   * 0x8dd90c, `target` = the target star's origin in the HUD's space (0x123c724 on +0xa0): while active,
   * t += dt (the crown sound plays on the first update, not here); landed (+0xb2) = t crossed total;
   * frame = (int)(t * n / total) clamped to 0..n-1, shown stopped; once that frame reaches startMove the
   * move timer runs, k = min(1, moveT * n / (total * (n - startMove))), position = start + k (target -
   * start) (vt+0x28 0x123c548, not rounded); visible while t < total.
   */
  update(dt: number, target: readonly [number, number]): void {
    if (!this.active) return;
    const old = this.t;
    const t = f32(old + dt);
    this.t = t;
    this.landed = this.total <= t && old < this.total;
    const raw = Math.trunc(f32(f32(t * this.n) / this.total));
    this.frame = raw < 0 ? 0 : raw >= this.n ? this.n - 1 : raw;
    if (this.startMove <= this.frame) this.moveT = f32(this.moveT + dt);
    let k = f32(f32(this.moveT * this.n) / f32(this.total * (this.n - this.startMove)));
    if (!(k <= 1)) k = 1;
    this.x = f32(this.sx + f32(k * f32(target[0] - this.sx)));
    this.y = f32(this.sy + f32(k * f32(target[1] - this.sy)));
    this.visible = t < this.total;
  }

  /** 0x8dda84 */
  get flying(): boolean { return this.t < this.total && this.active; }

  /** 0x8dda64 */
  get done(): boolean { return this.total <= this.t; }

  /** 0x8dda74: the landed flag, cleared. */
  takeLanded(): boolean {
    const l = this.landed;
    this.landed = false;
    return l;
  }
}

/**
 * 0x8ddc70 outside 2v2: is the record's tower gone? `kingAlive` = its team's King vt+0x138; the tower
 * is that King, or `alive` tells whether it is still in the team's Princess list.
 */
export function crownTowerGone(kingAlive: boolean, isKing: boolean, alive: boolean): boolean {
  if (!kingAlive) return true;
  if (isKing) return false;
  return !alive;
}

/**
 * HUD_rightMiddle's alpha in the HUD update 0x8d1e6c, before the crown update 0x8d2de0 (so with the
 * flights' state of the previous frame). HUD init 0x8cd4ec sets its alpha to 0 (0x123cbc0), so the
 * crown counter is hidden until a crown flies:
 *   - no flight flying and the battle over (battle screen 0xbe4400): hold (+0x410) = -dt, fade out;
 *   - no flight flying (and not a special mode 0xd36084, battle type 4 0xbdfa58 or the never-written
 *     byte 0x1a47ed8): hold -= dt, fade out once it is <= 0, else fade in;
 *   - otherwise (a flight flying): hold = 1 s, fade in.
 * Fade in: alpha = byte / 255 + 4 dt, fade out: byte / 255 - 2 dt, stored by 0x123cbc0 as the byte
 * (int)(clamp(alpha, 0, 1) * 255).
 */
export class CrownPanelFade {
  alphaByte = 0; // HUD_rightMiddle +0xc
  hold = 0; // HUD +0x410

  update(dt: number, flying: boolean, battleOver: boolean, special = false): void {
    let fadeIn: boolean;
    if (!flying && battleOver) {
      this.hold = f32(0 - dt);
      fadeIn = this.hold > 0;
    } else if (!flying && !special) {
      this.hold = f32(this.hold - dt);
      fadeIn = this.hold > 0;
    } else {
      this.hold = 1;
      fadeIn = true;
    }
    const a = fadeIn ? f32(f32(this.alphaByte * INV255) + f32(dt * 4)) : f32(f32(this.alphaByte * INV255) - f32(dt + dt));
    this.alphaByte = alphaByte(a);
  }

  get alpha(): number { return this.alphaByte / 255; }
}

/** DisplayObject alpha setter 0x123cbc0: byte = (int)(min(a, 1) * 255), 0 for a < 0. */
export function alphaByte(a: number): number {
  if (a < 0) return 0;
  return Math.trunc(f32((a > 1 ? 1 : a) * 255));
}
