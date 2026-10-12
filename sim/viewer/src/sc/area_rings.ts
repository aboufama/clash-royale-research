// Area-damage indicator rings (libg 160402020), ported from the battle screen:
//
//   World_areaDamage 0xf97be8 -> battle screen listener vt+0x3a8 0xbe76e8 (engine event 'areaRing') and,
//   for pushback, vt+0x3b0 0xbe7980 (event 'pushRing', also from area-effect pulses 0xf7a34c). Each call:
//     - projects the logic point with 0x8583bc (battle layer +0x2f0: x * 0.002 * 15, y * 0.002 * 12,
//       through its global matrix, truncated to whole stage px) and maps it into the HUD object (+0x300,
//       0x123c788);
//     - makes a radius-indicator object (class 0xcf0464, vtable 0x190af90, texture image/range.png) with
//       rx = R * 0.03 * a and ry = R2 * 0.024 * d (a, d: the battle layer's own scale, vt+0x48 / vt+0x50 =
//       matrix +0x10 / +0x1c), y divisor 1.25 and no inner radius; R2 > 0 builds a rectangle frame
//       (0xcf05d4), else the ring mesh 0xcf0838 -> 0xcf152c (sc/ui_port.ts ringStrip / ringBand);
//     - tints it: 0xbe76e8 sets colour bytes +10, +11 (green, blue multipliers) to 0x7f, so the ring is
//       (255, 127, 127); 0xbe7980 sets +9..+11 to 0x7f, grey (127, 127, 127). The listener gets no team:
//       both sides' rings look the same;
//     - appends it to the HUD object's children (0x1252994 -> 0x125299c at index = child count), so it
//       draws over the HUD elements made before it, and pushes { ring, t = 0 } on list +0x2d0.
//   The battle screen update 0xbe1d3c walks the list every frame: alpha = 1 - t / D (vt+0x58 0x123cbc0:
//   clamped to [0, 1], stored as a byte), visible = battle layer +0x1bc (1 from its ctor 0x855d04), then
//   t += dt and the ring is deleted once t > D, with D = AREA_DAMAGE_INDICATOR_DURATION_MS (client
//   globals +0x330) / 1000.
import type { Col, Mat } from './math.ts';
import { ringBand, ringStrip } from './ui_port.ts';

/** client_globals AREA_DAMAGE_INDICATOR_DURATION_MS (client globals +0x330). */
export const AREA_DAMAGE_INDICATOR_DURATION_MS = 400;

/** Colour multipliers of the two listener calls (bytes 0x7f = 127/255). */
const HALF = 0x7f / 255;
export const AREA_RING_RGB: readonly [number, number, number] = [1, HALF, HALF];
export const PUSH_RING_RGB: readonly [number, number, number] = [HALF, HALF, HALF];

export interface AreaRingView {
  /** 'area': vt+0x3a8 (0xbe76e8); 'push': vt+0x3b0 (0xbe7980) */
  kind: 'area' | 'push';
  /** logic point and radii (game units) as the listener received them */
  x: number;
  y: number;
  r: number;
  r2: number;
  /** list +0x2d0 entry +8: seconds since creation, advanced after the alpha is set */
  t: number;
  /** alpha set by the last update (byte / 255) */
  alpha: number;
  /** HUD child order shared with the other children appended to the HUD object (from `nextSeq`) */
  seq: number;
}

/**
 * Radius-indicator mesh in stage px around (0, 0), as a triangle strip [x, y, u, v] * n (u, v = 0 on
 * the outer edge, 1 on the inner edge), for the ctor 0xcf0464 with inner radius 0 and y divisor 1.25:
 * ry > 0 -> the rectangle frame of 0xcf05d4, else the ring of 0xcf0838 -> 0xcf152c.
 */
export function indicatorMesh(rx: number, ry: number, texH: number): Float32Array {
  if (ry > 0) return rectFrameStrip(rx, ry, texH);
  return ringStrip(rx, ringBand(rx, texH), 1.25);
}

/**
 * 0xcf05d4: a rectangle frame of half extents rx, ry (no y divisor) as a 10-vertex strip, outer then
 * inner corner, from (rx, -ry) through (rx, ry), (-rx, ry), (-rx, -ry) back to (rx, -ry). The band is
 * the texture height, or half the dimension when that leaves less than half; the smaller of rx and ry
 * decides (rx when rx <= ry).
 */
export function rectFrameStrip(rx: number, ry: number, texH: number): Float32Array {
  const bx = rx - texH <= rx * 0.5 ? rx * 0.5 : texH;
  const by = ry - texH <= ry * 0.5 ? ry * 0.5 : texH;
  const band = rx <= ry ? bx : by;
  const ix = rx - band, iy = ry - band;
  return new Float32Array([
    rx, -ry, 0, 0, ix, -iy, 1, 1,
    rx, ry, 0, 0, ix, iy, 1, 1,
    -rx, ry, 0, 0, -ix, iy, 1, 1,
    -rx, -ry, 0, 0, -ix, -iy, 1, 1,
    rx, -ry, 0, 0, ix, -iy, 1, 1,
  ]);
}

/** Ring size in stage px (0xbe76e8 / 0xbe7980): rx = R * 0.03 * a, ry = R2 * 0.024 * d, float32. */
export function ringRadiiPx(r: number, r2: number, layerScaleX: number, layerScaleY: number): [number, number] {
  const f = Math.fround;
  return [f(f(f(r) * f(0.030000001)) * f(layerScaleX)), f(f(f(r2) * f(0.024)) * f(layerScaleY))];
}

/** vt+0x58 0x123cbc0: alpha clamped to [0, 1] and stored as a byte (int)(a * 255). */
export function alphaByte(a: number): number {
  const v = a > 1 ? 1 : a;
  return a >= 0 ? Math.trunc(Math.fround(v * 255)) : 0;
}

/** The battle screen's indicator list (+0x2d0) and its per-frame fade (0xbe1d3c). */
export class AreaRings {
  readonly list: AreaRingView[] = [];
  /** the battle layer's +0x1bc byte, copied to each ring's visible flag (+8) every update */
  visible = true;
  durationMs = AREA_DAMAGE_INDICATOR_DURATION_MS;
  /** source of HUD child order numbers (battle_ui.ts can share its counter with timers and texts) */
  nextSeq: () => number = () => 0;

  reset(): void {
    this.list.length = 0;
  }

  /** Listener calls carried by the engine's events ('areaRing' -> 0xbe76e8, 'pushRing' -> 0xbe7980). */
  onEvents(events: readonly { type: string; x: number; y: number; r?: number; r2?: number }[]): void {
    for (const e of events) {
      if (e.type === 'areaRing') this.add('area', e.x, e.y, e.r ?? 0, e.r2 ?? 0);
      else if (e.type === 'pushRing') this.add('push', e.x, e.y, e.r ?? 0, 0);
    }
  }

  add(kind: 'area' | 'push', x: number, y: number, r: number, r2: number): void {
    this.list.push({ kind, x, y, r, r2, t: 0, alpha: 1, seq: this.nextSeq() });
  }

  /** 0xbe1d3c: alpha from the age, then age += dt; deleted once the age passes the duration. */
  update(dt: number): void {
    const D = Math.fround(this.durationMs * 0.001);
    let w = 0;
    for (const g of this.list) {
      g.alpha = alphaByte(Math.fround(1 - Math.fround(g.t / D))) / 255;
      g.t = Math.fround(g.t + dt);
      if (g.t <= D) this.list[w++] = g;
    }
    this.list.length = w;
  }

  /**
   * Draw the rings in the HUD layer (stage px view): `toStage` maps a logic point to stage px (the
   * battle projection), truncated like 0x8583bc; `layerScale` is the battle layer's scale; `draw`
   * renders a strip (image/range.png) with a matrix and colour transform. Oldest first (child order).
   */
  draw(toStage: (x: number, y: number) => [number, number], layerScale: number, texH: number,
    draw: (verts: Float32Array, m: Mat, c: Col) => void): void {
    for (const g of this.list) this.drawOne(g, toStage, layerScale, texH, draw);
  }

  /** One ring (for a caller that interleaves the HUD object's children by `seq`). */
  drawOne(g: AreaRingView, toStage: (x: number, y: number) => [number, number], layerScale: number, texH: number,
    draw: (verts: Float32Array, m: Mat, c: Col) => void): void {
    if (!this.visible || g.alpha <= 0) return;
    const [sx, sy] = toStage(g.x, g.y);
    const [rx, ry] = ringRadiiPx(g.r, g.r2, layerScale, layerScale);
    if (!(rx > 0)) return;
    const rgb = g.kind === 'area' ? AREA_RING_RGB : PUSH_RING_RGB;
    draw(indicatorMesh(rx, ry, texH), [1, 0, 0, 1, Math.trunc(sx), Math.trunc(sy)], [rgb[0], rgb[1], rgb[2], g.alpha, 0, 0, 0]);
  }
}
