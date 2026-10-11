#!/usr/bin/env python3
"""Decode gameplay data files from the Clash Royale install-time asset pack.

Usage:
  python3 -I tools/data/decode_assets.py [SOURCE] [OUT_DIR]

SOURCE may be the install_time_asset_pack.apk (ZIP) or an UNPACKED asset-pack
directory (containing assets/csv_logic/...). Resolution order: CLI arg, env
CR_ASSETS, default <repo>/game-files/asset-pack. OUT_DIR defaults to
<repo>/extracted/data/raw.

Extracts assets/csv_logic, csv_client, locations, tilemaps, level, plus a few
root data files, decoding each one. Supported container formats (auto-detected):
  * Supercell 9-byte-header LZMA: props 5d 00 00 04 00 + uint32 LE output size
    (an LZMA-alone stream whose 8-byte length was truncated to 4 bytes).
  * "Sig:" prefixed files (4 bytes magic + 64-byte signature) followed by one
    of the formats here.
  * "SC" header files (2 bytes "SC", uint32 BE version, [uint32 BE hash len +
    hash]) followed by LZMA / zstd.
  * zstd frames (28 b5 2f fd), via the optional `zstandard` module.
  * Plain text (left unchanged).
Writes a manifest.json listing the codec used for every file.
Data stays local; nothing is uploaded.
"""

import json
import lzma
import os
import sys
import zipfile
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO / "game-files" / "asset-pack"
DEFAULT_OUT = REPO / "extracted" / "data" / "raw"

SC_LZMA_PROPS = bytes.fromhex("5d00000400")
ZSTD_MAGIC = bytes.fromhex("28b52ffd")
PREFIXES = (
    "assets/csv_logic/",
    "assets/csv_client/",
    "assets/locations/",
    "assets/tilemaps/",
    "assets/level/",
)
ROOT_FILES = (
    "assets/data_manifest.toml",
    "assets/settings.csv",
    "assets/offline_emotes.csv",
    "assets/build.tag",
    "assets/version.number",
)
MAX_OUT = 64 * 1024 * 1024


def sc_lzma(data: bytes) -> bytes:
    expected = int.from_bytes(data[5:9], "little")
    if expected > MAX_OUT:
        raise ValueError("declared size too large")
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE)
    out = dec.decompress(data[:9] + bytes(4) + data[9:], max_length=expected + 1)
    if len(out) != expected:
        raise ValueError(f"length mismatch {len(out)} != {expected}")
    return out


def zstd(data: bytes) -> bytes:
    try:
        import zstandard  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ValueError("zstd frame found but `zstandard` module missing") from exc
    return zstandard.ZstdDecompressor().decompress(data, max_output_size=MAX_OUT)


def decode(data: bytes, depth: int = 0):
    """Return (decoded bytes, codec description)."""
    if depth > 3:
        raise ValueError("nested container depth exceeded")
    if data.startswith(b"Sig:"):
        inner, codec = decode(data[68:], depth + 1)
        return inner, "sig+" + codec
    if data[:5] == SC_LZMA_PROPS:
        return sc_lzma(data), "sc_lzma"
    if data.startswith(ZSTD_MAGIC):
        return zstd(data), "zstd"
    if data.startswith(b"SC") and len(data) > 30:
        version = int.from_bytes(data[2:6], "big")
        off = 6
        if version >= 4:  # newer SC files: extra version word
            version = int.from_bytes(data[6:10], "big")
            off = 10
        hlen = int.from_bytes(data[off:off + 4], "big")
        body = data[off + 4 + hlen:]
        inner, codec = decode(body, depth + 1)
        return inner, f"sc_v{version}+" + codec
    return data, "plain"


def iter_source(src: Path):
    """Yield (archive-style name 'assets/...', bytes) from a zip or directory."""
    if src.is_dir():
        base = src if (src / "assets").is_dir() else src.parent
        if not (base / "assets").is_dir():
            raise SystemExit(f"{src}: no assets/ directory found")
        for p in sorted((base / "assets").rglob("*")):
            if p.is_file() and not p.is_symlink():
                yield p.relative_to(base).as_posix(), p
    else:
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                if not info.is_dir():
                    yield info.filename, (z, info)


def read_item(item):
    if isinstance(item, Path):
        return item.read_bytes()
    z, info = item
    return z.read(info)


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__)
        return
    src = Path(args[0] if args else os.environ.get("CR_ASSETS", DEFAULT_SOURCE))
    out = Path(args[1] if len(args) > 1 else DEFAULT_OUT).resolve()
    if not src.exists():
        raise SystemExit(f"asset source not found: {src} (set CR_ASSETS or pass a path)")
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"source": src.name, "files": {}}
    errors = []
    for name, item in iter_source(src):
        if not (name.startswith(PREFIXES) or name in ROOT_FILES):
            continue
        rel = PurePosixPath(name).relative_to("assets")
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError(f"unsafe path {name}")
        raw = read_item(item)
        try:
            data, codec = decode(raw)
        except Exception as exc:  # keep going, report at end
            errors.append({"file": str(rel), "error": str(exc)})
            continue
        target = (out / rel).resolve()
        if not target.is_relative_to(out):
            raise ValueError(f"path escapes output: {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        manifest["files"][str(rel)] = {"codec": codec, "packed_bytes": len(raw), "bytes": len(data)}
    manifest["errors"] = errors
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    codecs = {}
    for f in manifest["files"].values():
        codecs[f["codec"]] = codecs.get(f["codec"], 0) + 1
    print(f"decoded {len(manifest['files'])} files, codecs={codecs}, errors={len(errors)}")
    for e in errors:
        print("ERROR", e)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
