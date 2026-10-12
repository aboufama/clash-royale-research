// Timed battle announcements of the HUD time update (libg 160402020, 0x8d38c4), drawn in the HUD at
// the projected arena centre (_DAT_01a57004/8 = 0x8583bc of logic (9000, 16000), set by 0xbdf990):
//   - the battle phase (0xd56070 from the mode's battle_timelines row): sections (Normal / Overtime)
//     and elixir phases (ElixirRateLength s each, ElixirRateVisible = rate x10, ElixirNotifyChange);
//   - print_endTimer once the section has END_TIMER_ANIM_MS (12000) or less left: its frame follows
//     the time, ((12000 - msLeft) * n) / (frameTime * n * 1000) clamped to 0..n-1, visible while below
//     n-1; hidden when the battle is over and when more time is left (a new section);
//   - its timeRunOut caption is set to "" (TID_TIME_RUN_OUT gets the empty string at 0x2d1fd6);
//   - when the clock passes 60 s (same section, no section flag) "print_60secondsLeft_overtime", when it
//     passes 30 s "print_30secondsLeft" (0x8d4f44: replaces the banner +0x230, plays it once);
//   - an elixir phase change with ElixirNotifyChange queues "print_elixir_speed" (0x8d4fe0, text
//     TID_ELIXIR_MULTIPLIER with <num> = rate / 10), shown once the banner and the extra-time clip have
//     stopped;
//   - the overtime section starting (while the end timer exists) plays "print_extra_time" with
//     TID_60S = TID_EXTRA_TIME_SECONDS (<VALUE> = the section length in s);
//   - the clock going up (a new section, 0x8d49f4) hides the end timer, drops the extra-time,
//     tiebreaker and draw clips and clears their edge flags (+0x293/+0x294);
//   - "print_tiebreaker" (+0x270) when the battle manager's tiebreak clock (+0x1f4, Battle.tiebreakMs)
//     passes 1000 ms (it was not past it on the previous update, +0x293);
//   - "duel_battle_draw" (+0x278) when its draw clock (+0x1f8, Battle.drawMs, BestOfGame only) becomes
//     non-zero (+0x294);
//   - "finalScore" (+0x280) once the battle is over (0xd4220c), both crown-score prints are hidden and
//     the mode is not BestOfGame. Its playerScore / enemyScore numbers (0x1243454 with 0xd293bc) find no
//     such children in this build's clip, so nothing shows them; txt_match_over (TID_MATCH_OVER) is
//     regilded with the client globals GOLD_RUSH_COLORS (+0x130) / CROWN_RUSH_COLORS (+0x138) when the
//     player's battle reward mode (entry +0x90 -> +8, 0x10293f8) is 1 / 2 (0xd3dbc8 / 0xd3dae4) -
//     never in the sandbox, so the clip's own white text shows;
//   - these three are played 0..n-1 once (0x1241f50) and added to the HUD after the clips before them.
// The crown-score prints (printScore_player +0x110 / printScore_enemy +0x118, 0x8e8470) are updated by
// the HUD crown update 0x8d2de0 (0x8e86e8) just before the time update; see ScorePrint.
// Not ported (A): the mode-specific texts (bVar9 path), the touchdown text (+0x3e0 / +0x3d1).

import type { Battle } from '../../../core/src/index.ts';
import type { ScLibrary } from './library.ts';
import type { ScRenderer } from './renderer.ts';
import { ClipPlayer } from './anim.ts';
import { WHITE } from './math.ts';

const END_TIMER_ANIM_MS = 12000;
const f32 = Math.fround;

interface Shown { exp: string; clip: ClipPlayer; text?: Record<string, string>; seq: number }

/**
 * Crown-score print (0x8e8470 class; printScore_player / printScore_enemy with children star1..3 and
 * a name text), update 0x8e86e8(dt, print, score) [STAT]:
 *   score < last: timer 0, hidden. delay (+0xac) -= dt; while > 0 nothing else happens.
 *   score > last: with the timer at 0: timer 0.001, visible, and each star i plays
 *     last >= i: newStar_end..newStar_end, score >= i: newStar..newStar_end, else noStar..noStar_end;
 *     with the timer running: stars last+1..score play newStar..newStar_end and the timer restarts at
 *     the main clip's "start" label time (+0x9c).
 *   timer > 0: timer += dt, main clip frame trunc(timer / frameTime) (clamped), hidden once that frame
 *   reaches the frame count; else the main clip stops on its last frame. last = score.
 * The name text gets the player's name (0x873bbc) or the client's fallback TID_YOU / TID_ENEMY; the
 * sandbox has no player names, so the fallback shows (A).
 */
export class ScorePrint {
  visible = false; // +8: the constructor ends hidden
  private last = 0; // +0xa8
  private delay = 0; // +0xac
  private t = 0; // +0x98 (float)
  private frame = 0;
  private readonly n: number;
  private readonly frameTime: number;
  private readonly startTime: number; // +0x9c = frameTime * "start"
  private readonly lb: { noStar: number; noStarEnd: number; newStar: number; newStarEnd: number };
  private readonly stars: (ClipPlayer | null)[];
  readonly exp: string;
  readonly name: string;

  constructor(ui: ScLibrary, exp: string, name: string) {
    this.exp = exp;
    this.name = name;
    const clip = ui.clip(exp);
    this.n = clip?.frameCount ?? 0;
    this.frameTime = f32(1 / (clip?.fps || 30));
    this.startTime = f32(this.frameTime * (clip?.labels.get('start') ?? -1));
    const star = (i: number): ClipPlayer | null => {
      const k = clip?.names?.indexOf(`star${i}`) ?? -1;
      const c = k >= 0 && clip ? ui.clips.get(clip.children[k]) : undefined;
      return c ? new ClipPlayer(c.frameCount, c.fps || 30) : null;
    };
    this.stars = [star(1), star(2), star(3)];
    const k1 = clip?.names?.indexOf('star1') ?? -1;
    const s1 = k1 >= 0 && clip ? ui.clips.get(clip.children[k1]) : undefined;
    const L = (s: string) => s1?.labels.get(s) ?? -1;
    this.lb = { noStar: L('noStar'), noStarEnd: L('noStar_end'), newStar: L('newStar'), newStarEnd: L('newStar_end') };
  }

  /** Star clips advance with the frame (MovieClip update). */
  advance(dt: number): void {
    for (const s of this.stars) s?.advance(dt);
  }

  update(dt: number, score: number): void {
    const last = this.last;
    if (score < last) { this.t = 0; this.visible = false; }
    this.delay = f32(this.delay - dt);
    if (this.delay > 0) return;
    const L = this.lb;
    if (last < score) {
      if (this.t === 0) {
        this.t = f32(0.001);
        this.visible = true;
        for (let i = 1; i <= 3; i++) {
          const s = this.stars[i - 1];
          if (!s) continue;
          if (last >= i) s.playRange(L.newStarEnd, L.newStarEnd, false);
          else if (score >= i) s.playRange(L.newStar, L.newStarEnd, false);
          else s.playRange(L.noStar, L.noStarEnd, false);
        }
      } else {
        for (let i = last + 1; i <= score; i++) this.stars[i - 1]?.playRange(L.newStar, L.newStarEnd, false);
        this.t = this.startTime;
      }
    }
    const n = this.n;
    if (this.t > 0) {
      this.t = f32(this.t + dt);
      const f = Math.trunc(f32(this.t / this.frameTime));
      this.frame = f < 0 ? 0 : Math.min(f, n - 1);
      if (f >= n) { this.t = 0; this.visible = false; }
    } else {
      this.frame = Math.max(n, 1) - 1;
      if (n <= 0) { this.t = 0; this.visible = false; }
    }
    this.last = score;
  }

  draw(r: ScRenderer, ui: ScLibrary, m: [number, number, number, number, number, number]): void {
    if (!this.visible || !ui.has(this.exp)) return;
    const named: Record<string, { frame: number; childFrame: number }> = {};
    this.stars.forEach((s, i) => { if (s) named[`star${i + 1}`] = { frame: s.frame, childFrame: s.frame }; });
    r.draw(ui, this.exp, this.frame, m, WHITE, { childFrame: this.frame, named, text: { txt: this.name } });
  }
}

export class Announcements {
  private prevSecs = -1; // +0x288
  private prevOT = false; // +0x291
  private prevRate = 0; // +0x370
  private prevClock = -1; // +0x40c
  private pendingElixir = false; // +0x378
  private prevTiebreak = false; // +0x293
  private prevDraw = false; // +0x294
  private banner: Shown | null = null; // +0x230
  private extra: Shown | null = null; // +0x268
  private tiebreaker: Shown | null = null; // +0x270
  private drawClip: Shown | null = null; // +0x278
  private finalScore: Shown | null = null; // +0x280
  private endTimer: { clip: ClipPlayer; visible: boolean; seq: number } | null = null; // +0x260
  private printPlayer: ScorePrint | null = null; // +0x110
  private printEnemy: ScorePrint | null = null; // +0x118
  private seq = 0; // HUD child order (0x1252994 appends)
  private readonly ui: ScLibrary;
  private readonly text: (tid: string, vars?: Record<string, string | number>) => string;

  constructor(ui: ScLibrary, text: (tid: string, vars?: Record<string, string | number>) => string) {
    this.ui = ui;
    this.text = text;
    // HUD init (0x8cd4ec): printScore_enemy (+0x118) then printScore_player (+0x110), added to the HUD
    if (ui.has('printScore_enemy')) this.printEnemy = new ScorePrint(ui, 'printScore_enemy', text('TID_ENEMY'));
    if (ui.has('printScore_player')) this.printPlayer = new ScorePrint(ui, 'printScore_player', text('TID_YOU'));
  }

  /** Battle phase like 0xd56070: section ms left, overtime, elixir rate x10 and its notify flag. */
  private phase(b: Battle): { msLeft: number; ot: boolean; rate: number; notify: boolean; sectionSec: number } {
    const reg = b.regulationTicks, ot = b.tick >= reg;
    const end = ot ? reg + b.overtimeTicks : reg;
    const msLeft = Math.max(0, (end - b.tick) * 50);
    const raw = (b as unknown as { timeline?: { raw?: Record<string, unknown> } }).timeline?.raw ?? {};
    const lens = (raw.ElixirRateLength as number[] | undefined) ?? [];
    const rates = (raw.ElixirRateVisible as number[] | undefined) ?? [];
    const notes = (raw.ElixirNotifyChange as boolean[] | undefined) ?? [];
    const sec = (b.tick * 50) / 1000;
    let i = 0, t = 0;
    while (i < lens.length - 1 && sec >= t + lens[i]) { t += lens[i]; i++; }
    const rate = rates[i] ?? Math.round((b.elixirPerTick() / 178) * 10);
    return { msLeft, ot, rate, notify: !!notes[i], sectionSec: ot ? (b.overtimeTicks * 50) / 1000 : (reg * 50) / 1000 };
  }

  private play(exp: string, text?: Record<string, string>): Shown | null {
    if (!this.ui.has(exp)) return null;
    const clip = new ClipPlayer(this.ui.frameCount(exp), this.ui.fps(exp) || 30);
    clip.playRange(0, clip.frames - 1, false);
    return { exp, clip, text, seq: this.seq++ };
  }

  /** One HUD update `dt` s after the previous one; `team` is the HUD player's side. */
  update(dt: number, b: Battle, team: 0 | 1 = 0): void {
    // clips advance with the frame; one created below shows its first frame first
    for (const s of [this.banner, this.extra, this.tiebreaker, this.drawClip, this.finalScore]) s?.clip.advance(dt);
    this.printEnemy?.advance(dt);
    this.printPlayer?.advance(dt);
    // HUD crown update 0x8d2de0 (before the time update): the enemy's crowns, then the player's
    this.printEnemy?.update(dt, b.players[1 - team].crowns);
    this.printPlayer?.update(dt, b.players[team].crowns);
    const ph = this.phase(b);
    const secs = Math.floor((ph.msLeft + 999) / 1000);
    const ended = !!b.result;
    const tbMs = b.tiebreakMs ?? 0, drawMs = b.drawMs ?? 0;
    // 0x8d49f4: the clock went up (a new section)
    if (this.prevClock >= 0 && this.prevClock < secs) {
      this.prevTiebreak = false;
      this.prevDraw = false;
      if (this.endTimer) this.endTimer.visible = false;
      this.extra = null;
      this.drawClip = null;
      this.tiebreaker = null;
    }
    this.prevClock = secs;
    // end timer and the overtime start
    if (END_TIMER_ANIM_MS < ph.msLeft) {
      if (this.endTimer) {
        this.endTimer.visible = false;
        if (ph.ot && !this.prevOT && !this.extra) {
          const v = this.text('TID_EXTRA_TIME_SECONDS', { VALUE: ph.sectionSec });
          this.extra = this.play('print_extra_time', v ? { TID_60S: v } : undefined);
        }
      }
    } else {
      if (!this.endTimer && this.ui.has('print_endTimer')) {
        this.endTimer = { clip: new ClipPlayer(this.ui.frameCount('print_endTimer'), this.ui.fps('print_endTimer') || 30), visible: true, seq: this.seq++ };
      }
      const et = this.endTimer;
      if (et) {
        if (ended) et.visible = false;
        else {
          const n = et.clip.frames;
          const span = Math.trunc((1 / et.clip.fps) * (n * 1000));
          let f = span ? Math.trunc(((END_TIMER_ANIM_MS - ph.msLeft) * n) / span) : 0;
          f = f < 1 ? 0 : Math.min(f, n - 1);
          et.clip.gotoAndStop(f);
          et.visible = f < n - 1;
        }
      }
    }
    // tiebreaker (+0x270) and draw (+0x278): on the rising edge of the battle manager's clocks
    if (tbMs > 1000 && !this.prevTiebreak && !this.tiebreaker) this.tiebreaker = this.play('print_tiebreaker');
    if (drawMs !== 0 && !this.prevDraw && !this.drawClip) this.drawClip = this.play('duel_battle_draw');
    // final score (+0x280): battle over, both crown-score prints hidden, not BestOfGame
    if (ended && this.printEnemy && !this.printEnemy.visible && this.printPlayer && !this.printPlayer.visible
      && !b.bestOfGame && !this.finalScore) {
      this.finalScore = this.play('finalScore');
    }
    // 60 / 30 s banners and the elixir banner
    if (!ended && this.prevSecs >= 0) {
      const sameSection = this.prevOT === ph.ot;
      let kind = 0;
      if (secs < 61 && this.prevSecs > 60 && sameSection) kind = 60;
      if (secs < 31 && this.prevSecs > 30 && sameSection) kind = 30;
      if (kind === 60) this.banner = this.play('print_60secondsLeft_overtime') ?? this.banner;
      else if (kind === 30) this.banner = this.play('print_30secondsLeft') ?? this.banner;
      if (ph.rate !== this.prevRate && ph.notify) this.pendingElixir = true;
    }
    if (this.pendingElixir) {
      const free = (!this.extra || !this.extra.clip.playing) && (!this.banner || !this.banner.clip.playing);
      if (free) {
        const num = ph.rate % 10 === 0 ? String(ph.rate / 10) : `${Math.trunc(ph.rate / 10)}.${ph.rate % 10}`;
        this.banner = this.play('print_elixir_speed', { txt: this.text('TID_ELIXIR_MULTIPLIER', { num }) }) ?? this.banner;
        this.pendingElixir = false;
      }
    }
    this.prevSecs = secs;
    this.prevOT = ph.ot;
    this.prevRate = ph.rate;
    this.prevTiebreak = tbMs > 1000;
    this.prevDraw = drawMs !== 0;
  }

  /** Drawn in stage px; `pos` = the arena centre in stage px (truncated). */
  draw(r: ScRenderer, pos: [number, number]): void {
    const m: [number, number, number, number, number, number] = [1, 0, 0, 1, pos[0], pos[1]];
    // the crown-score prints were added at HUD init, before every announcement
    this.printEnemy?.draw(r, this.ui, m);
    this.printPlayer?.draw(r, this.ui, m);
    const shown: { seq: number; draw: () => void }[] = [];
    const et = this.endTimer;
    if (et?.visible) {
      // the client sets timeRunOut's TID_TIME_RUN_OUT text to "" (0x8d38c4)
      shown.push({ seq: et.seq, draw: () => r.draw(this.ui, 'print_endTimer', et.clip.frame, m, WHITE,
        { childFrame: et.clip.frame, text: { TID_TIME_RUN_OUT: '' } }) });
    }
    for (const s of [this.extra, this.banner, this.tiebreaker, this.drawClip, this.finalScore]) {
      if (s) shown.push({ seq: s.seq, draw: () => r.draw(this.ui, s.exp, s.clip.frame, m, WHITE, { childFrame: s.clip.frame, text: s.text }) });
    }
    shown.sort((a, b) => a.seq - b.seq);
    for (const s of shown) s.draw();
  }
}
