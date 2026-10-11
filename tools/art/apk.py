"""Selective reader for the Clash Royale install-time asset pack.

Source = a ZIP (install_time_asset_pack.apk) OR an unpacked directory that
contains `assets/`. Selected by --assets / env CR_ASSETS, defaulting to
<repo>/game-files/asset-pack. Never extracts wholesale: pulls only the requested
members (an .sc plus the textures it references) into extracted/art/raw/.

  python apk.py search knight            # list member names matching a regex
  python apk.py pull sc/chr_knight.sc    # copy .sc + its *.sctx textures to raw/
  python apk.py stats                    # counts/sizes per extension
"""

from __future__ import annotations

import collections
import os
import re
import sys
import zipfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "extracted" / "art" / "raw"
DEFAULT_ASSETS = ROOT / "game-files" / "asset-pack"


class AssetSource:
    """Uniform access to 'assets/...' members in a zip or an unpacked dir."""

    def __init__(self, path: Path):
        self.path = Path(path)
        if self.path.is_file():
            self.zip = zipfile.ZipFile(self.path)
            self.base = None
        elif self.path.is_dir():
            self.zip = None
            self.base = self.path if (self.path / "assets").is_dir() else self.path.parent
            if not (self.base / "assets").is_dir():
                raise FileNotFoundError(f"{self.path} has no assets/ directory")
        else:
            raise FileNotFoundError(f"asset source not found: {self.path} (set CR_ASSETS or --assets)")

    def names(self) -> list[str]:
        if self.zip:
            return self.zip.namelist()
        return [p.relative_to(self.base).as_posix() for p in (self.base / "assets").rglob("*") if p.is_file()]

    def read(self, name: str) -> bytes:
        return self.zip.read(name) if self.zip else (self.base / name).read_bytes()

    def exists(self, name: str) -> bool:
        if self.zip:
            try:
                self.zip.getinfo(name)
                return True
            except KeyError:
                return False
        return (self.base / name).is_file()

    def size(self, name: str) -> int:
        return self.zip.getinfo(name).file_size if self.zip else (self.base / name).stat().st_size


_override: str | None = None


def set_source(path: str | Path | None):
    global _override
    _override = str(path) if path else None
    source.cache_clear()


@lru_cache(maxsize=1)
def source() -> AssetSource:
    return AssetSource(Path(_override or os.environ.get("CR_ASSETS") or DEFAULT_ASSETS))


def member(name: str) -> str:
    """Normalize 'sc/foo.sc' / 'assets/sc/foo.sc' to the member name 'assets/sc/foo.sc'."""
    name = name.lstrip("/")
    return name if name.startswith("assets/") else "assets/" + name


def read(name: str) -> bytes:
    return source().read(member(name))


def exists(name: str) -> bool:
    return source().exists(member(name))


def cached(name: str) -> Path:
    """Copy one member into RAW_DIR (mirroring its path) and return the local path."""
    rel = member(name)[len("assets/"):]
    out = RAW_DIR / rel
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(read(name))
    return out


def pull_sc(name: str) -> Path:
    """Extract an .sc file and every texture file it references."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sc2

    p = cached(name)
    sc = sc2.parse(p.read_bytes())
    base = os.path.dirname(member(name))
    for t in sc.textures:
        for ext in (t.external, t.lowres_external):
            if ext:
                cand = f"{base}/{Path(ext).name}"
                if exists(cand):
                    cached(cand)
                else:
                    print(f"warning: texture {ext} not in pack", file=sys.stderr)
    return p


def search(pattern: str) -> list[str]:
    rx = re.compile(pattern, re.I)
    return [n for n in source().names() if rx.search(n)]


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--assets", help="zip or unpacked dir (default: $CR_ASSETS or <repo>/game-files/asset-pack)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("pattern")
    p = sub.add_parser("pull")
    p.add_argument("names", nargs="+")
    sub.add_parser("stats")
    args = ap.parse_args()
    set_source(args.assets)
    if args.cmd == "search":
        for n in search(args.pattern):
            print(n, source().size(n))
    elif args.cmd == "pull":
        for n in args.names:
            print(pull_sc(n) if n.endswith(".sc") else cached(n))
    elif args.cmd == "stats":
        c, sz = collections.Counter(), collections.Counter()
        for n in source().names():
            ext = n.rsplit(".", 1)[-1] if "." in n.rsplit("/", 1)[-1] else ""
            c[ext] += 1
            sz[ext] += source().size(n)
        for k, v in c.most_common():
            print(f"{k:12s} {v:6d} {sz[k] / 1e6:9.1f} MB")


if __name__ == "__main__":
    main()
