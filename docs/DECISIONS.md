# Decisions

Newest first. Each entry gives the decision, why it was made, and what would
change it.

## 2026-10-12 — Scripted AI opponent: data-driven heuristics, not a native port

- **Decision:** `sim/core/src/bot.ts` adds `Bot`, a deterministic scripted
  player for either side and any supported deck (`new Bot(team, { seed, level })`,
  then `bot.act(battle)` once per tick before `battle.step()`). It is **not** a
  port: the original client's AI is not used, decompiled or imitated, and the
  bot claims no native fidelity (FIDELITY row "Scripted AI opponent", level –).
  It plays only through `Battle.play`, so it changes no engine mechanic.
- **How it plays:** card roles come from the build's data through the engine's
  definitions, never from card names: hit points (with shields, spawner and
  death-spawn shares), dps against ground, air and crown towers (projectile
  damage, splash and piercing radii, chain hops, the inferno ramp, charge
  damage), building targeting, flying, range, speed, elixir handed to the
  opponent on death, and for spells damage, tower damage, radius, rolling
  length, strikes, stun and damage over time. Decisions use a coarse
  Lanchester-style fight estimate (time for each side to kill the other, a
  splash bonus against counts, a single-target overkill floor, tower dps
  covering the fight, ranged troops shielded by the tower only when the
  geometry says so, fire that cannot target our troops landing on the tower)
  scored in elixir-equivalents: value killed, tower HP lost (24 elixir per
  Princess tower, 60 for the King), survivors' value, cost.
  - *Defence:* enemy troops near or over the river are grouped by lane; every
    hand card is scored against the group at a role-dependent spot (buildings
    in the centre to pull, ranged troops behind the tower the threat walks to,
    melee in front and pulled to the centre, swarms and building-targeting
    sponges on top of the threat); spells re-run the fight on what they leave.
    The bot waits for elixir when an unaffordable card is clearly better and
    time allows, and plays a cheap card to draw the next card when only that
    card answers the threat (the next card is visible to a player).
  - *Offence:* the same model run the other way: our troops in a lane against
    the enemy's defenders there, their tower and a virtual defender for the
    elixir they will have when the push arrives. Placements: the bridge (the
    pocket after a Princess tower falls), behind or in front of a push, slow
    tanks in the back, Miner and Goblin Barrel on the tower, siege at the river.
    Spells are cast for value (clusters, tower finishes; chip damage late).
  - *Elixir:* a reserve sized from enemy troops walking at us and their bar,
    punish when they are low, play rather than leak, save up for and unclog
    cards held too long, press when level or behind late and in overtime, hold
    back when ahead.
  - *Levels:* 1–3 change think rate, reaction time, placement jitter, the play
    gap, the spell threshold, a share of hesitations or random natural plays,
    and whether the cycling and saving tricks are used.
- **Determinism:** decisions read only the battle state (including the
  opponent's elixir, as an elixir counter would, but not their hand or pending
  plays) and the bot's own seeded xorshift32; float math uses only exact IEEE
  operations; bot-vs-bot matches replayed from the same seeds reproduce the
  state hash (tests and `node sim/bench/bot.ts`).
- **Why:** the owner wants an opponent in the viewer and a baseline for
  training; a heuristic player is quick to build, costs about 2 µs per tick
  and works with any deck. Native fidelity of the opponent's decisions is not
  a goal of the simulator.
- **Would change if:** a trained policy (M3) outplays it, or the owner wants the
  native client's AI behaviour (that would need its own research and port).

## 2026-10-11 — Follow the decompiled code literally, even where it surprises

- **Decision:** where the decompiled libg code disagrees with community
  knowledge or earlier approximations, the engine follows the code and records
  the rule (with its address) in docs/FIDELITY.md. Examples now in the engine:
  river tiles do not block walking units (path costs keep them off; deploying
  ground units are blocked); attacks reset whenever a unit stops swinging;
  area effects act from the tick after they are created; summon formations
  and SummonCharactersOffsets are authored for the top side and negated for
  team 0; knockback travels short of its nominal distance (unguarded −25
  step); Arrows are 10 scattered arrows per wave sharing one hit list.
- **Why:** the owner asked for byte-identical behaviour; the decompiled code is
  the best available evidence, and each port that could be checked (A*: 12
  native cases; attack and push: the 400-tick trace) matched exactly.
- **Would change if:** a native trace contradicts a port (then the reading of
  the code is wrong and gets fixed), or the owner's play-testing shows a
  difference that a trace confirms.

## 2026-10-11 — Native recovery and decompilation in the cloud (work/native)

- **Decision:** the decrypted libg was rebuilt in the cloud with the public
  recovery scripts and decompiled with headless Ghidra 12.1.4 under the
  ignored `work/native/` (PORT_NOTES.md, `decomp/*.c`, `decompile.sh`). Nothing
  from it is committed; the engine cites function addresses instead.
- **Why:** the Mac-only artifacts are unreachable from the cloud, and porting
  needs the code. The repository rules keep decoded material out of git.
- **Would change if:** the owner wants the decompiler outputs versioned (they
  would stay in this private repository only).

## 2026-10-11 — Collision push: ported (supersedes the fitted rule)

- **Decision:** the fitted push rule below was replaced by the decompiled
  Movement_collidePush 0xfce900 and geometricStep 0xfcef48. The 400-tick native
  trace now matches 539/539 positions exactly (the fit gave 508/539).

## 2026-10-11 — Battle RNG: native algorithm, local seed

- **Decision:** in-battle randomness (spell scatter) uses the native xorshift32
  algorithm (0x1294bb4) seeded from the config seed; the deck shuffle keeps
  its own generator.
- **Why:** the native seed comes from the server and is not available; the
  algorithm and the order of draws are what make the distribution right.
- **Would change if:** a native match with a known seed is recorded; then the
  seeding (0x1294b48) and every RNG call site must line up for a replay.

## 2026-10-11 — Owner: visuals indistinguishable, mechanics as exact as possible

- **Decision:** the owner asked for visuals indistinguishable from the real
  game and byte-identical behaviour for a limited troop set, judged by playing.
  Strategy: render the build's own SC2 movie clips (not redrawn art); implement
  mechanics from native facts; recover the decrypted `libg` in the cloud and
  decompile combat functions to port them; check every mechanic against
  recorded native traces (`research/evidence/`) and label the result in
  docs/FIDELITY.md.
- **Why:** byte-identity can only be shown by comparison with the original
  engine. The repo holds a few native traces (Knight fixture, King-vs-Knight
  400-tick fixture, 8-input match actions); the full-match per-frame captures
  live only on the owner's Mac.
- **Would change if:** the owner provides the Mac-only captures or the native
  harness runs in the cloud, enabling full-match differential tests.

## 2026-10-11 — Collision push fitted to a native trace

- **Decision:** push = per overlapping neighbour min(overlap, 90) × 150/90 along
  the centre line, capped at 150 units/tick, applied inside each actor's
  movement update. Unit-vs-unit pushes weight it by Mass.
- **Why:** the push algorithm was never decompiled, but
  `native-automatic-combat.json` records two Knights being pushed by King
  towers every tick. This rule reproduces 508/539 positions exactly (max error
  6 units) and the tick-0 step exactly. A sweep over alternatives fitted worse.
- **Would change if:** the decompiled movement code (`0xfcc578`, `0xfcef48`,
  `0x11d988c`) gives the real formula; it then replaces this fit.

## 2026-10-11 — Engine base confirmed: from-scratch TypeScript

- **Decision:** the owner confirmed the from-scratch deterministic 20 Hz
  TypeScript engine (`sim/core`) on 2026-10-11, optimised for speed (millions
  of headless matches). M1 needs all graphics and at least 8 troops.
- **Why:** both open-source engines get the fundamentals wrong (tick rate,
  units, starting elixir); one TypeScript core serves the browser and
  headless runs. First benchmark: ~7,000× real time per core with random play.

## 2026-10-11 — Pivot from exact emulation to a real-time simulator

- **Decision:** the active goal is a real-time simulator with original art
  that passes the owner's expert smell test ([GOAL.md](../GOAL.md)). The
  byte-identical native-engine track is paused and kept as a reference and
  verification oracle.
- **Why:** the owner wants to train a large "bitter lesson" policy that acts
  in real time like a player, and wants to judge fidelity themselves. The
  emulated original engine took about 8 minutes (instrumented) to boot and run
  a 904-step diagnostic match, well below real time. Arbitrary card placement,
  full state capture and reset were also unproven.
- **Would change if:** the native engine became fast enough to drive directly
  and could accept arbitrary actions.

## 2026-10-11 — Keep the game files in this repository; make it private

- **Decision:** commit the pinned APK and the unpacked install-time asset pack
  under `game-files/`, and switch the repository to private. CI refuses
  `game-files/` in a public repository.
- **Why:** cloud sessions can't reach the owner's Mac, and the download
  sources (APKMirror, APKFab) may be blocked or need fresh links.

## 2026-10-11 — Engine language: TypeScript, one core for browser and headless

- **Decision:** write the engine in TypeScript so the same deterministic core
  runs in the browser viewer and headless in Node for training.
- **Why:** one codebase for both the renderer and training. Node 26 is
  available, and no Rust toolchain was installed on the Mac.
- **Open:** whether to fork an existing open-source engine instead of starting
  from scratch. See "Open questions for the owner" in [STATE.md](../STATE.md). If
  throughput is too low for training, port the core to Rust or C++ (with WASM
  for the browser) behind the same interface.

## 2026-10-11 — Viewer: the client's projection and shadow pass, blue sees the turned view

- **Decision:** draw the battle with the client's projection (0x857ffc: 30 × 24
  SC px per tile, 12 px per 1000 height) and shadow pass (FUN_00851d7c matrices,
  shadow_2d_composite), and show the blue player the 180°-turned view the client
  gives logic player 0 (logic x runs right-to-left, the arena clip turned,
  decorations unflipped because they are placed before the flag is set).
- **Why:** the owner wants it visually indistinguishable from the game. The
  earlier fitted alignment was close on the ground but 46 % high for heights,
  and the earlier shadows were upright, blurred approximations.
- **Would change if:** a phone screenshot shows a different orientation or
  decoration layout for the blue player.

## 2026-10-11 — Public GitHub Pages demo from a private repository

- **Decision:** add a Pages workflow that bakes the original art in CI and
  publishes the playable viewer.
- **Why:** the owner asked for a demo they can play on their phone and chose
  public Pages after being told it publishes Supercell's art and data. The
  repository itself stays private and the public-repo guard stays in CI.
- **Update (same day):** the owner made the repository public so Pages could be
  served; the demo deploys from `main` with Pages source "GitHub Actions". The
  public-repo guard in the Checks workflow is left in place and now fails by
  design while `game-files/` is in a public repository.

## 2026-10-11 — Sixteen focus cards, quality over coverage

- **Decision:** the demo plays two fixed 8-card decks: Knight, Archers, Giant,
  Musketeer, Mini P.E.K.K.A, Spear Goblins, Fireball, Arrows (blue) and
  Valkyrie, Baby Dragon, Hog Rider, Skeleton Army, Minions, Cannon, Goblin
  Barrel, The Log (red). Engine logic, animation, projectile, spell and UI work
  is finished and verified for these 16 (plus the crown towers) before any
  other card. The engine keeps supporting the other cards.
- **Why:** the owner judged the 70-card viewer sloppy ("quality over
  quantity"). The 16 cover melee, ranged, tank, splash, air, swarm, building,
  river jump, a lobbed spell, a scatter spell, a projectile spawn spell and a
  rolling spell, so each mechanic family is exercised.
- **Would change if:** the owner names other cards to bring to the same bar.

## 2026-10-12 — Battles default to the Ladder game mode's end rules

- **Decision:** `BattleConfig.noDraws` defaults to true and `bestOfGame` to
  false, the Ladder row of game_modes.csv (GameModeData +0x180 / +0x181). A
  tie at the end of overtime therefore runs the battle manager's tiebreak
  (0x10ca9a0); the Duel coin flip runs only when a caller sets `bestOfGame`.
- **Why:** the sandbox has no game mode, and Ladder is the mode a normal 1v1
  battle uses. The earlier community "lowest tower loses" rule was an
  approximation; the ported tiebreak drains every tower until the lowest
  falls, and equal towers draw.
- **Would change if:** the viewer gains a mode picker or a native trace of a
  tied battle shows another mode's flags.

## 2026-10-12 — Sound: FMOD banks read in pure Python, played on WebAudio

- **Decision:** the bake (`tools/audio/bake_audio.py`, run by
  `tools/art/bake_web.py`) reads the FMOD Studio banks itself
  (`tools/audio/fmod_bank.py`, the chunk layouts read from libfmodstudio's
  loader) and rebuilds each used FSB5 Vorbis sample as a standalone Ogg Vorbis
  file (`tools/audio/fsb5_ogg.py`) without libvorbis or the FMOD runtime: FSB5
  stores only the Vorbis audio packets plus a CRC32 of the stripped setup
  header, so the three setup headers this build uses (libvorbisenc output for
  its rate / channel / quality presets) are committed as a small table
  (`tools/audio/vorbis_setup.py`, regenerated by `tools/audio/gen_vorbis_setup.py`
  from the MIT-licensed python-fsb5 lookup and the system libvorbis, dev only).
  The viewer plays the baked events with its own small FMOD-like player
  (`sim/viewer/src/sc/sound.ts`): timeline instruments, playlists, volume /
  pitch / delay / probability, random modulators, max instances, cooldown, loop
  transitions and stop-event commands; the client's triggers are ported from
  libg. Outputs go to the ignored `sim/viewer/assets/audio/`.
- **Why:** CI and the owner's machine need no native codec or FMOD licence,
  the bake stays standard Python plus the existing `flatbuffers` dependency,
  and Ogg Vorbis decodes natively in browsers (no re-encode, so no quality loss).
  The FMOD runtime (no web build of this version, licence terms) and a WASM
  Vorbis decoder (bundle size) were the alternatives.
- **Music:** played as the code and the banks say: 0xbdf1b0 starts 60sec_loop
  and 30sec_loop with 0xcbc880, which does not stop the previous music, and
  BattleMusic loops, so they layer until the end screen stops everything but the
  ambience (0xbe0100 → 0xcbc8d4). Kept literal and flagged for the owner.
- **Publishing:** the Pages workflow bakes with `--no-audio` until the owner
  approves putting decoded audio on the public site (AGENTS.md lists audio
  among the decoded assets never to publish); local bakes include it, and the
  viewer runs silently without it.
- **Would change if:** a bus / snapshot / sidechain in the banks turns out to
  duck BattleMusic, Safari support matters (it may not decode Ogg Vorbis: a
  bake-time re-encode to AAC would need a codec), or a later build changes the
  bank format version (0x8e).

## 2026-10-12 — Character effects: engine-recorded effect identity; spawn filters gated by state

- **Decision:** the viewer plays each damage entry's effect from a recorded
  engine event (`damage`: victim, the entry's effect kind and source; plus
  `shieldLost`, `spawn.src` / `pid`, `hit` / `shoot` `src` / `fx`, `impact.src` /
  `z`) instead of guessing it from hits and projectile impacts. The events are
  written only when recording, so state hashes and native traces do not change.
  The deploy filter of a spawn that is not a cast's summon follows view vt+0x140
  (0x846e6c), which acts only in state 4 or 8: death and projectile spawns that
  deploy show their request's clip (dying character's DeathSpawnDeployBaseAnim /
  DeployBaseAnimExportName, or the projectile's SpawnDeployBaseAnim); members
  active at once show none.
- **Why:** the client picks the effect per queued entry (Damage_enqueue 0xfca3d4
  → Health_applyHit 0xfcb29c), which the viewer cannot reconstruct for splash,
  spells, fallbacks and damage over time; and 0x846e6c returns early outside
  state 4 / 8, so giving death spawns with hitpoints a deploy flash (as first
  proposed) would not match the client.
- **Would change if:** the engine's spawner members stop deploying (0xf8aac8
  gives a member with hitpoints state 4 only with SpawnCharacterWithDeploy):
  their kept own filter (A) would then go too.
