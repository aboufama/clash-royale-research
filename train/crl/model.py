"""Policy and value networks.

Actor: an entity transformer over every object on the board (units and towers, projectiles, area
effects), both decks (own hand / queue, the opponent's publicly known cycle), the own pending plays
and a global token (clock, elixir, crowns). Two heads, sampled autoregressively:
  - slot: wait, or one of the 4 hand slots (logits from each slot's card token), masked to playable;
  - tile: 18 x 32 placement logits from tile queries that cross-attend to the entity tokens, dotted
    with a query made from the chosen card, masked to the tiles where that card lands as aimed.
Critic: the same kind of encoder with the privileged block added (the opponent's exact hand and
queue, pending plays and pending elixir), so value estimates do not have to guess hidden state while
the policy stays on fair information (asymmetric actor-critic).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class ModelConfig:
    d_model: int = 256
    layers: int = 4
    heads: int = 8
    tile_layers: int = 2
    tile_dim: int = 64  # width of the 576 tile queries (they dominate the compute at full width)
    tile_heads: int = 4
    critic_d_model: int = 192
    critic_layers: int = 3


class Layout:
    """Slices of an observation record (sim/rl/obs.ts layout()), from the worker's JSON spec."""

    def __init__(self, spec: dict):
        self.L = spec["layout"]
        self.S = spec["sizes"]
        self.V = {k: len(v) for k, v in spec["vocab"].items()}

    def unpack(self, obs: torch.Tensor) -> dict[str, torch.Tensor]:
        L, S = self.L, self.S
        B = obs.shape[0]

        def block(name: str, n: int, f: int, i: int):
            x = obs[:, L[name]: L[name] + n * (f + i)].reshape(B, n, f + i)
            return x[..., :f], x[..., f:].round().long()

        out: dict[str, torch.Tensor] = {}
        out["glob"] = obs[:, L["global"]: L["global"] + S["F_GLOBAL"]]
        out["unit_f"], out["unit_id"] = block("units", S["MAX_UNITS"], S["F_UNIT"], S["ID_UNIT"])
        out["proj_f"], out["proj_id"] = block("proj", S["MAX_PROJ"], S["F_PROJ"], S["ID_PROJ"])
        out["aoe_f"], out["aoe_id"] = block("aoe", S["MAX_AOE"], S["F_AOE"], S["ID_AOE"])
        out["card_f"], out["card_id"] = block("cards", S["N_CARDS"], S["F_CARD"], S["ID_CARD"])
        out["pend_f"], out["pend_id"] = block("pend", S["MAX_PEND"], S["F_PEND"], S["ID_PEND"])
        out["hand"] = obs[:, L["hand"]: L["hand"] + 4].round().long()
        out["priv_card"] = obs[:, L["privCards"]: L["privCards"] + 8 * S["F_PRIV_CARD"]].reshape(B, 8, S["F_PRIV_CARD"])
        out["priv_pend_f"], out["priv_pend_id"] = block("privPend", S["MAX_PEND"], S["F_PEND"], S["ID_PEND"])
        out["priv_glob"] = obs[:, L["privGlobal"]: L["privGlobal"] + S["F_PRIV_GLOBAL"]]
        return out


class Encoder(nn.Module):
    """Entity tokens -> transformer. Returns (tokens, key padding mask, global token, card tokens)."""

    def __init__(self, lay: Layout, d: int, layers: int, heads: int, privileged: bool):
        super().__init__()
        S, V = lay.S, lay.V
        self.privileged = privileged
        self.e_unit = nn.Embedding(V["units"] + 1, d, padding_idx=0)
        self.e_card = nn.Embedding(V["cards"] + 1, d, padding_idx=0)
        self.e_buff = nn.Embedding(V["buffs"] + 1, d, padding_idx=0)
        self.e_proj = nn.Embedding(V["projectiles"] + 1, d, padding_idx=0)
        self.e_aoe = nn.Embedding(V["areaEffects"] + 1, d, padding_idx=0)
        self.e_type = nn.Embedding(8, d)
        self.l_unit = nn.Linear(S["F_UNIT"], d)
        self.l_proj = nn.Linear(S["F_PROJ"], d)
        self.l_aoe = nn.Linear(S["F_AOE"], d)
        self.l_card = nn.Linear(S["F_CARD"] + (S["F_PRIV_CARD"] if privileged else 0), d)
        self.l_pend = nn.Linear(S["F_PEND"], d)
        self.l_glob = nn.Linear(S["F_GLOBAL"] + (S["F_PRIV_GLOBAL"] if privileged else 0), d)
        layer = nn.TransformerEncoderLayer(d, heads, 4 * d, dropout=0.0, batch_first=True, norm_first=True, activation="gelu")
        self.tf = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.n_cards = S["N_CARDS"]

    def forward(self, x: dict[str, torch.Tensor]):
        dev = x["glob"].device
        B = x["glob"].shape[0]
        T = lambda i: self.e_type.weight[i]  # noqa: E731
        u_id = x["unit_id"]
        units = self.l_unit(x["unit_f"]) + self.e_unit(u_id[..., 0]) + self.e_card(u_id[..., 1]) \
            + self.e_buff(u_id[..., 2]) + self.e_buff(u_id[..., 3]) + T(0)
        p_id = x["proj_id"]
        proj = self.l_proj(x["proj_f"]) + self.e_proj(p_id[..., 0]) + self.e_card(p_id[..., 1]) + T(1)
        aoe = self.l_aoe(x["aoe_f"]) + self.e_aoe(x["aoe_id"][..., 0]) + T(2)
        cf = x["card_f"]
        if self.privileged:
            # the privileged block describes the opponent's 8 cards (tokens 8..15)
            pad = torch.zeros(B, 8, x["priv_card"].shape[-1], device=dev, dtype=cf.dtype)
            cf = torch.cat([cf, torch.cat([pad, x["priv_card"]], 1)], -1)
        cards = self.l_card(cf) + self.e_card(x["card_id"][..., 0]) + T(3)
        pend = self.l_pend(x["pend_f"]) + self.e_card(x["pend_id"][..., 0]) + T(4)
        g = x["glob"]
        if self.privileged:
            g = torch.cat([g, x["priv_glob"]], -1)
        glob = (self.l_glob(g) + T(5)).unsqueeze(1)
        parts = [glob, cards, units, proj, aoe, pend]
        pad = [torch.zeros(B, 1 + self.n_cards, dtype=torch.bool, device=dev),
               u_id[..., 0] == 0, p_id[..., 0] == 0, x["aoe_id"][..., 0] == 0, x["pend_id"][..., 0] == 0]
        if self.privileged:
            parts.append(self.l_pend(x["priv_pend_f"]) + self.e_card(x["priv_pend_id"][..., 0]) + T(6))
            pad.append(x["priv_pend_id"][..., 0] == 0)
        tok = torch.cat(parts, 1)
        kpm = torch.cat(pad, 1)
        h = self.norm(self.tf(tok, src_key_padding_mask=kpm))
        return h, kpm, h[:, 0], h[:, 1:1 + self.n_cards]


class TileHead(nn.Module):
    """18 x 32 tile queries cross-attending to the entity tokens (projected to a narrow width), then a
    local conv mix."""

    def __init__(self, d: int, dt: int, heads: int, layers: int, w: int, h: int):
        super().__init__()
        self.w, self.h = w, h
        self.kv = nn.Linear(d, dt)
        self.g = nn.Linear(d, dt)
        self.pos = nn.Parameter(torch.randn(w * h, dt) * 0.02)
        self.attn = nn.ModuleList([nn.MultiheadAttention(dt, heads, batch_first=True) for _ in range(layers)])
        self.ff = nn.ModuleList([nn.Sequential(nn.LayerNorm(dt), nn.Linear(dt, 2 * dt), nn.GELU(), nn.Linear(2 * dt, dt)) for _ in range(layers)])
        self.ln = nn.ModuleList([nn.LayerNorm(dt) for _ in range(layers)])
        self.conv = nn.Conv2d(dt, dt, 3, padding=1, groups=dt)
        self.out = nn.LayerNorm(dt)

    def forward(self, tok: torch.Tensor, kpm: torch.Tensor, glob: torch.Tensor) -> torch.Tensor:
        B = tok.shape[0]
        kv = self.kv(tok)
        q = self.pos.unsqueeze(0).expand(B, -1, -1) + self.g(glob).unsqueeze(1)
        for attn, ff, ln in zip(self.attn, self.ff, self.ln):
            a, _ = attn(ln(q), kv, kv, key_padding_mask=kpm, need_weights=False)
            q = q + a
            q = q + ff(q)
        grid = q.transpose(1, 2).reshape(B, -1, self.h, self.w)
        q = q + self.conv(grid).reshape(B, -1, self.h * self.w).transpose(1, 2)
        return self.out(q)  # (B, tiles, dt), tile index = row * w + col


def masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    return logits.masked_fill(~mask, torch.finfo(logits.dtype).min)


class Actor(nn.Module):
    def __init__(self, lay: Layout, cfg: ModelConfig):
        super().__init__()
        d = cfg.d_model
        S = lay.S
        self.lay = lay
        self.n_tiles = S["N_TILES"]
        self.enc = Encoder(lay, d, cfg.layers, cfg.heads, privileged=False)
        self.tiles = TileHead(d, cfg.tile_dim, cfg.tile_heads, cfg.tile_layers, S["TILES_W"], S["TILES_H"])
        self.slot_card = nn.Sequential(nn.Linear(2 * d, d), nn.GELU(), nn.Linear(d, 1))
        self.slot_wait = nn.Sequential(nn.Linear(d, d), nn.GELU(), nn.Linear(d, 1))
        self.tile_q = nn.Sequential(nn.Linear(2 * d, d), nn.GELU(), nn.Linear(d, cfg.tile_dim))
        self.empty = nn.Parameter(torch.zeros(d))

    def trunk(self, obs: torch.Tensor):
        x = self.lay.unpack(obs)
        tok, kpm, glob, cards = self.enc(x)
        hand = x["hand"]  # (B, 4) own card index 0..7, -1 empty
        idx = hand.clamp(min=0).unsqueeze(-1).expand(-1, -1, cards.shape[-1])
        slot_tok = torch.gather(cards[:, :8], 1, idx)
        slot_tok = torch.where((hand >= 0).unsqueeze(-1), slot_tok, self.empty)
        return tok, kpm, glob, slot_tok

    def slot_logits(self, glob: torch.Tensor, slot_tok: torch.Tensor) -> torch.Tensor:
        g4 = glob.unsqueeze(1).expand(-1, 4, -1)
        card = self.slot_card(torch.cat([slot_tok, g4], -1)).squeeze(-1)
        return torch.cat([self.slot_wait(glob), card], -1)  # (B, 5)

    def tile_logits(self, tok, kpm, glob, slot_tok, slot: torch.Tensor) -> torch.Tensor:
        """Tile logits for the chosen slot (1..4; rows with slot 0 get the logits of slot 1, unused)."""
        tf = self.tiles(tok, kpm, glob)
        s = (slot.clamp(min=1) - 1).view(-1, 1, 1).expand(-1, 1, slot_tok.shape[-1])
        card = torch.gather(slot_tok, 1, s).squeeze(1)
        q = self.tile_q(torch.cat([card, glob], -1))
        return torch.einsum("btd,bd->bt", tf, q) / math.sqrt(q.shape[-1])

    @torch.no_grad()
    def act(self, obs: torch.Tensor, masks: torch.Tensor, greedy: bool = False):
        """Sample (slot, tile) for each row; returns slot, tile, logp."""
        tok, kpm, glob, slot_tok = self.trunk(obs)
        sm = masks[:, :5].bool()
        sl = masked_logits(self.slot_logits(glob, slot_tok).float(), sm)
        slot = sl.argmax(-1) if greedy else torch.distributions.Categorical(logits=sl).sample()
        logp = torch.log_softmax(sl, -1).gather(1, slot.unsqueeze(1)).squeeze(1)
        tile = torch.zeros_like(slot)
        play = slot > 0
        if play.any():
            r = play.nonzero().squeeze(1)
            tl = self.tile_logits(tok[r], kpm[r], glob[r], slot_tok[r], slot[r]).float()
            tm = self.chosen_tile_mask(masks[r], slot[r])
            tl = masked_logits(tl, tm)
            t = tl.argmax(-1) if greedy else torch.distributions.Categorical(logits=tl).sample()
            tile[r] = t
            logp[r] = logp[r] + torch.log_softmax(tl, -1).gather(1, t.unsqueeze(1)).squeeze(1)
        return slot, tile, logp

    def chosen_tile_mask(self, masks: torch.Tensor, slot: torch.Tensor) -> torch.Tensor:
        n = self.n_tiles
        start = 5 + (slot.clamp(min=1) - 1) * n
        ar = torch.arange(n, device=masks.device)
        return torch.gather(masks, 1, start.unsqueeze(1) + ar.unsqueeze(0)).bool()

    def evaluate(self, obs: torch.Tensor, slot_mask: torch.Tensor, tile_mask: torch.Tensor, slot: torch.Tensor, tile: torch.Tensor):
        """log p(slot, tile) and entropies under the current weights (training)."""
        tok, kpm, glob, slot_tok = self.trunk(obs)
        sl = masked_logits(self.slot_logits(glob, slot_tok).float(), slot_mask.bool())
        slp = torch.log_softmax(sl, -1)
        logp = slp.gather(1, slot.unsqueeze(1)).squeeze(1)
        ent_slot = -(slp.exp() * slp).sum(-1)
        ent_tile = torch.zeros_like(ent_slot)
        play = slot > 0
        if play.any():
            # the tile head (576 queries per row) runs only for rows that played a card
            r = play.nonzero().squeeze(1)
            tl = masked_logits(self.tile_logits(tok[r], kpm[r], glob[r], slot_tok[r], slot[r]).float(), tile_mask[r].bool())
            tlp = torch.log_softmax(tl, -1)
            logp = logp.index_add(0, r, tlp.gather(1, tile[r].unsqueeze(1)).squeeze(1))
            ent_tile = ent_tile.index_add(0, r, -(tlp.exp() * tlp).sum(-1))
        return logp, ent_slot, ent_tile


class Critic(nn.Module):
    def __init__(self, lay: Layout, cfg: ModelConfig):
        super().__init__()
        d = cfg.critic_d_model
        self.lay = lay
        self.enc = Encoder(lay, d, cfg.critic_layers, cfg.heads if d % cfg.heads == 0 else 4, privileged=True)
        self.v = nn.Sequential(nn.Linear(d, d), nn.GELU(), nn.Linear(d, 1))

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        _, _, glob, _ = self.enc(self.lay.unpack(obs))
        return self.v(glob).squeeze(-1)


def param_count(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())
