// The in-battle UI logic ported in viewer/src/sc/ui_port.ts (libg 160402020).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle } from '../../core/src/index.ts';
import { loadGameData } from '../../core/src/node.ts';
import { FOCUS_CARDS, FOCUS_DECKS } from '../src/focus.ts';
import {
  affordableSoon, type AreaActor, cardEntry, cardRaise, cardSlot, DEPLOY_AREA_PIECES, DeployAreaGrid, deployAreaAlpha, deployAreaShown,
  DeployTimer, dropWaits, dropWaitStep, ElixirBar, HandCard, HandWiggle, indicatorRadius, MAX_SPELL_PENDING_TIME_S, nextCardTimer,
  PENDING_GHOST_S, ringBand, ringStrip, rotScale, spellInstanceId, stageLayout, uiEase,
} from '../src/sc/ui_port.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('content scale 0x772a70 and battle layer 0xbdefac: stage size, layer scale and origin', () => {
  // 420 x 800 (h/w 1.905 > 1.77): 578.5 px wide; stageW/stageH >= 0.5 -> scale = H / 1120, margin 90
  const a = stageLayout(420, 800);
  close(a.stageW, 1024 / 1.77, 1e-9);
  close(a.stageH, 800 * a.stageW / 420, 1e-9);
  close(a.battleScale, a.stageH / 1120);
  close(a.battleY, a.battleScale * 90);
  close(a.battleX, a.stageW / 2);
  close(a.k, 420 / a.stageW);
  // 390 x 844 (stageW/stageH < 0.5): scale = W / 560, margin = 67.5 + (H - scale * 1120) / 2
  const b = stageLayout(390, 844);
  close(b.battleScale, b.stageW / 560);
  close(b.battleY, b.battleScale * (90 * 0.75 + (b.stageH - b.battleScale * 1120) * 0.5));
  // landscape: h/w < 1.77 keeps the ratio
  const c = stageLayout(1600, 900);
  close(c.stageW, 1024 / (900 / 1600));
  close(c.stageH, 1024);
});

function towers(): AreaActor[] {
  const t = (x: number, y: number, team: number, w: number, h: number, summ: boolean): AreaActor =>
    ({ x, y, team, alive: true, isBuilding: true, isSummoner: summ, noDeployW: w, noDeployH: h });
  return [t(9000, 3000, 0, 18, 16, true), t(3500, 6500, 0, 11, 21, false), t(14500, 6500, 0, 11, 21, false),
    t(9000, 29000, 1, 18, 16, true), t(3500, 25500, 1, 11, 21, false), t(14500, 25500, 1, 11, 21, false)];
}

test('deploy area 0x869d44: enemy crown towers stamp the far half, own towers do not', () => {
  const g = new DeployAreaGrid(36, 64);
  g.update(0.016, towers(), 0, true);
  for (let r = 0; r < 32; r++) {
    for (let c = 0; c < 18; c++) {
      const back = r === 31 && (c < 7 || c >= 11); // back-row corners cleared outside special modes
      assert.equal(g.blocked[r * 18 + c], r >= 15 && !back ? 1 : 0, `row ${r} col ${c}`);
    }
  }
});

test('deploy area: a fallen Princess tower opens its pocket, tiles shrink away from the river outwards', () => {
  const g = new DeployAreaGrid(36, 64);
  const ts = towers();
  g.update(0.016, ts, 0, true);
  ts[4].alive = false; // red left princess
  g.update(0.016, ts, 0, true);
  // pocket rows 15..20 on the left half: unblocked with timer 0.24 + 0.04 * |16 - row|
  for (let r = 15; r <= 20; r++) {
    for (let c = 0; c < 9; c++) {
      assert.equal(g.blocked[r * 18 + c], 0);
      close(g.timer[r * 18 + c], Math.abs(16 - r) * 0.04 + 0.24, 1e-6);
    }
    assert.equal(g.blocked[r * 18 + 9], 1);
  }
  // a shrinking tile is drawn at timer * 4.1667 scale
  const t16 = g.tiles(true).find((t) => t.row === 16 && t.col === 0)!;
  close(t16.scale, 1, 1e-6);
  g.update(0.12, ts, 0, true);
  const t16b = g.tiles(true).find((t) => t.row === 16 && t.col === 0)!;
  close(t16b.scale, (0.24 - 0.12) * 4.166667, 1e-5);
});

test('deploy area 0x86a610: border pieces of a rectangle (flipped view)', () => {
  const g = new DeployAreaGrid(36, 64);
  // a 3 x 2 block: cols 2..4, rows 10..11 (team 1 stamp seen by team 0)
  g.update(0.016, [{ x: 3500, y: 11000, team: 1, alive: true, isBuilding: true, isSummoner: false, noDeployW: 3, noDeployH: 2 }], 0, true,
    { special: true });
  const tiles = g.tiles(true);
  const at = (c: number, r: number) => tiles.find((t) => t.col === c && t.row === r)!;
  const names = (c: number, r: number) => at(c, r).pieces.map((k) => DEPLOY_AREA_PIECES[k]).sort();
  assert.equal(tiles.length, 6);
  // flipped: screen up = row + 1, screen right = col - 1
  assert.deepEqual(names(3, 11), ['deployArea_side_top']);
  assert.deepEqual(names(3, 10), ['deployArea_side_bottom']);
  assert.deepEqual(names(2, 11), ['deployArea_corner_rightTop']);
  assert.deepEqual(names(4, 11), ['deployArea_corner_leftTop']);
  assert.deepEqual(names(2, 10), ['deployArea_corner_rightBottom']);
  assert.deepEqual(names(4, 10), ['deployArea_corner_leftBottom']);
});

test('deploy area alpha 0x8caf60: +-6 per second, clamped', () => {
  close(deployAreaAlpha(0, true, 0.1), 0.6);
  close(deployAreaAlpha(0.9, true, 0.1), 1);
  close(deployAreaAlpha(0.3, false, 0.1), 0);
});

test('0x8cb0f4: the overlay shows for troops, buildings and The Log, not for spells', () => {
  const b = new Battle(loadGameData(), { seed: 1, decks: [FOCUS_DECKS[0].slice(), FOCUS_DECKS[1].slice()] });
  const shown = (name: string) => {
    const c = b.defs.card(name, 11);
    const raw = b.defs.data.cards[name] as Record<string, unknown>;
    return deployAreaShown({
      summonCharacter: c.spec.main !== null || c.spec.second !== null || c.spec.list.length > 0,
      radius: typeof raw.Radius === 'number' ? raw.Radius : 0, canDeployOnEnemySide: c.canDeployOnEnemySide,
      spellAsDeploy: c.spellAsDeploy, onlyOwnTroops: raw.OnlyOwnTroops === true, hasProjectile: c.spellProjectile !== null,
    });
  };
  for (const n of FOCUS_CARDS) {
    const spell = ['Fireball', 'Arrows', 'GoblinBarrel'].includes(n);
    assert.equal(shown(n), !spell, n);
  }
  assert.equal(deployAreaShown(null), false);
});

test('0xe7ee04 indicator radius: Radius, projectile Radius, turret range, area effect', () => {
  const base = { radius: 0, projectile: null, summon: null, aeoRadius: 0, hideRadiusIndicator: false };
  assert.deepEqual(indicatorRadius({ ...base, radius: 3500, projectile: { radius: 1400, radiusY: 0 } }), { radius: 3500, minRadius: 0, length: 0 });
  assert.deepEqual(indicatorRadius({ ...base, projectile: { radius: 2500, radiusY: 0 } }), { radius: 2500, minRadius: 0, length: 0 });
  // Cannon: Speed 0, Range 5500, CollisionRadius 600
  assert.deepEqual(indicatorRadius({ ...base, summon: { speed: 0, range: 5500, minimumRange: 0, collisionRadius: 600 } }),
    { radius: 6100, minRadius: 0, length: 0 });
  // capped by the projectile's MaxDistance + CollisionRadius; MinimumRange as the inner ring
  assert.deepEqual(indicatorRadius({ ...base, summon: { speed: 0, range: 11500, minimumRange: 3500, collisionRadius: 600, projectileMaxDistance: 9000 } }),
    { radius: 9600, minRadius: 3500, length: 0 });
  // walking troops: none
  assert.equal(indicatorRadius({ ...base, summon: { speed: 60, range: 1200, minimumRange: 0, collisionRadius: 500 } }).radius, 0);
  assert.equal(indicatorRadius({ ...base, aeoRadius: 2500 }).radius, 2500);
});

test('0xcf152c ring strip: segment count, outer/inner points, foreshortened y', () => {
  // R = 75 px (Fireball): n = int(75 * 0.1309 + 0.99) = 10 -> 64 segments, 130 vertices
  const v = ringStrip(75, ringBand(75));
  assert.equal(v.length / 4, 64 * 2 + 2);
  close(v[0], 75); close(v[1], 0); close(v[4], 75 - 32); // band = texture height 32
  close(v[2], 0); close(v[6], 1); // u, v: outer 0, inner 1
  // quarter turn: x 0, y = R / 1.25
  close(v[16 * 8], 75 * Math.cos(16 * 0.09817477), 1e-4);
  close(v[16 * 8 + 1], (75 * Math.sin(16 * 0.09817477)) / 1.25, 1e-4);
  // R = 600 px: n = 79 segments; R = 1000 px: capped at 100 with step 2pi/100
  assert.equal(ringStrip(600, 32).length / 4, 79 * 2 + 2);
  assert.equal(ringStrip(1000, 32).length / 4, 100 * 2 + 2);
  // small rings use half the radius as the band
  assert.equal(ringBand(45), 22.5);
  assert.equal(ringBand(183), 32);
});

test('deploy timer 0x8d9ad0: fill to the end label, then the outro, then removal', () => {
  const t = new DeployTimer(1, 0, 299, 324, 30);
  assert.equal(t.update(0.5), true);
  assert.equal(t.visible, true);
  assert.equal(t.frame, Math.trunc(0.5 * 299 / 1 + 0.5));
  t.update(0.6); // reaches total: switch to the outro
  assert.equal(t.state, 2);
  assert.equal(t.frame, 299);
  close(t.total, (324 - 1 - 299) / 30);
  t.update(0.4);
  assert.equal(t.frame, 299 + Math.trunc(0.4 * 24 / t.total + 0.5));
  assert.equal(t.update(1), false);
  assert.equal(t.visible, false);
  // a delay keeps it hidden first
  const d = new DeployTimer(1, 0.3, 299, 324, 30);
  d.update(0.2);
  assert.equal(d.visible, false);
  d.update(0.2);
  assert.equal(d.visible, true);
});

test('0x1433fb0 ease and the elixir bar bounce', () => {
  close(uiEase(0, 1, -1, 0.25, 0.02, 0.75), 0);
  close(uiEase(0, 1, 0.125, 0.25, 0.02, 0.75), 0.51);
  close(uiEase(0, 1, 0.25, 0.25, 0.02, 0.75), 1.02);
  close(uiEase(0, 1, 2, 0.25, 0.02, 0.75), 1);
  const e = new ElixirBar(10);
  e.update(0.016, 6, 600);
  assert.equal(e.last, 6);
  close(e.timer, 0.255);
  close(e.ghost, 0.6);
  e.update(0.255, 6, 610);
  close(e.fill, 0.6, 1e-6);
  assert.equal(e.full, false);
  e.update(0.016, 10, 1000);
  assert.equal(e.full, true);
  assert.equal(e.flowStarted, true);
});

test('0x8da088 hand slots and the 0x8e1408 selection raise', () => {
  const area: [number, number, number, number] = [-163, -176.55, 272, -49.55];
  const s0 = cardSlot(area, 0, 197.97);
  close(s0.x, -163 + 435 * 0.125);
  close(s0.y, (-176.55 - 49.55) / 2);
  close(s0.s, 127 / 197.97);
  close(cardSlot(area, 3, 197.97).x, -163 + 435 * 0.875);
  close(cardRaise(-113, 0.24, true), -130);
  close(cardRaise(-113, 0.24, false), -113);
  close(cardRaise(-113, 0, true), -113);
});

test('0x8e1408 card entry: x eases with a 20 px overshoot over D, y and scale reach the slot at D / 4', () => {
  const from = { x: -235, y: -73.65, sx: 0, sy: 0 };
  assert.equal(cardEntry(-0.1, 0.375, from, -108.6, -113.05, 0.792), null);
  const a = cardEntry(0, 0.375, from, -108.6, -113.05, 0.792)!;
  close(a.x, -235); close(a.y, -73.65); close(a.sx, 0); close(a.sy, 0);
  const q = cardEntry(0.375 / 4, 0.375, from, -108.6, -113.05, 0.792)!;
  close(q.y, -113.05); close(q.sx, 0.792); close(q.sy, 0.792);
  close(q.x, uiEase(-235, -108.6, 0.25, 1 / 3, 20, 2 / 3));
  const o = cardEntry(0.375 / 3, 0.375, from, -108.6, -113.05, 0.792)!;
  close(o.x, -108.6 + 20, 1e-4); // the overshoot peak at k = 1/3
  close(cardEntry(0.4, 0.375, from, -108.6, -113.05, 0.792)!.x, -108.6);
});

test('hand card cycle: hidden after a play until the slot changes, then dealt again (0x8e0b84 / 0x8e2868)', () => {
  const c = new HandCard();
  c.deal(0.375, 0.6);
  // battle start: the first card does not restart the delay
  c.update(0.1, 3);
  close(c.t, -0.5);
  c.update(1, 3);
  assert.ok(c.t >= c.dur);
  assert.equal(c.visible, true);
  c.select(true);
  c.played();
  c.update(0.5, 3); // play pending: still card 3 in the logic hand, hidden
  assert.equal(c.visible, false);
  // commit: the slot empties, the entry restarts at -0 and waits while empty
  assert.equal(c.update(0.05, -1), true);
  assert.equal(c.visible, false);
  assert.equal(c.selected, false);
  assert.equal(c.hideT, 0);
  assert.ok(Object.is(c.t, -0));
  // refill: shown at once, the entry runs from t = dt
  c.update(0.05, 5);
  assert.equal(c.visible, true);
  close(c.t, 0.05);
  close(c.raiseT, 0.24);
  // a card that never commits shows again after the 3 s hide timer
  const d = new HandCard();
  d.deal(0.375, 0);
  d.update(1, 2);
  d.played();
  d.update(2.9, 2);
  assert.equal(d.visible, false);
  d.update(0.2, 2);
  assert.equal(d.visible, true);
  // a direct card -> card change (commit and refill in one tick) also restarts the entry
  d.update(0.016, 6);
  close(d.t, 0.016);
});

test('0x8dc37c next card: grayscale and NextSpellTimer seconds while the hand timer runs', () => {
  assert.deepEqual(nextCardTimer(0), { gray: false, text: null });
  assert.deepEqual(nextCardTimer(1000), { gray: true, text: '1' });
  assert.deepEqual(nextCardTimer(50), { gray: true, text: '1' });
  assert.deepEqual(nextCardTimer(1001), { gray: true, text: '2' });
});

test('MAX_SPELL_PENDING_TIME: the drop waits only for elixir due within 1.1 s (0x8e2c04 / 0x8e2d50)', () => {
  // client_globals.csv 1200 ms, stored * 0.001 as a float (0xdf3394)
  assert.equal(MAX_SPELL_PENDING_TIME_S, Math.fround(1.2));
  // (int)((1.2f - 0.1f) * 1000f) = 1100 ms of regeneration: 110000 / msPerElixir hundredths
  assert.equal(affordableSoon(361, 4, 2800), true); // 361 + 39 = 400
  assert.equal(affordableSoon(360, 4, 2800), false);
  assert.equal(affordableSoon(322, 4, 1400), true); // + 78 (double elixir)
  assert.equal(affordableSoon(321, 4, 1400), false);
  assert.equal(affordableSoon(282, 4, 930), true); // + 118 (triple elixir)
  assert.equal(affordableSoon(281, 4, 930), false);
  assert.equal(affordableSoon(400, 4, 0), true); // no regeneration: only what is there
  assert.equal(affordableSoon(399, 4, 0), false);
  // waits: not affordable now, due soon, not dropped in the own back rows, time > 0
  assert.equal(dropWaits(false, true, false), true);
  assert.equal(dropWaits(true, true, false), false);
  assert.equal(dropWaits(false, false, false), false);
  assert.equal(dropWaits(false, true, true), false);
  assert.equal(dropWaits(false, true, false, 0), false);
});

test('0x8e1408 +0x324: a waiting card is released once affordable or when the time is up', () => {
  // counting down, not affordable yet
  let st = dropWaitStep(MAX_SPELL_PENDING_TIME_S, 0.5, false);
  assert.equal(st.release, false);
  close(st.t, 0.7, 1e-6);
  // affordable this frame: released at once, timer cleared
  assert.deepEqual(dropWaitStep(st.t, 0.016, true), { t: 0, release: true });
  // time up (clamped at 0) without the elixir: released anyway (the play check then refuses it)
  st = dropWaitStep(0.01, 0.016, false);
  assert.deepEqual(st, { t: 0, release: true });
  // nothing while not waiting
  assert.deepEqual(dropWaitStep(0, 0.016, true), { t: 0, release: false });
  // the engine's elixir reaches a 4-cost card from 3.62 within the wait: 22 ticks of 178
  const need = Math.ceil((40000 - 36200) / 178);
  assert.ok(need * 0.05 <= MAX_SPELL_PENDING_TIME_S, `${need} ticks`);
  assert.equal(PENDING_GHOST_S, 3);
});

test('full-elixir hand wiggle (0x907654 / 0x9077f0 / 0x907ab0 / 0x123e8b4)', () => {
  const w = new HandWiggle();
  const s = 0.6;
  w.add(1, s, s, spellInstanceId('Wizard'));
  w.add(1, 9, 9, 0); // already listed: unchanged
  w.add(2, s, s, spellInstanceId('Knight'));
  w.update(0.1);
  const deg = (t: number, id: number) => Math.sin(t * 28 + (id % 10000) * 123) * 0.45;
  const a = w.of(1)!;
  close(a.deg, deg(Math.fround(0.1), 17), 1e-5);
  assert.equal(a.sx, s);
  close(w.of(2)!.deg, deg(Math.fround(0.1), 0), 1e-5);
  assert.ok(Math.abs(a.deg) <= 0.45);
  // the clock keeps running from the HUD's creation; removal drops the entry
  w.update(0.25);
  close(w.clock, 0.35, 1e-6);
  close(w.of(2)!.deg, deg(Math.fround(0.35), 0), 1e-5);
  w.remove(2);
  assert.equal(w.of(2), null);
  // a non-negative index ends the entry at clock + 0.1122 i
  w.add(3, s, s, 0, 2);
  w.update(0.2);
  assert.ok(w.of(3) !== null);
  w.update(0.1);
  assert.equal(w.of(3), null);
  // matrix: rotation times scale, a = cos sx, b = sin sy, c = -sin sx, d = cos sy
  const [ma, mb, mc, md] = rotScale(0.45, 2, 3);
  const r = 0.45 * Math.PI / 180;
  close(ma, Math.cos(r) * 2, 1e-6);
  close(mb, Math.sin(r) * 3, 1e-6);
  close(mc, -Math.sin(r) * 2, 1e-6);
  close(md, Math.cos(r) * 3, 1e-6);
  w.reset();
  assert.equal(w.clock, 0);
  assert.equal(w.of(1), null);
});

test('card global IDs: instance = named row of the card table (LogicData +0x40 % 10000)', () => {
  assert.equal(spellInstanceId('Knight'), 0);
  assert.equal(spellInstanceId('Prince'), 16);
  assert.equal(spellInstanceId('Wizard'), 17); // the Prince's continuation row has no instance
  assert.equal(spellInstanceId('MiniPekka'), 18);
  assert.equal(spellInstanceId('Miner'), 32);
  assert.equal(spellInstanceId('MightyMiner'), 65);
  assert.equal(spellInstanceId('Cannon'), 0);
  assert.equal(spellInstanceId('Tesla'), 6);
  assert.equal(spellInstanceId('Fireball'), 0);
  assert.equal(spellInstanceId('Log'), 11);
  assert.equal(spellInstanceId('BarbLog'), 15);
});
