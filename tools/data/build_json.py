#!/usr/bin/env python3
"""Build clean gameplay JSON from decoded Clash Royale logic data.

Usage:
  python3 -I tools/data/build_json.py [--raw extracted/data/raw] [--out extracted/data/json]

Input: output of decode_assets.py. Output: one JSON file per table plus
cards.json (playable card list) and _build_report.json (provenance, merge
conflicts, unresolved references).

Merge rules (determined from the data, see docs/DATA_FIELDS.md):
  * Units/buildings/projectiles/area effects/buffs/actions exist ONLY as TOML
    in this build (no characters.csv etc.). Each entry is defined in exactly
    one file. [EXT.X] entries inherit from Base="NS.Name" and override fields
    (operators ["=",v] / ["+",v] / ["%",p]); they are emitted into the base's
    namespace with _meta.extends set.
  * Cards (spells_*.csv) have a classic CSV row; TOML tables with the same
    name (spells_*.toml bare tables, or [SPELL_*.Name] in per-unit files) are
    field-level overrides/extensions. TOML wins on conflicts.
  * Level scaling: stat(L) = floor(base * M[idx] / 100), idx = L - 1 -
    RelativeLevel(unit Rarity); M = [100] + rarities.PowerLevelMultiplier.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crdata import (  # noqa: E402
    load_csv_table,
    load_toml_lenient,
    merge_override,
    split_namespaces,
)

ROOT = Path(__file__).resolve().parents[2]

# Namespace -> output file
NS_FILES = {
    "CHARACTER": "characters.json",
    "BUILDING": "buildings.json",
    "PROJECTILE": "projectiles.json",
    "AEO": "area_effect_objects.json",
    "BUFF": "character_buffs.json",
    "ACTION": "actions.json",
    "ABILITY": "abilities.json",
    "VARIABLE": "variables.json",
    "STATS": "stats_display.json",
    "SHAPE": "shapes.json",
    "FILTER": "game_object_filters.json",
    "TARGET_RESOLVER": "target_resolvers.json",
    "DAMAGE_TYPE": "damage_types.json",
    "CARD_GROUP": "card_groups.json",
    "CLIENT_ACTION": "client_actions.json",
    "GAMEMODE": "game_mode_components.json",
    "PREDEFINEDDECK": "predefined_decks_toml.json",
    "AUGMENT_WAVE": "augment_waves.json",
    "ROULETTEDECKPOOL": "royale_roulette_deck_pools.json",
    "ROULETTEREGISTRY": "royale_roulette_registry.json",
    "TOWER_SKIN_SET": "tower_skin_sets_toml.json",
}

SPELL_NS = {
    "SPELL_CHARACTER": "spells_characters",
    "SPELL_BUILDING": "spells_buildings",
    "SPELL_OTHER": "spells_other",
    "SPELL_EVOLVED": "spells_evolved",
    "SPELL_HERO": "spells_hero_form",
}

# Plain CSV tables worth exporting for simulation / reference.
CSV_TABLES = [
    "rarities", "globals", "game_modes", "battle_timelines", "locations",
    "arenas", "character_abilities", "tribes", "spell_stat_types",
    "game_tags", "predefined_decks", "spell_sets", "npcs", "pve_waves",
    "exp_levels", "evo_shard_conversion", "hero_conversion", "draft_deck",
    "pick_cards", "game_mode_plugin_configs", "tournament_tiers",
    "card_masteries", "global_ids_oldformat",
]

# Plain TOML tables (bare top-level tables, no namespace) to export as-is.
PLAIN_TOML = [
    "support_cards.toml", "support_rarities.toml", "spawn_groups.toml",
    "card_forms.toml", "elixir_drop.toml", "boosts.toml", "loadout.toml",
    "streak_config.toml", "random_arena_pools.toml", "rulers.toml",
    "ruler_rarities.toml", "schemas.toml",
]

# Integer stats that scale with card level (see docs). Others are flat.
SCALED_FIELDS = {
    "CHARACTER": ["Hitpoints", "ShieldHitpoints", "Damage", "DamageSpecial",
                  "DeathDamage", "DashDamage", "DashingDamage",
                  "VariableDamage2", "VariableDamage3", "AttackStateDamage",
                  "ReflectedAttackDamage", "ReflectAttackCrownTowerDamage"],
    "BUILDING": ["Hitpoints", "ShieldHitpoints", "Damage", "DamageSpecial",
                 "DeathDamage", "VariableDamage2", "VariableDamage3"],
    "PROJECTILE": ["Damage", "CrownTowerDamage", "PushbackDamage",
                   "HealAmount"],
    "AEO": ["Damage", "CrownTowerDamage"],
    "BUFF": ["DamagePerSecond", "HealPerSecond", "CrownTowerDamagePerHit",
             "BuildingDamagePerSecond", "DamagePerHit"],
}
MAX_CARD_LEVEL = 16

# Field-name hints for reference resolution: substring -> namespaces (ordered)
REF_HINTS = [
    ("Projectile", ["PROJECTILE"]),
    ("Buff", ["BUFF"]),
    ("AreaEffect", ["AEO"]),
    ("AreaObject", ["AEO"]),
    ("AEO", ["AEO"]),
    ("Aoe", ["AEO"]),
    ("Spell", ["SPELL_CHARACTER", "SPELL_OTHER", "SPELL_BUILDING", "SPELL_EVOLVED", "SPELL_HERO", "AEO", "PROJECTILE"]),
    ("Ability", ["ABILITY"]),
    ("Action", ["ACTION"]),
    ("Character", ["CHARACTER", "BUILDING"]),
    ("Morph", ["CHARACTER", "BUILDING"]),
    ("Summon", ["CHARACTER", "BUILDING"]),
    ("Spawn", ["CHARACTER", "BUILDING", "PROJECTILE", "AEO"]),
    ("Filter", ["FILTER"]),
    ("Shape", ["SHAPE"]),
    ("Resolver", ["TARGET_RESOLVER"]),
    ("DamageType", ["DAMAGE_TYPE"]),
    ("Stats", ["STATS"]),
]
NON_REF_FIELD = re.compile(
    r"(Effect|Export|FileName|SWF|Sound|TID|Icon|Shadow|Prestige|Shader|"
    r"Asset|Animation|Anim|Filename|Name$|^Name|Condition|Value|Tags|Flags|"
    r"HealthBar|Trail|Mesh|Layer|Prefab)",
)


def jdump(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=False) + "\n",
                    encoding="utf-8")


# ------------------------------------------------------------------ load ---


def load_all_toml(logic: Path, report):
    """Return entries[ns][name] = (fields, source) and ext list."""
    entries: dict[str, dict] = defaultdict(dict)
    spells_toml: dict[str, dict] = defaultdict(lambda: defaultdict(list))
    files = sorted(logic.rglob("*.toml"))
    for p in files:
        if p.name in PLAIN_TOML:
            continue
        rel = str(p.relative_to(logic))
        data, notes = load_toml_lenient(p)
        report["notes"].extend(notes)
        for ns, name, fields in split_namespaces(data, p.name):
            if ns.startswith("__FILE__"):
                report.setdefault("unclassified_toml", defaultdict(list))[rel].append(name)
                continue
            if ns in SPELL_NS:
                spells_toml[ns][name].append((rel, fields))
                continue
            if name in entries[ns]:
                report["duplicates"].append(f"{ns}.{name}: {entries[ns][name][1]} and {rel}")
                fields = merge_override(entries[ns][name][0], fields, report["notes"], f"{ns}.{name}")
            entries[ns][name] = (fields, rel)
    return entries, spells_toml


def resolve_ext(entries, report):
    """Expand EXT.X (Base = "NS.Name") into the base namespace."""
    ext = entries.pop("EXT", {})
    resolved = {}

    def resolve(name, stack=()):
        if name in resolved:
            return resolved[name]
        fields, src = ext[name]
        base_ref = fields.get("Base")
        if not base_ref or "." not in base_ref:
            report["notes"].append(f"EXT.{name}: missing/invalid Base {base_ref!r}")
            return None
        bns, bname = base_ref.split(".", 1)
        if bns == "EXT":
            if bname in stack:
                return None
            r = resolve(bname, stack + (name,))
            if r is None:
                return None
            bns, bfields, bmeta = r
        elif bname in entries.get(bns, {}):
            bfields = entries[bns][bname][0]
            bmeta = None
        elif bns in ("CHARACTER", "BUILDING") and bname in entries.get(
                "BUILDING" if bns == "CHARACTER" else "CHARACTER", {}):
            # Buildings are characters in the engine; Base lookups cross over.
            bns = "BUILDING" if bns == "CHARACTER" else "CHARACTER"
            bfields = entries[bns][bname][0]
            bmeta = None
        elif bname in ext:
            r = resolve(bname, stack + (name,))
            if r is None:
                return None
            bns, bfields, bmeta = r
        else:
            report["unresolved_ext_base"].append(f"EXT.{name} -> {base_ref} ({src})")
            return None
        merged = merge_override(bfields, fields, report["notes"], f"EXT.{name}")
        merged["Name"] = name
        resolved[name] = (bns, merged, {"source": src, "extends": base_ref})
        return resolved[name]

    for name in list(ext):
        r = resolve(name)
        if r is None:
            continue
        bns, merged, meta = r
        for ons in ("CHARACTER", "BUILDING") if bns in ("CHARACTER", "BUILDING") else (bns,):
            if name in entries.get(ons, {}):
                # Partial table for the same name (e.g. [[CHARACTER.X.AttackSequenceList]]
                # next to [EXT.X]): apply it on top of the inherited record.
                partial, psrc = entries[ons].pop(name)[:2]
                merged = merge_override(merged, partial, report["notes"], f"{ons}.{name}")
                report["notes"].append(f"EXT.{name}: merged partial {ons}.{name} table from {psrc}")
        entries[bns][name] = (merged, meta["source"], meta["extends"])
    return entries


# ----------------------------------------------------------- rarities ----


def build_rarities(logic: Path):
    _, _, ents = load_csv_table(logic / "rarities.csv")
    out = {}
    for e in ents:
        name = e["Name"]
        mult = e.get("PowerLevelMultiplier")
        mult = mult if isinstance(mult, list) else [mult]
        e["_multiplierByIndex"] = [100] + [m for m in mult if m is not None]
        rel = e.get("RelativeLevel", 0)
        e["_firstCardLevel"] = rel + 1
        e["_maxCardLevel"] = rel + e.get("LevelCount", 0)
        e["_tournamentCardLevel"] = rel + 1 + e.get("TournamentLevelIndex", 0)
        out[name] = e
    return out


def scale(base, card_level, unit_rarity, rarities):
    r = rarities.get(unit_rarity) or rarities["Common"]
    idx = card_level - 1 - r.get("RelativeLevel", 0)
    m = r["_multiplierByIndex"]
    if idx < 0 or idx >= len(m):
        return None
    return base * m[idx] // 100


def tower_multipliers(globals_, kind: str, field: str, max_level=MAX_CARD_LEVEL):
    """Tower scaling derived from globals; verified against known values.

    m(1)=100; m(L)=floor(m(L-1)*(100+p)/100) with p = *_PER_<KIND>_LEVEL for
    L<=TOWER_SCALING_START_EXP_LEVEL(9) and *_AFTER_TOURNAMENTCAP above.
    """
    p1 = globals_[f"{field}_INCREASE_PERCENT_PER_{kind}_LEVEL"]["NumberValue"]
    p2 = globals_[f"{field}_INCREASE_PERCENT_PER_{kind}_LEVEL_AFTER_TOURNAMENTCAP"]["NumberValue"]
    cap = globals_["TOWER_SCALING_START_EXP_LEVEL"]["NumberValue"]
    m = [100]
    for lvl in range(2, max_level + 1):
        p = p1 if lvl <= cap else p2
        m.append(m[-1] * (100 + p) // 100)
    return m


# ------------------------------------------------------------- refs -----


def ref_namespaces(field: str):
    for hint, nss in REF_HINTS:
        if hint in field:
            return nss
    return None


def find_refs(fields: dict, index: dict, path=""):
    refs = {}
    for k, v in fields.items():
        key = f"{path}{k}"
        if isinstance(v, dict):
            refs.update(find_refs(v, index, key + "."))
            continue
        vals = v if isinstance(v, list) else [v]
        if isinstance(v, list) and v and isinstance(v[0], dict):
            for i, item in enumerate(v):
                refs.update(find_refs(item, index, f"{key}[{i}]."))
            continue
        if NON_REF_FIELD.search(k) and "Spawn" not in k and "Projectile" not in k:
            continue
        hits = []
        for s in vals:
            if not isinstance(s, str) or not s:
                continue
            cand = index.get(s)
            if not cand:
                continue
            pref = ref_namespaces(k)
            chosen = [ns for ns in (pref or []) if ns in cand] or (cand if pref is None else [])
            if chosen:
                hits.append({"name": s, "ns": chosen[0] if len(chosen) == 1 else chosen})
        if hits:
            refs[key] = hits[0] if len(hits) == 1 and not isinstance(v, list) else hits
    return refs


# ------------------------------------------------------------- main -----


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=ROOT / "extracted/data/raw")
    ap.add_argument("--out", type=Path, default=ROOT / "extracted/data/json")
    args = ap.parse_args()
    logic = args.raw / "csv_logic"
    out = args.out
    report = {"notes": [], "duplicates": [], "unresolved_ext_base": [],
              "spell_conflicts_toml_wins": [], "unresolved_refs": defaultdict(list)}

    rarities = build_rarities(logic)
    _, _, gl = load_csv_table(logic / "globals.csv")
    globals_ = {e["Name"]: e for e in gl}

    entries, spells_toml = load_all_toml(logic, report)
    entries = resolve_ext(entries, report)

    # name -> namespaces index for reference resolution
    index = defaultdict(list)
    for ns, d in entries.items():
        for name in d:
            index[name].append(ns)

    # ---- spells: CSV base + TOML overrides
    spells = {}
    for ns, base in SPELL_NS.items():
        cols, types, rows = load_csv_table(logic / f"{base}.csv")
        table = {}
        for e in rows:
            e = dict(e)
            e["_meta"] = {"namespace": ns, "source": [f"{base}.csv"]}
            table[e["Name"]] = e
        for name, contribs in spells_toml.get(ns, {}).items():
            rec = table.get(name)
            if rec is None:
                rec = {"Name": name, "_meta": {"namespace": ns, "source": [], "toml_only": True}}
                table[name] = rec
            for src, f in contribs:
                for k, v in f.items():
                    if k in rec and k != "_meta" and rec[k] != v:
                        report["spell_conflicts_toml_wins"].append(
                            {"spell": f"{ns}.{name}", "field": k, "csv_or_prev": rec[k], "toml": v, "file": src})
                    rec[k] = copy.deepcopy(v)
                rec["_meta"]["source"].append(src)
        for name in table:
            index[name].append(ns)
        spells[ns] = table

    # ---- emit unit-like namespaces with refs + level scaling
    for ns, d in sorted(entries.items()):
        fname = NS_FILES.get(ns, ns.lower() + ".json")
        table = {}
        for name, tup in sorted(d.items()):
            fields, src = tup[0], tup[1]
            rec = copy.deepcopy(fields) if isinstance(fields, dict) else {"_list": fields}
            if isinstance(fields, dict):
                rec.setdefault("Name", name) if ns in ("CHARACTER", "BUILDING", "PROJECTILE", "AEO", "BUFF") else None
            meta = {"namespace": ns, "source": src}
            if len(tup) > 2:
                meta["extends"] = tup[2]
            if isinstance(fields, dict):
                refs = find_refs(fields, index)
                if refs:
                    meta["refs"] = refs
                if ns in SCALED_FIELDS:
                    rar = fields.get("Rarity", "Common")
                    r = rarities.get(rar, rarities["Common"])
                    scaled = {}
                    mode = fields.get("DamageScalingMode")
                    levels = list(range(r["_firstCardLevel"], MAX_CARD_LEVEL + 1))
                    for f in SCALED_FIELDS[ns]:
                        v = fields.get(f)
                        if isinstance(v, dict):  # Damage = { BaseDamage, TowerDamage }
                            for sub in ("BaseDamage", "TowerDamage"):
                                sv = v.get(sub)
                                if isinstance(sv, int) and not isinstance(sv, bool) and sv != 0:
                                    scaled[f"{f}.{sub}"] = [scale(sv, L, rar, rarities) for L in levels]
                        elif isinstance(v, int) and not isinstance(v, bool) and v != 0:
                            scaled[f] = [scale(v, L, rar, rarities) for L in levels]
                    if scaled:
                        scaled["_levels"] = list(range(r["_firstCardLevel"], MAX_CARD_LEVEL + 1))
                        if mode or fields.get("IsSummonerTower") or fields.get("IsSummoner"):
                            scaled["_note"] = "tower scaling: see match_rules.json tower_scaling (card multipliers do not apply)"
                        meta["scaled"] = scaled
            rec["_meta"] = meta
            table[name] = rec
        jdump(table, out / fname)

    # ---- spells output (+ refs)
    for ns, table in spells.items():
        for name, rec in table.items():
            refs = find_refs({k: v for k, v in rec.items() if k != "_meta"}, index)
            if refs:
                rec["_meta"]["refs"] = refs
        jdump(table, out / f"{SPELL_NS[ns]}.json")

    # ---- plain CSV tables
    for t in CSV_TABLES:
        p = logic / f"{t}.csv"
        if not p.exists():
            continue
        cols, types, rows = load_csv_table(p)
        key = cols[0]
        keyed = {}
        dup = False
        for e in rows:
            k = e.get(key)
            if k is None or k in keyed:
                dup = True
                break
            keyed[k] = e
        payload = {"_columns": dict(zip(cols, types)), "rows": rows if dup else keyed}
        if t == "rarities":
            payload["rows"] = rarities
        jdump(payload, out / f"{t}.json")

    # ---- plain TOML tables
    for t in PLAIN_TOML:
        p = logic / t
        if p.exists():
            data, notes = load_toml_lenient(p)
            jdump(data, out / (Path(t).stem + ".json"))

    # ---- tilemaps (arena logic grids)
    tiles = {}
    for p in sorted((args.raw / "tilemaps").glob("*.csv")):
        tiles[p.stem] = parse_tilemap(p)
    jdump(tiles, out / "tilemaps.json")

    # ---- match rules + tower scaling
    match = build_match_rules(logic, globals_, rarities, entries)
    jdump(match, out / "match_rules.json")

    # ---- globals as flat dict
    flat = {}
    for name, e in globals_.items():
        v = {k: e[k] for k in ("NumberValue", "BooleanValue", "TextValue", "StringArray",
                                "NumberArray", "NumberArray2", "FloatValue") if k in e}
        flat[name] = v if len(v) != 1 else next(iter(v.values()))
    jdump(flat, out / "globals_flat.json")

    report["unresolved_refs"] = dict(report["unresolved_refs"])
    if "unclassified_toml" in report:
        report["unclassified_toml"] = {k: v for k, v in report["unclassified_toml"].items()}
    report["counts"] = {NS_FILES.get(ns, ns): len(d) for ns, d in entries.items()}
    report["counts"].update({SPELL_NS[ns]: len(t) for ns, t in spells.items()})
    jdump(report, out / "_build_report.json")
    print(json.dumps(report["counts"], indent=1))
    print("notes:", len(report["notes"]), "dups:", len(report["duplicates"]),
          "unresolved EXT:", len(report["unresolved_ext_base"]),
          "spell conflicts:", len(report["spell_conflicts_toml_wins"]))


TILE_FLAGS_DOC = {
    "1": "road / path for left lane (bottom-left & top-left)",
    "2": "road / path for right lane",
    "16": "blocked (not walkable / not deployable), e.g. back corners and river banks; combined with 1|2 under the king tower",
    "32": "water (river): ground units cannot walk, only bridges",
    "128": "marker (unknown purpose; symmetric points per side, possibly special-mode spawn points)",
    "256": "bridge marker (257 = left bridge, 258 = right bridge)",
    "512": "marker at arena centre line of one half (unknown purpose)",
}


def parse_tilemap(path: Path):
    """Parse a tilemap CSV: 'Map' section (36x64 int flag grid, 500-unit cells)
    plus optional 'Layout' section of object placements in cell coordinates."""
    import csv as _csv
    rows = list(_csv.reader(path.read_text(encoding="utf-8-sig").splitlines()))
    sections = []
    for r in rows:
        if r and r[0].strip():
            sections.append([r[0].strip(), []])
        elif sections:
            sections[-1][1].append(r)
    out = {"grid": [], "layout": {}}
    for name, body in sections:
        if name == "Map":
            for r in body[2:]:
                cells = r[1:]
                if not any(c.strip() for c in cells):
                    continue
                out["grid"].append([int(c) if c.strip() else 0 for c in cells])
        elif name == "Layout":
            cur = None
            for r in body:
                r = r + [""] * 4
                if r[1].strip():
                    cur = r[1].strip()
                    out["layout"].setdefault(cur, [])
                elif cur and r[2].strip() and r[2].strip() not in ("x", "int"):
                    out["layout"][cur].append({"x": int(r[2]), "y": int(r[3])})
    out["width"] = len(out["grid"][0]) if out["grid"] else 0
    out["height"] = len(out["grid"])
    if not out["layout"]:
        del out["layout"]
    return out


def build_match_rules(logic, globals_, rarities, entries):
    _, _, tl = load_csv_table(logic / "battle_timelines.csv")
    timelines = {}
    for e in tl:
        secs = []
        lens = e.get("SectionLength") or []
        types = e.get("SectionType") or []
        for i, L in enumerate(lens):
            secs.append({"lengthSec": L, "type": types[i] if i < len(types) else None})
        rates = []
        t = 0
        for i, L in enumerate(e.get("ElixirRateLength") or []):
            full = (e.get("ElixirFullBarMS") or [None])[i] if i < len(e.get("ElixirFullBarMS") or []) else None
            rates.append({"fromSec": t, "toSec": t + L if L else None, "fullBarMs": full,
                          "msPerElixir": full / 10 if full else None,
                          "displayMultiplierX10": (e.get("ElixirRateVisible") or [None] * 10)[i]
                          if i < len(e.get("ElixirRateVisible") or []) else None})
            t += L
        timelines[e["Name"]] = {"startingElixir": e.get("StartingElixir"), "sections": secs,
                                "elixirRates": rates, "raw": e}

    def g(name):
        e = globals_.get(name)
        if not e:
            return None
        for k in ("NumberValue", "BooleanValue", "TextValue", "NumberArray", "StringArray"):
            if k in e:
                return e[k]
        return None

    tower = {
        "princess_hp_multiplier": tower_multipliers(globals_, "TOWER", "HITPOINT"),
        "princess_damage_multiplier": tower_multipliers(globals_, "TOWER", "DAMAGE"),
        "king_hp_multiplier": tower_multipliers(globals_, "KING", "HITPOINT"),
        "king_damage_multiplier": tower_multipliers(globals_, "KING", "DAMAGE"),
        "_formula": "value(L) = floor(base * m[L-1] / 100); m[0]=100; m[L]=floor(m[L-1]*(100+p)/100), "
                    "p=*_PER_<TOWER|KING>_LEVEL for L<=TOWER_SCALING_START_EXP_LEVEL else *_AFTER_TOURNAMENTCAP",
    }
    kt = entries["BUILDING"]["KingTower"][0]
    pt = entries["BUILDING"]["PrincessTower"][0]
    kp = entries["PROJECTILE"]["KingProjectile"][0]
    pp = entries["PROJECTILE"]["TowerPrincessProjectile"][0]
    tower["king_tower"] = {"Hitpoints": [kt["Hitpoints"] * m // 100 for m in tower["king_hp_multiplier"]],
                           "Damage": [kp["Damage"] * m // 100 for m in tower["king_damage_multiplier"]],
                           "HitSpeed": kt.get("HitSpeed"), "LoadTime": kt.get("LoadTime"),
                           "Range": kt.get("Range"), "SightRange": kt.get("SightRange"),
                           "CollisionRadius": kt.get("CollisionRadius"),
                           "ProjectileSpeed": kp.get("Speed")}
    tower["princess_tower"] = {"Hitpoints": [pt["Hitpoints"] * m // 100 for m in tower["princess_hp_multiplier"]],
                               "Damage": [pp["Damage"] * m // 100 for m in tower["princess_damage_multiplier"]],
                               "HitSpeed": pt.get("HitSpeed"), "LoadTime": pt.get("LoadTime"),
                               "Range": pt.get("Range"), "SightRange": pt.get("SightRange"),
                               "CollisionRadius": pt.get("CollisionRadius"),
                               "ProjectileSpeed": pp.get("Speed")}
    keys = ["MAX_MANA", "LOGIC_BATTLE_START_COOLDOWN", "LOGIC_BATTLE_START_COOLDOWN_2V2",
            "LADDER_LEAGUES_OVERTIME_LENGTH", "CROWNS_PER_TOWER_STANDING", "MELEE_RANGE_LIMIT",
            "MELEE_RANGE_LIMIT_CLOSE", "MELEE_RANGE_LIMIT_MEDIUM", "ATTACK_FINISH_TIME_MS",
            "EXTRA_SIGHT_RANGE_TO_CROWN_TOWERS", "EXTRA_SIGHT_RANGE_TO_BUILDING",
            "ADD_CHARACTER_RANGE_TO_RADIUS", "MIRROR_LEVEL_OFFSET", "CLONE_LEVEL_OFFSET",
            "CLONE_DISTANCE_X", "CLONE_DISTANCE_Y", "MAX_PUSHBACK_LENGTH",
            "CHAMPION_RETURN_TO_CYCLE_POSITION", "TOWER_SCALING_START_EXP_LEVEL",
            "DEFLECTED_PRJ_TOWERS_DMG_MUL", "DEFLECTED_SPELL_TOWERS_DMG_MUL", "MAX_DEFLECTION_TIMES",
            "LOGIC_RANGE_EXTENSION_TO_KEEP_TARGET", "LOGIC_CANCEL_HIT_FROM_LONG_DISTANCE_RANGE",
            "LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS", "LOGIC_CHARACTER_CONTINUOUS_DAMAGE_ATTACK_CLOSER",
            "PANIC_SPEED_MULTIPLIER", "EXTRA_BUFF_RADIUS", "ORIGINAL_MAX_LEVEL",
            "DAMAGE_INCREASE_PERCENT_PER_SPELL_LEVEL", "HITPOINT_INCREASE_PERCENT_PER_SPELL_LEVEL"]
    logic_flags = {k: g(k) for k in globals_ if k.startswith(("LOGIC_", "PATHFINDING_", "CLONE_", "MIRROR_"))}
    spawn_groups, _ = load_toml_lenient(logic / "spawn_groups.toml")
    return {
        "_doc": "See docs/DATA_FIELDS.md. Times in seconds where key says Sec, else ms. Distances in game units (1000 = 1 tile).",
        "default_timeline": "Default",
        "timelines": timelines,
        "globals": {k: g(k) for k in keys},
        "logic_flags": logic_flags,
        "tower_scaling": tower,
        "card_level": {
            "max": MAX_CARD_LEVEL,
            "tournament_standard": rarities["Common"]["_tournamentCardLevel"],
            "common_multiplier_by_level": rarities["Common"]["_multiplierByIndex"],
            "rarity_first_level": {k: v["_firstCardLevel"] for k, v in rarities.items()},
        },
        "spawn_groups": spawn_groups,
        "arena": {
            "map_width_cells": 36, "map_height_cells": 64, "cell_size_units": 500,
            "width_units": 18000, "height_units": 32000, "tile_units": 1000,
            "tilemap": "tilemaps.json:tilemap",
            "tile_flags": TILE_FLAGS_DOC,
        },
    }


if __name__ == "__main__":
    main()
