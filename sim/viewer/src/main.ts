// Viewer entry: real-time loop at the engine's 20 Hz with render interpolation, hands for
// both players with drag-and-drop, a sandbox palette, pause/step/speed controls.
import { Battle, type CardDef, type GameData, supportedCards } from '../../core/src/index.ts';
import gameDataJson from '../../data/gamedata.json';
import { Camera } from './camera.ts';
import { Frame, type WorldRenderer } from './frame.ts';
import { Overlay } from './overlay.ts';
import { PlaceholderRenderer } from './placeholder.ts';

const data = gameDataJson as unknown as GameData;
const TICK_MS = 50;

const DEFAULT_DECKS: [string[], string[]] = [
  ['Knight', 'Archer', 'Giant', 'Musketeer', 'MiniPekka', 'Valkyrie', 'Fireball', 'Arrows'],
  ['BabyDragon', 'Wizard', 'Pekka', 'Minions', 'SkeletonArmy', 'Bomber', 'Fireball', 'Arrows'],
];

export interface ArtHooks {
  makeRenderer(canvas: HTMLCanvasElement, cam: Camera): Promise<WorldRenderer | null>;
  cardImage(card: string): string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function displayName(card: string): string {
  const r = data.cards[card];
  return (r && typeof r._displayName === 'string' ? r._displayName : card) as string;
}

class App {
  battle!: Battle;
  cam = new Camera();
  frame = new Frame();
  world!: WorldRenderer;
  overlay: Overlay;
  paused = false;
  speed = 1;
  acc = 0;
  last = 0;
  seed = 1;
  infinite = false;
  paletteTeam = 0;
  art: ArtHooks | null = null;
  decks: [string[], string[]] = [DEFAULT_DECKS[0].slice(), DEFAULT_DECKS[1].slice()];
  private handEls: HTMLElement[][] = [[], []];
  private nextEls: HTMLElement[] = [];
  private elixirFill: HTMLElement[] = [];
  private elixirNum: HTMLElement[] = [];
  private drag: { team: number; slot: number; card: string; ghost: HTMLElement } | null = null;
  private tickTimes: number[] = [];

  constructor() {
    this.overlay = new Overlay($('overlay'));
  }

  async init(): Promise<void> {
    this.art = await loadArt();
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
    this.newBattle();
    this.bindControls();
    this.buildPalette();
    addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  newBattle(): void {
    this.battle = new Battle(data, { seed: this.seed, decks: this.decks, recordEvents: true });
    this.battle.infiniteElixir = this.infinite;
    this.frame.battle = this.battle;
    this.frame.cam = this.cam;
    this.frame.snapshot(this.battle);
    this.acc = 0;
    this.buildHands();
  }

  resize(): void {
    const board = $('board');
    const r = board.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.cam.fit(r.width, r.height, dpr);
    this.world.resize(r.width, r.height, dpr);
    this.overlay.resize(r.width, r.height, dpr);
  }

  loop(t: number): void {
    const dt = this.last ? Math.min(250, t - this.last) : 0;
    this.last = t;
    if (!this.paused && !this.battle.ended) {
      this.acc += dt * this.speed;
      let n = 0;
      while (this.acc >= TICK_MS && n < 200) {
        this.stepOnce();
        this.acc -= TICK_MS;
        n++;
      }
    }
    this.frame.alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_MS);
    this.frame.now = t;
    this.frame.simMs = this.battle.tick * TICK_MS + this.frame.alpha * TICK_MS;
    this.world.draw(this.frame);
    this.overlay.draw(this.frame);
    this.updateHud();
    requestAnimationFrame((tt) => this.loop(tt));
  }

  stepOnce(): void {
    this.frame.snapshot(this.battle);
    const t0 = performance.now();
    this.battle.step();
    this.tickTimes.push(performance.now() - t0);
    if (this.tickTimes.length > 100) this.tickTimes.shift();
    this.world.onEvents?.(this.frame);
  }

  // ------------------------------------------------------------------ HUD

  buildHands(): void {
    for (const team of [0, 1]) {
      const el = $(`hand${team}`);
      el.innerHTML = '';
      this.handEls[team] = [];
      const next = document.createElement('div');
      next.className = 'card next';
      el.appendChild(next);
      this.nextEls[team] = next;
      for (let s = 0; s < 4; s++) {
        const c = document.createElement('div');
        c.className = 'card';
        c.addEventListener('pointerdown', (ev) => this.startDrag(ev, team, s, null));
        el.appendChild(c);
        this.handEls[team].push(c);
      }
      const ex = document.createElement('div');
      ex.className = 'elixir';
      ex.innerHTML = `<div class="num">6</div><div class="bar"><div class="fill"></div><div class="ticks"></div></div>`;
      el.appendChild(ex);
      this.elixirFill[team] = ex.querySelector('.fill') as HTMLElement;
      this.elixirNum[team] = ex.querySelector('.num') as HTMLElement;
    }
  }

  private setCard(el: HTMLElement, card: CardDef, small = false): void {
    if (el.dataset.card !== card.name) {
      el.dataset.card = card.name;
      const img = this.art?.cardImage(card.name);
      el.style.backgroundImage = img ? `url(${img})` : '';
      // the original card art carries its own elixir cost
      el.innerHTML = img ? '' : `${small ? '' : `<div class="cost">${card.cost}</div>`}<div class="name">${displayName(card.name)}</div>`;
    }
  }

  updateHud(): void {
    const b = this.battle;
    for (const team of [0, 1]) {
      const p = b.players[team];
      for (let s = 0; s < 4; s++) {
        const card = p.deck[p.hand[s]];
        const el = this.handEls[team][s];
        this.setCard(el, card);
        const ok = b.infiniteElixir || p.elixir - p.pending >= card.cost * 10000;
        el.classList.toggle('disabled', !ok || b.tick < p.slotReady[s]);
      }
      this.setCard(this.nextEls[team], p.deck[p.queue[0]], true);
      const avail = Math.max(0, p.elixir - p.pending);
      this.elixirFill[team].style.width = `${(avail / 100000) * 100}%`;
      this.elixirNum[team].textContent = String(Math.floor(avail / 10000));
    }
    const avg = this.tickTimes.reduce((a, x) => a + x, 0) / Math.max(1, this.tickTimes.length);
    $('status').textContent =
      `tick ${b.tick}  (${(b.tick / 20).toFixed(1)} s)\n` +
      `actors ${b.units.length}, projectiles ${b.projectiles.length}\n` +
      `engine ${avg.toFixed(3)} ms/tick\n` +
      (b.result ? `result: ${b.result.winner === -1 ? 'draw' : b.result.winner === 0 ? 'blue' : 'red'} (${b.result.reason})` : '');
  }

  // ------------------------------------------------------------------ input

  private startDrag(ev: PointerEvent, team: number, slot: number, paletteCard: string | null): void {
    ev.preventDefault();
    const p = this.battle.players[team];
    const card = paletteCard ?? p.deck[p.hand[slot]].name;
    const ghost = document.createElement('div');
    ghost.className = 'card';
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.75';
    ghost.style.zIndex = '10';
    ghost.style.transform = 'translate(-50%,-50%) scale(.8)';
    const img = this.art?.cardImage(card);
    if (img) ghost.style.backgroundImage = `url(${img})`;
    else ghost.textContent = displayName(card);
    document.body.appendChild(ghost);
    this.drag = { team, slot, card, ghost };
    const move = (e: PointerEvent) => this.dragMove(e);
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.dragEnd(e);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    this.dragMove(ev);
  }

  private boardPos(e: PointerEvent): { x: number; y: number } | null {
    const r = $('board').getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return null;
    return { x: Math.round(this.cam.gx(sx)), y: Math.round(this.cam.gy(sy)) };
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    d.ghost.style.left = `${e.clientX}px`;
    d.ghost.style.top = `${e.clientY}px`;
    const pos = this.boardPos(e);
    if (!pos) { this.frame.drag = null; d.ghost.style.display = ''; return; }
    const b = this.battle;
    const card = b.defs.card(d.card, b.levels[d.team]);
    const isSpell = card.type === 'spell';
    let snapped: { x: number; y: number } | null;
    if (d.slot >= 0) {
      const r = b.checkPlay(d.team, d.slot, pos.x, pos.y);
      snapped = typeof r === 'string' ? (r === 'elixir' || r === 'slot-cooldown' ? null : null) : r;
      if (typeof r === 'string' && r !== 'position') {
        // still show where it would go
        snapped = null;
      }
    } else {
      snapped = isSpell ? pos : b.snapDeploy(d.team, pos.x, pos.y, card);
      if (snapped && !b.deployPositionOk(d.team, snapped.x, snapped.y, card)) snapped = null;
    }
    const radius = isSpell ? Math.max(card.spellRadius, card.spellProjectile?.radius ?? 0) : card.summon[0]?.unit.collisionRadius ?? 500;
    this.frame.drag = { team: d.team, card: d.card, x: pos.x, y: pos.y, snapped, radius, isSpell };
    d.ghost.style.display = 'none';
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.frame.drag = null;
    if (!d) return;
    d.ghost.remove();
    const pos = this.boardPos(e);
    if (!pos) return;
    const err = d.slot >= 0 ? this.battle.play(d.team, d.slot, pos.x, pos.y) : this.battle.spawn(d.team, d.card, pos.x, pos.y);
    if (err) console.info('play rejected:', err);
  }

  // ------------------------------------------------------------------ controls

  bindControls(): void {
    const btnPlay = $<HTMLButtonElement>('btnPlay');
    btnPlay.onclick = () => {
      this.paused = !this.paused;
      btnPlay.textContent = this.paused ? 'Play' : 'Pause';
    };
    $<HTMLButtonElement>('btnStep').onclick = () => {
      this.paused = true;
      btnPlay.textContent = 'Play';
      this.stepOnce();
    };
    $<HTMLSelectElement>('speed').onchange = (e) => { this.speed = Number((e.target as HTMLSelectElement).value); };
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
    for (const name of supportedCards(this.battle.defs)) {
      const card = this.battle.defs.card(name, 11);
      const c = document.createElement('div');
      c.className = 'card';
      this.setCard(c, card);
      c.addEventListener('pointerdown', (ev) => this.startDrag(ev, this.paletteTeam, -1, name));
      el.appendChild(c);
    }
  }
}

async function loadArt(): Promise<ArtHooks | null> {
  try {
    const res = await fetch('assets/manifest.json');
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
