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
2. The diagnostic pipeline supplies all 421 resource inputs for original parsing
   and finalization; the original built-in Normal runner then creates its own
   test battle and reaches its native winner.
   Independent complete runs reproduce the selected steps and events. Preserve
   this reproducible checkpoint while replacing its remaining modeled platform
   boundaries with original Android routines and audited kernel inputs.
3. Finish original Android linker/process initialization. The shared game/Android
   asset manager reaches actual native file consumers, but the full-data path
   still stops at library registration needed by thread-destructor setup.
4. Ordered externally selected deployments for both owners now repeat through
   original construction, prediction, queueing, delayed commit, debit, spawn
   and live insertion in two fresh 124-tick diagnostic runs. Extend this to a
   complete externally controlled episode with verified native termination and
   position/health capture. The existing complete runner uses its own policy;
   the external-action probe is not yet a full match or training environment.
5. Capture every simulation-affecting field and ordered event, establish a
   complete reset mechanism, and validate the supported runtime and ordinary
   match behavior. Position/health observations and finite matching diagnostic
   runs do not replace these requirements.
6. Measure deterministic headless throughput and implement self-play and policy
   training only after the exactness gate passes.

The README chart reports evidence achieved toward these stages. It is reviewed
and updated on every push under the rules in [AGENTS.md](AGENTS.md).

The full native diagnostic replay has been delivered with troop placement and
observed interactions. Its test-mode and modeled-platform limits remain visible.
Future demos must continue to use verified original execution, retain unknown
fields honestly and never substitute generated battle mechanics.
