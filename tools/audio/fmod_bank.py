#!/usr/bin/env python3
"""FMOD Studio bank (.bank, format 0x8e) metadata reader, standard library only.

Reads the parts of the event model the viewer plays: events, their timelines, instruments
(waveform, multi, silence, command, event), instrument properties, random/AHDSR modulators,
loop transitions and the waveform -> FSB5 subsound table, plus the strings bank (path -> GUID).
The mixer too: buses (input / group / return / event master / port: output, fader volume, effect
chain, VCAs, instance limit and stealing), built-in effects with their parameter values, sidechain
effects, VCAs, snapshots (what they set) and parameters (name, range, flags).

The chunk layouts were read off libfmodstudio.so's bank loader (the APK's own FMOD build), see
docs/DECISIONS.md: every body is a fixed sequence of typed reads gated by the bank version.
Arrays are a varint16 header (count << 1 | sameSize) followed by u16 element sizes (once when
sameSize, else before every element). GUIDs are 16 bytes (Data1 u32, Data2 u16, Data3 u16, 8 bytes).
Addresses below are libfmodstudio.so's with Ghidra's image base 0x100000 (file offset + 0x100000).

  python3 tools/audio/fmod_bank.py <bank> [strings.bank]     # dump the events and the mixer as JSON
"""
from __future__ import annotations

import json
import struct
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path


def guid(b: bytes, o: int = 0) -> str:
    return str(uuid.UUID(bytes_le=bytes(b[o:o + 16])))


ZERO = "00000000-0000-0000-0000-000000000000"


class Rd:
    """Little-endian cursor over one chunk body."""

    def __init__(self, b: bytes):
        self.b = b
        self.p = 0

    def u8(self) -> int:
        v = self.b[self.p]
        self.p += 1
        return v

    def u16(self) -> int:
        v = struct.unpack_from("<H", self.b, self.p)[0]
        self.p += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.b, self.p)[0]
        self.p += 4
        return v

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.b, self.p)[0]
        self.p += 4
        return v

    def f32(self) -> float:
        v = struct.unpack_from("<f", self.b, self.p)[0]
        self.p += 4
        return v

    def guid(self) -> str:
        v = guid(self.b, self.p)
        self.p += 16
        return v

    def varint(self) -> int:  # 0x12d4e0
        v = self.u16()
        if v & 0x8000:
            v = (v & 0x7FFF) | (self.u16() << 15)
        return v

    def array(self, elem) -> list:
        """riffstream array: header, then elements (each parsed by `elem(Rd)` on its own bytes)."""
        hdr = self.varint()
        n, same = hdr >> 1, hdr & 1
        out = []
        size = 0
        for _ in range(n):
            if not same or size == 0:
                size = self.u16()
            out.append(elem(Rd(self.b[self.p:self.p + size])))
            self.p += size
        return out


# -- RIFF tree ----------------------------------------------------------------------------------

@dataclass
class Node:
    id: str
    data: bytes = b""
    kids: list["Node"] = field(default_factory=list)

    def get(self, cid: str) -> "Node | None":
        for k in self.kids:
            if k.id == cid:
                return k
        return None

    def all(self, cid: str) -> list["Node"]:
        return [k for k in self.kids if k.id == cid]


def riff(d: bytes, off: int, end: int) -> list[Node]:
    out = []
    while off + 8 <= end:
        cid = d[off:off + 4].decode("latin-1")
        size = struct.unpack_from("<I", d, off + 4)[0]
        body = off + 8
        if cid in ("RIFF", "LIST"):
            out.append(Node(d[body:body + 4].decode("latin-1"), b"", riff(d, body + 4, body + size)))
        else:
            out.append(Node(cid, d[body:body + size]))
        off = body + size + (size & 1)
    return out


# -- chunk bodies -------------------------------------------------------------------------------

def parse_evtb(b: bytes) -> dict:
    """EVTB (0x1b1590)."""
    r = Rd(b)
    e = {"guid": r.guid()}
    e["snapshot"] = r.guid()  # +0x60: a snapshot event's SNAB (zero for other events)
    e["timeline"] = r.guid()  # +0x30
    e["inputBus"] = r.guid()  # +0x40
    e["masterTrack"] = r.guid()  # +0x50
    e["maxInstances"] = r.u32()  # +0xd8
    e["priority"] = r.u32()  # +0xdc
    r.u8()  # +0xe8 (legacy flag)
    e["stealing"] = r.u32()  # +0xe4
    r.array(lambda x: x.guid())  # +0x80
    r.array(lambda x: None)  # +0xb0
    r.array(lambda x: None)  # +0xc0
    e["fe0"] = r.f32()  # +0xe0
    e["ue8"] = r.u32()  # +0xe8
    e["cooldown"] = r.f32()  # +0xec
    e["flags"] = r.u32()  # +0xf8
    e["outputs"] = r.array(lambda x: x.guid())  # +0x70
    r.array(lambda x: None)  # +0x90
    r.array(lambda x: None)  # +0xa0
    e["minDistance"] = r.f32()
    e["maxDistance"] = r.f32()
    return e


def parse_tlnb(b: bytes) -> dict:
    """TLNB (0x1b2580): instrument placements (guid, start, length in 48 kHz frames) and markers."""
    r = Rd(b)
    t = {"guid": r.guid()}

    def place(x: Rd):
        return {"inst": x.guid(), "start": x.u32(), "length": x.u32()}

    t["a"] = r.array(place)  # +0x38
    t["inst"] = r.array(place)  # +0x48
    r.array(lambda x: None)  # +0x58 (v >= 0x84)

    def marker(x: Rd):  # 0x1b2de0
        m = {"guid": x.guid(), "pos": x.u32()}
        n = x.u16()
        m["name"] = x.b[x.p:x.p + n].decode("utf-8", "replace")
        x.p += n
        if x.p + 4 <= len(x.b):
            m["length"] = x.u32()
        return m

    t["markers"] = r.array(marker)  # +0x78
    t["regions"] = r.array(lambda x: x.b.hex())  # +0x88
    return t


def parse_trnb(b: bytes) -> dict:
    r = Rd(b)
    return {"guid": r.guid(), "dest": r.guid(), "start": r.u32(), "end": r.u32(),
            "probability": struct.unpack_from("<f", b, 52)[0] if len(b) >= 56 else 100.0,
            "conditions": len(b) > 60}


def parse_inst(b: bytes) -> dict:
    """INST (0x1b6034) for bank version >= 0x82."""
    r = Rd(b)
    i = {"owner": r.guid()}  # +0x60
    i["volume"] = r.f32()  # +0x90 dB
    i["pitch"] = r.f32()  # +0xa4 semitones
    i["loopCount"] = r.i32()  # +0xb0 (-1 = loop)
    i["flags"] = r.u32()  # +0xb8
    i["startOffset"] = r.f32()  # +0x94 %
    i["probability"] = r.f32()  # +0x98 %
    i["delayMin"] = r.f32()  # +0x80 ms
    i["delayMax"] = r.f32()
    i["quantType"] = r.i32()  # +0x88
    i["quantN"] = r.u32()
    r.guid()  # +0x70
    i["fa8"] = r.f32()
    i["f9c"] = r.f32()
    i["polyphony"] = r.u32()  # +0xb4
    sz = r.u16()  # +0x30 element (0x1af1b0)
    sub = Rd(b[r.p:r.p + sz])
    r.p += sz
    i["output"] = sub.guid()
    i["ubc"] = r.u32()
    i["uc0"] = r.u32()
    i["fa0"] = r.f32()
    i["fac"] = r.f32()
    return i


def parse_modb(b: bytes) -> dict:
    """MODB (0x1a7b64): owner, modulated property, type 0 AHDSR / 1 random / 2 LFO-like."""
    r = Rd(b)
    r.u16()  # element size (v > 0x54)
    m = {"guid": r.guid(), "owner": r.guid(), "prop": r.u32(), "type": r.u32()}
    m["mode"] = r.i32()  # 0x1a9b10 (v >= 0x55)
    rest = b[r.p:]
    if m["type"] == 1 and len(rest) >= 4:
        m["amount"] = struct.unpack_from("<f", rest, 0)[0]
    else:
        m["raw"] = rest.hex()
        if m["type"] == 0 and len(rest) >= 44:
            f = struct.unpack_from("<11f", rest, 0)
            m["ahdsr"] = f
    return m


# -- mixer ------------------------------------------------------------------------------------
# Bus records (LIST IBUS/GBUS/RBUS/MBUS/PORT) all go through 0x1aefc8 (the wrappers 0x1aefb0 IBUS,
# 0x1af918 GBUS, 0x1afb34 RBUS, 0x1aff74 MBUS, 0x1afd50 PORT): a body chunk (IBSB/GBSB/RBSB/MBSB/PRTB)
# with the bus GUID and its output, then the shared BUS chunk, then PRPS.

INT_MAX = 0x7FFFFFFF
BUS_KINDS = {"IBSS": ("IBUS", "IBSB", "input"), "GBSS": ("GBUS", "GBSB", "group"), "RBSS": ("RBUS", "RBSB", "return"),
             "MBSS": ("MBUS", "MBSB", "master"), "PRTS": ("PORT", "PRTB", "port")}


def parse_bus_head(b: bytes) -> dict:
    """xBSB (0x1aefc8): bus GUID (+0x10), then the output element 0x1af1b0 at +0x48: output bus GUID,
    channel format (0x1af220, +8) and a u32 (+0xc)."""
    r = Rd(b)
    h = {"guid": r.guid(), "output": ZERO}
    if r.p + 2 <= len(b):
        sz = r.u16()
        sub = Rd(b[r.p:r.p + sz])
        h["output"] = sub.guid()
        h["outFormat"] = sub.u32()
    return h


def parse_bus(b: bytes) -> dict:
    """BUS (0x1aefc8, bank version >= 0x8c): the bus model's mixing properties.

    +0xc4 flags (u32), +0xc0 channel format (0x1af220), +0x80 and +0x90 effect GUID arrays (0x1af3bc, in
    signal order; +0x80 ahead of the fader, +0x90 after it, judging by bus:/Reverb's SFX reverb in +0x80
    and the buses' panners in +0x90), the fader element 0x1af290 (+0x30 volume dB, +0x34, then +0x38 the
    VCAs controlling the bus, 0x1af49c), +0xcc max instances and +0xd0 stealing (0x1aed84; read by the
    instance limiter 0x13a460 / 0x13a570: INT_MAX = no limit; 0 none, 1 virtualize, 2 oldest,
    3 furthest, 4 quietest), +0xa0 / +0xb0 u32 arrays (0x1af584: a channel format per +0x80 / +0x90
    effect), +0xc8 (0x1aed84, v >= 0x6f) and +0xd4 (0x1af648, v >= 0x8c)."""
    r = Rd(b)
    o: dict = {"flags": r.u32(), "format": r.u32()}
    o["preEffects"] = r.array(lambda x: x.guid())
    o["effects"] = r.array(lambda x: x.guid())
    sz = r.u16()
    fader = Rd(b[r.p:r.p + sz])
    r.p += sz
    o["volume"] = fader.f32()
    o["f34"] = fader.f32()
    o["vcas"] = r.array(lambda x: x.guid())
    o["maxInstances"] = r.i32()
    o["stealing"] = r.u32()
    o["preEffectFormats"] = r.array(lambda x: x.u32())
    o["effectFormats"] = r.array(lambda x: x.u32())
    o["c8"] = r.i32()
    o["d4"] = r.u32()
    return o


def parse_pmef(b: bytes) -> list:
    """PMEF (0x1a7710): u32 count (< 0x400), then per parameter a u32 type (0x1a9910) and its value
    (0x1a744c: 0 float, 1 int, 2 bool u8, 3 data = varint size + bytes), then a u8 (+0x5c, v >= 0x6e)."""
    r = Rd(b)
    out = []
    for _ in range(min(r.u32(), 0x400)):
        t = r.u32()
        if t == 0:
            out.append(round(r.f32(), 6))
        elif t == 1:
            out.append(r.i32())
        elif t == 2:
            out.append(bool(r.u8()))
        else:
            n = r.varint()
            out.append(r.b[r.p:r.p + n].hex())
            r.p += n
    if r.p < len(b):
        r.u8()  # +0x5c
    return out


def parse_befb(b: bytes) -> dict:
    """BEFB (0x1b024c): effect GUID (+0x10), DSP type (0x1b0380, FMOD_DSP_TYPE, matching the parameter
    counts: 18 compressor, 19 SFX reverb, 27 pan, 28 three-EQ, 36 multiband EQ), a u8 (+0x40, v >= 0x3d)."""
    r = Rd(b)
    return {"guid": r.guid(), "type": r.u32(), "u40": r.u8() if r.p < len(b) else 0}


def parse_scef(b: bytes) -> dict:
    """SCEF (0x1b0cd4, a sidechain effect inside LIST SCFF): GUID (+0x10), u8 (+0x6c), the effects it
    feeds as a sidechain input (+0x48, e.g. compressors with USESIDECHAIN), the sidechain modulators it
    drives (+0x58, 0x1a9568, v >= 0x53), a float (+0x68, v >= 0x88)."""
    r = Rd(b)
    s = {"guid": r.guid(), "u6c": r.u8()}
    s["targets"] = r.array(lambda x: x.guid())
    s["modulators"] = r.array(lambda x: x.guid())
    s["f68"] = r.f32() if r.p + 4 <= len(b) else 0.0
    return s


def parse_vcab(b: bytes) -> dict:
    """VCAB (0x1b1064): VCA GUID (+0x10), what it controls (+0x58: buses / VCAs, 0x1b10d8), its fader
    element (0x1af290: volume dB, +0x34, parent VCAs)."""
    r = Rd(b)
    v = {"guid": r.guid(), "controls": r.array(lambda x: x.guid())}
    sz = r.u16()
    fader = Rd(b[r.p:r.p + sz])
    r.p += sz
    v["volume"] = fader.f32()
    v["parents"] = r.array(lambda x: x.guid())
    return v


def parse_snab(b: bytes) -> dict:
    """SNAB (0x1b85b8): snapshot GUID (+0x10), u32 (+0x44), the properties it sets (+0x30, 0x1b86c0 ->
    0x1a8240: property key, target bus / effect GUID, property index, value), u8 (+0x48), i32 (+0x4c,
    -1..6, 0x1b88e4), intensity % (+0x40, v >= 0x33)."""
    r = Rd(b)
    s = {"guid": r.guid(), "u44": r.u32()}

    def ent(x: Rd) -> dict:
        return {"key": x.u32(), "target": x.guid(), "index": x.u32(), "value": round(x.f32(), 4)}

    s["entries"] = r.array(ent)
    s["u48"] = r.u8()
    s["u4c"] = r.i32()
    s["intensity"] = r.f32()
    return s


def parse_prmb(b: bytes) -> dict:
    """PRMB (0x1b4458): parameter GUID (+0x10), flags (+0x34, v >= 0x70: bit 0 global, bit 3 discrete),
    type (+0x30), name (0x1b0858), min (+0x38), max (+0x3c), default (+0x4c), +0x40, +0x44, +0x48."""
    r = Rd(b)
    p = {"guid": r.guid(), "flags": r.u32(), "type": r.u32()}
    n = r.u16()
    p["name"] = b[r.p:r.p + n].decode("utf-8", "replace").rstrip("\0")
    r.p += n
    p["min"], p["max"], p["default"], p["f40"], p["f44"] = (round(r.f32(), 4) for _ in range(5))
    p["f48"] = round(r.f32(), 4)
    if r.p + 2 <= len(b):
        p["labels"] = r.array(lambda x: x.b.hex())  # +0x60 (0x1b4794, v >= 0x8b): empty in this build
    return p


def bus_chain(buses: dict, start: str) -> list[dict]:
    """The buses a signal passes from `start` up to the master bus (each bus's `output`)."""
    out, seen, g = [], set(), start
    while g in buses and g not in seen:
        seen.add(g)
        out.append(buses[g])
        g = buses[g]["output"]
    return out


@dataclass
class Bank:
    path: str
    events: dict = field(default_factory=dict)  # guid -> evtb
    timelines: dict = field(default_factory=dict)
    instruments: dict = field(default_factory=dict)  # guid -> {kind, inst, ...}
    waveforms: dict = field(default_factory=dict)  # guid -> subsound index
    modulators: list = field(default_factory=list)
    strings: dict = field(default_factory=dict)
    version: int = 0
    buses: dict = field(default_factory=dict)  # guid -> {kind, guid, output, volume, effects, maxInstances, ...}
    effects: dict = field(default_factory=dict)  # guid -> builtin {type, params} | sidechain {targets, ...}
    vcas: dict = field(default_factory=dict)
    snapshots: dict = field(default_factory=dict)  # SNAB guid -> {entries}
    parameters: dict = field(default_factory=dict)


def parse_mixer(proj: Node, bank: Bank) -> None:
    """Buses, effects, VCAs, snapshots and parameters (layouts for bank version >= 0x8c, as this build's)."""
    if bank.version and bank.version < 0x8C:
        return
    for lst, (item, body, kind) in BUS_KINDS.items():
        ln = proj.get(lst)
        for it in (ln.all(item) if ln else []):
            hb, bb = it.get(body), it.get("BUS ")
            if hb is None or bb is None:
                continue
            bus = {"kind": kind, **parse_bus_head(hb.data), **parse_bus(bb.data)}
            bank.buses[bus["guid"]] = bus
    lst = proj.get("BEFX")
    for it in (lst.all("BEFF") if lst else []):
        e = {"kind": "builtin", **parse_befb(it.get("BEFB").data)}
        pm = it.get("PMEF")
        e["params"] = parse_pmef(pm.data) if pm is not None else []
        bank.effects[e["guid"]] = e
    lst = proj.get("SCFX")
    for it in (lst.all("SCFF") if lst else []):
        sc = it.get("SCEF")
        if sc is not None:
            e = {"kind": "sidechain", **parse_scef(sc.data)}
            bank.effects[e["guid"]] = e
    for lst_id, item, body, kind in (("PEFX", "PEFF", "PEFB", "plugin"), ("SEFX", "SEFF", "SEFB", "send")):
        lst = proj.get(lst_id)
        for it in (lst.all(item) if lst else []):  # none in this build's banks: kept raw
            bb = it.get(body)
            if bb is not None:
                bank.effects[guid(bb.data)] = {"kind": kind, "guid": guid(bb.data), "raw": bb.data.hex()}
    lst = proj.get("VCAS")
    for it in (lst.all("VCA ") if lst else []):
        vb = it.get("VCAB")
        if vb is not None:
            v = parse_vcab(vb.data)
            bank.vcas[v["guid"]] = v
    lst = proj.get("SNAS")
    for it in (lst.all("SNAP") if lst else []):
        sb = it.get("SNAB")
        if sb is not None:
            s = parse_snab(sb.data)
            bank.snapshots[s["guid"]] = s
    lst = proj.get("PRMS")
    for it in (lst.all("PARM") if lst else []):
        pb = it.get("PRMB")
        if pb is not None:
            p = parse_prmb(pb.data)
            bank.parameters[p["guid"]] = p


def parse_bank(path: str | Path) -> Bank:
    d = Path(path).read_bytes()
    top = riff(d, 0, len(d))[0]
    proj = top.get("PROJ")
    bank = Bank(str(path))
    fmt = top.get("FMT ")
    if fmt is not None and len(fmt.data) >= 4:
        bank.version = struct.unpack_from("<I", fmt.data, 0)[0]
    if proj is None:
        return bank
    parse_mixer(proj, bank)
    evts = proj.get("EVTS")
    for ev in (evts.all("EVNT") if evts else []):
        e = parse_evtb(ev.get("EVTB").data)
        bank.events[e["guid"]] = e
    tlns = proj.get("TLNS")
    for tm in (tlns.all("TMLN") if tlns else []):
        t = parse_tlnb(tm.get("TLNB").data)
        trns = tm.get("TRNS")
        t["transitions"] = [parse_trnb(x.get("TRNB").data) for x in trns.all("TRAN")] if trns else []
        bank.timelines[t["guid"]] = t

    def inst_of(n: Node) -> dict:
        return parse_inst(n.get("INST").data)

    lists = {"MUIS": ("MUIT", "MUIB", "multi"), "WAIS": ("WAIT", "WAIB", "wave"), "SLNS": ("SLNI", "SLNB", "silence"),
             "CMDS": ("CMDI", "CMDB", "command"), "EVIS": ("EVIT", "EVIB", "event"), "SPIS": ("SPIT", "SPIB", "scatterer"),
             "PRIS": ("PRIT", "PRIB", "programmer"), "EFIS": ("EFIT", "EFIB", "effect"), "SNAS": ("SNAP", "SNAB", "snapshot")}
    for lst, (item, body, kind) in lists.items():
        ln = proj.get(lst)
        for it in (ln.all(item) if ln else []):
            bb = it.get(body)
            if bb is None:
                continue
            g = guid(bb.data)
            ent = {"kind": kind, "guid": g}
            try:
                ent["inst"] = inst_of(it)
            except Exception:  # noqa: BLE001 - other kinds may differ; keep the entry
                ent["inst"] = None
            if kind == "multi":
                pl = Rd(it.get("PLST").data)
                ent["playMode"] = pl.i32()
                ent["playMode2"] = pl.i32()
                ent["entries"] = pl.array(lambda x: {"inst": x.guid(), "weight": x.f32()})
            elif kind == "wave":
                ent["waveform"] = guid(bb.data, 16)
            elif kind == "command":
                r = Rd(bb.data)
                r.guid()
                ent["command"] = r.u32()
                ent["target"] = r.guid()
                ent["value"] = r.f32()
            elif kind == "event":
                ent["raw"] = bb.data.hex()
                if len(bb.data) >= 32:
                    ent["event"] = guid(bb.data, 16)  # the event (or snapshot event) it starts
            bank.instruments[g] = ent
    wavs = proj.get("WAVS")
    for w in (wavs.all("WAV ") if wavs else []):
        r = Rd(w.data)
        g = r.guid()
        r.u16()
        bank_index = r.u32()
        sub = r.u32()
        bank.waveforms[g] = {"bankIndex": bank_index, "subsound": sub}
    mods = proj.get("MODS")
    for mu in (mods.all("MODU") if mods else []):
        bank.modulators.append(parse_modb(mu.get("MODB").data))
    return bank


def parse_strings(path: str | Path) -> dict[str, str]:
    """Strings bank STDT (radix tree): path -> GUID."""
    d = Path(path).read_bytes()
    i = d.find(b"STDT")
    n = struct.unpack_from("<I", d, i + 4)[0]
    s = d[i + 8:i + 8 + n]
    nodes = []
    k = 8
    while True:
        a, b = struct.unpack_from("<II", s, k)
        ch, fl = a >> 24, b >> 24
        if not (32 <= ch < 127 or ch == 0) or fl >= 0x80:
            break
        nodes.append((a & 0xFFFFFF, ch, b & 0xFFFFFF, fl))
        k += 8
    # the last node-shaped record is the GUID table's first 4 bytes (count / header word)
    gbase = k - 4

    def count(idx: int) -> int:
        _x, _c, y, fl = nodes[idx]
        return 1 if fl == 0 else sum(count(c) for c in range(y, y + fl))

    pool = gbase + 16 * count(0) + 4
    out: dict[str, str] = {}

    def label(x: int) -> str:
        if x == 0xFFFFFF:
            return ""
        e = s.index(b"\0", pool + x)
        return s[pool + x:e].decode("utf-8", "replace")

    def walk(idx: int, prefix: str) -> None:
        x, _ch, y, fl = nodes[idx]
        p = prefix + label(x)
        if fl == 0:
            out[p] = guid(s, gbase + 16 * y)
            return
        for c in range(y, y + fl):
            walk(c, p)

    walk(0, "")
    return out


if __name__ == "__main__":
    b = parse_bank(sys.argv[1])
    res = {"version": b.version, "events": b.events, "timelines": b.timelines, "instruments": b.instruments,
           "waveforms": b.waveforms, "modulators": b.modulators, "buses": b.buses, "effects": b.effects,
           "vcas": b.vcas, "snapshots": b.snapshots, "parameters": b.parameters}
    if len(sys.argv) > 2:
        st = parse_strings(sys.argv[2])
        inv = {v: k for k, v in st.items()}
        for g, e in b.events.items():
            e["path"] = inv.get(g)
        for g, e in list(b.buses.items()) + list(b.vcas.items()):
            e["path"] = inv.get(g)
    print(json.dumps(res, indent=1))
