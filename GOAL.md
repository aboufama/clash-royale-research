# Goal: an exact battle engine and a trained battling agent

The required outcome is a reproducible Clash Royale training environment and
an evaluated battling policy. The current work is engine recovery; there is no
working battle environment or trained policy yet.

## Hard acceptance criterion

The user requires a **byte-identical troop interaction model, including attacks
and towers, with no approximation**. This is a hard constraint, not a stretch
target. The project must preserve original simulation instructions and gameplay
data for the pinned build, and produce bit-identical complete per-tick battle
state and ordered events under identical starting state, inputs, and randomness.

Any unexplained difference fails acceptance. There is no numerical tolerance,
visual-similarity threshold, percentage-match substitute, guessed mechanic, or
learned surrogate that can satisfy this requirement. A policy trained in an
approximate environment does not complete this goal.

Raw process memory also contains addresses and operating-system bookkeeping.
The state-capture contract must identify every field that can affect subsequent
simulation, preserve its exact representation, and justify its completeness.
It must not omit inconvenient fields to manufacture matching traces. Instruction
identity, data identity, complete state capture, and behavioral equality are
separate evidence requirements.

Loader emulation with modeled system calls is a tool for recovering the original
bytes. A successful mocked constructor or JNI call does not prove a correct
runtime or a correct battle simulator. Runtime assumptions that influence
simulation must be eliminated or demonstrated equivalent to the original.

The only currently available reference is the original downloadable build and
what can be run or inspected using this computer and public materials. No
Supercell source code, special test build, private state traces, or Android
device access is assumed. If exactness cannot be established with those inputs,
the goal remains unmet; the project must not lower the requirement.

## Required milestones

| Stage | Required result | Acceptance evidence |
| --- | --- | --- |
| 1. Pin inputs | Complete original code and gameplay assets for one build | Package/version checks, signatures, byte hashes, asset manifest |
| 2. Recover runtime | Original native simulation instructions available and executable | Reproducible loading/recovery; original-code identity; explicit runtime dependencies |
| 3. Expose battle control | Reset, state capture, ordered commands, tick advancement and termination | Executable adapter to the original engine; documented coordinate/time/state representations |
| 4. Establish exactness | Troops, attacks, projectiles and towers match exactly | Complete state/event capture; zero-difference per-tick comparisons; code/data identity; all supported mechanics covered |
| 5. Run training matches | Deterministic headless matches and self-play | Reproducible seeds/inputs, measured throughput, stable reset, no mechanics shortcuts |
| 6. Train a policy | Policy improves through experience in the accepted engine | Versioned checkpoints and training configuration; legal observations/actions; reproducible evaluation against fixed baselines |

Stage 4 includes movement and bridge pathing; target choice and retargeting;
collision, pushing and knockback; spawn/deployment timing; attack windup,
cooldown, range and damage; projectile trajectories and area effects; tower
targeting, damage and destruction; troop abilities and status effects; elixir,
hand/deck rules, random state, simultaneous-event order, and battle outcomes.
Scope is the complete pinned build, not a favorable subset of troops.

Finite matching tests are necessary evidence, not a mathematical proof of all
reachable states. A 100% claim also needs an argument that original code, data,
state and runtime semantics have been preserved across the complete supported
simulation. Unsupported mechanics keep the exactness milestone incomplete.

## Current execution plan

1. Pinned install-time asset pack acquired and verified; still establish which
   fingerprint and cache overrides the reference runtime selects.
2. Support code, original selector records and `libg` code are recovered with
   explicit runtime models. Package the remaining private stage-two capture
   prerequisite; complete original initialization without forced success.
3. Original pathfinding and attack-clock functions execute on synthetic fixtures.
   Follow their original callers, data loaders and native state initialization
   to exercise movement, attack execution and a complete battle update.
4. Build an unmodified-engine reference runner and complete state-capture path.
   Synthetic object layouts and isolated function results do not satisfy it.
5. Implement the battle adapter and exact comparisons before policy training.

The README chart reports evidence achieved toward these stages. It is reviewed
and updated on every push under the rules in [AGENTS.md](AGENTS.md).

The user has seen an isolated original-pathfinding visualization. The next
requested visual demo must show a full match with troop placement and original
troop interactions. Intermediate component recovery is reported in text.
