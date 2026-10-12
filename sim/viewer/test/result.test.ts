// End-of-battle result screen (viewer/src/sc/result.ts) on a stand-in library with the frame counts,
// labels and child names of sc/ui_battle_end.sc's pvp_battle_end_new.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScLibrary } from '../src/sc/library.ts';
import { BattleScreens, endScreenDue, ResultScreen, resultKind } from '../src/sc/result.ts';

type ClipJson = { fps: number; n: number[]; e: number[]; c: number[]; k: number; nm?: string[]; lb?: Record<string, string> };

function clip(frames: number, kids: number[], names: string[], lb: Record<number, string> = {}): ClipJson {
  const n: number[] = [], e: number[] = [];
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < kids.length; i++) e.push(i, -1, -1);
    n.push(kids.length);
  }
  return { fps: 60, n, e, c: kids, k: 0, nm: names, lb: Object.fromEntries(Object.entries(lb)) };
}

function endLib(): ScLibrary {
  const crown = { 0: 'crown_idle', 1: 'crown_appear_start', 49: 'crown_appear_end' };
  const player = (extra: number[], extraNames: string[]) => clip(60,
    [492, 494, 503, 509, 509, 509, 512, ...extra], ['cushion_3', 'cushion_1', 'cushion_2', 'crown_2', 'crown_1', 'crown_3', 'player_name', ...extraNames],
    { 0: 'idle', 1: 'appear_start', 40: 'appear_end', 41: 'winner_start', 59: 'winner_end' });
  const clips: Record<string, ClipJson> = {
    463: clip(1, [], []), 461: clip(1, [], []), 458: clip(264, [], []), 549: clip(1, [], []), 557: clip(1, [], []), 483: clip(1, [], []),
    492: clip(20, [], []), 494: clip(20, [], []), 503: clip(20, [], []), 508: clip(80, [], []),
    509: clip(50, [508], ['crown'], crown), 512: clip(1, [314, 313], ['name', 'clan']), 513: clip(1, [], []), 435: clip(15, [], [], { 0: 'winner_start', 14: 'winner_end' }),
    518: player([513, 435], ['trophies', 'winner_txt']), 531: player([435], ['winner_txt']), 532: clip(20, [], []),
    558: clip(60, [463, 461, 458, 549, 549, 557, 483, 518, 531, 532],
      ['dimmer_stretch', 'loot', 'loot_season', 'ok_btn_single', 'ok_btn', 'again_btn', 'replay_btn', 'player_01', 'player_02', 'draw'],
      { 0: '0', 12: 'score_start', 28: 'score_end', 29: 'result_start', 59: 'result_end' }),
  };
  const tf = { font: 'Supercell-Magic', text: '', rect: [0, 0, 10, 10], color: -1, outline: 0, bytes: [0, 0, 20, 0] };
  return new ScLibrary({ v: 1, name: 'ui_battle_end', tex: [], shapes: {}, banks: [{ m: [], c: [] }], clips,
    exports: { pvp_battle_end_new: 558 }, tf: { 313: tf, 314: tf } } as never, []);
}

const ART = { sc: 'ui_battle_end', export: 'pvp_battle_end_new', endScreenDelay: 4000 };
const DT = 1 / 60;
const info = (kind: 1 | 2 | 3, own: number, opp: number) =>
  ({ kind, ownCrowns: own, oppCrowns: opp, ownName: 'You', oppName: 'Opponent', noClan: 'No Clan' });

test('result: due EndScreenDelay after the end (+0x198 = 1, +50 per tick; 0xd3581c)', () => {
  assert.equal(endScreenDue(79, 4000), false);
  assert.equal(endScreenDue(80, 4000), true);
  assert.equal(resultKind(-1, 0), 3);
  assert.equal(resultKind(1, 1), 1);
  assert.equal(resultKind(0, 1), 2);
});

test('result: setup of a win (0x8bc564, 0x8bc248, 0x8be288, 0x8bf730, 0x8c0bc4)', () => {
  const s = new ResultScreen(endLib(), ART, info(1, 2, 1));
  const root = s.root;
  for (const n of ['again_btn', 'ok_btn', 'replay_btn', 'draw', 'loot', 'loot_season']) assert.equal(root.child(n)!.visible, false, n);
  assert.equal(root.child('ok_btn_single')!.visible, true);
  const p1 = root.child('player_01')!, p2 = root.child('player_02')!;
  assert.equal(p1.child('winner_txt')!.visible, false);
  assert.equal(p2.child('winner_txt')!.visible, false);
  assert.equal(p1.child('trophies')!.visible, false);
  assert.equal(p1.frame, 1); // appear_start
  assert.equal(p1.child('crown_1')!.frame, 1); // crown_appear_start, stopped
  assert.equal(p1.child('crown_1')!.state, 2);
  const pn = p1.child('player_name')!;
  assert.equal(pn.slots[pn.index('name')]!.text, 'You');
  assert.equal(pn.slots[pn.index('clan')]!.text, 'No Clan');
  assert.equal(root.end, 28);
});

test('result: crowns every 0.3 s, opponent first, result 1 s after the last, then the winner (0x8c2b80)', () => {
  const s = new ResultScreen(endLib(), ART, info(1, 2, 1));
  const root = s.root, p1 = root.child('player_01')!, p2 = root.child('player_02')!;
  const started: string[] = [];
  const seen = new Set<string>();
  let resultAt = -1, winnerAt = -1;
  for (let n = 1; n <= 300; n++) {
    s.update(DT);
    for (const [who, p] of [['opp', p2], ['own', p1]] as const) {
      for (const i of [1, 2, 3]) {
        const c = p.child(`crown_${i}`)!;
        const key = `${who}${i}`;
        if (c.end === 49 && !seen.has(key)) { seen.add(key); started.push(`${key}@${n}`); }
      }
    }
    if (resultAt < 0 && root.end === 59) resultAt = n;
    if (winnerAt < 0 && p1.child('winner_txt')!.visible) winnerAt = n;
    s.advance(DT);
  }
  // root 0..28 takes 29 renders (frame 28 on the 29th); crown_1 of player_02 (the opponent) then at
  // once, the own crowns 0.3 s apart (18 updates at 60 fps)
  assert.deepEqual(started.map((x) => x.split('@')[0]), ['opp1', 'own1', 'own2']);
  const at = started.map((x) => +x.split('@')[1]);
  assert.equal(at[0], 30);
  assert.equal(at[1] - at[0], 18);
  assert.equal(at[2] - at[1], 18);
  // 1 s (60 updates) after the update that found all crowns shown
  assert.equal(resultAt, at[2] + 1 + 60);
  assert.ok(winnerAt > resultAt);
  assert.equal(p2.child('winner_txt')!.visible, false);
  assert.equal(p1.end, 59); // winner_start..winner_end
});

test('result: a landing crown starts its cushion and shakes the panel (0x8c2b80 / 0x8c1b9c)', () => {
  const s = new ResultScreen(endLib(), ART, info(2, 0, 1));
  const root = s.root, p2 = root.child('player_02')!;
  let shook = false, cushion = false;
  for (let n = 0; n < 120; n++) {
    s.update(DT);
    const off = root.slots[root.index('player_02')]?.offset;
    if (off && off[1] !== 0) shook = true;
    if (p2.child('cushion_1')!.end === 19) cushion = true;
    s.advance(DT);
  }
  assert.ok(shook);
  assert.ok(cushion);
});

test('screens: intro and result lifecycle in the battle screen (BattleScreens)', () => {
  const lib = endLib();
  const art = { manifest: { hud: { texts: { TID_YOU: 'You', TID_NO_CLAN: 'No Clan' }, result: ART } }, libs: { get: () => lib } };
  const sc = new BattleScreens();
  const b = { result: null as { winner: number; tick: number } | null, players: [{ crowns: 1 }, { crowns: 0 }] };
  sc.update(art, DT, 5000, b, 0, 'Opponent');
  assert.equal(sc.intro, null); // no intro art in this stand-in manifest
  assert.equal(sc.hudShown, true);
  b.result = { winner: 0, tick: 100 }; // the end tick finishes at 5050 ms
  sc.update(art, DT, 5050 + 79 * 50 + 49, b, 0, 'Opponent');
  assert.equal(sc.result, null);
  sc.update(art, DT, 5050 + 80 * 50, b, 0, 'Opponent'); // 80 ticks after the end tick
  assert.equal(sc.result!.kind, 1);
  assert.equal(sc.inputBlocked, true);
});
