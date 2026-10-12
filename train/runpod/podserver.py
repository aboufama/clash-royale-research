"""Control server that runs on a RunPod pod (python3 standard library only).

The launcher (launch.py) passes this file base64-encoded in the pod's environment and starts it as
the container command, because the machine that drives training may only reach the outside world
over HTTPS: RunPod's proxy exposes this server at https://<pod id>-8000.proxy.runpod.net. Every
request needs `Authorization: Bearer <CRL_TOKEN>`.

    GET  /status                 node / training state, GPU, disk
    PUT  /bundle                 a .tar.gz of the code (sim/ and train/), unpacked to $CRL_HOME/code
    POST /start   {"run", "args"} start `python -m crl.train --out runs/<run> <args>` in the background
    POST /stop    {"signal"}     stop the training (SIGINT by default: it finishes the step and exits)
    GET  /log?n=200              tail of the training log
    GET  /file?path=runs/...     download a file under $CRL_HOME/runs
    GET  /ls?path=runs/...       list a directory under $CRL_HOME/runs
    POST /exec    {"cmd", "timeout"}  run a shell command (debugging; same power as SSH)
"""
from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import tarfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOME = Path(os.environ.get("CRL_HOME", "/workspace/crl"))
TOKEN = os.environ.get("CRL_TOKEN", "")
PORT = int(os.environ.get("CRL_PORT", "8000"))
NODE_VERSION = os.environ.get("CRL_NODE_VERSION", "v22.22.0")
NODE_DIR = HOME / "node"
CODE = HOME / "code"
RUNS = HOME / "runs"
STATE = {"proc": None, "run": None, "log": None, "started": None, "node": "missing", "setup_log": []}
LOCK = threading.Lock()


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    STATE["setup_log"] = (STATE["setup_log"] + [line])[-50:]


def node_bin() -> Path:
    return NODE_DIR / "bin" / "node"


def install_node() -> None:
    """Node >= 22.18 runs the TypeScript worker directly (type stripping)."""
    if node_bin().exists():
        STATE["node"] = subprocess.run([str(node_bin()), "--version"], capture_output=True, text=True).stdout.strip()
        return
    STATE["node"] = "installing"
    url = f"https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz"
    log(f"downloading {url}")
    shutil.rmtree(NODE_DIR, ignore_errors=True)
    NODE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = HOME / "node.tar.xz"
    urllib.request.urlretrieve(url, tmp)
    # straight into NODE_DIR: RunPod's /workspace is NFS, where renaming the unpacked directory fails
    # (EXDEV) and chown is refused (hence --no-same-owner)
    subprocess.run(["tar", "-xJf", str(tmp), "--no-same-owner", "--strip-components=1", "-C", str(NODE_DIR)], check=True)
    tmp.unlink()
    STATE["node"] = subprocess.run([str(node_bin()), "--version"], capture_output=True, text=True).stdout.strip()
    log(f"node {STATE['node']} ready")


def extract(tf: tarfile.TarFile, dest: Path) -> None:
    try:
        tf.extractall(dest, filter="data")
    except TypeError:  # Python without extraction filters
        tf.extractall(dest)


def running() -> bool:
    p = STATE["proc"]
    return p is not None and p.poll() is None


def tail(path: Path, n: int) -> str:
    if not path or not path.exists():
        return ""
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 200 * n))
        return b"\n".join(f.read().splitlines()[-n:]).decode("utf8", "replace")


def safe(rel: str, root: Path) -> Path:
    p = (HOME / rel).resolve()
    if not str(p).startswith(str(root.resolve())):
        raise PermissionError(rel)
    return p


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):  # keep the console for our own lines
        pass

    def _auth(self) -> bool:
        if TOKEN and self.headers.get("Authorization") == f"Bearer {TOKEN}":
            return True
        self._send(401, {"error": "unauthorized"})
        return False

    def _send(self, code: int, obj=None, raw: bytes | None = None, ctype="application/json"):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if not self._auth():
            return
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/status":
                gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader"],
                                     capture_output=True, text=True).stdout.strip() if shutil.which("nvidia-smi") else ""
                du = shutil.disk_usage(HOME if HOME.exists() else "/")
                p = STATE["proc"]
                self._send(200, {"node": STATE["node"], "code": CODE.exists(), "running": running(), "run": STATE["run"],
                                 "exit": None if p is None or p.poll() is None else p.returncode, "started": STATE["started"],
                                 "gpu": gpu, "cpus": os.cpu_count(), "disk_free_gb": round(du.free / 2**30, 1),
                                 "setup": STATE["setup_log"][-5:]})
            elif u.path == "/log":
                self._send(200, raw=tail(STATE["log"], int(q.get("n", "200"))).encode(), ctype="text/plain")
            elif u.path == "/file":
                p = safe(q["path"], RUNS)
                self._send(200, raw=p.read_bytes(), ctype="application/octet-stream")
            elif u.path == "/ls":
                p = safe(q.get("path", "runs"), RUNS)
                self._send(200, [{"name": c.name, "size": c.stat().st_size, "dir": c.is_dir(), "mtime": c.stat().st_mtime}
                                 for c in sorted(p.iterdir())] if p.exists() else [])
            else:
                self._send(404, {"error": "not found"})
        except (KeyError, PermissionError, FileNotFoundError) as e:
            self._send(400, {"error": repr(e)})

    def do_PUT(self):
        if not self._auth():
            return
        if urlparse(self.path).path != "/bundle":
            return self._send(404, {"error": "not found"})
        data = self._body()
        with LOCK:
            if running():
                return self._send(409, {"error": "training is running; stop it first"})
            shutil.rmtree(CODE, ignore_errors=True)
            CODE.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
                for m in tf.getmembers():
                    if m.name.startswith("/") or ".." in Path(m.name).parts:
                        return self._send(400, {"error": f"bad path {m.name}"})
                extract(tf, CODE)
        log(f"bundle unpacked ({len(data)} bytes)")
        self._send(200, {"ok": True, "bytes": len(data)})

    def do_POST(self):
        if not self._auth():
            return
        u = urlparse(self.path).path
        try:
            req = json.loads(self._body() or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        if u == "/start":
            with LOCK:
                if running():
                    return self._send(409, {"error": "already running", "run": STATE["run"]})
                if not node_bin().exists() or not CODE.exists():
                    return self._send(409, {"error": "node or code missing", "node": STATE["node"], "code": CODE.exists()})
                run = req.get("run", "default")
                out = RUNS / run
                out.mkdir(parents=True, exist_ok=True)
                logf = out / "train.log"
                env = {**os.environ, "CRL_NODE": str(node_bin()), "PYTHONUNBUFFERED": "1", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
                       "PATH": f"{NODE_DIR / 'bin'}:{os.environ.get('PATH', '')}"}
                cmd = ["python3", "-m", "crl.train", "--out", str(out), *req.get("args", [])]
                fh = open(logf, "ab")
                fh.write(f"\n=== {time.ctime()} {' '.join(cmd)}\n".encode())
                fh.flush()
                STATE["proc"] = subprocess.Popen(cmd, cwd=str(CODE / "train"), stdout=fh, stderr=subprocess.STDOUT, env=env,
                                                 start_new_session=True)
                STATE.update(run=run, log=logf, started=time.time())
            log(f"started run {run}: {' '.join(cmd)}")
            return self._send(200, {"ok": True, "pid": STATE["proc"].pid, "cmd": cmd})
        if u == "/stop":
            if not running():
                return self._send(200, {"ok": True, "running": False})
            sig = getattr(signal, req.get("signal", "SIGINT"), signal.SIGINT)
            os.killpg(STATE["proc"].pid, sig)
            return self._send(200, {"ok": True, "signal": sig.name})
        if u == "/exec":
            try:
                r = subprocess.run(req["cmd"], shell=True, capture_output=True, text=True, timeout=float(req.get("timeout", 60)),
                                   cwd=str(HOME))
                return self._send(200, {"code": r.returncode, "stdout": r.stdout[-20000:], "stderr": r.stderr[-20000:]})
            except subprocess.TimeoutExpired:
                return self._send(200, {"code": -1, "stdout": "", "stderr": "timeout"})
        self._send(404, {"error": "not found"})


def main() -> None:
    if not TOKEN:
        raise SystemExit("CRL_TOKEN is not set")
    HOME.mkdir(parents=True, exist_ok=True)
    RUNS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=lambda: _guard(install_node), daemon=True).start()
    log(f"control server on :{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


def _guard(fn) -> None:
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - report setup failures through /status
        STATE["node"] = f"error: {e!r}"
        log(f"setup failed: {e!r}")


if __name__ == "__main__":
    main()
