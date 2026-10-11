// Character view animation, ported from the client (libg 160402020):
//   FUN_00840d44  character view update: action choice, direction hold, frame per action
//   FUN_00844f78  view angle from the actor facing          FUN_00f81d0c  integer atan2 (degrees)
//   FUN_0084a7f8  direction clip + mirror for a view angle  FUN_0084a9cc  attack frame vs the hit
//   FUN_00835fd0  action slots: 0 _run1_, 1 _idle1_, 2 _attack1_, 3 _charge1_, 4 _run1_/_jump1_, 5 _deploy1_
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
}

export function newAnimState(): AnimState {
  return { angle: -1, hold: 0, rot: 0, sign: 1, action: -1, actionStart: 0, stepToggle: 0, stopped: false,
    finishing: false, finishClock: 0 };
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
}

export interface AnimFrame {
  export: string;
  frame: number;
  mirror: boolean;
  /** action slot (0 run, 1 idle, 2 attack, 3 charge, 4 jump) */
  action: number;
  key: string;
}

function slotArt(art: CharacterArt, team: 0 | 1, slot: number): [string, ActionArt] | null {
  const acts = (team === 1 && art.actionsRed) ? art.actionsRed : art.actions;
  if (!acts) return null;
  const key = slot === 0 ? 'run1' : slot === 1 ? 'idle1' : slot === 2 ? 'attack1' : slot === 3 ? 'charge1'
    : slot === 4 ? (art.jumpEnabled && acts.jump1 ? 'jump1' : 'run1') : slot === 5 ? 'deploy1' : '';
  const a = acts[key];
  return a && a.dirs > 0 ? [key, a] : null;
}

function labelFrame(a: ActionArt, name: string): number {
  for (const [f, lb] of Object.entries(a.labels ?? {})) if (lb === name) return Number(f);
  return -1;
}

/** One frame of FUN_00840d44 for a direction-clip character (anim-set path). */
export function animate(art: CharacterArt, team: 0 | 1, s: AnimState, i: AnimInput): AnimFrame | null {
  const dt = i.dt;
  // displayed angle: changes at most every 0.5 s
  const want = viewAngle(i.dirX, i.dirY, i.flip);
  let shown = s.angle;
  let hold = s.hold - dt;
  if (hold <= 0 && want !== shown) { shown = want; hold = 0.5; }
  s.hold = hold;

  // action slot (state -> slot), with the clip-exists fallbacks of the native
  let slot = 1;
  let st = i.state;
  // TryToFinishAttackAnimation: after the attack state ends, keep playing the swing on a view clock
  // continued from the last shown attack time until the clip comes back to frame 0
  if (st < 2 && (s.action === 2 || s.finishing) && art.tryToFinishAttackAnimation) {
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

  if (slot === 2) {
    const clipMs = t((a.frames * 1000) / a.fps);
    const af = a.actionFrame ?? labelFrame(a, 'action_frame1');
    let time = i.atk;
    if (s.finishing) {
      s.finishClock += dt * 1000;
      time = t(s.finishClock);
    } else {
      if (i.atkPrev !== i.atk) time = t(i.atkPrev + i.alpha * (i.atk - i.atkPrev));
      s.finishClock = time;
    }
    const extra = i.finish > 0 ? t(i.alpha * 50) + i.finish : 0;
    if (af >= 0) {
      const f = attackFrame(!!art.animationsKeepLastFrame, false, art.hitSpeed ?? 1000, time, a.frames, clipMs, af, extra);
      frame = f.frame;
      if (s.finishing && f.frame === 0) s.finishing = false;
    }
  } else if (slot === 0 || slot === 3 || slot === 4) {
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
  return { export: `${a.export}_${dir.idx + 1}`, frame, mirror: dir.sign < 0, action: slot, key };
}
