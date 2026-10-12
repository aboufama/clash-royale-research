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
import json
import math
import os
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
    a("--workers", type=int, default=max(1, available_cpus() - 1))
    a("--groups", type=int, default=2, help="worker groups stepped alternately (overlaps simulation and inference)")
    a("--envs", type=int, default=24, help="battles per worker")
    # env
    a("--decision-ticks", type=int, default=5, help="decision grid in 50 ms ticks")
    a("--gamma", type=float, default=0.9997, help="discount per tick (0.9997: ~167 s horizon)")
    a("--lam", type=float, default=0.95, help="GAE lambda per decision")
    a("--bot-prob", type=float, default=0.05, help="share of episodes against the scripted bot")
    a("--bot-level", type=int, default=3)
    a("--random-prob", type=float, default=0.0)
    a("--no-deck-swap", action="store_true", help="learner keeps deck 0 / team order fixed")
    a("--self-play-prob", type=float, default=0.5, help="py-vs-py episodes where both sides are the learner")
    # reward
    a("--shape-coef", type=float, default=0.5, help="crown-tower damage reward weight at the start")
    a("--shape-anneal", type=float, default=2e8, help="decisions over which the shaping weight decays to 0")
    # ppo
    a("--rollout", type=int, default=65536, help="complete transitions per update")
    a("--buffer", type=int, default=0, help="rollout buffer capacity (default 2x rollout)")
    a("--minibatch", type=int, default=4096)
    a("--epochs", type=int, default=2)
    a("--lr", type=float, default=3e-4)
    a("--lr-decay", action="store_true", help="linear decay to 0 over --total-decisions")
    a("--clip", type=float, default=0.2)
    a("--vclip", type=float, default=0.5)
    a("--vf", type=float, default=0.5)
    a("--ent", type=float, default=0.01)
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
    a("--ckpt-every", type=int, default=10)
    a("--max-updates", type=int, default=0, help="stop after this many updates (0 = no limit)")
    a("--resume", default="", help="checkpoint path (default: <out>/latest.pt if present)")
    a("--compile", action="store_true", help="torch.compile the networks")
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
    if not args.buffer:
        args.buffer = 2 * args.rollout + 4 * args.workers * args.envs
    return args


class Stats:
    def __init__(self):
        self.reset()

    def reset(self):
        self.games = defaultdict(int)
        self.wins = defaultdict(float)
        self.ep_ticks = []
        self.decisions = 0
        self.t0 = time.time()

    def record(self, opp: str, outcome: float, ep_ticks: float):
        self.games[opp] += 1
        self.wins[opp] += 1.0 if outcome > 0 else 0.5 if outcome == 0 else 0.0
        self.ep_ticks.append(ep_ticks)

    def summary(self) -> dict:
        dt = max(1e-6, time.time() - self.t0)
        out = {"decisions_per_s": self.decisions / dt}
        for k, n in self.games.items():
            out[f"winrate_vs_{k}"] = self.wins[k] / n
            out[f"games_vs_{k}"] = n
        if self.ep_ticks:
            out["episode_s"] = float(np.mean(self.ep_ticks)) / 20
        return out


def main(argv=None):
    args = parse(argv)
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
               "randomProb": args.random_prob, "deckSwap": not args.no_deck_swap}
    pool = EnvPool(args.workers, args.envs, args.seed, env_cfg)
    spec = pool.spec
    (out / "spec.json").write_text(json.dumps(spec))
    lay = Layout(spec)
    mcfg = ModelConfig(args.d_model, args.layers, args.heads, 2, args.tile_dim, 4, args.critic_d_model, args.critic_layers)
    actor = Actor(lay, mcfg).to(device)
    critic = Critic(lay, mcfg).to(device)
    params = list(actor.parameters()) + list(critic.parameters())
    opt = torch.optim.Adam(params, lr=args.lr, eps=1e-5)
    league = League(out, args.league_size, args.active_opponents, args.pfsp_power, rng)
    n_tiles = spec["sizes"]["N_TILES"]
    buf = Rollout(args.buffer, pool.floats, n_tiles)
    print(f"actor {param_count(actor) / 1e6:.2f} M params, critic {param_count(critic) / 1e6:.2f} M; "
          f"{args.workers} workers x {args.envs} envs on {device}", flush=True)

    update = 0
    total_decisions = 0
    resume = args.resume or (str(out / "latest.pt") if (out / "latest.pt").exists() else "")
    if resume:
        ck = torch.load(resume, map_location=device)
        actor.load_state_dict(ck["actor"])
        critic.load_state_dict(ck["critic"])
        opt.load_state_dict(ck["opt"])
        league.load_state(ck["league"])
        update, total_decisions = ck["update"], ck["total_decisions"]
        print(f"resumed {resume} at update {update}, {total_decisions:.3g} decisions", flush=True)
    run_actor, run_critic = actor, critic
    if args.compile:
        run_actor = torch.compile(actor)
        run_critic = torch.compile(critic)
    amp = device.type == "cuda"
    autocast = (lambda: torch.autocast("cuda", dtype=torch.bfloat16)) if amp else (lambda: torch.autocast("cpu", enabled=False))

    league.resample(actor, device)
    models: dict[int, torch.nn.Module] = {s.sid: m for s, m in league.active}
    stream_last: dict[tuple[int, int], int | None] = {}
    ep_nets: dict[tuple[int, int], list] = {}
    stats = Stats()
    metrics_f = open(out / "metrics.jsonl", "a")

    def shape_coef() -> float:
        return args.shape_coef * max(0.0, 1.0 - total_decisions / max(1.0, args.shape_anneal))

    def assign(opp_code: int, team: int) -> list:
        if opp_code != 0:
            nets = [None, None]
            nets[team] = "L"
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
            nets = ep_nets.get((gid, ep))
            if nets is None or nets[team] != "L":
                continue
            li = stream_last.get((gid, team))
            if li is not None:
                buf.finish(li, term + c * shape, ticks, True, 0.0)
                stream_last[(gid, team)] = None
            opp = nets[1 - team]
            name = "self" if opp == "L" else opp if isinstance(opp, str) else "league"
            stats.record(name, outcome, ep_ticks)
            if isinstance(opp, int):
                league.record(opp, outcome)
            ended.add((gid, ep))
        for k in ended:
            ep_nets.pop(k, None)

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
        obs_t = torch.from_numpy(frame.obs).to(device)
        masks_t = torch.from_numpy(frame.masks).to(device)
        learn = np.array([v == "L" for v in nets_r], dtype=bool)
        with torch.no_grad(), autocast():
            if learn.any():
                li_rows = np.nonzero(learn)[0]
                lt = torch.from_numpy(li_rows).to(device)
                s, t, lp = run_actor.act(obs_t[lt], masks_t[lt])
                v = run_critic(obs_t[lt]).float()
                s_np, t_np = s.cpu().numpy(), t.cpu().numpy()
                lp_np, v_np = lp.float().cpu().numpy(), v.cpu().numpy()
                slot[li_rows], tile[li_rows] = s_np, t_np
                tm = run_actor.chosen_tile_mask(masks_t[lt], s).cpu().numpy() * (s_np > 0)[:, None]
                idx = buf.add(frame.obs[li_rows].astype(np.float16), frame.masks[li_rows, :5], tm, s_np, t_np, lp_np, v_np)
                for k, r in enumerate(li_rows):
                    key = (int(gids[r]), int(teams[r]))
                    prev = stream_last.get(key)
                    if prev is not None and meta[r, 3] == 0:
                        buf.finish(prev, float(meta[r, 4]) + c * float(meta[r, 5]), float(meta[r, 6]), False, float(v_np[k]), int(idx[k]))
                    stream_last[key] = int(idx[k])
                stats.decisions += len(li_rows)
                total_decisions += len(li_rows)
            for sid in {v for v in nets_r if isinstance(v, int)}:
                rows = np.nonzero(np.array([v == sid for v in nets_r]))[0]
                m = models.get(sid)
                if m is None:
                    continue  # snapshot dropped while its episode ran: it waits (slot 0)
                rt = torch.from_numpy(rows).to(device)
                s, t, _ = m.act(obs_t[rt], masks_t[rt])
                slot[rows], tile[rows] = s.cpu().numpy(), t.cpu().numpy()
        return np.stack([gids, teams, slot, tile], 1).astype(np.int32)

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
        if buf.n_complete < args.rollout:
            continue

        # ---------------------------------------------------------------- PPO update
        t_up = time.time()
        if args.lr_decay:
            for g in opt.param_groups:
                g["lr"] = args.lr * max(0.0, 1.0 - total_decisions / args.total_decisions)
        idx, adv, ret = buf.advantages(args.gamma, args.lam)
        N = len(idx)
        adv_n = (adv - adv.mean()) / (adv.std() + 1e-8)
        dev = lambda a, dt=None: torch.from_numpy(np.ascontiguousarray(a)).to(device, dtype=dt)  # noqa: E731
        obs_all = torch.from_numpy(buf.obs[idx]).to(device)  # float16, the whole rollout on the device
        sm_all, tm_all = dev(buf.slot_mask[idx]), dev(buf.tile_mask[idx])
        slot_all, tile_all = dev(buf.slot[idx]), dev(buf.tile[idx])
        logp_old, v_old = dev(buf.logp[idx]), dev(buf.value[idx])
        adv_t, ret_t = dev(adv_n), dev(ret)
        logs = defaultdict(list)
        actor.train()
        critic.train()
        for _ in range(args.epochs):
            perm = torch.randperm(N)
            for start in range(0, N, args.minibatch):
                mb = perm[start:start + args.minibatch]
                mbd = mb.to(device)
                o = obs_all[mbd].float()
                with autocast():
                    logp, ent_s, ent_t = run_actor.evaluate(o, sm_all[mbd], tm_all[mbd], slot_all[mbd], tile_all[mbd])
                    v = run_critic(o).float()
                ratio = torch.exp(logp - logp_old[mbd])
                a = adv_t[mbd]
                pg = -torch.min(ratio * a, ratio.clamp(1 - args.clip, 1 + args.clip) * a).mean()
                vo = v_old[mbd]
                vc = vo + (v - vo).clamp(-args.vclip, args.vclip)
                r = ret_t[mbd]
                vl = 0.5 * torch.max((v - r) ** 2, (vc - r) ** 2).mean()
                ent = ent_s.mean() + ent_t.mean()
                loss = pg + args.vf * vl - args.ent * ent
                opt.zero_grad(set_to_none=True)
                loss.backward()
                gn = torch.nn.utils.clip_grad_norm_(params, args.max_grad)
                opt.step()
                with torch.no_grad():
                    logs["loss_pg"].append(pg.item())
                    logs["loss_v"].append(vl.item())
                    logs["entropy_slot"].append(ent_s.mean().item())
                    logs["entropy_tile"].append(ent_t.sum().item() / max(1, int((slot_all[mbd] > 0).sum())))
                    logs["approx_kl"].append(((ratio - 1) - torch.log(ratio)).mean().item())
                    logs["clipfrac"].append(((ratio - 1).abs() > args.clip).float().mean().item())
                    logs["grad_norm"].append(float(gn))
        actor.eval()
        critic.eval()
        var = float(np.var(ret))
        ev = 1.0 - float(np.var(ret - buf.value[idx])) / var if var > 0 else 0.0
        play_rate = float((buf.slot[idx] > 0).mean())
        buf.compact(stream_last)
        update += 1

        if update % args.snapshot_every == 0:
            league.add(actor, update)
        league.resample(actor, device)
        referenced = {v for nets in ep_nets.values() for v in nets if isinstance(v, int)}
        new_models = {s.sid: m for s, m in league.active}
        for sid in referenced:
            if sid not in new_models and sid in models:
                new_models[sid] = models[sid]
        models = new_models

        rec = {"update": update, "decisions": total_decisions, "transitions": N, "shape_coef": shape_coef(), "explained_var": ev,
               "play_rate": play_rate, "update_s": time.time() - t_up, "league": len(league.pool),
               **{k: float(np.mean(v)) for k, v in logs.items()}, **stats.summary(), **{f"t_{k}": v for k, v in timing.items()}}
        metrics_f.write(json.dumps(rec) + "\n")
        metrics_f.flush()
        wr = " ".join(f"{k[11:]}={v:.2f}" for k, v in rec.items() if k.startswith("winrate_vs_"))
        print(f"upd {update} dec {total_decisions:.3g} {rec['decisions_per_s']:.0f}/s ev {ev:.2f} kl {rec.get('approx_kl', 0):.4f} "
              f"ent {rec.get('entropy_slot', 0):.2f}/{rec.get('entropy_tile', 0):.2f} play {play_rate:.2f} "
              f"ep {rec.get('episode_s', 0):.0f}s {wr} | wait {timing['wait_s']:.1f}s proc {timing['process_s']:.1f}s "
              f"upd {rec['update_s']:.1f}s rec/frame {timing['records'] / max(1, timing['frames']):.0f}", flush=True)
        stats.reset()
        timing.clear()

        if update % args.ckpt_every == 0:
            ck = {"actor": actor.state_dict(), "critic": critic.state_dict(), "opt": opt.state_dict(), "league": league.state(),
                  "update": update, "total_decisions": total_decisions, "args": vars(args), "model": mcfg.__dict__}
            tmp = out / "latest.pt.tmp"
            torch.save(ck, tmp)
            os.replace(tmp, out / "latest.pt")
            torch.save({"actor": actor.state_dict(), "model": mcfg.__dict__, "update": update}, out / f"actor_{update:06d}.pt")
        if (args.max_updates and update >= args.max_updates) or total_decisions >= args.total_decisions:
            break
    pool.close()
    metrics_f.close()


if __name__ == "__main__":
    main()
