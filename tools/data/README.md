# tools/data — Clash Royale 160402020 gameplay data extraction

Pure Python 3.11+ standard library (uses `tomllib`, `lzma`, `csv`). No pip deps.
Optional: `pip install zstandard` only if a future build ships zstd-framed files
(none in 160402020). Extracted data is game IP: keep it local (`extracted/` is gitignored).

## Inputs
* Asset pack, either the zip `install_time_asset_pack.apk` **or** the unpacked
  directory containing `assets/csv_logic/...`. Selected by CLI arg, else env
  `CR_ASSETS`, else default `<repo>/game-files/asset-pack`.
* The base `.apkm` contains no logic data (checked: only flutter/res/lib), so it is not needed.

## Commands (run from repo root)
```sh
# 1. decode csv_logic, csv_client, tilemaps, locations, level -> extracted/data/raw
python3 -I tools/data/decode_assets.py                      # default source
python3 -I tools/data/decode_assets.py game-files/asset-pack  # unpacked dir
CR_ASSETS=/path/install_time_asset_pack.apk python3 -I tools/data/decode_assets.py
python3 -I tools/data/decode_assets.py <source> <out_dir>   # explicit

# 2. build typed JSON -> extracted/data/json (one file per table + _build_report.json)
python3 -I tools/data/build_json.py [--raw extracted/data/raw] [--out extracted/data/json]

# 3. card list with mechanic flags -> extracted/data/json/cards.json
python3 -I tools/data/build_cards.py
```

## Files
* `decode_assets.py` — container detection: Supercell LZMA (`5d 00 00 04 00` + u32 size,
  vendored decoder), `Sig:` prefix, `SC` header, zstd, plain. Writes `raw/manifest.json`.
* `crdata.py` — shared loaders: Supercell CSV (names row, types row, continuation rows ->
  arrays), lenient TOML (merges the duplicate `[ImmuneToWeakPushback]` table), namespace
  splitting, `EXT` inheritance with `["=",v]`/`["+",v]`/`["%",p]` operators.
* `build_json.py` — merges everything, resolves references (`_meta.refs`), adds per-level
  arrays (`_meta.scaled`), tower scaling + match rules (`match_rules.json`), tilemaps.
* `build_cards.py` — playable cards (base / evolution / hero form) + mechanic flags.

See `docs/DATA_FIELDS.md` for field meanings, units and the merge rules.
