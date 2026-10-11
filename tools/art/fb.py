"""Minimal schema-less FlatBuffers reader.

Supercell's SC2 (.sc v5/v6) and SCTX files are sequences of (size-prefixed)
FlatBuffers. Rather than generating code with flatc, we read fields by index
following the community schemas (see sc-workshop/SupercellFlash sc2_schemas and
sc-workshop/SupercellTexture sctx_schemas).
"""

from __future__ import annotations

import struct

_u8 = struct.Struct("<B")
_u16 = struct.Struct("<H")
_i32 = struct.Struct("<i")
_u32 = struct.Struct("<I")


class Table:
    __slots__ = ("buf", "pos", "vt", "vtlen")

    def __init__(self, buf: bytes | memoryview, pos: int):
        self.buf = buf
        self.pos = pos
        self.vt = pos - _i32.unpack_from(buf, pos)[0]
        self.vtlen = _u16.unpack_from(buf, self.vt)[0]

    @classmethod
    def root(cls, buf, base: int = 0) -> "Table":
        """Root table of an (un-prefixed) flatbuffer starting at `base`."""
        return cls(buf, base + _u32.unpack_from(buf, base)[0])

    # -- field access -----------------------------------------------------
    def _off(self, idx: int) -> int:
        o = 4 + 2 * idx
        if o >= self.vtlen:
            return 0
        return _u16.unpack_from(self.buf, self.vt + o)[0]

    def has(self, idx: int) -> bool:
        return self._off(idx) != 0

    def scalar(self, idx: int, fmt: str, default=0):
        o = self._off(idx)
        if not o:
            return default
        return struct.unpack_from("<" + fmt, self.buf, self.pos + o)[0]

    def u8(self, idx, default=0):
        return self.scalar(idx, "B", default)

    def u16(self, idx, default=0):
        return self.scalar(idx, "H", default)

    def u32(self, idx, default=0):
        return self.scalar(idx, "I", default)

    def i32(self, idx, default=0):
        return self.scalar(idx, "i", default)

    def _indirect(self, idx: int) -> int | None:
        o = self._off(idx)
        if not o:
            return None
        p = self.pos + o
        return p + _u32.unpack_from(self.buf, p)[0]

    def table(self, idx: int) -> "Table | None":
        p = self._indirect(idx)
        return None if p is None else Table(self.buf, p)

    def vector(self, idx: int) -> tuple[int, int]:
        """Returns (start_of_elements, length) or (0, 0)."""
        p = self._indirect(idx)
        if p is None:
            return 0, 0
        n = _u32.unpack_from(self.buf, p)[0]
        return p + 4, n

    def bytes(self, idx: int) -> bytes:
        s, n = self.vector(idx)
        return bytes(self.buf[s : s + n]) if n else b""

    def string(self, idx: int) -> str | None:
        p = self._indirect(idx)
        if p is None:
            return None
        n = _u32.unpack_from(self.buf, p)[0]
        return bytes(self.buf[p + 4 : p + 4 + n]).decode("utf-8", "replace")

    def vec_scalars(self, idx: int, fmt: str) -> list:
        s, n = self.vector(idx)
        if not n:
            return []
        return list(struct.unpack_from("<%d%s" % (n, fmt), self.buf, s))

    def vec_structs(self, idx: int, fmt: str) -> list[tuple]:
        """Vector of structs with a packed struct format (no padding inside)."""
        s, n = self.vector(idx)
        st = struct.Struct("<" + fmt)
        return [st.unpack_from(self.buf, s + i * st.size) for i in range(n)]

    def vec_tables(self, idx: int) -> list["Table"]:
        s, n = self.vector(idx)
        out = []
        for i in range(n):
            p = s + 4 * i
            out.append(Table(self.buf, p + _u32.unpack_from(self.buf, p)[0]))
        return out

    def vec_strings(self, idx: int) -> list[str]:
        s, n = self.vector(idx)
        out = []
        for i in range(n):
            p = s + 4 * i
            q = p + _u32.unpack_from(self.buf, p)[0]
            ln = _u32.unpack_from(self.buf, q)[0]
            out.append(bytes(self.buf[q + 4 : q + 4 + ln]).decode("utf-8", "replace"))
        return out


def read_size_prefixed(buf, pos: int) -> tuple[Table, int]:
    """Read a size-prefixed flatbuffer at `pos`; returns (root_table, next_pos)."""
    size = _u32.unpack_from(buf, pos)[0]
    return Table.root(buf, pos + 4), pos + 4 + size
