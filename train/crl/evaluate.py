"""Win rate of a trained actor against the scripted bot (or random play).

    python -m crl.evaluate runs/exp1/latest.pt --episodes 200 --bot-level 3 [--greedy]
    python -m crl.evaluate runs/exp1/actor_000500.pt --opponent random
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import torch

from .envpool import EnvPool, available_cpus
from .model import Actor, Layout, ModelConfig


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("checkpoint")
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--opponent", choices=["bot", "random"], default="bot")
    p.add_argument("--bot-level", type=int, default=3)
    p.add_argument("--greedy", action="store_true", help="argmax actions instead of sampling")
    p.add_argument("--workers", type=int, default=max(1, available_cpus() - 1))
    p.add_argument("--envs", type=int, default=8)
    p.add_argument("--seed", type=int, default=12345)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--replays", default="", help="write every episode as a replay JSON here (viewer: ?replay=<url>)")
    a = p.parse_args(argv)
    device = torch.device(a.device)
    ck = torch.load(a.checkpoint, map_location=device)
    env_cfg = {"botProb": 1.0 if a.opponent == "bot" else 0.0, "randomProb": 1.0 if a.opponent == "random" else 0.0,
               "botLevel": a.bot_level}
    if a.replays:
        env_cfg["replayDir"] = str(Path(a.replays).resolve())
    pool = EnvPool(a.workers, a.envs, a.seed, env_cfg)
    actor = Actor(Layout(pool.spec), ModelConfig(**ck["model"])).to(device).eval()
    actor.load_state_dict(ck["actor"])
    results = []
    t0 = time.time()
    actions = None
    while len(results) < a.episodes:
        fr = pool.step(actions)
        for row in fr.dones:
            results.append(float(row[3]))
        if len(fr.meta) == 0:
            actions = np.zeros((0, 4), np.int32)
            continue
        with torch.no_grad():
            s, t, _ = actor.act(torch.from_numpy(fr.obs).to(device), torch.from_numpy(fr.masks).to(device), greedy=a.greedy)
        actions = np.stack([fr.meta[:, 0], fr.meta[:, 1], s.cpu().numpy(), t.cpu().numpy()], 1).astype(np.int32)
    pool.close()
    r = np.array(results[:a.episodes])
    opp = f"bot level {a.bot_level}" if a.opponent == "bot" else "random play"
    print(f"{a.checkpoint} vs {opp}, {len(r)} episodes ({'greedy' if a.greedy else 'sampled'}): "
          f"win {np.mean(r > 0):.3f} draw {np.mean(r == 0):.3f} loss {np.mean(r < 0):.3f} in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
