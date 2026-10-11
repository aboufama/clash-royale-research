import { Battle, type BattleConfig, ST_ACTIVE, Unit } from '../src/index.ts';
import { loadGameData } from '../src/node.ts';

export const data = loadGameData();

export const DECK_A = ['Knight', 'Archer', 'Giant', 'Musketeer', 'Fireball', 'Arrows', 'MiniPekka', 'Valkyrie'];
export const DECK_B = ['BabyDragon', 'Minions', 'Skeletons', 'Goblins', 'Bomber', 'Wizard', 'Barbarians', 'Pekka'];

export function newBattle(cfg: Partial<BattleConfig> = {}): Battle {
  return new Battle(data, { seed: 1, decks: [DECK_A, DECK_B], noShuffle: true, ...cfg });
}

/** Insert an already-active unit (test fixture, like the native synthetic fixtures). */
export function addActive(b: Battle, name: string, team: number, x: number, y: number, level = 11): Unit {
  const def = b.defs.unit(name, level);
  const u = new Unit((b as unknown as { nextId: number }).nextId++, def, name, team, x, y, b.tick);
  u.state = ST_ACTIVE;
  b.units.push(u);
  return u;
}

/** Deterministic random legal-play policy for smoke tests and benchmarks. */
export function randomPolicy(b: Battle, rngState: { s: number }, team: number): void {
  const r = () => {
    rngState.s = (Math.imul(rngState.s, 1664525) + 1013904223) >>> 0;
    return rngState.s;
  };
  if (r() % 10 !== 0) return;
  const slot = r() % 4;
  const x = r() % 18000;
  const y = team === 0 ? r() % 15000 : 17000 + (r() % 15000);
  const p = b.players[team];
  const card = p.deck[p.hand[slot]];
  const tx = card.type === 'spell' ? r() % 18000 : x;
  const ty = card.type === 'spell' ? r() % 32000 : y;
  b.play(team, slot, tx, ty);
}
