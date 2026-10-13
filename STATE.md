# Project state: Clash Royale real-time simulator

The single source of truth for where the project stands. Read it after
[GOAL.md](GOAL.md) and [AGENTS.md](AGENTS.md), and keep it current.
Last updated 2026-10-12 (view5: VisualHitSpeed, attack finish and shake, Bats lunge, view jolts, Inferno beam entries, Electro Wizard beam pivots, arena clip instances; hud4: emotes, the result's confetti and OK button, the intro's touch hold; 70 cards with original art).

## The owner and what they want

- The owner (GitHub `aboufama`) plays Clash Royale **heavily** and judges the
  simulator by watching and playing it. They will notice wrong hit timings,
  speeds, ranges, retargeting and pathing.
- They want a fully working battle simulator where you can place any troop,
  with all projectiles, troops and art rendered properly. It must run **in
  real time**, because a "bitter lesson" style policy will be trained on it and
  must make dynamic decisions the way a player does. Headless training should
  run far faster than real time.
- **Update 2026-10-11 (mid-session):** the owner now wants the visuals to be
  indistinguishable from the real game and the behaviour byte-identical for a
  limited troop set; they will smell-test it by playing. Byte-identity can only
  be shown against the original engine, so mechanics are ported from the
  decompiled `libg` and checked against the recorded native traces
  ([docs/DECISIONS.md](docs/DECISIONS.md)).
- They value honest status: what works, what's approximated, what's missing.

## History

1. **Overnight, 2026-10-10 to 11:** Codex agents tried to build an *exact*
   environment by emulating the original ARM64 engine (`libg.so`) in Unicorn.
   The game's own "Normal" test battle runs 904 steps on 8 externally supplied
   troop placements and reproduces byte-for-byte. It is about **7× slower than
   real time**, can't take arbitrary actions, and has no reset or full state
   capture. Details: `research/findings.md`, `research/evidence/`, and the
   native-track section of [README.md](README.md).
2. **2026-10-11 pivot:** the owner chose a fast reimplementation with the
   original art and data. The repository was made **private** and the original
   game files were added under `game-files/` ([docs/DECISIONS.md](docs/DECISIONS.md)).
3. Codex's methods (evidence receipts; separating observed, inferred and
   unknown; parallel agents with separate scopes) came from **REA**
   (github.com/morluto/rea), which Codex reviewed but never ran
   (`research/rea-review.md`). The REA idea that matters now is its DX-Ball
   pattern: decompile one function, port it, then differentially test the port
   against the original binary. Use it for core mechanics (V-level fidelity).

## Current state

| Area | State |
| --- | --- |
| Game files | ✅ `game-files/`: the APK bundle (contains `libg.so`) and all 10,870 asset-pack files, hash-manifested ([game-files/README.md](game-files/README.md)) |
| Gameplay data | ✅ `tools/data/`, standard-library Python only. It decodes 648 logic files (0 errors) into 66 JSON tables plus `cards.json` with mechanic flags. Field meanings, units and level scaling are in [docs/DATA_FIELDS.md](docs/DATA_FIELDS.md) |
| Art | ✅ `tools/art/` decodes the SC2 sprite format (`.sc` v5: FlatBuffers + zstd) and the `.sctx` ASTC textures, and renders original animation frames to sheets plus JSON (anchor, hit frame). Verified on the Knight's run and attack animations. See [tools/art/README.md](tools/art/README.md) |
| Mechanics facts | ✅ [docs/MECHANICS_BRIEF.md](docs/MECHANICS_BRIEF.md): tick rate, units, elixir, pathfinding, attack timing, King activation and end rules, measured from native runs |
| Engine | ✅ `sim/core`: deterministic 20 Hz integer engine; 70 playable cards (`supportedCards`). Ported from the decompiled `libg` (P in [docs/FIDELITY.md](docs/FIDELITY.md)): world tick order, attack clock, targeting and retargeting, default tower by lane, collision push, A* and cell costs, dynamic building occlusion, goal-cell selection, path requests, arena collision, avoidance sidestep, stop-and-go walking, knockback, river jump, charge, area-effect pulses, building decay, spell cast from the King tower (Arrows scatter on the native RNG), summon formations and deploy delays, pending-damage targeting, projectile hits and chain hops, piercing and rolling projectiles (Log, Barbarian Barrel, Bowler, Executioner, Magic Archer), projectile spawn/setup and height, impact spawns (Goblin Barrel), tower and building default targets, stuns and damage over time, jumping-unit rules, the damage-key window and the deploy check with its zone map, periodic spawners (0xf800bc / 0xf8aac8), the world after the end (opt-in `postEnd`: 0x10ca9a0 until EndScreenDelay), target-removal notices with the finish wait, Kamikaze as a queued kill, MultipleTargets / AllTargetsHit, the Inferno attack sequence, the Miner's tunnel path (state 6), the world list's actor order, area-effect grid order and child objects, and level scaling (0xe7e418). 126 core tests, including the 400-tick native trace (539/539 positions and all HP exact) and the 12 native A* cases. ~3,500× real time per core |
| Viewer | ✅ `sim/viewer`: the build's own SC2 movie clips in WebGL for every supported unit, building, projectile, area effect and buff; tower ruins, deploy clocks, original card art in the hands and palette; drag-and-drop for both sides, sandbox palette, pause/step/speed. The battle projection is the client's own (0x857ffc: 30 × 24 px per tile, 12 px per 1000 height, blue sees the 180°-turned view with logic x right-to-left) and shadows follow the client's shadow pass (flipped skewed silhouettes, one composite with the location colour). River jumpers rise over the river on the actor z the client builds from the jump's height records, with the shadow left on the ground and the jump clip timed to the landing (0xfd0320, 0x84d738, 0x84440c). The HUD is the client's own exports and layout (hand cards with the RadialFill elixir mask, elixir bar, clock, crowns, the played card's "-cost" float text); the arena's nested clips animate and the location cloud shadows drift (0x857a50); the effect system (particles with tails measured on the clip's current rotated height, screen shake) is ported. Area-damage indicator rings (World_areaDamage 0xf97be8 and area-effect pulses → battle screen listener 0xbe76e8 / 0xbe7980, ring class 0xcf0464, fade 0xbe1d3c; `sc/area_rings.ts`), footstep MoveEffects on the run clips' action_frame labels (0x840d44, `sc/unit_fx.ts`, called from art.ts) and the river-jump LandingEffect (0xf7f2c8 → view vt+0x80) are ported from engine events `areaRing` / `pushRing` / `landing` (decompiles in `work/native/decomp_rings/`). The sandbox side panel wears sc/ui_common.sc buttons and popups (`?clean` hides it). Unit libraries stream in on demand (core + both decks at startup). Text is the client's own text path (sc/text.ts, sc/freetype.ts: the two game fonts, FreeType 2.9 unhinted glyphs with the post-processed outline channel, HarfBuzz kerning, the TextField layout and two-pass drawing of 0x126ab4c; art.ts sets `ScRenderer.textStageScale` to the HUD's stage scale for the battle layer and clears it for the HUD). The emote button, its menu and the emote bubbles with their sounds (`sc/emotes.ts`), the result screen's confetti (`sc/confetti.ts`) and the game buttons' press feedback (`sc/ui_button.ts`) are the client's own (docs/FIDELITY.md Emotes and Result rows) |
| Sound | ✅ The client's FMOD sounds in the viewer (`sim/viewer/src/sc/sound.ts`, WebAudio, Battle panel toggle): `tools/audio/` reads the FMOD Studio banks and rebuilds the used FSB5 Vorbis samples as Ogg in pure Python during the bake (`sim/viewer/assets/audio/`, ignored); effect sound components, cast sounds, HUD / hand / timer / crown sounds, the battle screen's clock sounds and music (0xbdf1b0), overtime, end horn and the result screen's music, as traced in docs/FIDELITY.md (Sound row; A: modulator ranges, playlist modes, event stealing; P: the buses' instance limits; –: bus volumes and effects, snapshots, AHDSR, all decoded by `tools/audio/fmod_bank.py` but not applied; the emote sounds play their .ogg directly, `sc/emotes.ts`). Battle music: the standard theme (music_arena_general_battle, owner's choice over the build's seasonal row), then the 60 s loop, the 30 s loop and sudden death, one at a time: bus:/Music/Arena holds one instance and steals the oldest, so each new track cuts the previous one off (P) |
| Demo (GitHub Pages) | ✅ Live at https://aboufama.github.io/clash-royale-research/ . `.github/workflows/pages.yml` bakes the art, tests and builds the viewer and deploys on every push to `main` (Pages source: GitHub Actions). The repository was made public by the owner (2026-10-11) to serve Pages; the Checks workflow flags `game-files/` in a public repo by design |
| AI opponent | ✅ `sim/core/src/bot.ts`: deterministic scripted bot for either side and any supported deck (`new Bot(team, { seed, level })`, `bot.act(battle)` each tick; in the viewer the panel's Blue AI / Red AI buttons pick off / easy / medium / hard); card roles from the data and a coarse fight estimate drive defence, pushes, spells and elixir management. Not a native port ([docs/DECISIONS.md](docs/DECISIONS.md)). About 87% wins against `randomPolicy` with mixed random decks, 100% against a passive side, ~2 µs per tick; `node sim/bench/bot.ts` evaluates it. The AI never emotes; the panel's "Red emote" sends the red side's emotes for testing |
| Training bridge | ❌ Not started |

### Key facts so far

These come from the brief and the data notes.

- **Ticks:** 20 per second (50 ms each). The match is 180 s plus 120 s of overtime.
- **Space:** integer game units at 1000 per tile. The arena is 18000×32000. The path grid is 36×64 cells of 500 units, with the river at y 15000–17000.
- **Elixir:** stored ×10000. It regenerates exactly 178 units per tick at 1× elixir. Players start with 6, and the max is 10.
- **Deploying:** a deploy commits 20 ticks after it is played. The unit becomes active after its data `DeployTime` (usually 1000 ms).
- **Hand cycle:** the played card stays in its slot (hidden by the client) until its play commits; then the slot empties and the hand timer refills it from the queue, at most one fill per NextSpellCooldownMS (1000 ms at first), so the next card appears about 1 s after the release (0xf9f23c, 0xfa5b4c).
- **Movement:** a unit moves its data `Speed` value in game units per tick (stop-and-go units such as the Giant walk faster while moving: the loader raises 45 to 52). Pathing is A* on the 500-unit grid, with step costs 10/14 × cell cost.
- **Attacks:** units spawn preloaded, so the first hit lands after `HitSpeed − LoadTime`. Damage is applied at the end of the same tick.
- **King tower:** activates 3300 ms after it is first damaged or a Princess tower falls.
- **Level scaling:** `stat(L) = floor(base × M[L−1−rel]/100)`, with M = 100, 110, 121, … At tournament level 11 the multiplier is 256 (Knight: 1766 HP, 202 damage).
- **Art:** units are **2D sprite movie clips**. Exports are named `{Blue|Red}ExportName_{run1|idle1|attack1}_{1..9}`: direction 1 faces away, 5 faces right, 9 faces the camera, and left-facing frames are mirrors, giving 16 directions. The frame label `action_frame` marks the hit. The `sc3d/*.glb` files use a custom Supercell FlatBuffer glTF that stock loaders reject.

## Repository map

| Path | What |
| --- | --- |
| `GOAL.md`, `AGENTS.md`, `CLAUDE.md` | Goal and rules. `CLAUDE.md` imports `AGENTS.md` |
| `STATE.md` | This file |
| `docs/FIDELITY.md` | Per-mechanic fidelity level (V/P/D/A/–) |
| `docs/DECISIONS.md` | Decisions and their reasons |
| `docs/DATA_FIELDS.md`, `docs/MECHANICS_BRIEF.md` | Data meanings and native mechanics facts |
| `game-files/` | Original inputs. **Private; never publish** |
| `tools/data/`, `tools/art/` | Extraction tools. Outputs go to the ignored `extracted/` folder |
| `sim/` | `core/` engine + tests, `viewer/` browser viewer, `bench/` throughput, `data/gamedata.json` (generated by `tools/data/export_sim_data.py`) |
| `sim/rl/`, `train/` | Self-play RL: the Node environment workers over the engine, the PyTorch PPO trainer, the RunPod launcher ([train/README.md](train/README.md)) |
| `research/`, `scripts/`, `tests/` | Paused exact-engine track |

**Only on the owner's Mac:** the Unicorn harness and per-tick frame captures
of full native matches live in Codex's local `work/` folder. Differential
(V-level) checks against whole native matches have to run there.

**In this cloud container (ignored, not committed):** `work/native/` holds a
rebuilt decrypted `libg` (`libg-patched.so`), two Ghidra projects,
`decompile.sh` (headless decompile of any address), `PORT_NOTES.md` and 146+
decompiled battle functions. A fresh container must rebuild them with the
recovery scripts (see `work/native/RECOVERY_LOG.md` if present, or the
README's native-track section).

## Prior art (public, permissive licenses)

- **ClashRoyaleAi**, github.com/itzik123/ClashRoyaleAi (MIT): C++, 132 cards and
  41 Evolutions, about 20,000× real time, Python bindings, PPO, WASM.
- **crforge**, github.com/voonhous/crforge (Apache-2.0): Java ECS, 100+ cards,
  Gymnasium bridge, docs on established versus guessed mechanics.
- **Both get native fundamentals wrong.** ClashRoyaleAi runs at 10 ticks/s on
  an 18×34 float board. crforge uses float speeds (60 = 1000 units/s) and a
  starting elixir of 5. Use them for ideas and coverage lists, not numbers.

## How to run

```sh
cd sim && npm install
npm test                 # engine tests (Node 22+ runs the TypeScript directly)
npm run bench            # headless throughput
npm run dev              # viewer at http://localhost:8080 (needs baked art for the original look)
```

Bake the original art for the viewer (about 2 minutes, ~150 MB into the
ignored `sim/viewer/assets/`): `.venv/bin/python tools/art/bake_web.py`
(see [tools/art/README.md](tools/art/README.md)).

Regenerate data: `python3 -I tools/data/decode_assets.py && python3 -I tools/data/build_json.py && python3 -I tools/data/build_cards.py && python3 -I tools/data/export_sim_data.py`.

## Training (self-play RL), 2026-10-12

Setup: `sim/rl/` (environment) and `train/` (trainer, RunPod launcher, export). See
[train/README.md](train/README.md) and DECISIONS "Self-play RL setup".

**Live run (2026-10-13).** RunPod pod `crl-5090a`: one RTX 5090 on community cloud, $0.69/hr,
31-core CPU quota. Run directory `/workspace/crl/runs/exp1`. CUDA MPS runs on the pod; restart it after a CUDA fault.
- **Driving it:** `train/runpod/launch.py --pod crl-5090a status|log|ls|fetch|upload|exec|stop|start|terminate`
  with `RUNPOD_API_KEY` set. Pod ids and control tokens are in `work/runpod/pods.json` (ignored, this
  container only). `create` makes the new pod the default, so always pass `--pod`.
- **Current flags:** `--mirror --envs 96 --active-opponents 2 --bot-prob 0.1 --epochs 1 --minibatch 2048
  --lr 4e-4 --ent-slot 0.03 --ent-tile 0.005 --crown-coef 1.0 --card-floor 0.01`, single collector (28 workers).
- **Population (2026-10-13 21:50 UTC):** 9 pods, $7.81/hr, about 53k decisions/s in total.
  Updated after the first population step at 21:35.

  | Pod | Run | Hardware | Role and flags |
  |---|---|---|---|
  | `crl-5090a` | `exp1` | community 5090 | main run |
  | `crl-b` | `x1` | secure 4090 | exploiter, reset to main's update-2040 weights at 21:35 |
  | `crl-c` | `w5` | secure 4090 | from `w2` u2268, `--wait-options 5 --crown-coef 3.0` (delay head) |
  | `crl-d` | `w2` | secure 4090 | from `e1` u1960, `--wait-options 5 --crown-coef 1.5 --shape-floor 0.2` (delay head) |
  | `crl-e` | `e2` | secure 4090 | from `x1` u2192, `--crown-coef 2.0` |
  | `crl-f` | `w4` | secure 4090 | from `w3` u2264, `--wait-options 5 --crown-coef 1.0` (delay head) |
  | `crl-g` | `g2` | secure 4090 | from `e1` u1960, `--crown-coef 2.0 --shape-floor 0.2` |
  | `crl-h` | `w3` | secure 4090 | from `w2` u2170, `--wait-options 5 --crown-coef 2.0` (delay head) |
  | `crl-i` | `w1` | secure 4090 | from `e1` u1960, `--wait-options 5 --crown-coef 2.0` (delay head) |

  - **22:45:** every run moved to a fixed `--lr 2e-4` with no `--target-kl` (see DECISIONS).
    - **Population step:** f1 (8.5 %) and c2 (11.5 %) became `w4` and `w5` from the delay-head
      runs, which held about 30 % and lose the fewest crowns (0.86–0.89 per game).
    - **Mix:** five of nine runs now use the delay head.
  - **22:20 ranking and changes:**
    - **Ranking** (bot win, last 100 updates):

      | Run | Win | Crowns lost per game |
      |---|---|---|
      | x1 | 31.9 % | |
      | w2 | 30.4 % | 0.92 |
      | w1 | 29.7 % | 0.94 |
      | f1 | 27.2 % | |
      | g2 | 25.4 % | |
      | exp1 | 24.3 % | |
      | c2 | 23.2 % | |
      | e1 | 20.0 % | |
      | h1 | 12.6 % | |

      The delay-head runs (w1, w2) lose the fewest crowns.
    - **Bug:** the KL-adaptive lr had collapsed in several runs (h1 at 3e-5). Collapsed play rows
      inflated the KL estimate; the per-row KL is now capped at 1. All runs restarted, which resets
      the lr scale.
    - **Population step:** h1 became `w3` (from w2, `--wait-options 5 --crown-coef 2.0`, seed 41) and
      e1 became `e2` (from the exploiter x1, `--crown-coef 2.0`, seed 42).
    - **Second resume of a delay-head run** failed on optimizer groups (fixed: `train.load_opt`).
  - **Ranking at 21:33** (bot win, last 100 updates, 1000–2500 games each):

    | Run | Win |
    |---|---|
    | e1 | 35.2 % |
    | exp1 | 33.2 % |
    | f1 | 32.5 % |
    | h1 | 32.1 % |
    | d1 | 29.3 % |
    | i1 | 28.8 % |
    | g1 (`--epochs 2`) | 20.3 % |
    | b1 (`--lam 0.98 --shape-floor 0.1`; its lr collapsed to 2e-5) | 14.2 % |

    Crown-heavy rewards take the most crowns: f1 0.93 and e1 0.86 per game, against 0.74 for exp1.
  - **e1 u1960 watch** (32 bot games): 47 % wins, crowns 0.97 / 0.94, seven three-crown wins. It
    opens with a Giant at the bridge (median play time 1 s) and sends Knight to the bridge 52 % of
    the time.
  - **Shared settings:** every run except `x1` started from the update-1780 checkpoint
    (scratchpad `backup/latest_1780.pt`). They share the main flags: `--mirror --envs 96
    --active-opponents 2 --epochs 1 --minibatch 2048 --lr 4e-4 --ent-slot 0.03 --ent-tile 0.005
    --crown-coef 1.0 --card-floor 0.01 --import-share 0.15 --bot-prob 0.1 --lr 2e-4 (fixed since 22:45)
    --import-dir /workspace/crl/runs/<run>/import`.
  - **Relays:** each run imports the exploiter's snapshots through a one-way relay (scratchpad
    `relay_<pod>.log`). Only `exp1` sends snapshots to the exploiter.
  - **Scratchpad tools:**
    - `fleet.sh` / `grab4.sh` rent and verify pods one at a time.
    - `popstat.sh` prints the last-100-update bot benchmark per run.
    - `breakwatch.py` reports a run whose games meet the owner's bar ≥ 50 % of the time, or at ≥ 45 %
      bot wins (BREAKTHROUGH), or whose bar rate rose 3+ points above 25 % (big leap),
      over ≥ 250 games.
  - **Plan:** every ~2 h, copy the best run's checkpoint into the worst (population-based
    training), keeping each run's own flags.
  - **Community supply:** most new community pods come up with `NVIDIA_VISIBLE_DEVICES=void` and
    `/dev/nvidia-uvm` returning I/O errors (`cuInit` 999). One 5090 ran at 600 MHz under its power cap.
  - **Renting pods:** verify every new pod right after `wait`: `cuInit` returns 0, and a bf16
    matmul runs at ≥ 50 % of the max SM clock. Never run two `create` loops at once: they race on
    `work/runpod/pods.json` and orphan pods. `GET /pods` through `launch.rest` lists every pod, and
    `env.CRL_TOKEN` recovers a lost token.
  - **Throughput:** one 4090 pod with 10 workers does about 6.5k decisions/s, close to the 5090's
    8k with 28 workers. The trainer process (GPU + Python), not the CPU simulation, limits a pod.
- **Throughput:** 7.5–13k decisions/s. The simulation is CPU-bound, so value tracks the CPU quota.
- **Cost:** about 13–19k decisions/s per $/hr, against about 2k for 2× H100 secure ($7.98/hr, 16–18k/s).
  Community stock is thin, and some hosts have a broken GPU (`cuInit` 999, `/dev/nvidia-uvm` I/O error).
  Verify CUDA right after `wait`. Before renting, read the 2026-10-13 cost entry in DECISIONS.
- **Opponents:** pure self-play, mirror match on the default blue deck, against the current policy
  and a PFSP league of snapshots. The scripted bot is a benchmark only: the learner plays it in 10 %
  of episodes and those games are never stored. Before update 200 the matchup was deck 0 vs deck 1,
  and 5–25 % of training games were against the bot.
- **Restarts:** stop, push, start with the same `--run`. It resumes from `latest.pt`, written every
  10 updates. A local backup copy lives in the scratchpad.
- **History:** update 1–1273 on 2× H100 (pod `crl-2`, terminated after the balance ran out).
  Update 1270 onward on the 5090; update 1350 onward with behaviour monitoring.
  The `--card-kl` attempt (updates 1431–1440) wrecked the agent; its checkpoint and metrics are kept
  on the pod as `*_cardkl*`. The run restarted from the update-1350 checkpoint after `crl.card_floor`
  surgery, with `--card-floor 0.01`.

**Progress against the hard bot** (benchmark only; mirror and pure self-play since update 210).
Windowed over 50 updates:

| Updates | Win | Crowns taken / lost | Notes |
|---|---|---|---|
| 1200–1350 | 26–34 % | ~0.7 / 1.1–1.3 | |
| 1351–1380 | 7–10 % | | after the card-floor surgery |
| 1700–1766 | 28–29 % | 0.71 / 1.2 | baseline again |

- **Owner's bar:** since 2026-10-13 23:00, at least 1 crown without losing a tower, the majority of
  the time (`dominant1_vs_bot`, logged from 23:00).
  - **Original bar:** at least 2 crowns without losing a tower (`dominant_vs_bot`), 0–2 % all day.
  - **Estimate before logging:** about 25 % of e1's u1960 watch games met the new bar.
- **Update-1760 watch:** the fast 0-3 losses are gone, which fits training against the exploiter.
  The most common result is a 0-1 loss: the agent defends but has no offence. It sends single
  units over one bridge, mostly Mini P.E.K.K.A, and Giant, the deck's win condition, is played
  0.16 times a game.
- **Main run 1800–1983:** bot win rate fell to 12–17 % (crowns 0.3 / 1.3) while it beat its league
  63 % of the time. PFSP gave the exploiter's snapshots most of its league games. The run was reset
  to the update-1780 checkpoint (the 1983 one is kept as `latest_1983_exploited.pt`). Main and `b1`
  now run with `--import-share 0.15`, a cap on imported snapshots' share of PFSP weight.
- **Run `b1` tests credit assignment:** longer λ and a kept tower-damage shaping.
- **Next if the plateau holds:** a delay head (choose a wait length, so saving for a Giant push is
  one decision), or a short engine lookahead.

**Card collapse found by the monitoring (update 1350).** The agent played only five of its eight
cards; Giant, Fireball and Arrows stayed in hand all game.
- **How collapsed:** p(card | play) for those three was about 1e-9, so an entropy bonus has no gradient.
- **What it meant:** one hand slot cycled; the deck's only win condition (Giant) and both spells
  were never used.
- **Fix:** a slot-head distillation lifted those cards to a median 4 % of plays with p(wait)
  unchanged. A 1 % hinge floor keeps them from collapsing again; see DECISIONS for what failed first.
  Watch that Giant, Fireball and Arrows become useful, not just played.

**Monitoring (do this often, not only the win rate).**
- **Training log:** every 10 updates it prints per-card plays per game, seconds at full elixir,
  elixir at play, enemy-half placements and tower damage, for self, league and bot games
  (`beh_*` in metrics.jsonl). It warns on illegal sampled actions.
- **Watch report:** `python -m crl.watch latest.pt --games 32 --maps --out work/watch/uNNNN` (from
  `train/`) plays the bot and itself. It reports results, a per-card table (plays, elixir, timing,
  placement bands), placement heatmaps and elixir habits, and writes replays.
- **Look at games:** copy a replay to `sim/viewer/assets/replays/` and open
  `?replay=assets/replays/<file>.json`. Look at the frames, not only the numbers.

**Watching the agent.**
- **Replays:** `crl.watch --out DIR` or `train/crl/evaluate.py --replays DIR` write them, and the viewer
  plays them with `?replay=<path>`. Two update-30 replays are in `sim/viewer/replays/`.
- **Playing against it:** `?vs=agent`, or the "Red AI" button cycled to "RL agent". It runs
  `sim/viewer/models/agent.onnx`, currently the update-830 actor, with onnxruntime-web. Both sides get the agent's deck.
- **Updating the published agent:** fetch `actor_XXXXXX.pt` and `spec.json`, then run
  `python -m crl.export actor.pt --spec spec.json --out ../sim/viewer/models/agent.onnx` from
  `train/`, then commit.

## Next steps

1. **Remaining native ports** (A rows in docs/FIDELITY.md): the default lane
   goal without a target (0xd43a4c: a mode subsystem at ctx+0x358 whose vt+0x48
   is not yet identified), King activation conditions (TOML scripting), the
   damage-over-time sync of HitTickFromSource (Earthquake, unsupported), the
   area-effect filter 0xe31fc8 (does it skip a tunnelling Miner?),
   SpawnPathfindMorph (Goblin Drill), AttackSequenceList characters.
   Done 2026-10-12 (eng4, `mechanics3.test.ts`, decompiles in `work/native/decomp_eng4/`,
   DECISIONS "Engine port 4"): the target-removal notice (0xf8c9d8 → 0xfc7640: the
   attacker drops the dead target and waits ATTACK_FINISH_TIME_MS before searching;
   OverrideAttackFinishTime units search at once), Kamikaze as a queued kill (0xf83018:
   normal death, Battle Ram's Barbarians), MultipleTargets picks (0xfc458c) and AllTargetsHit,
   the Inferno attack sequence (mode 3: stage by the attack timer, reset on every target
   change, the Dragon 500 closer while walking; `Unit.seqIndex`, `hit.seq`), the projectile
   start collision at creation with ProjectileStartExtraRadius (0xf934bc), the Miner's state 6
   (A* to the deploy point via a bridge at SpawnPathfindSpeed, then deploy), the actor-update
   order of the world list (area effects, projectiles, characters), area-effect candidates in
   grid order (0xf9a594), SpawnAreaEffectObject on the parent's first update, the double King
   kill through the tiebreak gate, ctx +0x2c4, card and crown-tower scaling via 0xe7e418, and the
   loader's walking speed for stop-and-go units. Recorded events: `kingActivate`,
   `hit.cancelled`, `hit.seq`. Every state hash changes (unit layout) and replays diverge.
   Done 2026-10-11 (third pass, PORT_NOTES §9, `projectiles.test.ts`,
   `towers.test.ts`): piercing and rolling projectiles (0xf8f2d0 / 0xf8ff74 box
   query, out-and-back axe, Log/Barbarian Barrel cast from the target point),
   projectile spawn and setup (0xf8e4c8 / 0xf8e6fc / 0xf8fb34, projectile
   height `z`), impact spawns (Goblin Barrel formation, priorities), tower and
   building default targets, the Arrows scatter check, jumping-unit rules
   (targetability, Log immunity, JumpHack pushback immunity), summon lane hints
   and the arena clamp of 0xd35ab4, and the loader's Mass formula (crown towers
   derive mass 20; the fitted value is gone). Earlier: pending-damage overkill
   rule (0xf94824), projectile flight/hit/chain (0xf90708, 0xf9188c), damage
   apply and key window (0xfcaeec), deploy check and zones (0xf9e16c, 0xfa2c0c,
   0xfa023c); see `sim/core/test/ported.test.ts`.
   Done 2026-10-12 (golem, `death_spawn.test.ts`, decompiles in `work/native/decomp_golem/`):
   death spawns from the spawn request of 0xf83990 run by 0xf8aac8 (ring step (n−1−i)·360/n,
   no team mirror, the source facing + SpawnAngleShift, 0x11d950c point check without a radius),
   members with hitpoints active at once unless DeathSpawnDeployTime >= 1 (the engine used to make
   Golemites, Elixir Golem parts, Lava Pups and Tombstone Skeletons deploy for 1 s), the
   DeathSpawnPushback slide (0xfcff3c) and the LOGIC_DEATH_SPAWN_IMMUNE_FIRST_TICK targeting
   immunity; ManaOnDeathForOpponent as the kill reward 0xfca5ec (loader ×10, to the damage's owner,
   none for the tiebreak's kill) and ManaOnDeath in the death 0xf83990, both with the engine event
   `elixir`. State hashes of matches with death spawners change; others are unchanged.
   Done 2026-10-12 (eng3, `spawner.test.ts`, `post_end.test.ts`, decompiles in
   `work/native/decomp_eng3/`): periodic spawners from 0xf800bc's timer (SpawnStartTime, loader
   default 0, so Tombstone / Barbarian Hut spawn on the deploy-end tick; half the spawn-speed
   percentage per tick; SpawnInterval / SpawnPauseTime) and the request run by the shared 0xf8aac8
   port (`spawnSetup`, also used by death spawns): members with hitpoints active at once (the engine
   used to make Witch / Night Witch / Tombstone / hut members deploy 1 s), ring placement without
   mirror, one member 1500 in front of a hut / Tombstone. State hashes of matches with periodic
   spawners change; others are unchanged. The world after the end (`BattleConfig.postEnd`, on in the
   viewer, off by default): 80 more ticks until EndScreenDelay (0x10ca9a0 / 0xd3581c), plays rejected
   (0xd77504), attack clocks held at 0 (0xfc90b0), only flag-8 damage (0xfcb29c), the fallen King's
   side cleared by the wave of 0xd352f8 / 0xd35de4; results never change. Also: plays committing once
   time is up are rejected and only flag-8 damage applies during the tiebreak (0xd77504 / 0xfcaeec;
   hashes of tiebreak matches change, results do not).
2. **Differential checks:** ask the owner to run the Mac harness on a few
   scripted matches (two knights crossing, Arrows on Skeleton Army, Giant vs
   Cannon, Hog Rider jump) and record per-tick positions/HP; add them as tests.
3. **Card coverage (M4)** by mechanic family: dashes, attack sequences,
   scripted actions, multi-projectile troops, Tornado, Clone, Graveyard,
   Earthquake, champions, evolutions.
4. **Speed:** the native movement made each tick dearer (~4,000× real time);
   inline the A* visit loop, keep spatial queries allocation-free.
5. **HUD left:** the gain flash on the hand cards needs BattleArt.drawCard to apply the `color`
   option hud.ts now passes (battle_art.ts: `opts.color` multiplied into the card's colour); the
   emote system's approximations (no player profile: the DefaultOwned King emotes; Play_emote's own
   volume; the ScrollArea mask; the 9-slice grid algorithm) and spectator / 2v2 / battle-end chat taunts
   (docs/FIDELITY.md Emotes row). Done 2026-10-12 (hud4, decompiles in `work/native/decomp_hud4/`):
   emotes (HUD_taunt 0x8cd4ec, the menu 0x8e9284 / 0x8ea3a4 / 0x8ead78 / 0x8eab24, the bubbles
   0x8e8f0c / 0x8e89d0 / 0x8e920c / 0x8e8c38, the HUD's 0x8d1228 / 0x8d601c / 0x8d6820, Play_emote
   0x8892cc; `sc/emotes.ts`), the game buttons' button_timeline press feedback and click sound
   (0x1273538 / 0x127386c / 0x894dfc; `sc/ui_button.ts`: the result's OK, the emote and mute buttons),
   the result screen's confetti (0x8c08b0 -> 0x855d04 / 0x82dfe8; `sc/confetti.ts`), the intro's touch
   hold (0x8cace4 / 0x8cad48 and the hold scale of 0x8ca764), the end screen dropping the released
   plays' leftovers (0xbe0100 -> 0x8dd538), the back-row line settled (logic Globals +0x1c8 is 0:
   zeroed by the constructor 0xe367f4 -> 0xe36aac, written by no loader, so 0xbe1500 / 0x8e1fb8 use the
   own arena edge, as the viewer did), the HUD clock frozen once the battle manager stops at
   EndScreenDelay (0x10ca9a0 / 0xd3581c), the tap floater TID_NO_SPELL_SELECTED_TAP of the battle
   screen's touch end 0xbe1120, and the drag-spell sound found absent (DragEffect, client tables
   +0xee0, has no reader and no sound). `BattleUi.isHuman` is set by main.ts from the AI toggles.
   Done 2026-10-12 (golem): the
   death-elixir floats (engine event `elixir` -> `BattleUi.gainFloat`), the Log leftover's end
   (engine events `cast.pid` / `projEnd` -> battle screen vt+0xd8 0xbe4340), the commit-run
   TID_INVALID_SPELL_POSITION floater (vt+0x230 0xbe8910 at the popup manager's default point
   0x88ca58; engine event `reject`; the vt+0x280 cooldown text needs a mode ladder lacks), the HUD
   clock after the end (timeline section `Battle.overtime`, the clock running on during
   EndScreenDelay, HUD_topRight's fade 0x8d1e6c, the renderer now applies a named colour to text so
   the red last-30-s seconds show) and HUD_player's slide-in / slide-out with the 0.4 hand-update
   gate (0x8db8e0 / 0x8dc37c). Training bridge (M3) and
   the fidelity pass (M5); see [GOAL.md](GOAL.md). Done 2026-10-12 (hud3): crown flights to the counter
   and its fade (0x8d0dd8 / 0x8d2de0 / 0x8dd90c / 0x8d1e6c, `sc/crown_fly.ts`, effects.sc star_appear*
   in the bake), the spend drops and the "-cost" float at the play's pending run (0xd77504 -> 0xfa35c4 ->
   0x85ada8 -> 0x8dcbf4 / 0xbe5898; spells too), the refund flash and the 0x8b2368 bar geometry
   (0x8dbebc), the x2/x3 badge (0x8d38c4 -> 0x8d5158), the collector's gain float (0xbe4a8c), both
   `darken` backdrops (graphics level 2 assumed). Also done: the
   "Not enough Elixir!" floater of a play rejected for elixir (0xd77504 →
   0xbe7184, gate SHOW_NOT_ENOUGH_MANA_AFTER_FAILURES; popup manager floaters
   0x88cb54 / 0x88ce50 / 0x88cc2c / 0x88c7fc, `sc/floater.ts`; decompiles in
   `work/native/decomp_floater/`), the full-elixir hand wiggle (0x8dc37c →
   0x907654 / 0x9077f0 / 0x907ab0), the
   unaffordable-drop wait (MAX_SPELL_PENDING_TIME: 0x8e2c04 / 0x8e2d50 /
   0x8e1408 +0x324) and the released play's leftover preview (ghosts, ring,
   name; 0xbe1aa8 → 0x8dd100, dropped by the cast 0xbe5b4c), decompiles in
   `work/native/decomp_hand2/`. Also done: the
   tiebreaker / draw / final-score clips of 0x8d38c4 and the crown-score
   prints of 0x8d2de0 (`sc/announce.ts`), on the engine's ported tiebreak
   (`Battle.tiebreakMs` / `drawMs`, 0x10ca9a0, `end.test.ts`); decompiles in
   `work/native/decomp_end/`.
6. **Viewer fidelity left:** the arena clip field +0x84 used as the 180°
   turn's ty (768 assumed), particle emitter semantics (EmitterReplaceType modifiers, TrailSWF),
   and the items of the 2026-10-12 audit not yet ported (per-card
   effects of non-default cards). Done 2026-10-12: the battle intro banner
   (0xbdfa8c → 0x8c81b8, `sc/intro.ts`; HUD hidden and input blocked until its
   actionFrame, the battle clock does not wait) and the end-of-battle result
   screen after EndScreenDelay (0xd3581c → 0xbe0100 → 0x8bc564 / 0x8c2b80,
   `sc/result.ts`), both on the client's MovieClip runtime (`sc/movieclip.ts`,
   per-instance playheads); decompiles in `work/native/decomp_intro/`. The result's confetti,
   its OK button's press feedback and the intro's touch hold are done too (hud4, item 5).
   Done 2026-10-12 (units3, `sc/unit_view.ts`, decompiles in
   `work/native/decomp_units3/`): health bars per frame as 0x83c268 (enemy
   NoDamage badge always, own bars only once damaged, LifeTime buildings always,
   the shield as the bar, the +0x470 damage flash) and the client-action bar of
   Dark Prince / Skeleton Warrior (0x8405c4 → 0x853574); summon members'
   staggered reveal at half alpha (0xd423bc → vt+0x138 0x846b2c); shooter
   effects (0xf85244), death effects at z with angle and buff override
   (0x850504 / 0xfc2288), AttackStartEffect (0x83e524), view effect calls
   vt+0x80 / vt+0xc0; the frame clock keeps running after the battle end
   (0xbe1d3c → 0x856f28). Left (A): the bar holder's visibility in state 11,
   Underground read as tunnelling (the Miner's tunnel view vt+0x168 is ported, fx2 below).
   The battle layer's placement (content scale 0x772a70, layer scale and
   position 0xbdefac, `sc/ui_port.ts` stageLayout) and the drag preview's
   snap (deploy check 0xf9e16c) are ported. 0x83c0ac is the HideBeforeFirstHit
   scale, which no unit in this build uses. Decompiles for the view work are in
   `work/native/decomp_shadow/` and `decomp_anim/`.
   Done 2026-10-12 (aoe, `sc/area_view.ts`, decompiles in `work/native/decomp_aoe/`,
   coverage in [docs/EFFECTS.md](docs/EFFECTS.md) "Spells"): the client's area-effect
   object view (factory 0x84fc88 → 0x833b84 / 0x8342c8 / 0x834038) replaces the
   radius-scaled, 300 ms-faded approximation: LoopingEffect attached and stopped
   by the parent-removed notice, OneShot once, ScaledEffect once with its SWF clips
   stretched over life − 200 ms and faded over 200 ms (effect +0x98 / +0x9c,
   0x82a994 hold path, now in `sc/effects.ts`), pulse HitEffect from the new
   recorded engine event `aoePulse`; buff views (0x8348c8: the buff's Effect on
   the unit, deleted with the buff) and the buff filter's clock and colour
   arithmetic (0x82ea34 / 0x82ebdc: filters loop over their clip, so the cold tint
   cycles); the cast effect plays once (0x850258 → 0x82dc54) for every card. Left
   (–): followed targets / Clone mode / the AEO's own clip (no supported user),
   crown towers drawn without buff filters, a frozen unit's idle clip (anim.ts).
   Finding for the engine: AreaEffectData's TargetProjectiles defaults to true in
   the loader (0xdc2e74), which is what the engine's Lightning heuristic assumes.
   Done 2026-10-12 (fx2, `sc/char_effects.ts`, `sc/beam.ts`, decompiles in
   `work/native/decomp_fx2/`, coverage per unit / field / projectile in
   [docs/EFFECTS.md](docs/EFFECTS.md) "Units and buildings"): every effect field of
   the 64 characters and buildings the 70 cards create is played at its client call
   site or marked: damage entries' effects on the victim (0xfcb29c → vt+0xc0, incl.
   the global "Damage" spark of splash, spell and fallback hits), the melee splash's
   centre effect, TargetedHitEffect beams (Tesla, Electro Wizard: 0x84e8e0 + the
   0x82a994 beam), Inferno beam / flame / level-transition slots (0x83b6d8),
   ContinuousEffect, ChargeEffect with its Filter component recolouring the unit
   (0x82ebdc), ShieldLostEffect, SpawnCharacterEffect (Witch, Night Witch), the
   Miner's tunnel effect and tunnel-end reveal (vt+0x168 / vt+0x170), chain beams
   (Electro Dragon / Spirit, 0xf8f618 → 0x84ef20), piercing projectiles' DeathEffect
   at their last hit and the axe's PingpongDeathEffect, the deploy filter of death
   and projectile spawns (view vt+0x140: only members that deploy, e.g. Balloon
   bombs with their carrier's clip, Barbarian Barrel's filter_deploy_unit_miner,
   none for Goblin Barrel). Filter components share the buff filter's code
   (`sc/area_view.ts`); world-listener effects play once. New recorded engine
   events `damage`, `shieldLost` and fields `spawn.src` / `pid`, `hit.src` / `fx`,
   `impact.src` / `z` (no simulation change). Its finding for the engine (0xf8aac8 deploys a
   spawner's member with hitpoints only with SpawnCharacterWithDeploy) is ported (eng3, item 1).
   Left: Tesla's AttackStartEffect (single-clip
   buildings), Electro Dragon's LoadAttackEffects (sound only); the Inferno view's +0x4cc and the
   view jolts are done (view5 below).
   Done 2026-10-12 (fix3, audit items; decompiles in `work/native/decomp_fix3/`, tests in
   `sim/viewer/test/view_fix3.test.ts`): nested clips of unit, building, crown tower, projectile and
   ghost views play on their own playheads (`sc/movieclip.ts` ClipInstances, renderer `inst`; 0x84a310 /
   0x123f55c), health bars use the client's reference clip (direction _1 of the team's idle export, ⌈top⌉,
   the King tower with the King inside; 0x836e58) and are depth-sorted in layer 12 (0x856a88), the King
   tower's shadow holds the King and every HasRotationOnTimeline shadow poses its turret (0x8455cc),
   the hit wobble and the death angle come from new recorded engine events (`wobble` = view vt+0xe8,
   `damage.vx/vy` = the entry's vector; no simulation change), TryToFinishAttackAnimation stops while
   frozen, and the legacy sprite pickers (`sc/units.ts`, BattleArt.viewAngle, art.ts unitState /
   attackPhase) are gone: every sprite comes from the ported 0x844f78 → 0x84a7f8 path (the sc-test gallery
   too). Left: the sprite / shadow clip copies share one instance and the Electro Wizard's extra targets
   carry no hit vector (A); the turret's frame-apply reset is traced and invisible (view5 below).
   Done 2026-10-12 (view5, decompiles in `work/native/decomp_view5/`, tests in `sim/viewer/test/view5.test.ts`):
   the attack frame's VisualHitSpeed branch 0x845244 (the Inferno Dragon's attack clip loops every 1200 ms
   of the timer and plays no AttackStartEffect), TryToFinishAttackAnimationBeforeNextAttack (Valkyrie's
   swing goes on after a kill restarts the timer, @0x8427a8), AttackShakeTime (@0x842c44), the AttackDashTime
   lunge of the Bats (view vt+0x40 0x845ce8 → the position getters 0x846f98…: half way to the target's edge
   at the hit), the view jolts of ShakesTargets (vt+0xf0 0x83e488 → 0x839b08: Executioner, Magic Archer,
   Barbarian Barrel), the Inferno beam entry = the engine's sequence index every frame with 0x83b6d8's
   effect-only slot rule, the Electro Wizard's two beams from attack_pivot_1 / _2 (execute's slot; the old
   third beam is gone, cancelled hits play none; pivots are text-field rect centres), arena / decoration /
   effect SWF clips on per-instance playheads, vtb8 for the jump clip; new recorded engine events `dash`
   and `shake` (no simulation change). Checked and left as is: the Miner's tunnel effect already follows
   the logic position (its dirt stays where emitted, as the client's emitters do), AttackFinishTime only
   matters for AttackStateCount ≥ 2 (no supported user), and the turret frame-apply reset of 0x123f7b4
   happens only while the turret has sign +1 and no recoil (invisible). The Electro Wizard beam overshoot
   could not be reproduced (4,416 beam frames of an AI battle and the single / two-target / tower / red-side
   cases end within 8 px of their target).
   Fixed 2026-10-12 (owner: "the valk still swings as it moves", `sim/viewer/test/finish_anim.test.ts`): the
   Valkyrie's TryToFinishAttackAnimation is armed by the state 0x840d44 returned last frame (+0xa84, @0x840de0)
   and ends on frame 0, a frame before the action frame or past the clip (@0x8436d8); the port re-armed it from
   the shown action and ended it on frame 0 only, so after her first attack she spun for as long as she walked.
   She now plays at most the rest of one follow-through (as the client does) and then her run clip. No other
   supported character has the flag; Knight, Mini P.E.K.K.A, Barbarians, Giant and P.E.K.K.A were checked.

## Open questions for the owner

- Pocket deploy area after a Princess tower falls: now from the decompiled zone
  map (the fallen tower stops stamping its 11×21 no-deploy area; the King's
  18×16 area still blocks), i.e. that lane from the river to y 20999. Worth a
  smell test.
- Starting elixir: the owner said to follow the decompile; data and the native
  run both give 6.
- Training stack: decided 2026-10-12. PyTorch PPO self-play on RunPod, driven
  over HTTPS (train/README.md). Open: GPU / vCPU budget for the first run, and
  whether the policy may see the opponent's hand. It currently gets only what
  is derivable from public plays; the critic sees everything.
- Which cards or decks should come first after M1?
- Smell test (2026-10-12, eng4): a Log or Bowler ball hits a tunnelling Miner
  (the decompile has no exemption), and the Miner tunnels via a bridge, not in a
  straight line.

## Known gaps

- Unit-vs-unit pushing, avoidance, knockback and formations are ported from
  the code but not yet checked against a native trace.
- The battle RNG uses the native algorithm with a local seed.
- Double and triple elixir regen rates are inferred, not observed.
- Card stats truncate (0xe7e418: m · base / 100). The engine reads Common's multiplier table for every rarity; the client's shorter Rare / Epic / Legendary / Champion tables iterate v + v/10 past their end, which differs from Common's entries only from card level 21 (Rare) up, beyond the highest level (16).
- Live game updates after install aren't included in `game-files/`.
- The overtime tiebreak is ported from the battle manager (0x10ca9a0: field
  cleared, 3.25 s pause, all towers drain until the lowest falls; equal towers
  draw), gated by the game mode's NoDraws (Ladder: true). The Duel series flow
  (BestOfGame between games) is not ported. The native test runner scored a
  tie as a draw (−1); why (its mode's NoDraws, equal towers) was not traced.
