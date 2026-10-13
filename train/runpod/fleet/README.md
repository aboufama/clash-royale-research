# Population tooling (RunPod)

Scripts that drove the nine-pod population on 2026-10-13. They need `CRL_SP` pointing at a scratch
directory that holds `runpod.key` (the RunPod API key, mode 600; never commit it), and they use
`../launch.py` with the pod registry in `work/runpod/pods.json`.

| Script | What it does |
|---|---|
| `grab4.sh NAME MIN` | Rent one pod. Tries community 5090, then secure 4090 / 5090, then community 4090. Verifies `cuInit` and a bf16 matmul at ≥ 50 % clock (`gpubench.py`); terminates and retries on failure. |
| `fleet.sh` | Initial rollout: rent pods in turn, upload a checkpoint, start the variants. Never run two rent loops at once (they race on `pods.json`). |
| `fleet_flags.txt` | Each pod's run and variant flags, as of the pause. |
| `restart_same.sh [pod ...]` | Stop, push code, and restart each run from `fleet_flags.txt` (it resumes from `latest.pt`). |
| `winddown.sh` | Stop each run, fetch `latest.pt` and `metrics.jsonl` to `work/runpod/final_<date>/`, stop the pod. |
| `popstat.sh` (+ `popsum.py`) | Last-100-update bot benchmark per run: win rate, crowns, the owner's bar (1+ crown and no tower lost). |
| `breakwatch.py` | Every 10 min, prints BREAKTHROUGH (bar ≥ 50 % or ≥ 45 % wins over 250+ games) or a big leap. |
| `podwatch.py` | Tails the pods' training logs; prints errors, every 10th update and behaviour lines. |
| `deepwatch.sh POD RUN` | Fetch a run's checkpoint and run `crl.watch` on it locally. |
| `trendpod.py` | Windowed bot benchmark for one `metrics.jsonl` (upload it to a pod and run it there). |

The relays between runs are `../relay.py` (main ↔ exploiter, and `--one-way` exploiter → other runs).
