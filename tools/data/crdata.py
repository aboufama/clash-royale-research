"""Shared loaders for decoded Clash Royale logic data (CSV + TOML).

CSV format (Supercell "logic CSV"):
  row 0  = column names
  row 1  = column types (int/Int, string/String, boolean, IntArray, StringArray,
           BooleanArray, float ...; case-insensitive)
  row 2+ = entries. A row whose first column (Name) is empty continues the
           previous entry; each such continuation row adds one more element to
           that entry's per-row arrays (per-level values, timeline sections,
           array-typed globals ...).

TOML format (newer per-unit files):
  [NAMESPACE.EntryName] tables, e.g. [CHARACTER.Knight], [PROJECTILE.X],
  [BUFF.X], [AEO.X], [ACTION.X], [EXT.X] (inherits Base="NS.Name" and applies
  overrides). Top-level per-table files (projectiles.toml, buildings.toml ...)
  use bare [EntryName] tables whose namespace is implied by the file.
  Override operators inside EXT: ["=", v] set, ["+", v] add, ["%", p] scale
  to p percent.
"""

from __future__ import annotations

import copy
import csv
import io
import re
import tomllib
from pathlib import Path

# Namespaces implied by top-level files that use bare [Name] headers.
FILE_DEFAULT_NS = {
    "characters_base.toml": "CHARACTER",
    "characters_evo.toml": "CHARACTER",
    "buildings.toml": "BUILDING",
    "buildings_evo.toml": "BUILDING",
    "projectiles.toml": "PROJECTILE",
    "projectiles_evo.toml": "PROJECTILE",
    "area_effect_objects.toml": "AEO",
    "area_effect_objects_evo.toml": "AEO",
    "character_buffs.toml": "BUFF",
    "character_buffs_evo.toml": "BUFF",
    "spells_characters.toml": "SPELL_CHARACTER",
    "spells_buildings.toml": "SPELL_BUILDING",
    "spells_other.toml": "SPELL_OTHER",
    "spells_evolved.toml": "SPELL_EVOLVED",
    "spells_heroes.toml": "SPELL_HERO",
    "actions.toml": "ACTION",
    "damage_types.toml": "DAMAGE_TYPE",
    "shapes.toml": "SHAPE",
    "targetresolvers.toml": "TARGET_RESOLVER",
    "game_object_filters.toml": "FILTER",
    "variables.toml": "VARIABLE",
}

KNOWN_NS = {
    "CHARACTER", "BUILDING", "PROJECTILE", "AEO", "BUFF", "ACTION", "EXT",
    "ABILITY", "STATS", "VARIABLE", "SPELL_CHARACTER", "SPELL_BUILDING",
    "SPELL_OTHER", "SPELL_EVOLVED", "SPELL_HERO", "CLIENT_ACTION", "SHAPE",
    "FILTER", "TARGET_RESOLVER", "DAMAGE_TYPE", "CARD_GROUP", "GAMEMODE",
    "PREDEFINEDDECK", "AUGMENT_WAVE", "ROULETTEDECKPOOL", "ROULETTEREGISTRY",
    "TOWER_SKIN_SET",
}

OPERATORS = {"=", "+", "%", "-", "*"}

# ---------------------------------------------------------------- CSV ----


def _convert(value: str, typ: str):
    t = typ.lower().replace("array", "")
    if value == "":
        return None
    if t == "int":
        try:
            return int(value)
        except ValueError:
            try:
                return int(float(value))
            except ValueError:
                return value
    if t == "boolean":
        v = value.strip().lower()
        if v in ("true", "1"):
            return True
        if v in ("false", "0"):
            return False
        return value
    if t == "float":
        try:
            return float(value)
        except ValueError:
            return value
    return value


def load_csv_table(path: Path):
    """Return (columns, types, entries). Each entry is a dict.

    Columns whose value appears on continuation rows become lists aligned by
    row index (trailing Nones trimmed, interior blanks kept as None). Columns
    of an *Array type always become lists. Everything else is a scalar.
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return [], [], []
    cols = rows[0]
    types = rows[1] + [""] * (len(cols) - len(rows[1]))
    groups: list[list[list[str]]] = []
    for row in rows[2:]:
        if not any(c.strip() for c in row):
            if groups:
                groups[-1].append([""] * len(cols))
            continue
        row = row + [""] * (len(cols) - len(row))
        if row[0] != "" or not groups:
            groups.append([row])
        else:
            groups[-1].append(row)
    entries = []
    for g in groups:
        e = {}
        for ci, col in enumerate(cols):
            if not col:
                continue
            typ = types[ci] if ci < len(types) else "string"
            vals = [_convert(r[ci], typ) for r in g]
            is_array_type = "array" in typ.lower()
            if is_array_type or any(v is not None for v in vals[1:]):
                while vals and vals[-1] is None:
                    vals.pop()
                if vals:
                    e[col] = vals
            elif vals[0] is not None:
                e[col] = vals[0]
        entries.append(e)
    return cols, types, entries


# --------------------------------------------------------------- TOML ----

_HEADER = re.compile(r"^(\s*)\[(\[?)\s*([^\]\[]+?)\s*\]\]?\s*(#.*)?$")


def _dedupe_tables(text: str):
    """Rename repeated [table] headers so tomllib accepts the file.

    Returns (text, dups) where dups maps renamed -> original header key.
    The native loader accepts a repeated table; we merge it field-wise
    afterwards (later values win).
    """
    seen = set()
    dups = {}
    out = []
    for line in text.splitlines():
        m = _HEADER.match(line)
        if m and not m.group(2):
            key = m.group(3)
            if key in seen:
                n = 2
                while f"{key}__dup{n}" in seen:
                    n += 1
                new = f"{key}__dup{n}"
                seen.add(new)
                dups[new] = key
                line = f"{m.group(1)}[{new}]"
            else:
                seen.add(key)
        out.append(line)
    return "\n".join(out), dups


def _get_path(d, dotted):
    parts = dotted.split(".")
    cur = d
    for p in parts[:-1]:
        cur = cur[p.strip('"')]
    return cur, parts[-1].strip('"')


def load_toml_lenient(path: Path):
    text = Path(path).read_text(encoding="utf-8-sig")
    try:
        return tomllib.loads(text), []
    except tomllib.TOMLDecodeError:
        pass
    fixed, dups = _dedupe_tables(text)
    data = tomllib.loads(fixed)
    notes = []
    for new, orig in dups.items():
        parent, leaf = _get_path(data, new)
        _, oleaf = _get_path(data, orig)
        extra = parent.pop(leaf)
        parent.setdefault(oleaf, {}).update(extra)
        notes.append(f"{Path(path).name}: duplicate table [{orig}] merged (later fields win)")
    return data, notes


def split_namespaces(data: dict, filename: str):
    """Yield (namespace, name, fields) for every entry in a TOML document."""
    default = FILE_DEFAULT_NS.get(filename)
    for key, val in data.items():
        if key in KNOWN_NS and isinstance(val, dict):
            for name, fields in val.items():
                yield key, name, fields
        elif key in KNOWN_NS and isinstance(val, list):
            yield key, "__list__", val
        elif default and isinstance(val, dict):
            yield default, key, val
        else:
            yield "__FILE__:" + filename, key, val


# ------------------------------------------------------ EXT inheritance ----


def is_operator(v):
    return (
        isinstance(v, list)
        and len(v) == 2
        and isinstance(v[0], str)
        and v[0] in OPERATORS
        and isinstance(v[1], (int, float))
    )


def apply_operator(base_val, op_val, notes, where):
    op, x = op_val
    if op == "=":
        return x
    if base_val is None:
        notes.append(f"{where}: operator {op_val} on missing base value; using 0")
        base_val = 0
    if op == "+":
        return base_val + x
    if op == "-":
        return base_val - x
    if op in ("%", "*"):
        # ["%", 120] -> 120 % of base. Integer stats stay integers (truncate).
        r = base_val * x / 100 if op == "%" else base_val * x
        return int(r) if isinstance(base_val, int) and float(r).is_integer() else (
            int(r) if isinstance(base_val, int) else r
        )
    return x


def merge_override(base: dict, over: dict, notes, where):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k == "Base":
            continue
        if is_operator(v):
            out[k] = apply_operator(out.get(k), v, notes, f"{where}.{k}")
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge_override(out[k], v, notes, f"{where}.{k}")
        else:
            out[k] = copy.deepcopy(v)
    return out
