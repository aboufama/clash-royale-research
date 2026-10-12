// Elixir bar extras of the battle HUD ported in viewer/src/sc/ui_port.ts (libg 160402020): the refund
// flash and bar geometry (0x8dbebc, 0x8b2368), the spend drops (0x8dcbf4), the gain floats (0xbe4a8c,
// 0x8dce48) and the elixir speed badge (0x8d38c4 -> 0x8d5158).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  barTipX, elixirDropXs, elixirGainExport, elixirGainText, ElixirBar, PanelFlash, refundBar, regenBadgeText, UiBar,
} from '../src/sc/ui_port.ts';

const f32 = Math.fround;
const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('0x8dbebc refund flash: a rise of more than 1 shows bar_refund for 0.25 s, alpha 1 - (1 - 4t)^2', () => {
  const e = new ElixirBar(10);
  assert.equal(e.last, -1); // 0x8da088
  // the first update rises from -1 to 6: a refund of 7 from -1
  e.update(1 / 60, 6, 600);
  assert.equal(e.refundStarted, true);
  assert.equal(e.refund, 7);
  assert.equal(e.refundFrom, -1);
  assert.equal(e.refundShown, true);
  const t1 = f32(0.25 - 1 / 60);
  close(e.refundT, t1, 1e-7);
  const k = f32(f32(t1 * -4) + 1);
  assert.equal(e.refundAlpha, Math.trunc(f32(f32(1 - f32(k * k)) * 255)));
  // it fades to 0 at t = 0, then hides on the next frame
  let frames = 1;
  while (e.refundT > 0) { e.update(1 / 60, 6, 600); frames++; assert.equal(e.refundStarted, false); }
  assert.ok(frames === 15 || frames === 16, `${frames}`); // 0.25 s at 60 fps, float32 steps
  assert.equal(e.refundAlpha, 0);
  assert.equal(e.refundShown, true);
  e.update(1 / 60, 6, 600);
  assert.equal(e.refundShown, false);
  // a rise of 1 (regeneration) is no refund; a play given back (3 -> 7) is
  e.update(1 / 60, 7, 700);
  assert.equal(e.refundStarted, false);
  e.update(1 / 60, 3, 300);
  assert.equal(e.refundStarted, false);
  e.update(1 / 60, 7, 700);
  assert.equal(e.refundStarted, true);
  assert.equal(e.refund, 4);
  assert.equal(e.refundFrom, 3);
  assert.equal(e.last, 7);
});

test('0x8b2368 bar: body scale = (len - end width) * fill * scale0 / width0, end at the body right edge', () => {
  // bar_body: local x 0..18 at scale 0.399, x -1.45; bar_end 9 * 0.399 wide; bar_bg 402.36 wide
  const len = 402.36;
  const bar = new UiBar(len, { x: -1.45, scale: 0.399, x0: 0, x1: 18 }, 9 * 0.399);
  bar.setFill(0.6);
  close(bar.bodyScale * 18, (len - 9 * 0.399) * 0.6);
  close(bar.endX, -1.45 + (len - 9 * 0.399) * 0.6);
  bar.setFill(0);
  assert.equal(bar.bodyScale, 0);
  close(bar.endX, -1.45);
  // the refund bar of a rise 3 -> 7: x = 3 * len / 10 - 7, length len / 10 * 4, fill 1
  const r = new UiBar(len, { x: -6.85, scale: 0.399, x0: 0, x1: 18 }, 9 * 0.399);
  refundBar(r, len, 10, 3, 4);
  close(r.bodyX, 3 * len / 10 - 7);
  close(r.len, len / 10 * 4);
  close(r.bodyScale * 18, len / 10 * 4 - 9 * 0.399);
  close(r.endX, r.bodyX + len / 10 * 4 - 9 * 0.399);
});

test('0x8dbebc bar_tip x = clamp(whole / max) * len + 2 + body x', () => {
  close(barTipX(6, 10, 400, -1.45), 0.6 * 400 + 2 - 1.45);
  close(barTipX(-1, 10, 400, -1.45), 2 - 1.45);
  close(barTipX(12, 10, 400, 0), 402);
});

test('0x8dcbf4 spend drops: cost clips side by side from the elixir_bar x, each one width further', () => {
  assert.deepEqual(elixirDropXs(0, -131.95, 40), []);
  const xs = elixirDropXs(4, -131.95, 40);
  assert.equal(xs.length, 4);
  close(xs[0], -131.95);
  close(xs[3], -131.95 + 120);
});

test('0xbe4a8c gain text and clip; 0x8dce48 / 0x8db8e0 panel flash', () => {
  assert.equal(elixirGainText(10000), '1');
  assert.equal(elixirGainText(20000), '2');
  assert.equal(elixirGainText(5000), '0.5');
  assert.equal(elixirGainText(15000), '1.5');
  // remainders within +-999 print the whole part only
  assert.equal(elixirGainText(10999), '1');
  assert.equal(elixirGainText(11000), '1.1');
  assert.equal(elixirGainExport(-1, 0), 'elixir_float_txt');
  assert.equal(elixirGainExport(0, 0), 'elixir_float_txt_blue');
  assert.equal(elixirGainExport(1, 0), 'elixir_float_txt_red');
  assert.equal(elixirGainExport(1, 1), 'elixir_float_txt_blue');
  const p = new PanelFlash();
  p.start();
  p.update(0.1);
  close(p.t, 0.3, 1e-6);
  assert.equal(p.add, Math.trunc(f32(f32(f32(f32(0.4) - 0.1) * 0.5) * 255)));
  p.update(1);
  assert.equal(p.t, 0);
  assert.equal(p.add, 0);
});

test('0x8d5158 elixir badge text: "x%d" or "x%d.%d" of the rate x10', () => {
  assert.equal(regenBadgeText(20), 'x2');
  assert.equal(regenBadgeText(30), 'x3');
  assert.equal(regenBadgeText(15), 'x1.5');
});
