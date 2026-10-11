// Original-art world renderer. Filled in once the baked SC libraries exist
// (tools/art/bake_web.py -> sim/viewer/assets/). Returns null hooks until then.
import type { ArtHooks } from './main.ts';

export function createArt(_manifest: unknown): ArtHooks | null {
  return null;
}
