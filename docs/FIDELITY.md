# Mechanics fidelity tracker

Levels (see [GOAL.md](../GOAL.md#fidelity-policy)): **V** ported and
differentially verified against original code · **P** ported from decompiled
original code · **D** driven by the build's data files · **A** approximation
(say from where) · **–** not implemented.

Update a row in the same commit that changes the mechanic. "Owner check"
records the result of the owner's smell test, with the date.

| Area | Mechanic | Level | Source / notes | Owner check |
| --- | --- | --- | --- | --- |
| Match | Tick rate, match clock, overtime, sudden death | – | | |
| Match | Elixir generation, 2×/3× elixir phases, max elixir | – | | |
| Match | Deck, hand of 4, next card, cycle order | – | | |
| Match | Crowns, tower destruction, tiebreak by tower HP | – | | |
| Arena | Coordinate units, arena size, river, bridges | – | | |
| Arena | Deploy zones, pocket expansion after a tower falls | – | | |
| Deploy | Deploy delay, spawn formation of multi-unit cards | – | | |
| Movement | Speed units, bridge pathing, lane choice | – | | |
| Movement | Collision radius, mass, pushing, avoidance | – | | |
| Targeting | Sight range, target selection, retarget rules, building-only targeting | – | | |
| Targeting | Air vs ground targeting | – | | |
| Attack | Load time/windup, hit speed, first-hit timing, attack reset on retarget | – | | |
| Attack | Melee damage, ranged projectiles, homing, splash radius | – | | |
| Towers | Princess and King stats, King activation, tower targeting | – | | |
| Spells | Area damage, crown-tower damage reduction, travel time | – | | |
| Effects | Stun, slow, freeze, rage, knockback, pull | – | | |
| Special | Charge, dash, jump, spawners, death spawn, chain lightning, evolutions, champions | – | | |
| Scaling | Level and rarity scaling of HP and damage | – | | |
