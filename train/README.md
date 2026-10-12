# Training an agent (self-play RL)

The agent learns by playing the deterministic simulator against itself. Nothing in the policy is
hand-written: no card heuristics, no human replays, and a sparse reward (win / loss) once the
start-up shaping has faded out. The aim is to spend compute on search and learning rather than on
built-in knowledge.

## Pieces

| Part | Where | What |
|---|---|---|
| Environment | `sim/rl/` (TypeScript, runs on Node ≥ 22.18) | `env.ts`: one battle, controllers (trainer / scripted bot / random), decision points, discounted reward sums. `obs.ts`: observation and legal-action masks. `worker.ts`: N battles per process, binary frames over stdin/stdout. |
| Trainer | `train/crl/` (Python, PyTorch) | `envpool.py`: Node workers. `model.py`: actor and critic. `rollout.py`: transitions and GAE. `league.py`: snapshot opponents. `train.py`: PPO loop. `evaluate.py`: win rate vs the bot. |
| Cloud | `train/runpod/` | `launch.py`: create a pod, upload the code and drive the run over HTTPS. `podserver.py`: the pod's control server. |

The engine is the same code as the browser game (`sim/core`). The only engine addition is
`Battle.deployGrid`, which reuses the native deploy check's footprint test to list the tiles where a
card lands exactly as aimed. It is used for the action mask and has no effect on the simulation:
the benchmark gives the same ticks and results before and after the change.

## Design

**Decisions.** The agent may act every 5 ticks (250 ms), but only when it has a playable card.
Otherwise waiting is the only legal action and no network call is made. Each transition is
(observation, action, reward sum, k ticks, next observation). Rewards are discounted per tick
(γ = 0.9997, a horizon of about 167 s), and GAE uses γ^k.

**Actions.** Two choices, sampled in order:
- the slot: wait, or one of the 4 hand cards (masked to the playable ones);
- the tile: one of the 18 × 32 tiles (masked to the tiles where the chosen card lands as aimed).

Every position the game's own snap could produce is one of these tiles, so masking loses nothing.

**Observations.** Each side sees the board from its own end: team 1's view is turned 180°, as
in the client. One network therefore plays both decks from both sides. The observation is a set
of entities:
- every unit and tower: type, owner, position, hp, shield, deploy, target, attack clock, charge, buffs, height;
- every projectile and area effect;
- both decks;
- the own pending plays;
- a global token: clock, overtime, elixir rate, elixirs, crowns, hand timer.

**What the agent knows about the opponent.** The actor gets fair information only: what a player
can see or work out exactly.
- **Opponent elixir.** Elixir is debited when a play commits, which is the moment the card
  appears, and regeneration and the cap are deterministic. So it is a function of the public
  history.
- **Opponent cycle.** A played card goes to the back of the queue. The last ≤ 4 plays are
  therefore known queue entries, and after 4 plays the hand is known too. The rest of the deck
  gets a probability of being in hand.

**The critic.** It additionally sees privileged information: the opponent's exact hand, queue
order, plays still inside the 1 s command delay, and pending elixir. This makes value estimates
less noisy without letting the policy depend on hidden information (asymmetric actor-critic, as
in AlphaStar's value baseline).

**Network.**
- Actor: a transformer over the entity tokens (default d = 256, 4 layers, 8 heads, about 3–5 M
  parameters).
  - Slot logits come from each hand card's token.
  - Tile logits come from 576 tile queries that cross-attend to the entities (plus a 3 × 3
    depthwise conv), dotted with a query from the chosen card.
- Critic: a smaller transformer with the privileged tokens.

Everything is learned from data: card identities are embeddings, and no hand-made features are
used.

**Self-play.**
- By default, half the trainer-vs-trainer episodes are the current policy on both sides, and
  both sides learn.
- The other half pit it against frozen snapshots, saved every 10 updates and kept up to 64. The
  opponent is picked by PFSP: the snapshots it beats least are played most.
- 5 % of episodes are against the scripted bot (level 3). That win rate is the running
  yardstick; it is not the objective.

**Reward.**
- Base: +1 for a win, −1 for a loss, 0 for a draw. The Ladder rules use the tiebreak, so draws
  are rare.
- Shaping, to get learning started: crown-tower damage dealt minus damage taken, in fractions
  of max hp, weighted 0.5. The weight decays linearly to 0 over the first 2·10⁸ decisions.

**PPO.** 65 536 transitions per update, 2 epochs, minibatch 8192, Adam 3e-4, clip 0.2, value
clip 0.5, entropy 0.01, bf16 autocast on the GPU.

**Throughput.**
- Per core, the simulation gives about 25k ticks/s, or about 1 200 decisions/s and 6 episodes/s
  with active play. Observation encoding is about 7 % of that; the engine's targeting,
  pathfinding and collisions are the rest.
- Workers are split into two groups that step alternately, so simulation overlaps inference and
  bookkeeping.
- A 32-vCPU pod should give about 30k decisions/s, or about 150 matches/s.

## Running locally

```sh
pip install -r train/requirements.txt         # torch, numpy; node >= 22.18 on PATH
cd train
python -m crl.train --smoke                   # tiny CPU run through every path (about 1 minute)
python -m crl.train --out runs/local --workers 3 --envs 16 --rollout 8192 --minibatch 2048
python -m crl.evaluate runs/local/latest.pt --episodes 100 --bot-level 3
python -m unittest discover -s tests          # GAE tests
cd ../sim && node rl/bench.ts 32 10           # worker throughput; npm test runs rl/test too
```

`metrics.jsonl` in the run directory logs every update: win rate vs self / league / bot, decisions
per second, losses, entropies, KL, explained variance, play rate and episode length.

## Running on RunPod

`launch.py` reaches the pod over HTTPS through RunPod's proxy. The machine driving it, a cloud
session included, may have no SSH. The pod's container command is `podserver.py`, which installs
Node, receives the code bundle and runs the trainer.

```sh
export RUNPOD_API_KEY=...                                  # never commit it
python3 train/runpod/launch.py create --name crl-1         # 1 GPU with >= 16 vCPUs (see --gpu, --min-vcpu)
python3 train/runpod/launch.py wait
python3 train/runpod/launch.py push
python3 train/runpod/launch.py start --run exp1 -- --envs 24
python3 train/runpod/launch.py log                         # also: status, ls runs/exp1, fetch runs/exp1/latest.pt
python3 train/runpod/launch.py stop                        # SIGINT; `start` again resumes from latest.pt
python3 train/runpod/launch.py terminate                   # stops billing; the volume goes with it
```

The pod id and its control token are stored in `work/runpod/pods.json`, which git ignores.

The bundle contains only:
- `sim/core/src`, `sim/rl` and `sim/data` (the engine and its gameplay JSON);
- `train/crl`.

It never contains `game-files/`, art or audio (see docs/DECISIONS.md).

**Sizing.** The simulation is CPU-bound and the model is small, so buy vCPUs rather than GPU
size: one mid-range GPU (RTX 4090 / L40S / A6000) with as many vCPUs as offered is the efficient
setup. A multi-GPU pod mainly adds vCPUs (the trainer uses one GPU).

## Next steps

- **Watch the agent play.** Export its matches as replays (seed, decks, plays per tick), load
  them in the viewer, or run the actor in the browser (ONNX) to play against it.
- **League exploiters**, if self-play cycles (AlphaStar-style agents trained only to beat the
  main policy).
- **Engine speed**: grid queries and path search dominate the profile.
- **More decks**: the observation is deck-agnostic (card embeddings), so the same network can
  train on deck pairs drawn from the supported cards.
