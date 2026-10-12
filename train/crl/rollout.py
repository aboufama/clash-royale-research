"""Rollout storage for the semi-MDP transitions of the learning policy, and GAE.

A transition is created when the learner decides (obs, action, logp, value) and completed when its
stream's next record arrives: the reward sum and tick count since the decision come with that record
(or with the episode's done row). Incomplete transitions survive an update by being moved to the
front of the buffer.
"""
from __future__ import annotations

import numpy as np


class Rollout:
    def __init__(self, capacity: int, floats: int, n_tiles: int):
        self.cap = capacity
        self.obs = np.zeros((capacity, floats), np.float16)
        self.slot_mask = np.zeros((capacity, 5), np.uint8)
        self.tile_mask = np.zeros((capacity, n_tiles), np.uint8)
        self.slot = np.zeros(capacity, np.int64)
        self.tile = np.zeros(capacity, np.int64)
        self.logp = np.zeros(capacity, np.float32)
        self.value = np.zeros(capacity, np.float32)
        self.reward = np.zeros(capacity, np.float32)
        self.dt = np.zeros(capacity, np.float32)
        self.done = np.zeros(capacity, np.bool_)
        self.next_value = np.zeros(capacity, np.float32)
        self.complete = np.zeros(capacity, np.bool_)
        self.next = np.full(capacity, -1, np.int64)
        self.n = 0
        self.n_complete = 0

    def add(self, obs, slot_mask, tile_mask, slot, tile, logp, value) -> np.ndarray:
        k = len(slot)
        if self.n + k > self.cap:
            raise RuntimeError("rollout buffer full: raise --buffer or lower --rollout")
        i = np.arange(self.n, self.n + k)
        self.obs[i] = obs
        self.slot_mask[i] = slot_mask
        self.tile_mask[i] = tile_mask
        self.slot[i] = slot
        self.tile[i] = tile
        self.logp[i] = logp
        self.value[i] = value
        self.complete[i] = False
        self.done[i] = False
        self.next[i] = -1
        self.n += k
        return i

    def finish(self, i: int, reward: float, dt: float, done: bool, next_value: float, next_idx: int = -1) -> None:
        self.reward[i] = reward
        self.dt[i] = dt
        self.done[i] = done
        self.next_value[i] = next_value
        self.next[i] = next_idx
        self.complete[i] = True
        self.n_complete += 1

    def advantages(self, gamma: float, lam: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """GAE over the complete transitions: A_i = d_i + gamma^dt_i * lam * A_next (same stream).

        Returns (indices, advantages, returns)."""
        n = self.n
        adv = np.zeros(n, np.float32)
        disc = np.power(gamma, self.dt[:n]).astype(np.float32)
        delta = self.reward[:n] + disc * self.next_value[:n] * (~self.done[:n]) - self.value[:n]
        comp = self.complete[:n]
        nxt = self.next[:n]
        for i in range(n - 1, -1, -1):
            if not comp[i]:
                continue
            a = delta[i]
            j = nxt[i]
            if j >= 0 and not self.done[i] and comp[j]:
                a += disc[i] * lam * adv[j]
            adv[i] = a
        idx = np.nonzero(comp)[0]
        return idx, adv[idx], adv[idx] + self.value[idx]

    def compact(self, stream_last: dict) -> None:
        """Drop the complete transitions; move the incomplete ones to the front.

        `stream_last` maps stream key -> buffer index of its pending transition (updated in place)."""
        n = self.n
        keep = np.nonzero(~self.complete[:n])[0]
        remap = np.full(n, -1, np.int64)
        remap[keep] = np.arange(len(keep))
        for arr in (self.obs, self.slot_mask, self.tile_mask, self.slot, self.tile, self.logp, self.value):
            arr[:len(keep)] = arr[keep]
        self.complete[:len(keep)] = False
        self.next[:len(keep)] = -1
        self.n = len(keep)
        self.n_complete = 0
        for k, v in list(stream_last.items()):
            if v is not None:
                nv = remap[v] if v < n else -1
                stream_last[k] = int(nv) if nv >= 0 else None
