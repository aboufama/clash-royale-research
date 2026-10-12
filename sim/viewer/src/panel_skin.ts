// The simulator's side panel and opponent hand wear the game's own UI pieces: each 9-slice export of
// sc/ui_common.sc (buttons btn_*, popup bodies bg_popup_01_*, bars) is rendered once with the SC renderer
// and exposed as CSS variables for border-image (index.html styles body.skinned with them):
//   --sk-<export>-img    url(PNG)
//   --sk-<export>-slice  the scaling grid insets in image px, plus `fill`
//   --sk-<export>-w      the same insets in CSS px (border widths)
import type { BattleArt } from './sc/battle_art.ts';

/** image px per SC px of the rendered pieces, and CSS px per SC px on the page */
const RENDER_SCALE = 2;
const CSS_SCALE = 0.5;

export function applyPanelSkin(art: BattleArt): boolean {
  const c = art.manifest.hud.common;
  if (!c || typeof document === 'undefined') return false;
  const vars: string[] = [];
  for (const e of c.exports) {
    const s = art.sliceImage(c.sc, e, RENDER_SCALE);
    if (!s) continue;
    const px = (v: number) => `${((v / RENDER_SCALE) * CSS_SCALE).toFixed(2)}px`;
    const [t, r, b, l] = s.slice;
    vars.push(`--sk-${e}-img: url(${s.url});`, `--sk-${e}-slice: ${t} ${r} ${b} ${l} fill;`,
      `--sk-${e}-w: ${px(t)} ${px(r)} ${px(b)} ${px(l)};`);
  }
  if (!vars.length) return false;
  const style = document.createElement('style');
  style.textContent = `:root {\n  ${vars.join('\n  ')}\n}`;
  document.head.appendChild(style);
  document.body.classList.add('skinned');
  return true;
}
