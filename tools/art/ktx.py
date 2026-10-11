"""KTX1 / KTX2 decoder (ASTC / ETC / raw) -> RGBA PNG.

In CR 160402020 every .ktx (1387 files, all under sc3d/) is KTX2 with no
supercompression, vkFormat ASTC: 157/158 (4x4), 165/166 (6x6), 171/172 (8x8),
odd = UNORM, even = SRGB, with full mip chains.
  python ktx.py FILE.ktx [...] [-o OUTDIR] [--info]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import texture2ddecoder
from PIL import Image

KTX2_ID = b"\xabKTX 20\xbb\r\n\x1a\n"
KTX1_ID = b"\xabKTX 11\xbb\r\n\x1a\n"

# Vulkan ASTC formats: 157 + 2*i (UNORM) / +1 (SRGB)
_ASTC_SIZES = [(4, 4), (5, 4), (5, 5), (6, 5), (6, 6), (8, 5), (8, 6), (8, 8),
               (10, 5), (10, 6), (10, 8), (10, 10), (12, 10), (12, 12)]
VK_ASTC = {}
for _i, _bs in enumerate(_ASTC_SIZES):
    VK_ASTC[157 + 2 * _i] = _bs
    VK_ASTC[158 + 2 * _i] = _bs
VK_NAMES = {37: "R8G8B8A8_UNORM", 43: "R8G8B8A8_SRGB", 147: "ETC2_R8G8B8_UNORM",
            148: "ETC2_R8G8B8_SRGB", 151: "ETC2_R8G8B8A8_UNORM", 152: "ETC2_R8G8B8A8_SRGB"}
for _k, _v in VK_ASTC.items():
    VK_NAMES[_k] = f"ASTC_{_v[0]}x{_v[1]}_{'UNORM' if _k % 2 else 'SRGB'}"

# GL internal formats used by KTX1
GL_ASTC = {0x93B0 + i: bs for i, bs in enumerate(_ASTC_SIZES)}
GL_ASTC.update({0x93D0 + i: bs for i, bs in enumerate(_ASTC_SIZES)})


def info(data: bytes) -> dict:
    if data[:12] == KTX2_ID:
        vk, ts, w, h, d, layers, faces, levels, scheme = struct.unpack_from("<9I", data, 12)
        lv = [struct.unpack_from("<3Q", data, 80 + 24 * i) for i in range(max(levels, 1))]
        return dict(container="KTX2", vkFormat=vk, format=VK_NAMES.get(vk, str(vk)), width=w,
                    height=h, levels=levels, supercompression=scheme, level_index=lv)
    if data[:12] == KTX1_ID:
        (endian, gltype, gltypesize, glformat, glinternal, glbase, w, h, d, arr, faces, levels,
         kvlen) = struct.unpack_from("<13I", data, 12)
        return dict(container="KTX1", glInternalFormat=glinternal, width=w, height=h,
                    levels=levels, kv=kvlen)
    raise ValueError("not a KTX file")


def _decode(buf: bytes, w: int, h: int, astc=None, fmt_name="") -> Image.Image:
    if astc:
        bw, bh = astc
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_astc(buf, w, h, bw, bh), "raw", "BGRA")
    if "ETC2_R8G8B8A8" in fmt_name:
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc2a8(buf, w, h), "raw", "BGRA")
    if "ETC2_R8G8B8" in fmt_name:
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc2(buf, w, h), "raw", "BGRA")
    if "R8G8B8A8" in fmt_name:
        return Image.frombytes("RGBA", (w, h), buf[: w * h * 4])
    raise NotImplementedError(fmt_name)


def decode(data: bytes, level: int = 0) -> Image.Image:
    meta = info(data)
    if meta["container"] == "KTX2":
        off, length, _ = meta["level_index"][level]
        buf = data[off : off + length]
        if meta["supercompression"] == 2:
            import zstandard
            buf = zstandard.ZstdDecompressor().decompress(buf, max_output_size=64 << 20)
        elif meta["supercompression"]:
            raise NotImplementedError(f"KTX2 supercompression {meta['supercompression']}")
        w, h = max(1, meta["width"] >> level), max(1, meta["height"] >> level)
        return _decode(buf, w, h, VK_ASTC.get(meta["vkFormat"]), meta["format"])
    # KTX1
    off = 64 + meta["kv"]
    w, h = meta["width"], meta["height"]
    for _ in range(level):
        size = struct.unpack_from("<I", data, off)[0]
        off += 4 + ((size + 3) & ~3)
        w, h = max(1, w >> 1), max(1, h >> 1)
    size = struct.unpack_from("<I", data, off)[0]
    buf = data[off + 4 : off + 4 + size]
    gi = meta["glInternalFormat"]
    if buf[:4] == b"\x28\xb5\x2f\xfd":
        import zstandard
        buf = zstandard.ZstdDecompressor().decompress(buf, max_output_size=64 << 20)
    name = {0x9278: "ETC2_R8G8B8_UNORM", 0x9274: "ETC2_R8G8B8_UNORM", 0x9278 + 0: "ETC2_R8G8B8A8_UNORM",
            0x8058: "R8G8B8A8"}.get(gi, hex(gi))
    return _decode(buf, w, h, GL_ASTC.get(gi), name)


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument("--info", action="store_true")
    args = ap.parse_args()
    for f in args.inputs:
        data = f.read_bytes()
        m = info(data)
        m.pop("level_index", None)
        print(f.name, m)
        if not args.info:
            out = args.out or f.parent
            out.mkdir(parents=True, exist_ok=True)
            decode(data).save(out / (f.stem + ".png"))


if __name__ == "__main__":
    sys.exit(main())
