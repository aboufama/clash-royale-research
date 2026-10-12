// The result screen's confetti (libg 160402020), ported from 0x8c08b0 (called by the result setup 0x8bf730 with
// 0 for an own win, 1 for a loss, not for a draw):
//   - the first call makes two effect layers, 0x855d04(the location of table 0xf, 0, 1): battle-layer objects
//     (vtable 0x188dfd8: the sprite layers Base .. Above and an effect manager +0x1a0) without the battle's
//     ground; +0x308 is appended to the game layer +0x178 (above the result screen and the popup manager) and
//     +0x300 to the HUD layer +0x160 (above the HUD, below the intro +0x168 and the result screen +0x170);
//   - the effects: win_battle_confetti_blue in +0x300, win_battle_confetti_blue_top in +0x308 (static Strings
//     0x1a5e858 / 0x1a5e868; clan-war, gold / crown rush and event modes pick others, none in a ladder battle),
//     played once (0x82dfe8 -> 0x82dcb0 with the "enemy" flag = the loss -> EnemyVersion
//     win_battle_confetti_red / _red_top, then setLoop(0)) at x = (stage width - insets) / 2,
//     y = (stage height - insets) / 2, 40 px higher for a loss (insets 0 here);
//   - 0x82dfe8 turns the stage point into the layer's logic units with 0x8582a4 (layer +0x180 / +0x184 = 0 and no
//     flip, +0x1b9, for a fresh layer: logic x = (int)(x * 500 / 15), y = (int)(y * 500 / 12)), and the layer
//     draws its sprites back through 0x857ffc (px = 15 wx, py = 12 (wy - wz / 2), world = logic * 0.002) at
//     scale 1 in stage px;
//   - the result screen's update 0x8c1b9c updates both layers each frame (0x856f28 with the frame dt).
// The effect system itself is sc/effects.ts (EffectPlayer) on a stand-in art whose projection is that layer's.
import type { BattleArt } from './battle_art.ts';
import { EffectPlayer } from './effects.ts';
import type { ScRenderer } from './renderer.ts';

/** Effect names of 0x8c08b0 for a ladder battle (0x1a5e858, 0x1a5e868). */
export const CONFETTI = 'win_battle_confetti_blue';
export const CONFETTI_TOP = 'win_battle_confetti_blue_top';

/** Layers of the battle-layer object in drawing order (0xe22490 / 0x8569f0, sc/effects.ts). */
const LAYERS = ['Base', 'Shadow', 'Ground', 'GroundAbility', 'Object', 'Above'];

/** 0x8582a4 on a fresh effect layer: stage px -> its logic units (truncated like the int stores). */
export function layerLogic(x: number, y: number): [number, number] {
  return [Math.trunc((x * 500) / 15), Math.trunc((y * 500) / 12)];
}

/** The play point of 0x8c08b0 in stage px (no safe-area insets). */
export function confettiPoint(stageW: number, stageH: number, loss: boolean): [number, number] {
  const x = Math.trunc(stageW) / 2;
  const y = Math.trunc(stageH) / 2;
  return [x, loss ? y - 40 : y];
}

/** A BattleArt whose projection is a fresh effect layer's (0x857ffc with +0x180 / +0x184 = 0, no flip). */
function layerArt(art: BattleArt): BattleArt {
  return new Proxy(art, {
    get(t, k) {
      if (k === 'gameToPx') return (x: number, y: number, z = 0): [number, number] => [x * 0.03, y * 0.024 - z * 0.012];
      if (k === 'flip') return false;
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

export class Confetti {
  /** +0x300 (under the result screen) and +0x308 (above it) */
  readonly under: EffectPlayer;
  readonly over: EffectPlayer;

  constructor(art: BattleArt, stageW: number, stageH: number, loss: boolean, seed = 0x8c08b0) {
    const la = layerArt(art);
    this.under = new EffectPlayer(la, seed);
    this.over = new EffectPlayer(la, seed + 1);
    for (const p of [this.under, this.over]) p.shadows = false;
    const [x, y] = confettiPoint(stageW, stageH, loss);
    const [lx, ly] = layerLogic(x, y);
    const team = loss ? 1 : 0;
    if (this.under.has(CONFETTI)) this.under.play(CONFETTI, lx, ly, { team, loop: false });
    if (this.over.has(CONFETTI_TOP)) this.over.play(CONFETTI_TOP, lx, ly, { team, loop: false });
  }

  /** 0x856f28 on both layers, `dt` s. */
  update(dt: number): void {
    this.under.update(dt * 1000);
    this.over.update(dt * 1000);
  }

  /** Draw one layer in stage px (the caller has set the stage view). */
  draw(r: ScRenderer, which: 'under' | 'over'): void {
    const p = which === 'under' ? this.under : this.over;
    for (const l of LAYERS) p.draw(r, l);
  }
}
