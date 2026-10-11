// Differential tests against native fixture traces recorded by the research track
// (research/evidence/*.json). Each starts from the recorded tick-0 state and compares
// every later tick.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Battle, KING_ACTIVE, ST_ACTIVE, ST_DEAD, TOWER_KING, Unit } from '../src/index.ts';
import { data, DECK_A, DECK_B } from './helpers.ts';

interface Actor { present: boolean; hp: number; attack_timer: number; position: [number, number]; target: string }
interface Tick {
  tick: number;
  source: Actor;
  target: Actor;
  kings: { pointer: string; hp: number }[];
  live_actors: { pointer: string; data_id: number; vtable_va: string; position: [number, number] }[];
}

const trace = JSON.parse(readFileSync(new URL('../../../research/evidence/native-automatic-combat.json', import.meta.url), 'utf8')) as { ticks: Tick[] };

function king(b: Battle, team: number, x: number, y: number): Unit {
  const u = new Unit(b.allocId(), b.defs.tower('king', 1), '', team, x, y, 0);
  u.state = ST_ACTIVE;
  u.tower = TOWER_KING;
  u.kingState = KING_ACTIVE;
  b.units.push(u);
  return u;
}

function knight(b: Battle, team: number, x: number, y: number): Unit {
  const u = new Unit(b.allocId(), b.defs.unit('Knight', 1), 'Knight', team, x, y, 0);
  u.state = ST_ACTIVE;
  b.units.push(u);
  return u;
}

test('native automatic combat: Knights vs King towers, 400 ticks (5x5 synthetic arena)', () => {
  const t0 = trace.ticks[0];
  const b = new Battle(data, { seed: 1, decks: [DECK_A, DECK_B], fixture: { width: 2500, height: 2500 } });
  // Native live-list order: KingA, KingB, T (team 1 knight), S (team 0 knight).
  const kA = king(b, 0, 1000, 500);
  const kB = king(b, 1, 1000, 2000);
  const T = knight(b, 1, ...t0.target.position);
  const S = knight(b, 0, ...t0.source.position);
  // tick-0 state: timers already advanced once; targets as recorded
  for (const u of [S, T]) u.atkTimer = 750;
  for (const k of [kA, kB]) k.atkTimer = 550;
  S.target = T; S.locked = true;
  T.target = kA; T.locked = true;
  kA.target = T; kA.locked = true;
  kB.target = S; kB.locked = true;
  b.tick = 1;

  let maxPosErr = 0;
  let exactPos = 0;
  let comparedPos = 0;
  const hpMismatch: string[] = [];
  const projMismatch: string[] = [];
  for (const rec of trace.ticks.slice(1)) {
    b.step();
    assert.equal(b.tick - 1, rec.tick);
    for (const [u, a, name] of [[S, rec.source, 'S'], [T, rec.target, 'T']] as const) {
      if (!a.present) {
        if (u.state !== ST_DEAD) hpMismatch.push(`${rec.tick} ${name} alive in sim (hp ${u.hp}) but gone natively`);
        continue;
      }
      if (u.hp !== a.hp) hpMismatch.push(`${rec.tick} ${name} hp ${u.hp} != ${a.hp}`);
      const e = Math.max(Math.abs(u.x - a.position[0]), Math.abs(u.y - a.position[1]));
      maxPosErr = Math.max(maxPosErr, e);
      comparedPos++;
      if (e === 0) exactPos++;
    }
    const khp = [kA.hp, kB.hp];
    rec.kings.forEach((k, i) => { if (khp[i] !== k.hp) hpMismatch.push(`${rec.tick} king${i} hp ${khp[i]} != ${k.hp}`); });
    const nat = rec.live_actors.filter((a) => a.vtable_va === '0x1936050').map((a) => a.position.join(',')).sort();
    const sim = b.projectiles.map((p) => `${p.x},${p.y}`).sort();
    if (nat.join(';') !== sim.join(';')) projMismatch.push(`${rec.tick} native [${nat.join(' ')}] sim [${sim.join(' ')}]`);
  }
  console.log(`positions: ${exactPos}/${comparedPos} exact, max error ${maxPosErr} units`);
  if (hpMismatch.length) console.log('hp mismatches:', hpMismatch.slice(0, 10));
  if (projMismatch.length) console.log(`projectile mismatches (${projMismatch.length}):`, projMismatch.slice(0, 6));
  assert.deepEqual(hpMismatch, [], 'every HP value matches the native trace');
  assert.ok(maxPosErr <= 6, `push positions within 6 units (got ${maxPosErr})`);
});
