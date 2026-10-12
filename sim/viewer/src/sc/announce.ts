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
//   - the clock going up (a new section, 0x8d49f4) hides the end timer and drops the extra-time clip.
// Not ported (A): the tiebreaker / draw / final-score clips and the mode-specific texts (bVar9 path).

import type { Battle } from '../../../core/src/index.ts';
import type { ScLibrary } from './library.ts';
import type { ScRenderer } from './renderer.ts';
import { ClipPlayer } from './anim.ts';
import { WHITE } from './math.ts';

const END_TIMER_ANIM_MS = 12000;

interface Shown { exp: string; clip: ClipPlayer; text?: Record<string, string> }

export class Announcements {
  private prevSecs = -1; // +0x288
  private prevOT = false; // +0x291
  private prevRate = 0; // +0x370
  private prevClock = -1; // +0x40c
  private pendingElixir = false; // +0x378
  private banner: Shown | null = null; // +0x230
  private extra: Shown | null = null; // +0x268
  private endTimer: { clip: ClipPlayer; visible: boolean } | null = null; // +0x260
  private readonly ui: ScLibrary;
  private readonly text: (tid: string, vars?: Record<string, string | number>) => string;

  constructor(ui: ScLibrary, text: (tid: string, vars?: Record<string, string | number>) => string) {
    this.ui = ui;
    this.text = text;
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
    return { exp, clip, text };
  }

  update(dt: number, b: Battle): void {
    // clips advance with the frame; one created below shows its first frame first
    for (const s of [this.banner, this.extra]) s?.clip.advance(dt);
    const ph = this.phase(b);
    const secs = Math.floor((ph.msLeft + 999) / 1000);
    const ended = !!b.result;
    // 0x8d49f4: the clock went up (a new section)
    if (this.prevClock >= 0 && this.prevClock < secs) {
      if (this.endTimer) this.endTimer.visible = false;
      this.extra = null;
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
        this.endTimer = { clip: new ClipPlayer(this.ui.frameCount('print_endTimer'), this.ui.fps('print_endTimer') || 30), visible: true };
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
  }

  /** Drawn in stage px; `pos` = the arena centre in stage px (truncated). */
  draw(r: ScRenderer, pos: [number, number]): void {
    const m: [number, number, number, number, number, number] = [1, 0, 0, 1, pos[0], pos[1]];
    if (this.endTimer?.visible) {
      // the client sets timeRunOut's TID_TIME_RUN_OUT text to "" (0x8d38c4)
      r.draw(this.ui, 'print_endTimer', this.endTimer.clip.frame, m, WHITE,
        { childFrame: this.endTimer.clip.frame, text: { TID_TIME_RUN_OUT: '' } });
    }
    for (const s of [this.extra, this.banner]) {
      if (s) r.draw(this.ui, s.exp, s.clip.frame, m, WHITE, { childFrame: s.clip.frame, text: s.text });
    }
  }
}
