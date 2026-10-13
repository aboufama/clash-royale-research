# Decisions

Newest first. Each entry gives the decision, why it was made, and what would
change it.

## 2026-10-12 — Engine port 4: removal notices, Kamikaze, attack sequences, Miner, world order

- **Decision:** port, from `work/native/decomp_eng4/`, the target-removal notice
  (0xf8c9d8 → 0xfc7640: finish wait +0x50, 250 ms without a search), the
  Kamikaze self-kill as a queued kill (0xf83018 → 0xfca24c), MultipleTargets
  with AllTargetsHit (0xfc458c), the Inferno attack sequence (loader 0xdde618,
  0xde0e5c, 0xfc90b0, 0xfc3cb4, 0xfc4afc), the projectile start collision at
  World_addActor with ProjectileStartExtraRadius (0xf934bc), the Miner's state 6
  (0xf84f4c, 0xfcca18, 0x11d9304, 0xfcef48, 0xf800bc), the world list's actor
  order (area effects, projectiles, characters), area-effect candidates in grid
  order (0xf9a594), the child area effect on the parent's first update
  (0xf7b254), the double King kill through the tiebreak gate, crown-tower and
  card scaling through 0xe7e418, and the loader's raised walking speed of
  stop-and-go characters (0xdde618 @0xddf844; found while reading the loader,
  not on the original list). The King-death wave is no longer gated by
  `postEnd`: it runs at the end of every battle tick as 0xd33f74 does; without
  `postEnd` its end-tick kills stay queued and its clocks are not hashed, so
  those states are unchanged.
- **Why:** these replace D/A rows whose behaviour the decompile contradicts:
  "retarget keeps the clock" (an observation that holds only for an in-range
  retarget), an instant Kamikaze death that let attackers retarget in the same
  attack phase, straight-line tunnelling, the A list order. The native trace
  fixtures (400-tick fixture, King retarget, A*) still match: none of them
  removes a dead target during an attack or contains a Kamikaze, a sequence,
  a Miner or a stop-and-go unit.
- **State hashes:** every hash changes, because the unit layout changed
  (`seqIndex` replaces the old `rampMs`, `keepFlag` added, a tunnelling unit adds
  its destination, the double-kill tiebreak hashes the wave clock and
  `fullTowersFlag`). Behaviour changes too, so replays of matches diverge: in 12
  recorded bot-vs-bot matches replayed on both engines the first divergence was a
  removal notice (target dropped with the finish wait instead of a same-tick
  retarget: 8 matches), a Kamikaze (Ice Spirits) dying in the flush, a Bowler
  ball hitting on creation, the Golem's raised speed and the Inferno Dragon's
  shorter range while walking; with the same plays the winner differed in 3 of
  the 12. Bot strength is about the same (`bench/bot.ts 40`).
- **Owner smell test wanted:** a log or bowling ball (piercing projectile) hits
  a tunnelling Miner (0xf82e68 has no state-6 exemption); the Miner tunnels via a
  bridge (state-6 path costs treat water as blocked for it).
- **Would change if:** a native trace shows a same-tick retarget after a kill, or
  a straight tunnel; or 0xe31fc8 (area-effect filter) turns out to accept a
  tunnelling Miner.

## 2026-10-12 — The world after the end: an opt-in post-end phase of `step()`

- **Decision:** `BattleConfig.postEnd` (default false) lets `Battle.step()` keep
  ticking after the result, as the client's battle manager does (0x10ca9a0:
  the battle tick 0xd33f74 runs on until ms since the end, ctx +0x198, reach the
  location's EndScreenDelay at 0xd3581c; 4000 ms = 80 ticks, `endScreenDelay`).
  `Battle.result` (winner, reason, tick) is set once and never changes;
  `Battle.ended` stays "there is a result" and the new `Battle.stopped` says
  "nothing more will happen". The post-end tick runs the command manager (every
  play fails, 0xd77504), the world tick with the attack clocks held at 0
  (0xfc90b0) and non-flag-8 damage dropped (0xfcb29c), the King-death wave
  (0xd352f8) and +0x198 += 50; there is no end check. `endCrowns` keeps the
  crowns of the end for the result screen. The viewer creates its battles with
  `postEnd: true` and steps until `stopped`, then runs its visual clock.
- **Why opt-in:** training, self-play, benchmarks, bots and the native traces
  want the episode to stop at the result; their states and hashes must not
  depend on this. With `postEnd` off nothing changes (the King wave, the only
  post-end work that starts on the end tick, is gated by the flag, and the
  post-end clocks are hashed only after a post-end tick ran). A separate
  method was rejected: the viewer's loop, its event hand-off and the replay of
  a battle are all built on `step()`.
- **Also from the same functions:** once time is up the tiebreak also rejects
  plays (0xd77504 returns 4 on 0xd360a8) and drops non-flag-8 damage while its
  clock runs (0xfcaeec). These change state hashes of matches that reach the
  tiebreak (no result changed in 120 seeded matches).
- **Would change it:** a training setup that wants the post-end frames
  (e.g. for a value target), or a native trace showing the client stopping
  earlier.

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
- **Update (2026-10-12):** the owner saw an older build after a deploy. Pages
  lets browsers cache each file for 10 minutes. The workflow now loads the
  bundle as `dist/main.js?v=<commit>`, and the viewer adds that version to
  every asset request (`sim/viewer/src/sc/asset_fetch.ts`). A new deploy then
  never runs against cached files. Only the 10-minute cache of `index.html`
  itself remains.

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
- **Music:** the owner heard the first version and rejected it ("it needs to
  be the actual clash royale sound"). Two changes:
  - BattleMusic plays `music_arena_general_battle`, the standard battle theme
    (a playlist of the three 2-minute loops), not music.csv's row. That row
    names this build's seasonal track `music_arena_202610`. The
    60sec_loop, 30sec_loop and Sudden_death rows already come from the
    standard theme's bank, and Pre_result's stop commands name its events.
    The override is `MUSIC_OVERRIDES` in `tools/audio/bake_audio.py`.
  - One battle track at a time, as the mixer does it. 0xbdf1b0 starts the
    next track with 0xcbc880, which does not stop the previous music, and
    every music event loops; played literally, the tracks layered. The first
    fix stopped the previous track with a short fade (A). Decoding the master
    bank's mixer (`tools/audio/fmod_bank.py`, layouts from libfmodstudio's
    loader 0x1aefc8 and friends) showed the real handover: all four battle
    events route through bus:/Music/Arena, which holds one event instance and
    steals the oldest (BUS max instances 1, stealing 2; libfmodstudio's
    instance start 0x145040 → 0x13a460 / 0x13a570 → steal 0x145a50: the old
    track ends at the next DSP block, no release). No snapshot, parameter or
    sidechain is involved, and the client sets none in battle. The bake now
    gives every event the limited buses of its routing chain (sounds.json
    v 2) and SoundSystem.play applies them to all events (P); a v 1 bake
    keeps the stop-and-fade fallback.
- **Publishing:** the owner approved putting the decoded audio on the public
  Pages site with the art (2026-10-12), an explicit exception to the AGENTS.md
  rule for this demo; the Pages workflow bakes with audio. `--no-audio` stays
  available for bakes that must not include it. The CI check on `game-files/`
  in a public repository is unchanged.
- **Would change if:** the owner wants the seasonal track back, the bus
  volumes and sidechain compressors / EQ modulators on bus:/Music/Arena
  (decoded, not applied) are ported, Safari
  support matters (it may not decode Ogg Vorbis: a bake-time re-encode to AAC
  would need a codec), or a later build changes the bank format version (0x8e).

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

## 2026-10-12 — Emotes: the default emote deck, direct .ogg playback, 9-slice in the MovieClip runtime

- **Decision:** the viewer's emote menu shows what 0x8e9284 builds for an account whose emote deck holds
  only emotes.csv's DefaultOwned rows (the four King emotes: four empty slots, then the four emotes, plus
  the six text taunts of taunts.csv); an emote's sound plays its SfxFile .ogg (copied by the bake to
  `assets/emotes/`) straight on the sound system's AudioContext instead of through the FMOD event
  `event:/Main/Trigger/SFX_trigger/Play_emote`; scaling-grid clips drawn through `sc/movieclip.ts` keep
  their margins at world scale 1 (the usual SC 9-slice). The opponent never emotes on its own; the sandbox
  panel's "Red emote" sends the red side's emotes and text taunts in turn.
- **Why:** the sandbox has no player profile (a fresh account owns exactly the DefaultOwned emotes); the
  Play_emote event is a programmer sound that the client feeds the .ogg, and its own level was not decoded
  (A in docs/FIDELITY.md); without 9-slice the menu's text buttons and the speech bubbles would stretch
  their rounded corners. The scripted AI is not a client feature, so it does not emote.
- **Would change if:** player profiles (owned emotes, a chosen deck) come into the sandbox, the Play_emote
  event's volume / bus is decoded (tools/audio), or the client's scaling-grid render path is traced and
  differs.

## 2026-10-12 — Self-play RL setup: entity transformer, PPO, fair actor with a privileged critic

- **Decision:** the training stack in `sim/rl/` (environment) and `train/` (trainer, RunPod launcher):
  - **Environment:** Node workers step N battles each over the unchanged engine and stream
    fixed-layout float records over pipes.
  - **Decisions:** at most every 5 ticks, and only while a card is playable.
  - **Actions:** wait or hand slot, then one of the 576 tiles, masked to the tiles where the card
    lands as aimed (`Battle.deployGrid`, the native deploy check's footprint test).
  - **Observations:** each side sees its own end of the board.
  - **Network:** an entity-transformer actor and a privileged critic.
  - **Training:** PPO with per-tick discounting. Opponents are self-play, PFSP snapshots and 5 %
    scripted bot (the yardstick). The reward is win/loss plus crown-tower damage shaping that
    decays to 0.
  - **Opponent information for the actor:** its elixir and the publicly known part of its cycle,
    not its actual hand.
- **Why:**
  - **Bitter lesson.** A generic architecture over the raw game state with no hand features or
    heuristics, and compute spent on self-play.
  - **Exact masks.** They remove actions that only the engine's snap would correct, without
    removing any reachable outcome.
  - **Fair opponent information.** A player can compute both features exactly: elixir is debited
    when the card appears (0xd77504), and played cards go to the back of the queue. Giving them
    directly saves the network from learning bookkeeping, and the policy stays fair.
  - **Privileged critic.** It reduces value noise without leaking hidden state into the policy
    (AlphaStar's value baseline).
  - **The engine itself.** It runs about 60k ticks/s per core, so no port or approximation is
    needed; the policy trains on the same engine the browser runs.
- **RunPod upload scope:** the owner offered RunPod compute for this. A pod receives
  `sim/core/src`, `sim/rl` and `sim/data` (gameplay JSON decoded from the game files) plus `train/`,
  over HTTPS, and nothing from `game-files/`, the art or the audio. Its control server requires a
  random per-pod token. This is an owner-approved exception to the AGENTS.md "no third-party
  upload" rule, limited to that bundle. The upload happens only when the owner supplies the API key.
- **Would change if:** self-play cycles (add league exploiters), the owner wants the actor to see
  the true opponent hand (one flag in `obs.ts`), or simulation stops being the bottleneck (a GPU
  batch engine or a faster engine build).

## 2026-10-12 — Play against the trained agent on Pages

- **Decision:** the viewer offers "RL agent" as a fifth AI level (and `?vs=agent` starts with red played
  by it). The trained actor is exported to ONNX (`train/crl/export.py`, checked against PyTorch), committed
  as `sim/viewer/models/agent.onnx` and run in the browser with onnxruntime-web (WASM, from jsDelivr, on
  first use). The agent uses the training observation code (`sim/rl/obs.ts`) on the same engine, the same
  decision grid and the same masked sampling (`sim/viewer/src/agent.ts`); inference is asynchronous, so a
  play lands a few ticks after its observation and is dropped if it became illegal.
- **Why:** the owner asked to play against the agent once it beats the hard bot a few times. It did from
  update ~115 on (2–5 wins in every ~30 games against level 3).
- **Check exception:** `scripts/check_public_tree.py` rejects binary files. It now allows exactly
  `sim/viewer/models/agent.onnx`, and only as an ONNX protobuf under 50 MB. Network weights are not game
  data. The rule for game-files/ and the public-repository CI check are unchanged.
- **Would change if:** the model grows past what a browser should download (distil it, or quantise), or
  per-version history becomes too heavy (publish only milestone versions).


## 2026-10-13 — Training compute: community RTX 5090s, one experiment per pod

- **Decision:** train on community-cloud RTX 5090 pods ($0.69/hr) rather than H100s. Each pod runs
  its own run (a population of variants compared on the bot benchmark), not a shard of one run.
- **Why:** the simulation is CPU-bound. Throughput follows the pod's CPU quota once the GPU keeps
  up with inference and the PPO update.
  - **Measured:** one 5090 with a 31-core quota does 7.5–13k decisions/s (about 13–19k per $/hr).
    2× H100 secure did 16–18k/s at $7.98/hr (about 2k per $/hr); 1× H100 did about 7.5k/s at $3.99.
  - **Why separate runs:** sharing one run across pods would ship hundreds of MB/s of rollouts
    between datacenters. Separate runs need nothing.
- **Caveats:** community stock is thin, and two of three hosts rented on 2026-10-13 had a broken
  GPU (`cuInit` 999, `/dev/nvidia-uvm` I/O error). Verify CUDA right after the pod starts and
  terminate a bad host at once.
- **Would change if:** a single run needs more than one pod's throughput (then distributed
  collectors with compressed rollouts), or GPU prices or CPU quotas change.

## 2026-10-13 — Behaviour monitoring, and a floor on the card choice

- **Decision:** the environment reports per-episode behaviour for both sides:
  - card plays by deck index;
  - enemy-half plays;
  - elixir at play;
  - ticks at full elixir;
  - tower damage dealt and taken.

  The trainer logs these per opponent kind. `crl.watch` produces per-card tables, heatmaps and
  replays from a checkpoint.

  Collapsed cards are lifted back by a one-off slot-head distillation (`crl.card_floor`), and
  training keeps a hinge floor on p(card | play) (`--card-floor`).
- **Why:** the win rate against the bot hid a collapse that the first behaviour report showed at once.
  - **The collapse:** the agent never played Giant, Fireball or Arrows. They stayed in hand all
    game with p(card | play) around 1e-9, so one hand slot cycled five cards.
  - **Why an entropy bonus fails:** its gradient is about p·log(1/p), so it cannot pull a
    probability back from 1e-9.
- **What failed first:**
  - **KL pull to uniform:** a penalty on KL(uniform || p(card | play)) on every row wrecked the
    agent in ten updates (bot win rate from about 30 % to 0). It acts on the 95 % of rows that
    wait, so it swamped the card choice's policy gradient and held the choice near uniform.
  - **Hinge floor in PPO, applied cold:** it overshot the floor under Adam (to about 20 % in ten
    steps) and moved p(wait) from 0.95 to 0.62 through the shared card head.
- **What works:** the distillation fits only the slot head, on frozen trunk features, to a target
  that keeps each state's p(wait) and the relative preferences among the other cards but lifts every
  legal card to 3 % of the play probability. p(wait) was unchanged at 0.957 and the parked cards
  rose to a median 4 %. During training the hinge is zero above its floor (1 %) and its gradient
  reaches only the slot head.
- **Also:**
  - The terminal reward counts crowns: `--crown-coef`, + coef · (crowns taken − lost) / 3. It stays
    zero-sum, so self-play is unchanged in kind.
  - `--shape-floor` keeps a small zero-sum tower-damage weight after the anneal.
  - Both follow the research notes (JueWu and OpenAI Five keep zero-sum shaping).
- **Would change if:** the floor keeps the policy from dropping cards that are bad in some states.
  Then lower `--card-floor`; the floor is per state, so it costs at most 1 % of plays per card.

## 2026-10-13 — A chosen wait length (delay head)

- **Decision:** with `--wait-options N` the agent's wait is a choice of length (`--wait-ticks`,
  default 5/10/20/40/80 ticks = 0.25–4 s), made by a small head on the trunk's global token. The
  action's tile field carries the choice on waits, so the worker protocol is unchanged.
  - A longer wait ends early when the opponent commits a card or the agent's elixir bar is full
    (`sim/rl/env.ts` `waitTicks`).
  - Old checkpoints and league snapshots load with the head set to prefer the shortest wait: about
    80 % at bias 3, and always for snapshots.
- **Why:** the agent decides every 0.25 s and waits on about 95 % of decisions. Saving elixir for a
  Giant push then takes about 16 consecutive waits, which exploration rarely finds, and λ per
  decision spans only seconds.
  - **Evidence:** the update-1760 watch showed no combined pushes and 0.69 crowns per game against
    the bot. The research notes rank a delay head (AlphaStar, TStarBot-X, TempoRL) as a top fix.
- **What it is not:** the game has no such action. It is the agent's own temporal abstraction: a
  player can always wait, and every play still goes through `Battle.play` at a decision tick.
- **Would change if:** the head stays on the shortest wait after training (no gain), or the
  interrupts prove too coarse. Then add an interrupt on own tower damage or on an enemy unit crossing
  the bridge.
