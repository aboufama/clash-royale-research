#!/usr/bin/env python3
"""Bake the battle's sounds for the browser viewer: FMOD Studio events -> Ogg files + sounds.json.

Called by tools/art/bake_web.py (`bake(...)`) with the sound names its manifest needs; can also run
alone (`python3 tools/audio/bake_audio.py --out sim/viewer/assets [names...]`). Output (ignored,
rebuildable) under <out>/audio/: one .ogg per FSB5 subsound used (tools/audio/fsb5_ogg.py) and
sounds.json, the event model the viewer plays (sim/viewer/src/sc/sound.ts).

How the client names a sound (libg 160402020):
  * effects, spells (CastSound), rarities and the client tables name a *resource* like
    "soundbanks/card_common_archer/card_common_archer_attack"; the resource system resolves it
    through the FMODSoundBank asset "soundbanks/card_common_archer" in assets.scdb (events
    [{n: name, p: "event:/...", u}]) to an FMODSound holding the event path, and the FMOD backend
    plays it with getEvent(path) -> createInstance -> start (0xcba648 / 0xcba864 -> 0xcbc14c);
  * music rows (csv_client/music.csv: Name, BankName, EventName) are played by 0xcbc880, which loads
    the bank and plays EventName the same way, remembering the instance as the current music.
The strings bank (clashroyale.strings.bank) maps the path to the event GUID; the event's own bank
holds its timeline, instruments and the FSB5 samples (tools/audio/fmod_bank.py).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "art"))
import apk  # noqa: E402
import fmod_bank  # noqa: E402
import fsb5_ogg  # noqa: E402

ROOT = HERE.parents[1]
RAW = ROOT / "extracted" / "data" / "raw"

# Resource names the battle UI plays, from the client's static tables: 0xe664d8 builds the names,
# 0xe1698c copies them into the client tables (offsets below), whose getters the HUD calls.
UI_SOUNDS = {
    "selectSpell": "soundbanks/ui_battle_general/ui_battle_general_select_spell",  # +0xa00, card select 0x8e12e4
    "cardFlyIn": "soundbanks/ui_battle_general/ui_battle_general_card_fly_in",  # +0xa80, card arrival 0x8e05e8 / 0x8e1408
    "spellAvailable": "soundbanks/ui_battle_general/ui_battle_general_spell_available",  # +0xc80, affordable 0x8e1408
    "spellNotReady": "soundbanks/ui_battle_general/ui_battle_general_spell_not_ready",  # +0xcc0, 0xbe7184
    "collectorGet": "soundbanks/card_rare_elixir_collector/card_rare_elixir_collector_get",  # +0xe00, 0xbe4a8c
    "crownEnemy": "soundbanks/ui_battle_general/ui_battle_general_get_star_enemy",  # +0xd80, crown flight 0x8dd90c
    "crownPlayer": "soundbanks/music_jingle_general/music_jingle_general_get_star_player",  # +0xdc0
    # deploy timers 0x8d9748 (own / enemy), played by 0x8d9ad0
    "deployTick": "soundbanks/ui_battle_general/ui_battle_general_deploy_timer_tick",
    "deployDing": "soundbanks/ui_battle_general/ui_battle_general_deploy_timer_ding",
    "enemyDeployTick": "soundbanks/ui_battle_general/ui_battle_general_enemy_deploy_timer_tick",
    "enemyDeployDing": "soundbanks/ui_battle_general/ui_battle_general_enemy_deploy_timer_ding",
    # intro banner 0x8ca764: banner_sfx once the clip reaches its start_sound label (+0xe4), else
    # names_whoosh_in 2 s in; names_whoosh_out at actionFrame (+0xe8)
    "bannerSfx": "soundbanks/ui_menu_general/ui_menu_general_banner_sfx",
    "namesIn": "soundbanks/ui_battle_general/ui_battle_general_names_whoosh_in",
    "namesOut": "soundbanks/ui_battle_general/ui_battle_general_names_whoosh_out",
    # hand panel slide 0x8db8e0 (+0xeb)
    "boardSlideIn": "soundbanks/ui_menu_general/ui_menu_general_board_slide_in",
    # HUD time update 0x8d38c4: overtime start, time ran out at the end
    "extraTime": "soundbanks/ui_battle_general/ui_battle_general_extra_time_jingle",
    "gameEndHorn": "soundbanks/music_jingle_general/music_jingle_general_gameend_horn",
    # result screen 0x8be06c (crown N appears, 0x8c2b80)
    "crown1": "soundbanks/ui_battle_general/ui_battle_general_first_crown",
    "crown2": "soundbanks/ui_battle_general/ui_battle_general_second_crown",
    "crown3": "soundbanks/ui_battle_general/ui_battle_general_third_crown",
}

# music.csv's BattleMusic row points at this build's seasonal arena track (music_arena_202610, the
# October 2026 theme). The owner wants the standard Clash Royale battle music, which the same build ships
# as music_arena_general_battle: a playlist of the three 2-minute battle loops (2min_loop_battle_01..03).
# The result jingle's stop commands (Pre_result) name that event, not the seasonal one (DECISIONS.md).
MUSIC_OVERRIDES = {
    "BattleMusic": ("soundbanks/music_arena_general_battle.bank",
                    "event:/Main/Music/Arena/music_arena_general_battle/music_arena_general_battle"),
}

# music.csv rows the result screen plays (0x8bc564 Pre_result; 0x8c2b80 Win/Lose/Draw = client tables
# +0xe48/+0xe50/+0xe58; 0x8c1b9c Post_result_loop once the jingle stopped)
RESULT_MUSIC = {"preResult": "Pre_result", "win": "Win", "lose": "Lose", "draw": "Draw", "postResult": "Post_result_loop"}


def csv_rows(rel: str) -> list[dict]:
    p = RAW / rel
    if not p.exists():
        return []
    rows = list(csv.DictReader(io.StringIO(p.read_text(encoding="utf-8"))))
    return rows[1:]  # the type row


def client_global_lists(name: str) -> tuple[list[str], list[int]]:
    """StringArray / NumberArray of a client_globals.csv entry (continuation rows have no name)."""
    p = RAW / "csv_client" / "client_globals.csv"
    strs, nums = [], []
    if not p.exists():
        return strs, nums
    rows = list(csv.reader(io.StringIO(p.read_text(encoding="utf-8"))))
    on = False
    for r in rows[2:]:
        if r and r[0]:
            on = r[0] == name
        if on:
            if len(r) > 4 and r[4]:
                strs.append(r[4])
            if len(r) > 5 and r[5].strip().lstrip("-").isdigit():
                nums.append(int(r[5]))
    return strs, nums


class Resolver:
    def __init__(self, log=print):
        self.log = log
        self.paths: dict[str, str] = {}  # event path -> guid
        self.inv: dict[str, str] = {}
        self.res: dict[str, tuple[str, str]] = {}  # resource name -> (bank file, event path)
        self.banks: dict[str, fmod_bank.Bank] = {}
        self.fsb: dict[str, fsb5_ogg.Fsb5 | None] = {}
        self.warnings: list[str] = []
        self._load_strings()
        self._load_scdb()

    def _load_strings(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".bank") as t:
            t.write(apk.read("assets/soundbanks/clashroyale.strings.bank"))
            t.flush()
            self.paths = fmod_bank.parse_strings(t.name)
        self.inv = {v: k for k, v in self.paths.items()}

    def _load_scdb(self) -> None:
        from flatbuffers import flexbuffers
        raw = apk.read("assets/assets.scdb")
        con = sqlite3.connect(":memory:")
        if hasattr(con, "deserialize"):
            con.deserialize(raw)
        else:  # pragma: no cover - Python < 3.11
            t = tempfile.NamedTemporaryFile(suffix=".scdb", delete=False)
            t.write(raw)
            t.close()
            con = sqlite3.connect(t.name)
        for path, fname, data in con.execute("select path, assetFilename, data from meta where assetType='FMODSoundBank'"):
            try:
                v = flexbuffers.Loads(data)
            except Exception:  # noqa: BLE001
                self.warnings.append(f"scdb {path}: undecodable")
                continue
            for e in (v or {}).get("events", []):
                self.res[f"{path}/{e['n']}"] = (fname, e["p"])

    def bank(self, fname: str) -> fmod_bank.Bank:
        if fname not in self.banks:
            with tempfile.NamedTemporaryFile(suffix=".bank") as t:
                data = apk.read("assets/" + fname)
                t.write(data)
                t.flush()
                self.banks[fname] = fmod_bank.parse_bank(t.name)
            self.fsb[fname] = fsb5_ogg.fsb5_in_bank(data)
        return self.banks[fname]


def _r(v: float, n: int = 3) -> float | int:
    r = round(v, n)
    return int(r) if r == int(r) else r


class AudioBaker:
    def __init__(self, out: Path, log=print):
        self.out = out
        self.log = log
        self.r = Resolver(log)
        self.events: dict[str, dict] = {}
        self.files: list[dict] = []
        self.file_ix: dict[tuple[str, int], int] = {}
        self.missing: set[str] = set()
        self.skipped_mods = 0

    # -- event model ---------------------------------------------------------------------------
    def node(self, bank: fmod_bank.Bank, fname: str, g: str, mods: dict, depth: int = 0) -> dict | None:
        it = bank.instruments.get(g)
        if it is None or depth > 6:
            return None
        inst = it.get("inst") or {}
        n: dict = {"k": it["kind"]}
        if inst:
            if inst["volume"]:
                n["vol"] = _r(inst["volume"])
            if inst["pitch"]:
                n["pitch"] = _r(inst["pitch"])
            if inst["loopCount"]:
                n["lc"] = inst["loopCount"]
            if inst["delayMin"] or inst["delayMax"]:
                n["dl"] = [_r(inst["delayMin"]), _r(inst["delayMax"])]
            if inst["probability"] != 100:
                n["p"] = _r(inst["probability"])
            if inst["startOffset"]:
                n["so"] = _r(inst["startOffset"])
        for m in mods.get(g, []):
            if m["type"] == 1 and m["prop"] == 0:
                n["rv"] = _r(m["amount"])
            elif m["type"] == 1 and m["prop"] == 1:
                n["rp"] = _r(m["amount"])
            else:
                self.skipped_mods += 1
        k = it["kind"]
        if k == "wave":
            w = bank.waveforms.get(it["waveform"])
            if w is None:
                return None
            n["f"] = self.file(fname, w["subsound"])
            if n["f"] is None:
                return None
        elif k == "multi":
            n["m"] = it["playMode"]
            ents = []
            for e in it["entries"]:
                c = self.node(bank, fname, e["inst"], mods, depth + 1)
                if c is not None:
                    ents.append([_r(e["weight"]), c])
            n["e"] = ents
        elif k == "command":
            n["c"] = it["command"]
            n["tg"] = self.r.inv.get(it["target"], it["target"])
            n["val"] = _r(it["value"])
        elif k == "silence":
            pass
        else:
            n["unsupported"] = True
        return n

    def file(self, fname: str, sub: int) -> int | None:
        key = (fname, sub)
        if key in self.file_ix:
            return self.file_ix[key]
        fsb = self.r.fsb.get(fname)
        if fsb is None or sub >= len(fsb.samples):
            return None
        s = fsb.samples[sub]
        stem = Path(fname).stem
        rel = f"audio/{stem}/{sub:03d}.ogg"
        p = self.out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(fsb5_ogg.sample_ogg(s))
        self.file_ix[key] = len(self.files)
        self.files.append({"f": rel, "n": s.samples, "ch": s.channels, "name": s.name})
        return self.file_ix[key]

    def event(self, key: str, fname: str, path: str) -> bool:
        if key in self.events:
            return True
        g = self.r.paths.get(path)
        if g is None:
            self.missing.add(f"{key}: {path} not in strings bank")
            return False
        bank = self.r.bank(fname)
        ev = bank.events.get(g)
        if ev is None:
            self.missing.add(f"{key}: event {path} not in {fname}")
            return False
        mods: dict[str, list] = {}
        for m in bank.modulators:
            mods.setdefault(m["owner"], []).append(m)
        tl = bank.timelines.get(ev["timeline"]) or {"inst": [], "a": [], "markers": [], "transitions": []}
        insts, end = [], 0
        for pl in tl["inst"] + tl["a"]:
            nd = self.node(bank, fname, pl["inst"], mods)
            if nd is None:
                continue
            nd["t"] = pl["start"]
            if pl["length"]:
                nd["len"] = pl["length"]
            insts.append(nd)
            end = max(end, pl["start"] + pl["length"])
        d = {"path": path, "max": ev["maxInstances"], "steal": ev["stealing"], "prio": ev["priority"],
             "inst": insts, "len": end}
        if ev["cooldown"]:
            d["cooldown"] = _r(ev["cooldown"], 4)
        # a transition back to an earlier destination marker (FMOD's loop region / transition marker)
        marks = {m["guid"]: m for m in tl["markers"]}
        for tr in tl["transitions"]:
            dst = marks.get(tr["dest"])
            if dst is not None and not tr["conditions"] and tr["probability"] >= 100 and dst["pos"] < tr["end"]:
                d["loop"] = [dst["pos"], tr["end"]]
        for m in mods.get(ev["guid"], []) + mods.get(ev["masterTrack"], []):
            self.skipped_mods += 1
        self.events[key] = d
        return True

    def resource(self, name: str) -> str | None:
        """Bake a resource name ("soundbanks/<bank>/<event>"); returns the key or None."""
        if not name:
            return None
        hit = self.r.res.get(name)
        if hit is None:
            self.missing.add(f"{name}: no FMODSoundBank entry")
            return None
        return name if self.event(name, hit[0], hit[1]) else None

    def music(self, name: str) -> str | None:
        key = "music:" + name
        if name in MUSIC_OVERRIDES:
            bank, ev = MUSIC_OVERRIDES[name]
            return key if self.event(key, bank, ev) else None
        for row in csv_rows("csv_client/music.csv"):
            if row.get("Name") == name:
                return key if self.event(key, row["BankName"], row["EventName"]) else None
        self.missing.add(f"{key}: no music.csv row")
        return None


def bake(out: Path, effect_sounds: set[str], cast: dict[str, str], rarities: set[str], location: str,
         log=print) -> dict:
    """Write <out>/audio/*.ogg and audio/sounds.json; returns a summary for the art manifest."""
    a = AudioBaker(out, log)
    adir = out / "audio"
    if adir.exists():
        for p in sorted(adir.rglob("*.ogg")):
            p.unlink()
    ui = {k: a.resource(v) for k, v in UI_SOUNDS.items()}
    rar = {}
    for row in csv_rows("csv_logic/rarities.csv"):
        if row.get("Name") in rarities:
            sel, av = a.resource(row.get("SpellSelectedSound", "")), a.resource(row.get("SpellAvailableSound", ""))
            if sel or av:
                rar[row["Name"]] = {"select": sel, "available": av}
    ui["rarity"] = rar
    fx = {s: a.resource(s) for s in sorted(effect_sounds)}
    casts = {c: a.resource(s) for c, s in sorted(cast.items()) if s}
    # SOUND_START_TIMES / SOUNDS_PVP (0xbdf1b0): index 0 is the location's Sound (0xe48c74)
    loc = next((r for r in csv_rows("csv_logic/locations.csv") if r.get("Name") == location), {})
    sounds_pvp, _ = client_global_lists("SOUNDS_PVP")
    _, sound_times = client_global_lists("SOUND_START_TIMES")
    time_sounds = [a.resource(loc.get("Sound", ""))] + [a.resource(s) for s in sounds_pvp]
    # the music list: the location's MusicOverride (loader 0xe48b80 -> +0x140, at most one row) when set,
    # else MUSICS_PVP (client table +0x118; the NpcOnly / "FirstMatch" / 2v2 lists are not used here)
    musics_pvp, _ = client_global_lists("MUSICS_PVP")
    if loc.get("MusicOverride"):
        musics_pvp = [loc["MusicOverride"]]
    _, music_times = client_global_lists("MUSIC_START_TIMES")
    music = {"times": music_times[:len(musics_pvp)], "battle": [a.music(m) for m in musics_pvp],
             "extraTime": a.music(loc.get("ExtraTimeMusic", "")) if loc.get("ExtraTimeMusic") else None,
             # the battle screen setup 0xbde180 plays the location's AmbientSound (0xe48cfc, +0x3c8)
             "ambient": a.resource(loc.get("AmbientSound", ""))}
    for k, v in RESULT_MUSIC.items():
        music[k] = a.music(v)
    doc = {"v": 1, "generatedBy": "tools/audio/bake_audio.py", "files": a.files, "events": a.events,
           "ui": ui, "effects": {k: v for k, v in fx.items() if v}, "cast": {k: v for k, v in casts.items() if v},
           "time": {"times": sound_times, "sounds": time_sounds}, "music": music,
           "missing": sorted(a.missing)}
    adir.mkdir(parents=True, exist_ok=True)
    (adir / "sounds.json").write_text(json.dumps(doc, separators=(",", ":")))
    size = sum((out / f["f"]).stat().st_size for f in a.files)
    log(f"audio: {len(a.events)} events, {len(a.files)} files ({size / 1e6:.1f} MB), "
        f"{len(a.missing)} unresolved, {a.skipped_mods} modulators not applied")
    for m in sorted(a.missing)[:20]:
        log("  audio missing:", m)
    for w in a.r.warnings:
        log("  audio warning:", w)
    return {"json": "audio/sounds.json", "events": len(a.events), "files": len(a.files), "bytes": size}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "sim" / "viewer" / "assets")
    ap.add_argument("--location", default="PvP_goblin")
    ap.add_argument("names", nargs="*", help="extra resource names")
    args = ap.parse_args()
    print(bake(args.out, set(args.names), {}, {"Legendary"}, args.location))


if __name__ == "__main__":
    main()
