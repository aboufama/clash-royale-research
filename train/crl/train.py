"""Self-play PPO for the Clash Royale simulator.

    python -m crl.train --out runs/exp1                 # from train/, defaults sized for one GPU pod
    python -m crl.train --smoke                         # tiny CPU run that exercises every path

One policy plays both decks from both sides (deck and side drawn per episode; team 1 sees the board
turned 180 degrees). Opponents: the current policy (self-play, both sides learn), frozen snapshots
picked by PFSP, and optionally the scripted bot (also the yardstick logged as win rate vs bot).
Reward: +1 / -1 / 0 for a win / loss / draw, plus an optional crown-tower damage term annealed to 0.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import queue
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from .envpool import EnvPool, available_cpus
from .league import League
from .model import Actor, Critic, Layout, ModelConfig, param_count
from .rollout import Rollout

OPP_NAMES = {0: "py", 1: "bot", 2: "random", 3: "none"}


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a = p.add_argument
    a("--out", default="runs/default")
    a("--seed", type=int, default=1)
    a("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a("--workers", type=int, default=max(1, available_cpus() - 3), help="simulation workers (default: leave 3 CPUs to the trainer)")
    a("--groups", type=int, default=2, help="worker groups stepped alternately (overlaps simulation and inference)")
    a("--collectors", type=int, default=1, help="collector processes sharing the workers (crl/dist.py when > 1)")
    a("--learner-device", default="", help="default: cuda:1 when there are 2+ GPUs, else --device")
    a("--collector-devices", default="", help="comma-separated devices the collectors take in turn (default: --device)")
    a("--learner-values", action="store_true", help="multi-collector: the learner computes V and GAE, collectors run the actor only")
    a("--envs", type=int, default=24, help="battles per worker")
    # env
    a("--decision-ticks", type=int, default=5, help="decision grid in 50 ms ticks")
    a("--gamma", type=float, default=0.9997, help="discount per tick (0.9997: ~167 s horizon)")
    a("--lam", type=float, default=0.95, help="GAE lambda per decision")
    a("--bot-prob", type=float, default=0.1, help="share of episodes against the scripted bot (benchmark only, never trained on)")
    a("--bot-level", type=int, default=3)
    a("--random-prob", type=float, default=0.0)
    a("--no-deck-swap", action="store_true", help="learner keeps deck 0 / team order fixed")
    a("--mirror", action="store_true", help="mirror match: both sides play the first deck (sim/rl/env.ts DEFAULT_ENV)")
    a("--self-play-prob", type=float, default=0.5, help="py-vs-py episodes where both sides are the learner")
    # reward
    a("--crown-coef", type=float, default=0.0, help="terminal reward += coef * (crowns taken - crowns lost) / 3")
    a("--shape-coef", type=float, default=0.5, help="crown-tower damage reward weight at the start")
    a("--shape-anneal", type=float, default=2e8, help="decisions over which the shaping weight decays to --shape-floor")
    a("--shape-floor", type=float, default=0.0, help="shaping weight after the anneal (zero-sum, so self-play stays fair)")
    # ppo
    a("--rollout", type=int, default=65536, help="complete transitions per update")
    a("--buffer", type=int, default=0, help="rollout buffer capacity (default 2x rollout)")
    a("--minibatch", type=int, default=4096)
    a("--epochs", type=int, default=2)
    a("--lr", type=float, default=3e-4)
    a("--lr-decay", action="store_true", help="linear decay to 0 over --total-decisions")
    a("--target-kl", type=float, default=0.0, help="adapt the lr each update toward this approx KL (0 = fixed lr)")
    a("--clip", type=float, default=0.2)
    a("--vclip", type=float, default=0.5)
    a("--vf", type=float, default=0.5)
    a("--ent", type=float, default=0.01, help="default for --ent-slot / --ent-tile")
    a("--ent-slot", type=float, default=None, help="entropy bonus of the slot head (wait / which card)")
    a("--ent-tile", type=float, default=None, help="entropy bonus of the tile head")
    a("--ent-card", type=float, default=0.0, help="entropy bonus of which card, given a play (slots 1-4 renormalized)")
    a("--card-floor", type=float, default=0.0, help="floor on p(card | play) for every legal card (e.g. 0.02); 0 = off")
    a("--card-floor-coef", type=float, default=0.05, help="weight of the card floor penalty sum(relu(log floor - log p))")
    a("--max-grad", type=float, default=1.0)
    a("--total-decisions", type=float, default=5e9)
    # model
    a("--d-model", type=int, default=256)
    a("--layers", type=int, default=4)
    a("--heads", type=int, default=8)
    a("--tile-dim", type=int, default=64)
    a("--critic-d-model", type=int, default=192)
    a("--critic-layers", type=int, default=3)
    # league / io
    a("--snapshot-every", type=int, default=10, help="updates between league snapshots")
    a("--league-size", type=int, default=64)
    a("--active-opponents", type=int, default=4)
    a("--pfsp-power", type=float, default=1.0)
    a("--import-dir", default="", help="add actor checkpoints dropped here (another run's snapshots) to the league")
    a("--import-keep", type=int, default=0, help="keep only the newest N imported snapshots in the league (0 = all)")
    a("--import-share", type=float, default=1.0, help="cap on the imported snapshots' share of the league's PFSP weight")
    a("--opp-slots", type=int, default=8, help="model slots for league opponents (graphs captured once per slot)")
    a("--opp-every", type=int, default=10, help="updates between league opponent rotations (each running game keeps its "
                                              "opponent alive, so rotating every update piles up models and graph replays)")
    a("--ckpt-every", type=int, default=10)
    a("--max-updates", type=int, default=0, help="stop after this many updates (0 = no limit)")
    a("--resume", default="", help="checkpoint path (default: <out>/latest.pt if present)")
    a("--compile", action="store_true", help="(unused)")
    a("--no-cuda-graphs", action="store_true", help="eager inference instead of CUDA graphs")
    a("--smoke", action="store_true", help="tiny CPU configuration for a quick end-to-end check")
    args = p.parse_args(argv)
    if args.smoke:
        args.device, args.workers, args.envs = "cpu", 2, 4
        args.rollout, args.minibatch, args.epochs = 256, 128, 1
        args.d_model, args.layers, args.heads, args.critic_d_model, args.critic_layers = 64, 1, 4, 64, 1
        args.tile_dim = 32
        args.snapshot_every, args.ckpt_every = 1, 1
        args.max_updates = args.max_updates or 3
        args.bot_prob = 0.25
    args.workers = max(args.workers, args.collectors)  # every collector needs at least one worker
    if not args.buffer:
        args.buffer = 2 * args.rollout + 4 * args.workers * args.envs
    if args.ent_slot is None:
        args.ent_slot = args.ent
    if args.ent_tile is None:
        args.ent_tile = args.ent
    if not args.learner_device:
        args.learner_device = "cuda:1" if args.device.startswith("cuda") and torch.cuda.device_count() > 1 else args.device
    return args


class Stats:
    def __init__(self):
        self.reset()

    def reset(self):
        self.games = defaultdict(int)
        self.wins = defaultdict(float)
        self.dominant = defaultdict(float)
        self.crowns = defaultdict(float)
        self.lost = defaultdict(float)
        self.ep_ticks = []
        self.decisions = 0
        self.illegal = 0
        self.beh: dict[str, np.ndarray] = {}  # summed done-record behaviour (own, opponent) per opponent kind
        self.beh_n = defaultdict(int)
        self.t0 = time.time()

    def record(self, opp: str, outcome: float, ep_ticks: float, crowns: float = 0, opp_crowns: float = 0,
               beh: np.ndarray | None = None):
        if beh is not None and len(beh):
            self.beh[opp] = self.beh.get(opp, 0) + beh.astype(np.float64)
            self.beh_n[opp] += 1
        self.games[opp] += 1
        self.wins[opp] += 1.0 if outcome > 0 else 0.5 if outcome == 0 else 0.0
        # the owner's bar against the hard bot: at least 2 crowns without losing a tower
        self.dominant[opp] += 1.0 if crowns >= 2 and opp_crowns == 0 else 0.0
        self.crowns[opp] += crowns
        self.lost[opp] += opp_crowns
        self.ep_ticks.append(ep_ticks)

    def summary(self) -> dict:
        dt = max(1e-6, time.time() - self.t0)
        out = {"decisions_per_s": self.decisions / dt, "illegal_actions": self.illegal}
        for k, n in self.games.items():
            out[f"winrate_vs_{k}"] = self.wins[k] / n
            out[f"games_vs_{k}"] = n
            out[f"dominant_vs_{k}"] = self.dominant[k] / n
            out[f"crowns_vs_{k}"] = self.crowns[k] / n
            out[f"crowns_lost_vs_{k}"] = self.lost[k] / n
        if self.ep_ticks:
            out["episode_s"] = float(np.mean(self.ep_ticks)) / 20
        for k, v in self.beh.items():
            out[f"beh_{k}"] = behaviour(v / self.beh_n[k])
            out[f"beh_{k}"]["n"] = self.beh_n[k]
        return out


def behaviour(v: np.ndarray) -> dict:
    """Per-game means of the done-record behaviour block (sim/rl/env.ts BEH_F) for both sides."""
    f = len(v) // 2
    out = {}
    for side, b in (("own", v[:f]), ("opp", v[f:])):
        plays = float(b[:8].sum())
        out[side] = {"cards": [round(float(x), 3) for x in b[:8]], "plays": plays,
                     "enemy_half": float(b[8]) / max(plays, 1e-9), "elixir_at_play": float(b[9]) / max(plays, 1e-9),
                     "full_elixir_s": float(b[10]) / 20, "dmg_dealt": float(b[11]), "dmg_taken": float(b[12])}
    return out


def behaviour_line(rec: dict, names: list[str]) -> str:
    """One log line per opponent kind: plays per game of each card, elixir leaked, placements."""
    parts = []
    for k, v in sorted(rec.items()):
        if not k.startswith("beh_"):
            continue
        o = v["own"]
        cards = " ".join(f"{n[:6]} {c:.1f}" for n, c in zip(names, o["cards"]))
        line = (f"{k[4:]}(n={v['n']}): {cards} | full-elixir {o['full_elixir_s']:.0f}s at-play {o['elixir_at_play']:.1f} "
                f"enemy-half {o['enemy_half']:.2f} dmg {o['dmg_dealt']:.2f}/{o['dmg_taken']:.2f}")
        if k == "beh_bot":
            b = v["opp"]
            line += f" || bot: {b['plays']:.1f} plays, full-elixir {b['full_elixir_s']:.0f}s"
        parts.append(line)
    return "\n    ".join(parts)


def count_illegal(masks: np.ndarray, slot: np.ndarray, tile: np.ndarray, n_tiles: int) -> int:
    """Actions the masks forbid (inference sanity check: should always be 0)."""
    if len(slot) == 0:
        return 0
    bad = (slot < 0) | (slot > 4) | (tile < 0) | (tile >= n_tiles)
    ok = ~bad
    r = np.nonzero(ok)[0]
    s, t = slot[r], tile[r]
    legal = masks[r, s] > 0
    play = s > 0
    legal[play] &= masks[r[play], 5 + (s[play] - 1) * n_tiles + t[play]] > 0
    return int(bad.sum() + (~legal).sum())


def make_autocast(device: torch.device):
    if device.type == "cuda":
        return lambda: torch.autocast("cuda", dtype=torch.bfloat16)
    return lambda: torch.autocast("cpu", enabled=False)


def build_nets(spec: dict, mcfg: ModelConfig, device: torch.device):
    lay = Layout(spec)
    return Actor(lay, mcfg).to(device), Critic(lay, mcfg).to(device)


def ppo_update(actor, critic, opt, data: dict, args, device: torch.device) -> dict:
    """PPO epochs over one rollout (`data`: CPU tensors from the collector). Returns mean logs."""
    autocast = make_autocast(device)
    params = list(actor.parameters()) + list(critic.parameters())
    # the learning rate is set every update: a resumed optimizer otherwise keeps the checkpoint's lr, so
    # --lr changes did not take effect; --target-kl scales it (rl_games-style KL-adaptive rule)
    lr_now = (data["lr"] if args.lr_decay else args.lr) * getattr(args, "lr_scale", 1.0)
    for g in opt.param_groups:
        g["lr"] = lr_now
    d = {k: v.to(device) for k, v in data.items() if isinstance(v, torch.Tensor)}
    obs_all = d["obs"]  # float16
    N = obs_all.shape[0]
    logs = defaultdict(list)
    actor.train()
    critic.train()
    for _ in range(args.epochs):
        perm = torch.randperm(N, device=device)
        for start in range(0, N, args.minibatch):
            mb = perm[start:start + args.minibatch]
            o = obs_all[mb].float()
            with autocast():
                logp, ent_s, ent_t, ent_c, fl_c = actor.evaluate(o, d["slot_mask"][mb], d["tile_mask"][mb], d["slot"][mb], d["tile"][mb],
                                                                 args.card_floor)
                v = critic(o).float()
            ratio = torch.exp(logp - d["logp"][mb])
            a = d["adv"][mb]
            pg = -torch.min(ratio * a, ratio.clamp(1 - args.clip, 1 + args.clip) * a).mean()
            vo = d["value"][mb]
            vc = vo + (v - vo).clamp(-args.vclip, args.vclip)
            r = d["ret"][mb]
            vl = 0.5 * torch.max((v - r) ** 2, (vc - r) ** 2).mean()
            ent = ent_s.mean() + ent_t.mean()
            # separate entropy weights: the slot choice (when / which card) collapsed far faster than the tile
            loss = pg + args.vf * vl - args.ent_slot * ent_s.mean() - args.ent_tile * ent_t.mean() - args.ent_card * ent_c.mean() + args.card_floor_coef * fl_c.mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            gn = torch.nn.utils.clip_grad_norm_(params, args.max_grad)
            if not bool(torch.isfinite(loss) & torch.isfinite(gn)):
                logs["skipped"].append(torch.ones((), device=device))  # one bad batch must not poison the weights
                continue
            logs["skipped"].append(torch.zeros((), device=device))
            opt.step()
            with torch.no_grad():
                plays = (d["slot"][mb] > 0).sum().clamp(min=1)
                logs["loss_pg"].append(pg.detach())
                logs["loss_v"].append(vl.detach())
                logs["entropy_slot"].append(ent_s.mean().detach())
                logs["entropy_tile"].append(ent_t.sum().detach() / plays)
                logs["entropy_card"].append(ent_c.mean().detach())
                logs["card_floor_pen"].append(fl_c.mean().detach())
                logs["ratio_max"].append(ratio.max().detach())
                # log-ratio clamped: a row whose ratio underflows to 0 made the estimate inf
                lr_ = (logp - d["logp"][mb]).clamp(-20, 20)
                logs["approx_kl"].append((torch.exp(lr_) - 1 - lr_).mean().detach())
                tiny = (logp - d["logp"][mb]) < -13.8
                played = d["slot"][mb] > 0
                logs["ratio_tiny_play"].append((tiny & played).float().sum() / played.float().sum().clamp(min=1))
                logs["ratio_tiny_wait"].append((tiny & ~played).float().sum() / (~played).float().sum().clamp(min=1))
                logs["clipfrac"].append(((ratio - 1).abs() > args.clip).float().mean().detach())
                logs["grad_norm"].append(gn.detach())
    actor.eval()
    critic.eval()
    out = {k: float(torch.stack(v).float().mean()) for k, v in logs.items()}
    if args.target_kl > 0 and "approx_kl" in out:
        sc = getattr(args, "lr_scale", 1.0)
        if out["approx_kl"] > 2 * args.target_kl:
            sc /= 1.5
        elif out["approx_kl"] < args.target_kl / 2:
            sc *= 1.5
        args.lr_scale = min(2.0, max(0.05, sc))
    out["lr"] = lr_now
    return out


_SLOT_COLS: dict[int, tuple[np.ndarray, int]] = {}


def slot_need(obs: np.ndarray, spec: dict, rows: np.ndarray | None = None) -> tuple[int, int]:
    """Unit and projectile slots used by any of `rows` of `obs` (slots fill from 0), read on the host from
    the id columns only."""
    key = id(spec)
    if key not in _SLOT_COLS:
        L, S = spec["layout"], spec["sizes"]
        su, sp = S["F_UNIT"] + S["ID_UNIT"], S["F_PROJ"] + S["ID_PROJ"]
        cols = np.array([L["units"] + i * su + S["F_UNIT"] for i in range(S["MAX_UNITS"])]
                        + [L["proj"] + i * sp + S["F_PROJ"] for i in range(S["MAX_PROJ"])])
        _SLOT_COLS[key] = (cols, S["MAX_UNITS"])
    cols, nu_max = _SLOT_COLS[key]
    ids = obs[np.ix_(rows, cols)] if rows is not None else obs[:, cols]
    if ids.shape[0] == 0:
        return 1, 1
    used = np.nonzero((ids > 0).any(0))[0]
    u, p = used[used < nu_max], used[used >= nu_max] - nu_max
    return (int(u[-1]) + 1 if len(u) else 1), (int(p[-1]) + 1 if len(p) else 1)


class GraphedInfer:
    """Inference through CUDA graphs captured at a few batch sizes and entity-slot counts: one replay
    instead of ~1000 kernel launches per call, over only the unit / projectile slots the batch uses
    (chosen on the host by `slot_need`). Rows are padded to the next captured size; padded rows have no
    legal action and are dropped. Weights are updated in place (load_state_dict copies into the
    captured parameters), so the graphs stay valid."""

    UNIT_BUCKETS = (24, 40, 64)
    PROJ_BUCKETS = (8, 16, 32)

    def __init__(self, actor, critic, floats: int, mask_bytes: int, device: torch.device, sizes=(64, 128, 256, 512, 1024, 2048),
                 spec: dict | None = None):
        self.actor, self.critic, self.sizes, self.spec = actor, critic, sizes, spec
        self.graphs = {}
        autocast = make_autocast(device)
        pool = torch.cuda.graph_pool_handle()
        ub = self.UNIT_BUCKETS if spec else (None,)
        pb = self.PROJ_BUCKETS if spec else (None,)
        nets = [m for m in (actor, critic) if m is not None]
        for B in sizes:
            obs = torch.zeros(B, floats, device=device)
            masks = torch.zeros(B, mask_bytes, dtype=torch.uint8, device=device)
            masks[:, 0] = 1
            for nu in ub:
                for npj in pb:
                    trim = {"unit": nu, "proj": npj} if spec else None
                    for m in nets:
                        m.enc.fixed_trim = trim
                    stream = torch.cuda.Stream()
                    stream.wait_stream(torch.cuda.current_stream())
                    with torch.cuda.stream(stream), torch.no_grad(), autocast():
                        for _ in range(2):
                            self._run(obs, masks)
                    torch.cuda.current_stream().wait_stream(stream)
                    g = torch.cuda.CUDAGraph()
                    with torch.cuda.graph(g, pool=pool), torch.no_grad(), autocast():
                        out = self._run(obs, masks)
                    self.graphs[(B, nu, npj)] = (g, obs, masks, out)
        for m in nets:
            m.enc.fixed_trim = None

    def _run(self, obs, masks):
        a = self.actor.act_packed(obs, masks)
        if self.critic is None:
            return a
        return torch.cat([a, self.critic(obs).float().unsqueeze(1)], 1)

    def __call__(self, obs: torch.Tensor, masks: torch.Tensor, obs_np: np.ndarray | None = None,
                 rows: np.ndarray | None = None) -> torch.Tensor:
        """`obs_np` / `rows`: the frame's host observations and the rows in `obs` (for the slot counts)."""
        n = obs.shape[0]
        B = next((b for b in self.sizes if b >= n), None)
        if B is None:  # larger than every capture: split
            half = n // 2
            hr = None if rows is None else rows[:half]
            tr = None if rows is None else rows[half:]
            return torch.cat([self(obs[:half], masks[:half], obs_np, hr), self(obs[half:], masks[half:], obs_np, tr)])
        nu = npj = None
        if self.spec is not None:
            need_u, need_p = slot_need(obs_np, self.spec, rows) if obs_np is not None else (64, 32)
            nu = next(b for b in self.UNIT_BUCKETS if b >= min(need_u, self.UNIT_BUCKETS[-1]))
            npj = next(b for b in self.PROJ_BUCKETS if b >= min(need_p, self.PROJ_BUCKETS[-1]))
        g, so, sm, out = self.graphs[(B, nu, npj)]
        so[:n].copy_(obs)
        sm[:n].copy_(masks)
        if n < B:
            so[n:].zero_()
            sm[n:].zero_()
            sm[n:, 0] = 1
        g.replay()
        # a copy: `out` is the graph's static buffer, and the split path above replays the same graph for
        # its second half (returning the view let the second half overwrite the first's actions)
        return out[:n].clone()


class OppSlots:
    """League opponents in a fixed set of model slots whose CUDA graphs (trimmed, like the learner's) are
    captured once. A new opponent's weights are copied into a free slot in place, so its graphs stay valid;
    a slot is free when neither the new picks nor a running episode use its snapshot. Rebuilding graphs per
    opponent cost 36 captures each, and untrimmed graphs made an opponent row ~1.7x a learner row."""

    def __init__(self, template, n: int, floats: int, mask_bytes: int, device: torch.device, spec: dict, use_graphs: bool):
        self.models, self.graphs, self.sid = [], [], [None] * n
        for _ in range(n):
            m = copy.deepcopy(template).to(device).eval()
            m.enc.trim_tokens = False
            for p_ in m.parameters():
                p_.requires_grad_(False)
            self.models.append(m)
            self.graphs.append(GraphedInfer(m, None, floats, mask_bytes, device, sizes=(64, 128, 256, 512), spec=spec)
                               if use_graphs else None)

    def load(self, picks, referenced: set) -> list:
        """Put `picks` (league snapshots) into slots; returns league.active [(snapshot, model)]."""
        keep = {s.sid for s in picks} | referenced
        active = []
        for s in picks:
            if s.sid in self.sid:
                i = self.sid.index(s.sid)
            else:
                free = [i for i, x in enumerate(self.sid) if x is None or x not in keep]
                if not free:
                    continue  # every slot is busy with running games: fewer opponents this round
                i = free[0]
                if s.state is None:
                    s.state = torch.load(s.path, map_location="cpu")["actor"]
                self.models[i].load_state_dict(s.state)
                self.sid[i] = s.sid
            active.append((s, self.models[i]))
        return active

    def get(self, sid: int):
        if sid not in self.sid:
            return None, None
        i = self.sid.index(sid)
        return self.models[i], self.graphs[i]


def cpu_state(m: torch.nn.Module) -> dict:
    return {k: v.detach().to("cpu", copy=True) for k, v in m.state_dict().items()}


def learner_main(args, spec: dict, mcfg: ModelConfig, resume: str, in_q, out_q) -> None:
    """Learner process: owns the trained networks and the optimizer, so the PPO update runs while the
    collector keeps simulating with the previous weights (PPO's ratio uses the behaviour log-probs)."""
    device = torch.device(args.device)
    torch.set_num_threads(2)
    actor, critic = build_nets(spec, mcfg, device)
    opt = torch.optim.Adam(list(actor.parameters()) + list(critic.parameters()), lr=args.lr, eps=1e-5)
    if resume:
        ck = torch.load(resume, map_location=device)
        actor.load_state_dict(ck["actor"])
        critic.load_state_dict(ck["critic"])
        opt.load_state_dict(ck["opt"])
    actor.eval()
    critic.eval()
    out_q.put(("init", cpu_state(actor), cpu_state(critic)))
    while True:
        msg = in_q.get()
        if msg[0] == "stop":
            return
        if msg[0] == "update":
            t0 = time.time()
            logs = ppo_update(actor, critic, opt, msg[1], args, device)
            logs["update_s"] = time.time() - t0
            out_q.put(("updated", logs, cpu_state(actor), cpu_state(critic)))
        elif msg[0] == "ckpt":
            path, extra = msg[1], msg[2]
            tmp = Path(str(path) + ".tmp")
            torch.save({"actor": actor.state_dict(), "critic": critic.state_dict(), "opt": opt.state_dict(), **extra}, tmp)
            os.replace(tmp, path)


def main(argv=None):
    args = parse(argv)
    if args.collectors > 1:
        from .dist import main as dist_main
        return dist_main(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device(args.device)
    if device.type == "cpu":
        torch.set_num_threads(max(1, min(4, available_cpus() // 2)))
    else:
        torch.set_num_threads(2)  # leave the cores to the simulation workers
    rng = random.Random(args.seed)

    env_cfg = {"decisionTicks": args.decision_ticks, "gamma": args.gamma, "botProb": args.bot_prob, "botLevel": args.bot_level,
               "randomProb": args.random_prob, "deckSwap": not args.no_deck_swap, "mirror": args.mirror, "crownCoef": args.crown_coef}
    pool = EnvPool(args.workers, args.envs, args.seed, env_cfg)
    spec = pool.spec
    (out / "spec.json").write_text(json.dumps(spec))
    mcfg = ModelConfig(args.d_model, args.layers, args.heads, 2, args.tile_dim, 4, args.critic_d_model, args.critic_layers)
    # the collector's copies (behaviour policy); the learner process owns the trained ones
    actor, critic = build_nets(spec, mcfg, device)
    actor.eval()
    critic.eval()
    # inference keeps fixed shapes: trimming reads the batch's slot counts back from the GPU (a host sync
    # per block, per network, per frame); the learner trims (training is where the compute is)
    actor.enc.trim_tokens = False
    critic.enc.trim_tokens = False
    for p_ in list(actor.parameters()) + list(critic.parameters()):
        p_.requires_grad_(False)
    league = League(out, args.league_size, args.active_opponents, args.pfsp_power, rng)
    n_tiles = spec["sizes"]["N_TILES"]
    buf = Rollout(args.buffer, pool.floats, n_tiles)
    print(f"actor {param_count(actor) / 1e6:.2f} M params, critic {param_count(critic) / 1e6:.2f} M; "
          f"{args.workers} workers x {args.envs} envs on {device}", flush=True)

    update = 0
    total_decisions = 0
    resume = args.resume or (str(out / "latest.pt") if (out / "latest.pt").exists() else "")
    if resume:
        ck = torch.load(resume, map_location="cpu")
        league.load_state(ck["league"])
        update, total_decisions = ck["update"], ck["total_decisions"]
        print(f"resumed {resume} at update {update}, {total_decisions:.3g} decisions", flush=True)
        del ck
    mp = torch.multiprocessing.get_context("spawn")
    to_learner, from_learner = mp.Queue(), mp.Queue()
    learner = mp.Process(target=learner_main, args=(args, spec, mcfg, resume, to_learner, from_learner), daemon=True)
    learner.start()
    _, a_state, c_state = from_learner.get()
    actor.load_state_dict(a_state)
    critic.load_state_dict(c_state)
    run_actor, run_critic = actor, critic
    autocast = make_autocast(device)
    use_graphs = device.type == "cuda" and not args.no_cuda_graphs
    infer = GraphedInfer(actor, critic, pool.floats, pool.mask_bytes, device, spec=spec) if use_graphs else None
    opp_slots = OppSlots(actor, args.opp_slots, pool.floats, pool.mask_bytes, device, spec, use_graphs)
    league.active = opp_slots.load(league.pick(args.import_share), set())
    stream_last: dict[tuple[int, int], int | None] = {}
    ep_nets: dict[tuple[int, int], list] = {}
    stats = Stats()
    beh_win, beh_win_n = {}, defaultdict(int)
    metrics_f = open(out / "metrics.jsonl", "a")

    def shape_coef() -> float:
        return max(args.shape_floor, args.shape_coef * max(0.0, 1.0 - total_decisions / max(1.0, args.shape_anneal)))

    def assign(opp_code: int, team: int) -> list:
        if opp_code != 0:
            # the scripted bot is a benchmark only: the learner plays it ("E") but nothing is trained on it
            nets = [None, None]
            nets[team] = "E"
            nets[1 - team] = OPP_NAMES[opp_code]
            return nets
        if not league.active or rng.random() < args.self_play_prob:
            return ["L", "L"]
        lt = rng.randrange(2)
        nets = [None, None]
        nets[lt] = "L"
        nets[1 - lt] = league.active[league.sample()][0].sid
        return nets

    def process(frame) -> np.ndarray:
        nonlocal total_decisions
        c = shape_coef()
        # episode ends
        ended = set()
        for row in frame.dones:
            gid, team, ep = int(row[0]), int(row[1]), int(row[2])
            outcome, term, shape, ticks, ep_ticks = float(row[3]), float(row[4]), float(row[5]), float(row[6]), float(row[7])
            crowns, opp_crowns = (float(row[8]), float(row[9])) if len(row) > 9 else (0.0, 0.0)
            beh = row[11:]
            nets = ep_nets.get((gid, ep))
            if nets is None or nets[team] not in ("L", "E"):
                continue
            li = stream_last.get((gid, team))
            if li is not None and nets[team] == "L":
                buf.finish(li, term + c * shape, ticks, True, 0.0)
                stream_last[(gid, team)] = None
            opp = nets[1 - team]
            name = "self" if opp == "L" else opp if isinstance(opp, str) else "league"
            stats.record(name, outcome, ep_ticks, crowns, opp_crowns, beh)
            if isinstance(opp, int):
                league.record(opp, outcome)
            ended.add((gid, ep))
        for k in ended:
            ep_nets.pop(k, None)

        tp0 = time.time()
        meta = frame.meta
        n = len(meta)
        gids = meta[:, 0].astype(np.int64)
        teams = meta[:, 1].astype(np.int64)
        eps = meta[:, 2].astype(np.int64)
        nets_r = []
        for r in range(n):
            k = (int(gids[r]), int(eps[r]))
            if k not in ep_nets:
                ep_nets[k] = assign(int(meta[r, 7]), int(teams[r]))
            nets_r.append(ep_nets[k][int(teams[r])])
        slot = np.zeros(n, np.int64)
        tile = np.zeros(n, np.int64)
        tp1 = time.time()
        timing["p_bookkeep_s"] += tp1 - tp0
        obs_t = torch.from_numpy(frame.obs).to(device)
        masks_t = torch.from_numpy(frame.masks).to(device)
        learn = np.array([v in ("L", "E") for v in nets_r], dtype=bool)
        with torch.no_grad(), autocast():
            if learn.any():
                li_rows = np.nonzero(learn)[0]
                lt = torch.from_numpy(li_rows).to(device)
                packed = infer(obs_t[lt], masks_t[lt], frame.obs, li_rows) if infer is not None else \
                    torch.cat([run_actor.act_packed(obs_t[lt], masks_t[lt]), run_critic(obs_t[lt]).float().unsqueeze(1)], 1)
                packed = packed.cpu().numpy()  # the one host sync for the learner's rows
                s_np, t_np = packed[:, 0].astype(np.int64), packed[:, 1].astype(np.int64)
                lp_np, v_np = packed[:, 2].astype(np.float32), packed[:, 3].astype(np.float32)
                tp2 = time.time()
                timing["p_infer_s"] += tp2 - tp1
                slot[li_rows], tile[li_rows] = s_np, t_np
                stats.illegal += count_illegal(frame.masks[li_rows], s_np, t_np, n_tiles)
                keep = np.array([nets_r[r] == "L" for r in li_rows], dtype=bool)  # benchmark games are not stored
                li_rows, s_np, t_np, lp_np, v_np = li_rows[keep], s_np[keep], t_np[keep], lp_np[keep], v_np[keep]
                # the chosen card's tile mask, gathered on the host (zeros for a wait)
                start = 5 + np.clip(s_np - 1, 0, 3) * n_tiles
                tm = frame.masks[li_rows[:, None], start[:, None] + np.arange(n_tiles)[None, :]] * (s_np > 0)[:, None]
                idx = buf.add(frame.obs[li_rows].astype(np.float16), frame.masks[li_rows, :5], tm, s_np, t_np, lp_np, v_np)
                for k, r in enumerate(li_rows):
                    key = (int(gids[r]), int(teams[r]))
                    prev = stream_last.get(key)
                    if prev is not None and meta[r, 3] == 0:
                        buf.finish(prev, float(meta[r, 4]) + c * float(meta[r, 5]), float(meta[r, 6]), False, float(v_np[k]), int(idx[k]))
                    stream_last[key] = int(idx[k])
                timing["p_store_s"] += time.time() - tp2
                stats.decisions += len(li_rows)
                total_decisions += len(li_rows)
            tp3 = time.time()
            for sid in {v for v in nets_r if isinstance(v, int)}:
                rows = np.nonzero(np.array([v == sid for v in nets_r]))[0]
                m, gi_ = opp_slots.get(sid)
                if m is None:
                    continue  # snapshot dropped while its episode ran: it waits (slot 0)
                rt = torch.from_numpy(rows).to(device)
                pk = (gi_(obs_t[rt], masks_t[rt], frame.obs, rows) if gi_ is not None
                      else m.act_packed(obs_t[rt], masks_t[rt])).cpu().numpy()
                slot[rows], tile[rows] = pk[:, 0].astype(np.int64), pk[:, 1].astype(np.int64)
            timing["p_opp_s"] += time.time() - tp3
        return np.stack([gids, teams, slot, tile], 1).astype(np.int32)

    def snapshot() -> dict:
        """Hand the complete transitions to the learner and free them from the buffer."""
        idx, adv, ret = buf.advantages(args.gamma, args.lam)
        adv_n = (adv - adv.mean()) / (adv.std() + 1e-8)
        t = lambda a: torch.from_numpy(np.ascontiguousarray(a))  # noqa: E731
        data = {"obs": t(buf.obs[idx]), "slot_mask": t(buf.slot_mask[idx]), "tile_mask": t(buf.tile_mask[idx]),
                "slot": t(buf.slot[idx]), "tile": t(buf.tile[idx]), "logp": t(buf.logp[idx]), "value": t(buf.value[idx]),
                "adv": t(adv_n.astype(np.float32)), "ret": t(ret.astype(np.float32)),
                "lr": args.lr * max(0.0, 1.0 - total_decisions / args.total_decisions)}
        var = float(np.var(ret))
        info = {"transitions": len(idx), "explained_var": 1.0 - float(np.var(ret - buf.value[idx])) / var if var > 0 else 0.0,
                "play_rate": float((buf.slot[idx] > 0).mean()), "t_submit": time.time()}
        buf.compact(stream_last)
        return {"data": data, "info": info}

    def finish_update(p: dict, ulogs: dict) -> bool:
        if update % args.snapshot_every == 0:
            league.add(actor, update)
        if args.import_dir:
            n_imp = league.import_dir(Path(args.import_dir), args.import_keep)
            if n_imp:
                print(f"  imported {n_imp} snapshot(s) from {args.import_dir}; league {len(league.pool)}", flush=True)
                league.active = []  # rotate now so the new snapshots play
        if update % args.opp_every == 0 or not league.active:
            referenced = {v for nets in ep_nets.values() for v in nets if isinstance(v, int)}
            league.active = opp_slots.load(league.pick(args.import_share), referenced)
        info = p["info"]
        rec = {"update": update, "decisions": total_decisions, "transitions": info["transitions"], "shape_coef": shape_coef(),
               "explained_var": info["explained_var"], "play_rate": info["play_rate"], "league": len(league.pool),
               "opp_models": sum(x is not None for x in opp_slots.sid),
               "update_wall_s": time.time() - info["t_submit"], **ulogs, **stats.summary(), **{f"t_{k}": v for k, v in timing.items()}}
        metrics_f.write(json.dumps(rec) + "\n")
        metrics_f.flush()
        wr = " ".join(f"{k[11:]}={v:.2f}" for k, v in rec.items() if k.startswith("winrate_vs_"))
        if "dominant_vs_bot" in rec:
            wr += (f" [bot: 2+crowns&0 lost {rec['dominant_vs_bot']:.2f}, crowns {rec['crowns_vs_bot']:.2f}"
                   f"/{rec['crowns_lost_vs_bot']:.2f}, n={rec['games_vs_bot']}]")
        print(f"upd {update} dec {total_decisions:.3g} {rec['decisions_per_s']:.0f}/s ev {rec['explained_var']:.2f} "
              f"kl {rec.get('approx_kl', 0):.4f} ent {rec.get('entropy_slot', 0):.2f}/{rec.get('entropy_tile', 0):.2f} "
              f"card {rec.get('entropy_card', 0):.2f}/floor {rec.get('card_floor_pen', 0):.3f} "
              f"play {rec['play_rate']:.2f} ep {rec.get('episode_s', 0):.0f}s {wr} | wait {timing['wait_s']:.1f}s "
              f"proc {timing['process_s']:.1f}s (book {timing['p_bookkeep_s']:.1f} infer {timing['p_infer_s']:.1f} "
              f"store {timing['p_store_s']:.1f} opp {timing['p_opp_s']:.1f}) upd {rec.get('update_s', 0):.1f}s rec/frame "
              f"{timing['records'] / max(1, timing['frames']):.0f}", flush=True)
        if rec.get("illegal_actions"):
            print(f"  WARNING {rec['illegal_actions']} illegal actions sampled this update", flush=True)
        for k, v in stats.beh.items():  # behaviour over the last 10 updates, printed then
            beh_win[k] = beh_win.get(k, 0) + v
            beh_win_n[k] += stats.beh_n[k]
        if update % 10 == 0 and beh_win:
            print("  behaviour " + behaviour_line({f"beh_{k}": {**behaviour(v / beh_win_n[k]), "n": beh_win_n[k]}
                                                  for k, v in beh_win.items()}, spec["env"]["decks"][0]), flush=True)
            beh_win.clear()
            beh_win_n.clear()
        stats.reset()
        timing.clear()
        if update % args.ckpt_every == 0:
            extra = {"league": league.state(), "update": update, "total_decisions": total_decisions, "args": vars(args),
                     "model": mcfg.__dict__}
            to_learner.put(("ckpt", str(out / "latest.pt"), extra))
            torch.save({"actor": actor.state_dict(), "model": mcfg.__dict__, "update": update}, out / f"actor_{update:06d}.pt")
        return bool((args.max_updates and update >= args.max_updates) or total_decisions >= args.total_decisions)

    pending = None
    timing = defaultdict(float)
    groups = [list(pool.group(g, args.groups)) for g in range(args.groups)]
    groups = [g for g in groups if g]
    for ws in groups:
        pool.send_many(ws, None)
    gi = 0
    while True:
        # one group's frame is handled while the other groups simulate
        ws = groups[gi]
        t0 = time.time()
        fr = pool.recv_many(ws)
        t1 = time.time()
        acts = process(fr)
        t2 = time.time()
        pool.send_many(ws, acts)
        timing["wait_s"] += t1 - t0
        timing["process_s"] += t2 - t1
        timing["frames"] += 1
        timing["records"] += len(fr.meta)
        gi = (gi + 1) % len(groups)
        if pending is not None:
            # wait for the learner only when the buffer could overflow before the next frame
            full = buf.n + 2 * args.workers * args.envs > buf.cap
            try:
                msg = from_learner.get() if full else from_learner.get_nowait()
            except queue.Empty:
                msg = None
            if msg is not None:
                _, ulogs, a_state, c_state = msg
                actor.load_state_dict(a_state)
                critic.load_state_dict(c_state)
                update += 1
                if finish_update(pending, ulogs):
                    break
                pending = None
        if pending is None and buf.n_complete >= args.rollout:
            pending = snapshot()
            to_learner.put(("update", pending["data"]))
    to_learner.put(("stop",))
    learner.join(timeout=60)
    pool.close()
    metrics_f.close()


if __name__ == "__main__":
    main()
