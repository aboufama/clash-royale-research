// The demo's 16 focus cards (engine names), narrowed by the owner: quality over quantity.
// Blue (team 0) and red (team 1) play these decks by default; the ?dev palette offers the same 16.

export const FOCUS_DECKS: readonly [readonly string[], readonly string[]] = [
  ['Knight', 'Archer', 'Giant', 'Musketeer', 'MiniPekka', 'SpearGoblins', 'Fireball', 'Arrows'],
  ['Valkyrie', 'BabyDragon', 'HogRider', 'SkeletonArmy', 'Minions', 'Cannon', 'GoblinBarrel', 'Log'],
];

export const FOCUS_CARDS: readonly string[] = [...FOCUS_DECKS[0], ...FOCUS_DECKS[1]];
