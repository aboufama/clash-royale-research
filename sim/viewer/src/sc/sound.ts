// Battle sound (libg 160402020): the client's FMOD Studio playback, rebuilt on WebAudio.
//
//   sound.attach('assets');          // once; nothing loads until the first user gesture unlocks audio
//   sound.play('soundbanks/card_common_archer/card_common_archer_attack');   // resource name -> event
//   sound.update();                  // each frame: timed command instruments, finished instances
//
// How the client plays a sound (decompiles in work/native/decomp_sound/):
//  - by resource (0xcba648 with a data ref: effects, CastSound, client tables; 0xcba864 with a name):
//    the FMODSound resource holds an event path; the FMOD backend (0x1a57a10) plays it with
//    getEvent(path) -> createInstance -> start (0xcbc14c), keyed by an increasing id. Nothing else is
//    set on the instance: no 3D attributes, no volume (the only per-instance call is setPitch, 0xcbc74c,
//    from an effect whose speed +0xb0 is not 1, 0x82bf10 @0x82c0d0; the speed is set only by view
//    vt+0xc0 0x84f11c / vt+0xb8 0x84f200 through 0x82ccf0, and the only caller passing other than 1.0 is
//    the AttackStartEffect 0x83e524 with the buffs' AudioPitchModifier product 0xfc24e0), so every
//    sound is 2D at its authored level;
//  - logic-side sounds are effects too, played by a static name through a view (sc/char_effects.ts):
//    GenericDie / EnemyGenericDie (every death but crown towers, 0xf83990 / 0xf8d5bc), the crowd
//    reactions of a CrowdEffects location (CrowdTowerTakeDamage 0xfcb29c, CrowdDieBigUnit 0xf83990,
//    CrowdSummonBigUnit 0xd423bc) and the King tower's King_player_activate / King_enemy_activate
//    (king_tower.toml ActionPlayEffect);
//  - music (0xcbc880 with a music.csv row): the same, remembering the instance as the current music
//    (backend +8); 0xcbb4c4 stops it (allow fade-out), 0xcbc9ec tells whether it still plays;
//  - effects (0x82bf10): a component's Sound starts when the component does (age >= Time), muted
//    effects aside (0x82cd10); stopping (0x82d074, only with KillLoopingSoundsOnEnd = data +0xae,
//    0xe22094) or restarting (0x82be20) an effect keys its sounds off (0xcbc508: keyOff when the event
//    has a sustain point).
// The FMOD event model comes from the banks (tools/audio/fmod_bank.py, read against libfmodstudio's
// loader): timeline instruments at 48 kHz frame positions, multi-instrument playlists, instrument
// volume (dB) / pitch (semitones) / loop count / trigger delay / probability, random modulators,
// event max instances / stealing / cooldown, loop transitions, command instruments (stop event).
// Approximations (A, docs/FIDELITY.md): random modulator ranges (volume: 0..-amount dB; pitch:
// +-amount/2 st), playlist modes (2 shuffle, 1 weighted random, 0/3 sequential), stealing (0/1/2 stop
// the oldest instance), keyOff (looping voices stop looping), FMOD's 64-voice cap (new voices are
// dropped past it); bus effects, VCAs, snapshots, AHDSR / LFO modulators and parameters are not
// applied. The audio clock is the wall clock like FMOD's; a faster simulation speed plays the
// battle's events faster and the events' own limits (max instances, cooldown) thin them out.

import { assetFetch } from './asset_fetch.ts';

/** One instrument of a baked event (tools/audio/bake_audio.py `node`). */
export interface SoundNode {
  k: 'wave' | 'multi' | 'silence' | 'command' | string;
  /** timeline start (48 kHz frames; top-level instruments only) and placed length */
  t?: number;
  len?: number;
  vol?: number; // dB
  pitch?: number; // semitones
  lc?: number; // loop count, -1 = loop
  dl?: [number, number]; // trigger delay min, max (ms)
  p?: number; // trigger probability %
  so?: number; // start offset %
  rv?: number; // random volume modulator amount (dB)
  rp?: number; // random pitch modulator amount (semitones)
  f?: number; // wave: index into files
  m?: number; // multi: playlist mode
  e?: [number, SoundNode][]; // multi: [weight %, entry]
  c?: number; // command type (0 = stop event)
  tg?: string; // command target event path
  unsupported?: boolean;
}

export interface SoundEventDef {
  path: string;
  max: number;
  steal: number;
  prio: number;
  cooldown?: number; // s
  loop?: [number, number]; // timeline loop [destination, transition] (48 kHz frames)
  len: number;
  inst: SoundNode[];
}

export interface SoundDoc {
  v: number;
  files: { f: string; n: number; ch: number; name?: string }[];
  events: Record<string, SoundEventDef>;
  ui: Record<string, string | null> & { rarity?: Record<string, { select: string | null; available: string | null }> };
  effects: Record<string, string>;
  cast: Record<string, string>;
  time: { times: number[]; sounds: (string | null)[] };
  music: { times: number[]; battle: (string | null)[]; extraTime: string | null; preResult: string | null; win: string | null;
    lose: string | null; draw: string | null; postResult: string | null; ambient?: string | null };
  missing?: string[];
}

export const FRAME_RATE = 48000;
/** FMOD Studio System::initialize(64, ...) in 0xcbb1f0 */
export const MAX_VOICES = 64;

export function dbToGain(db: number): number {
  return db <= -80 ? 0 : Math.pow(10, db / 20);
}

export function semitonesToRate(st: number): number {
  return Math.pow(2, st / 12);
}

/** Deterministic xorshift for the playlist / modulator draws (FMOD seeds its own from time(), 0xcbb1f0). */
export class SoundRng {
  private s: number;
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
}

/**
 * Multi-instrument playlist (FMOD PLST: mode, entries with weights in %). Mode 2 (the default, 1370
 * of 1406 playlists) is taken as shuffle: a random order without a repeat until every entry played
 * and no immediate repeat across rounds; 1 as weighted random; 0 / 3 as sequential (A).
 */
export class Playlist {
  private order: number[] = [];
  private last = -1;
  private seq = 0;
  pick(node: SoundNode, rng: SoundRng): SoundNode | null {
    const e = node.e ?? [];
    if (e.length === 0) return null;
    if (e.length === 1) return e[0][1];
    const mode = node.m ?? 2;
    if (mode === 1) {
      const total = e.reduce((s, [w]) => s + Math.max(0, w), 0) || e.length;
      let r = rng.next() * total;
      for (const [w, n] of e) { r -= total === e.length ? 1 : Math.max(0, w); if (r < 0) return n; }
      return e[e.length - 1][1];
    }
    if (mode === 2) {
      if (this.order.length === 0) {
        const idx = e.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        if (idx[0] === this.last && idx.length > 1) [idx[0], idx[1]] = [idx[1], idx[0]];
        this.order = idx;
      }
      const i = this.order.shift()!;
      this.last = i;
      return e[i][1];
    }
    const i = this.seq % e.length;
    this.seq++;
    return e[i][1];
  }
}

/** Volume (dB) of one instrument trigger: its volume minus the random modulator's draw (A). */
export function drawVolume(node: SoundNode, rng: SoundRng): number {
  return (node.vol ?? 0) - (node.rv ? rng.next() * node.rv : 0);
}

/** Pitch (semitones) of one instrument trigger: its pitch +- half the random modulator's amount (A). */
export function drawPitch(node: SoundNode, rng: SoundRng): number {
  return (node.pitch ?? 0) + (node.rp ? (rng.next() - 0.5) * node.rp : 0);
}

/**
 * Event admission (FMOD event macros): an instance cannot start within `cooldown` s of the previous
 * start; at max instances a stealing mode 0..2 stops the oldest instance (returned), others refuse.
 */
export function admit(def: Pick<SoundEventDef, 'max' | 'steal' | 'cooldown'>, now: number, lastStart: number | undefined,
  liveIds: readonly number[]): { ok: boolean; steal: number | null } {
  if (def.cooldown && lastStart !== undefined && now - lastStart < def.cooldown) return { ok: false, steal: null };
  if (liveIds.length >= Math.max(1, def.max)) {
    if (def.steal <= 2) return { ok: true, steal: liveIds[0] };
    return { ok: false, steal: null };
  }
  return { ok: true, steal: null };
}

/**
 * 0xbdf1b0's threshold test (music: MUSIC_START_TIMES; sounds: SOUND_START_TIMES): the first
 * threshold t with secs <= t < prev (prev = the previous update's seconds left, 99999999 at the
 * screen setup 0xbde180); the time sounds skip thresholds above 10 in overtime. Returns the index.
 */
export function thresholdIndex(times: readonly number[], secs: number, prev: number, overtime = false, skipAbove10 = false): number {
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (skipAbove10 && overtime && t > 10) continue;
    if (secs <= t && t < prev) return i;
  }
  return -1;
}

// ------------------------------------------------------------------------------------- WebAudio

interface Voice { src: AudioBufferSourceNode; gain: GainNode; looping: boolean; ended: boolean }
interface Inst {
  id: number;
  key: string;
  def: SoundEventDef;
  start: number;
  voices: Voice[];
  pending: { at: number; node: SoundNode }[];
  music: boolean;
  /** looping voices waiting for their sample to decode */
  waiting: number;
}

export interface SoundLogEntry { t: number; name: string; kind: string; id: number; ok: boolean; why?: string }

export class SoundSystem {
  base = 'assets';
  doc: SoundDoc | null = null;
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private loading: Promise<void> | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private fetching = new Map<number, Promise<AudioBuffer | null>>();
  private insts = new Map<number, Inst>();
  private lastStart = new Map<string, number>();
  private playlists = new Map<SoundNode, Playlist>();
  private nextId = 1;
  private rng = new SoundRng();
  /** current music instance (FMOD backend +8) */
  musicId = 0;
  /** user preference: sound on (default) / muted; persisted per viewer */
  enabled = true;
  volume = 1;
  /** bumped when sound is switched back on, so looping battle sounds (music, ambience) restart */
  generation = 0;
  /** the simulation is paused: audio suspended */
  private paused = false;
  /** recent plays, for tests and the browser check (window.__soundLog) */
  readonly log: SoundLogEntry[] = [];
  logLimit = 4000;
  private attached = false;

  attach(base = 'assets'): void {
    if (this.attached) return;
    this.attached = true;
    this.base = base.replace(/\/$/, '');
    try { const v = localStorage.getItem('cr.sound'); if (v === '0') this.enabled = false; } catch { /* storage blocked */ }
    if (typeof window === 'undefined') return;
    const unlock = () => { this.unlock(); };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });
    (window as unknown as { __sound?: SoundSystem }).__sound = this;
  }

  /** First user gesture: create / resume the AudioContext (browsers require a gesture) and load. */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended' && !this.paused) void this.ctx.resume();
    void this.load();
  }

  get ready(): boolean { return !!this.ctx && !!this.doc && this.enabled; }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem('cr.sound', on ? '1' : '0'); } catch { /* ignore */ }
    if (on) { this.generation++; this.unlock(); }
    else this.stopAll();
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else if (this.enabled) void this.ctx.resume();
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const r = await assetFetch(`${this.base}/audio/sounds.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.doc = await r.json() as SoundDoc;
      } catch (e) {
        console.warn('sound: no audio/sounds.json (run tools/art/bake_web.py)', e);
        return;
      }
      // decode everything the battle can play in the background (effects, UI, time sounds, music)
      const want = new Set<number>();
      const d = this.doc;
      const m = d.music;
      const first = [...m.battle, m.ambient, m.extraTime, m.preResult, m.win, m.lose, m.draw, m.postResult, ...d.time.sounds,
        ...Object.values(d.ui)].filter((k): k is string => typeof k === 'string');
      for (const k of [...first, ...Object.keys(d.events)]) if (d.events[k]) this.collectFiles(d.events[k].inst, want);
      const files = [...want];
      let i = 0;
      const worker = async () => { while (i < files.length) await this.buffer(files[i++]); };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })();
    return this.loading;
  }

  private collectFiles(nodes: readonly SoundNode[], out: Set<number>): void {
    for (const n of nodes) {
      if (n.f !== undefined) out.add(n.f);
      if (n.e) this.collectFiles(n.e.map((x) => x[1]), out);
    }
  }

  private buffer(f: number): Promise<AudioBuffer | null> {
    const have = this.buffers.get(f);
    if (have) return Promise.resolve(have);
    const p0 = this.fetching.get(f);
    if (p0) return p0;
    const ctx = this.ctx, doc = this.doc;
    if (!ctx || !doc || !doc.files[f]) return Promise.resolve(null);
    const p = (async () => {
      try {
        const r = await assetFetch(`${this.base}/${doc.files[f].f}`);
        const ab = await r.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        this.buffers.set(f, buf);
        return buf;
      } catch (e) {
        console.warn('sound: decode failed', doc.files[f].f, e);
        return null;
      }
    })();
    this.fetching.set(f, p);
    return p;
  }

  /** Decoded buffer of a file (tests / the browser check). */
  bufferOf(f: number): AudioBuffer | null { return this.buffers.get(f) ?? null; }

  private record(name: string, kind: string, id: number, ok: boolean, why?: string): void {
    this.log.push({ t: this.ctx ? this.ctx.currentTime : 0, name, kind, id, ok, why });
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }

  private liveOf(key: string): number[] {
    const out: number[] = [];
    for (const [id, i] of this.insts) if (i.key === key) out.push(id);
    return out;
  }

  private voiceCount(): number {
    let n = 0;
    for (const i of this.insts.values()) for (const v of i.voices) if (!v.ended) n++;
    return n;
  }

  /**
   * Start the event for a resource name or a music key (FMOD getEvent + createInstance + start);
   * `pitch` = the instance pitch multiplier (EventInstance::setPitch). Returns the instance id or 0.
   */
  play(key: string | null | undefined, pitch = 1, kind = 'sfx'): number {
    if (!key) return 0;
    const doc = this.doc;
    if (!this.enabled || !this.ctx || !doc || this.paused) { this.record(key, kind, 0, false, 'not ready'); return 0; }
    const def = doc.events[key];
    if (!def) { this.record(key, kind, 0, false, 'unknown'); return 0; }
    // EventInstance::setPitch(0) (an AttackStartEffect under a buff without AudioPitchModifier, 0xfc24e0)
    // leaves the instance at playback rate 0: nothing is heard (A: the frozen FMOD instance itself, which
    // still counts toward max instances, is not kept)
    if (!(pitch > 0)) { this.record(key, kind, 0, false, 'pitch 0'); return 0; }
    const now = this.ctx.currentTime;
    const live = this.liveOf(key);
    const a = admit(def, now, this.lastStart.get(key), live);
    if (!a.ok) { this.record(key, kind, 0, false, def.cooldown && live.length < def.max ? 'cooldown' : 'max instances'); return 0; }
    if (a.steal !== null) this.stop(a.steal, true);
    this.lastStart.set(key, now);
    const id = this.nextId++;
    const inst: Inst = { id, key, def, start: now, voices: [], pending: [], music: kind === 'music', waiting: 0 };
    this.insts.set(id, inst);
    for (const node of def.inst) {
      const at = now + (node.t ?? 0) / FRAME_RATE;
      if (node.k === 'command') inst.pending.push({ at, node });
      else this.trigger(inst, node, at, pitch, node.t ?? 0, node.len ?? 0);
    }
    this.runCommands(inst, now);
    this.record(key, kind, id, true);
    return id;
  }

  /** One instrument trigger (probability, delay, playlist pick, volume / pitch draws). */
  private trigger(inst: Inst, node: SoundNode, at: number, pitch: number, tlStart: number, tlLen: number, volDb = 0, st = 0): void {
    if (node.p !== undefined && this.rng.next() * 100 >= node.p) return;
    let when = at;
    if (node.dl) when += (node.dl[0] + this.rng.next() * Math.max(0, node.dl[1] - node.dl[0])) / 1000;
    const vol = volDb + drawVolume(node, this.rng);
    const semis = st + drawPitch(node, this.rng);
    if (node.k === 'multi') {
      let pl = this.playlists.get(node);
      if (!pl) { pl = new Playlist(); this.playlists.set(node, pl); }
      const child = pl.pick(node, this.rng);
      if (child) {
        const loopKids = node.lc === -1 && child.lc === undefined ? { ...child, lc: -1 } : child;
        this.trigger(inst, loopKids, when, pitch, tlStart, tlLen, vol, semis);
      }
      return;
    }
    if (node.k === 'command') { inst.pending.push({ at: when, node }); return; }
    if (node.k !== 'wave' || node.f === undefined) return;
    this.startVoice(inst, node, when, pitch, vol, semis, tlStart, tlLen);
  }

  private startVoice(inst: Inst, node: SoundNode, when: number, pitch: number, volDb: number, semis: number, tlStart: number, tlLen: number,
    late = 0): void {
    const ctx = this.ctx!, master = this.master!;
    const buf = this.buffers.get(node.f!);
    if (!buf) {
      const p = this.buffer(node.f!);
      if (inst.music || node.lc === -1 || inst.def.loop) {
        // music and loops start once decoded, at the position they would have reached (a one-shot is dropped)
        inst.waiting++;
        void p.then((b) => {
          inst.waiting--;
          if (!b || !this.ctx || this.insts.get(inst.id) !== inst) return;
          const now = this.ctx.currentTime;
          this.startVoice(inst, node, now, pitch, volDb, semis, tlStart, tlLen, Math.max(0, now - when));
        });
        this.record(inst.key, 'voice', inst.id, false, 'waiting for decode');
      } else this.record(inst.key, 'voice', inst.id, false, 'buffer not decoded yet');
      return;
    }
    if (this.voiceCount() >= MAX_VOICES) { this.record(inst.key, 'voice', inst.id, false, 'voice cap'); return; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch * semitonesToRate(semis);
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(volDb);
    src.connect(gain);
    gain.connect(master);
    let looping = false;
    const loop = inst.def.loop;
    if (node.lc === -1) { src.loop = true; looping = true; }
    else if (loop && tlStart <= loop[0] && loop[1] <= tlStart + (tlLen || Infinity)) {
      // the event's loop transition jumps back inside this instrument: loop that stretch of it
      src.loop = true;
      src.loopStart = Math.max(0, (loop[0] - tlStart) / FRAME_RATE);
      src.loopEnd = Math.min(buf.duration, (loop[1] - tlStart) / FRAME_RATE);
      looping = true;
    }
    const v: Voice = { src, gain, looping, ended: false };
    src.onended = () => { v.ended = true; try { gain.disconnect(); } catch { /* gone */ } };
    let off = (node.so ? (node.so / 100) * buf.duration : 0) + late * src.playbackRate.value;
    if (off >= buf.duration || (src.loop && src.loopEnd > src.loopStart && off >= src.loopEnd)) {
      if (!src.loop) { try { gain.disconnect(); } catch { /* gone */ } return; }
      const a = src.loopEnd > src.loopStart ? src.loopStart : 0, b = src.loopEnd > src.loopStart ? src.loopEnd : buf.duration;
      off = a + ((off - a) % (b - a));
    }
    src.start(Math.max(when, ctx.currentTime), off);
    inst.voices.push(v);
  }

  private runCommands(inst: Inst, now: number): void {
    const due = inst.pending.filter((p) => p.at <= now);
    if (!due.length) return;
    inst.pending = inst.pending.filter((p) => p.at > now);
    for (const p of due) {
      // command instrument type 0 = stop event (all instances of the target event)
      if (p.node.c === 0 && p.node.tg) {
        for (const [id, i] of this.insts) if (i.def.path === p.node.tg && id !== inst.id) this.stop(id, false);
      }
    }
  }

  /** EventInstance::stop: immediate (FMOD_STUDIO_STOP_IMMEDIATE) or allowing fade-out (no AHDSR here). */
  stop(id: number, immediate = true): void {
    const i = this.insts.get(id);
    if (!i || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of i.voices) {
      if (v.ended) continue;
      try {
        v.gain.gain.setTargetAtTime(0, t, immediate ? 0.004 : 0.01);
        v.src.stop(t + (immediate ? 0.03 : 0.06));
      } catch { /* not started */ }
    }
    i.pending = [];
    this.insts.delete(id);
    if (id === this.musicId) this.musicId = 0;
  }

  /** EventInstance::keyOff (0xcbc508) for events with sustain points: here looping voices stop looping (A). */
  keyOff(id: number): void {
    const i = this.insts.get(id);
    if (!i) return;
    for (const v of i.voices) if (v.looping && !v.ended) { v.src.loop = false; v.looping = false; }
  }

  isPlaying(id: number): boolean {
    const i = this.insts.get(id);
    if (!i) return false;
    return i.pending.length > 0 || i.waiting > 0 || i.voices.some((v) => !v.ended) || (this.ctx ? this.ctx.currentTime < i.start + 0.05 : false);
  }

  /** 0xcbc880: start a music row and make it the current music. */
  playMusic(key: string | null | undefined): number {
    if (!key) return 0;
    const id = this.play(key, 1, 'music');
    if (id) this.musicId = id;
    return id;
  }

  /** 0xcbb4c4: stop the current music (allow fade-out). */
  stopMusic(): void {
    if (this.musicId) this.stop(this.musicId, false);
    this.musicId = 0;
  }

  /** 0xcbc9ec: the current music instance is still alive. */
  musicPlaying(): boolean {
    return this.musicId !== 0 && this.isPlaying(this.musicId);
  }

  stopAll(): void {
    for (const id of [...this.insts.keys()]) this.stop(id, true);
    this.musicId = 0;
  }

  /** 0xcbc8d4: stop every instance but `keep` (FMOD stop mode: immediate or allowing fade-out). */
  stopAllExcept(keep: number, immediate: boolean): void {
    for (const id of [...this.insts.keys()]) if (id !== keep) this.stop(id, immediate);
  }

  /** Per frame: timed command instruments, instance clean-up (FMOD Studio System::update 0xcbbf18). */
  update(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [id, i] of this.insts) {
      this.runCommands(i, now);
      if (now > i.start + 0.1 && i.pending.length === 0 && i.waiting === 0 && i.voices.every((v) => v.ended)) {
        this.insts.delete(id);
        if (id === this.musicId) this.musicId = 0;
      }
    }
  }

  // ------------------------------------------------------------------------- client hooks

  /** UI sound by client-table role (bake_audio.py UI_SOUNDS). */
  ui(role: string): number {
    return this.play(this.doc?.ui?.[role] as string | undefined, 1, 'ui');
  }
}

/** The viewer's sound system (one per page). */
export const sound = new SoundSystem();

// ---------------------------------------------------------------------- effect component sounds

interface FxSoundState { next: number; ids: number[]; lastAge: number }
const fxState = new WeakMap<object, FxSoundState>();

/** Baked `sounds` of an effect: [[time ms, resource name], ...] in component order (bake_web.py). */
type FxSounds = [number, string][];

/**
 * 0x82bf10's sound part, called by the effect instance's update before its components: each sound
 * component starts its event once the effect's age reaches its Time (the component start), with the
 * effect's pitch when it is not 1 (0xcbc74c). An age that went back (ForcedLength restart, 0x82be20)
 * keys the previous sounds off and re-arms them.
 */
export function fxSoundUpdate(fx: object, def: object, age: number, stopped: boolean, pitch = 1): void {
  const list = (def as { sounds?: FxSounds }).sounds;
  if (!list || list.length === 0) return;
  let st = fxState.get(fx);
  if (!st) { st = { next: 0, ids: [], lastAge: age }; fxState.set(fx, st); }
  if (age < st.lastAge) {
    for (const id of st.ids) sound.keyOff(id);
    st.ids = [];
    st.next = 0;
  }
  st.lastAge = age;
  if (stopped) return;
  // components start in data order once due (each its own Time)
  for (let i = 0; i < list.length; i++) {
    if (st.next & (1 << Math.min(i, 30))) continue;
    if (list[i][0] > age) continue;
    st.next |= 1 << Math.min(i, 30);
    const id = sound.play(list[i][1], pitch, 'effect');
    if (id) st.ids.push(id);
  }
}

/** 0x82d074: stopping an effect keys its sounds off only with KillLoopingSoundsOnEnd. */
export function fxSoundStop(fx: object, def: object): void {
  const st = fxState.get(fx);
  if (!st) return;
  st.next = 0x7fffffff;
  if ((def as { KillLoopingSoundsOnEnd?: boolean }).KillLoopingSoundsOnEnd) for (const id of st.ids) sound.keyOff(id);
}

// ------------------------------------------------------------------------ battle screen sounds

/** What the battle sound logic reads each frame (BattleUi). */
export interface BattleSoundState {
  /** seconds left of the timeline's section (0xd566d8) and overtime (0xd56738) */
  secs: number;
  overtime: boolean;
  /** the battle is over (0xd4220c) */
  ended: boolean;
  /** battle +0x1e1 (0xd3e360 = 0xd56610): it ended with the time run out in the last section */
  timeRanOut: boolean;
}

/**
 * The clock as 0xbdf1b0 / 0x8d38c4 read it: seconds left of the timeline's section (0xd566d8,
 * ceil(ms left / 1000)), overtime (0xd56738), over (0xd4220c), and battle +0x1e1 (set by the end
 * 0xd3e360 from 0xd56610: the time ran out in the last section, i.e. overtime or the tiebreak after it).
 */
export function battleClockSounds(b: { tick: number; overtime: boolean; regulationTicks: number; overtimeTicks: number;
  result: { tick: number; reason: string } | null }): BattleSoundState {
  const end = b.overtime ? b.regulationTicks + b.overtimeTicks : b.regulationTicks;
  const msLeft = Math.max(0, (end - b.tick) * 50);
  return {
    secs: Math.floor((msLeft + 999) / 1000), overtime: b.overtime, ended: !!b.result,
    timeRanOut: !!b.result && b.result.reason !== 'king' && b.result.tick + 1 >= b.regulationTicks + b.overtimeTicks,
  };
}

/**
 * The battle screen's sound logic:
 *  - 0xbdf1b0 (every battle screen update, and once from the setup 0xbde180 with prev = 99999999):
 *    while the battle runs and outside overtime, the first MUSIC_START_TIMES threshold crossed starts
 *    MUSICS_PVP[i] (0xcbc880, without stopping the previous music); the first SOUND_START_TIMES
 *    threshold crossed plays the location's Sound (i = 0, 0xe48c74) or SOUNDS_PVP[i - 1] (0xcba648),
 *    skipping thresholds above 10 in overtime;
 *  - 0x8d38c4 (HUD time update): overtime starting plays extra_time_jingle and the location's
 *    ExtraTimeMusic (0xe48c6c); the time running out at the end (+0x1e1) plays gameend_horn;
 *  - 0xbde180 plays the location's AmbientSound (0xe48cfc) at the setup.
 */
export class BattleSounds {
  private prev = 99999999; // battle screen +0x410
  private wasOvertime = false; // HUD +0x291
  private wasTimeOut = false; // HUD +0x292
  private setupDone = false;
  /** the music the client would have started last (played as soon as audio is unlocked, A) */
  private want: string | null = null;
  private started: string | null = null;
  private gen = 0;
  ambientId = 0;

  reset(): void {
    this.prev = 99999999;
    this.wasOvertime = false;
    this.wasTimeOut = false;
    this.setupDone = false;
    this.want = null;
    this.started = null;
    this.ambientId = 0;
    sound.stopAll();
  }

  update(s: BattleSoundState): void {
    const doc = sound.doc;
    if (!doc) return;
    const ready = sound.ready;
    if (this.gen !== sound.generation) {
      // sound switched back on mid-battle: restart the current music and ambience
      this.gen = sound.generation;
      this.started = null;
      this.setupDone = false;
    }
    if (!this.setupDone && ready) {
      this.setupDone = true;
      this.ambientId = sound.play(doc.music.ambient ?? null, 1, 'ambient');
    }
    // 0x8d38c4
    if (s.overtime && !this.wasOvertime) {
      if (ready) sound.ui('extraTime');
      this.want = doc.music.extraTime;
    }
    if (s.timeRanOut && !this.wasTimeOut && ready) sound.ui('gameEndHorn');
    this.wasOvertime = s.overtime;
    this.wasTimeOut = s.timeRanOut;
    // 0xbdf1b0: nothing once the battle is over
    if (!s.ended) {
      const secs = s.secs;
      if (!s.overtime) {
        const i = thresholdIndex(doc.music.times, secs, this.prev);
        if (i >= 0 && i < doc.music.battle.length) this.want = doc.music.battle[i];
      }
      const j = thresholdIndex(doc.time.times, secs, this.prev, s.overtime, true);
      if (j >= 0 && j < doc.time.sounds.length && ready) sound.play(doc.time.sounds[j], 1, 'time');
      this.prev = secs;
    }
    if (ready && this.want && this.want !== this.started && !s.ended) {
      this.started = this.want;
      // one battle track at a time: 0xcbc880 itself never stops the previous music, and every music event
      // loops (its timeline jumps back to the start), so in the client the handover happens in FMOD's mixer
      // (bus / snapshot / sidechain, not decoded); what a player hears is the 2-minute track giving way to
      // the 60 s loop, that to the 30 s loop, and the battle music to sudden death (A: mechanism)
      sound.stopMusic();
      sound.playMusic(this.want);
    }
  }
}

// ------------------------------------------------------------------------ HUD and screen sounds

/** Card select sound (0x8e11b4 -> 0x8e12e4): the rarity's SpellSelectedSound, else the client table's +0xa00. */
export function selectSound(rarity: string | undefined): number {
  const r = rarity ? sound.doc?.ui?.rarity?.[rarity] : undefined;
  return r?.select ? sound.play(r.select, 1, 'ui') : sound.ui('selectSpell');
}

/** A hand card became affordable (0x8e1408): the rarity's SpellAvailableSound, else the client table's +0xc80. */
export function availableSound(rarity: string | undefined): number {
  const r = rarity ? sound.doc?.ui?.rarity?.[rarity] : undefined;
  return r?.available ? sound.play(r.available, 1, 'ui') : sound.ui('spellAvailable');
}

/**
 * Hand card sounds of the hand update (0x8e1408), fed one slot at a time by the HUD:
 *  - card_fly_in (client table +0xa80) on the first frame an entering card shows (entry timer t
 *    reaching 0 with the deal flag +0x31f: the battle-start deal 0x8e0a80 / 0x8e0aa8 and an armed
 *    card's restart 0x8e0b84);
 *  - spell_available (+0xc80, or the rarity's) when the card turns affordable (cost * 100 <= the
 *    elixir hundredths, +0x31a) on a frame its card did not change (+0x31d) while the hand is live.
 */
export class HandSounds {
  private aff: boolean[] = [false, false, false, false];
  private cards: number[] = [-1, -1, -1, -1];
  private rar: (string | undefined)[] = [];
  slideDone = false;

  reset(): void {
    this.aff = [false, false, false, false];
    this.cards = [-1, -1, -1, -1];
    this.slideDone = false;
  }

  /** `tBefore` / `cardBefore`: the card object's entry timer and card before its update this frame. */
  card(slot: number, tBefore: number, cardBefore: number, armed: boolean, tAfter: number, card: number,
    affordable: boolean, rarity: string | undefined): void {
    if (card !== -1 && tAfter >= 0 && (tBefore < 0 || (card !== cardBefore && armed && cardBefore !== -1))) sound.ui('cardFlyIn');
    const same = card === this.cards[slot] && card !== -1;
    if (same && affordable && !this.aff[slot]) availableSound(rarity);
    this.aff[slot] = affordable;
    this.cards[slot] = card;
    this.rar[slot] = rarity;
  }

  /** A card was selected (tap or drag start, 0x8e11b4 with the sound flag). */
  select(slot: number): void {
    selectSound(this.rar[slot]);
  }

  /** HUD_player's slide (0x8db8e0 +0xeb): board_slide_in the first time t reaches 0.3. */
  slide(t: number): void {
    if (!this.slideDone && t >= 0.3) { this.slideDone = true; sound.ui('boardSlideIn'); }
  }
}

/** Deploy timer sounds (0x8d9748 / 0x8d9ad0): a tick each quarter of the countdown, the ding at its end. */
export function timerSounds(ticksBefore: number, stateBefore: number, t: { ticks: number; state: number }, own: boolean): void {
  if (t.ticks > ticksBefore) sound.ui(own ? 'deployTick' : 'enemyDeployTick');
  if (stateBefore === 1 && t.state === 2) sound.ui(own ? 'deployDing' : 'enemyDeployDing');
}

/** The intro and result screens' sounds, read off their state each battle screen update. */
export class ScreenSounds {
  private intro: object | null = null;
  private introOut = false;
  private result: object | null = null;
  private shown = 0;
  private resultShown = false;

  reset(): void {
    this.intro = null;
    this.introOut = false;
    this.result = null;
    this.shown = 0;
    this.resultShown = false;
  }

  /**
   * - intro (0x8ca764): banner_sfx once its clip reaches the start_sound label (frame 0 of
   *   battle_intro_banners, so on its first update), names_whoosh_out once it reaches actionFrame;
   * - result screen: its creation (0xbe0100, after EndScreenDelay) first stops every sound but the
   *   location's ambience (0xcbc8d4 with battle screen +0x3c8, allowing fade-out), then plays
   *   Pre_result (0x8bc564 -> 0xcbc880); each crown that appears plays
   *   first / second / third_crown by its index on its side (0x8c2b80, the 0x8be06c sounds);
   *   result_end starting plays Win / Lose / Draw (client tables +0xe48 / +0xe50 / +0xe58; Draw
   *   without a winner); after that, Post_result_loop whenever the current music has stopped (0x8c1b9c).
   */
  update(intro: { beforeAction: boolean } | null, result: object | null, kind: number, oppCrowns: number, keep = 0): void {
    const doc = sound.doc;
    if (intro !== this.intro) {
      this.intro = intro;
      this.introOut = false;
      if (intro) sound.ui('bannerSfx');
    }
    if (intro && !this.introOut && !intro.beforeAction) { this.introOut = true; sound.ui('namesOut'); }
    if (result !== this.result) {
      this.result = result;
      this.shown = 0;
      this.resultShown = false;
      if (result && doc && sound.ready) {
        sound.stopAllExcept(keep, false);
        sound.playMusic(doc.music.preResult);
      }
    }
    if (!result || !doc) return;
    // ResultScreen's crown counter (+0x31c) and result flag (+0x1d0), read without changing result.ts
    const r = result as { shown?: unknown; resultShown?: unknown };
    const shown = typeof r.shown === 'number' ? r.shown : this.shown;
    while (this.shown < shown) {
      const own = oppCrowns <= this.shown;
      const idx = this.shown - (own ? oppCrowns : 0);
      sound.ui(`crown${Math.min(3, idx + 1)}`);
      this.shown++;
    }
    if (!this.resultShown && r.resultShown === true) {
      this.resultShown = true;
      sound.playMusic(kind === 1 ? doc.music.win : kind === 2 ? doc.music.lose : doc.music.draw);
    }
    if (this.resultShown && sound.ready && !sound.musicPlaying()) sound.playMusic(doc.music.postResult);
  }
}
