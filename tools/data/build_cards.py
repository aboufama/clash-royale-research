#!/usr/bin/env python3
"""Build cards.json (playable card list + mechanic flags) from build_json.py output.

Usage: python3 -I tools/data/build_cards.py [--json extracted/data/json] [--raw extracted/data/raw]
"""

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
csv.field_size_limit(sys.maxsize)


def load(d, n):
    return json.loads((d / n).read_text())


def english_names(raw: Path, tids):
    out = {}
    p = raw / "csv_client" / "texts.csv"
    if not p.exists():
        return out
    with p.open(encoding="utf-8-sig", newline="") as f:
        r = csv.reader(f)
        head = next(r)
        en = head.index("EN")
        for row in r:
            if row and row[0] in tids and len(row) > en:
                out[row[0]] = row[en]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=ROOT / "extracted/data/json")
    ap.add_argument("--raw", type=Path, default=ROOT / "extracted/data/raw")
    a = ap.parse_args()
    J = a.json
    objs = {}
    for ns, fn in [("CHARACTER", "characters.json"), ("BUILDING", "buildings.json"),
                   ("PROJECTILE", "projectiles.json"), ("AEO", "area_effect_objects.json"),
                   ("BUFF", "character_buffs.json")]:
        objs[ns] = load(J, fn)
    rar = load(J, "rarities.json")["rows"]
    tables = {"troop": load(J, "spells_characters.json"), "building": load(J, "spells_buildings.json"),
              "spell": load(J, "spells_other.json")}
    evo = load(J, "spells_evolved.json")
    hero = load(J, "spells_hero_form.json")

    def find(name):
        for ns in ("CHARACTER", "BUILDING", "PROJECTILE", "AEO"):
            if name in objs[ns]:
                return ns, objs[ns][name]
        return None, None

    def walk(name, seen, depth=0):
        """Collect object records reachable from name (refs, 3 levels)."""
        ns, rec = find(name)
        if rec is None or (ns, name) in seen or depth > 3:
            return []
        seen.add((ns, name))
        out = [(ns, name, rec)]
        for k, ref in rec.get("_meta", {}).get("refs", {}).items():
            for r in ref if isinstance(ref, list) else [ref]:
                if isinstance(r.get("ns"), str) and r["ns"] in ("BUFF",):
                    b = objs["BUFF"].get(r["name"])
                    if b and ("BUFF", r["name"]) not in seen:
                        seen.add(("BUFF", r["name"]))
                        out.append(("BUFF", r["name"], b))
                elif "Ignore" not in k:
                    out += walk(r["name"], seen, depth + 1)
        return out

    def mechanics(card, recs):
        m = set()
        if card.get("Mirror"):
            m.add("mirror")
        if card.get("Rarity") == "Champion":
            m.add("champion")
        for ns, name, r in recs:
            g = r.get
            if g("ChargeRange"):
                m.add("charge")
            if g("DashMaxRange") or g("DashDamage") or g("DashCount"):
                m.add("dash/jump-attack")
            if g("JumpEnabled"):
                m.add("river_jump")
            if g("SpawnCharacter") and ns in ("CHARACTER", "BUILDING") and (g("SpawnPauseTime") or g("SpawnInterval")):
                m.add("spawner")
            if g("DeathSpawnCharacter") or g("DeathSpawnProjectile"):
                m.add("death_spawn")
            if g("DeathDamage") or g("DeathAreaEffect"):
                m.add("death_damage")
            if g("Kamikaze"):
                m.add("kamikaze")
            if g("ShieldHitpoints"):
                m.add("shield")
            if g("ChainedHitCount") or (ns == "AEO" and g("HitBiggestTargets")):
                m.add("chain/biggest-target")
            if g("MultipleTargets") or g("MultipleProjectiles"):
                m.add("multi_target")
            if g("VariableDamage2"):
                m.add("ramp_up_damage")
            if g("TargetOnlyBuildings"):
                m.add("targets_buildings_only")
            if g("Clone") or g("SpawnClones"):
                m.add("clone")
            if g("Ability"):
                m.add("ability")
            if g("ManaCollectAmount") or g("ManaOnDeath") or g("ManaOnDeathForOpponent"):
                m.add("elixir_generation")
            if g("HidesWhenNotAttacking"):
                m.add("hides")
            if g("MorphCharacter") or g("SpawnPathfindMorph") or g("MorphTime"):
                m.add("morph")
            if g("AttractPercentage"):
                m.add("pull(tornado)")
            if g("Pushback") or g("AttackPushBack") or g("DashPushBack"):
                m.add("knockback")
            if ns == "BUFF":
                sm, hm = g("SpeedMultiplier"), g("HitSpeedMultiplier")
                if sm == -100 and hm == -100:
                    m.add("freeze/stun")
                elif isinstance(sm, int) and sm > 100 or isinstance(hm, int) and hm > 100:
                    m.add("rage/boost")
                elif isinstance(sm, int) and -100 < sm < 0:
                    m.add("slow")
                if g("DamagePerSecond"):
                    m.add("damage_over_time")
                if g("HealPerSecond"):
                    m.add("heal")
                if g("Invisible"):
                    m.add("invisibility")
            if any(k.startswith("On") and k.endswith("Action") for k in r) or g("AttackSequenceList"):
                m.add("scripted_actions")
        return sorted(m)

    def targets(card):
        t = []
        for k in ("SummonCharacter", "SummonCharacterSecond", "Projectile", "AreaEffectObject"):
            v = card.get(k)
            if v:
                t.append({"field": k, "name": v, "ns": find(v)[0]})
        for v in card.get("SummonCharactersList") or []:
            t.append({"field": "SummonCharactersList", "name": v, "ns": find(v)[0]})
        return t

    tids = set()
    for tab in list(tables.values()) + [evo, hero]:
        for r in tab.values():
            if r.get("TID"):
                tids.add(r["TID"])
    names = english_names(a.raw, tids)

    def forms(card):
        ev = card.get("EvolvedSpells") or []
        return ev if isinstance(ev, list) else [ev]

    def entry(name, card, ctype, form="base"):
        tg = targets(card)
        recs, seen = [], set()
        for t in tg:
            recs += walk(t["name"], seen)
        r = rar.get(card.get("Rarity", "Common"), {})
        e = {
            "id": name, "name": names.get(card.get("TID"), name), "type": ctype, "form": form,
            "elixir": card.get("ManaCost"), "rarity": card.get("Rarity"),
            "firstLevel": r.get("_firstCardLevel"), "count": card.get("SummonNumber") or (len(card["SummonCharactersList"]) if card.get("SummonCharactersList") else None),
            "deploys": tg, "mechanics": mechanics(card, recs),
            "eventOnly": bool(card.get("NotVisible") or card.get("NotInUse")),
        }
        if form == "evolution":
            e["evoCycles"] = card.get("DarkElixirCost")
        return e

    cards = []
    for ctype, tab in tables.items():
        for name, card in tab.items():
            if card.get("NotInUse") and card.get("NotVisible"):
                continue
            e = entry(name, card, ctype)
            f = forms(card)
            e["evolution"] = next((x for x in f if x.endswith("_EV1") and x in evo and not evo[x].get("NotInUse")), None)
            e["heroForm"] = next((x for x in f if x.endswith("_hero") and x in hero), None)
            if e["evolution"]:
                e["mechanics"] = sorted(set(e["mechanics"]) | {"has_evolution"})
            if e["heroForm"]:
                e["mechanics"] = sorted(set(e["mechanics"]) | {"has_hero_form"})
            cards.append(e)
    by_base = {c["id"]: c for c in cards}
    for c in list(cards):
        if c["evolution"]:
            cards.append(entry(c["evolution"], evo[c["evolution"]], c["type"], "evolution"))
        if c["heroForm"]:
            cards.append(entry(c["heroForm"], hero[c["heroForm"]], c["type"], "hero"))
    playable = [c for c in cards if not c["eventOnly"]]
    summary = {
        "base_cards_by_type": dict(Counter(c["type"] for c in playable if c["form"] == "base")),
        "evolutions": sum(1 for c in playable if c["form"] == "evolution"),
        "hero_forms": sum(1 for c in playable if c["form"] == "hero"),
        "event_only_cards": sum(1 for c in cards if c["eventOnly"]),
        "mechanics_counts_base_cards": dict(Counter(m for c in playable if c["form"] == "base" for m in c["mechanics"]).most_common()),
    }
    (J / "cards.json").write_text(json.dumps({"summary": summary, "cards": cards}, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
