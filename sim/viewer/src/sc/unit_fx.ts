// Character view footstep effects (libg 160402020, FUN_00840d44): the end of the walk branch, after the
// frame of a run (action 0) or charge (action 3) clip has been chosen from the walk clock, for a view whose
// actor has a movement component. Only the sprite pass (the first of the two passes; the second, the
// shadow, has bVar6 false) plays effects. The CharacterData fields are MoveEffect (+0x318, 0xde0afc; the
// action-10 getter 0xde0b04 reads the same field), LoopMoveEffect, FlyingHeight (+0x334, 0xde0580).
//
// - Without LoopMoveEffect (every supported character): f1 / f2 = the clip's action_frame1 /
//   action_frame2 label frames (vt+0xf8, -1 when absent). When at least one exists ((f1 & f2) != -1) and
//   the frame differs from prev, the frame this action showed at the view's last update (view +0x4ec +
//   action * 8, written for every action at the end of each update, 0x84407c), k walks from prev up to
//   (not including) the new frame, wrapping at the clip length; at the first k equal to f1 or f2 the
//   MoveEffect plays once (0x82dc54: one-shot, no parent) at the actor's logic x, y, z with the actor's
//   angle (0xf81d0c), and for a ground character (FlyingHeight <= 0) the location's WalkEffect too
//   (location +0x120 / +0x128 by 0xd56738; no location of this build has one). So a step fires on the
//   update after the clip reaches the labelled frame, once per pass.
// - With LoopMoveEffect: while walking, a looping MoveEffect (0x82dedc) is kept alive (handle at view
//   +0x9ec, checked with 0x82e52c), attached to the actor when the effect's FollowParent (+0xac, 0xe2202c)
//   is set; any action other than 0 or 10 stops it (0x82e4a4 / 0x82e160).
//
// art.ts calls `step` for every animated character right after its view update (sc/anim.ts animate).
import type { CharacterArt, EffectDef } from './manifest.ts';
import type { PlayOptions } from './effects.ts';
import { nativeAngle, type AnimFrame } from './anim.ts';

/** The effect player calls used here (sc/effects.ts EffectPlayer). */
export interface StepFxPlayer {
  readonly art: { readonly manifest: { readonly effects: Record<string, EffectDef> } };
  has(name: string): boolean;
  play(name: string, x: number, y: number, opts?: PlayOptions): number;
  stop(handle: number): void;
}

/** The actor fields the view reads (logic position and facing, engine Unit). */
export interface StepActor {
  id: number;
  team: number;
  x: number;
  y: number;
  /** actor z (0xf942a8): z base + FlyingHeight */
  z: number;
  dirX: number;
  dirY: number;
  /** has a movement component (data Speed > 0, 0xf7ed38) and is a walker */
  walker: boolean;
}

/** Last frame of a label in an action clip, -1 if absent (a repeated label: its last frame, like sc/anim.ts). */
function labelFrame(labels: Record<string, string> | undefined, name: string): number {
  let r = -1;
  for (const [f, lb] of Object.entries(labels ?? {})) if (lb === name) r = Number(f);
  return r;
}

/** Frames k from prev (inclusive) to cur (exclusive), wrapping at n, reach f1 or f2 (0x840d44 loop). */
export function stepCrossed(prev: number, cur: number, n: number, f1: number, f2: number): boolean {
  if ((f1 & f2) === -1 || cur === prev || n <= 0) return false;
  let k = prev;
  for (let guard = 0; guard <= n + Math.abs(prev); guard++) {
    if (k === f1 || k === f2) return true;
    k = (k + 1) % n;
    if (k === cur) return false;
  }
  return false;
}

export class UnitFx {
  /** view +0x4ec: per actor, the frame each action showed at its last update (sprite pass). */
  private last = new Map<number, Map<number, number>>();
  /** view +0x9ec: per actor, the LoopMoveEffect handle */
  private loops = new Map<number, number>();

  /**
   * One character view update's footstep part. `sprite` is the frame the view update chose (null: no
   * clip); `walkEffect` the location's WalkEffect, if any.
   */
  step(fx: StepFxPlayer, art: CharacterArt, u: StepActor, sprite: AnimFrame | null | undefined, walkEffect?: string): void {
    if (!sprite) return;
    const slot = sprite.action;
    let per = this.last.get(u.id);
    if (!per) { per = new Map(); this.last.set(u.id, per); }
    // A: the view ctor (0x836860) leaves the per-action slots unset; 0 assumed
    const prev = per.get(slot) ?? 0;
    per.set(slot, sprite.frame);
    const walking = u.walker && (slot === 0 || slot === 3);
    const move = art.effects?.moveEffect;
    const team = (u.team === 1 ? 1 : 0) as 0 | 1;
    if (walking && move) {
      if (!(art as { loopMoveEffect?: boolean }).loopMoveEffect) {
        const acts = team === 1 && art.actionsRed ? art.actionsRed : art.actions;
        const a = acts?.[sprite.key];
        if (a && stepCrossed(prev, sprite.frame, a.frames, labelFrame(a.labels, 'action_frame1'), labelFrame(a.labels, 'action_frame2'))) {
          const opts: PlayOptions = { team, z: u.z, angle: nativeAngle(u.dirX, u.dirY) };
          if (fx.has(move)) fx.play(move, u.x, u.y, opts);
          const flying = (art.flyingHeight ?? 0) > 0;
          if (!flying && walkEffect && fx.has(walkEffect)) fx.play(walkEffect, u.x, u.y, opts);
        }
      } else if (!this.loops.has(u.id) && fx.has(move)) {
        const def = fx.art.manifest.effects[move];
        const id = u.id;
        const opts: PlayOptions = { team, z: u.z, angle: nativeAngle(u.dirX, u.dirY) };
        if (def?.FollowParent) opts.follow = () => this.pos.get(id) ?? null;
        this.loops.set(id, fx.play(move, u.x, u.y, opts));
      }
    }
    if (u.walker) this.pos.set(u.id, [u.x, u.y, u.z]);
    // end of the view update: an action other than 0 / 10 ends the looping MoveEffect
    if (slot !== 0) this.stopLoop(fx, u.id);
  }

  private pos = new Map<number, [number, number, number]>();

  private stopLoop(fx: StepFxPlayer, id: number): void {
    const h = this.loops.get(id);
    if (h === undefined) return;
    fx.stop(h);
    this.loops.delete(id);
  }

  /** Drop the state of views that were not updated this frame (actor gone: the view and its loop end). */
  prune(fx: StepFxPlayer, seen: ReadonlySet<number>): void {
    for (const id of this.last.keys()) if (!seen.has(id)) this.last.delete(id);
    for (const id of this.pos.keys()) if (!seen.has(id)) this.pos.delete(id);
    for (const id of [...this.loops.keys()]) if (!seen.has(id)) this.stopLoop(fx, id);
  }
}
