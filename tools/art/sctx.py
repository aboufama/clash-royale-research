"""Decoder for Supercell .sctx textures (FlatBuffer header id "SCTX").

Layout (little endian), per sc-workshop/SupercellTexture and verified on CR 160402020:

    u32 header_len ; FlatBuffer Header (file_identifier "SCTX")
        Header{unk1:u16, pixel_type:u32, width:u16, height:u16, levels_count:u8,
               unk3:u8, flags:u32 (1=zstd, 8=pad16), texture_length:i32,
               unk5:u8, unk6:u8, extensions:{types:[u8], ext:[union]}}
        union 1=Tags{[string]} 2=ASTCEncodingParams{string}
              3=ProxyTexture{pixel_type:u32,width:u16,height:u16,data:[u8]}  (low-res preview)
    u32 mips_len ; repeated (u32 len ; FlatBuffer MipMap{width,height,offset,hash})
    [pad to 16 if flags & 8]
    texture data: zstd frame (if magic 28B52FFD) else raw, decompressed size = texture_length

Pixel types (ScPixel): 204..208 ASTC 4x4..6x6, 210..218 ASTC 8x5..12x12 (linear),
186..200 sRGB ASTC, 178..183 ETC2, 263 ETC1, 70/71 RGBA8, 266 RGB8, ...
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import texture2ddecoder
import zstandard
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fb import read_size_prefixed  # noqa: E402

ASTC_BLOCKS = {
    186: (4, 4), 187: (5, 4), 188: (5, 5), 189: (6, 5), 190: (6, 6),
    192: (8, 5), 193: (8, 6), 194: (8, 8), 195: (10, 5), 196: (10, 6),
    197: (10, 8), 198: (10, 10), 199: (12, 10), 200: (12, 12),
    204: (4, 4), 205: (5, 4), 206: (5, 5), 207: (6, 5), 208: (6, 6),
    210: (8, 5), 211: (8, 6), 212: (8, 8), 213: (10, 5), 214: (10, 6),
    215: (10, 8), 216: (10, 10), 217: (12, 10), 218: (12, 12),
}
PIXEL_NAMES = {70: "RGBA8", 71: "RGBA8_sRGB", 178: "ETC2_EAC_RGBA8", 179: "ETC2_EAC_SRGBA8",
               180: "ETC2_RGB8", 181: "ETC2_SRGB8", 263: "ETC1_RGB8", 266: "RGB8", 1: "A8",
               10: "R8", 30: "RG8", 40: "R5G6B5", 42: "ABGR4"}
for _k, (_bw, _bh) in ASTC_BLOCKS.items():
    PIXEL_NAMES[_k] = f"ASTC{'_sRGB' if _k < 204 else ''}_{_bw}x{_bh}"


@dataclass
class Sctx:
    pixel_type: int
    width: int
    height: int
    flags: int
    texture_length: int
    levels: list = field(default_factory=list)  # (w, h, offset)
    tags: list = field(default_factory=list)
    astc_params: str | None = None
    proxies: list = field(default_factory=list)  # (pixel_type, w, h, bytes)
    data_offset: int = 0
    raw: bytes = b""

    @property
    def pixel_name(self) -> str:
        return PIXEL_NAMES.get(self.pixel_type, str(self.pixel_type))


def parse(data: bytes) -> Sctx:
    if data[8:12] != b"SCTX":
        raise ValueError("not an SCTX file")
    h, p = read_size_prefixed(data, 0)
    tex = Sctx(pixel_type=h.u32(1), width=h.u16(2), height=h.u16(3), flags=h.u32(6),
               texture_length=h.i32(7))
    levels_count = h.u8(4, 1)
    ext = h.table(10)
    if ext:
        for t, tb in zip(ext.bytes(0), ext.vec_tables(1)):
            if t == 1:
                tex.tags = tb.vec_strings(0)
            elif t == 2:
                tex.astc_params = tb.string(0)
            elif t == 3:
                tex.proxies.append((tb.u32(0), tb.u16(1), tb.u16(2), tb.bytes(3)))
    mlen = struct.unpack_from("<I", data, p)[0]
    q, end = p + 4, p + 4 + mlen
    while q < end and len(tex.levels) < levels_count:
        m, q = read_size_prefixed(data, q)
        tex.levels.append((m.u16(0), m.u16(1), m.u32(2)))
    if tex.flags & 8:
        end = (end + 15) & ~15
    tex.data_offset = end
    body = data[end:]
    if body[:4] == b"\x28\xb5\x2f\xfd":
        body = zstandard.ZstdDecompressor().decompress(body, max_output_size=max(tex.texture_length, 1))
    tex.raw = body
    return tex


def decode_pixels(pixel_type: int, w: int, h: int, buf: bytes) -> Image.Image:
    """Decode a GPU/raw pixel buffer to an RGBA PIL image."""
    if pixel_type in ASTC_BLOCKS:
        bw, bh = ASTC_BLOCKS[pixel_type]
        out = texture2ddecoder.decode_astc(buf, w, h, bw, bh)
        return Image.frombytes("RGBA", (w, h), out, "raw", "BGRA")
    if pixel_type in (178, 179):
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc2a8(buf, w, h), "raw", "BGRA")
    if pixel_type in (180, 181):
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc2(buf, w, h), "raw", "BGRA")
    if pixel_type in (182, 183):
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc2a1(buf, w, h), "raw", "BGRA")
    if pixel_type == 263:
        return Image.frombytes("RGBA", (w, h), texture2ddecoder.decode_etc1(buf, w, h), "raw", "BGRA")
    if pixel_type in (70, 71, 72, 73, 74):
        return Image.frombytes("RGBA", (w, h), buf[: w * h * 4])
    if pixel_type in (266, 267):
        return Image.frombytes("RGB", (w, h), buf[: w * h * 3]).convert("RGBA")
    if pixel_type in (1,):
        a = Image.frombytes("L", (w, h), buf[: w * h])
        img = Image.new("RGBA", (w, h), (255, 255, 255, 0))
        img.putalpha(a)
        return img
    if pixel_type in (264,):
        return Image.frombytes("L", (w, h), buf[: w * h]).convert("RGBA")
    if pixel_type in (265,):
        return Image.frombytes("LA", (w, h), buf[: w * h * 2]).convert("RGBA")
    raise NotImplementedError(f"pixel type {pixel_type} ({PIXEL_NAMES.get(pixel_type, '?')})")


def decode(data: bytes, level: int = 0) -> Image.Image:
    tex = parse(data)
    w, h, off = tex.levels[level] if tex.levels else (tex.width, tex.height, 0)
    return decode_pixels(tex.pixel_type, w, h, tex.raw[off:])


def decode_proxy(data: bytes, index: int = 0) -> Image.Image:
    tex = parse(data)
    pt, w, h, buf = tex.proxies[index]
    return decode_pixels(pt, w, h, buf)


def main():
    import argparse

    ap = argparse.ArgumentParser(description="Decode .sctx to PNG")
    ap.add_argument("inputs", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=None, help="output dir (default: alongside)")
    ap.add_argument("--info", action="store_true", help="only print header info")
    args = ap.parse_args()
    for f in args.inputs:
        data = f.read_bytes()
        tex = parse(data)
        print(f"{f.name}: {tex.pixel_name} {tex.width}x{tex.height} flags={tex.flags} "
              f"levels={tex.levels} proxies={[(p[0], p[1], p[2]) for p in tex.proxies]} tags={tex.tags}")
        if args.info:
            continue
        out_dir = args.out or f.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        decode(data).save(out_dir / (f.stem + ".png"))


if __name__ == "__main__":
    main()
