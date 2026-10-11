"""Reject binary research inputs and accidental local/private files in Git."""

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


def problem(path, data):
    path = PurePosixPath(path)
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
