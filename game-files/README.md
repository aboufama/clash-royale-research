# Pinned original game inputs (private)

These are original Supercell files for Clash Royale Android build
**160402020**. They are here so a cloud session can work without
re-downloading. **Keep this repository private.** See
[../AGENTS.md](../AGENTS.md).

## apk/

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `clash-royale-160402020.apkm` | 72,343,657 | `89b88338537af9ff29f6d02dc667448b9e89be49f327ebd46ca20f489634c5c3` |

- Source: APKMirror bundle
  `com.supercell.clashroyale_160402020-160402020_1arch_2dpi_24lang_…apkmirror.com.apkm`.
- It's a ZIP of split APKs: `base.apk` plus `split_config.arm64_v8a.apk`, which
  holds the native libraries, including the game engine `libg.so` (28 MB). Its
  code is protected. The research track recovers the runnable code by
  emulating its loader; see `research/findings.md`.
- `metadata.json` lists per-split hashes and the signing certificate
  (`59ea9ded5f79298a50103d254497ca71ca80332492c749375044879b8f099357`), as
  verified by the research track (`scripts/verify_apks.py`, `scripts/prepare_apkm.py`).

## asset-pack/

The unpacked contents of the signed install-time asset pack,
`install_time_asset_pack.apk`. The original archive is 913,096,301 bytes,
SHA-256 `3e62afcf73786919be08b0a48f1744d82b618642fed8e8db7d1a76b5b2eb3fd3`, and
was fetched from APKFab with `scripts/fetch_asset_pack.py`. It isn't committed
whole because GitHub limits files to 100 MB. All 10,870 members are committed
unchanged. Verify them with:

```bash
cd game-files/asset-pack && shasum -a 256 -c ../asset-pack.sha256 --quiet
```

What's inside `assets/`, roughly:

| Path | Contents |
| --- | --- |
| `csv_logic/` | Gameplay data: classic CSV tables plus per-unit TOML (characters, buildings, projectiles, spells, buffs…). Many are Supercell-LZMA-compressed; see `scripts/sc_lzma.py` |
| `csv_client/` | Client-side tables (effects, animations, UI) |
| `sc/` | 2D sprite/movie-clip files (`.sc`) and textures (`.sctx`), about 537 MB |
| `sc3d/` | 3D models (`.glb`), materials (`.rmat`) and textures (`.ktx`), about 212 MB |
| `image/` | PNGs, including card/character art |
| `sfx/`, `soundbanks/` | Sound effects (`.ogg`) and FMOD banks (`.bank`) |
| `locations/`, `tilemaps/`, `level/` | Arena and map data |
| `fingerprint.json` | The pack's own file/hash manifest |

Later live updates downloaded by the game are **not** included. The data here
is what ships at install time for this build.
