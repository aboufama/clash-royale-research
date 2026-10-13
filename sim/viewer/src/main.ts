// Viewer entry: real-time loop at the engine's 20 Hz with render interpolation. The default page
// shows only what the client shows in a battle (the HUD is drawn with the game's own exports by
// battle_ui.ts / hud.ts): drag a card from the hand, or tap a card and then the arena. The
// simulator's own controls (pause/step/speed/restart, sandbox palette, the red player's hand for
// local two-player testing) are shown unless the URL has `?clean`.
import { Battle, Bot, type CardDef, type GameData, type ProjectileDef, supportedCards, type UnitDef } from '../../core/src/index.ts';
import gameDataJson from '../../data/gamedata.json';
import type { BattleUi, PreviewInput } from './battle_ui.ts';
import { Camera } from './camera.ts';
import { FOCUS_CARDS, FOCUS_DECKS } from './focus.ts';
import { Frame, type WorldRenderer } from './frame.ts';
import { Overlay } from './overlay.ts';
import { PlaceholderRenderer } from './placeholder.ts';
import { sound } from './sc/sound.ts';
import { affordableSoon, dropWaits, MAX_SPELL_PENDING_TIME_S } from './sc/ui_port.ts';
import { assetFetch } from './sc/asset_fetch.ts';
import { AgentPlayer } from './agent.ts';

export { FOCUS_CARDS, FOCUS_DECKS } from './focus.ts';

const data = gameDataJson as unknown as GameData;
const TICK_MS = 50;
// sandbox controls are on by default; `?clean` shows only what the client shows
const DEV = typeof location === 'undefined' || !new URLSearchParams(location.search).has('clean');

const DEFAULT_DECKS: [string[], string[]] = [FOCUS_DECKS[0].slice(), FOCUS_DECKS[1].slice()];

export interface ArtHooks {
  makeRenderer(canvas: HTMLCanvasElement, cam: Camera): Promise<WorldRenderer | null>;
  cardImage(card: string): string | null;
  /** start loading the art of these characters / projectiles / spells / area effects */
  prewarm(names: Iterable<string>): void;
}

/** Names of everything a card can put on the field (summons and what they spawn or shoot). */
function cardArtNames(card: CardDef): string[] {
  const out = new Set<string>([card.name]);
  const proj = (p: ProjectileDef | null, d = 0): void => {
    if (!p || d > 4 || out.has(p.name)) return;
    out.add(p.name);
    unit(p.spawnUnit, d + 1);
    proj(p.spawnProjectile, d + 1);
  };
  const unit = (u: UnitDef | null | undefined, d = 0): void => {
    if (!u || d > 4 || out.has(u.name)) return;
    out.add(u.name);
    proj(u.projectile, d + 1);
    unit(u.deathSpawn?.unit, d + 1);
    unit(u.spawn?.unit, d + 1);
    if (u.deathAreaEffect) out.add(u.deathAreaEffect.name);
  };
  for (const s of card.summon) unit(s.unit);
  proj(card.spellProjectile);
  proj(card.firstProjectile);
  if (card.areaEffect) out.add(card.areaEffect.name);
  return [...out];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function displayName(card: string): string {
  const r = data.cards[card];
  return (r && typeof r._displayName === 'string' ? r._displayName : card) as string;
}

/** A card being dragged from the canvas HUD (own hand) or a DOM hand/palette (?dev). */
interface Drag {
  team: number;
  slot: number; // -1: palette
  card: string;
  /** pointer start (stage px) and whether it has left the card */
  sx: number;
  sy: number;
  moved: boolean;
  /** the drag preview exists (created when the card visual first disappears, 0x8e1fb8) */
  previewOn: boolean;
  /** last pointer position (board CSS px) */
  px: number;
  py: number;
  dom: HTMLElement | null;
  /** grab offset (card origin - pointer, stage px) */
  gx: number;
  gy: number;
}

class App {
  battle!: Battle;
  cam = new Camera();
  frame = new Frame();
  world!: WorldRenderer;
  overlay: Overlay;
  paused = false;
  speed = 1;
  private statusAt = 0;
  acc = 0;
  /** visual ms run since the engine stopped (the post-end world reached the end screen, Battle.stopped) */
  afterEnd = 0;
  last = 0;
  seed = 1;
  infinite = false;
  paletteTeam = 0;
  readonly dev = DEV;
  art: ArtHooks | null = null;
  decks: [string[], string[]] = [DEFAULT_DECKS[0].slice(), DEFAULT_DECKS[1].slice()];
  private handEls: HTMLElement[] = [];
  private nextEl: HTMLElement | null = null;
  private elixirFill: HTMLElement | null = null;
  private elixirNum: HTMLElement | null = null;
  private drag: Drag | null = null;
  /** a canvas-hand card released before it was affordable, still dragged while it waits (0x8e2c04) */
  private held: Drag | null = null;
  private tickTimes: number[] = [];
  /** scripted AI per team (sim/core bot.ts, not a client feature); null = played by hand */
  private bots: [Bot | null, Bot | null] = [null, null];
  /** AI level per team: 0 off, 1..3 easy..hard (scripted bot), 4 the trained RL agent */
  aiLevel: [number, number] = [0, 0];
  /** the trained agent per team (aiLevel 4; train/crl/export.py -> models/agent.onnx) */
  private agents: [AgentPlayer | null, AgentPlayer | null] = [null, null];
  /** a touch held on a game button of the HUD layer +0x178 / the result screen (not a battle touch) */
  private uiHeld: 'ok' | 'emote' | null = null;
  /** sandbox: the next emote the red side sends (its deck in order, then the text taunts) */
  private redEmote = 0;
  /** stage point of a touch that began on the arena with no card selected (0xbe1120's tap) */
  private tapStart: [number, number] | null = null;
  /**
   * A recorded match (`?replay=<url>`, written by sim/rl's worker or train/crl/evaluate.py --replays): the
   * battle config plus every accepted play by tick. The engine is deterministic, so feeding the plays in
   * at their ticks replays the match exactly; hand input and the AI are off meanwhile.
   */
  replay: Replay | null = null;
  private onAgentLoaded: (() => void) | null = null;
  private replayAt = 0;
  private replaying = false;

  constructor() {
    this.overlay = new Overlay($('overlay'));
  }

  /** The canvas HUD and battle UI (null with the placeholder renderer). */
  get ui(): BattleUi | null {
    return (this.world as unknown as { ui?: BattleUi }).ui ?? null;
  }

  async init(): Promise<void> {
    document.body.classList.toggle('dev', DEV);
    sound.attach('assets'); // audio/ (bake_audio.py), loaded on the first user gesture
    // ?vs=agent: red is played by the trained agent
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('vs') === 'agent') {
      this.aiLevel = [0, AGENT_LEVEL];
      this.decks = [AGENT_DECK.slice(), AGENT_DECK.slice()];
    }
    const rp = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('replay');
    if (rp) {
      try { this.useReplay(await (await assetFetch(rp)).json() as Replay); } catch (e) { console.warn('replay', rp, e); }
    }
    this.art = await loadArt();
    // the decks' unit art loads with the core libraries; any other card's on first use
    if (this.art) this.prewarmDecks();
    const glCanvas = $<HTMLCanvasElement>('gl');
    let world: WorldRenderer | null = null;
    if (this.art) {
      try { world = await this.art.makeRenderer(glCanvas, this.cam); } catch (e) { console.warn('art renderer failed', e); }
      this.overlay.artMode = world !== null;
    }
    if (!world) {
      // Placeholder needs a 2D context: swap in a fresh canvas.
      const c2 = document.createElement('canvas');
      c2.id = 'gl';
      glCanvas.replaceWith(c2);
      world = new PlaceholderRenderer(c2);
    }
    this.world = world;
    // a waiting card is released by the hand update (0x8e1408 -> 0x8e29f4)
    if (this.ui) this.ui.hud.onRelease = (slot) => this.releaseHeld(slot);
    this.newBattle();
    this.bindControls();
    this.bindPointer();
    if (DEV) this.buildPalette();
    addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  private prewarmDecks(): void {
    const defs = new Battle(data, { seed: 1, decks: this.decks }).defs;
    this.art?.prewarm(this.decks.flat().flatMap((n) => cardArtNames(defs.card(n, 11))));
  }

  /** Play back a recorded match: its seed and decks, both sides hands-off. */
  useReplay(r: Replay): void {
    this.replay = r;
    this.seed = r.seed;
    this.decks = [r.decks[0].slice(), r.decks[1].slice()];
    this.aiLevel = [0, 0];
  }

  newBattle(): void {
    this.replayAt = 0;
    // postEnd: the world runs on after the result until EndScreenDelay, as the battle manager runs it (0x10ca9a0)
    this.battle = new Battle(data, { seed: this.seed, decks: this.decks, recordEvents: true, postEnd: true });
    this.battle.infiniteElixir = this.infinite;
    this.frame.battle = this.battle;
    this.frame.cam = this.cam;
    this.frame.snapshot(this.battle);
    this.acc = 0;
    this.afterEnd = 0;
    this.drag = null;
    this.held = null;
    this.ui?.reset();
    this.makeBots();
    if (DEV) this.buildRedHand();
  }

  /** One Bot per AI side, seeded from the battle seed so a restart replays the same match. */
  private makeBots(): void {
    this.bots = [0, 1].map((t) => this.aiLevel[t] > 0 && this.aiLevel[t] < AGENT_LEVEL
      ? new Bot(t, { seed: this.seed * 2 + t + 1, level: this.aiLevel[t] }) : null) as [Bot | null, Bot | null];
    for (const t of [0, 1]) {
      if (this.aiLevel[t] !== AGENT_LEVEL) { this.agents[t] = null; continue; }
      let a = this.agents[t];
      if (!a) {
        a = new AgentPlayer(t, data);
        this.agents[t] = a;
        void a.load(AGENT_MODEL).then(() => this.onAgentLoaded?.());
      }
      a.reset(this.battle);
    }
    // the play check's reactions for a human player only (0xf941ec): the AI sides are not human
    const ui = this.ui;
    if (ui) ui.isHuman = (t) => this.aiLevel[t] === 0;
  }

  resize(): void {
    const board = $('board');
    const r = board.getBoundingClientRect();
    const dpr = Math.min(3, devicePixelRatio || 1);
    this.cam.fit(r.width, r.height, dpr);
    this.world.resize(r.width, r.height, dpr);
    this.overlay.resize(r.width, r.height, dpr);
  }

  loop(t: number): void {
    const dt = this.last ? Math.min(250, t - this.last) : 0;
    this.last = t;
    if (!this.paused && !this.battle.stopped) {
      // after the result the engine steps its post-end world (no end checks, plays rejected, no attacks,
      // the fallen King's side cleared) until the end screen is due (0xd3581c), as the battle manager does
      this.acc += dt * this.speed;
      let n = 0;
      while (this.acc >= TICK_MS && n < 200) {
        this.stepOnce();
        this.acc -= TICK_MS;
        n++;
        if (this.battle.stopped) break;
      }
    } else if (!this.paused) {
      // Then the logic stays on its last tick, but the client keeps running the battle layer every frame
      // (battle screen update 0xbe1d3c -> 0x856f28: views, effects, clouds, shake; the result screen): the
      // visual clock runs on past the last tick.
      this.afterEnd += dt * this.speed;
    }
    this.frame.alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_MS);
    this.frame.now = t;
    this.frame.simMs = this.battle.tick * TICK_MS + this.frame.alpha * TICK_MS + this.afterEnd;
    this.updatePreview();
    this.world.draw(this.frame);
    this.overlay.draw(this.frame);
    if (DEV) this.updateDevHud();
    sound.update();
    requestAnimationFrame((tt) => this.loop(tt));
  }

  stepOnce(): void {
    // a stopped battle does not step: its last tick's events must not be handed to the views again
    if (this.battle.stopped) return;
    this.frame.snapshot(this.battle);
    for (const a of this.agents) {
      const d = a?.decide(this.battle);
      if (a && d) this.playCard(a.team, d.slot, d.x, d.y);
    }
    const r = this.replay;
    if (r) {
      // the recorded plays of this tick, in their recorded order, through the hand path
      this.replaying = true;
      while (this.replayAt < r.plays.length && r.plays[this.replayAt][0] <= this.battle.tick) {
        const [tick, team, slot, x, y] = r.plays[this.replayAt++];
        if (tick === this.battle.tick) this.playCard(team, slot, x, y);
      }
      this.replaying = false;
    }
    // AI sides decide on the state before the tick, blue then red; their plays take the hand path
    for (const bot of this.bots) {
      const d = bot?.decide(this.battle);
      if (bot && d) this.playCard(bot.team, d.slot, d.x, d.y);
    }
    const t0 = performance.now();
    this.battle.step();
    for (const a of this.agents) a?.observe(this.battle);
    this.tickTimes.push(performance.now() - t0);
    if (this.tickTimes.length > 100) this.tickTimes.shift();
    this.world.onEvents?.(this.frame);
  }

  // ------------------------------------------------------------------ input (canvas HUD)

  private boardXY(e: PointerEvent): [number, number] {
    const r = $('board').getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Board CSS px -> logic position (the camera uses the client's battle transform). */
  private logicAt(px: number, py: number): { x: number; y: number } {
    return { x: Math.round(this.cam.gx(px)), y: Math.round(this.cam.gy(py)) };
  }

  private bindPointer(): void {
    const board = $('board');
    board.addEventListener('pointerdown', (e) => {
      const ui = this.ui;
      if (!ui) return;
      e.preventDefault();
      const [bx, by] = this.boardXY(e);
      const L = ui.layout;
      // result screen OK (sc/result.ts): a game button, held (Down) until the touch ends on it
      if (ui.screens.okPress(bx, by, L)) { this.uiHeld = 'ok'; board.setPointerCapture(e.pointerId); return; }
      // HUD_taunt's emote button, mute button and menu items (sc/emotes.ts, game layer +0x178, on top)
      const [sx, sy] = ui.hud.toStage(bx, by);
      if (ui.emotes?.pointerDown(sx, sy, L.stageW, L.stageH)) { this.uiHeld = 'emote'; board.setPointerCapture(e.pointerId); return; }
      // the intro banner takes the touch (hold at holdFrame, 0x8cace4)
      ui.screens.introTouchDown();
      // battle input is blocked by the intro before its actionFrame and once the battle is over (0xbe4400)
      if (ui.screens.inputBlocked) return;
      const slot = ui.hud.cardAt(sx, sy);
      const team = ui.hud.team;
      // a touch on the arena (above the hand panel; which touches the battle screen gets there is A) with no
      // card selected: a tap that may end in 0xbe1120's floater
      this.tapStart = slot < 0 && ui.hud.selected < 0 && sy < ui.hud.handTop ? [sx, sy] : null;
      if (slot >= 0) {
        const p = this.battle.players[team];
        const home = ui.hud.slotPos(slot);
        this.drag = { team, slot, card: p.deck[p.hand[slot]].name, sx, sy, moved: false, previewOn: false, px: bx, py: by, dom: null,
          gx: home ? home.x - sx : 0, gy: home ? home.y - sy : 0 };
        board.setPointerCapture(e.pointerId);
        this.dragMove(bx, by);
      } else if (ui.hud.selected >= 0 && sy < ui.hud.handTop) {
        // A touch on the arena with a card selected (battle screen touch begin 0xbe08d8): with the emote
        // menu closed (0x8d1adc), no arena drag in progress (+0x358), the battle not over (0xd4220c) and
        // the selected card (0x8d52ac: the first slot holding a card with +0x319) not already in drag mode
        // (+0x318: dragged, or released and waiting for its elixir), that card takes the touch (0x8e30c0:
        // its touch begin 0x8e2894, the drag start 0x8e2a74 at the touch point, its touch move 0x8e2948,
        // then the grab offset +0x2c8/+0x2cc zeroed). It is then an ordinary drag: the moves update it
        // (0xbe0aa0 -> card vt+0x118) and the touch end releases it (0xbe1120 -> card vt+0x120 0x8e2c04),
        // so the play is submitted at the touch end with the drag preview's leftover, or waits for its
        // elixir, exactly like a card dragged from the hand.
        const slotSel = ui.hud.selected;
        const p = this.battle.players[team];
        const def = p.hand[slotSel] >= 0 ? p.deck[p.hand[slotSel]] : undefined;
        if (def && !this.drag && this.held?.slot !== slotSel && !ui.emotes?.menuOpen && !this.battle.result) {
          this.drag = { team, slot: slotSel, card: def.name, sx, sy, moved: true, previewOn: false, px: bx, py: by, dom: null, gx: 0, gy: 0 };
          board.setPointerCapture(e.pointerId);
          this.dragMove(bx, by);
        }
      }
    });
    board.addEventListener('pointermove', (e) => {
      const ui = this.ui;
      if (ui && this.uiHeld) {
        const [bx, by] = this.boardXY(e);
        const [sx, sy] = ui.hud.toStage(bx, by);
        if (this.uiHeld === 'ok') ui.screens.okMove(bx, by, ui.layout);
        else ui.emotes?.pointerMove(sx, sy, ui.layout.stageW, ui.layout.stageH);
        return;
      }
      if (!this.drag || this.drag.dom) return;
      const [bx, by] = this.boardXY(e);
      this.dragMove(bx, by);
    });
    const end = (e: PointerEvent) => {
      const ui = this.ui;
      if (ui && this.uiHeld) {
        const held = this.uiHeld;
        this.uiHeld = null;
        const [bx, by] = this.boardXY(e);
        const [sx, sy] = ui.hud.toStage(bx, by);
        if (held === 'ok') {
          // OK: the click sound, then leave the battle; the client returns home, here a new battle starts
          if (ui.screens.okRelease(bx, by, ui.layout)) { ui.click(); this.newBattle(); }
        } else {
          const t = ui.emotes?.pointerUp(sx, sy, ui.layout.stageW, ui.layout.stageH);
          if (t) ui.sendTaunt(t);
        }
        return;
      }
      // a touch ending on the battle screen: the intro lets go (0x8cad48); 0xbe1120: without a card drag, a
      // selected card or the emote menu open, a tap on the arena shows TID_NO_SPELL_SELECTED_TAP; then the
      // emote menu closes (0x8d120c)
      ui?.screens.introTouchUp();
      const tap = this.tapStart;
      this.tapStart = null;
      if (ui && tap && !this.drag && ui.hud.selected < 0 && !ui.emotes?.menuOpen && !ui.screens.inputBlocked && !this.battle.result) {
        ui.noCardSelected(ui.hud.toStage(...this.boardXY(e))[1]);
      }
      ui?.emotes?.closeMenu();
      const d = this.drag;
      if (!d || d.dom) return;
      this.drag = null;
      if (!ui) return;
      if (!d.moved) {
        // tap: toggle the card's selection
        ui.hud.drag = null;
        ui.hud.select(ui.hud.selected === d.slot ? -1 : d.slot);
        return;
      }
      [d.px, d.py] = this.boardXY(e); // touch-end point (+0x328)
      this.touchEnd(d);
    };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
  }

  /**
   * Touch end of a dragged hand card (0x8e2c04). With MAX_SPELL_PENDING_TIME > 0, a card that is not
   * affordable (+0x31a) but will be within that time (0x8e2d50), dropped outside the own back rows
   * (0xbe1500: logic Globals +0x1c8 rows, which is 0 - zeroed by the constructor 0xe367f4 -> 0xe36aac and
   * written by neither loader - so "in the back rows" is beyond the own arena edge, the line where the card
   * visual finishes shrinking in 0x8e1fb8), stays in
   * drag mode with its preview and waits (+0x324): any other waiting card is released first (0x8d112c ->
   * 0x8e2b6c). Otherwise it is released now (0x8e29f4 -> 0xbe1634, then 0x8e1004).
   */
  private touchEnd(d: Drag): void {
    const ui = this.ui;
    if (!ui) return;
    const b = this.battle;
    const p = b.players[d.team];
    const def = p.deck[p.hand[d.slot]];
    const avail = p.elixir - p.pending;
    const hundredths = avail < 1 ? 0 : Math.trunc(Math.min(avail, b.maxElixir) / 100);
    const affordNow = b.infiniteElixir || (!!def && def.cost * 100 <= hundredths);
    const soon = !!def && affordableSoon(hundredths, def.cost, this.msPerElixir());
    if (def && dropWaits(affordNow, soon, this.cardScale(d) > 0)) {
      const other = this.held;
      if (other) { ui.hud.stopWait(other.slot); this.releaseHeld(other.slot); }
      ui.hud.startWait(d.slot, MAX_SPELL_PENDING_TIME_S);
      this.held = d;
      ui.hud.held = ui.hud.drag;
      ui.hud.drag = null;
      ui.holdPreview();
      return;
    }
    ui.hud.drag = null;
    this.release(d, 0);
  }

  /** The waiting card in `slot` is released (its time is up or it became affordable, 0x8e1408). */
  private releaseHeld(slot: number): void {
    const d = this.held;
    const ui = this.ui;
    if (!d || d.slot !== slot || !ui) return;
    this.held = null;
    ui.hud.held = null;
    this.release(d, 1);
  }

  /**
   * Release at the touch-end point (0x8e29f4 -> 0x8e1fb8(0, card, 1) -> 0xbe1634): a play is submitted
   * only with the card's visual hidden (0xbe1634 param_6) and goes through the play check (0xd77504 via
   * 0xcc4658: here Battle.play). On success the preview leaves its ghosts, ring, indicator and name until
   * the cast (0xbe1aa8) and the card hides (0x8d5438 -> 0x8e2868); 0x8e1004 returns the card to its slot
   * and deselects it only after a successful play.
   */
  private release(d: Drag, which: 0 | 1): void {
    const ui = this.ui;
    if (!ui) return;
    // 0x8e29f4(touch-end point, card, 1) -> 0x8e1fb8 updates the drag preview at the touch-end point
    // before 0xbe1634 submits and 0xbe1aa8 builds the leftover from it. The client makes the preview in
    // the touch handlers, so it exists at the release however quick the touch was; here it is fed once
    // per frame, so it is brought up to the touch-end point now (a press and release with no frame in
    // between, e.g. a quick tap on the arena with a selected card, would otherwise leave nothing).
    const pv = this.previewOf(d);
    if (which === 0) ui.preview = pv;
    else ui.held = pv;
    let play: { x: number; y: number } | null = null;
    if (d.previewOn && this.cardScale(d) <= 0) {
      const pos = this.logicAt(d.px, d.py);
      play = this.playCard(d.team, d.slot, pos.x, pos.y);
    }
    ui.releasePreview(which, play);
  }

  /** ms per elixir (0xfa3e28): the timeline's current full-bar time (0xd448b0) / MAX_MANA. */
  private msPerElixir(): number {
    const b = this.battle;
    const sec = b.timeMs / 1000;
    let full = b.timeline.elixirRates[0].fullBarMs;
    for (const r of b.timeline.elixirRates) if (sec >= r.fromSec) full = r.fullBarMs;
    return Math.trunc(full / Math.trunc(b.maxElixir / 10000));
  }

  /** Card visual scale while dragged (0x8e1fb8): 1 - (d / span)^4 from its slot up to the arena's near edge, 0 = hidden. */
  private cardScale(d: Drag): number {
    const ui = this.ui;
    if (!ui) return 0;
    const slot = ui.hud.slotPos(d.slot);
    const [, sy] = ui.hud.toStage(d.px, d.py);
    if (!slot) return 0;
    // boundary: logic row Globals +0x1c8 (0) from the own side, i.e. the own edge of the arena (0x8e1fb8:
    // project(0, rows · 500) for the flipped view, (0, (mapH − rows) · 500) with mapH ctx +0x18c = 64 otherwise)
    const [, edge] = ui.toStage(...this.edgePx(d.team));
    const span = Math.max(1, slot.y - edge);
    const dist = slot.y - sy;
    if (dist <= 0) return 1;
    const t = (dist / span) ** 2;
    const s = Math.min(1, 1 - t * t);
    return s <= 0 ? 0 : s;
  }

  private edgePx(team: number): [number, number] {
    const art = (this.world as unknown as { ui?: BattleUi }).ui?.art;
    return art ? art.gameToPx(9000, team === 0 ? 0 : 32000) : [0, 0];
  }

  private previewAlpha(d: Drag): number {
    const s = this.cardScale(d);
    return d.previewOn ? 1 - (s <= 0 ? 0.01 : s) : 0;
  }

  private dragMove(bx: number, by: number): void {
    const d = this.drag;
    const ui = this.ui;
    if (!d || !ui) return;
    d.px = bx;
    d.py = by;
    const [sx, sy] = ui.hud.toStage(bx, by);
    if (Math.hypot(sx - d.sx, sy - d.sy) > 8) d.moved = true;
    if (!d.moved) return;
    ui.hud.select(d.slot);
    const s = this.cardScale(d);
    if (s <= 0) d.previewOn = true;
    ui.hud.drag = { slot: d.slot, card: d.card, x: sx, y: sy, cardScale: s, gx: d.gx, gy: d.gy };
  }

  /**
   * Each frame: feed the drag previews of the dragged card and of a card waiting for elixir (snapped by
   * the engine's deploy check prediction; an invalid position keeps the pointer's, 0xbe1634).
   */
  private updatePreview(): void {
    const ui = this.ui;
    if (!ui) return;
    // the overlay reads the selected card; the HUD shows the own team's hand
    ui.preview = this.previewOf(this.drag);
    ui.held = this.previewOf(this.held);
    if (ui.hud.drag && this.drag && !this.drag.dom) ui.hud.drag.cardScale = this.cardScale(this.drag);
    if (ui.hud.held && this.held) ui.hud.held.cardScale = this.cardScale(this.held);
  }

  private previewOf(d: Drag | null): PreviewInput | null {
    if (!d || !(d.previewOn || d.dom)) return null;
    const b = this.battle;
    const card = b.defs.card(d.card, b.levels[d.team]);
    const raw = d.dom ? this.domLogic(d) : this.logicAt(d.px, d.py);
    if (!raw) return null;
    const snapped = b.deployPlace(d.team, card, raw.x, raw.y);
    const hidden = d.dom !== null || this.cardScale(d) <= 0;
    const pos = snapped ?? raw;
    return { team: d.team, card: d.card, slot: d.slot, x: pos.x, y: pos.y, alpha: d.dom ? 1 : this.previewAlpha(d),
      valid: snapped !== null && hidden };
  }

  /** Submit a play now; the snapped play position, or null when the engine rejects it. */
  private playCard(team: number, slot: number, x: number, y: number): { x: number; y: number } | null {
    if (this.replay && !this.replaying) return null; // a replay owns both hands
    const b = this.battle;
    const err = b.play(team, slot, x, y);
    const ui = this.ui;
    if (err) {
      // an own play the client's check rejects for elixir shows "Not enough Elixir!" (0xd77504 -> 0xbe7184);
      // the submit 0xbe1634 sends only plays its deploy check accepts, with the snapped position
      if (err === 'elixir' && ui && team === ui.hud.team) {
        const p = b.players[team];
        const card = p.deck[p.hand[slot]];
        const at = card ? b.deployPlace(team, card, x, y) : null;
        if (at) ui.notEnoughElixir(at.x, at.y);
      }
      console.info('play rejected:', err);
      return null;
    }
    const cmd = b.commands[b.commands.length - 1];
    // the placed card hides in its slot until the slot changes (0xbe1634 -> 0x8d5438 -> 0x8e2868)
    if (ui && team === ui.hud.team) ui.hud.played(slot);
    const pos = cmd ? b.deployPlace(team, cmd.card, x, y) ?? { x, y } : { x, y };
    if (ui && cmd) ui.markPending(team, cmd.card.name, pos.x, pos.y, b.tick);
    return pos;
  }

  // ------------------------------------------------------------------ dev controls (?dev)

  private domLogic(d: Drag): { x: number; y: number } | null {
    const r = $('board').getBoundingClientRect();
    const x = d.px, y = d.py;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    return this.logicAt(x, y);
  }

  private setCard(el: HTMLElement, card: CardDef): void {
    if (el.dataset.card !== card.name) {
      el.dataset.card = card.name;
      const img = this.art?.cardImage(card.name);
      el.style.backgroundImage = img ? `url(${img})` : '';
      el.innerHTML = img ? '' : `<div class="cost">${card.cost}</div><div class="name">${displayName(card.name)}</div>`;
    }
  }

  /** ?dev: the red player's hand as a DOM strip for local two-player testing. */
  private buildRedHand(): void {
    const el = $('hand1');
    el.innerHTML = '';
    this.handEls = [];
    const next = document.createElement('div');
    next.className = 'card next';
    el.appendChild(next);
    this.nextEl = next;
    for (let s = 0; s < 4; s++) {
      const c = document.createElement('div');
      c.className = 'card';
      c.addEventListener('pointerdown', (ev) => this.startDomDrag(ev, 1, s, null));
      el.appendChild(c);
      this.handEls.push(c);
    }
    const ex = document.createElement('div');
    ex.className = 'elixir';
    ex.innerHTML = `<div class="num gt">6</div><div class="bar"><div class="fill"></div><div class="ticks"></div></div>`;
    el.appendChild(ex);
    this.elixirFill = ex.querySelector('.fill') as HTMLElement;
    this.elixirNum = ex.querySelector('.num') as HTMLElement;
  }

  private updateDevHud(): void {
    const b = this.battle;
    const p = b.players[1];
    for (let s = 0; s < 4 && s < this.handEls.length; s++) {
      const card = p.deck[p.hand[s]];
      const el = this.handEls[s];
      // an empty slot (card played, not yet refilled) or a card whose play has not committed yet
      const hidden = !card || b.commands.some((c) => c.team === 1 && c.slot === s);
      el.style.visibility = hidden ? 'hidden' : '';
      if (!card) continue;
      this.setCard(el, card);
      const ok = b.infiniteElixir || p.elixir - p.pending >= card.cost * 10000;
      el.classList.toggle('disabled', !ok);
    }
    if (this.nextEl && p.queue.length) this.setCard(this.nextEl, p.deck[p.queue[0]]);
    const avail = Math.max(0, p.elixir - p.pending);
    // DOM writes only on change (and the status text a few times a second): each write restyles and
    // repaints the panel
    const fillW = `${(avail / 100000) * 100}%`;
    if (this.elixirFill && this.elixirFill.style.width !== fillW) this.elixirFill.style.width = fillW;
    const num = String(Math.floor(avail / 10000));
    if (this.elixirNum && this.elixirNum.textContent !== num) this.elixirNum.textContent = num;
    const now = performance.now();
    if (now - this.statusAt < 250) return;
    this.statusAt = now;
    const avg = this.tickTimes.reduce((a, x) => a + x, 0) / Math.max(1, this.tickTimes.length);
    const st = $('status');
    const text =
      `tick ${b.tick}  (${(b.tick / 20).toFixed(1)} s)\n` +
      `actors ${b.units.length}, projectiles ${b.projectiles.length}\n` +
      `engine ${avg.toFixed(3)} ms/tick\n` +
      (b.result ? `result: ${b.result.winner === -1 ? 'draw' : b.result.winner === 0 ? 'blue' : 'red'} (${b.result.reason})` : '');
    if (st.textContent !== text) st.textContent = text;
  }

  private startDomDrag(ev: PointerEvent, team: number, slot: number, paletteCard: string | null): void {
    ev.preventDefault();
    const p = this.battle.players[team];
    const handCard = slot >= 0 ? p.deck[p.hand[slot]] : undefined;
    if (!paletteCard && !handCard) return; // empty slot
    const card = paletteCard ?? handCard!.name;
    this.art?.prewarm(cardArtNames(this.battle.defs.card(card, 11)));
    const ghost = document.createElement('div');
    ghost.className = 'card dragghost';
    const img = this.art?.cardImage(card);
    if (img) ghost.style.backgroundImage = `url(${img})`;
    else ghost.textContent = displayName(card);
    document.body.appendChild(ghost);
    const [bx, by] = this.boardXY(ev);
    this.drag = { team, slot, card, sx: 0, sy: 0, moved: true, previewOn: true, px: bx, py: by, dom: ghost, gx: 0, gy: 0 };
    const move = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      [d.px, d.py] = this.boardXY(e);
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      ghost.style.display = this.domLogic(d) ? 'none' : '';
    };
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const d = this.drag;
      this.drag = null;
      ghost.remove();
      if (!d) return;
      [d.px, d.py] = this.boardXY(e);
      const pos = this.domLogic(d);
      if (!pos) return;
      if (d.slot >= 0) this.playCard(d.team, d.slot, pos.x, pos.y);
      else {
        const err = this.battle.spawn(d.team, d.card, pos.x, pos.y);
        if (err) console.info('spawn rejected:', err);
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    move(ev);
  }

  bindControls(): void {
    if (!DEV) return;
    const btnPlay = $<HTMLButtonElement>('btnPlay');
    btnPlay.onclick = () => {
      this.paused = !this.paused;
      btnPlay.textContent = this.paused ? 'Play' : 'Pause';
      sound.setPaused(this.paused);
    };
    $<HTMLButtonElement>('btnStep').onclick = () => {
      this.paused = true;
      btnPlay.textContent = 'Play';
      sound.setPaused(true);
      this.stepOnce();
    };
    // speed cycles 0.25x .. 10x
    const speeds = [0.25, 0.5, 1, 2, 4, 10];
    const sp = $<HTMLButtonElement>('speed');
    sp.onclick = () => {
      this.speed = speeds[(speeds.indexOf(this.speed) + 1) % speeds.length];
      sp.textContent = `${this.speed}x`;
    };
    $<HTMLButtonElement>('btnReset').onclick = () => {
      this.seed = Number($<HTMLInputElement>('seed').value) || 1;
      this.newBattle();
    };
    const inf = $<HTMLButtonElement>('btnInf');
    inf.onclick = () => {
      this.infinite = !this.infinite;
      this.battle.infiniteElixir = this.infinite;
      inf.classList.toggle('on', this.infinite);
    };
    // game sound (sc/sound.ts): on by default, starts with the first click (browser autoplay rule)
    const snd = $<HTMLButtonElement>('btnSound');
    snd.classList.toggle('on', sound.enabled);
    snd.onclick = () => { sound.setEnabled(!sound.enabled); snd.classList.toggle('on', sound.enabled); };
    // AI toggles cycle off -> easy -> medium -> hard; a change applies from the next tick
    const aiNames = ['off', 'easy', 'medium', 'hard', 'RL agent'];
    const labels: (() => void)[] = [];
    for (const [id, t] of [['aiBlue', 0], ['aiRed', 1]] as const) {
      const btn = $<HTMLButtonElement>(id);
      const label = () => {
        const a = this.agents[t];
        const state = this.aiLevel[t] === AGENT_LEVEL && a ? (a.error ? ' (failed)' : a.loaded ? '' : ' (loading)') : '';
        btn.textContent = `${t === 0 ? 'Blue' : 'Red'} AI: ${aiNames[this.aiLevel[t]]}${state}`;
        btn.classList.toggle('on', this.aiLevel[t] > 0);
      };
      labels.push(label);
      label();
      btn.onclick = () => {
        const was = this.aiLevel[t];
        this.aiLevel[t] = (this.aiLevel[t] + 1) % aiNames.length;
        if (this.aiLevel[t] === AGENT_LEVEL || was === AGENT_LEVEL) {
          // the agent is trained on a mirror match: both sides get its deck while it plays (a new battle)
          this.decks = this.aiLevel.includes(AGENT_LEVEL) ? [AGENT_DECK.slice(), AGENT_DECK.slice()]
            : [DEFAULT_DECKS[0].slice(), DEFAULT_DECKS[1].slice()];
          this.prewarmDecks();
          this.newBattle();
        } else this.makeBots();
        label();
      };
    }
    this.onAgentLoaded = () => { for (const l of labels) l(); };
    // the AI never emotes (not a client feature); this sends the red side's emotes in turn for testing
    // (the opponent's taunt event, 0x8d601c type 3 -> 0x8d6820)
    const re = document.getElementById('emoteRed') as HTMLButtonElement | null;
    if (re) {
      re.onclick = () => {
        const ui = this.ui;
        const e = ui?.emotes;
        if (!ui || !e) return;
        const n = e.art.emotes.length + e.art.taunts.length;
        if (n > 0) ui.opponentTaunt(this.redEmote++ % n);
      };
    }
    const pb = $<HTMLButtonElement>('palBlue');
    const pr = $<HTMLButtonElement>('palRed');
    pb.onclick = () => { this.paletteTeam = 0; pb.classList.add('on'); pr.classList.remove('on'); };
    pr.onclick = () => { this.paletteTeam = 1; pr.classList.add('on'); pb.classList.remove('on'); };
    addEventListener('keydown', (e) => {
      if (e.key === ' ') { e.preventDefault(); btnPlay.click(); }
      else if (e.key === '.' || e.key === 'ArrowRight') $<HTMLButtonElement>('btnStep').click();
    });
  }

  buildPalette(): void {
    const el = $('palette');
    el.innerHTML = '';
    const supported = new Set(supportedCards(this.battle.defs));
    // any supported card, the focus decks' cards first
    const names = [...FOCUS_CARDS.filter((n) => supported.has(n)), ...[...supported].filter((n) => !FOCUS_CARDS.includes(n))];
    for (const name of names) {
      const card = this.battle.defs.card(name, 11);
      const c = document.createElement('div');
      c.className = 'card';
      this.setCard(c, card);
      c.addEventListener('pointerdown', (ev) => this.startDomDrag(ev, this.paletteTeam, -1, name));
      el.appendChild(c);
    }
  }
}

const AGENT_LEVEL = 4;
/** the deck the agent trains with on both sides (sim/rl/env.ts DEFAULT_ENV decks[0], --mirror) */
const AGENT_DECK = FOCUS_DECKS[0];
const AGENT_MODEL = 'models/agent.onnx';

/** A recorded match (sim/rl/env.ts RlEnv.replay()). */
interface Replay {
  v: number;
  seed: number;
  level: number;
  decks: [string[], string[]];
  /** [tick, team, slot, x, y] for every accepted Battle.play */
  plays: number[][];
  ctrl?: string[];
  result?: { winner: number; reason: string; tick: number } | null;
}

async function loadArt(): Promise<ArtHooks | null> {
  try {
    const res = await assetFetch('assets/manifest.json');
    if (!res.ok) return null;
    const manifest = await res.json();
    const mod = await import('./art.ts');
    return mod.createArt(manifest);
  } catch (e) {
    console.info('original art not baked; using placeholder renderer', e);
    return null;
  }
}

const app = new App();
(globalThis as unknown as { app: App }).app = app;
app.init();
