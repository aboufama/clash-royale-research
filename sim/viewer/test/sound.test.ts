// Battle sound logic of viewer/src/sc/sound.ts (libg 160402020): the event admission and playlist
// helpers, 0xbdf1b0's threshold test, and the battle / HUD / result sound sequencing driven by the
// same state the viewer feeds them, played into a stub AudioContext (no WebAudio in node).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Battle } from '../../core/src/index.ts';
import { loadGameData } from '../../core/src/node.ts';
import {
  admit, battleClockSounds, BattleSounds, busAdmits, busSteals, dbToGain, drawPitch, drawVolume, HandSounds, Playlist,
  ScreenSounds, semitonesToRate, type SoundDoc, type SoundEventDef, sound, SoundRng, thresholdIndex, timerSounds,
} from '../src/sc/sound.ts';

const TIMES = [180, 60, 30, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const UI = ['extraTime', 'gameEndHorn', 'cardFlyIn', 'spellAvailable', 'selectSpell', 'deployTick', 'deployDing',
  'enemyDeployTick', 'enemyDeployDing', 'bannerSfx', 'namesOut', 'boardSlideIn', 'crown1', 'crown2', 'crown3'];

function ev(key: string, extra: Partial<SoundEventDef> = {}): SoundEventDef {
  return { path: `event:/${key}`, max: 64, steal: 3, prio: 0, len: 48000, inst: [{ k: 'wave', f: 0, t: 0 }], ...extra };
}

function fixture(): SoundDoc {
  const time = ['loc:start', 'ui:60s', 'ui:30s', ...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `ui:cd${n}`)];
  const music = { times: [180, 60, 30], battle: ['music:Battle', 'music:60s', 'music:30s'], extraTime: 'music:Sudden',
    ambient: 'amb', preResult: 'music:Pre', win: 'music:Win', lose: 'music:Lose', draw: 'music:Draw', postResult: 'music:Post' };
  const ui: SoundDoc['ui'] = Object.fromEntries(UI.map((k) => [k, `ui:${k}`]));
  ui.rarity = { Legendary: { select: 'rar:select', available: null } };
  const keys = [...time, ...music.battle, music.extraTime, music.ambient, music.preResult, music.win, music.lose, music.draw,
    music.postResult, ...UI.map((k) => `ui:${k}`), 'rar:select'];
  return { v: 1, files: [], events: Object.fromEntries(keys.map((k) => [k, ev(k)])), ui, effects: {}, cast: {},
    time: { times: TIMES, sounds: time }, music };
}

/** A stub audio clock: play() admits and logs instances; voices find no decoded buffer (files: []). */
const clock = { currentTime: 0, state: 'running', resume: async () => {}, suspend: async () => {} };
function fresh(doc = fixture()): void {
  sound.stopAll();
  sound.doc = doc;
  (sound as unknown as { loading: Promise<void> }).loading = Promise.resolve(); // no fetch of sounds.json
  sound.ctx = clock as unknown as AudioContext;
  sound.enabled = true;
  sound.setPaused(false);
  sound.log.length = 0;
}
const played = (kind?: string) => sound.log.filter((e) => e.ok && e.kind !== 'voice' && (!kind || e.kind === kind)).map((e) => e.name);

test('dB / semitone conversions', () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.001);
  assert.equal(dbToGain(-80), 0);
  assert.equal(semitonesToRate(12), 2);
  assert.ok(Math.abs(semitonesToRate(-12) - 0.5) < 1e-12);
});

test('0xbdf1b0 thresholds: the first t with secs <= t < prev; time sounds skip t > 10 in overtime', () => {
  assert.equal(thresholdIndex([180, 60, 30], 180, 99999999), 0); // the setup call
  assert.equal(thresholdIndex([180, 60, 30], 179, 180), -1);
  assert.equal(thresholdIndex([180, 60, 30], 60, 61), 1);
  assert.equal(thresholdIndex([180, 60, 30], 60, 60), -1); // no repeat on the same second
  assert.equal(thresholdIndex([180, 60, 30], 25, 99999999), 0); // several crossed: list order wins
  assert.equal(thresholdIndex(TIMES, 60, 61, true, true), -1); // overtime: no 60 s warning
  assert.equal(thresholdIndex(TIMES, 10, 11, true, true), 3);
  assert.equal(thresholdIndex(TIMES, 60, 61, false, true), 1);
});

test('event admission: cooldown, max instances, stealing', () => {
  assert.deepEqual(admit({ max: 2, steal: 3 }, 1, undefined, []), { ok: true, steal: null });
  assert.deepEqual(admit({ max: 2, steal: 3 }, 1, 0.9, [4, 5]), { ok: false, steal: null });
  assert.deepEqual(admit({ max: 2, steal: 0 }, 1, 0.9, [4, 5]), { ok: true, steal: 4 });
  assert.deepEqual(admit({ max: 8, steal: 0, cooldown: 0.2 }, 1, 0.9, []), { ok: false, steal: null });
  assert.deepEqual(admit({ max: 8, steal: 0, cooldown: 0.2 }, 1.25, 1, []), { ok: true, steal: null });
});

test('bus instance limits: admission (0x13a460) and registration with stealing (0x13a570)', () => {
  const lists: Record<string, number[]> = { 'bus:/A': [3, 7], 'bus:/B': [7], 'bus:/N': [5] };
  const live = (b: string) => lists[b] ?? [];
  assert.equal(busAdmits(undefined, live), true);
  assert.equal(busAdmits([['bus:/A', 3, 0]], live), true); // not full
  assert.equal(busAdmits([['bus:/N', 1, 0]], live), false); // full, stealing none: refused
  assert.equal(busAdmits([['bus:/N', 1, 2]], live), true);
  assert.equal(busAdmits([['bus:/A', 2, 2], ['bus:/N', 1, 0]], live), true); // the first full bus decides
  assert.deepEqual(busSteals(undefined, live), []);
  assert.deepEqual(busSteals([['bus:/A', 2, 2]], live), [3]); // the oldest
  assert.deepEqual(busSteals([['bus:/A', 3, 2]], live), []); // room left
  assert.deepEqual(busSteals([['bus:/A', 2, 1]], live), []); // virtualize: no steal
  assert.deepEqual(busSteals([['bus:/A', 2, 0]], live), []);
  // a stolen instance leaves every bus: B's steal makes room on A
  assert.deepEqual(busSteals([['bus:/B', 1, 2], ['bus:/A', 2, 2]], live), [7]);
  assert.deepEqual(busSteals([['bus:/A', 2, 2], ['bus:/B', 1, 2]], live), [3, 7]);
});

test('a full bus with stealing none refuses a new instance; with stealing oldest it ends the oldest', () => {
  const doc = fixture();
  doc.v = 2;
  doc.events['vo:a'] = ev('vo:a', { bus: [['bus:/VO', 1, 0]] });
  doc.events['vo:b'] = ev('vo:b', { bus: [['bus:/VO', 1, 0]] });
  doc.events['m:a'] = ev('m:a', { bus: [['bus:/M/sub', 2, 2], ['bus:/M', 1, 2]] });
  doc.events['m:b'] = ev('m:b', { bus: [['bus:/M', 1, 2]] });
  fresh(doc);
  const a = sound.play('vo:a');
  assert.ok(a);
  assert.equal(sound.play('vo:b'), 0);
  assert.equal(sound.log.at(-1)?.why, 'bus max instances');
  const m1 = sound.play('m:a');
  const m2 = sound.play('m:b');
  assert.ok(m1 && m2 && sound.isPlaying(m2) && !sound.isPlaying(m1));
  assert.ok(sound.isPlaying(a), 'other buses are untouched');
});

test('the battle tracks hand over through bus:/Music/Arena: one instance, the oldest stolen', () => {
  const doc = fixture();
  doc.v = 2;
  const arena: [string, number, number][] = [['bus:/Music/Arena', 1, 2]];
  for (const k of [...doc.music.battle, doc.music.extraTime]) doc.events[k!] = ev(k!, { bus: arena });
  fresh(doc);
  const bs = new BattleSounds();
  bs.reset();
  const live = () => sound.log.filter((e) => e.ok && e.kind === 'music').map((e) => [e.name, sound.isPlaying(e.id)]);
  for (let s = 180; s >= 0; s--) {
    clock.currentTime = 180 - s;
    bs.update({ secs: s, overtime: false, ended: false, timeRanOut: false });
    if (s === 61) assert.deepEqual(live(), [['music:Battle', true]]);
    if (s === 60) assert.deepEqual(live(), [['music:Battle', false], ['music:60s', true]]);
    if (s === 30) assert.deepEqual(live(), [['music:Battle', false], ['music:60s', false], ['music:30s', true]]);
  }
  clock.currentTime = 181;
  bs.update({ secs: 120, overtime: true, ended: false, timeRanOut: false });
  assert.deepEqual(live(), [['music:Battle', false], ['music:60s', false], ['music:30s', false], ['music:Sudden', true]]);
  const sudden = sound.musicId;
  assert.ok(sudden && sound.musicPlaying());
  // the result jingles route elsewhere (bus:/Music/Jingle, no limit): Pre_result does not steal
  assert.ok(sound.play('music:Pre', 1, 'music') && sound.isPlaying(sudden));
});

test('a sounds.json without bus data (v 1) still plays one battle track at a time', () => {
  fresh();
  const bs = new BattleSounds();
  bs.reset();
  bs.update({ secs: 180, overtime: false, ended: false, timeRanOut: false });
  bs.update({ secs: 60, overtime: false, ended: false, timeRanOut: false });
  const m = sound.log.filter((e) => e.ok && e.kind === 'music');
  assert.deepEqual(m.map((e) => [e.name, sound.isPlaying(e.id)]), [['music:Battle', false], ['music:60s', true]]);
});

test('playlists: shuffle without repeats within a round or across rounds, sequential, weighted', () => {
  const rng = new SoundRng(7);
  const kids = [0, 1, 2, 3].map((f) => ({ k: 'wave', f }));
  const node = { k: 'multi', m: 2, e: kids.map((k) => [25, k] as [number, typeof k]) };
  const pl = new Playlist();
  const seq = Array.from({ length: 40 }, () => pl.pick(node, rng)!.f!);
  for (let r = 0; r < 10; r++) assert.deepEqual([...seq.slice(r * 4, r * 4 + 4)].sort(), [0, 1, 2, 3]);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  const s0 = new Playlist();
  assert.deepEqual(Array.from({ length: 5 }, () => s0.pick({ ...node, m: 0 }, rng)!.f), [0, 1, 2, 3, 0]);
  const w = new Playlist();
  const heavy = { k: 'multi', m: 1, e: [[90, kids[0]], [10, kids[1]]] as [number, { k: string; f: number }][] };
  const n0 = Array.from({ length: 2000 }, () => w.pick(heavy, rng)!.f).filter((f) => f === 0).length;
  assert.ok(n0 > 1700 && n0 < 1900, `weighted pick ${n0}`);
});

test('random modulators stay inside their ranges', () => {
  const rng = new SoundRng(3);
  for (let i = 0; i < 500; i++) {
    const v = drawVolume({ k: 'wave', vol: -3, rv: 4 }, rng);
    const p = drawPitch({ k: 'wave', pitch: 1, rp: 2 }, rng);
    assert.ok(v <= -3 && v >= -7);
    assert.ok(p >= 0 && p <= 2);
  }
  assert.equal(drawVolume({ k: 'wave' }, rng), 0);
});

test('a battle\'s clock sounds and music: start, 60 / 30 s, countdown, overtime, the horn', () => {
  fresh();
  const data = loadGameData();
  const deck = ['Knight', 'Archer', 'Giant', 'Musketeer', 'Fireball', 'Arrows', 'MiniPekka', 'Valkyrie'];
  const b = new Battle(data, { seed: 1, decks: [deck, deck], noShuffle: true });
  assert.ok(b.overtimeTicks > 0);
  const bs = new BattleSounds();
  bs.reset();
  const clockOf = (tick: number, overtime: boolean, result: { tick: number; reason: string } | null = null) =>
    battleClockSounds({ tick, overtime, regulationTicks: b.regulationTicks, overtimeTicks: b.overtimeTicks, result });
  for (let t = 0; t < b.regulationTicks; t++) { clock.currentTime = t * 0.05; bs.update(clockOf(t, false)); }
  const reg = played();
  assert.deepEqual(reg.slice(0, 3), ['amb', 'loc:start', 'music:Battle']);
  assert.ok(reg.indexOf('ui:60s') < reg.indexOf('music:60s'));
  assert.deepEqual(reg.filter((n) => n.startsWith('ui:cd')), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `ui:cd${n}`));
  assert.deepEqual(played('music'), ['music:Battle', 'music:60s', 'music:30s']);
  sound.log.length = 0;
  const end = b.regulationTicks + b.overtimeTicks;
  for (let t = b.regulationTicks; t < end; t++) { clock.currentTime = t * 0.05; bs.update(clockOf(t, true)); }
  const ot = played();
  assert.deepEqual(ot.slice(0, 2), ['ui:extraTime', 'music:Sudden']);
  assert.ok(!ot.includes('ui:60s') && !ot.includes('ui:30s') && !ot.includes('music:60s'));
  assert.deepEqual(ot.filter((n) => n.startsWith('ui:cd')).length, 10);
  sound.log.length = 0;
  bs.update(clockOf(end, true, { tick: end - 1, reason: 'tiebreak' }));
  bs.update(clockOf(end, true, { tick: end - 1, reason: 'tiebreak' }));
  assert.deepEqual(played(), ['ui:gameEndHorn']);
});

test('a king tower win before the time runs out plays no horn', () => {
  fresh();
  const bs = new BattleSounds();
  bs.reset();
  bs.update({ secs: 100, overtime: false, ended: false, timeRanOut: false });
  sound.log.length = 0;
  bs.update(battleClockSounds({ tick: 1700, overtime: false, regulationTicks: 3600, overtimeTicks: 2400, result: { tick: 1700, reason: 'king' } }));
  assert.deepEqual(played(), []);
});

test('switching sound back on restarts the battle music', () => {
  fresh();
  const bs = new BattleSounds();
  bs.reset();
  bs.update({ secs: 120, overtime: false, ended: false, timeRanOut: false });
  assert.deepEqual(played('music'), ['music:Battle']);
  sound.setEnabled(false);
  sound.setEnabled(true);
  sound.ctx = clock as unknown as AudioContext; // the stub stays (unlock found no AudioContext in node)
  sound.log.length = 0;
  bs.update({ secs: 119, overtime: false, ended: false, timeRanOut: false });
  assert.deepEqual(played(), ['amb', 'music:Battle']);
});

test('hand sounds: fly-in on entry, available on turning affordable, the rarity select sound', () => {
  fresh();
  const h = new HandSounds();
  h.card(0, -0.2, -1, false, -0.1, 3, false, 'Common'); // still entering
  h.card(0, -0.1, 3, false, 0.0, 3, false, 'Common'); // shows: card_fly_in
  h.card(0, 0.0, 3, false, 0.05, 3, true, 'Common'); // affordable: spell_available
  h.card(0, 0.05, 3, false, 0.1, 3, true, 'Common'); // still affordable: nothing
  h.card(1, -0.1, 5, false, 0.0, 5, true, 'Legendary'); // enters affordable: fly-in only
  h.select(1);
  h.select(0);
  assert.deepEqual(played(), ['ui:cardFlyIn', 'ui:spellAvailable', 'ui:cardFlyIn', 'rar:select', 'ui:selectSpell']);
  h.slide(0.2);
  h.slide(0.3);
  h.slide(0.5);
  assert.equal(played().filter((n) => n === 'ui:boardSlideIn').length, 1);
});

test('deploy timer ticks and ding per side', () => {
  fresh();
  timerSounds(0, 1, { ticks: 1, state: 1 }, true);
  timerSounds(1, 1, { ticks: 1, state: 1 }, true);
  timerSounds(3, 1, { ticks: 3, state: 2 }, false);
  assert.deepEqual(played(), ['ui:deployTick', 'ui:enemyDeployDing']);
});

test('intro and result screen sounds', () => {
  fresh();
  const s = new ScreenSounds();
  const intro = { beforeAction: true };
  s.update(intro, null, 0, 0);
  s.update(intro, null, 0, 0);
  intro.beforeAction = false;
  s.update(intro, null, 0, 0);
  s.update(null, null, 0, 0);
  assert.deepEqual(played(), ['ui:bannerSfx', 'ui:namesOut']);
  sound.log.length = 0;
  // the end screen stops every sound but the ambience (0xbe0100 -> 0xcbc8d4), then plays Pre_result
  const amb = sound.play('amb', 1, 'ambient');
  const music = sound.playMusic('music:30s');
  const fx = sound.play('ui:cd3', 1, 'time');
  sound.log.length = 0;
  const result = { shown: 0, resultShown: false };
  s.update(null, result, 1, 1, amb);
  assert.ok(sound.isPlaying(amb) && !sound.isPlaying(music) && !sound.isPlaying(fx));
  result.shown = 1; // the opponent's crown
  s.update(null, result, 1, 1);
  result.shown = 3; // both of the winner's
  s.update(null, result, 1, 1);
  result.resultShown = true;
  s.update(null, result, 1, 1);
  assert.deepEqual(played(), ['music:Pre', 'ui:crown1', 'ui:crown1', 'ui:crown2', 'music:Win']);
});

test('music whose sample is still decoding starts once decoded, at the position it would have reached', async () => {
  const doc = fixture();
  doc.files = [{ f: 'audio/m/000.ogg', n: 480000, ch: 2 }];
  doc.events['music:Battle'] = ev('music:Battle', { loop: [0, 480000], len: 480000, inst: [{ k: 'wave', f: 0, t: 0, len: 480000 }] });
  doc.events['ui:cd5'] = ev('ui:cd5'); // a one-shot on the same file: dropped while not decoded
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const starts: { when: number; off: number; loop: boolean }[] = [];
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } });
  const ctx = {
    ...clock, currentTime: 100,
    decodeAudioData: async () => { await gate; return { duration: 10, numberOfChannels: 2, length: 441000 }; },
    createGain: node,
    createBufferSource: () => {
      const src = { ...node(), buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: { value: 1 }, onended: null,
        start(when: number, off: number) { starts.push({ when, off, loop: src.loop }); }, stop() {} };
      return src;
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
  try {
    fresh(doc);
    sound.ctx = ctx as unknown as AudioContext;
    const id = sound.playMusic('music:Battle');
    sound.play('ui:cd5', 1, 'time');
    assert.ok(id && sound.musicPlaying(), 'the music instance waits for its sample');
    ctx.currentTime = 112.5; // decoded 12.5 s later
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(starts.length, 1, 'only the music voice starts');
    assert.ok(starts[0].loop && Math.abs(starts[0].off - 2.5) < 1e-9, `offset ${starts[0].off}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
