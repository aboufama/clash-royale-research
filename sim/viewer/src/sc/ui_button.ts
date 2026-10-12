// The client's game button (libg 160402020): the result screen's OK button, HUD_taunt's emote button, the emote
// menu's items and text taunts. Ported from:
//   - creation: 0x8a1c08 (screen +0xc8 = 1) -> 0x1273ea0 -> screen vt+0x188 0x8a1b90 makes a GameButton
//     (0x894c54 over the CustomButton 0x12730ac; HUD init 0x8cd4ec and the emote menu 0x8e9284 / 0x8ea65c /
//     0x8ea21c make them directly); vt+0x170 0x1273538 with "use template" set wraps the instance in a clip of
//     the template the client set at startup (0x7723c8 -> 0x1273500: sc/ui.sc `button_timeline`): the template
//     takes the instance's matrix and the instance replaces the template's child 0, so the instance is drawn
//     through button_timeline's child-0 matrix of the current frame;
//   - states (vt+0x180 0x12733ec): -1000 disabled, 0 idle, 1 down, 2 clicked; a change calls vt+0x198
//     (0x8950bc -> 0x127386c): the template plays the state's labels (vt+0x1a0 / vt+0x1a8: "Idle"/"IdleEnd",
//     "Down"/"DownEnd", "Clicked"/"ClickedEnd", "Disabled"/"DisabledEnd"; the GameButton's state 0 asks for
//     "IdleNotice" only with +0x100, never set here), falling back to the Idle labels when the state's are
//     missing, gotoAndStop when only a start exists;
//   - touch: begin (vt+0x110 0x12732d8 / 0x894f80) -> state 1; the touch leaving the button (vt+0x150 0x1273380)
//     -> state 0 unless clicked; coming back (vt+0x148 0x1273334 / 0x89500c) -> state 1; end on the button
//     (vt+0x120 0x1273224 / 0x894fe0) -> state 2, then vt+0x160 0x894dfc: the click sound (the button's +0x108
//     resource, set by 0x894c54 from client tables +0x9c0: ui_menu_general_buttonclick_2) and the listener
//     (+0xa8 vt+8);
//   - update (vt+0x10 0x1273474): a clicked button whose template clip stopped returns to state 0.
// button_timeline (70 frames at 60 fps): Idle 0..1, Clicked 4..14 (child 0 scaled up to 1.05 and back),
// Down 15..22 (down to 0.949), IdleNotice 23..69.
import type { ScLibrary } from './library.ts';
import type { Mat } from './math.ts';
import { McNode } from './movieclip.ts';

export const TEMPLATE_EXPORT = 'button_timeline';

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** vt+0x1a0 / vt+0x1a8 (0x1273a7c / 0x1273ad8): the state's start / end label. */
export function stateLabels(state: number): [string, string] | null {
  switch (state) {
    case -1000: return ['Disabled', 'DisabledEnd'];
    case 0: return ['Idle', 'IdleEnd'];
    case 1: return ['Down', 'DownEnd'];
    case 2: return ['Clicked', 'ClickedEnd'];
    default: return null;
  }
}

export class GameButton {
  /** the template clip (null without sc/ui.sc's button_timeline: the instance is drawn as it is) */
  readonly template: McNode | null;
  /** +0xa0 */
  state = -1;
  /** +0xa4: a touch began on the button and has not ended */
  held = false;
  /** the touch that began on the button is over it now */
  over = false;

  constructor(ui: ScLibrary | null | undefined) {
    this.template = ui && ui.has(TEMPLATE_EXPORT) ? McNode.of(ui, TEMPLATE_EXPORT) : null;
    // 0x1273538 ends with vt+0x180(0) (the state was set to -1 first)
    this.setState(0);
  }

  /** vt+0x180 0x12733ec -> vt+0x198 0x127386c */
  setState(s: number): void {
    if (this.state === s || this.state === -1000) return;
    this.state = s;
    const t = this.template;
    if (!t) return;
    let [a, b] = [t.label('Idle'), t.label('IdleEnd')];
    const sl = s !== 0 ? stateLabels(s) : null;
    if (sl) {
      const sa = t.label(sl[0]), sb = t.label(sl[1]);
      if (sa !== -1) { a = sa; b = sb; }
    }
    if (a === -1) return;
    if (b !== -1) t.playRange(a, b, false);
    else t.gotoAndStop(a);
  }

  /** Touch began on the button (vt+0x110). */
  press(): void {
    this.held = true;
    this.over = true;
    this.setState(1);
  }

  /** The held touch moved; `inside` = it is over the button (vt+0x148 / vt+0x150). */
  move(inside: boolean): void {
    if (!this.held || inside === this.over) return;
    this.over = inside;
    if (inside) this.setState(1);
    else if (this.state !== 2) this.setState(0);
  }

  /**
   * The held touch ended (vt+0x120): on the button it clicks (state 2; the caller plays the click sound and
   * runs the listener, vt+0x160). Returns whether it clicked.
   */
  release(inside: boolean): boolean {
    if (!this.held) return false;
    this.held = false;
    this.over = false;
    if (!inside || this.state === -1000) { if (this.state !== 2) this.setState(0); return false; }
    this.setState(2);
    return true;
  }

  /** Per-frame update (vt+0x10 0x1273474) and the render-time advance of the template, `dt` s. */
  advance(dt: number): void {
    const t = this.template;
    if (!t) return;
    t.advance(dt);
    if (this.state === 2 && t.state === 2) this.setState(0);
  }

  /** The template's child-0 matrix of its current frame (identity without one), applied over the instance. */
  matrix(): Mat {
    const t = this.template;
    if (!t) return IDENTITY;
    const c = t.clip, f = Math.min(Math.max(t.frame, 0), c.frameCount - 1), bm = t.lib.banks[c.bank].m;
    for (let i = c.frameStart[f]; i < c.frameStart[f + 1]; i++) {
      if (c.elements[i * 3] !== 0) continue;
      const mi = c.elements[i * 3 + 1];
      return mi >= 0 ? [bm[mi * 6], bm[mi * 6 + 1], bm[mi * 6 + 2], bm[mi * 6 + 3], bm[mi * 6 + 4], bm[mi * 6 + 5]] : IDENTITY;
    }
    return IDENTITY;
  }
}
