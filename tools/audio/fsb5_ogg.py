#!/usr/bin/env python3
"""FSB5 (FMOD sample bank) reader and Vorbis-to-Ogg rebuild, standard library only.

FMOD stores Vorbis samples as bare packets ([u16 size][packet]...) without the Vorbis header
packets; the setup header is identified by a CRC32 (tools/audio/vorbis_setup.py holds the three
setups this build uses). `sample_ogg` wraps one sample in a playable Ogg Vorbis stream: identity,
comment and setup headers, then the audio packets with granule positions computed from each
packet's mode block size (granule += (previous + current) / 4, 0 for the first), the last page
set to the sample's exact length so decoders trim the padding.

  python3 tools/audio/fsb5_ogg.py <file.bank|file.fsb> <out_dir>      # dump every sample
"""
from __future__ import annotations

import base64
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vorbis_setup import SETUPS  # noqa: E402

FREQ = {1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000}
MODE_VORBIS = 15


@dataclass
class Sample:
    index: int
    name: str
    frequency: int
    channels: int
    samples: int  # PCM frames
    data: bytes
    chunks: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return self.samples / self.frequency


@dataclass
class Fsb5:
    mode: int
    samples: list[Sample]


def parse_fsb5(d: bytes, off: int = 0) -> Fsb5:
    if d[off:off + 4] != b"FSB5":
        raise ValueError("not an FSB5 block")
    version, num, shs, nts, ds, mode = struct.unpack_from("<6I", d, off + 4)
    hdr = 0x3C if version == 1 else 0x40
    p = off + hdr
    metas = []
    for i in range(num):
        raw = struct.unpack_from("<Q", d, p)[0]
        p += 8
        nxt = raw & 1
        freq = FREQ.get((raw >> 1) & 0xF, 0)
        ch = ((raw >> 5) & 1) + 1
        doff = ((raw >> 6) & 0xFFFFFFF) * 16
        frames = (raw >> 34) & 0x3FFFFFFF
        chunks = {}
        while nxt:
            c = struct.unpack_from("<I", d, p)[0]
            p += 4
            nxt = c & 1
            size = (c >> 1) & 0xFFFFFF
            ctype = c >> 25
            chunks[ctype] = d[p:p + size]
            p += size
        if 2 in chunks:
            freq = struct.unpack_from("<I", chunks[2])[0]
        if 1 in chunks:
            ch = chunks[1][0]
        metas.append([i, f"{i:04d}", freq, ch, frames, doff, chunks])
    names = off + hdr + shs
    if nts:
        offs = struct.unpack_from(f"<{num}I", d, names)
        for m, o in zip(metas, offs):
            e = d.index(b"\0", names + o)
            m[1] = d[names + o:e].decode("utf-8", "replace")
    data0 = off + hdr + shs + nts
    out = []
    for k, (i, name, freq, ch, frames, doff, chunks) in enumerate(metas):
        end = metas[k + 1][5] if k + 1 < num else ds
        out.append(Sample(i, name, freq, ch, frames, d[data0 + doff:data0 + end], chunks))
    return Fsb5(mode, out)


def fsb5_in_bank(bank: bytes) -> Fsb5 | None:
    """The FSB5 block inside an FMOD Studio bank's SND chunk (None for a bank without samples)."""
    i = bank.find(b"SND ")
    while i >= 0:
        j = bank.find(b"FSB5", i + 8, i + 8 + 64)
        if j >= 0:
            return parse_fsb5(bank, j)
        i = bank.find(b"SND ", i + 4)
    return None


# -- Ogg ---------------------------------------------------------------------------------------

def _crc_table() -> list[int]:
    t = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
        t.append(r & 0xFFFFFFFF)
    return t


_CRC = _crc_table()


def _ogg_crc(b: bytes) -> int:
    c = 0
    for x in b:
        c = ((c << 8) & 0xFFFFFFFF) ^ _CRC[((c >> 24) ^ x) & 0xFF]
    return c


class _OggWriter:
    def __init__(self, serial: int):
        self.serial = serial
        self.seq = 0
        self.out = bytearray()

    def page(self, packets: list[bytes], granule: int, bos=False, eos=False, cont=False) -> None:
        lacing = bytearray()
        body = bytearray()
        for pk in packets:
            n = len(pk)
            while n >= 255:
                lacing.append(255)
                n -= 255
            lacing.append(n)
            body += pk
        assert len(lacing) <= 255
        flags = (1 if cont else 0) | (2 if bos else 0) | (4 if eos else 0)
        hdr = bytearray(b"OggS" + struct.pack("<BBqIII", 0, flags, granule, self.serial, self.seq, 0))
        hdr.append(len(lacing))
        hdr += lacing
        crc = _ogg_crc(bytes(hdr) + bytes(body))
        struct.pack_into("<I", hdr, 22, crc)
        self.out += hdr + body
        self.seq += 1


def _id_header(channels: int, rate: int, bs0: int, bs1: int) -> bytes:
    e0 = bs0.bit_length() - 1
    e1 = bs1.bit_length() - 1
    return b"\x01vorbis" + struct.pack("<IBIiiiBB", 0, channels, rate, 0, 0, 0, e0 | (e1 << 4), 1)


def _comment_header() -> bytes:
    vendor = b"fsb5_ogg"
    return b"\x03vorbis" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0) + b"\x01"


def sample_ogg(s: Sample, serial: int = 1) -> bytes:
    vd = s.chunks.get(11)
    if vd is None:
        raise ValueError("sample has no VORBISDATA chunk")
    crc = struct.unpack_from("<I", vd)[0]
    if crc not in SETUPS:
        raise ValueError(f"unknown Vorbis setup crc {crc} (run gen_vorbis_setup.py)")
    _ch, _rate, bs0, bs1, modes, b64 = SETUPS[crc]
    setup = zlib.decompress(base64.b64decode(b64))
    mode_bits = (len(modes) - 1).bit_length()
    w = _OggWriter(serial)
    w.page([_id_header(s.channels, s.frequency, bs0, bs1)], 0, bos=True)
    w.page([_comment_header(), setup], 0)
    # audio packets
    pkts: list[tuple[bytes, int]] = []
    p, d = 0, s.data
    gran, prev = 0, 0
    while p + 2 <= len(d):
        n = struct.unpack_from("<H", d, p)[0]
        if n == 0:
            break
        pk = d[p + 2:p + 2 + n]
        p += 2 + n
        mode = (pk[0] >> 1) & ((1 << mode_bits) - 1) if mode_bits else 0
        bs = modes[mode] if mode < len(modes) else bs0
        gran = gran + (prev + bs) // 4 if prev else 0
        prev = bs
        pkts.append((pk, gran))
    if not pkts:
        raise ValueError("no audio packets")
    # pages of up to ~4 KiB, granule = last packet's (the final page: the exact sample count)
    page: list[bytes] = []
    size = 0
    last_gran = 0
    for k, (pk, g) in enumerate(pkts):
        if page and (size + len(pk) > 4096 or len(page) * 1 + len(pk) // 255 + 1 > 200):
            w.page(page, last_gran)
            page, size = [], 0
        page.append(pk)
        size += len(pk)
        last_gran = g
    w.page(page, min(last_gran, s.samples) if s.samples else last_gran, eos=True)
    return bytes(w.out)


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    d = src.read_bytes()
    fsb = fsb5_in_bank(d) if src.suffix == ".bank" else parse_fsb5(d, d.find(b"FSB5"))
    if fsb is None:
        print("no samples")
        return
    if fsb.mode != MODE_VORBIS:
        raise SystemExit(f"codec {fsb.mode} not supported")
    out.mkdir(parents=True, exist_ok=True)
    for s in fsb.samples:
        (out / f"{s.index:03d}_{s.name}.ogg").write_bytes(sample_ogg(s))
        print(s.index, s.name, s.channels, s.frequency, f"{s.duration:.3f}s")


if __name__ == "__main__":
    main()
