"""Bake original SC2 movie clips into a compact web format for the browser renderer.

    .venv/bin/python tools/art/bake_web.py                     # default unit list
    .venv/bin/python tools/art/bake_web.py --chars Knight,Archer,Giant --format webp
    .venv/bin/python tools/art/bake_web.py --list-chars         # character / card names

Output (gitignored, fully rebuildable): sim/viewer/assets/
    sc/<name>.json      one per .sc file: shapes, movie clips, matrix banks, exports
    sc/<name>_<i>.png   texture atlases (decoded from .sctx; tree-shaken + repacked)
    manifest.json       game names -> art (characters, projectiles, effects, towers,
                        arena + alignment constants, cards, HUD)

Library JSON (`v` = 1). Everything is the SC2 display list as sc2.py decodes it; no frame
is pre-rendered. Ids are the original object ids.
    tex     [{f: file, w, h}]
    shapes  {id: [[texIndex, [x, y, u, v, ...]], ...]}   vertices in triangle-strip order,
            x/y in SC pixels, u/v in TEXELS of tex[texIndex] (divide by w/h)
    clips   {id: {fps, n: [elements per frame], e: [child, matrix, color, ...] flat,
                  c: [child ids], b: [blend per child] (absent = all 0), k: bank,
                  lb: {frameIndex: label}, nm: [child instance names] (optional)}}
            matrix/color index -1 = identity / no color transform
    banks   [{m: [a, b, c, d, tx, ty, ...], c: [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, ...]}]
            multipliers 0..1, adds 0..255 (sc2.Color semantics)
    exports {name: id}
    mods    {id: 38 | 39 | 40}  mask begin / masked content begin / mask end
    tf      {id: {font, text, rect: [l, t, r, b], color, outline, size, align, flags}}

Libraries are tree-shaken to the exports the manifest needs, matrix/color banks are
compacted, and atlases that would be mostly unused are repacked (exact texel copies with a
padding border, so bilinear sampling is unchanged).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apk  # noqa: E402
import sc2  # noqa: E402
import sctx  # noqa: E402

ROOT = apk.ROOT
OUT = ROOT / "sim" / "viewer" / "assets"
DATA = ROOT / "extracted" / "data" / "json"
RAW = ROOT / "extracted" / "data" / "raw"
NO_INDEX = 0xFFFF
PAD = 4  # texel border kept around every repacked rectangle

DEFAULT_CHARS = ("Knight,Archer,Giant,Musketeer,MiniPekka,Valkyrie,BabyDragon,Minion,Skeleton,"
                 "Goblin,SpearGoblin,Bomber,Wizard,Barbarian,Pekka,MegaMinion,Princess,"
                 "DartGoblin,RoyalGiant,Bat,FlyingMachine,EliteBarbarian")
DEFAULT_SPELLS = "Fireball,Arrows"
# Common names that differ from the build's internal names (card -> character).
ALIASES = {"DartGoblin": "BlowdartGoblin", "FlyingMachine": "DartBarrell",
           "EliteBarbarian": "AngryBarbarian", "EliteBarbarians": "AngryBarbarian",
           "ElitBarbarian": "AngryBarbarian", "Archers": "Archer", "Goblins": "Goblin_Stab",
           "Bats": "Bat", "Minions": "Minion", "Skeletons": "Skeleton",
           "Barbarians": "Barbarian", "SpearGoblins": "SpearGoblin"}

# Character fields naming effects (legacy_vfx/effects.json entries).
CHAR_EFFECT_FIELDS = ("SpawnEffect", "DeathEffect", "AttackStartEffect", "DamageEffect", "MoveEffect",
                      "ProjectileEffect", "LandingEffect", "ContinuousEffect", "DashEffect",
                      "DashStartEffect", "ChargeEffect", "KamikazeEffect", "TargetedHitEffect",
                      "AbilityPendingEffect", "ShieldLostEffect", "DamageEffectSpecial")
CHAR_FILTER_FIELDS = ("DeployBaseAnimExportName", "SpawnDeployBaseAnim")
PROJ_EFFECT_FIELDS = ("HitEffect", "TrailEffect", "DeathEffect", "PingpongDeathEffect")

HUD_EXPORTS = (
    # bottom panel: hand, elixir bar, next card
    "HUD_player", "spell_card_ingame", "spell_card_ingame_reveal", "card_item_elixir_ingame",
    "Elixir_bar_drop_anim", "elixir_float_txt", "elixir_float_txt_blue", "elixir_float_txt_red",
    # top: timer, crowns, player names
    "HUD_topLeft", "HUD_topRight", "HUD_topRight_overtime", "HUD_topRight_double_elixir",
    "HUD_rightMiddle", "Clock_middle", "icon_crowns", "crown_rotate_anim",
    "print_60secondsLeft_overtime", "print_elixir_speed", "print_endTimer", "pvp_battle_start",
    # deploy UI
    "troopDeployTimer_player", "troopDeployTimer_enemy", "deployArea_base",
    "deployArea_corner_leftBottom", "deployArea_corner_leftTop", "deployArea_corner_rightBottom",
    "deployArea_corner_rightTop", "deployArea_innerCorner_bottomLeft", "deployArea_innerCorner_bottomRight",
    "deployArea_innerCorner_topLeft", "deployArea_innerCorner_topRight", "deployArea_side_bottom",
    "deployArea_side_left", "deployArea_side_right", "deployArea_side_top",
)


def r2(v: float) -> float | int:
    v = round(float(v), 2)
    return int(v) if v.is_integer() else v


def r5(v: float) -> float | int:
    v = round(float(v), 5)
    return int(v) if v.is_integer() else v


# ---------------------------------------------------------------------------------------------
# SC2 -> web library
# ---------------------------------------------------------------------------------------------

class ScSource:
    """One parsed .sc file plus lazily decoded atlases."""

    def __init__(self, rel: str):
        self.rel = rel  # e.g. "sc/chr_knight.sc"
        self.name = Path(rel).stem
        self.sc = sc2.parse(apk.read(rel))
        self._img: dict[int, Image.Image] = {}

    def texture(self, i: int) -> Image.Image:
        if i not in self._img:
            t = self.sc.textures[i]
            if t.external:
                data = apk.read(f"{Path(self.rel).parent.as_posix()}/{Path(t.external).name}")
                img = sctx.decode(data) if data[8:12] == b"SCTX" else None
                if img is None:
                    import ktx
                    img = ktx.decode(data)
            elif t.data and t.data[:4] == b"\xabKTX":
                import ktx
                img = ktx.decode(t.data)
            else:
                raise NotImplementedError(f"{self.rel}: texture {i} has no supported data")
            self._img[i] = img.convert("RGBA")
        return self._img[i]

    def reachable(self, roots: set[int]) -> set[int]:
        sc, seen, stack = self.sc, set(), list(roots)
        while stack:
            oid = stack.pop()
            if oid in seen:
                continue
            seen.add(oid)
            mc = sc.movieclips.get(oid)
            if mc:
                stack.extend(mc.children_ids)
        return seen


def _pack_shelves(rects: list[tuple[int, int, int]], max_side: int = 4096):
    """rects: [(key, w, h)] -> ({key: (atlas, x, y)}, [(w, h)] per atlas). Simple shelf packer."""
    order = sorted(rects, key=lambda r: (-r[2], -r[1]))
    total = sum(w * h for _, w, h in rects)
    side = 256
    while side < max_side and side * side < total * 1.25:
        side *= 2
    width = max(side, max((w for _, w, _ in rects), default=1))
    width = min(max_side, 1 << (width - 1).bit_length())
    atlases: list[list] = []  # [cursor_x, cursor_y, shelf_h, used_w, used_h]
    place = {}
    cur = None
    for key, w, h in order:
        if cur is None or (cur[0] + w > width and cur[1] + cur[2] + h > max_side):
            cur = [0, 0, 0, 0, 0]
            atlases.append(cur)
        if cur[0] + w > width:  # new shelf
            cur[1] += cur[2]
            cur[0], cur[2] = 0, 0
        if cur[1] + h > max_side:
            cur = [0, 0, 0, 0, 0]
            atlases.append(cur)
        place[key] = (len(atlases) - 1, cur[0], cur[1])
        cur[0] += w
        cur[2] = max(cur[2], h)
        cur[3] = max(cur[3], cur[0])
        cur[4] = max(cur[4], cur[1] + cur[2])
    sizes = [(a[3], a[4]) for a in atlases]
    return place, sizes


def _merge_rects(rects: list[list[int]]) -> list[list[int]]:
    """Union overlapping [x0, y0, x1, y1] rectangles until none overlap."""
    rects = [r[:] for r in rects]
    changed = True
    while changed:
        changed = False
        rects.sort()
        out: list[list[int]] = []
        for r in rects:
            for o in out:
                if r[0] < o[2] and o[0] < r[2] and r[1] < o[3] and o[1] < r[3]:
                    o[0], o[1] = min(o[0], r[0]), min(o[1], r[1])
                    o[2], o[3] = max(o[2], r[2]), max(o[3], r[3])
                    changed = True
                    break
            else:
                out.append(r)
        rects = out
    return rects


def export_library(src: ScSource, export_names: set[str] | None, out_dir: Path, fmt: str,
                   downscale: float = 1.0, log=print) -> dict:
    """Write <out_dir>/<name>.json + textures. export_names None = every export."""
    sc = src.sc
    names = sorted(sc.exports) if export_names is None else sorted(n for n in export_names if n in sc.exports)
    missing = sorted((export_names or set()) - set(sc.exports))
    if missing:
        log(f"  warning: {src.name}: {len(missing)} exports not found, e.g. {missing[:5]}")
    roots = {sc.exports[n] for n in names}
    ids = src.reachable(roots)

    # --- banks: compact used matrix / color indices ---------------------------------------------
    used_m: dict[int, set[int]] = defaultdict(set)
    used_c: dict[int, set[int]] = defaultdict(set)
    for oid in ids:
        mc = sc.movieclips.get(oid)
        if not mc:
            continue
        for _ci, mi, coi in mc.elements:
            if mi != NO_INDEX:
                used_m[mc.bank].add(mi)
            if coi != NO_INDEX:
                used_c[mc.bank].add(coi)
    bank_ids = sorted(set(used_m) | set(used_c) | {sc.movieclips[o].bank for o in ids if o in sc.movieclips})
    bank_map = {b: i for i, b in enumerate(bank_ids)}
    mremap: dict[int, dict[int, int]] = {}
    cremap: dict[int, dict[int, int]] = {}
    banks_out = []
    for b in bank_ids:
        mats, cols = sc.banks[b] if b < len(sc.banks) else ([], [])
        ml = sorted(used_m.get(b, ()))
        cl = sorted(used_c.get(b, ()))
        mremap[b] = {old: i for i, old in enumerate(ml)}
        cremap[b] = {old: i for i, old in enumerate(cl)}
        mflat, cflat = [], []
        for old in ml:
            m = mats[old]
            mflat += [r5(m.a), r5(m.b), r5(m.c), r5(m.d), r2(m.tx), r2(m.ty)]
        for old in cl:
            c = cols[old]
            cflat += [r5(c.r_mul), r5(c.g_mul), r5(c.b_mul), r5(c.a_mul), r2(c.r_add), r2(c.g_add), r2(c.b_add)]
        banks_out.append({"m": mflat, "c": cflat})

    # --- textures: which ones, and repack? ---------------------------------------------------------
    shape_ids = sorted(o for o in ids if o in sc.shapes)
    used_tex = sorted({cmd.texture_index for o in shape_ids for cmd in sc.shapes[o].commands})
    tex_sizes = {}
    for t in used_tex:
        img = src.texture(t)
        tex_sizes[t] = img.size
    # Per-command texel bounding boxes.
    cmd_rects: dict[tuple[int, int], list[int]] = {}
    for o in shape_ids:
        for k, cmd in enumerate(sc.shapes[o].commands):
            W, H = tex_sizes[cmd.texture_index]
            us = [u * W for _, _, u, _ in cmd.verts]
            vs = [v * H for _, _, _, v in cmd.verts]
            cmd_rects[(o, k)] = [max(0, math.floor(min(us)) - PAD), max(0, math.floor(min(vs)) - PAD),
                                 min(W, math.ceil(max(us)) + PAD), min(H, math.ceil(max(vs)) + PAD)]
    per_tex: dict[int, list[list[int]]] = defaultdict(list)
    for (o, k), r in cmd_rects.items():
        per_tex[sc.shapes[o].commands[k].texture_index].append(r)
    merged = {t: _merge_rects(rs) for t, rs in per_tex.items()}
    used_area = sum((r[2] - r[0]) * (r[3] - r[1]) for rs in merged.values() for r in rs)
    full_area = sum(w * h for w, h in tex_sizes.values())
    repack = full_area > 0 and used_area < 0.7 * full_area

    tex_out = []
    # mapping (src_tex, texel x, y) -> (out_tex, x, y): via rect offsets
    if repack:
        rects = []
        for t, rs in merged.items():
            for i, r in enumerate(rs):
                rects.append(((t, i), r[2] - r[0], r[3] - r[1]))
        place, sizes = _pack_shelves(rects)
        atlases = [Image.new("RGBA", s, (0, 0, 0, 0)) for s in sizes]
        for (t, i), (ai, x, y) in place.items():
            r = merged[t][i]
            atlases[ai].paste(src.texture(t).crop(tuple(r)), (x, y))

        def find_rect(t, rect):
            for i, r in enumerate(merged[t]):
                if r[0] <= rect[0] and r[1] <= rect[1] and rect[2] <= r[2] and rect[3] <= r[3]:
                    return i, r
            raise AssertionError("rect not merged")

        def uv_map(o, k, t, u, v):
            i, r = find_rect(t, cmd_rects[(o, k)])
            ai, x, y = place[(t, i)]
            W, H = tex_sizes[t]
            return ai, u * W - r[0] + x, v * H - r[1] + y
        out_images = atlases
    else:
        out_images = [src.texture(t) for t in used_tex]
        tindex = {t: i for i, t in enumerate(used_tex)}

        def uv_map(o, k, t, u, v):
            W, H = tex_sizes[t]
            return tindex[t], u * W, v * H

    ext = "webp" if fmt == "webp" else "png"
    for i, img in enumerate(out_images):
        if downscale != 1.0:
            img = img.resize((max(1, round(img.width * downscale)), max(1, round(img.height * downscale))),
                             Image.LANCZOS)
        fname = f"{src.name}_{i}.{ext}"
        if fmt == "webp":
            img.save(out_dir / fname, "WEBP", lossless=True, method=4, exact=True)
        else:
            img.save(out_dir / fname, "PNG", compress_level=6)
        tex_out.append({"f": fname, "w": img.width, "h": img.height})

    # --- shapes -------------------------------------------------------------------------------
    shapes_out = {}
    for o in shape_ids:
        cmds = []
        for k, cmd in enumerate(sc.shapes[o].commands):
            flat = []
            ti = None
            for x, y, u, v in cmd.verts:
                ti, tu, tv = uv_map(o, k, cmd.texture_index, u, v)
                if downscale != 1.0:
                    tu, tv = tu * downscale, tv * downscale
                flat += [r2(x), r2(y), r2(tu), r2(tv)]
            if ti is None:
                continue
            cmds.append([ti, flat])
        shapes_out[str(o)] = cmds

    # --- clips --------------------------------------------------------------------------------
    clips_out = {}
    for o in sorted(ids):
        mc = sc.movieclips.get(o)
        if not mc:
            continue
        mr, cr = mremap.get(mc.bank, {}), cremap.get(mc.bank, {})
        e = []
        for ci, mi, coi in mc.elements:
            e += [ci, mr[mi] if mi != NO_INDEX else -1, cr[coi] if coi != NO_INDEX else -1]
        d = {"fps": mc.framerate, "n": [f.count for f in mc.frames], "e": e,
             "c": list(mc.children_ids), "k": bank_map.get(mc.bank, 0)}
        blend = list(mc.children_blend[: len(mc.children_ids)])
        if any(blend):
            d["b"] = blend + [0] * (len(mc.children_ids) - len(blend))
        labels = {str(i): f.label for i, f in enumerate(mc.frames) if f.label}
        if labels:
            d["lb"] = labels
        if any(mc.children_names):
            d["nm"] = list(mc.children_names)
        clips_out[str(o)] = d

    mods_out = {str(o): sc.modifiers[o] for o in ids if o in sc.modifiers}
    tf_out = {}
    for o in ids:
        tf = sc.textfields.get(o)
        if tf is None:
            continue
        # struct TextField: id, ?, font_ref, l, t, r, b, color, outline, text_ref, ?, flags.., size, align..
        tid, _u0, font_ref, l, t, r, b, color, outline, text_ref, _u1, b0, b1, b2, b3, _u2 = tf
        s = sc.strings

        def sref(i):
            return s[i] if 0 <= i < len(s) else ""
        tf_out[str(o)] = {"font": sref(font_ref), "text": sref(text_ref), "rect": [l, t, r, b],
                          "color": color, "outline": outline, "bytes": [b0, b1, b2, b3]}

    lib = {"v": 1, "name": src.name, "tex": tex_out, "shapes": shapes_out, "clips": clips_out,
           "banks": banks_out, "exports": {n: sc.exports[n] for n in names}}
    if mods_out:
        lib["mods"] = mods_out
    if tf_out:
        lib["tf"] = tf_out
    js = json.dumps(lib, separators=(",", ":"))
    (out_dir / f"{src.name}.json").write_text(js)
    tex_bytes = sum((out_dir / t["f"]).stat().st_size for t in tex_out)
    info = {"exports": len(names), "objects": len(ids), "json": len(js), "textures": tex_bytes,
            "repacked": repack, "atlases": [(t["w"], t["h"]) for t in tex_out],
            "used_area_pct": round(100 * used_area / full_area, 1) if full_area else 0}
    log(f"  {src.name}: {info['exports']} exports, {info['objects']} objects, json {len(js) / 1e3:.0f} kB, "
        f"tex {tex_bytes / 1e6:.2f} MB {info['atlases']}{' repacked' if repack else ''} "
        f"(used {info['used_area_pct']}% of source atlases)")
    return info


# ---------------------------------------------------------------------------------------------
# Game data -> what to bake
# ---------------------------------------------------------------------------------------------

def load_json(name: str):
    d = json.loads((DATA / f"{name}.json").read_text())
    return d["rows"] if isinstance(d, dict) and "rows" in d and "_columns" in d else d


def read_location_csv(rel: str) -> dict:
    """locations/*.csv -> {sc, export, objects: [{export, x, y}]} (game units, y grows downward)."""
    p = RAW / rel
    text = p.read_text() if p.exists() else apk.read(rel).decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    out = {"sc": None, "export": None, "objects": []}
    section, current = None, None
    for r in rows:
        r = r + [""] * (4 - len(r))
        if r[0] in ("FileName", "Objects", "Background"):
            section = r[0]
            continue
        if section == "FileName" and r[1].startswith("sc/"):
            out["sc"], out["export"] = r[1], r[2]
        elif section == "Objects":
            if r[1] and r[1] not in ("x",):
                current = r[1]
            elif r[2] not in ("", "x", "int") and current:
                try:
                    out["objects"].append({"export": current, "x": int(r[2]), "y": int(r[3] or 0)})
                except ValueError:
                    pass
    return out


class Baker:
    def __init__(self, args, log=print):
        self.args = args
        self.log = log
        self.chars = load_json("characters")
        self.buildings = load_json("buildings")
        self.projs = load_json("projectiles")
        self.aeos = load_json("area_effect_objects")
        self.spells = {}
        for t in ("spells_characters", "spells_other", "spells_buildings"):
            for k, v in load_json(t).items():
                if isinstance(v, dict):
                    v["_table"] = t
                    self.spells[k] = v
        self.effects = json.loads(apk.read("legacy_vfx/effects.json"))
        self.emitters = json.loads(apk.read("legacy_vfx/emitters.json"))
        self.need: dict[str, set[str] | None] = defaultdict(set)  # sc rel path -> exports (None = all)
        self.src: dict[str, ScSource] = {}
        self.m_effects: dict[str, dict] = {}
        self.m_emitters: dict[str, dict] = {}
        self.missing_effects: set[str] = set()
        self.warnings: list[str] = []

    # -- helpers ---------------------------------------------------------------------------------
    def source(self, rel: str) -> ScSource | None:
        rel = rel.lstrip("/")
        if rel not in self.src:
            if not apk.exists(rel):
                self.warnings.append(f"missing sc file {rel}")
                self.src[rel] = None
            else:
                self.src[rel] = ScSource(rel)
        return self.src[rel]

    def want(self, rel: str, export: str) -> str | None:
        """Request an export; returns the library name or None if it does not exist."""
        src = self.source(rel)
        if src is None:
            return None
        if export not in src.sc.exports:
            self.warnings.append(f"{rel}: export {export!r} not found")
            return None
        if self.need[src.rel] is not None:
            self.need[src.rel].add(export)
        return src.name

    def clip_info(self, rel: str, export: str) -> dict:
        src = self.source(rel)
        mc = src.sc.movieclips.get(src.sc.exports[export])
        if not mc:
            return {"frames": 1, "fps": 0}
        d = {"frames": len(mc.frames), "fps": mc.framerate}
        labels = {str(i): f.label for i, f in enumerate(mc.frames) if f.label}
        if labels:
            d["labels"] = labels
        return d

    # -- effects ---------------------------------------------------------------------------------
    def effect(self, name: str | None):
        if not name or name in self.m_effects:
            return
        e = self.effects.get(name)
        if e is None:
            self.missing_effects.add(name)
            return
        out = {k: e[k] for k in ("Loop", "FollowParent", "Scale", "ShakeScreen", "ForcedLength", "EnemyVersion",
                                 "PivotClip", "ShakeMaxIntensity") if k in e}
        self.m_effects[name] = out
        comps = []
        for c in e.get("RenderableComponents", []):
            t = c.get("Type")
            d = {"type": t, "layer": c.get("Layer") or "Object"}
            if c.get("Time"):
                d["time"] = c["Time"]
            if c.get("RenderableScale") not in (None, 100):
                d["scale"] = c["RenderableScale"]
            if t in ("SWF", "Filter"):
                if not c.get("ExportName"):
                    continue  # sound-only component
                rel = c.get("FileName") or "sc/effects.sc"
                lib = self.want(rel, c["ExportName"])
                if lib is None:
                    continue
                d.update(sc=lib, export=c["ExportName"], **self.clip_info(rel, c["ExportName"]))
                for k in ("FlashWidth", "TextInstanceName", "TextParentInstanceName"):
                    if k in c:
                        d[k[0].lower() + k[1:]] = c[k]
            elif t == "Effect":
                if not c.get("Effect"):
                    continue
                self.effect(c["Effect"])
                d["effect"] = c["Effect"]
            elif t == "ParticleEmitter":
                if not c.get("ParticleEmitterName"):
                    continue
                self.emitter(c["ParticleEmitterName"])
                if c["ParticleEmitterName"] not in self.m_emitters:
                    continue
                d["emitter"] = c["ParticleEmitterName"]
            else:
                continue
            comps.append(d)
        out["components"] = comps
        if e.get("EnemyVersion"):
            self.effect(e["EnemyVersion"])

    def emitter(self, name: str):
        if name in self.m_emitters:
            return
        em = self.emitters.get(name)
        if em is None:
            self.warnings.append(f"emitter {name!r} not found")
            return
        out = {k: v for k, v in em.items() if k not in ("ParticleResource", "ParticleExportName", "TrailSWF")}
        parts = []
        for rel, exp in zip(em.get("ParticleResource", []), em.get("ParticleExportName", [])):
            lib = self.want(rel, exp)
            if lib:
                parts.append({"sc": lib, "export": exp, **self.clip_info(rel, exp)})
        out["particles"] = parts
        if em.get("TrailSWF") and em.get("TrailExportName"):
            lib = self.want(em["TrailSWF"], em["TrailExportName"])
            if lib:
                out["trail"] = {"sc": lib, "export": em["TrailExportName"]}
        self.m_emitters[name] = out
        if em.get("EnemyVersion"):
            self.emitter(em["EnemyVersion"])
        if em.get("ParticleSpecificEmitter"):
            self.emitter(em["ParticleSpecificEmitter"])

    # -- characters / projectiles ----------------------------------------------------------------
    def resolve_char_name(self, name: str) -> tuple[str | None, str | None]:
        """Accepts a character name, card name or alias. Returns (character, card)."""
        name = ALIASES.get(name, name)
        card = None
        if name in self.spells and self.spells[name].get("SummonCharacter"):
            card = name
            name = self.spells[name]["SummonCharacter"]
        if name not in self.chars and name not in self.buildings:
            return None, None
        if card is None:
            for k, v in self.spells.items():
                if v.get("SummonCharacter") == name and v["_table"] == "spells_characters":
                    card = k
                    if k == name:
                        break
        return name, card

    def projectile(self, name: str | None, out: dict):
        if not name or name in out:
            return
        p = self.projs.get(name)
        if p is None:
            self.warnings.append(f"projectile {name!r} not found")
            return
        d = {}
        rel = p.get("FileName")
        if rel and p.get("ExportName"):
            d["sc"] = self.want(rel, p["ExportName"])
            d["export"] = p["ExportName"]
            d.update(self.clip_info(rel, p["ExportName"]))
            if p.get("RedExportName") and self.want(rel, p["RedExportName"]):
                d["redExport"] = p["RedExportName"]
            if p.get("ShadowExportName") and self.want(rel, p["ShadowExportName"]):
                d["shadow"] = p["ShadowExportName"]
            if p.get("RedShadowExportName") and self.want(rel, p["RedShadowExportName"]):
                d["redShadow"] = p["RedShadowExportName"]
        for k in ("Scale", "Speed", "Gravity", "ConstantHeight", "Radius", "use360Frames", "ShadowDisableRotate",
                  "Homing", "AlwaysResetAnimation"):
            if k in p:
                d[k[0].lower() + k[1:]] = p[k]
        for k in PROJ_EFFECT_FIELDS:
            if p.get(k):
                self.effect(p[k])
                d[k[0].lower() + k[1:]] = p[k]
        out[name] = d
        for k in ("SpawnProjectile", "SpawnChain"):
            if isinstance(p.get(k), str):
                self.projectile(p[k], out)
                d[k[0].lower() + k[1:]] = p[k]

    def unit_art(self, name: str, row: dict, projectiles: dict) -> dict | None:
        rel = row.get("FileName")
        if not rel:
            return None
        src = self.source(rel)
        if src is None:
            return None
        blue, red = row.get("BlueExportName"), row.get("RedExportName") or row.get("BlueExportName")
        entry = {"sc": src.name, "blue": blue, "red": red, "scale": row.get("Scale", 100)}
        for team, prefix in (("actions", blue), ("actionsRed", red)):
            acts: dict[str, dict] = {}
            rx = re.compile(re.escape(prefix) + r"_([A-Za-z]+[0-9]*)_([0-9]+)$")
            dirs: dict[str, set[int]] = defaultdict(set)
            for e in src.sc.exports:
                m = rx.match(e)
                if m:
                    dirs[m.group(1)].add(int(m.group(2)))
            for act, ds in sorted(dirs.items()):
                n = max(ds)
                if sorted(ds) != list(range(1, n + 1)):
                    self.warnings.append(f"{name}: {prefix}_{act} has gaps in directions {sorted(ds)}")
                first = f"{prefix}_{act}_1"
                info = self.clip_info(rel, first)
                labels = info.get("labels", {})
                a = {"export": f"{prefix}_{act}", "dirs": n, "frames": info["frames"], "fps": info["fps"]}
                if labels:
                    a["labels"] = labels
                    hit = [int(i) for i, lb in labels.items() if lb == "action_frame"]
                    if hit:
                        a["actionFrame"] = hit[0]
                acts[act] = a
                for d in sorted(ds):
                    self.want(rel, f"{prefix}_{act}_{d}")
            if team == "actionsRed" and red == blue:
                break
            entry[team] = acts
        for k in ("FlyingHeight", "CollisionRadius", "ShadowScaleX", "ShadowScaleY", "ShadowSkew", "ShadowX",
                  "ShadowY", "HealthBar", "HealthBarOffsetY", "HealthBarOffsetYBlue", "HealthBarOffsetYRed",
                  "HideHealthbar", "UseAnimator", "ProjectileStartZ", "ProjectileStartRadius", "DeployTime",
                  "DeployDelay", "Speed", "HitSpeed", "LoadTime", "Range", "AnimationsKeepLastFrame",
                  "TryToFinishAttackAnimation", "DontStopMoveAnim", "LoopMoveEffect"):
            if k in row:
                entry[k[0].lower() + k[1:]] = row[k]
        if row.get("ShadowCustom"):
            lib = self.want("sc/effects.sc", row["ShadowCustom"])
            if lib:
                entry["shadowCustom"] = {"sc": lib, "export": row["ShadowCustom"]}
        fx = {}
        for k in CHAR_EFFECT_FIELDS:
            if row.get(k):
                self.effect(row[k])
                fx[k[0].lower() + k[1:]] = row[k]
        if fx:
            entry["effects"] = fx
        for k in CHAR_FILTER_FIELDS:
            if row.get(k):
                lib = self.want("sc/effects.sc", row[k])
                if lib:
                    entry[k[0].lower() + k[1:]] = {"sc": lib, "export": row[k], **self.clip_info("sc/effects.sc", row[k])}
        for k in ("Projectile", "CustomFirstProjectile"):
            if row.get(k):
                self.projectile(row[k], projectiles)
                entry[k[0].lower() + k[1:]] = row[k]
        return entry

    # -- towers, arena, cards, HUD ---------------------------------------------------------------
    def towers(self, projectiles: dict) -> dict:
        bt = "sc/building_tower.sc"
        king, prin = self.buildings["KingTower"], self.buildings["PrincessTower"]
        out = {"positions": {"king": [9000, 3000], "princessLeft": [3500, 6500], "princessRight": [14500, 6500],
                             "note": "blue team; red = (x, 32000 - y)"}}
        k = {"sc": self.want(bt, king["BlueExportName"]), "blue": king["BlueExportName"],
             "red": king["RedExportName"], **self.clip_info(bt, king["BlueExportName"]),
             "turretChild": "turret", "kingChild": "king_dummy",
             "king": {"sc": self.want("sc/chr_king.sc", "King_blue"), "blue": "King_blue", "red": "King_red",
                      **self.clip_info("sc/chr_king.sc", "King_blue")},
             "turretFrames": 36,
             "destroyed": "kingtower_destroyed", "scale": king.get("Scale", 100),
             "attachedHeight": king.get("AttachedCharacterHeight"), "projectileStartZ": king.get("ProjectileStartZ"),
             "healthBar": king.get("HealthBar"), "healthBarOffsetYBlue": king.get("HealthBarOffsetYBlue"),
             "healthBarOffsetYRed": king.get("HealthBarOffsetYRed"),
             "shadow": {s: king.get(f"Shadow{s}") for s in ("ScaleX", "ScaleY", "Skew", "X", "Y")}}
        self.want(bt, king["RedExportName"])
        self.want("sc/chr_king.sc", "King_red")
        for e in ("default_blue_turret", "default_red_turret_bottom", "default_red_turret_mid", "default_red_turret_top"):
            self.want("sc/chr_king.sc", e)
        k["skinTurrets"] = {"blue": ["default_blue_turret"],
                            "red": ["default_red_turret_bottom", "default_red_turret_mid", "default_red_turret_top"]}
        p = {"sc": self.want(bt, prin["BlueExportName"]), "base": {"blue": prin["BlueExportName"], "red": prin["RedExportName"]},
             "top": {"blue": prin["BlueTopExportName"], "red": prin["RedTopExportName"]},
             "character": prin.get("AttachedCharacter"), "attachedHeight": prin.get("AttachedCharacterHeight"),
             "destroyed": "princesstower_destroyed", "scale": prin.get("Scale", 100),
             "healthBar": prin.get("HealthBar"), "healthBarOffsetYBlue": prin.get("HealthBarOffsetYBlue"),
             "healthBarOffsetYRed": prin.get("HealthBarOffsetYRed"),
             "shadow": {s: prin.get(f"Shadow{s}") for s in ("ScaleX", "ScaleY", "Skew", "X", "Y")}}
        for e in (prin["RedExportName"], prin["BlueTopExportName"], prin["RedTopExportName"], "kingtower_destroyed",
                  "princesstower_destroyed", "Tower_destroyed_ground1", "Tower_destroyed_ground2",
                  "Tower_destroyed_water1", "Tower_destroyed_water2", "StarTower_base_neutral", "StarTower_top_neutral"):
            self.want(bt, e)
        for row, d in ((king, k), (prin, p)):
            fx = {}
            for f in ("DeathEffect", "DamageEffect", "ProjectileEffect", "SpawnEffect"):
                if row.get(f):
                    self.effect(row[f])
                    fx[f[0].lower() + f[1:]] = row[f]
            d["effects"] = fx
            if row.get("Projectile"):
                self.projectile(row["Projectile"], projectiles)
                d["projectile"] = row["Projectile"]
        out["king"], out["princess"] = k, p
        return out

    def arena(self, location: str) -> dict:
        locs = load_json("locations")
        loc = locs[location]
        lay = read_location_csv(loc["FileName"])
        lib = self.want(lay["sc"], lay["export"])
        decos = {}
        for f in ("decos.csv", "decos_season.csv"):
            p = RAW / "csv_logic" / f
            if p.exists():
                for r in list(csv.DictReader(io.StringIO(p.read_text())))[1:]:
                    decos.setdefault(r["Name"], r)
        objs = []
        for o in lay["objects"]:
            if o["export"].startswith("foldable"):
                continue  # screen frames for foldable phones, not arena art
            d = decos.get(o["export"])
            if not d or not d.get("FileName") or not d.get("ExportName"):
                self.warnings.append(f"arena object {o['export']} has no decos.csv art")
                continue
            dl = self.want(d["FileName"], d["ExportName"])
            if not dl:
                continue
            ob = {"deco": o["export"], "sc": dl, "export": d["ExportName"], "x": o["x"], "y": o["y"],
                  "layer": d.get("Layer") or "Object"}
            for k in ("ShadowScaleX", "ShadowScaleY", "ShadowX", "ShadowY", "ShadowSkew", "SortValue"):
                if d.get(k):
                    ob[k[0].lower() + k[1:]] = int(d[k])
            if d.get("Animate"):
                ob["animate"] = d["Animate"].upper() == "TRUE"
            ob.update(self.clip_info(d["FileName"], d["ExportName"]))
            objs.append(ob)
        out = {
            "location": location, "sc": lib, "export": lay["export"], "objects": objs,
            # Alignment (see tools/art/README.md "Arena alignment"): SC pixel of a game point
            #   px = originPx[0] + (x - 9000) / 1000 * pxPerTileX
            #   py = originPx[1] - (y - 16000) / 1000 * pxPerTileY       (blue at the bottom)
            "pxPerTileX": 29.85, "pxPerTileY": 24.2, "originPx": [-1.6, 383.4], "originGame": [9000, 16000],
            "zPxPer1000": 17.5,
            "alignmentNote": (
                "Fitted to the goblin_bgr art (export-local SC pixels, scale 1): checker-tile edges of both "
                "field halves (least squares, residuals <1.4 px), river/bridge shapes centred on y=16000 "
                "(bridge clip ty 383 + 0.4) and the King/Princess pads (centres within 1 px of the fit). "
                "Units, towers and arena share one pixel scale (King tower art = 4 tiles = 120 px). "
                "zPxPer1000 assumes an orthographic camera: cos(asin(24.2/29.85)) * 29.85 (approximation)."),
            "objectsNote": "location objects use x right, y DOWN from the red edge (y_down = 32000 - y_game)",
            "shadow": {k: loc.get(k, 0) for k in ("ShadowR", "ShadowG", "ShadowB", "ShadowA", "ShadowOffsetX",
                                                   "ShadowOffsetY")},
        }
        if loc.get("CloudExportName"):
            cl = self.want(loc.get("CloudFileName", "sc/effects.sc"), loc["CloudExportName"])
            if cl:
                out["clouds"] = {"sc": cl, "export": loc["CloudExportName"],
                                 **{k[5:].lower(): loc[k] for k in loc if k.startswith("Cloud") and k not in
                                    ("CloudFileName", "CloudExportName")}}
        for k in ("WalkEffect", "LoopingEffect", "LoopingEffectRegularTime", "LoopingEffectOvertime"):
            if loc.get(k):
                self.effect(loc[k])
                out[k[0].lower() + k[1:]] = loc[k]
        return out

    def card(self, card: str) -> dict | None:
        row = self.spells.get(card)
        if not row or not row.get("IconFile"):
            return None
        rel = row.get("IconSWF") or "sc/ui_spells.sc"
        lib = self.want(rel, row["IconFile"])
        if not lib:
            return None
        d = {"sc": lib, "export": row["IconFile"], "elixir": row.get("ManaCost"), "rarity": row.get("Rarity"),
             "table": row["_table"]}
        for k in ("SummonCharacter", "SummonNumber", "Projectile", "AreaEffectObject", "Effect", "Radius",
                  "ProjectileWaves", "ProjectileWaveInterval", "MultipleProjectiles"):
            if k in row:
                d[k[0].lower() + k[1:]] = row[k]
        if row.get("Effect"):
            self.effect(row["Effect"])
        return d

    def hud(self) -> dict:
        ui = "sc/ui.sc"
        out = {"sc": "ui", "exports": [], "healthBars": {}, "healthBarParts": {}}
        for e in HUD_EXPORTS:
            if self.want(ui, e):
                out["exports"].append(e)
        hb_csv = RAW / "csv_client" / "health_bars.csv"
        rows = list(csv.DictReader(io.StringIO(hb_csv.read_text())))[1:]
        for r in rows:
            d = {}
            for k in ("PlayerExportName", "EnemyExportName", "NoDamagePlayerExportName", "NoDamageEnemyExportName",
                      "PlayerDivider", "EnemyDivider"):
                if r.get(k) and self.want(r.get("FileName") or ui, r[k]):
                    d[k[0].lower() + k[1:]] = r[k]
            for k in ("MinimumHitpointValue", "SegmentsCount"):
                if r.get(k):
                    d[k[0].lower() + k[1:]] = int(r[k])
            for k in ("ShowOwnAlways", "ShowEnemyAlways", "ShowAsShield"):
                if r.get(k):
                    d[k[0].lower() + k[1:]] = r[k].lower() == "true"
            out["healthBars"][r["Name"]] = d
        # New-style bars (healthbars.toml): Badge + Bar parts per type.
        toml = (RAW / "csv_client" / "healthbars.toml").read_text()
        cur = None
        for line in toml.splitlines():
            m = re.match(r"\s*\[CLIENT_ACTION\.(\w+)\]", line)
            if m:
                cur = {"name": m.group(1)}
                out["healthBarParts"][cur["name"]] = cur
                continue
            m = re.match(r'\s*(\w+)\s*=\s*(.+)$', line)
            if m and cur is not None:
                k, v = m.group(1), m.group(2).strip()
                if v.startswith('"'):
                    v = v.strip('"')
                    if k.endswith("ExportName"):
                        self.want(ui, v)
                elif v.startswith("["):
                    v = re.findall(r'"([^"]*)"', v)
                else:
                    try:
                        v = int(v)
                    except ValueError:
                        pass
                cur[k[0].lower() + k[1:]] = v
        # multi-line ClientActions arrays
        for blk in re.finditer(r"\[CLIENT_ACTION\.(\w+)\]([^\[]*(?:\[[^\]]*\][^\[]*)*?)(?=\n\[CLIENT_ACTION|\Z)", toml):
            acts = re.search(r"ClientActions\s*=\s*\[(.*?)\]", blk.group(2), re.S)
            if acts:
                out["healthBarParts"][blk.group(1)]["clientActions"] = re.findall(r'"([^"]*)"', acts.group(1))
        return out

    # -- main ------------------------------------------------------------------------------------
    def run(self):
        a = self.args
        t0 = time.time()
        projectiles: dict = {}
        characters: dict = {}
        cards: dict = {}
        for raw in [s for s in a.chars.split(",") if s.strip()] + ["TowerPrincess"]:
            name, card = self.resolve_char_name(raw.strip())
            if name is None:
                self.warnings.append(f"unknown character/card {raw!r}")
                continue
            row = self.chars.get(name) or self.buildings.get(name)
            entry = self.unit_art(name, row, projectiles)
            if entry is None:
                continue
            if card:
                entry["card"] = card
                c = self.card(card)
                if c:
                    cards[card] = c
            if raw.strip() != name:
                entry["requestedAs"] = raw.strip()
            characters[name] = entry
        spells = {}
        for raw in [s for s in a.spells.split(",") if s.strip()]:
            row = self.spells.get(raw.strip())
            if not row:
                self.warnings.append(f"unknown spell {raw!r}")
                continue
            c = self.card(raw.strip())
            if c:
                cards[raw.strip()] = c
            d = {"card": raw.strip()}
            if row.get("Projectile"):
                self.projectile(row["Projectile"], projectiles)
                d["projectile"] = row["Projectile"]
            if row.get("Effect"):
                self.effect(row["Effect"])
                d["effect"] = row["Effect"]
            if row.get("AreaEffectObject"):
                aeo = self.aeos.get(row["AreaEffectObject"], {})
                d["areaEffectObject"] = row["AreaEffectObject"]
                for k in ("ScaledEffect", "LoopingEffect", "OneShotEffect", "HitEffect", "SpawnEffect"):
                    if aeo.get(k):
                        self.effect(aeo[k])
                        d[k[0].lower() + k[1:]] = aeo[k]
            spells[raw.strip()] = d
        towers = self.towers(projectiles)
        arena = self.arena(a.location)
        hud = self.hud()
        extra_fx = [s for s in (a.effects or "").split(",") if s.strip()]
        for e in extra_fx:
            self.effect(e.strip())

        # -- write libraries -------------------------------------------------------------------
        sc_dir = OUT / "sc"
        sc_dir.mkdir(parents=True, exist_ok=True)
        for old in sc_dir.iterdir():
            if old.suffix in (".json", ".png", ".webp"):
                old.unlink()
        libs, total_json, total_tex = {}, 0, 0
        self.log(f"writing {len(self.need)} libraries to {sc_dir}")
        for rel in sorted(self.need):
            src = self.src[rel]
            info = export_library(src, self.need[rel], sc_dir, a.format, a.downscale, self.log)
            libs[src.name] = {"json": f"sc/{src.name}.json", **info}
            total_json += info["json"]
            total_tex += info["textures"]
        fonts = {}
        if a.fonts:
            fdir = OUT / "fonts"
            fdir.mkdir(exist_ok=True)
            for fam, fname in (("Supercell-Magic", "supercell-magic_0.ttf"), ("SC CCBackBeat", "sc_ccbackbeatregular.ttf")):
                if apk.exists(f"font/{fname}"):
                    (fdir / fname).write_bytes(apk.read(f"font/{fname}"))
                    fonts[fam] = f"fonts/{fname}"
        manifest = {
            "version": 1, "build": "160402020", "generatedBy": "tools/art/bake_web.py",
            "args": {"chars": a.chars, "spells": a.spells, "location": a.location, "format": a.format,
                     "downscale": a.downscale},
            "libs": {k: {"json": v["json"]} for k, v in libs.items()},
            "characters": characters, "spells": spells, "projectiles": projectiles,
            "effects": self.m_effects, "emitters": self.m_emitters, "towers": towers, "arena": arena,
            "cards": cards, "hud": hud, "fonts": fonts,
            "directions": ("export suffix 1 = facing screen up (away), mid = screen right, N = screen down; "
                           "left-facing = horizontal mirror of 2..N-1; N dirs span 180 degrees"),
            "missingEffects": sorted(self.missing_effects),
        }
        (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
        self.log(f"manifest: {len(characters)} characters, {len(projectiles)} projectiles, {len(self.m_effects)} "
                 f"effects, {len(self.m_emitters)} emitters, {len(cards)} cards")
        self.log(f"total: json {total_json / 1e6:.2f} MB, textures {total_tex / 1e6:.1f} MB "
                 f"({a.format}{', downscale %.2f' % a.downscale if a.downscale != 1 else ''}) in {time.time() - t0:.0f} s")
        if self.missing_effects:
            self.log(f"effects referenced by data but absent from effects.json ({len(self.missing_effects)}): "
                     f"{sorted(self.missing_effects)[:12]}")
        for w in sorted(set(self.warnings)):
            self.log("warning:", w)


def list_names():
    chars = load_json("characters")
    for t in ("spells_characters", "spells_other"):
        for k, v in load_json(t).items():
            if isinstance(v, dict):
                print(f"{t:18s} {k:28s} -> {v.get('SummonCharacter') or v.get('Projectile') or ''}")
    print("characters:", ", ".join(sorted(chars)))


def main():
    global OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--assets", help="asset zip or unpacked dir (default $CR_ASSETS / game-files/asset-pack)")
    ap.add_argument("--chars", default=DEFAULT_CHARS, help="comma list of character or card names")
    ap.add_argument("--spells", default=DEFAULT_SPELLS, help="comma list of spell card names")
    ap.add_argument("--effects", default="", help="extra effect names to include")
    ap.add_argument("--location", default="PvP_goblin", help="locations.csv row for the arena (Arena1 = PvP_goblin)")
    ap.add_argument("--format", choices=["webp", "png"], default="webp", help="atlas format (lossless either way)")
    ap.add_argument("--downscale", type=float, default=1.0, help="atlas scale factor, e.g. 0.5 for small bundles")
    ap.add_argument("--no-fonts", dest="fonts", action="store_false", help="do not copy the HUD fonts")
    ap.add_argument("--out", type=Path, default=None, help="output dir (default sim/viewer/assets)")
    ap.add_argument("--list-chars", action="store_true")
    args = ap.parse_args()
    apk.set_source(args.assets)
    if args.list_chars:
        list_names()
        return
    OUT = args.out or OUT
    Baker(args).run()


if __name__ == "__main__":
    main()
