"""Parser for Supercell SC2 (.sc version 5/6, FlatBuffer-based) 2D asset files.

File layout (verified on Clash Royale 160402020):

    "SC" u32le version (5; 6 adds a u16 0 after it)
    u32 descriptor_len ; FlatBuffer Header{translation_precision, scale_precision,
        shape_count, movie_clips_count, texture_count, text_fields_count, unk3,
        header_offset, resources_offset, textures_length, metadata:[{name, hash}],
        compressed_size, external_matrix_bank_size}
    zstd frame -> decompressed stream of size-prefixed FlatBuffers:
        @0                 DataStorage{strings, unk2, unk3, rectangles,
                           movieclips_frame_elements:[u16], shapes_bitmap_poins:[u8],
                           matrix_banks:[{matrices, colors, half_matrices}]}
        @resources_offset  ExportNames, TextFields, Shapes, MovieClips,
                           MovieClipModifiers, Textures
Schemas: sc-workshop/SupercellFlash supercell-flash/sc2_schemas/*.fbs (MIT).
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import zstandard

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fb import Table, read_size_prefixed  # noqa: E402

PRECISION_MUL = {0: 1.0, 1: 1.0, 2: 20.0, 3: 1024.0}


@dataclass
class Matrix:
    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 1.0
    tx: float = 0.0
    ty: float = 0.0

    def mul(self, o: "Matrix") -> "Matrix":
        """self * o : apply o first, then self (column-vector convention)."""
        return Matrix(
            self.a * o.a + self.c * o.b,
            self.b * o.a + self.d * o.b,
            self.a * o.c + self.c * o.d,
            self.b * o.c + self.d * o.d,
            self.a * o.tx + self.c * o.ty + self.tx,
            self.b * o.tx + self.d * o.ty + self.ty,
        )

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return self.a * x + self.c * y + self.tx, self.b * x + self.d * y + self.ty


IDENTITY = Matrix()


@dataclass
class Color:
    """Flash-like color transform; multipliers/adds in 0..1 / 0..255."""
    r_mul: float = 1.0
    g_mul: float = 1.0
    b_mul: float = 1.0
    a_mul: float = 1.0
    r_add: float = 0.0
    g_add: float = 0.0
    b_add: float = 0.0

    def mul(self, o: "Color") -> "Color":
        # apply o first, then self
        return Color(self.r_mul * o.r_mul, self.g_mul * o.g_mul, self.b_mul * o.b_mul,
                     self.a_mul * o.a_mul,
                     min(255.0, self.r_add + o.r_add * self.r_mul),
                     min(255.0, self.g_add + o.g_add * self.g_mul),
                     min(255.0, self.b_add + o.b_add * self.b_mul))


WHITE = Color()


@dataclass
class DrawCommand:
    texture_index: int
    verts: list  # [(x, y, u, v)] u,v in 0..1, triangle strip order


@dataclass
class Shape:
    id: int
    commands: list[DrawCommand]


@dataclass
class Frame:
    count: int
    label: str = ""


@dataclass
class MovieClip:
    id: int
    export_name: str | None
    framerate: int
    children_ids: list[int]
    children_names: list[str]
    children_blend: list[int]
    frames: list[Frame]
    elements: list[tuple[int, int, int]]  # (child_index, matrix_index, color_index)
    bank: int
    scaling_grid: tuple | None = None
    frame_starts: list[int] = field(default_factory=list)


@dataclass
class TextureRef:
    index: int
    external: str | None  # e.g. "sc/chr_knight_0.sctx"
    width: int
    height: int
    pixel_type: int
    fmt: int
    data: bytes | None
    lowres_external: str | None = None


@dataclass
class SC2File:
    version: int
    header: dict
    metadata: list  # [(name, hash)]
    strings: list[str]
    exports: dict[str, int]  # name -> object id
    shapes: dict[int, Shape]
    movieclips: dict[int, MovieClip]
    textfields: dict[int, tuple]
    modifiers: dict[int, int]  # id -> type (38 mask / 39 masked / 40 unmasked)
    textures: list[TextureRef]
    banks: list[tuple[list[Matrix], list[Color]]]


def _parse_banks(storage: Table, tmul: float, smul: float):
    banks = []
    for bt in storage.vec_tables(6):
        mats = [Matrix(*m) for m in bt.vec_structs(0, "6f")]
        half = bt.vec_structs(2, "6h")
        if not mats and half:
            mats = [Matrix(a / smul, b / smul, c / smul, d / smul, tx / tmul, ty / tmul)
                    for a, b, c, d, tx, ty in half]
        cols = []
        # struct ColorTransform {r_mul,g_mul,b_mul,alpha,r_add,g_add,b_add} = 7 bytes
        for rm, gm, bm, am, ra, ga, ba in bt.vec_structs(1, "7B"):
            cols.append(Color(rm / 255, gm / 255, bm / 255, am / 255, ra, ga, ba))
        banks.append((mats, cols))
    return banks


def parse(data: bytes) -> SC2File:
    if data[:2] != b"SC":
        raise ValueError("not an SC file")
    version = struct.unpack_from(">I", data, 2)[0]
    if version <= 4:
        raise NotImplementedError(f"classic SC1 (version {version}) not handled here")
    version = struct.unpack_from("<I", data, 2)[0]
    pos = 6
    if version == 6:
        pos += 2
    dlen = struct.unpack_from("<I", data, pos)[0]
    desc = Table.root(data, pos + 4)
    pos = pos + 4 + dlen
    header = dict(
        translation_precision=desc.u32(0), scale_precision=desc.u32(1),
        shape_count=desc.u32(2), movie_clips_count=desc.u32(3), texture_count=desc.u32(4),
        text_fields_count=desc.u32(5), unk3=desc.u32(6), header_offset=desc.u32(7),
        resources_offset=desc.u32(8), textures_length=desc.u32(9),
        compressed_size=desc.u32(11), external_matrix_bank_size=desc.u32(12),
    )
    metadata = [(t.string(0), t.bytes(1).hex()) for t in desc.vec_tables(10)]
    csize = header["compressed_size"] or (len(data) - pos)
    body = data[pos : pos + csize]
    if body[:4] == b"\x28\xb5\x2f\xfd":
        body = zstandard.ZstdDecompressor().decompress(body, max_output_size=256 * 1024 * 1024)
    if header["external_matrix_bank_size"]:
        raise NotImplementedError("external matrix banks (v6 compressed clips) not yet supported")

    storage, _ = read_size_prefixed(body, 0)
    strings = storage.vec_strings(0)
    rects = storage.vec_structs(3, "4f")
    s_el, n_el = storage.vector(4)
    elements_buf = struct.unpack_from("<%dH" % n_el, body, s_el) if n_el else ()
    s_pts, n_pts = storage.vector(5)
    tmul = PRECISION_MUL.get(header["translation_precision"], 1.0)
    smul = PRECISION_MUL.get(header["scale_precision"], 1.0)
    banks = _parse_banks(storage, tmul, smul)

    p = header["resources_offset"]
    t_exports, p = read_size_prefixed(body, p)
    t_text, p = read_size_prefixed(body, p)
    t_shapes, p = read_size_prefixed(body, p)
    t_clips, p = read_size_prefixed(body, p)
    t_mods, p = read_size_prefixed(body, p)
    t_tex, p = read_size_prefixed(body, p)

    exports = {}
    for oid, ref in zip(t_exports.vec_scalars(0, "H"), t_exports.vec_scalars(1, "I")):
        exports[strings[ref]] = oid

    textfields = {}
    # struct TextField: H H I hhhh I I I I B B B B i  = 40 bytes
    for tf in t_text.vec_structs(0, "HHIhhhhIIIIBBBBi"):
        textfields[tf[0]] = tf

    shapes = {}
    for st in t_shapes.vec_tables(0):
        cmds = []
        for _unk, tex_i, cnt, off in st.vec_structs(1, "4I"):
            verts = []
            for v in range(cnt):
                x, y, u, vv = struct.unpack_from("<ffHH", body, s_pts + (off + v) * 12)
                verts.append((x, y, u / 65535.0, vv / 65535.0))
            cmds.append(DrawCommand(tex_i, verts))
        shapes[st.u16(0)] = Shape(st.u16(0), cmds)

    if version == 6:
        raise NotImplementedError("SC2 v6 compressed movieclips not yet supported")
    movieclips = {}
    for mt in t_clips.vec_tables(0):
        mid = mt.u16(0)
        name_ref = mt.u32(1, None)
        frames = [Frame(c, strings[l] if l < len(strings) else "") for c, l in mt.vec_structs(8, "II")]
        if not frames:
            frames = [Frame(c) for (c,) in mt.vec_structs(12, "H")]
        children = mt.vec_scalars(5, "H")
        cnames = [strings[r] for r in mt.vec_scalars(6, "I")]
        blend = list(mt.bytes(7))
        eoff = mt.u32(9, 0xFFFFFFFF)
        total = sum(f.count for f in frames)
        elements = []
        if eoff != 0xFFFFFFFF:
            for e in range(total):
                i = eoff + 3 * e
                elements.append((elements_buf[i], elements_buf[i + 1], elements_buf[i + 2]))
        starts, acc = [], 0
        for f in frames:
            starts.append(acc)
            acc += f.count
        sg = mt.u32(11, None)
        movieclips[mid] = MovieClip(
            id=mid, export_name=strings[name_ref] if name_ref is not None else None,
            framerate=mt.u8(2), children_ids=children, children_names=cnames,
            children_blend=blend, frames=frames, elements=elements, bank=mt.u32(10),
            scaling_grid=rects[sg] if sg is not None and sg < len(rects) else None,
            frame_starts=starts)

    modifiers = {mid: typ for mid, typ in t_mods.vec_structs(0, "HBx")}

    textures = []
    for i, ts in enumerate(t_tex.vec_tables(0)):
        hi = ts.table(1)
        lo = ts.table(0)
        textures.append(TextureRef(
            index=i, external=hi.string(5), width=hi.u16(2), height=hi.u16(3),
            pixel_type=hi.u8(1), fmt=hi.u8(0), data=hi.bytes(4) or None,
            lowres_external=lo.string(5) if lo else None))

    return SC2File(version, header, metadata, strings, exports, shapes, movieclips,
                   textfields, modifiers, textures, banks)


def summary(sc: SC2File) -> str:
    lines = [f"SC2 v{sc.version} shapes={len(sc.shapes)} clips={len(sc.movieclips)} "
             f"textfields={len(sc.textfields)} modifiers={len(sc.modifiers)} banks={len(sc.banks)} "
             f"precision(t,s)=({sc.header['translation_precision']},{sc.header['scale_precision']})"]
    for t in sc.textures:
        lines.append(f"  texture[{t.index}] {t.width}x{t.height} ext={t.external} lowres={t.lowres_external} "
                     f"fmt={t.fmt} pixel={t.pixel_type} inline={len(t.data) if t.data else 0}")
    for name, oid in sorted(sc.exports.items()):
        mc = sc.movieclips.get(oid)
        if mc:
            lines.append(f"  export {name!r} id={oid} frames={len(mc.frames)} fps={mc.framerate} "
                         f"children={len(mc.children_ids)}")
        else:
            lines.append(f"  export {name!r} id={oid} (non-clip)")
    return "\n".join(lines)


if __name__ == "__main__":
    for f in sys.argv[1:]:
        print(f)
        print(summary(parse(Path(f).read_bytes())))
