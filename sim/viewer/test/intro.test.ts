// Battle intro banner (viewer/src/sc/intro.ts) and the MovieClip runtime under it
// (viewer/src/sc/movieclip.ts), on stand-in libraries with the frame counts, labels and child names of
// sc/ui_battle_banners.sc.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScLibrary } from '../src/sc/library.ts';
import { lerpCol, lerpMat, McNode } from '../src/sc/movieclip.ts';
import { BattleIntro, introHudVisible, stretchScale } from '../src/sc/intro.ts';

type ClipJson = { fps: number; n: number[]; e: number[]; c: number[]; k: number; nm?: string[]; lb?: Record<string, string> };

/** A clip of `frames` frames showing child i in frame f when shown(i, f). */
function clip(frames: number, kids: number[], names: string[], shown: (i: number, f: number) => boolean = () => true,
  lb: Record<number, string> = {}): ClipJson {
  const n: number[] = [], e: number[] = [];
  for (let f = 0; f < frames; f++) {
    let k = 0;
    for (let i = 0; i < kids.length; i++) if (shown(i, f)) { e.push(i, -1, -1); k++; }
    n.push(k);
  }
  return { fps: 60, n, e, c: kids, k: 0, nm: names, lb: Object.fromEntries(Object.entries(lb).map(([f, s]) => [f, s])) };
}

/** battle_intro_banners as in sc/ui_battle_banners.sc (290 frames, holdFrame 158, actionFrame 159; vs
 * on the display list from frame 18; player / enemy with banner, name, trophies, rating). */
function bannersLib(): ScLibrary {
  const clips: Record<string, ClipJson> = {
    // shape-less leaves
    118: clip(1, [], []), 120: clip(1, [], []),
    119: clip(1, [118], ['dimmer_bg_stretch']), 121: clip(1, [120], ['gradient_stretch_h']),
    126: clip(255, [], [], undefined, { 32: 'start', 136: 'hold_start', 254: 'hold_end' }),
    127: clip(189, [], []),
    128: clip(1, [], []), 129: clip(1, [99], ['name']), 132: clip(1, [], []), 135: clip(2, [], [], undefined, { 0: 'league', 1: 'rating' }),
    136: clip(1, [128, 129, 132, 135], ['banner', 'name', 'trophies', 'rating']),
    145: clip(1, [106, 143], ['txt', 'txt_fight']), 143: clip(1, [98], ['TID_FIGHT']), 150: clip(120, [], []),
    151: clip(290, [119, 121, 121, 126, 127, 136, 136, 145, 150, 143],
      ['dimmer', 'gradient_top', 'gradient_bottom', 'vs', 'vs_china', 'player', 'enemy', 'mode', 'mode_suddendeath', 'txt_fight'],
      (i, f) => (i === 3 || i === 4 ? f >= 18 : true), { 0: 'start_sound', 158: 'holdFrame', 159: 'actionFrame' }),
    // banner object clips
    152: clip(1, [], []), 153: clip(1, [], []), 134: clip(1, [], []), 155: clip(1, [], []),
    156: clip(1, [155, 155, 155], ['badge1', 'badge2', 'badge3']), 158: clip(1, [155], ['badge1_active']), 159: clip(1, [155], ['badge1']),
    162: clip(1, [152, 153, 134, 156, 158, 159], ['shadow', 'banner_bg', 'banner_fg', 'badges', 'badges_editor', 'badges_profile']),
    186: clip(1, [], []), 183: clip(1, [], []),
  };
  const tf = (id: number) => ({ font: 'Supercell-Magic', text: '', rect: [0, 0, 10, 10] as [number, number, number, number], color: -1, outline: 0, bytes: [0, 0, 20, 0] as [number, number, number, number] });
  return new ScLibrary({
    v: 1, name: 'ui_battle_banners', tex: [], shapes: {}, banks: [{ m: [], c: [] }], clips,
    exports: { battle_intro_banners: 151, battle_banner: 162, banner_bg_default_green: 186, banner_fg_default_green: 183 },
    tf: { 98: tf(98), 99: tf(99), 106: tf(106) },
  } as never, []);
}

const ART = { sc: 'ui_battle_banners', export: 'battle_intro_banners', banner: 'battle_banner', bannerBg: 'banner_bg_default_green', bannerFg: 'banner_fg_default_green' };
const DT = 1 / 60;

test('MovieClip: one frame per render step, stops at the end of an unlooped range (0x123f55c, 0x123f458)', () => {
  const lib = bannersLib();
  const vs = McNode.of(lib, 'battle_intro_banners')!.child('vs')!;
  vs.playRange(0, 254, false);
  vs.step(DT); // the first step only accumulates time
  assert.equal(vs.frame, 0);
  for (let i = 0; i < 10; i++) vs.step(DT);
  assert.equal(vs.frame, 10);
  for (let i = 0; i < 400; i++) vs.step(DT);
  assert.equal(vs.frame, 254);
  assert.equal(vs.state, 2);
  // a slow frame still moves one frame only (mode 0) and consumes the whole multiple of the frame time
  vs.playRange(0, 254, false);
  vs.step(0.1); vs.step(0.1);
  assert.equal(vs.frame, 1);
  assert.ok(vs.acc < vs.ft + 0.1);
});

test('MovieClip: a child advances only while on its parent\'s display list (0x1252f60 over 0x123f7b4)', () => {
  const lib = bannersLib();
  const root = McNode.of(lib, 'battle_intro_banners')!;
  const vs = root.child('vs')!;
  root.playRange(0, root.frames - 1, false);
  vs.playRange(0, vs.frames - 1, false);
  for (let i = 0; i < 18; i++) root.advance(DT); // root frames 0..17: vs not displayed
  assert.equal(root.frame, 17);
  assert.equal(vs.frame, 0);
  root.advance(DT); // root reaches 18 and renders vs (its first step only accumulates)
  assert.equal(vs.frame, 0);
  root.advance(DT);
  assert.equal(vs.frame, 1);
});

test('MovieClip: mode 1 moves all due frames without passing the end; play-to walks backwards (0x12422a4)', () => {
  const lib = bannersLib();
  const vs = McNode.of(lib, 'battle_intro_banners')!.child('vs')!;
  vs.mode = 1;
  vs.setFrameTime(0.008163);
  vs.playRange(30, 79, false);
  vs.step(DT);
  vs.step(DT); // 1/60 s at 0.008163 s per frame: 2 frames
  assert.equal(vs.frame, 32);
  for (let i = 0; i < 50; i++) vs.step(DT);
  assert.equal(vs.frame, 79);
  assert.equal(vs.state, 2);
  const b = McNode.of(lib, 'battle_intro_banners')!.child('vs')!;
  b.gotoAndStop(10);
  b.playTo(7);
  assert.equal(b.state, 1);
  b.step(DT); b.step(DT);
  assert.equal(b.frame, 9);
  b.step(DT); b.step(DT);
  assert.equal(b.frame, 7);
  assert.equal(b.state, 2);
});

test('MovieClip: interpolation of 0x123e96c / 0x124439c', () => {
  const m = lerpMat(0.5, [1, 0, 0, 1, 0, 0], [3, 0, 0, 3, 10, -20]);
  assert.ok(Math.abs(m[0] - 2) < 1e-5 && Math.abs(m[3] - 2) < 1e-5);
  assert.ok(Math.abs(m[1]) < 1e-5 && Math.abs(m[2]) < 1e-5);
  assert.equal(m[4], 5);
  assert.equal(m[5], -10);
  // a quarter turn halfway: 45 degrees
  const r = lerpMat(0.5, [1, 0, 0, 1, 0, 0], [0, 1, -1, 0, 0, 0]);
  assert.ok(Math.abs(r[0] - Math.SQRT1_2) < 1e-5 && Math.abs(r[1] - Math.SQRT1_2) < 1e-5);
  // colours lerp on the bytes and truncate
  const c = lerpCol(0.5, [1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 1, 0, 0, 10]);
  assert.equal(c[3], 127 / 255);
  assert.equal(c[6], 5);
});

test('intro: what a ladder 1v1 shows (0x8c81b8)', () => {
  const lib = bannersLib();
  const it = new BattleIntro(lib, ART, { player: 'You', enemy: 'Opponent' });
  const root = it.root;
  assert.equal(it.actionFrame, 159);
  assert.equal(it.holdFrame, 158);
  assert.equal(root.child('txt_fight')!.visible, false);
  assert.equal(root.child('mode')!.visible, true);
  assert.equal(root.child('mode')!.child('txt_fight')!.visible, true);
  assert.equal(root.child('mode_suddendeath')!.visible, false);
  assert.equal(root.child('vs_china')!.visible, false);
  for (const side of ['player', 'enemy']) {
    const p = root.child(side)!;
    assert.equal(p.child('trophies')!.visible, false);
    assert.equal(p.child('rating')!.visible, false);
    const banner = p.slots[p.index('banner')]!.replace!;
    assert.equal(banner.clip.id, 162);
    assert.equal(banner.slots[banner.index('banner_bg')]!.replace!.clip.id, 186);
    assert.equal(banner.slots[banner.index('banner_fg')]!.replace!.clip.id, 183);
    assert.equal(banner.child('badges')!.child('badge1')!.visible, false);
    assert.equal(banner.child('badges_editor')!.visible, false);
  }
  const pn = root.child('player')!.child('name')!;
  assert.equal(pn.slots[pn.index('name')]!.text, 'You');
});

test('intro: HUD hidden and input blocked until actionFrame, removed after its last frame (0xbe1d3c)', () => {
  const lib = bannersLib();
  const it = new BattleIntro(lib, ART, { player: 'You', enemy: 'Opponent' });
  const flag = { on: true };
  let intro: BattleIntro | null = it;
  let shownAt = -1, goneAt = -1;
  for (let n = 1; n <= 400; n++) {
    // battle screen update: the intro's update and deletion, then the HUD gate; then the render advance
    if (intro) {
      intro.update(DT, false);
      if (intro.done) intro = null;
    }
    const v = introHudVisible(flag, intro);
    if (v && shownAt < 0) shownAt = n;
    if (!intro && goneAt < 0) goneAt = n;
    intro?.advance(DT);
  }
  // the render that reaches frame 159 is the 160th; the next update shows the HUD
  assert.equal(shownAt, 161);
  // frame 289 (the end, state 2) is reached by the 290th render; the next update deletes it
  assert.equal(goneAt, 291);
  assert.equal(flag.on, false);
});

test('intro: a card play halves the frame time and switches to interpolated catch-up (0x8ca764)', () => {
  const lib = bannersLib();
  const it = new BattleIntro(lib, ART, { player: 'You', enemy: 'Opponent' });
  for (let i = 0; i < 20; i++) { it.update(DT, false); it.advance(DT); }
  const f0 = it.root.frame;
  it.update(DT, true);
  assert.equal(it.spedUp, true);
  assert.equal(it.root.mode, 2);
  assert.ok(Math.abs(it.root.ft - 1 / 120) < 1e-6);
  it.advance(DT); it.advance(DT);
  assert.ok(it.root.frame >= f0 + 3);
});

test('intro: vs replays hold_start..hold_end once it stops (0x8ca764)', () => {
  const lib = bannersLib();
  const it = new BattleIntro(lib, ART, { player: 'You', enemy: 'Opponent' });
  const vs = it.root.child('vs')!;
  let held = false;
  for (let n = 0; n < 300; n++) {
    it.update(DT, false);
    if (vs.start === 136 && vs.end === 254) held = true;
    it.advance(DT);
  }
  assert.ok(held);
});

test('intro: the stretch helper covers the stage, never shrinks (0x89a38c)', () => {
  // dimmer_bg_stretch 826 x 1602.4 under the 1.1 slot: a 1828 x 1024 stage stretches x only
  const [sx, sy] = stretchScale([-413, -801.2, 413, 801.2], [1.1, 0, 0, 1.1, 0, 0], 1828, 1024, true, true);
  assert.ok(Math.abs(sx - 1828 / (826 * 1.1)) < 1e-4);
  assert.equal(sy, 1);
  assert.deepEqual(stretchScale([-10, -200, 10, 200], [45.53, 0, 0, 1.18, 0, 0], 578, 1024, true, false), [1, 1]);
});
