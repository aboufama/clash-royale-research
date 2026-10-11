// Node-only helpers (file loading). Not imported by the browser build.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameData } from './data.ts';

export const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../data/gamedata.json');

let cached: GameData | null = null;

export function loadGameData(path = DATA_PATH): GameData {
  if (!cached || path !== DATA_PATH) {
    const d = JSON.parse(readFileSync(path, 'utf8')) as GameData;
    if (path !== DATA_PATH) return d;
    cached = d;
  }
  return cached;
}
