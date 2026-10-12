// Drifting cloud shadows of the location (Cloud* columns), ported from libg 160402020:
//   setup 0x857a50 (from the battle layer init 0x856088, which battle setup 0xbde180 calls after the
//   view flip is set), new cloud 0x85a11c, per-frame update 0x85751c (from the layer update 0x856f28,
//   the same dt in seconds as the screen shake).
//
// The clouds are children of battle layer 11 (Above), added before any effect, so they draw over the
// actors and under the Above effects. Setup, with W = the stage width minus the safe-area insets (SC px),
// A / B = the projected logic corners (0, 0) / (map width, map height) through the flip, N = CloudCount:
// cloud i (N − 1 down to 0) takes a slot s drawn without replacement from {N − 1 .. 0} and is placed at
//   (A.x + W/N · (s + r/2),  A.y − 100 + (|B.y − A.y| + 200)/N · (i + r/2)).
// A new cloud (0x85a11c): a random entry of the file/export lists, scale MinScale + r·(MaxScale − MinScale)
// (%), alpha MinAlpha + r·(MaxAlpha − MinAlpha) (%), speed (MinSpeed + r·(MaxSpeed − MinSpeed))·0.1 px/s
// along the angle +0x150 (always 0: +x); with RandomFlip the clip is mirrored unless rand() is odd; its
// width is the clip's width through that scale (0x123c9e0, frame 0). Update: position += dt · velocity;
// a cloud that has left the stage (moving right: x − w/2 > W/2) is replaced by a new random cloud at
// x = −((w + W)/2 + 1 + r·20) (mirrored for a leftward one), keeping its y.
//
// Approximations (A): the client only builds the clouds when setting +0x198 of 0x770758 is 2 (taken to be
// the high graphics level, assumed on); libc rand() is a seeded xorshift; safe-area insets are 0.

import type { BattleArt } from './battle_art.ts';
import type { ScRenderer } from './renderer.ts';
import { ClipPlayer } from './anim.ts';

interface Cloud {
  x: number; y: number;
  vx: number; vy: number;
  w: number;
  scale: number; flip: number; alpha: number;
  player: ClipPlayer;
}

export class Clouds {
  private readonly art: BattleArt;
  private readonly list: Cloud[] = [];
  private s: number;

  constructor(art: BattleArt, stageW: number, seed = 1) {
    this.art = art;
    this.s = (seed * 0x9e3779b1) >>> 0 || 1;
    const c = art.manifest.arena.clouds;
    const n = c?.count ?? 0;
    if (!c || n < 1 || !art.libs.get(c.sc)?.has(c.export)) return;
    const W = Math.trunc(stageW);
    const [ax, ay] = art.gameToPx(0, 0);
    const [, by] = art.gameToPx(18000, 32000);
    const slots: number[] = [];
    for (let k = n - 1; k >= 0; k--) slots.push(k);
    for (let i = n - 1; i >= 0; i--) {
      const cl = this.make();
      const j = this.rand() % slots.length;
      const slot = slots[j];
      slots.splice(j, 1);
      cl.x = ax + W * (1 / n) * (slot + this.frand() * 0.5);
      cl.y = ay - 100 + (1 / n) * (Math.abs(by - ay) + 200) * (i + this.frand() * 0.5);
      this.list[i] = cl;
    }
  }

  private rand(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x & 0x7fffffff;
  }

  private frand(): number { return this.rand() / 0x80000000; }

  /** 0x85a11c */
  private make(): Cloud {
    const c = this.art.manifest.arena.clouds!;
    this.rand(); // the file/export entry (one per location here)
    const scale = ((c.minscale ?? 100) + this.frand() * ((c.maxscale ?? 100) - (c.minscale ?? 100))) * 0.01;
    const alpha = ((c.minalpha ?? 100) + this.frand() * ((c.maxalpha ?? 100) - (c.minalpha ?? 100))) * 0.01;
    const lo = (c.minspeed ?? 0) * 0.1, hi = (c.maxspeed ?? 0) * 0.1;
    const speed = lo + this.frand() * (hi - lo);
    const flip = c.randomflip && (this.rand() & 1) === 0 ? -1 : 1;
    const lib = this.art.libs.get(c.sc)!;
    const b = lib.frameBounds(c.export, 0);
    const w = b ? (b[2] - b[0]) * scale : 0;
    const player = new ClipPlayer(Math.max(1, lib.frameCount(c.export)), lib.fps(c.export) || 30);
    return { x: 0, y: 0, vx: speed, vy: 0, w, scale, flip, alpha, player };
  }

  /** 0x85751c: `dt` seconds; `stageW` the current stage width (SC px). */
  update(dt: number, stageW: number): void {
    const W = Math.trunc(stageW);
    for (let i = this.list.length - 1; i >= 0; i--) {
      let cl = this.list[i];
      cl.x += dt * cl.vx;
      cl.y += dt * cl.vy;
      if ((cl.vx > 0 && W * 0.5 < cl.x - cl.w * 0.5) || (cl.vx < 0 && cl.w * 0.5 + cl.x < W * -0.5)) {
        const y = cl.y;
        cl = this.make();
        const d = (cl.w + W) * 0.5 + 1 + this.frand() * 20;
        cl.x = cl.vx <= 0 ? d : -d;
        cl.y = y;
        this.list[i] = cl;
      } else {
        cl.player.advance(dt);
      }
    }
  }

  draw(r: ScRenderer): void {
    const c = this.art.manifest.arena.clouds;
    if (!c || !this.list.length) return;
    const lib = this.art.libs.get(c.sc);
    if (!lib) return;
    for (const cl of this.list) {
      if (!cl) continue;
      r.draw(lib, c.export, cl.player.frame, [cl.scale * cl.flip, 0, 0, cl.scale, cl.x, cl.y], [1, 1, 1, cl.alpha, 0, 0, 0]);
    }
  }
}
