"""Pool of Node environment workers (sim/rl/worker.ts) driven over pipes.

Each worker runs `envs_per_worker` battles. One `step()` sends every worker the actions for the
records of its previous frame and returns the next frames; the workers run in parallel while the
trainer waits. Record layout and sizes come from the JSON spec the worker prints at the handshake.
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
WORKER = REPO / "sim" / "rl" / "worker.ts"


@dataclass
class Frame:
    """One worker frame. `gid` = global env id (worker * envs_per_worker + env)."""
    dones: np.ndarray  # (nDone, DONE_F) float32: env, team, episode, outcome, term, shape, ticks, epTicks, crowns, opp crowns
    meta: np.ndarray  # (nRec, META_F) float32: env, team, episode, start, term, shape, ticks, opp
    obs: np.ndarray  # (nRec, floats) float32
    masks: np.ndarray  # (nRec, maskBytes) uint8


def node_binary() -> str:
    return os.environ.get("CRL_NODE") or shutil.which("node") or "node"


def enlarge_pipe(fd: int, size: int = 8 << 20) -> None:
    """Grow a pipe so a whole frame (~1-2 MB) fits without the writer stalling (Linux F_SETPIPE_SZ)."""
    try:
        import fcntl
        for s in (size, 4 << 20, 1 << 20):
            try:
                fcntl.fcntl(fd, 1031, s)  # F_SETPIPE_SZ
                return
            except OSError:
                continue
    except ImportError:
        pass


def available_cpus() -> int:
    """CPUs this container may use: the cgroup quota (RunPod limits pods by quota, so os.cpu_count()
    reports the whole host), else the affinity mask, else os.cpu_count()."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        q = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
        p = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
        if q > 0:
            return max(1, q // p)
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 1


class EnvPool:
    def __init__(self, n_workers: int, envs_per_worker: int, seed: int, env_cfg: dict | None = None):
        self.n_workers = n_workers
        self.envs_per_worker = envs_per_worker
        self.procs: list[subprocess.Popen] = []
        self.spec: dict | None = None
        for w in range(n_workers):
            p = subprocess.Popen([node_binary(), str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
                                 cwd=str(REPO / "sim"))
            enlarge_pipe(p.stdout.fileno())
            cfg = {"numEnvs": envs_per_worker, "seed": (seed * 1000003 + w * 7919 + 1) & 0x7FFFFFFF, **(env_cfg or {})}
            p.stdin.write((json.dumps(cfg) + "\n").encode())
            line = p.stdout.readline()
            if not line:
                raise RuntimeError(f"worker {w} exited during the handshake")
            self.spec = json.loads(line)
            self.procs.append(p)
        L = self.spec["layout"]
        S = self.spec["sizes"]
        self.floats = L["floats"]
        self.mask_bytes = L["maskBytes"]
        self.done_f = S["DONE_F"]
        self.meta_f = S["META_F"]
        self.pending = [np.zeros((0, 4), np.int32) for _ in range(n_workers)]

    @staticmethod
    def _read(f, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = f.read(n - len(buf))
            if not chunk:
                raise RuntimeError("worker closed its pipe")
            buf += chunk
        return bytes(buf)

    def send(self, w: int, actions: np.ndarray) -> None:
        a = np.ascontiguousarray(actions, dtype=np.int32).reshape(-1)
        payload = struct.pack("<ii", 1, a.size // 4) + a.tobytes()
        self.procs[w].stdin.write(struct.pack("<I", len(payload)) + payload)

    def recv(self, w: int) -> Frame:
        f = self.procs[w].stdout
        n = struct.unpack("<I", self._read(f, 4))[0]
        raw = self._read(f, n)
        n_done, n_rec = struct.unpack_from("<ii", raw, 0)
        o = 8
        dones = np.frombuffer(raw, np.float32, n_done * self.done_f, o).reshape(n_done, self.done_f).copy()
        o += n_done * self.done_f * 4
        meta = np.frombuffer(raw, np.float32, n_rec * self.meta_f, o).reshape(n_rec, self.meta_f).copy()
        o += n_rec * self.meta_f * 4
        obs = np.frombuffer(raw, np.float32, n_rec * self.floats, o).reshape(n_rec, self.floats)
        o += n_rec * self.floats * 4
        masks = np.frombuffer(raw, np.uint8, n_rec * self.mask_bytes, o).reshape(n_rec, self.mask_bytes)
        base = w * self.envs_per_worker
        dones[:, 0] += base
        meta[:, 0] += base
        return Frame(dones, meta, obs, masks)

    def group(self, g: int, n_groups: int) -> range:
        """Workers of group g when the pool is split into n_groups (for pipelining)."""
        per = -(-self.n_workers // n_groups)
        return range(g * per, min(self.n_workers, (g + 1) * per))

    def send_many(self, workers, actions: np.ndarray | None) -> None:
        """Send each worker in `workers` its rows of `actions` ((n, 4) int32: gid, team, slot, tile)."""
        w_of = actions[:, 0] // self.envs_per_worker if actions is not None and len(actions) else None
        for w in workers:
            if w_of is None:
                self.send(w, np.zeros((0, 4), np.int32))
                continue
            sel = actions[w_of == w].copy()
            sel[:, 0] -= w * self.envs_per_worker
            self.send(w, sel)

    def recv_many(self, workers) -> Frame:
        frames = [self.recv(w) for w in workers]
        return Frame(np.concatenate([f.dones for f in frames]), np.concatenate([f.meta for f in frames]),
                     np.concatenate([f.obs for f in frames]), np.concatenate([f.masks for f in frames]))

    def step(self, actions: np.ndarray | None) -> Frame:
        """All workers in lockstep: send the previous frame's actions, return the next frame."""
        ws = range(self.n_workers)
        self.send_many(ws, actions)
        return self.recv_many(ws)

    def close(self) -> None:
        for p in self.procs:
            try:
                payload = struct.pack("<ii", 2, 0)
                p.stdin.write(struct.pack("<I", len(payload)) + payload)
                p.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
