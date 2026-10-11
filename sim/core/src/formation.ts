// Summon formation offsets, ported verbatim from Deploy_formationOffset 0xd42ce0 (libg 160402020)
// [STAT]. Pure integer math on the native 1024-scaled sine table; C truncating division.

import { sin1024 } from './trig.ts';

const t = Math.trunc;

/**
 * Offset of summon index `i` (0-based within the circle groups).
 * @param n1 SummonNumber of the first group (as passed natively, max(v,1))
 * @param r ring radius (SummonRadius, else the first character's SpawnRadius or CollisionRadius)
 * @param width SummonWidth (line formation when non-zero)
 * @param negY the bottom team (natively "team index 0"): offsets authored for the top side are negated
 * @param lane spawn lane id (0xd38d9c)
 * @param shift the first character's SpawnAngleShift
 * @param n2 SummonCharacterSecondCount
 * @param laneSeq LOGIC_LANE_ID_BASED_DEPLOY_SEQUENCE
 */
export function formationOffset(i: number, n1: number, r: number, width: number, negY: boolean, lane: number,
  shift: number, n2: number, laneSeq: boolean): [number, number] {
  let p1 = i;
  let p3 = r;
  let p7 = shift;
  let N = (n2 <= n1 ? n1 : n2) << 1;
  if (n2 < 1) N = n2 + n1;
  let mirror = false;
  let ring = true; // falls into the native else-branch (ring radius / large-N adjustments)
  if (N < 4) {
    if (N === 1) return [0, 0];
    if (N === 2) {
      p7 += 90;
      mirror = lane === 1 && laneSeq;
      ring = false;
    } else if (N === 3) {
      mirror = lane === 1 && laneSeq;
      p7 += 180;
    } else {
      mirror = lane === 2 && laneSeq;
    }
  } else if (N < 6) {
    if (N === 4) {
      mirror = lane === 2 && laneSeq;
      p7 += 45;
    } else {
      mirror = lane === 2 && laneSeq;
      p7 += 180;
    }
  } else if (N !== 7) {
    mirror = lane === 2 && laneSeq;
  } else {
    if (p1 === 0) return [0, 0];
    mirror = false;
    p1 -= 1;
    N = 6;
  }
  if (ring) {
    if (width === 0 && N > 2) {
      const a = n1 !== 0 ? t(90 / n1) : 0;
      const k = t((sin1024(a) * 1000) / 1024);
      p3 = k !== 0 ? t((p3 * 577) / k) : 0;
    }
    if (N > 6) p3 = t((p3 * ((p1 * 3) % 7)) / 6);
  }
  if (width === 0 || n2 !== 1) {
    let div: number;
    let ax: number;
    let ay: number;
    if (n2 < 1) {
      div = 1024;
      const a = N !== 0 ? t((p1 * 360) / N) : 0;
      ay = a + p7 + 90;
      ax = a + p7 + 180;
    } else {
      let u7 = N !== 0 ? t(360 / N) : 0;
      u7 = u7 >> 1;
      let u6 = u7;
      if (n1 < n2) u7 += (n2 !== 0 ? t(180 / n2) : 0) >> 1;
      else if (n2 < n1) u6 = u7 + ((n1 !== 0 ? t(180 / n1) : 0) >> 1);
      let base = n1 !== 1 ? p7 : 0;
      let u8 = p1 > 0 || n1 !== 1 ? u7 : 90;
      if (n1 > 1 && n2 === 1) {
        if (p1 < n1) u8 = n1 !== 0 ? t(90 / n1) : 0;
        base = 0;
      }
      div = -1024;
      const a4 = u6 + base + (N !== 0 ? t(((p1 - n1) * 360) / N) : 0);
      const a2 = u8 + base + (N !== 0 ? t((p1 * 360) / N) : 0);
      ay = a4 + 180;
      ax = a4 + 270;
      if (p1 < n1) { ay = a2; ax = a2 + 90; }
    }
    let x = t((sin1024(ax) * p3) / 1024);
    let y = div !== 0 ? t((sin1024(ay) * p3) / div) : 0;
    if (width === 0) {
      if (negY) y = -y;
    } else {
      const lx = N - 1 !== 0 ? t((p1 * width) / (N - 1)) : 0;
      const parity = p1 < 0 ? -(p1 & 1) : p1 & 1;
      x = lx - t(width / 2);
      y = p3 * parity - t(p3 / 2);
      if (negY) { x = -x; y = -y; mirror = lane === 1; }
    }
    if (mirror) x = -x;
    return [x, y];
  }
  if (p1 !== 0) return [mirror ? -width : width, negY ? -p3 : p3];
  return [0, 0];
}
