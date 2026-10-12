"""Export a trained actor to ONNX for the browser viewer (play against the agent on the Pages site).

    python -m crl.export runs/exp1/actor_000100.pt --out ../sim/viewer/models/agent.onnx

The graph takes one observation record (sim/rl/obs.ts layout, float32 [B, floats]) and returns the slot
logits [B, 5] and the tile logits of every hand slot [B, 4, 576]; the viewer applies the legal-action
masks and samples, exactly as `Actor.act` does in training. Checked against PyTorch with onnxruntime.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch

from .model import Actor, Layout, ModelConfig


class ExportActor(torch.nn.Module):
    def __init__(self, actor: Actor):
        super().__init__()
        self.a = actor

    def forward(self, obs: torch.Tensor):
        a = self.a
        tok, kpm, glob, slot_tok = a.trunk(obs)
        sl = a.slot_logits(glob, slot_tok)
        tf = a.tiles(tok, kpm, glob)  # [B, tiles, dt]
        q = a.tile_q(torch.cat([slot_tok, glob.unsqueeze(1).expand(-1, 4, -1)], -1))  # [B, 4, dt]
        tl = torch.einsum("btd,bsd->bst", tf, q) / math.sqrt(q.shape[-1])
        return sl, tl


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("checkpoint")
    p.add_argument("--spec", default="", help="spec.json of the run (default: next to the checkpoint)")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    ck = torch.load(a.checkpoint, map_location="cpu")
    spec_path = Path(a.spec) if a.spec else Path(a.checkpoint).parent / "spec.json"
    spec = json.loads(spec_path.read_text())
    actor = Actor(Layout(spec), ModelConfig(**ck["model"])).eval()
    actor.load_state_dict(ck["actor"])
    actor.enc.trim_tokens = False
    m = ExportActor(actor).eval()
    F = spec["layout"]["floats"]
    obs = torch.zeros(1, F)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.backends.mha.set_fastpath_enabled(False)  # the fused encoder-layer op has no ONNX export
    with torch.no_grad():
        torch.onnx.export(m, (obs,), str(out), input_names=["obs"], output_names=["slot_logits", "tile_logits"],
                          dynamic_axes={"obs": {0: "b"}, "slot_logits": {0: "b"}, "tile_logits": {0: "b"}},
                          opset_version=17, dynamo=False)
    # check against PyTorch on real-looking observations (a few recorded records if present, else random ids)
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    test = Path(a.checkpoint).parent / "obs_sample.npy"
    x = np.load(test) if test.exists() else None
    if x is None:
        x = np.zeros((4, F), np.float32)
        L, S = spec["layout"], spec["sizes"]
        for b in range(4):  # a few towers and units with plausible ids and features
            for i in range(10):
                o = L["units"] + i * (S["F_UNIT"] + S["ID_UNIT"])
                x[b, o:o + S["F_UNIT"]] = rng.random(S["F_UNIT"])
                x[b, o + S["F_UNIT"]] = rng.integers(1, len(spec["vocab"]["units"]))
            for i in range(16):
                o = L["cards"] + i * (S["F_CARD"] + S["ID_CARD"])
                x[b, o:o + S["F_CARD"]] = rng.random(S["F_CARD"])
                x[b, o + S["F_CARD"]] = rng.integers(1, len(spec["vocab"]["cards"]))
            x[b, L["hand"]:L["hand"] + 4] = [0, 1, 2, 3]
            x[b, L["global"]:L["global"] + S["F_GLOBAL"]] = rng.random(S["F_GLOBAL"])
    with torch.no_grad():
        sl_t, tl_t = m(torch.from_numpy(x))
    sl_o, tl_o = sess.run(None, {"obs": x})
    d1 = float(np.abs(sl_o - sl_t.numpy()).max())
    d2 = float(np.abs(tl_o - tl_t.numpy()).max())
    # the trimmed (training) path must agree with the fixed-shape one
    actor.enc.trim_tokens = True
    with torch.no_grad():
        sl_tr, _ = m(torch.from_numpy(x))
    d3 = float((sl_tr - sl_t).abs().max())
    print(f"{out}: {out.stat().st_size / 2**20:.1f} MiB; max |onnx - torch| slot {d1:.2e} tile {d2:.2e}; trim vs fixed {d3:.2e}")
    if max(d1, d2, d3) > 1e-3:
        raise SystemExit("export check failed")


if __name__ == "__main__":
    main()
