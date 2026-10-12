// End-of-battle announcements of the HUD time update 0x8d38c4 and the crown-score prints of 0x8d2de0
// (viewer/src/sc/announce.ts), on a stand-in library with the frame counts and labels of sc/ui.sc.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle } from '../../core/src/index.ts';
import { loadGameData } from '../../core/src/node.ts';
import { Announcements, ScorePrint } from '../src/sc/announce.ts';
import { ScLibrary } from '../src/sc/library.ts';

const data = loadGameData();
const DECK = ['Knight', 'Archer', 'Giant', 'Musketeer', 'Fireball', 'Arrows', 'MiniPekka', 'Valkyrie'];

/** Clips as in sc/ui.sc: printScore_* 102 frames ("start" 16) with star1..3 (66 frames), finalScore 66,
 * print_tiebreaker 75, duel_battle_draw 70; all 30 fps. */
function lib(): ScLibrary {
  const clip = (n: number, extra: Record<string, unknown> = {}) => ({ fps: 30, n: new Array(n).fill(0), e: [], c: [], k: 0, ...extra });
  const star = { lb: { 0: 'noStar', 19: 'noStar_end', 20: 'newStar', 45: 'newStar_end', 46: 'oldStar', 65: 'oldStar_end' } };
  const score = { c: [10, 10, 10], nm: ['star1', 'star2', 'star3'], lb: { 16: 'start', 87: 'end' } };
  return new ScLibrary({
    v: 1, name: 'ui', tex: [], shapes: {}, banks: [{ m: [], c: [] }],
    clips: {
      10: clip(66, star), 1: clip(102, score), 2: clip(102, score), 3: clip(66), 4: clip(75), 5: clip(70),
      6: clip(39), 7: clip(60),
    },
    exports: { printScore_player: 1, printScore_enemy: 2, finalScore: 3, print_tiebreaker: 4, duel_battle_draw: 5,
      print_endTimer: 6, print_30secondsLeft: 7 },
  } as never, []);
}

type Peek = { tiebreaker: unknown; drawClip: unknown; finalScore: unknown; printPlayer: ScorePrint; printEnemy: ScorePrint };
const peek = (a: Announcements) => a as unknown as Peek;
const DT = 1 / 60;

test('crown-score print 0x8e86e8: shown from the crown until the 102-frame clip has run (3.4 s)', () => {
  const p = new ScorePrint(lib(), 'printScore_player', 'You');
  assert.equal(p.visible, false);
  p.update(DT, 0);
  assert.equal(p.visible, false);
  let frames = 0;
  p.update(DT, 1);
  while (p.visible) { frames++; p.update(DT, 1); }
  // update k leaves the timer at 0.001 + k/60 s; it reaches 102/30 s on update 204, so the print is up
  // after updates 1..203
  assert.equal(frames, 203);
});

test('print_tiebreaker on the first update with the tiebreak clock past 1000 ms, once', () => {
  const b = new Battle(data, { seed: 1, decks: [DECK, DECK], noShuffle: true });
  const a = new Announcements(lib(), () => '');
  b.run(6000);
  let shownAt = -1;
  while (b.tiebreakMs <= 1200) {
    b.step();
    a.update(0.05, b);
    if (shownAt < 0 && peek(a).tiebreaker) shownAt = b.tiebreakMs;
  }
  assert.equal(shownAt, 1050);
  assert.equal(peek(a).drawClip, null);
});

test('finalScore once the battle is over and both prints are hidden; never in BestOfGame', () => {
  for (const bestOfGame of [false, true]) {
    const b = new Battle(data, { seed: 1, decks: [DECK, DECK], noShuffle: true, bestOfGame });
    const a = new Announcements(lib(), () => '');
    b.run(5990);
    b.players[1].princess[0].hp -= 100; // side 1 loses the tiebreak (or, in BestOfGame, the drain)
    let endFrame = -1, finalFrame = -1, drawFrame = -1, frame = 0;
    while (frame < 20000 && finalFrame < 0) {
      if (!b.result) b.step();
      a.update(0.05, b);
      if (b.result && endFrame < 0) endFrame = frame;
      if (peek(a).drawClip && drawFrame < 0) drawFrame = frame;
      if (peek(a).finalScore) finalFrame = frame;
      frame++;
      if (bestOfGame && b.result && frame > endFrame + 200) break;
    }
    assert.ok(endFrame > 0);
    if (bestOfGame) {
      assert.equal(finalFrame, -1);
    } else {
      // the tower fell on the tick before the end: the player's print (side 0 took the crown) shows from
      // that update until its timer, 0.001 + 0.05 k s, reaches 3.4 s on update k = 68; finalScore
      // appears on that update, 66 updates after the one that saw the result
      assert.equal(peek(a).printPlayer.visible, false);
      assert.equal(finalFrame - endFrame, 66);
    }
    assert.equal(drawFrame, -1); // unequal towers: no draw clock
  }
});

test('duel_battle_draw when the BestOfGame draw clock starts', () => {
  const b = new Battle(data, { seed: 1, decks: [DECK, DECK], noShuffle: true, bestOfGame: true });
  const a = new Announcements(lib(), () => '');
  b.run(6000);
  for (;;) {
    b.step();
    a.update(0.05, b);
    if (b.drawMs !== 0) break;
    assert.equal(peek(a).drawClip, null);
  }
  assert.equal(b.drawMs, 50);
  assert.ok(peek(a).drawClip);
});
