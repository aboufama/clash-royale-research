// 2x3 affine matrices and Flash-style color transforms, with the exact composition rules of
// tools/art/sc2.py (Matrix.mul / Color.mul) so the WebGL output matches tools/art/render.py.
//
// Mat = [a, b, c, d, tx, ty]:  x' = a*x + c*y + tx,  y' = b*x + d*y + ty  (SC pixels, y down)
// Col = [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd]: multipliers 0..1, adds 0..255

export type Mat = [number, number, number, number, number, number];
export type Col = [number, number, number, number, number, number, number];

export const IDENTITY: Readonly<Mat> = [1, 0, 0, 1, 0, 0];
export const WHITE: Readonly<Col> = [1, 1, 1, 1, 0, 0, 0];

export function mat(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0): Mat {
  return [a, b, c, d, tx, ty];
}

/** p * q: apply q first, then p (sc2.Matrix.mul). */
export function matMul(p: Readonly<Mat>, q: Readonly<Mat>, out: Mat = [1, 0, 0, 1, 0, 0]): Mat {
  const a = p[0] * q[0] + p[2] * q[1];
  const b = p[1] * q[0] + p[3] * q[1];
  const c = p[0] * q[2] + p[2] * q[3];
  const d = p[1] * q[2] + p[3] * q[3];
  const tx = p[0] * q[4] + p[2] * q[5] + p[4];
  const ty = p[1] * q[4] + p[3] * q[5] + p[5];
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = tx; out[5] = ty;
  return out;
}

export function matTranslate(tx: number, ty: number): Mat {
  return [1, 0, 0, 1, tx, ty];
}

export function matScale(sx: number, sy = sx): Mat {
  return [sx, 0, 0, sy, 0, 0];
}

export function matRotate(rad: number): Mat {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export function matInvert(m: Readonly<Mat>): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  const id = det === 0 ? 0 : 1 / det;
  const a = m[3] * id, b = -m[1] * id, c = -m[2] * id, d = m[0] * id;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function matApply(m: Readonly<Mat>, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Uniform-ish scale factor of a matrix (geometric mean of the axis lengths). */
export function matScaleFactor(m: Readonly<Mat>): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function col(rMul = 1, gMul = 1, bMul = 1, aMul = 1, rAdd = 0, gAdd = 0, bAdd = 0): Col {
  return [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd];
}

/** p * q: apply q first, then p (sc2.Color.mul: adds of q are scaled by p's multipliers). */
export function colMul(p: Readonly<Col>, q: Readonly<Col>, out: Col = [1, 1, 1, 1, 0, 0, 0]): Col {
  const r = Math.min(255, p[4] + q[4] * p[0]);
  const g = Math.min(255, p[5] + q[5] * p[1]);
  const b = Math.min(255, p[6] + q[6] * p[2]);
  out[0] = p[0] * q[0]; out[1] = p[1] * q[1]; out[2] = p[2] * q[2]; out[3] = p[3] * q[3];
  out[4] = r; out[5] = g; out[6] = b;
  return out;
}

export function colAlpha(a: number): Col {
  return [1, 1, 1, a, 0, 0, 0];
}
