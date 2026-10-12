"""Opponent pool for self-play: frozen snapshots of the learner, sampled by prioritised fictitious
self-play (opponents the learner beats less often are picked more often, AlphaStar-style)."""
from __future__ import annotations

import copy
import random
from dataclasses import dataclass, field
from pathlib import Path

import torch


@dataclass
class Snapshot:
    sid: int
    update: int
    path: str
    wins: float = 0.0
    games: float = 0.0
    state: dict | None = field(default=None, repr=False)

    def winrate(self) -> float:
        # Beta(1, 1) prior: an untested snapshot counts as 50 %
        return (self.wins + 1.0) / (self.games + 2.0)


class League:
    def __init__(self, out_dir: Path, max_size: int, active: int, pfsp_power: float, rng: random.Random):
        self.dir = out_dir / "league"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_size = max_size
        self.n_active = active
        self.pfsp_power = pfsp_power
        self.rng = rng
        self.pool: list[Snapshot] = []
        self.active: list[tuple[Snapshot, torch.nn.Module]] = []
        self.next_sid = 0

    def add(self, actor: torch.nn.Module, update: int) -> Snapshot:
        sid = self.next_sid
        self.next_sid += 1
        state = {k: v.detach().to("cpu", copy=True) for k, v in actor.state_dict().items()}
        path = self.dir / f"snap_{sid:05d}.pt"
        torch.save({"sid": sid, "update": update, "actor": state}, path)
        s = Snapshot(sid, update, str(path), state=state)
        self.pool.append(s)
        if len(self.pool) > self.max_size:
            # keep the newest half and a spread of older ones
            old = self.pool[:-self.max_size // 2]
            drop = old[self.rng.randrange(len(old))]
            self.pool.remove(drop)
        return s

    def resample(self, template: torch.nn.Module, device: torch.device) -> None:
        """Pick the active opponents for the next rollout by PFSP weights."""
        self.active = []
        if not self.pool:
            return
        weights = [(1.0 - s.winrate() + 0.05) ** self.pfsp_power for s in self.pool]
        picks: list[Snapshot] = []
        cand = list(range(len(self.pool)))
        for _ in range(min(self.n_active, len(self.pool))):
            tot = sum(weights[i] for i in cand)
            r = self.rng.random() * tot
            for j, i in enumerate(cand):
                r -= weights[i]
                if r <= 0:
                    picks.append(self.pool[i])
                    cand.pop(j)
                    break
        for s in picks:
            if s.state is None:
                s.state = torch.load(s.path, map_location="cpu")["actor"]
            m = copy.deepcopy(template)
            m.load_state_dict(s.state)
            m.to(device).eval()
            for p in m.parameters():
                p.requires_grad_(False)
            self.active.append((s, m))

    def sample(self) -> int:
        return self.rng.randrange(len(self.active)) if self.active else -1

    def record(self, sid: int, outcome: float) -> None:
        for s in self.pool:
            if s.sid == sid:
                s.games += 1.0
                s.wins += 1.0 if outcome > 0 else 0.5 if outcome == 0 else 0.0
                return

    def state(self) -> dict:
        return {"next_sid": self.next_sid,
                "pool": [{"sid": s.sid, "update": s.update, "path": s.path, "wins": s.wins, "games": s.games} for s in self.pool]}

    def load_state(self, st: dict) -> None:
        self.next_sid = st["next_sid"]
        self.pool = [Snapshot(p["sid"], p["update"], p["path"], p["wins"], p["games"]) for p in st["pool"] if Path(p["path"]).exists()]
