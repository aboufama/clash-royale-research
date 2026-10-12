// Emotes (viewer/src/sc/emotes.ts), the game button (sc/ui_button.ts) and the result screen's confetti point
// (sc/confetti.ts), ported from libg 160402020 (0x8cd4ec, 0x8d1228, 0x8d601c / 0x8d6820, 0x8e9284, 0x8ea3a4,
// 0x8ead78, 0x8eab24, 0x8e8f0c / 0x8e89d0, 0x8e920c / 0x8e8c38, 0x1273538 / 0x127386c, 0x8c08b0), on stand-in
// libraries with the names, labels and frame counts of sc/ui.sc's exports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScLibrary } from '../src/sc/library.ts';
import {
  bounceEase, bubbleExport, type EmoteArt, Emotes, followAxis, MENU_SLOTS, menuAreaPos,
} from '../src/sc/emotes.ts';
import { GameButton } from '../src/sc/ui_button.ts';
import { confettiPoint, layerLogic } from '../src/sc/confetti.ts';

type El = [number, number]; // [child index, matrix index]
type ClipJson = { fps: number; n: number[]; e: number[]; c: number[]; k: number; nm?: string[]; lb?: Record<string, string> };

/** A clip: `frames` frames of the same children (elements per frame from `at(f)` when given). */
function clip(frames: number, kids: number[], names: string[], els: El[] | ((f: number) => El[]), lb: Record<number, string> = {}): ClipJson {
  const n: number[] = [], e: number[] = [];
  for (let f = 0; f < frames; f++) {
    const fe = typeof els === 'function' ? els(f) : els;
    for (const [ci, mi] of fe) e.push(ci, mi, -1);
    n.push(fe.length);
  }
  return { fps: 60, n, e, c: kids, k: 0, nm: names, lb: Object.fromEntries(Object.entries(lb)) };
}

const SQUARE: [number, number[]][] = [[0, [-10, -10, 0, 0, 10, -10, 1, 0, -10, 10, 0, 1, 10, 10, 1, 1]]];
const tf = { font: 'Supercell-Magic', text: '', rect: [-20, -5, 20, 5] as [number, number, number, number], color: -1, outline: 0, bytes: [0, 0, 14, 0] as [number, number, number, number] };

// matrices: 0 identity, 1 scale 0.95 (Down), 2 (-266, -104) buttons, 3 (33, -45.25) taunt_button, 4 (33, -125.25) mute,
// 5 x3 scale, 6 x4 scale, 7..12 taunt_btn_01..06, 13 bubble player2 (141.9, -283.05), 14 bubble opponent2
// (-144.8, 109.05), 15 scale 1.05 (Clicked)
const M = [
  [1, 0, 0, 1, 0, 0], [0.95, 0, 0, 0.95, 0, 0], [1, 0, 0, 1, -266, -104], [1, 0, 0, 1, 33, -45.25], [1, 0, 0, 1, 33, -125.25],
  [3, 0, 0, 3, 0, 0], [4, 0, 0, 4, 0, 0],
  [1, 0, 0, 1, -99.8, -138.6], [1, 0, 0, 1, 52, -138.6], [1, 0, 0, 1, 203, -139], [1, 0, 0, 1, -100, -84], [1, 0, 0, 1, 51.8, -84], [1, 0, 0, 1, 202.8, -84.4],
  [1, 0, 0, 1, 141.9, -283.05], [1, 0, 0, 1, -144.8, 109.05], [1.05, 0, 0, 1.05, 0, 0],
];

function uiLib(): ScLibrary {
  const btn = (f: number): El[] => [[0, f >= 16 && f <= 22 ? 1 : f >= 5 && f <= 13 ? 15 : -1]];
  const clips: Record<string, ClipJson> = {
    2: clip(70, [1], [''], btn, { 0: 'Idle', 1: 'IdleEnd', 4: 'Clicked', 14: 'ClickedEnd', 15: 'Down', 22: 'DownEnd', 23: 'IdleNotice', 69: 'IdleNoticeEnd' }),
    14: clip(1, [1], [''], [[0, -1]]),
    12: clip(1, [1, 14], ['', 'muted'], [[0, 5], [1, -1]]),
    13: clip(2, [1], [''], [[0, 5]], { 0: '1', 1: '2' }),
    11: clip(25, [12, 13], ['taunt_button', 'mute_btn'], [[0, 3], [1, 4]], { 0: 'idle', 1: 'duel_start' }),
    10: clip(1, [11], ['buttons'], [[0, 2]]),
    21: clip(16, [], [], []), 22: clip(1, [1], [''], [[0, 6]]), 24: clip(1, [1], [''], [[0, -1]]),
    23: clip(1, [1, 100], ['', 'txt'], [[0, 5], [1, -1]]),
    20: clip(1, [21, 22, 23, 23, 23, 23, 23, 23, 24],
      ['emotes', 'panel', 'taunt_btn_01', 'taunt_btn_02', 'taunt_btn_03', 'taunt_btn_04', 'taunt_btn_05', 'taunt_btn_06', 'button_more'],
      [[0, -1], [1, -1], [2, 7], [3, 8], [4, 9], [5, 10], [6, 11], [7, 12], [8, -1]]),
    31: clip(1, [1], [''], [[0, 6]]), 32: clip(145, [1], [''], [[0, 6]]), 33: clip(1, [1], [''], [[0, -1]]), 34: clip(1, [1], [''], [[0, -1]]),
    30: clip(1, [31, 32, 33, 34], ['background', 'background_crystal', 'image', 'tag_new'], [[0, -1], [1, -1], [2, -1], [3, -1]]),
    35: clip(1, [1], [''], [[0, 6]]),
    36: clip(74, [1], [''], [[0, -1]]),
    41: clip(1, [31, 32, 34, 1], ['background', 'background_crystal', 'anim', ''], [[0, -1], [1, -1], [2, -1], [3, -1]]),
    40: clip(145, [41], ['bubble'], [[0, 13]]),
    42: clip(145, [41], ['bubble'], [[0, 14]]),
    45: clip(1, [1, 101], ['', 'txt'], [[0, -1], [1, -1]]),
    43: clip(145, [45], ['bubble'], [[0, 13]]),
    44: clip(145, [45], ['bubble'], [[0, 14]]),
  };
  return new ScLibrary({
    v: 1, name: 'ui', tex: [{ f: 't', w: 1, h: 1 }], shapes: { 1: SQUARE }, clips, banks: [{ m: M.flat(), c: [] }],
    exports: {
      button_timeline: 2, HUD_taunt: 10, taunt_selector_new: 20, emote_menu_sticker_btn: 30, emote_menu_empty_slot: 35,
      emote_downloading: 36, sticker_bubble_player2_master: 40, sticker_bubble_opponent2_master: 42,
      speech_bubble_player2_master: 43, speech_bubble_opponent2_master: 44,
    },
    tf: { 100: tf, 101: tf },
  } as never, []);
}

function packLib(): ScLibrary {
  const clips: Record<string, ClipJson> = {};
  const exports: Record<string, number> = {};
  for (let i = 1; i <= 4; i++) {
    clips[10 + i] = clip(145, [1], [''], [[0, -1]]);
    clips[20 + i] = clip(1, [1], [''], [[0, -1]]);
    exports[`emote${i}`] = 10 + i;
    exports[`icon${i}`] = 20 + i;
  }
  return new ScLibrary({ v: 1, name: 'emotes_king_01_dl', tex: [{ f: 't', w: 1, h: 1 }], shapes: { 1: SQUARE }, clips,
    banks: [{ m: M.flat(), c: [] }], exports } as never, []);
}

const ART: EmoteArt = {
  ui: 'ui',
  emotes: [0, 1, 2, 3].map((lo) => ({ name: `Emote${lo}`, hi: 1, lo, sc: 'emotes_king_01_dl', clip: `emote${lo + 1}`, icon: `icon${lo + 1}`,
    crystal: false, frames: 145, sfx: `emotes/e${lo}.ogg` })),
  taunts: [1, 2, 3, 4, 5, 6].map((i) => ({ index: i - 1, name: `Taunt${i}`, tid: `TID_EMOTE${i}`, btn: `taunt_btn_0${i}`, sound: null })),
  texts: { TID_EMOTE1: 'Good luck!', TID_TAUNT_LIMIT_FULL: 'limit', TID_NO_TAUNT_DUE_TO_MUTE: 'muted', TID_EMOTE_MISSING: 'missing' },
  clickSound: 'click',
  globals: { showTime: 4, cooldown10: 20, limit: 100, soundCooldown: 3000 },
};

function setup() {
  const ui = uiLib(), pack = packLib();
  const e = new Emotes(ui, ART, { get: (n) => (n === 'ui' ? ui : n === 'emotes_king_01_dl' ? pack : undefined) });
  const log: string[] = [];
  e.hooks = { click: () => log.push('click'), sfx: (p) => log.push(`sfx ${p}`), popup: (t) => log.push(`popup ${t}`) };
  return { e, log };
}

const W = 1150, H = 1024, CX = 575;

test('emotes: bubble exports by the opponent flag and the sender index (0x8e8f0c / 0x8e89d0)', () => {
  assert.equal(bubbleExport(true, false), 'sticker_bubble_player2_master');
  assert.equal(bubbleExport(true, true), 'sticker_bubble_opponent2_master');
  assert.equal(bubbleExport(false, false), 'speech_bubble_player2_master');
  assert.equal(bubbleExport(false, true), 'speech_bubble_opponent2_master');
  // a 2v2 team-mate (index >= 2) gets the other pair
  assert.equal(bubbleExport(true, false, 2), 'sticker_bubble_player_master');
  assert.equal(bubbleExport(true, true, 2), 'sticker_bubble_opponent_master');
});

test('emotes: menu layout (0x8e9284 / 0x8ea3a4) and the item bounce 0x1208868', () => {
  assert.deepEqual(menuAreaPos(1150.56, 1024), [385, 634]);
  assert.deepEqual(MENU_SLOTS[0], [51, 43.5]);
  assert.deepEqual(MENU_SLOTS[7], [357, 130.5]);
  assert.equal(bounceEase(0.8, 1, -0.1, 0.2, 1, 1), 0.8);
  assert.equal(bounceEase(0.8, 1, 0, 0.2, 1, 1), 1);
  assert.ok(Math.abs(bounceEase(0.8, 1, 0.5, 0.2, 1, 1) - 1.1) < 1e-6);
  assert.equal(bounceEase(0.8, 1, 1.5, 0.2, 1, 1), 1);
});

test('emotes: 0x8e8c38 follows per axis (snap within 0.2 px, else (target + cur (k - 0.39)) / (k + 0.61))', () => {
  assert.equal(followAxis(100.1, 100, 1 / 60), 100);
  const k = 0.2251 * 60;
  assert.ok(Math.abs(followAxis(0, 100, 1 / 60) - 100 / (k + 0.61)) < 1e-3);
  assert.equal(followAxis(0, 100, 0.0005), 0); // no move below dt 0.001
});

test('emotes: an own emote shows its bubble at the bottom, an opponent one at the top, with sounds (0x8d6820)', () => {
  const { e, log } = setup();
  e.receive(true, { emote: ART.emotes[1] }, CX, H);
  assert.equal(e.bubbles.length, 1);
  const b = e.bubbles[0];
  assert.equal(b.opponent, false);
  assert.deepEqual([b.x, b.y], [CX, H]);
  assert.equal(b.root.clip.id, 40); // sticker_bubble_player2_master
  const bubble = b.root.child('bubble')!;
  assert.equal(bubble.child('anim')!.visible, false);
  assert.equal(bubble.added.length, 1);
  assert.deepEqual(bubble.added[0].m, [1, 0, 0, 1, 0, 34.5]); // the loader (150, 150) in the area (-150, -115.5)
  assert.equal(b.emoteClip!.state, 0); // played once
  assert.deepEqual(log, ['sfx emotes/e1.ogg']);
  e.receive(false, { emote: ART.emotes[0] }, CX, H);
  assert.equal(e.bubbles[0].opponent, true);
  assert.deepEqual([e.bubbles[0].x, e.bubbles[0].y], [CX, 0]);
  assert.equal(e.bubbles[0].root.clip.id, 42); // sticker_bubble_opponent2_master, inserted at index 0
});

test('emotes: the opponent\'s 1 s gate, the sender\'s earlier bubble ends, life SHOW_TAUNT_TIME_SEC (0x8d6820 / 0x8e920c)', () => {
  const { e } = setup();
  const none = () => null;
  e.receive(false, { emote: ART.emotes[0] }, CX, H);
  e.receive(false, { emote: ART.emotes[1] }, CX, H); // within 1 s: dropped
  assert.equal(e.bubbles.length, 1);
  assert.equal(e.oppCount, 2);
  for (let i = 0; i < 61; i++) e.update(1 / 60, true, none);
  e.receive(false, { emote: ART.emotes[2] }, CX, H);
  assert.equal(e.bubbles.length, 2);
  assert.equal(e.bubbles[1].life, 0); // the earlier one ends with the next update
  e.update(1 / 60, true, none);
  assert.equal(e.bubbles.length, 1);
  // visible while its clip plays; deleted when the 4 s are spent
  const b = e.bubbles[0];
  for (let i = 0; i < 145; i++) { e.update(1 / 60, true, none); e.advance(1 / 60); }
  assert.equal(b.root.state, 2);
  e.update(1 / 60, true, none);
  assert.equal(b.visible, false);
  for (let i = 0; i < 4 * 60; i++) e.update(1 / 60, true, none);
  assert.equal(e.bubbles.length, 0);
});

test('emotes: muted, hidden HUD and the taunt limit (0x8d601c / 0x8d6820)', () => {
  const { e, log } = setup();
  e.muted = true;
  e.receive(true, { emote: ART.emotes[0] }, CX, H);
  e.receive(false, { emote: ART.emotes[0] }, CX, H);
  assert.equal(e.bubbles.length, 0);
  assert.deepEqual(log, ['popup muted']);
  e.muted = false;
  e.update(0, false, () => null); // HUD hidden (+0x29c)
  e.receive(true, { emote: ART.emotes[0] }, CX, H);
  assert.equal(e.bubbles.length, 0);
  e.update(0, true, () => null);
  e.ownCount = 99;
  e.receive(true, { emote: ART.emotes[0] }, CX, H);
  assert.equal(e.bubbles.length, 0);
  assert.equal(log.at(-1), 'popup limit');
});

test('emotes: the menu opens from the taunt button, sends an emote, cools down 2 s (0x8d15c0 / 0x8eab24)', () => {
  const { e, log } = setup();
  // the taunt button: HUD_taunt (W/2, H) + buttons (-266, -104) + taunt_button (33, -45.25), 3x the square
  const tx = W / 2 - 266 + 33, ty = H - 104 - 45.25;
  assert.equal(e.pointerDown(tx, ty, W, H), true);
  assert.equal(e.tauntBtn.state, 1);
  assert.equal(e.pointerUp(tx, ty, W, H), null);
  assert.deepEqual(log, ['click']);
  assert.equal(e.menuOpen, true);
  const menu = e.menu!;
  assert.equal(menu.items.length, 8);
  assert.deepEqual(menu.items.map((it) => it.emote?.lo ?? null), [null, null, null, null, 0, 1, 2, 3]);
  assert.deepEqual(menu.items.map((it) => it.scale), [0.75, 0.75, 0.75, 0.75, 1, 1, 1, 1]);
  assert.equal(menu.texts.length, 6);
  assert.equal(menu.texts[0].node.slots[menu.texts[0].node.index('txt')]!.text, 'Good luck!');
  for (const n of ['emotes', 'panel', 'button_more']) assert.equal(menu.root.child(n)!.visible, false, n);
  const buttons = e.taunt.child('buttons')!;
  assert.equal(buttons.child('taunt_button')!.visible, false); // hidden while open
  assert.equal(buttons.child('mute_btn')!.visible, true); // shown while open
  // the bounce of the emote items
  e.update(0.1, true, () => null);
  assert.ok(menu.items[5].scale > 1.05);
  // a click on Emote1 (item 5)
  const [ax, ay] = menuAreaPos(W, H);
  const [ix, iy] = [ax + MENU_SLOTS[5][0], ay + MENU_SLOTS[5][1]];
  assert.equal(e.pointerDown(ix, iy, W, H), true);
  const sent = e.pointerUp(ix, iy, W, H);
  assert.deepEqual(sent, { emote: ART.emotes[1] });
  assert.equal(e.menuOpen, false);
  assert.ok(Math.abs(menu.cooldown - 2) < 1e-6);
  // reopened within the cooldown: a click does nothing
  e.setMenu(true);
  assert.equal(e.pointerDown(ix, iy, W, H), true);
  assert.equal(e.pointerUp(ix, iy, W, H), null);
  assert.equal(e.menuOpen, true);
  // an empty slot after the cooldown: TID_EMOTE_MISSING, cooldown, closed
  e.update(2.1, true, () => null);
  const [ex, ey] = [ax + MENU_SLOTS[0][0], ay + MENU_SLOTS[0][1]];
  assert.equal(e.pointerDown(ex, ey, W, H), true);
  assert.equal(e.pointerUp(ex, ey, W, H), null);
  assert.equal(log.at(-1), 'popup missing');
  assert.equal(e.menuOpen, false);
  assert.ok(menu.cooldown > 1.9);
});

test('emotes: the mute button toggles muting and closes the menu; a battle touch closes it (0x8d15c0 / 0xbe1120)', () => {
  const { e } = setup();
  e.setMenu(true);
  const mx = W / 2 - 266 + 33, my = H - 104 - 125.25;
  assert.equal(e.pointerDown(mx, my, W, H), true);
  e.pointerUp(mx, my, W, H);
  assert.equal(e.muted, true);
  assert.equal(e.menuOpen, false);
  const buttons = e.taunt.child('buttons')!;
  assert.equal(buttons.child('taunt_button')!.child('muted')!.visible, true);
  assert.equal(buttons.child('mute_btn')!.frame, 1);
  e.setMenu(true);
  e.closeMenu();
  assert.equal(e.menuOpen, false);
});

test('game button: Down while held, Clicked on release over it, then Idle; outside it goes back to Idle (0x127386c)', () => {
  const b = new GameButton(uiLib());
  assert.equal(b.state, 0);
  b.press();
  assert.equal(b.template!.frame, 15);
  for (let i = 0; i < 10; i++) b.advance(1 / 60);
  assert.equal(b.template!.frame, 22);
  assert.deepEqual(b.matrix(), [0.95, 0, 0, 0.95, 0, 0]);
  assert.equal(b.release(true), true);
  assert.equal(b.state, 2);
  assert.equal(b.template!.frame, 4);
  for (let i = 0; i < 12; i++) b.advance(1 / 60);
  assert.equal(b.state, 0); // stopped on ClickedEnd -> Idle (0x1273474)
  b.press();
  b.move(false);
  assert.equal(b.state, 0);
  b.move(true);
  assert.equal(b.state, 1);
  assert.equal(b.release(false), false);
  assert.equal(b.state, 0);
});

test('confetti: the play point and the effect layer\'s logic units (0x8c08b0 / 0x8582a4)', () => {
  assert.deepEqual(confettiPoint(1150.5, 1024, false), [575, 512]);
  assert.deepEqual(confettiPoint(1150.5, 1024, true), [575, 472]);
  assert.deepEqual(layerLogic(575, 512), [19166, 21333]);
});
