// Targeted SWF components ("beams"): the SWF component update 0x82a994 of libg 160402020 for a
// component whose FlashWidth (+0x178, effect data) is non-zero and that has a target: the target actor
// (+0x190, set by the effect's 0x82d484 / 0x82b474) or a fixed target point (+0x158..+0x160 with the
// flag +0x164, set by 0x82d508 / 0x82b484). Visual only.
//
// Each update (2D path, no 3D model): the target point P is the target actor's (x, y, z + vt+0xa8) —
// vt+0xa8 0xf829ec = 2 × CollisionRadius — or the fixed point; it is projected to the battle layer
// (0x857ffc) and, for an actor target whose view is not jumping (state 5) unless HasDamageVisualPivot,
// moved by that view's damage pivot (0x84eb7c(view, −1, centerFirst): attack_pivot_center, else
// attack_pivot, else attack_pivot_1; negated under the 180° view). Without a source actor (+0x188; none
// of the callers ported here sets one) d = P − (the component's own position + its offset (+0x168,
// +0x16c), set through the effect's vt+0x48 0x82d204); the inner clip gets the matrix
// R(atan2 d) · S(|d| / FlashWidth, 1) (FlashWidth < 1: no stretch, rotation only) and its position at
// the offset (0x123c548). So the clip's local x axis runs from the source to the target and FlashWidth
// is the clip's authored length.
import type { Mat } from './math.ts';

/**
 * The beam clip's matrix in battle-layer px: `pos` the component's position, `offset` the source
 * offset, `end` the projected target (pivot included), `flash` the FlashWidth, `scale` the component's
 * own scale (RenderableScale × effect Scale; the container's, applied around the inner clip).
 */
export function beamMatrix(pos: [number, number], offset: [number, number], end: [number, number], flash: number, scale = 1): Mat {
  const ox = pos[0] + offset[0], oy = pos[1] + offset[1];
  const dx = end[0] - ox, dy = end[1] - oy;
  const len = Math.hypot(dx, dy);
  const s = flash < 1 ? 1 : Math.fround(len / flash);
  const a = Math.atan2(dy, dx);
  const c = Math.cos(a), n = Math.sin(a);
  // container scale k around the inner clip: T(pos) · k · (T(offset) · R(a) · S(s, 1))
  const k = scale;
  return [k * c * s, k * n * s, -k * n, k * c, pos[0] + k * offset[0], pos[1] + k * offset[1]];
}
