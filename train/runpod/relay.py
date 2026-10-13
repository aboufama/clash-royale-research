"""Exchange snapshots between a main run and its exploiter on two pods (python3 standard library).

    export RUNPOD_API_KEY=...
    python3 train/runpod/relay.py --main crl-5090a:exp1 --exploiter crl-b:x1 --every 1200

Every `--every` seconds: the main run's newest league snapshot goes to the exploiter's import
directory (the exploiter trains only against those, --import-dir runs/x1/import --self-play-prob 0),
and the exploiter's current actor goes to the main run's import directory (--import-dir
runs/exp1/import), where its league picks it by PFSP like any snapshot. Files travel through this
machine; sent names are remembered in work/runpod/relay_<main>_<exploiter>.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import launch  # noqa: E402

EXTRACT = ("import torch,sys; c=torch.load(sys.argv[1],map_location='cpu',weights_only=False); "
           "torch.save({'actor':c['actor'],'update':c['update']},sys.argv[2]); print(c['update'])")


def pod_of(name: str) -> dict:
    st = launch.load_state()
    if name not in st["pods"]:
        sys.exit(f"unknown pod {name}")
    return st["pods"][name]


def sh(p: dict, cmd: str) -> str:
    r = launch.ctl(p, "POST", "/exec", json.dumps({"cmd": cmd, "timeout": 300}).encode(), timeout=360)
    return r.get("stdout") or ""


def get(p: dict, path: str) -> bytes:
    return launch.ctl(p, "GET", f"/file?path={path}", raw=True, timeout=600)


def put(p: dict, path: str, data: bytes) -> None:
    launch.ctl(p, "PUT", f"/upload?path={path}", data, ctype="application/octet-stream", timeout=600)


def once(main: tuple[dict, str], expl: tuple[dict, str], sent: dict) -> None:
    (mp, mrun), (xp, xrun) = main, expl
    # main -> exploiter: the newest league snapshot
    newest = sh(mp, f"ls -t /workspace/crl/runs/{mrun}/league/ 2>/dev/null | head -1").strip().splitlines()
    if newest and newest[0].endswith(".pt") and newest[0] != sent.get("main"):
        data = get(mp, f"runs/{mrun}/league/{newest[0]}")
        put(xp, f"runs/{xrun}/import/main_{newest[0]}", data)
        sent["main"] = newest[0]
        print(f"{time.strftime('%H:%M:%S')} main {newest[0]} -> exploiter ({len(data) >> 20} MiB)", flush=True)
    # exploiter -> main: its current actor
    out = sh(xp, f"cd /workspace/crl/runs/{xrun} && test -f latest.pt && python3 -c \"{EXTRACT}\" latest.pt export_actor.pt").strip()
    upd = out.splitlines()[-1] if out else ""
    if upd.isdigit() and upd != sent.get("exploiter"):
        data = get(xp, f"runs/{xrun}/export_actor.pt")
        put(mp, f"runs/{mrun}/import/expl_{xrun}_{int(upd):06d}.pt", data)
        sent["exploiter"] = upd
        print(f"{time.strftime('%H:%M:%S')} exploiter update {upd} -> main ({len(data) >> 20} MiB)", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--main", required=True, help="pod:run of the main agent")
    ap.add_argument("--exploiter", required=True, help="pod:run of the exploiter")
    ap.add_argument("--every", type=float, default=1200)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    (mpod, mrun), (xpod, xrun) = a.main.split(":"), a.exploiter.split(":")
    state = launch.STATE.parent / f"relay_{mpod}_{xpod}.json"
    sent = json.loads(state.read_text()) if state.exists() else {}
    while True:
        try:
            once((pod_of(mpod), mrun), (pod_of(xpod), xrun), sent)
            state.write_text(json.dumps(sent))
        except Exception as e:  # a pod restarting or the proxy hiccuping: try again next round
            print(f"{time.strftime('%H:%M:%S')} relay error: {e!r}", flush=True)
        if a.once:
            return
        time.sleep(a.every)


if __name__ == "__main__":
    main()
