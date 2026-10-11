"""Inspect Supercell "FLAT glTF" .glb files (sc3d/**.glb).

These are GLB v2 containers whose first chunk is NOT "JSON" but "FLA2": a
FlatBuffer encoding of the glTF JSON (schema: Daniil-SV/Supercell-Flat-Converter
glTF.fbs, root_type Root), with mesh/animation payloads in the "SC_odin_format"
extension (quantized vertex streams + packed animation tracks) in the BIN chunk.
Stock glTF loaders (three.js GLTFLoader, pygltflib, trimesh) reject them.

  python glb_info.py FILE.glb [...] [--json]   # chunk layout, counts, names, extensions
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

from flatbuffers import flexbuffers

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fb import Table  # noqa: E402

# Root field indices (glTF.fbs `table Root`)
R_ACCESSORS, R_ANIMATIONS, R_ASSET, R_BUFFERVIEWS, R_BUFFERS, R_CAMERAS, R_EXT, R_EXTREQ, \
    R_EXTUSED, R_EXTRAS, R_IMAGES, R_MATERIALS, R_MESHES, R_NODES, R_SAMPLERS, R_SCENE, \
    R_SCENES, R_SKINS, R_TEXTURES = range(19)


def chunks(data: bytes):
    magic, ver, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a GLB")
    pos, out = 12, []
    while pos < min(length, len(data)):
        clen, ctype = struct.unpack_from("<I4s", data, pos)
        out.append((ctype.decode("latin1"), data[pos + 8 : pos + 8 + clen]))
        pos += 8 + clen
    return ver, out


def _flex(tbl: Table, idx: int):
    raw = tbl.bytes(idx)
    if not raw:
        return None
    try:
        return flexbuffers.Loads(raw)
    except Exception as e:  # pragma: no cover - diagnostic only
        return f"<flexbuffer {len(raw)}B: {e}>"


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    ver, chs = chunks(data)
    info = {"file": path.name, "glb_version": ver, "chunks": [(t, len(b)) for t, b in chs]}
    fla = next((b for t, b in chs if t == "FLA2"), None)
    if fla is None:
        info["note"] = "standard JSON glTF" if any(t == "JSON" for t, _ in chs) else "unknown"
        return info
    root = Table.root(fla)
    info["extensionsUsed"] = root.vec_strings(R_EXTUSED)
    info["extensionsRequired"] = root.vec_strings(R_EXTREQ)
    info["counts"] = {k: root.vector(i)[1] for k, i in [
        ("accessors", R_ACCESSORS), ("animations", R_ANIMATIONS), ("bufferViews", R_BUFFERVIEWS),
        ("buffers", R_BUFFERS), ("images", R_IMAGES), ("materials", R_MATERIALS), ("meshes", R_MESHES),
        ("nodes", R_NODES), ("skins", R_SKINS), ("textures", R_TEXTURES)]}
    info["meshes"] = []
    for m in root.vec_tables(R_MESHES):
        info["meshes"].append({"name": m.string(2), "primitives": m.vector(3)[1]})
    info["skins"] = [{"name": s.string(4), "joints": s.vector(3)[1]} for s in root.vec_tables(R_SKINS)]
    info["animations"] = []
    for a in root.vec_tables(R_ANIMATIONS):
        info["animations"].append({"name": a.string(3), "channels": a.vector(0)[1], "samplers": a.vector(4)[1],
                                   "extensions": _flex(a, 1)})
    nodes = root.vec_tables(R_NODES)
    info["node_names"] = [n.string(6) for n in nodes][:40]
    ext = _flex(root, R_EXT)
    if isinstance(ext, dict):
        info["root_extensions"] = {k: (v if len(json.dumps(v, default=str)) < 400 else f"<{type(v).__name__}>")
                                   for k, v in ext.items()}
    return info


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path)
    args = ap.parse_args()
    for f in args.inputs:
        print(json.dumps(inspect(f), indent=1, default=str))


if __name__ == "__main__":
    main()
