// Deterministic integer helpers. All engine state is integer game units, ms or
// fixed-point; nothing here touches floating-point transcendental functions, so
// results are identical in every JavaScript engine.

/** floor(sqrt(n)) for 0 <= n < 2^53, exact. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  // Math.sqrt is correctly rounded (IEEE 754), so the estimate is off by at most 1.
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** C-style integer division (truncates toward zero), as native integer code does. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Seeded PRNG (xorshift128). 32-bit integer state, deterministic across engines.
 * Only engine logic that the game itself randomizes may draw from it.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // splitmix32 to spread the seed over the state
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next() || 1;
    this.b = next();
    this.c = next();
    this.d = next();
  }

  /** Uniform uint32. */
  nextU32(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return this.nextU32() % n;
  }

  state(): number[] {
    return [this.a, this.b, this.c, this.d];
  }
}

/** FNV-1a over 32-bit words, for state hashing in replay tests. */
export class Hasher {
  h = 0x811c9dc5;
  add(v: number): void {
    // fold a (possibly > 32-bit) integer into two words
    const lo = v | 0;
    const hi = Math.floor(v / 4294967296) | 0;
    this.word(lo);
    this.word(hi);
  }
  private word(w: number): void {
    for (let i = 0; i < 4; i++) {
      this.h ^= (w >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193) >>> 0;
    }
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
