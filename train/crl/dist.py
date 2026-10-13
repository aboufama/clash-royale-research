"""Several collector processes feeding one learner (`--collectors K`, K > 1).

One Python collector tops out well below what the simulation workers of a large pod can produce
(inference, bookkeeping and pipe parsing run in a single interpreter), so K collectors each own a
share of the workers, their own inference copies (CUDA graphs) and rollout buffer, and stream
rollouts to the learner process. The coordinator (this process) owns the league, the logs and the
checkpoints.

    collector k --rollouts--> learner --weights--> every collector
              \\--stats-------> coordinator <--update logs + weights-- learner
    coordinator --opponent set / stop--> collectors;  --ckpt / stop--> learner
"""
from __future__ import annotations

import json
import os
import queue
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from .envpool import EnvPool
from .league import League
from .model import ModelConfig, param_count
from .rollout import Rollout
from .train import OPP_NAMES, GraphedInfer, Stats, behaviour, behaviour_line, build_nets, count_illegal, load_actor, wait_ticks, cpu_state, make_autocast, ppo_update

MAX_OUTSTANDING = 2  # rollouts a collector may have in flight before it waits for new weights


def _drain(q):
    """All messages currently in `q`."""
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except queue.Empty:
            return out
        except (FileNotFoundError, ConnectionError, EOFError):
            return out  # the sender (and its shared-memory tensors) is gone: shutting down


def rollout_for_learner_values(buf: Rollout, t, lr: float):
    """The complete transitions plus the observations their bootstraps need (a successor may still be
    pending), for the learner to evaluate V and run GAE."""
    n = buf.n
    comp = np.nonzero(buf.complete[:n])[0]
    nxt = buf.next[comp]
    boot = (nxt >= 0) & ~buf.done[comp]
    need = np.unique(np.concatenate([comp, nxt[boot]]))
    pos = np.full(n, -1, np.int64)
    pos[need] = np.arange(len(need))
    tpos = np.full(n, -1, np.int64)
    tpos[comp] = np.arange(len(comp))
    safe = np.maximum(nxt, 0)
    data = {"obs_u": t(buf.obs[need]), "self_u": t(pos[comp]), "next_u": t(np.where(boot, pos[safe], -1)),
            "next_t": t(np.where(boot, tpos[safe], -1)), "reward": t(buf.reward[comp]), "dt": t(buf.dt[comp]),
            "slot_mask": t(buf.slot_mask[comp]), "tile_mask": t(buf.tile_mask[comp]), "slot": t(buf.slot[comp]),
            "tile": t(buf.tile[comp]), "logp": t(buf.logp[comp]), "lr": lr}
    return data, {"transitions": len(comp), "play_rate": float((buf.slot[comp] > 0).mean())}


@torch.no_grad()
def values_and_gae(critic, data: dict, gamma: float, lam: float, device: torch.device) -> tuple[dict, float]:
    """Learner side of --learner-values: V over the rollout's observations, then GAE along each stream
    (A_i = d_i + gamma^dt_i * lam * A_next while the successor is in this rollout)."""
    autocast = make_autocast(device)
    obs_u = data["obs_u"]
    v_u = np.empty(len(obs_u), np.float32)
    for a in range(0, len(obs_u), 8192):
        with autocast():
            v_u[a:a + 8192] = critic(obs_u[a:a + 8192].to(device).float()).float().cpu().numpy()
    self_u, next_u, next_t = data["self_u"].numpy(), data["next_u"].numpy(), data["next_t"].numpy()
    value = v_u[self_u]
    nv = np.where(next_u >= 0, v_u[np.maximum(next_u, 0)], 0.0).astype(np.float32)
    disc = np.power(gamma, data["dt"].numpy()).astype(np.float32)
    delta = data["reward"].numpy() + disc * nv - value
    adv = np.zeros(len(value), np.float32)
    for i in range(len(value) - 1, -1, -1):
        j = next_t[i]
        adv[i] = delta[i] + (disc[i] * lam * adv[j] if j >= 0 else 0.0)
    ret = adv + value
    out = {k: v for k, v in data.items() if k not in ("obs_u", "self_u", "next_u", "next_t", "reward", "dt")}
    out["obs"] = obs_u[torch.from_numpy(self_u)]
    out["value"] = torch.from_numpy(value)
    out["adv"] = torch.from_numpy(adv)
    out["ret"] = torch.from_numpy(ret)
    var = float(np.var(ret))
    return out, (1.0 - float(np.var(ret - value)) / var if var > 0 else 0.0)


# ------------------------------------------------------------------------------------------ learner

def learner_main(args, spec: dict, mcfg: ModelConfig, resume: str, in_q, coord_q, weight_qs) -> None:
    device = torch.device(args.learner_device)
    torch.set_num_threads(2)
    actor, critic = build_nets(spec, mcfg, device)
    opt = torch.optim.Adam(list(actor.parameters()) + list(critic.parameters()), lr=args.lr, eps=1e-5)
    if resume:
        ck = torch.load(resume, map_location=device)
        added = load_actor(actor, ck["actor"])
        critic.load_state_dict(ck["critic"])
        if added:  # see train.learner_main
            head = list(actor.wait_dur.parameters())
            ids = {id(p) for p in head}
            opt = torch.optim.Adam([p for p in actor.parameters() if id(p) not in ids] + list(critic.parameters()),
                                   lr=args.lr, eps=1e-5)
            opt.load_state_dict(ck["opt"])
            opt.add_param_group({"params": head})
        else:
            opt.load_state_dict(ck["opt"])
    actor.eval()
    critic.eval()
    version = 0
    consumed = [0] * len(weight_qs)

    def broadcast():
        a, c = cpu_state(actor), cpu_state(critic)
        for q in weight_qs:
            q.put(("weights", version, list(consumed), a, c))
        return a, c

    a_state, c_state = broadcast()
    coord_q.put(("init", a_state, c_state))
    pending: list[dict] = []
    infos: list[dict] = []
    n_pending = 0
    while True:
        msg = in_q.get()
        kind = msg[0]
        if kind == "stop":
            return
        if kind == "ckpt":
            path, extra = msg[1], msg[2]
            tmp = Path(str(path) + ".tmp")
            torch.save({"actor": actor.state_dict(), "critic": critic.state_dict(), "opt": opt.state_dict(), **extra}, tmp)
            os.replace(tmp, path)
            continue
        if kind != "rollout":
            continue
        _, cid, data, info = msg
        if "obs_u" in data:
            data, info["explained_var"] = values_and_gae(critic, data, args.gamma, args.lam, device)
        consumed[cid] += 1
        pending.append(data)
        infos.append(info)
        n_pending += info["transitions"]
        if n_pending < args.rollout:
            continue
        t0 = time.time()
        batch = {k: torch.cat([d[k] for d in pending]) for k in pending[0] if isinstance(pending[0][k], torch.Tensor)}
        # advantages were normalised per collector rollout; renormalise over the whole batch
        adv = batch["adv"]
        batch["adv"] = (adv - adv.mean()) / (adv.std() + 1e-8)
        batch["lr"] = pending[-1]["lr"]
        logs = ppo_update(actor, critic, opt, batch, args, device)
        logs["update_s"] = time.time() - t0
        n = sum(i["transitions"] for i in infos)
        logs["transitions"] = n
        logs["explained_var"] = float(np.average([i["explained_var"] for i in infos], weights=[i["transitions"] for i in infos]))
        logs["play_rate"] = float(np.average([i["play_rate"] for i in infos], weights=[i["transitions"] for i in infos]))
        pending, infos, n_pending = [], [], 0
        version += 1
        a_state, c_state = broadcast()
        coord_q.put(("updated", version, logs, a_state, c_state))


# ---------------------------------------------------------------------------------------- collector

def collector_main(cid: int, args, spec: dict, mcfg: ModelConfig, n_workers: int, roll_q, weight_q, ctrl_q, stats_q) -> None:
    devs = [d for d in (args.collector_devices or args.device).split(",") if d]
    device = torch.device(devs[cid % len(devs)])
    torch.set_num_threads(1)
    rng = random.Random(args.seed * 7919 + cid)
    env_cfg = {"decisionTicks": args.decision_ticks, "gamma": args.gamma, "botProb": args.bot_prob, "botLevel": args.bot_level,
               "randomProb": args.random_prob, "deckSwap": not args.no_deck_swap, "mirror": args.mirror, "crownCoef": args.crown_coef,
               **({"waitTicks": wait_ticks(args)} if args.wait_options else {})}
    pool = EnvPool(n_workers, args.envs, args.seed * 101 + cid, env_cfg)
    n_tiles = spec["sizes"]["N_TILES"]
    rollout = max(1024, args.rollout // args.collectors)
    buf = Rollout(2 * rollout + 4 * n_workers * args.envs, pool.floats, n_tiles)
    actor, critic = build_nets(spec, mcfg, device)
    for m in (actor, critic):
        m.eval()
        m.enc.trim_tokens = False
        for p_ in m.parameters():
            p_.requires_grad_(False)
    _, version, consumed, a_state, c_state = weight_q.get()
    actor.load_state_dict(a_state)
    critic.load_state_dict(c_state)
    use_graphs = device.type == "cuda" and not args.no_cuda_graphs
    # --learner-values: the learner computes V(s) when a rollout arrives (on its own GPU), so collectors run
    # the actor only (the critic was about a third of the collectors' inference)
    lv = args.learner_values
    infer = GraphedInfer(actor, None if lv else critic, pool.floats, pool.mask_bytes, device, spec=spec) if use_graphs else None
    autocast = make_autocast(device)
    opponents: dict[int, tuple] = {}  # sid -> (model, graphs or None)
    active: list[int] = []
    stream_last: dict = {}
    ep_nets: dict = {}
    stats = Stats()
    league_results: list[tuple[int, float]] = []
    timing = defaultdict(float)
    sent = 0
    total_decisions = 0
    shape_coef = args.shape_coef

    def load_opponent(sid: int, path: str):
        m, _ = build_nets(spec, mcfg, device)
        load_actor(m, torch.load(path, map_location=device)["actor"], absent_bias=20.0)
        m.eval()
        m.enc.trim_tokens = False
        for p_ in m.parameters():
            p_.requires_grad_(False)
        # opponents rotate: untrimmed graphs (4 captures, not 36) keep loading one quick
        g = GraphedInfer(m, None, pool.floats, pool.mask_bytes, device, sizes=(64, 128, 256, 512)) if use_graphs else None
        return m, g

    def assign(opp_code: int, team: int) -> list:
        if opp_code != 0:
            # the scripted bot is a benchmark only: the learner plays it ("E") but nothing is trained on it
            nets = [None, None]
            nets[team] = "E"
            nets[1 - team] = OPP_NAMES[opp_code]
            return nets
        live = [s for s in active if s in opponents]
        if not live or rng.random() < args.self_play_prob:
            return ["L", "L"]
        lt = rng.randrange(2)
        nets = [None, None]
        nets[lt] = "L"
        nets[1 - lt] = rng.choice(live)
        return nets

    def process(frame) -> np.ndarray:
        nonlocal total_decisions
        c = shape_coef
        ended = set()
        for row in frame.dones:
            gid, team, ep = int(row[0]), int(row[1]), int(row[2])
            outcome, term, shape, ticks, ep_ticks = float(row[3]), float(row[4]), float(row[5]), float(row[6]), float(row[7])
            crowns, opp_crowns = float(row[8]), float(row[9])
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
                league_results.append((opp, outcome))
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
        t1 = time.time()
        obs_t = torch.from_numpy(frame.obs).to(device)
        masks_t = torch.from_numpy(frame.masks).to(device)
        learn = np.array([v in ("L", "E") for v in nets_r], dtype=bool)
        with torch.no_grad(), autocast():
            if learn.any():
                li_rows = np.nonzero(learn)[0]
                lt = torch.from_numpy(li_rows).to(device)
                if infer is not None:
                    packed = infer(obs_t[lt], masks_t[lt], frame.obs, li_rows)
                elif lv:
                    packed = actor.act_packed(obs_t[lt], masks_t[lt])
                else:
                    packed = torch.cat([actor.act_packed(obs_t[lt], masks_t[lt]), critic(obs_t[lt]).float().unsqueeze(1)], 1)
                packed = packed.cpu().numpy()
                s_np, t_np = packed[:, 0].astype(np.int64), packed[:, 1].astype(np.int64)
                lp_np = packed[:, 2].astype(np.float32)
                v_np = np.zeros(len(packed), np.float32) if lv else packed[:, 3].astype(np.float32)
                t2 = time.time()
                timing["p_infer_s"] += t2 - t1
                slot[li_rows], tile[li_rows] = s_np, t_np
                stats.illegal += count_illegal(frame.masks[li_rows], s_np, t_np, n_tiles)
                keep = np.array([nets_r[r] == "L" for r in li_rows], dtype=bool)  # benchmark games are not stored
                li_rows, s_np, t_np, lp_np, v_np = li_rows[keep], s_np[keep], t_np[keep], lp_np[keep], v_np[keep]
                start = 5 + np.clip(s_np - 1, 0, 3) * n_tiles
                tm = frame.masks[li_rows[:, None], start[:, None] + np.arange(n_tiles)[None, :]] * (s_np > 0)[:, None]
                idx = buf.add(frame.obs[li_rows].astype(np.float16), frame.masks[li_rows, :5], tm, s_np, t_np, lp_np, v_np)
                for k, r in enumerate(li_rows):
                    key = (int(gids[r]), int(teams[r]))
                    prev = stream_last.get(key)
                    if prev is not None and meta[r, 3] == 0:
                        buf.finish(prev, float(meta[r, 4]) + c * float(meta[r, 5]), float(meta[r, 6]), False, float(v_np[k]), int(idx[k]))
                    stream_last[key] = int(idx[k])
                timing["p_store_s"] += time.time() - t2
                stats.decisions += len(li_rows)
                total_decisions += len(li_rows)
            t3 = time.time()
            for sid in {v for v in nets_r if isinstance(v, int)}:
                rows = np.nonzero(np.array([v == sid for v in nets_r]))[0]
                if sid not in opponents:
                    continue  # dropped while its episode ran: it waits
                m, g = opponents[sid]
                rt = torch.from_numpy(rows).to(device)
                pk = (g(obs_t[rt], masks_t[rt]) if g is not None else m.act_packed(obs_t[rt], masks_t[rt])).cpu().numpy()
                slot[rows], tile[rows] = pk[:, 0].astype(np.int64), pk[:, 1].astype(np.int64)
            timing["p_opp_s"] += time.time() - t3
        return np.stack([gids, teams, slot, tile], 1).astype(np.int32)

    def apply_weights(msgs):
        nonlocal version, consumed
        w = [m for m in msgs if m[0] == "weights"]
        if w:
            _, version, consumed, a, c_ = w[-1]
            actor.load_state_dict(a)  # in place: the CUDA graphs stay valid
            critic.load_state_dict(c_)

    groups = [list(pool.group(g, args.groups)) for g in range(args.groups)]
    groups = [g for g in groups if g]
    for ws in groups:
        pool.send_many(ws, None)
    gi = 0
    while True:
        for m in _drain(ctrl_q):
            if m[0] == "stop":
                pool.close()
                return
            if m[0] == "opponents":
                active = [sid for sid, _ in m[1]]
                shape_coef = m[2]
                referenced = {v for nets in ep_nets.values() for v in nets if isinstance(v, int)}
                for sid in list(opponents):
                    if sid not in active and sid not in referenced:
                        del opponents[sid]
                for sid, path in m[1]:
                    if sid not in opponents:
                        opponents[sid] = load_opponent(sid, path)
        apply_weights(_drain(weight_q))
        ws = groups[gi]
        t0 = time.time()
        fr = pool.recv_many(ws)
        t1 = time.time()
        acts = process(fr)
        pool.send_many(ws, acts)
        timing["wait_s"] += t1 - t0
        timing["process_s"] += time.time() - t1
        timing["frames"] += 1
        timing["records"] += len(fr.meta)
        gi = (gi + 1) % len(groups)
        if buf.n_complete >= rollout:
            # back-pressure: never more than MAX_OUTSTANDING rollouts ahead of the learner
            while sent - consumed[cid] >= MAX_OUTSTANDING:
                apply_weights([weight_q.get()])
            t = lambda a: torch.from_numpy(np.ascontiguousarray(a))  # noqa: E731
            if lv:
                data, info = rollout_for_learner_values(buf, t, args.lr)
            else:
                idx, adv, ret = buf.advantages(args.gamma, args.lam)
                data = {"obs": t(buf.obs[idx]), "slot_mask": t(buf.slot_mask[idx]), "tile_mask": t(buf.tile_mask[idx]),
                        "slot": t(buf.slot[idx]), "tile": t(buf.tile[idx]), "logp": t(buf.logp[idx]), "value": t(buf.value[idx]),
                        "adv": t(adv.astype(np.float32)), "ret": t(ret.astype(np.float32)), "lr": args.lr}
                var = float(np.var(ret))
                info = {"transitions": len(idx), "explained_var": 1.0 - float(np.var(ret - buf.value[idx])) / var if var > 0 else 0.0,
                        "play_rate": float((buf.slot[idx] > 0).mean())}
            buf.compact(stream_last)
            roll_q.put(("rollout", cid, data, info))
            sent += 1
            stats_q.put(("stats", cid, {"games": dict(stats.games), "wins": dict(stats.wins), "dominant": dict(stats.dominant),
                                        "crowns": dict(stats.crowns), "lost": dict(stats.lost), "ep_ticks": list(stats.ep_ticks),
                                        "decisions": stats.decisions, "illegal": stats.illegal,
                                        "beh": {k: v.tolist() for k, v in stats.beh.items()}, "beh_n": dict(stats.beh_n)},
                         dict(timing), list(league_results)))
            stats.reset()
            timing.clear()
            league_results.clear()


# -------------------------------------------------------------------------------------- coordinator

def main(args) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    # one throwaway worker for the spec (layout, vocabulary)
    probe = EnvPool(1, 1, args.seed, {})
    spec = probe.spec
    probe.close()
    (out / "spec.json").write_text(json.dumps(spec))
    mcfg = ModelConfig(args.d_model, args.layers, args.heads, 2, args.tile_dim, 4, args.critic_d_model, args.critic_layers,
                       args.wait_options)
    template, _ = build_nets(spec, mcfg, torch.device("cpu"))
    print(f"actor {param_count(template) / 1e6:.2f} M params; {args.collectors} collectors x "
          f"~{args.workers // args.collectors} workers x {args.envs} envs; learner on {args.learner_device}", flush=True)
    league = League(out, args.league_size, args.active_opponents, args.pfsp_power, rng)
    update, total_decisions = 0, 0
    resume = args.resume or (str(out / "latest.pt") if (out / "latest.pt").exists() else "")
    if resume:
        ck = torch.load(resume, map_location="cpu")
        league.load_state(ck["league"])
        update, total_decisions = ck["update"], ck["total_decisions"]
        print(f"resumed {resume} at update {update}, {total_decisions:.3g} decisions", flush=True)
        del ck

    mp = torch.multiprocessing.get_context("spawn")
    learner_q, coord_q, stats_q = mp.Queue(), mp.Queue(), mp.Queue()
    weight_qs = [mp.Queue() for _ in range(args.collectors)]
    ctrl_qs = [mp.Queue() for _ in range(args.collectors)]
    learner = mp.Process(target=learner_main, args=(args, spec, mcfg, resume, learner_q, coord_q, weight_qs), daemon=True)
    learner.start()
    _, a_state, _ = coord_q.get()
    template.load_state_dict(a_state)
    share = [args.workers // args.collectors + (1 if i < args.workers % args.collectors else 0) for i in range(args.collectors)]
    collectors = [mp.Process(target=collector_main, args=(i, args, spec, mcfg, share[i], learner_q, weight_qs[i], ctrl_qs[i], stats_q),
                             daemon=True) for i in range(args.collectors)]
    for p in collectors:
        p.start()

    def shape_coef() -> float:
        return max(args.shape_floor, args.shape_coef * max(0.0, 1.0 - total_decisions / max(1.0, args.shape_anneal)))

    def send_opponents():
        picks = league.pick()
        for q in ctrl_qs:
            q.put(("opponents", [(s.sid, s.path) for s in picks], shape_coef()))

    send_opponents()
    stats = Stats()
    beh_win, beh_win_n = {}, defaultdict(int)
    timing = defaultdict(float)
    metrics_f = open(out / "metrics.jsonl", "a")
    t_last = time.time()
    try:
        while True:
            # collector stats (non-blocking), then wait briefly for a learner update
            for m in _drain(stats_q):
                _, cid, st, tm, lres = m
                for k, n in st["games"].items():
                    stats.games[k] += n
                for f in ("wins", "dominant", "crowns", "lost"):
                    for k, v in st[f].items():
                        getattr(stats, f)[k] += v
                stats.ep_ticks.extend(st["ep_ticks"])
                stats.decisions += st["decisions"]
                stats.illegal += st.get("illegal", 0)
                for k, v in st.get("beh", {}).items():
                    stats.beh[k] = stats.beh.get(k, 0) + np.asarray(v)
                    stats.beh_n[k] += st["beh_n"][k]
                total_decisions += st["decisions"]
                for k, v in tm.items():
                    timing[k] += v
                for sid, outcome in lres:
                    league.record(sid, outcome)
            try:
                msg = coord_q.get(timeout=0.5)
            except queue.Empty:
                if not learner.is_alive() or not all(p.is_alive() for p in collectors):
                    raise RuntimeError("a learner or collector process died")
                continue
            if msg[0] != "updated":
                continue
            _, version, ulogs, a_state, _ = msg
            template.load_state_dict(a_state)
            update += 1
            if update % args.snapshot_every == 0:
                league.add(template, update)
            if update % args.opp_every == 0:  # rotate the league opponents now and then (each new one costs graph captures)
                send_opponents()
            dt = time.time() - t_last
            t_last = time.time()
            summary = stats.summary()
            summary["decisions_per_s"] = stats.decisions / max(1e-6, dt)
            rec = {"update": update, "decisions": total_decisions, "shape_coef": shape_coef(), "league": len(league.pool),
                   **ulogs, **summary, **{f"t_{k}": v for k, v in timing.items()}}
            metrics_f.write(json.dumps(rec) + "\n")
            metrics_f.flush()
            wr = " ".join(f"{k[11:]}={v:.2f}" for k, v in rec.items() if k.startswith("winrate_vs_"))
            if "dominant_vs_bot" in rec:
                wr += (f" [bot: 2+crowns&0 lost {rec['dominant_vs_bot']:.2f}, crowns {rec['crowns_vs_bot']:.2f}"
                       f"/{rec['crowns_lost_vs_bot']:.2f}, n={rec['games_vs_bot']}]")
            nf = max(1, timing["frames"])
            print(f"upd {update} dec {total_decisions:.3g} {rec['decisions_per_s']:.0f}/s ev {rec['explained_var']:.2f} "
                  f"kl {rec.get('approx_kl', 0):.4f} ent {rec.get('entropy_slot', 0):.2f}/{rec.get('entropy_tile', 0):.2f} "
                  f"card {rec.get('entropy_card', 0):.2f}/floor {rec.get('card_floor_pen', 0):.3f} "
                  f"play {rec['play_rate']:.2f} ep {rec.get('episode_s', 0):.0f}s {wr} | per collector frame: wait "
                  f"{1000 * timing['wait_s'] / nf:.0f}ms proc {1000 * timing['process_s'] / nf:.0f}ms; upd {rec['update_s']:.1f}s "
                  f"n={rec['transitions']}", flush=True)
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
                learner_q.put(("ckpt", str(out / "latest.pt"), extra))
                torch.save({"actor": template.state_dict(), "model": mcfg.__dict__, "update": update}, out / f"actor_{update:06d}.pt")
            if (args.max_updates and update >= args.max_updates) or total_decisions >= args.total_decisions:
                break
    finally:
        for q in ctrl_qs:
            q.put(("stop",))
        learner_q.put(("stop",))
        for p in collectors:
            p.join(timeout=30)
        learner.join(timeout=60)
        metrics_f.close()
