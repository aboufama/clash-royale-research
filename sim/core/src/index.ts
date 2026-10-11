// Public API of the simulator core. The core has no DOM or Node dependencies.
export { Battle, COMMAND_DELAY_TICKS } from './battle.ts';
export type { BattleConfig, BattleResult, Player, PlayError } from './battle.ts';
export { Arena, ARENA_H, ARENA_W, CELL, GRID_H, GRID_W, RIVER_Y0, RIVER_Y1 } from './arena.ts';
export { Defs, M1_CARDS, scaleStat, TICK_MS, ELIXIR_ONE } from './data.ts';
export type { CardDef, GameData, ProjectileDef, UnitDef } from './data.ts';
export {
  KING_ACTIVATING, KING_ACTIVE, KING_INACTIVE, Projectile, ST_ACTIVE, ST_DEAD, ST_DEPLOYING, TOWER_KING,
  TOWER_NONE, TOWER_PRINCESS, Unit,
} from './entities.ts';
export type { BattleEvent, Command } from './entities.ts';
