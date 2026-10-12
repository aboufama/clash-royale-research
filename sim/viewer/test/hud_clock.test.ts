// HUD clock after the end, HUD_topRight's fade, HUD_player's slide-in with the hand update gate and the
// popup manager's default floater point, ported in viewer/src/sc/ui_port.ts (libg 160402020: 0x8d38c4 on
// the timeline 0xd56070, 0x8d1e6c, 0x8db8e0 / 0x8dc37c, 0x88ca58), on real engine battles where it matters.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle, ST_DEAD } from '../../core/src/index.ts';
import { loadGameData } from '../../core/src/node.ts';
import { battleClock, defaultFloaterPos, HandPanelSlide, postEndTicks, topRightFade } from '../src/sc/ui_port.ts';

const data = loadGameData();
const DECK = ['Knight', 'Archer', 'Giant', 'Musketeer', 'Fireball', 'Arrows', 'MiniPekka', 'Valkyrie'];
const battle = () => new Battle(data, { seed: 1, decks: [DECK, DECK], noShuffle: true });

test('0x8d38c4: a battle won at the end of regulation shows 0:00 of regulation, not "Overtime 2:00"', () => {
  const b = battle();
  b.tick = b.regulationTicks - 1;
  b.players[0].crowns = 1;
  b.step();
  assert.ok(b.result && b.tick === b.regulationTicks);
  // the engine's tick is one past the end, and the timeline keeps running during EndScreenDelay
  for (const k of [0, 1, 40]) assert.deepEqual(battleClock(b, k), { ot: false, msLeft: 0, secs: 0 });
});

test('0x8d38c4: equal crowns at the end of regulation enter overtime (2:00 left)', () => {
  const b = battle();
  b.tick = b.regulationTicks - 1;
  b.step();
  assert.equal(b.result, null);
  assert.deepEqual(battleClock(b), { ot: true, msLeft: 120000, secs: 120 });
  b.step();
  assert.equal(battleClock(b).secs, 120); // 119.95 s
  assert.equal(battleClock(b).msLeft, 119950);
});

test('0x8d38c4: after a King kill the clock keeps counting through the end delay (the battle tick runs on)', () => {
  const b = battle();
  b.tick = 2000; // 80 s left after this tick
  b.players[1].king.state = ST_DEAD;
  (b as unknown as { checkEnd(): void }).checkEnd();
  b.tick++;
  assert.equal(b.result?.reason, 'king');
  assert.deepEqual(battleClock(b), { ot: false, msLeft: (3600 - 2001) * 50, secs: 80 });
  assert.equal(battleClock(b, 20).secs, 79);
  assert.equal(battleClock(b, 60).secs, 77);
});

test('0x8d1e6c HUD_topRight: from 0, +4 dt per frame while unblocked, -2 dt once blocked, as an alpha byte', () => {
  let a = 0;
  const dt = 1 / 60;
  const seen: number[] = [];
  for (let i = 0; i < 18; i++) { a = topRightFade(a, dt, false); seen.push(a); }
  assert.equal(seen[0], 17); // (int)(f32(4 / 60) * 255)
  assert.equal(seen[seen.length - 1], 255);
  assert.ok(seen.indexOf(255) <= 16, 'in about 0.25 s');
  let frames = 0;
  while (a > 0) { a = topRightFade(a, dt, true); frames++; }
  assert.ok(frames >= 29 && frames <= 32, `${frames} frames to fade out (0.5 s)`);
  assert.equal(topRightFade(0, dt, true), 0);
});

test('0x8db8e0 slide: t moves 4 / s; y = u^2 (3 - 2u) dist; alpha while t > 0; 0x8dc37c gate at 0.4', () => {
  const s = new HandPanelSlide();
  assert.equal(s.offset(200), 200);
  assert.equal(s.visible, false);
  s.update(0.05, true);
  assert.ok(Math.abs(s.t - 0.2) < 1e-6 && s.visible && !s.handLive);
  const u = Math.fround(1 - s.t);
  assert.ok(Math.abs(s.offset(200) - u * u * 200 * (3 - 2 * u)) < 1e-3);
  s.update(0.05, true);
  assert.equal(s.handLive, true); // t = 0.4
  s.update(1, true);
  assert.equal(s.t, 1);
  assert.equal(s.offset(200), 0);
  s.update(0.1, false); // blocked: the gate closes at once, the panel slides out
  assert.equal(s.handLive, false);
  assert.ok(Math.abs(s.t - 0.6) < 1e-6);
  s.update(1, false);
  assert.equal(s.t, 0);
  assert.equal(s.visible, false);
});

test('0x88ca58 default floater point: stage size times (0.5, 0.3), floored', () => {
  assert.deepEqual(defaultFloaterPos(400.7, 712.3), [200, 213]);
  assert.deepEqual(defaultFloaterPos(375, 812), [187, 243]);
});

test('0x10ca9a0 / 0xd3581c: the battle ticks after the end stop at EndScreenDelay, and the clock with them', () => {
  assert.equal(postEndTicks(4000), 80);
  assert.equal(postEndTicks(1), 0);
  assert.equal(postEndTicks(51), 1);
  const b = battle();
  b.tick = 2000;
  b.players[1].king.state = ST_DEAD;
  (b as unknown as { checkEnd(): void }).checkEnd();
  b.tick++;
  // the viewer's clock runs on under the result screen; the HUD reads at most postEndTicks past the end
  const frozen = battleClock(b, postEndTicks(4000)).secs;
  assert.equal(battleClock(b, Math.min(postEndTicks(4000), 200)).secs, frozen);
  assert.equal(frozen, Math.ceil(((3600 - 2001 - 80) * 50) / 1000));
});
