"""Reject binary research inputs and accidental local/private files in Git.

Exception: game-files/ holds the pinned original game inputs in this private
repository; there only GitHub's per-file size limit is enforced.
"""

from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_SUFFIXES = {
    ".apk",
    ".apkm",
    ".xapk",
    ".aab",
    ".so",
    ".dylib",
    ".dex",
    ".bin",
    ".ecc",
    ".class",
    ".zip",
    ".gz",
    ".jks",
    ".keystore",
    ".pem",
}
FORBIDDEN_ROOTS = {
    "work",
    "artifacts",
    "downloads",
    "local",
    ".venv",
    "venv",
    "node_modules",
}


# The repository is private and deliberately carries the pinned original game
# inputs here. CI separately fails if this directory exists while it is public.
GAME_FILES_ROOT = "game-files"

# The trained agent the Pages viewer plays against (train/crl/export.py; owner request
# 2026-10-12, docs/DECISIONS.md). Network weights, not game data; only this exact path,
# and only an ONNX file under 50 MB.
PUBLISHED_MODEL = "sim/viewer/models/agent.onnx"
PUBLISHED_MODEL_MAX = 50_000_000


def problem(path, data):
    path = PurePosixPath(path)
    if path.parts[0] == GAME_FILES_ROOT:
        if len(data) > 100_000_000:
            return "file exceeds GitHub's 100 MB limit"
        return None
    if str(path) == PUBLISHED_MODEL:
        if len(data) > PUBLISHED_MODEL_MAX or not data.startswith(b"\x08"):
            return "published agent model must be an ONNX protobuf under 50 MB"
        return None
    if path.parts[0] in FORBIDDEN_ROOTS or path.suffix.lower() in FORBIDDEN_SUFFIXES:
        return "local/binary research artifact"
    if path.name == ".env" or path.name.startswith(".env."):
        return "environment configuration"
    if len(data) > 1_000_000:
        return "file exceeds the 1 MB source/evidence limit"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "non-text file"
    if chr(0) in text:
        return "binary content"
    if ("/" + "Users" + "/") in text or ("BEGIN " + "PRIVATE KEY") in text:
        return "local absolute path or private key"
    return None


def main():
    # Include untracked nonignored files so this can run before the first commit.
    names = (
        subprocess.check_output(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    failures = []
    for name in sorted(set(filter(None, names))):
        target = ROOT / name
        if target.is_symlink():
            failures.append((name, "symlink"))
        elif target.is_file():
            reason = problem(name, target.read_bytes())
            if reason:
                failures.append((name, reason))
    for name, reason in failures:
        print(f"{name}: {reason}", file=sys.stderr)
    if failures:
        return 1
    print("Public source/evidence tree check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
