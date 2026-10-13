"""Lift collapsed cards back to a floor by distilling the slot head (one-off checkpoint surgery).

    python -m crl.card_floor latest.pt --out latest_floored.pt --floor 0.03

At update 1350 three of the eight cards had p(card | play) around 1e-9: no policy gradient can bring
such a probability back. This collects states with the checkpoint's own policy, builds a target that
keeps each state's p(wait) and the relative preferences among the other cards but lifts every legal
card to at least `floor` of the play probability, and fits only the slot head (the trunk, the tile
head and the critic are untouched) to that target. Training then continues from the result with a
small --card-floor as a safety net. A penalty applied during PPO did not work: a KL pull to uniform
swamped the policy gradient, and a hinge moved p(wait) through the shared card head.
"""
from __future__ import annotations

import argparse

import numpy as np
import torch

from .envpool import EnvPool
from .model import Actor, Layout, ModelConfig, masked_logits


def collect(actor: Actor, rows: int, seed: int) -> tuple[torch.Tensor, torch.Tensor]:
    obs, masks, n = [], [], 0
    for opp, bot in (("self", 0.0), ("bot", 1.0)):
        pool = EnvPool(2, 8, seed + int(bot), {"botProb": bot, "mirror": True})
        actions = None
        target = rows // 2
        got = 0
        while got < target:
            fr = pool.step(actions)
            obs.append(fr.obs.copy())
            masks.append(fr.masks.copy())
            got += len(fr.obs)
            with torch.no_grad():
                s, t, _ = actor.act(torch.from_numpy(fr.obs.copy()), torch.from_numpy(fr.masks.copy()))
            actions = np.stack([fr.meta[:, 0], fr.meta[:, 1], s.numpy(), t.numpy()], 1).astype(np.int32)
        pool.close()
        n += got
    return torch.from_numpy(np.concatenate(obs)), torch.from_numpy(np.concatenate(masks))


def floored_target(p: torch.Tensor, legal: torch.Tensor, floor: float) -> torch.Tensor:
    """p: (B, 5) slot probabilities; legal: (B, 4) legal cards. Same p(wait); cards below `floor` of the
    play probability are raised to it and the others scaled down to make room."""
    pw, pc = p[:, :1], p[:, 1:]
    play = pc.sum(-1, keepdim=True).clamp(min=1e-12)
    c = pc / play
    multi = legal.sum(-1, keepdim=True) >= 2
    low = legal & (c < floor) & multi
    room = 1.0 - floor * low.sum(-1, keepdim=True)
    rest = torch.where(low | ~legal, torch.zeros_like(c), c)
    rest = rest / rest.sum(-1, keepdim=True).clamp(min=1e-12) * room
    c_new = torch.where(low, torch.full_like(c, floor), rest)
    c_new = torch.where(multi, c_new, c)
    return torch.cat([pw, c_new * play], -1)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("--out", required=True)
    ap.add_argument("--floor", type=float, default=0.03)
    ap.add_argument("--rows", type=int, default=24000)
    ap.add_argument("--steps", type=int, default=600)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=31)
    ap.add_argument("--threads", type=int, default=3)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    torch.manual_seed(a.seed)
    ck = torch.load(a.checkpoint, map_location="cpu", weights_only=False)
    probe = EnvPool(1, 1, 1)
    actor = Actor(Layout(probe.spec), ModelConfig(**ck["model"]))
    probe.close()
    actor.load_state_dict(ck["actor"])
    actor.eval()
    obs, masks = collect(actor, a.rows, a.seed)
    sm = masks[:, :5].bool()
    legal = sm[:, 1:]
    with torch.no_grad():
        # the trunk is frozen: compute its features once (in chunks; only the slot head's inputs are kept)
        feats = [actor.trunk(obs[i:i + 1024])[2:] for i in range(0, len(obs), 1024)]
        glob = torch.cat([f[0] for f in feats])
        slot_tok = torch.cat([f[1] for f in feats])
        p_old = torch.softmax(masked_logits(actor.slot_logits(glob, slot_tok).float(), sm), -1)
        target = floored_target(p_old, legal, a.floor)

    def report(tag: str) -> None:
        with torch.no_grad():
            p = torch.softmax(masked_logits(actor.slot_logits(glob, slot_tok).float(), sm), -1)
            c = p[:, 1:] / p[:, 1:].sum(-1, keepdim=True).clamp(min=1e-12)
            multi = legal.sum(-1) >= 2
            minc = torch.where(legal, c, torch.ones_like(c)).min(-1).values[multi]
            kl = (target * (torch.log(target.clamp(min=1e-12)) - torch.log(p.clamp(min=1e-12)))).sum(-1).mean()
            print(f"{tag}: p(wait) {float(p[:, 0].mean()):.4f} (was {float(p_old[:, 0].mean()):.4f}); min p(card|play) "
                  f"median {float(minc.median()):.3g}, below floor {float((minc < a.floor * 0.9).float().mean()):.3f}; "
                  f"KL(target||p) {float(kl):.4f}", flush=True)

    print(f"{len(obs)} states")
    report("before")
    head = list(actor.slot_card.parameters()) + list(actor.slot_wait.parameters())
    opt = torch.optim.Adam(head, lr=a.lr)
    n = len(obs)
    for step in range(a.steps):
        idx = torch.randint(0, n, (4096,))
        lp = torch.log_softmax(masked_logits(actor.slot_logits(glob[idx], slot_tok[idx]).float(), sm[idx]), -1)
        t = target[idx]
        loss = -(t * torch.where(sm[idx], lp, torch.zeros_like(lp))).sum(-1).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        if (step + 1) % 100 == 0:
            report(f"step {step + 1}")
    ck["actor"] = actor.state_dict()
    ck["card_floor_surgery"] = {"floor": a.floor, "from": a.checkpoint, "steps": a.steps}
    torch.save(ck, a.out)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
