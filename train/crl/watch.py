"""Watch the agent play: games against the scripted bot (the benchmark, never trained on) and against
itself, with replays and a behaviour report (results, card use, placement, elixir habits).

    python -m crl.watch work/runpod/runs/exp1/latest.pt --games 32 --out work/watch/u1400

The aggregate behaviour in metrics.jsonl says *that* something changed; this says *how*: which cards
it plays where and when, what it does at full elixir, and the replays to look at (viewer: ?replay=).
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

from .envpool import EnvPool
from .model import Actor, Layout, ModelConfig

BANDS = (("back", 0, 8), ("mid", 8, 14), ("bridge", 14, 18), ("enemy", 18, 32))  # canonical rows, 0 = own back


def run(actor: Actor, opp: str, games: int, workers: int, envs: int, seed: int, replay_dir: Path | None, greedy: bool) -> dict:
    cfg = {"mirror": True, "botProb": 1.0 if opp == "bot" else 0.0, "botLevel": 3}
    if replay_dir is not None:
        replay_dir.mkdir(parents=True, exist_ok=True)
        cfg["replayDir"] = str(replay_dir)
    pool = EnvPool(workers, envs, seed, cfg)
    spec = pool.spec
    L, S = spec["layout"], spec["sizes"]
    names = spec["vocab"]["cards"]
    n_tiles, tw = S["N_TILES"], S["TILES_W"]
    beh_f = S.get("BEH_F", 0)
    card_stride = S["F_CARD"] + S["ID_CARD"]
    dones, plays = [], []
    dec = full = full_wait = 0
    heat = defaultdict(lambda: np.zeros((S["TILES_H"], tw), np.int32))
    actions = None
    while len(dones) < games:
        fr = pool.step(actions)
        dones.extend(fr.dones.tolist())
        with torch.no_grad():
            s, t, _ = actor.act(torch.from_numpy(fr.obs.copy()), torch.from_numpy(fr.masks.copy()), greedy=greedy)
        s, t = s.numpy(), t.numpy()
        g = L["global"]
        for r in range(len(fr.meta)):
            elixir = float(fr.obs[r, g + 4]) * 10
            dec += 1
            if elixir >= 9.99:
                full += 1
                full_wait += int(s[r] == 0)
            if s[r] <= 0:
                continue
            di = int(fr.obs[r, L["hand"] + s[r] - 1])
            cid = int(round(float(fr.obs[r, L["cards"] + di * card_stride + S["F_CARD"]])))
            name = names[cid - 1] if 0 < cid <= len(names) else "?"
            row, col = int(t[r]) // tw, int(t[r]) % tw
            plays.append((name, row, col, elixir, float(fr.obs[r, g]) * 180))
            heat[name][row, col] += 1
        actions = np.stack([fr.meta[:, 0], fr.meta[:, 1], s, t], 1).astype(np.int32)
    pool.close()

    d = np.array(dones[:games], np.float64)
    out = {"games": len(d), "decisions": dec, "plays": len(plays), "play_rate": len(plays) / max(1, dec),
           "full_elixir_decisions": full / max(1, dec), "waited_at_full": full_wait / max(1, full)}
    if len(d):
        out.update(win=float(np.mean(d[:, 3] > 0)), draw=float(np.mean(d[:, 3] == 0)), crowns=float(d[:, 8].mean()),
                   crowns_lost=float(d[:, 9].mean()), dominant=float(np.mean((d[:, 8] >= 2) & (d[:, 9] == 0))),
                   length_s=float(d[:, 7].mean() / 20))
        if beh_f and d.shape[1] >= 11 + 2 * beh_f:
            own, op = d[:, 11:11 + beh_f], d[:, 11 + beh_f:11 + 2 * beh_f]
            out["full_elixir_s"] = float(own[:, 10].mean() / 20)
            out["opp_full_elixir_s"] = float(op[:, 10].mean() / 20)
            out["opp_plays"] = float(op[:, :8].sum(1).mean())
    per = {}
    by = defaultdict(list)
    for p in plays:
        by[p[0]].append(p)
    for name, ps in sorted(by.items(), key=lambda kv: -len(kv[1])):
        rows = np.array([p[1] for p in ps])
        per[name] = {"per_game": len(ps) / max(1, len(d)), "elixir_at_play": float(np.mean([p[3] for p in ps])),
                     "median_time_s": float(np.median([p[4] for p in ps])),
                     **{b: float(np.mean((rows >= lo) & (rows < hi))) for b, lo, hi in BANDS}}
    out["cards"] = per
    out["heat"] = {k: v.tolist() for k, v in heat.items()}
    return out


def heatmap(h: np.ndarray) -> list[str]:
    """2x2-binned placement map, enemy back row at the top, own back row at the bottom."""
    H, W = h.shape
    b = h[: H - H % 2, : W - W % 2].reshape(H // 2, 2, W // 2, 2).sum((1, 3))
    m = max(1, b.max())
    ramp = " .:-=+*#%@"
    return ["|" + "".join(ramp[min(9, int(np.ceil(9 * v / m)))] if v else " " for v in row) + "|" for row in b[::-1]]


def report(name: str, r: dict, maps: bool) -> str:
    lines = [f"== vs {name}: {r['games']} games"]
    if "win" in r:
        lines.append(f"   win {r['win']:.2f} draw {r['draw']:.2f} | crowns {r['crowns']:.2f} taken / {r['crowns_lost']:.2f} lost | "
                     f"2+ crowns & 0 lost {r['dominant']:.2f} | length {r['length_s']:.0f}s")
    lines.append(f"   decisions {r['decisions']}, plays {r['plays']} (rate {r['play_rate']:.3f}); at full elixir on "
                 f"{r['full_elixir_decisions']:.2f} of decisions, waited on {r['waited_at_full']:.2f} of those"
                 + (f"; {r['full_elixir_s']:.0f}s per game at full elixir (opponent {r['opp_full_elixir_s']:.0f}s, "
                    f"{r['opp_plays']:.0f} plays)" if "full_elixir_s" in r else ""))
    lines.append(f"   {'card':16s} {'/game':>6s} {'elixir':>6s} {'t_med':>6s}  " + " ".join(f"{b:>6s}" for b, _, _ in BANDS))
    for c, v in r["cards"].items():
        lines.append(f"   {c:16s} {v['per_game']:6.2f} {v['elixir_at_play']:6.1f} {v['median_time_s']:6.0f}  "
                     + " ".join(f"{v[b]:6.2f}" for b, _, _ in BANDS))
    if maps:
        cards = list(r["cards"])
        for i in range(0, len(cards), 4):
            group = cards[i:i + 4]
            blocks = [heatmap(np.array(r["heat"][c])) for c in group]
            lines.append("   " + "  ".join(f"{c[:11]:11s}" for c in group))
            for row in zip(*blocks):
                lines.append("   " + "  ".join(row))
    return "\n".join(lines)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("checkpoint")
    p.add_argument("--games", type=int, default=32, help="games per opponent")
    p.add_argument("--opponents", default="bot,self")
    p.add_argument("--workers", type=int, default=2)
    p.add_argument("--envs", type=int, default=8)
    p.add_argument("--seed", type=int, default=777)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--greedy", action="store_true")
    p.add_argument("--maps", action="store_true", help="print a placement heatmap per card")
    p.add_argument("--out", default="", help="directory for replays/<opponent>/ and report.json")
    a = p.parse_args(argv)
    torch.set_num_threads(a.threads)
    ck = torch.load(a.checkpoint, map_location="cpu", weights_only=False)
    out = Path(a.out) if a.out else None
    probe = EnvPool(1, 1, 1)
    actor = Actor(Layout(probe.spec), ModelConfig(**ck["model"])).eval()
    probe.close()
    actor.load_state_dict(ck["actor"])
    res = {"update": ck.get("update"), "decisions": ck.get("total_decisions")}
    print(f"checkpoint update {res['update']}, {res['decisions'] or 0:.3g} decisions")
    for opp in a.opponents.split(","):
        r = run(actor, opp, a.games, a.workers, a.envs, a.seed, out / "replays" / opp if out else None, a.greedy)
        res[opp] = r
        print(report(opp, r, a.maps), flush=True)
    if out:
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(json.dumps(res))


if __name__ == "__main__":
    main()
