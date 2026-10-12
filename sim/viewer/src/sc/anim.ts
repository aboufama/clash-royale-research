// Character view animation, ported from the client (libg 160402020):
//   FUN_00840d44  character view update: action choice, direction hold, frame per action
//   FUN_00844f78  view angle from the actor facing          FUN_00f81d0c  integer atan2 (degrees)
//   FUN_0084a7f8  direction clip + mirror for a view angle  FUN_0084a9cc  attack frame vs the hit
//   FUN_00835fd0  action slots: 0 _run1_, 1 _idle1_, 2 _attack1_, 3 _charge1_, 4 _run1_/_jump1_, 5 _deploy1_
//   FUN_00836e58 / FUN_00840d44 first branch: buildings drawn from one labelled clip (no anim set)
//   MovieClip 0x123ee08 (ctor), 0x123f55c (advance), 0x123f458 (goto), 0x1241f50 / 0x1242234
// The engine supplies the logic state (facing vector, attack timer, walk clock, charge); everything
// here is view-side and never feeds back into the simulation.

import type { ActionArt, CharacterArt } from './manifest.ts';

/** atan(i / 128) in whole degrees, i = 0..128 (table at 0x3432d8). */
const ATAN_DEG = [
  0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10, 11, 11, 11, 12, 12, 13, 13, 14, 14, 14,
  15, 15, 16, 16, 17, 17, 17, 18, 18, 19, 19, 19, 20, 20, 21, 21, 21, 22, 22, 22, 23, 23, 24, 24, 24, 25, 25, 25, 26,
  26, 27, 27, 27, 28, 28, 28, 29, 29, 29, 30, 30, 30, 31, 31, 31, 32, 32, 32, 33, 33, 33, 34, 34, 34, 35, 35, 35, 35,
  36, 36, 36, 37, 37, 37, 37, 38, 38, 38, 39, 39, 39, 39, 40, 40, 40, 40, 41, 41, 41, 41, 42, 42, 42, 42, 43, 43, 43,
  43, 44, 44, 44, 44, 45, 45, 45,
];

const t = Math.trunc;
/** -0.05 as the float32 constant 0xbd4ccccd (0x8444ac) */
const F32_M005 = Math.fround(-0.05);

/** FUN_00f81d0c: facing vector -> degrees 0..359 (0 = +x, 90 = +y), integer math. */
export function nativeAngle(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  if (x > 0 && y >= 0) return x <= y ? 90 - ATAN_DEG[t((x << 7) / y)] : ATAN_DEG[t((y << 7) / x)];
  const ax = Math.abs(x);
  if (x < 1 && y > 0) return y <= ax ? 180 - ATAN_DEG[t((y << 7) / ax)] : ATAN_DEG[t((ax << 7) / y)] + 90;
  const ay = Math.abs(y);
  if (x >= 0 || y > 0) {
    if (ay <= ax) {
      if (x === 0) return 0;
      let v = 360 - ATAN_DEG[t((ay << 7) / ax)];
      if (v > 359) v = -ATAN_DEG[t((ay << 7) / ax)];
      return v < 0 ? v + 360 : v;
    }
    return ATAN_DEG[t((ax << 7) / ay)] + 270;
  }
  if (ay < ax) return ATAN_DEG[t((ay << 7) / ax)] + 180;
  if (y !== 0) return 270 - ATAN_DEG[t((ax << 7) / ay)];
  return 0;
}

/** FUN_00844f78: view angle (0 = screen up, clockwise) for the blue player's flipped view or not. */
export function viewAngle(dx: number, dy: number, flip: boolean): number {
  return ((flip ? 270 : 90) + nativeAngle(dx, dy)) % 360;
}

/**
 * FUN_0084a7f8: N authored directions span 180 degrees; the circle is cut into 2N sectors by
 * floor(2N * a / 360). Sectors 0 / 2N-1 show direction 0 (away) and N-1 / N the last one (toward
 * the camera), both keeping the previous mirror sign; the left half mirrors directions 1..N-2.
 */
export function pickDirectionNative(a: number, n: number, lastSign: number): { idx: number; sign: number } {
  if (n < 2) return { idx: 0, sign: 1 };
  const n2 = n * 2;
  let k = t((n2 * (a % 360)) / 360);
  k -= t(k / n2) * n2;
  if (k === n || k === n - 1) return { idx: n - 1, sign: lastSign };
  if (k === 0 || k === n2 - 1) return { idx: 0, sign: lastSign };
  if (k < n) return { idx: k, sign: 1 };
  return { idx: n + ~(k - t(k / n) * n), sign: -1 };
}

/**
 * FUN_0084a9cc: frame of an attack clip so that its action_frame lands on the hit. `time` is the
 * attack timer (ms, crossing multiples of hitSpeed at hits), `extra` the finish timer. The wind-up
 * (frames 0..actionFrame) lasts min(hitSpeed, clipMs) * actionFrame / frames ms and ends on the hit;
 * the follow-through continues at the same rate, then frame 0 (or the last frame) is held.
 */
export function attackFrame(keepLast: boolean, seqMode: boolean, hitSpeed: number, time: number, frames: number,
  clipMs: number, actionFrame: number, extra: number): { frame: number; done: boolean } {
  let tt = t(extra + time);
  const cyc = hitSpeed !== 0 ? t(tt / hitSpeed) : 0;
  const len = Math.min(clipMs, hitSpeed);
  let wind = frames !== 0 ? t((len * actionFrame) / frames) : 0;
  if (wind < 2) wind = 1;
  const start = hitSpeed - wind;
  let frame: number;
  let done = false;
  if (cyc === 0) {
    if (tt < start) frame = 0;
    else { frame = t(((tt - start) * actionFrame) / wind); done = true; }
  } else if (seqMode) {
    frame = t(((tt - start) * actionFrame) / wind);
  } else {
    tt -= cyc * hitSpeed;
    if (tt < len - wind) frame = t((tt * actionFrame) / wind) + actionFrame;
    else if (tt < start) frame = keepLast ? frames - 1 : 0;
    else { frame = t(((tt - start) * actionFrame) / wind); done = true; }
  }
  if (extra > 0) done = false;
  return { frame, done };
}

/** Per-unit view state the client keeps between frames. */
export interface AnimState {
  /** displayed view angle (view +0x4d0/0x9a), -1 before the first frame */
  angle: number;
  /** direction hold timer, seconds (view +0xa08 / param_3[0x141]) */
  hold: number;
  /** rotating angle for RotateAngleSpeed characters (view +0xa20) */
  rot: number;
  /** last mirror sign used by the action entry (+0x2c), kept by the front/back directions */
  sign: number;
  /** current action slot and the global time it started (view +0x4d4 / +0xa88) */
  action: number;
  actionStart: number;
  /** stop-and-go walking: half-cycle toggle (+0xa0c) and last stopped flag (+0xa14) */
  stepToggle: number;
  stopped: boolean;
  /** TryToFinishAttackAnimation: view-side attack clock (+0xa94) while finishing */
  finishing: boolean;
  finishClock: number;
  /** facing angle recorded at the first path search and its 0.3 s hold (view +0x4e0 / +0x4e4, 0x845bb0) */
  walkAngle: number;
  walkHold: number;
  /** seconds spent in the jump state 5 (view +0xa2c, float), JumpEnabled characters only */
  jumpT: number;
  /** last frame's swing flag (view +0xa15): the attack clip was in its wind-up toward the action frame */
  swing: boolean;
  /** the attack's time step of the last attacking frame (view +0xa98, 0xfc94bc(attack, 50)): the finish clock's rate */
  scale: number;
}

export function newAnimState(): AnimState {
  return { angle: -1, hold: 0, rot: 0, sign: 1, action: -1, actionStart: 0, stepToggle: 0, stopped: false,
    finishing: false, finishClock: 0, walkAngle: -1, walkHold: 0, jumpT: 0, swing: false, scale: 50 };
}

/** Logic inputs for one character view frame (native names in brackets). */
export interface AnimInput {
  /** actor state [0xf817a8]: 0 idle, 1 moving, 2 attacking, 4 deploying, 5 jumping */
  state: number;
  /** facing vector [actor +0xf8/+0xfc] */
  dirX: number;
  dirY: number;
  /** actor id [actor +8] (walk-cycle phase) */
  id: number;
  /** has a movement component and can walk (Speed > 0) */
  walker: boolean;
  /** charge progress [movement +0x1e0] (charge clip at >= 10000) */
  charge: number;
  /** walk clock ms [movement +0x1f0] and its tick-start snapshot [+0x210] */
  walk: number;
  walkPrev: number;
  /** attack timer ms [attack +0x24] and its tick-start snapshot [+0x34], finish timer [+0x50] */
  atk: number;
  atkPrev: number;
  finish: number;
  /** interpolation fraction between ticks, seconds since the last view frame, global anim clock (s) */
  alpha: number;
  dt: number;
  clock: number;
  flip: boolean;
  /** HitSpeed of the actor whose attack timer drives the swing (default: the character's data) */
  hitSpeed?: number;
  /**
   * The buff time scale of a 50 ms step (Buff_timeScale 0xfc27b8 / 0xfc94bc(attack, 50); the engine's
   * attack clock step): 50 unbuffed, 0 frozen or stunned. Default 50.
   */
  scale?: number;
  /** facing vector at the unit's path search this frame, if any (engine 'path' event, view vt+0x178) */
  pathFacing?: [number, number];
  /**
   * Jump state only: steps left to the landing (0xfce8b8: distance from the actor to the landing cell
   * of the path (movement +0x3c[0]) × 500, ÷ the move speed vtb8 = JumpSpeed); undefined when the
   * move speed is below 1 (no landing cap).
   */
  jumpLeft?: number;
}

export interface AnimFrame {
  export: string;
  frame: number;
  mirror: boolean;
  /** action slot (0 run, 1 idle, 2 attack, 3 charge, 4 jump) */
  action: number;
  key: string;
  /**
   * The swing flag rose this frame (0x840d44: the attack frame's wind-up flag of 0x84a9cc, set while
   * the clip runs from the wind-up start to its action frame, against view +0xa15): the view plays
   * AttackStartEffect (0x83e524 -> vt+0xc0)
   */
  attackStart?: boolean;
}

function slotArt(art: CharacterArt, team: 0 | 1, slot: number): [string, ActionArt] | null {
  const acts = (team === 1 && art.actionsRed) ? art.actionsRed : art.actions;
  if (!acts) return null;
  const key = slot === 0 ? 'run1' : slot === 1 ? 'idle1' : slot === 2 ? 'attack1' : slot === 3 ? 'charge1'
    : slot === 4 ? (art.jumpEnabled && acts.jump1 ? 'jump1' : 'run1') : slot === 5 ? 'deploy1' : '';
  const a = acts[key];
  return a && a.dirs > 0 ? [key, a] : null;
}

/**
 * A drag-preview ghost's sprite (0x8e4eb4): the preview actor faces the enemy King (Actor_faceActor
 * 0xf84d04: facing = King - position, Vec_setLength 0x1294d74 to 256) and its view is updated with
 * dt 0 (vt+0x208(0, 1)), so it shows the idle action's first frame in the direction picked from that
 * facing like any character view (0x844f78 -> 0x84a7f8, mirror sign starting at +1).
 */
export function ghostSprite(art: CharacterArt, team: 0 | 1, dirX: number, dirY: number, flip: boolean):
  { export: string; frame: number; mirror: boolean } | null {
  const r = slotArt(art, team, 1);
  if (!r) return null;
  const a = r[1];
  const dir = pickDirectionNative(viewAngle(dirX, dirY, flip), a.dirs, 1);
  return { export: `${a.export}_${dir.idx + 1}`, frame: 0, mirror: dir.sign < 0 };
}

/**
 * Gallery helper (sc-test.ts only; not a client path): the `key` action clip (run1, idle1, attack1...) of a
 * character facing (dx, dy), direction from the client's pick (0x844f78 -> 0x84a7f8, mirror sign starting
 * at +1), frame ⌊ms · fps / 1000⌋ looped. `dir` = the authored direction index (1-based).
 */
export function gallerySprite(art: CharacterArt, team: 0 | 1, key: string, dx: number, dy: number, flip: boolean, ms: number):
  { export: string; frame: number; mirror: boolean; dir: number } | null {
  const acts = (team === 1 && art.actionsRed) ? art.actionsRed : art.actions;
  const a = acts?.[key];
  if (!a || a.dirs < 1) return null;
  const d = pickDirectionNative(viewAngle(dx, dy, flip), a.dirs, 1);
  const frame = a.frames > 0 ? t((Math.max(0, ms) * a.fps) / 1000) % a.frames : 0;
  return { export: `${a.export}_${d.idx + 1}`, frame, mirror: d.sign < 0, dir: d.idx + 1 };
}

/**
 * Vec_setLength 0x1294d74: |v|^2 (0x7fffffff when a component is outside ±0xb504 or the sum overflows),
 * n = Math_isqrt of it; when n != 0 each component becomes v * len / n, truncated toward zero.
 */
export function vecSetLength(x: number, y: number, len: number): [number, number] {
  const inRange = (v: number) => v >= -0xb504 && v <= 0xb504;
  let d2 = 0x7fffffff;
  if (inRange(x) && inRange(y)) d2 = Math.min(x * x + y * y, 0x7fffffff);
  let n = Math.floor(Math.sqrt(d2));
  if (n * n > d2) n--;
  else if ((n + 1) * (n + 1) <= d2) n++;
  if (n === 0) return [x, y];
  return [Math.trunc((x * len) / n), Math.trunc((y * len) / n)];
}

/** Frame of a label, -1 if absent; a repeated label gives its last frame (lookup 0x123f3c0 searches from the end). */
function labelFrame(a: ActionArt, name: string): number {
  let r = -1;
  for (const [f, lb] of Object.entries(a.labels ?? {})) if (lb === name) r = Number(f);
  return r;
}

/** One frame of FUN_00840d44 for a direction-clip character (anim-set path). */
export function animate(art: CharacterArt, team: 0 | 1, s: AnimState, i: AnimInput): AnimFrame | null {
  const dt = i.dt;
  // 0x845bb0: the first path search records the facing and holds it 0.3 s (the record is never
  // cleared, so only the first counts)
  if (i.pathFacing && s.walkAngle === -1) { s.walkAngle = nativeAngle(i.pathFacing[0], i.pathFacing[1]); s.walkHold = 0.3; }
  // 0x844f78: while walking within the hold, a facing at most 89 degrees off the recorded one shows the record
  let fa = nativeAngle(i.dirX, i.dirY);
  if (s.walkAngle !== -1 && i.state === 1) {
    let d = (s.walkAngle - fa) % 360;
    if (d < 0) d += 360;
    if (d >= 180) d -= 360;
    if (!(s.walkHold <= 0 || Math.abs(d) > 89)) fa = s.walkAngle;
  }
  // displayed angle: changes at most every 0.5 s
  const want = ((i.flip ? 270 : 90) + fa) % 360;
  if (s.walkHold > 0) s.walkHold -= dt; // view update 0x839b08
  // view +0xa2c (0x840d44, before the action choice): time in state 5 for JumpEnabled characters
  // (not custom dummy objects, view +0x278), float seconds, 0 in any other state
  if (art.jumpEnabled) s.jumpT = i.state === 5 ? Math.fround(s.jumpT + dt) : 0;
  let shown = s.angle;
  let hold = s.hold - dt;
  if (hold <= 0 && want !== shown) { shown = want; hold = 0.5; }
  s.hold = hold;

  // action slot (state -> slot), with the clip-exists fallbacks of the native
  let slot = 1;
  let st = i.state;
  // TryToFinishAttackAnimation: after the attack state ends, keep playing the swing on a view clock
  // continued from the last shown attack time until the clip comes back to frame 0; only while the buff
  // time scale is above 0 (0x840d44 @0x840e24: no buff component or Buff_timeScale(buff, 50) > 0), so a
  // frozen or stunned unit stops finishing
  const scale = i.scale ?? 50;
  if (st < 2 && (s.action === 2 || s.finishing) && art.tryToFinishAttackAnimation && scale > 0) {
    s.finishing = true;
    st = 2;
  } else {
    s.finishing = false;
  }
  if (st === 4) slot = slotArt(art, team, 5) ? 5 : 1;
  else if (st === 2) slot = slotArt(art, team, 2) ? 2 : 1;
  else if (st === 5) slot = slotArt(art, team, 4) ? 4 : 0;
  else if (st === 1) {
    if (!i.walker) { slot = 1; if (s.angle !== -1) shown = s.angle; } else if (i.charge >= 10000 && slotArt(art, team, 3)) slot = 3;
    else slot = 0;
  }
  let r = slotArt(art, team, slot);
  if (!r) { slot = 1; r = slotArt(art, team, 1); }
  if (!r) { slot = 0; r = slotArt(art, team, 0); }
  if (!r) return null;
  const [key, a] = r;

  // RotateAngleSpeed: the shown angle turns toward the facing at that many degrees per second
  let ang = shown;
  if (art.rotateAngleSpeed) {
    let cur = s.angle === -1 ? shown : s.rot;
    let d = ((((shown - cur) % 360) + 360) % 360);
    if (d > 180) d -= 360;
    const sgn = d > 0 ? 1 : d < 0 ? -1 : 0;
    const next = cur + sgn * art.rotateAngleSpeed * dt;
    let d2 = ((((shown - next) % 360) + 360) % 360);
    if (d2 > 180) d2 -= 360;
    cur = (d2 === 0 || Math.sign(d2) === sgn) ? next : shown;
    cur = ((cur % 360) + 360) % 360;
    s.rot = cur;
    ang = t(cur);
  }
  s.angle = shown;

  const dir = pickDirectionNative(ang, a.dirs, s.sign);
  s.sign = dir.sign;
  if (slot !== s.action) { s.actionStart = i.clock; }
  s.action = slot;
  const frameDur = 1 / a.fps;
  let frame = t(i.clock / frameDur);
  let swing = false;

  if (slot === 2) {
    const clipMs = t((a.frames * 1000) / a.fps);
    const af = a.actionFrame ?? labelFrame(a, 'action_frame1');
    let time = i.atk;
    if (s.finishing) {
      // +0xa94 += dt · (+0xa98 · 20): the step of the last attacking frame (stored @0x842850), float32 (0x840d44 @0x8418fc)
      s.finishClock = Math.fround(s.finishClock + Math.fround(dt * Math.fround(s.scale * 20)));
      time = t(s.finishClock);
    } else {
      if (i.atkPrev !== i.atk) time = t(i.atkPrev + i.alpha * (i.atk - i.atkPrev));
      s.finishClock = time;
      s.scale = scale;
    }
    const extra = i.finish > 0 ? t(i.alpha * 50) + i.finish : 0;
    if (af >= 0) {
      const f = attackFrame(!!art.animationsKeepLastFrame, false, i.hitSpeed ?? art.hitSpeed ?? 1000, time, a.frames, clipMs, af, extra);
      frame = f.frame;
      swing = f.done;
      if (s.finishing && f.frame === 0) s.finishing = false;
    }
  } else if (slot === 4) {
    // the jump action (id 4: the slot holds _jump1_, or _run1_ without one, 0x835fd0) at 0x84440c:
    // f = (int)(t / fd) on the jump timer, fd = the clip's frame time 1/fps (clip +0x8c, 0x123f218),
    // capped at max((int)(N − left·0.05 / fd), N / 2) so the clip's second half ends at the landing
    // (float32 arithmetic as in the client)
    const fd = Math.fround(1 / a.fps);
    frame = t(Math.fround(s.jumpT / fd));
    if (i.jumpLeft !== undefined) {
      const back = Math.fround(Math.fround(Math.fround(i.jumpLeft) * F32_M005) / fd);
      let cap = t(Math.fround(a.frames + back));
      const half = t(a.frames / 2);
      if (cap <= half) cap = half;
      if (cap <= frame) frame = cap;
    }
  } else if (slot === 0 || slot === 3) {
    const walk = i.walkPrev + i.alpha * (i.walk - i.walkPrev);
    const sma = art.stopMovementAfterMS ?? 0;
    if (sma < 1) {
      const sec = walk * ((art.walkingSpeedTweakPercentage ?? 0) + 100) * 1.0000001e-5;
      frame = ((i.id * 2) % 1000000) + t(sec / frameDur);
    } else {
      const f1 = labelFrame(a, 'action_frame1'), f2 = labelFrame(a, 'action_frame2');
      const stopped = sma > 0 && i.walk !== sma && sma <= i.walk;
      if (s.stopped !== stopped) {
        if (!stopped) s.stepToggle ^= 1;
        s.stopped = stopped;
      }
      if (f1 !== -1) {
        if (!art.dontStopMoveAnim) {
          let lo = f1, hi = f2;
          if (s.stepToggle === 1) { lo = f2; hi = a.frames + f1; }
          frame = hi;
          if (!stopped) {
            frame = lo + t((walk * (hi - lo)) / sma + 0.5);
            if (hi <= frame) frame = hi;
          }
        } else {
          const cyc = (art.waitMS ?? 0) + sma;
          let ext = t((cyc * (f2 - f1)) / sma) - (f2 - f1);
          let lo = f1, hi = f2;
          if (s.stepToggle === 1) {
            lo = ext + f2;
            hi = a.frames + f1;
            ext = t(((hi - lo) * cyc) / sma) - (hi - lo);
          }
          hi += ext;
          frame = lo + t((walk * (hi - lo)) / cyc + 0.5);
          if (hi <= frame) frame = hi;
        }
      }
    }
  }
  frame %= a.frames;
  if (frame < 0) frame += a.frames;
  const attackStart = swing && !s.swing;
  s.swing = swing;
  return { export: `${a.export}_${dir.idx + 1}`, frame, mirror: dir.sign < 0, action: slot, key, attackStart };
}

/**
 * FUN_008455cc turret (HasRotationOnTimeline buildings: King tower, Cannon, X-Bow): the `turret`
 * child's frame and mirror for view angle `a` over its n frames, and the TurretMovement recoil
 * offset k = TM / (TM * s + 1) px along the aim, s = seconds since the last attack (view +0x330,
 * reset by the attack callback 0x846ab4).
 */
export function turretPose(a: number, n: number, turretMovement: number, sinceAttackS: number): {
  frame: number; sign: number; ox: number; oy: number;
} {
  const q = n * 4 - 4;
  const u = t((q * a) / 360);
  const right = u <= q >> 1 || n * 4 - 5 <= u;
  const v = right ? u : q + ~u;
  let frame = (v + 1) >> 1;
  if (n <= frame) frame = 0;
  const k = turretMovement / (turretMovement * sinceAttackS + 1);
  const rad = a * 0.017453294;
  return { frame, sign: right ? 1 : -1, ox: -(Math.sin(rad) * k), oy: k * Math.cos(rad) };
}

/**
 * SC MovieClip playback as the client steps it, once per rendered frame. A new clip plays from frame 0
 * (ctor 0x123ee08). Advance 0x123f55c: once the accumulated time reaches the frame duration (1/fps)
 * the clip moves exactly one frame (the whole multiple of the duration is consumed), wrapping inside a
 * looped range or over the whole clip; time accumulates only while playing. Goto 0x123f458: reaching
 * the end of an unlooped range stops. playRange 0x1241f50, gotoAndStop 0x1242234.
 */
export class ClipPlayer {
  frame = 0;
  playing = true;
  private start = 0;
  private end = -1;
  private loop = false;
  private acc = 0;
  readonly frames: number;
  readonly fps: number;
  constructor(frames: number, fps: number) {
    this.frames = frames;
    this.fps = fps;
  }

  private goto(f: number): void {
    if (this.end === f && !this.loop && this.playing) { this.acc = 0; this.playing = false; }
    this.frame = f;
  }

  gotoAndStop(f: number): void {
    this.start = f;
    this.end = -1;
    this.loop = false;
    if (f >= 0 && f < this.frames) this.goto(f);
    else if (f === -1 && !this.playing) return;
    this.acc = 0;
    this.playing = false;
  }

  playRange(a: number, b: number, loop: boolean): void {
    this.start = a;
    this.end = b;
    this.loop = loop && a < b && b !== -1;
    if (a >= 0 && a < this.frames) this.goto(a);
    if (a === b) {
      if (!this.playing) return;
      this.playing = false;
    } else {
      if (this.playing) return;
      this.playing = true;
    }
    this.acc = 0;
  }

  /** One rendered frame, `dt` seconds after the previous one. */
  advance(dt: number): void {
    if (!(dt > 0)) return;
    const dur = 1 / this.fps;
    if (dur <= this.acc) {
      this.acc -= t(this.acc / dur) * dur;
      let next = this.frame + 1;
      if (this.loop) {
        const span = this.end - this.start + 1;
        next = (span !== 0 ? (next - this.start) % span : next - this.start) + this.start;
      }
      this.goto(this.frames !== 0 ? next % this.frames : next);
    }
    if (this.playing) this.acc += dt;
  }
}

/** Logic inputs for a building drawn from one labelled clip. */
export interface BuildingInput {
  /** native actor state: 4 deploying, 2 attacking */
  state: number;
  /** deploy time left, ms [actor +0x15c], and DeployTime */
  deployLeft: number;
  deployTime: number;
  /** hide timer [actor +0x138] (HidesWhenNotAttacking) */
  hideT: number;
  /** collector generate timer [actor +0x130] */
  manaT: number;
  /** an elixir collection happened since the last view frame (view vt+0x130) */
  collected: boolean;
  /** seconds since the last view frame */
  dt: number;
}

/** (int)((float)a * (float)b / (float)c), the client's float scaling of timeline frames. */
function fscale(a: number, b: number, c: number): number {
  return t(Math.fround(Math.fround(Math.fround(a) * Math.fround(b)) / Math.fround(c)));
}

export interface BuildingAnim {
  clip: ClipPlayer;
  /** collector pump playing after a collection (view +0x9b7) */
  pumping: boolean;
}

/**
 * Building views without an anim set, ported from the view setup 0x836e58 and the first branch of
 * FUN_00840d44. Setup: an `attack` label is shown stopped, a deploy_start/deploy_end pair stops on
 * deploy_start, other non-hiding non-collector clips play spawn_start..spawn_end when present. Each
 * frame: while deploying (with the deploy pair) the frame is deploy_start + (deploy_end − deploy_start)
 * · elapsed / DeployTime (0xf8519c); hiders show |hide timer| on hide_start..hide_end over HideTimeMs,
 * then appear_start..appear_end over UpTimeMs; the Elixir Collector holds action_frame · timer /
 * ManaGenerateTimeMs and plays action_frame to the end on each collection (0x84692c); other clips
 * play idle_start..idle_end once stopped. Turret buildings (HasRotationOnTimeline) use turretPose.
 * Spawner clips with an action_frame (synced to the spawn timer) do not occur in this build.
 */
export function newBuildingAnim(art: CharacterArt, labels: Record<string, number>, frames: number, fps: number): BuildingAnim {
  const c = new ClipPlayer(frames, fps);
  const L = (n: string): number => labels[n] ?? -1;
  if (L('attack') >= 0) c.gotoAndStop(L('attack'));
  if (L('deploy_start') >= 0 && L('deploy_end') >= 0) c.gotoAndStop(L('deploy_start'));
  if (!art.hidesWhenNotAttacking && !(art.manaGenerateTimeMs && art.manaGenerateTimeMs > 0)) {
    const a = L('spawn_start'), b = L('spawn_end');
    if (a >= 0 && L('attack') <= b) c.playRange(a, b, false);
  }
  return { clip: c, pumping: false };
}

export function animateBuilding(art: CharacterArt, name: string, labels: Record<string, number>, s: BuildingAnim, i: BuildingInput): number {
  const c = s.clip;
  const L = (n: string): number => labels[n] ?? -1;
  const af = L('action_frame');
  const collector = !!art.manaGenerateTimeMs && art.manaGenerateTimeMs > 0;
  if (i.collected && collector && af >= 0 && c.frames > 0) {
    s.pumping = true;
    c.playRange(af, c.frames - 1, false);
  }
  let idle = false;
  const ds = L('deploy_start'), de = L('deploy_end');
  if (i.state === 4 && ds >= 0 && de >= 0) {
    const dtm = i.deployTime;
    let el = dtm - i.deployLeft;
    if (dtm <= el) el = dtm;
    if (el < 1) el = 0;
    c.gotoAndStop(ds + fscale(de - ds, el, dtm));
  } else if (art.hidesWhenNotAttacking) {
    const v = Math.abs(i.hideT);
    const hide = art.hideTimeMs ?? 0;
    let a: number, span: number, num: number, den: number;
    if (hide < v) { a = L('appear_start'); span = L('appear_end') - a; num = v - hide; den = art.upTimeMs ?? 0; }
    else { a = L('hide_start'); span = L('hide_end') - a; num = v; den = hide; }
    c.gotoAndStop(a + fscale(num, span, den));
  } else if (collector) {
    if (!s.pumping) c.gotoAndStop(fscale(af, i.manaT, art.manaGenerateTimeMs!));
    if (!c.playing) s.pumping = false;
  } else {
    idle = true;
  }
  if (idle && (name === 'RageBottle' || !c.playing)) {
    const a = L('idle_start'), b = L('idle_end');
    if (a >= 0 && b >= 0) c.playRange(a, b, false);
  }
  c.advance(i.dt);
  return c.frame;
}
