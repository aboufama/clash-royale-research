"""Run training on a RunPod GPU pod over HTTPS only (python3 standard library).

    export RUNPOD_API_KEY=...                      # never commit it
    python3 train/runpod/launch.py create --name crl-1 [--gpu "NVIDIA GeForce RTX 4090"] [--min-vcpu 16]
    python3 train/runpod/launch.py wait            # until the pod's control server answers
    python3 train/runpod/launch.py push            # upload sim/ (engine + gameplay data) and train/
    python3 train/runpod/launch.py start --run exp1 -- --rollout 65536
    python3 train/runpod/launch.py status | log | ls runs/exp1 | fetch runs/exp1/latest.pt
    python3 train/runpod/launch.py stop | terminate

The pod runs podserver.py as its container command (passed base64-encoded in its environment) and
is reached through RunPod's proxy at https://<pod id>-8000.proxy.runpod.net with a random bearer
token. Pod id and token are kept in work/runpod/pods.json (work/ is ignored by git).

What leaves this machine: the engine (sim/core, sim/rl), its gameplay data (sim/data/gamedata.json,
decoded from the game files) and the trainer (train/). Never game-files/, art or audio.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import secrets
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STATE = REPO / "work" / "runpod" / "pods.json"
REST = "https://rest.runpod.io/v1"
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
GPUS = ["NVIDIA GeForce RTX 4090", "NVIDIA L40S", "NVIDIA RTX A6000", "NVIDIA A100 80GB PCIe", "NVIDIA H100 PCIe"]
BUNDLE = ["sim/core/src", "sim/rl", "sim/data", "sim/package.json", "sim/tsconfig.json", "train/crl", "train/requirements.txt"]


def api_key() -> str:
    k = os.environ.get("RUNPOD_API_KEY")
    if not k:
        sys.exit("set RUNPOD_API_KEY")
    return k


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"pods": {}, "current": None}


def save_state(st: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, indent=1))
    os.chmod(STATE, 0o600)


def rest(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(REST + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"RunPod {method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:2000]}")


def pod(args) -> dict:
    st = load_state()
    name = args.pod or st.get("current")
    if not name or name not in st["pods"]:
        sys.exit("no pod: run `create` first or pass --pod")
    return st["pods"][name]


def ctl(p: dict, method: str, path: str, body: bytes | None = None, ctype="application/json", timeout=120, raw=False):
    url = f"https://{p['id']}-8000.proxy.runpod.net{path}"
    req = urllib.request.Request(url, method=method, data=body, headers={"Authorization": f"Bearer {p['token']}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if raw else json.loads(data)


def cmd_create(args):
    st = load_state()
    token = secrets.token_urlsafe(32)
    boot = base64.b64encode((Path(__file__).parent / "podserver.py").read_bytes()).decode()
    body = {
        "name": args.name,
        "imageName": args.image,
        "gpuTypeIds": args.gpu or GPUS,
        "gpuTypePriority": "custom" if args.gpu else "availability",
        "gpuCount": args.gpu_count,
        "cloudType": args.cloud,
        "containerDiskInGb": 40,
        "volumeInGb": args.volume,
        "volumeMountPath": "/workspace",
        "ports": ["8000/http"],
        "minVCPUPerGPU": args.min_vcpu,
        "minRAMPerGPU": args.min_ram,
        "env": {"CRL_TOKEN": token, "CRL_BOOT_B64": boot},
        "dockerStartCmd": ["bash", "-c", "echo \"$CRL_BOOT_B64\" | base64 -d > /crl_podserver.py && exec python3 /crl_podserver.py"],
    }
    r = rest("POST", "/pods", body)
    st["pods"][args.name] = {"id": r["id"], "token": token, "created": time.time(), "gpu": r.get("gpu"), "cost": r.get("costPerHr")}
    st["current"] = args.name
    save_state(st)
    print(json.dumps({k: r.get(k) for k in ("id", "desiredStatus", "costPerHr", "vcpuCount", "memoryInGb", "gpu")}, indent=1))


def cmd_wait(args):
    p = pod(args)
    t0 = time.time()
    while time.time() - t0 < args.timeout:
        try:
            s = ctl(p, "GET", "/status", timeout=20)
            print(json.dumps(s, indent=1))
            if s.get("node", "").startswith("v"):
                return
        except Exception as e:  # noqa: BLE001 - the proxy answers 404 / 502 until the server is up
            print(f"waiting ({type(e).__name__}: {str(e)[:80]})", flush=True)
        time.sleep(15)
    sys.exit("timed out")


def bundle() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for rel in BUNDLE:
            path = REPO / rel
            tf.add(path, arcname=rel, filter=lambda ti: None if "__pycache__" in ti.name or "/test" in ti.name else ti)
    return buf.getvalue()


def cmd_push(args):
    data = bundle()
    print(f"bundle {len(data) / 1024:.0f} KiB: {', '.join(BUNDLE)}")
    print(ctl(pod(args), "PUT", "/bundle", data, ctype="application/gzip", timeout=300))


def cmd_start(args):
    print(json.dumps(ctl(pod(args), "POST", "/start", json.dumps({"run": args.run, "args": args.train_args}).encode()), indent=1))


def cmd_stop(args):
    print(ctl(pod(args), "POST", "/stop", json.dumps({"signal": args.signal}).encode()))


def cmd_status(args):
    p = pod(args)
    info = rest("GET", f"/pods/{p['id']}")
    print(json.dumps({k: info.get(k) for k in ("id", "name", "desiredStatus", "costPerHr", "vcpuCount", "memoryInGb", "gpu")}, indent=1))
    try:
        print(json.dumps(ctl(p, "GET", "/status", timeout=20), indent=1))
    except Exception as e:  # noqa: BLE001
        print(f"control server: {e}")


def cmd_log(args):
    print(ctl(pod(args), "GET", f"/log?n={args.n}", raw=True).decode())


def cmd_ls(args):
    for f in ctl(pod(args), "GET", f"/ls?path={args.path}"):
        print(f"{'d' if f['dir'] else '-'} {f['size']:>12} {time.strftime('%m-%d %H:%M', time.localtime(f['mtime']))} {f['name']}")


def cmd_fetch(args):
    data = ctl(pod(args), "GET", f"/file?path={args.path}", raw=True, timeout=600)
    dest = Path(args.dest) if args.dest else REPO / "work" / "runpod" / args.path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    print(f"{dest} ({len(data) / 2**20:.1f} MiB)")


def cmd_exec(args):
    r = ctl(pod(args), "POST", "/exec", json.dumps({"cmd": " ".join(args.cmd), "timeout": args.timeout}).encode(), timeout=args.timeout + 30)
    sys.stdout.write(r["stdout"])
    sys.stderr.write(r["stderr"])
    print(f"[exit {r['code']}]")


def cmd_terminate(args):
    st = load_state()
    p = pod(args)
    rest("DELETE", f"/pods/{p['id']}")
    name = args.pod or st["current"]
    st["pods"].pop(name, None)
    if st["current"] == name:
        st["current"] = None
    save_state(st)
    print(f"terminated {p['id']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pod", help="pod name from `create` (default: the last created)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--name", default="crl")
    c.add_argument("--gpu", action="append", help="GPU type id (repeat for a preference list)")
    c.add_argument("--gpu-count", type=int, default=1)
    c.add_argument("--min-vcpu", type=int, default=16, help="vCPUs per GPU: the simulation is CPU-bound")
    c.add_argument("--min-ram", type=int, default=32)
    c.add_argument("--volume", type=int, default=100)
    c.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    c.add_argument("--image", default=IMAGE)
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=float, default=1200)
    sub.add_parser("push")
    s = sub.add_parser("start")
    s.add_argument("--run", default="exp1")
    s.add_argument("train_args", nargs=argparse.REMAINDER, help="arguments after -- go to crl.train")
    st = sub.add_parser("stop")
    st.add_argument("--signal", default="SIGINT")
    sub.add_parser("status")
    lg = sub.add_parser("log")
    lg.add_argument("-n", type=int, default=60)
    ls = sub.add_parser("ls")
    ls.add_argument("path", nargs="?", default="runs")
    f = sub.add_parser("fetch")
    f.add_argument("path")
    f.add_argument("--dest")
    e = sub.add_parser("exec")
    e.add_argument("cmd", nargs=argparse.REMAINDER)
    e.add_argument("--timeout", type=float, default=60)
    sub.add_parser("terminate")
    args = ap.parse_args()
    if getattr(args, "train_args", None) and args.train_args[:1] == ["--"]:
        args.train_args = args.train_args[1:]
    {"create": cmd_create, "wait": cmd_wait, "push": cmd_push, "start": cmd_start, "stop": cmd_stop, "status": cmd_status,
     "log": cmd_log, "ls": cmd_ls, "fetch": cmd_fetch, "exec": cmd_exec, "terminate": cmd_terminate}[args.cmd](args)


if __name__ == "__main__":
    main()
