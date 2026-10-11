# tools/art — Clash Royale asset extraction (local use only)

Decoders for the CR 160402020 asset pack. Outputs go to `extracted/art/` (gitignored).
Never commit or upload game assets.

Asset source: zip (`install_time_asset_pack.apk`) or an unpacked dir containing `assets/`.
Selected by `--assets PATH`, env `CR_ASSETS`, default `<repo>/game-files/asset-pack`.

```sh
python -m venv .venv && .venv/bin/pip install -r tools/art/requirements.txt
export CR_ASSETS=game-files/asset-pack          # or path to the .apk zip

python tools/art/apk.py search 'chr_knight'     # find members
python tools/art/apk.py pull sc/chr_knight.sc   # copy .sc + referenced .sctx to extracted/art/raw/sc/
python tools/art/sc2.py extracted/art/raw/sc/chr_knight.sc          # list exports/frames/textures
python tools/art/render.py extracted/art/raw/sc/chr_knight.sc \
    --export 'Knight_attack1_*' --sheet --scale 1.5 -o extracted/art/out/knight   # sheets + JSON
python tools/art/sctx.py extracted/art/raw/sc/chr_knight_0.sctx -o extracted/art/out   # atlas -> PNG
python tools/art/ktx.py  FILE.ktx -o OUT        # KTX2 ASTC -> PNG (sc3d materials)
python tools/art/glb_info.py FILE.glb           # inspect Supercell FLAT glTF (FLA2) files
python tools/art/make_samples.py                # proof renders -> extracted/art/samples/
```

Formats (verified):
- `.sc`  = SC2 v5: `"SC"`, u32le version=5, u32 len + FlatBuffer header (export names, counts),
  then a zstd frame holding size-prefixed FlatBuffers (DataStorage, ExportNames, TextFields,
  Shapes, MovieClips, Modifiers, Textures). Schemas: sc-workshop/SupercellFlash `sc2_schemas`.
- `.sctx` = size-prefixed FlatBuffer (id `SCTX`) + mip table + zstd ASTC payload
  (pixel_type 212 = ASTC 8x8) + a low-res ASTC proxy. Schema: sc-workshop/SupercellTexture.
- `.ktx` = KTX2, ASTC 4x4/6x6/8x8, no supercompression (sc3d materials only).
- `.glb` = GLB container with an `FLA2` (FlatBuffer glTF) chunk + `SC_odin_format`
  quantized mesh / packed animation data; stock glTF loaders reject it.

Unit export naming: `{Blue|RedExportName}_{run1|idle1|attack1}_{1..9}`; dir 1 = facing up/away,
5 = facing right, 9 = facing camera; left-facing = horizontal mirror of 2..8 (16 dirs).
Frame label `action_frame` marks the hit frame. Render JSON `anchor` = clip origin (feet) in px.
Logic CSV/TOML (FileName, BlueExportName, Projectile ExportName, ...) are 9-byte-header LZMA.
