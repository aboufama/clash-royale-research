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

## Web bake for the browser renderer (`bake_web.py`)

```sh
.venv/bin/python tools/art/bake_web.py                 # the engine's 70 cards + spawns, ~2 min
.venv/bin/python tools/art/bake_web.py --cards Knight,Archer,Fireball --units "" --projectiles "" \
    --aeos "" --buffs "" --format png --downscale 0.5   # a small subset
.venv/bin/python tools/art/bake_web.py --list-chars    # names accepted by --chars (character or card)
cd sim && npx esbuild viewer/src/sc-test.ts --bundle --format=esm --outfile=viewer/dist/sc-test.js \
    --servedir=viewer --serve=8090                     # gallery: http://localhost:8090/sc-test.html
```

Output goes to `sim/viewer/assets/` (gitignored, rebuilt by the script): one JSON per `.sc`
(shapes, clips, compacted matrix banks, exports, masks, text fields; format in the script's
docstring) plus lossless WebP/PNG atlases, `manifest.json` and the HUD fonts. Libraries are
tree-shaken to the exports the manifest needs; mostly-unused atlases (effects, ui, ui_spells) are
repacked with a 4-texel border. The default bake covers the engine's 70 cards with every unit,
building, projectile, area effect and buff they reach (`--cards`, `--units`, `--projectiles`,
`--aeos`, `--buffs`): 74 libraries, 10.2 MB JSON, 144 MB lossless WebP (`--downscale 0.5` roughly
halves the atlases). The first 22-unit set alone was 31 libraries / 54 MB. The renderer is `sim/viewer/src/sc/` (WebGL2, see `renderer.ts`).

What the manifest resolves from the build's data: characters (`FileName`, Blue/Red export names,
actions found as `<prefix>_<action>_<dir>` with frame counts, fps, labels and `action_frame`,
directions, Scale, shadow fields, effects, deploy filter, projectiles), projectiles (export, red
export, shadow, hit/trail effects), effects (`legacy_vfx/effects.json` components: SWF exports,
nested effects, emitters from `legacy_vfx/emitters.json`), towers (`building_tower.sc` King /
Princess exports, `chr_king.sc` King, destroyed exports), the arena (`locations.csv` ->
`locations/<arena>.csv` background + objects -> `decos.csv` art), in-battle card icons
(`IconFile` in `ui_spells.sc` or `IconSWF`) and HUD/health-bar exports (`ui.sc`,
`health_bars.csv`, `healthbars.toml`). Buildings: labelled single clips (`clip`: Tesla
deploy/idle/appear/hide, Tombstone, bombs, Rage bottle, Elixir Collector), clips with a `turret`
child (Cannon, X-Bow: 19 aim frames over 180 degrees) or direction exports (Inferno Tower, Mortar).
`areaEffects` (`area_effect_objects`: radius, lifetime, Scaled/Looping/OneShot/Spawn/Hit/NoFollowObject
effects; played by the client's area-effect view, `sim/viewer/src/sc/area_view.ts`) and `buffs`
(`character_buffs`: filter clip with loop = !FilterInheritLifeDuration, the buff view's effects and
flags). Scaled ground circles are drawn at the data radius in SC pixels without any scaling
(Freeze 3000 -> `spell_freeze_radius_blue` 178 px wide = 2 x 3 x 29.85), which independently
confirms the arena scale. Tower ruins come from the permanent particle
of the tower DeathEffect (`Tower_destroyed_ground2` King, `Tower_destroyed_ground1` Princess).

### Arena alignment (client projection, libg 0x857ffc)

    world = logic * 0.002                     (FUN_00851b54)
    sx = -270 + 15 * wx                       (ox = -(36 >> 1) * 15, 0x8578e4)
    sy =    0 + 12 * (wy - wz / 2)            (oy = 0)

i.e. 30 SC px per tile across, 24 along (0.8 foreshortening) and 12 px per 1000 units of
height, with the arena export drawn at the battle layer origin. This is the unflipped view
(logic y = 0 at the top). The viewer who is logic player 0 (blue, bottom) gets wx' = 36 - wx,
wy' = 64 - wy and the arena clip turned 180 degrees; location decorations are placed before that
flag is set and keep their unflipped positions. `sim/viewer/src/sc/battle_art.ts` implements both.
An earlier least-squares fit to the checker tiles (29.85 x 24.2 px, 17.5 px per 1000 height) was
close on the ground but put flying units, projectile arcs and the tower princess 46 % too high.

### Renderer fidelity vs `render.py`

`sim/viewer/sc-test.html?mode=compare&lib=..&export=..&frame=..` draws one clip; on the same
opaque background the WebGL output matches `render.py` within 0.1-0.4 mean absolute difference
per channel for unit, tower and effect clips (screenshots in `extracted/art/web-check/compare/`).
Differences by design: blend mode 4 (screen) and 3 (multiply) are real GL blends (render.py
treats all non-normal modes as additive), masks (modifiers 38/39/40) are applied with the stencil
buffer (render.py ignores them), text fields are drawn with the Supercell-Magic font.

Approximations (not recovered from the game code): particle emitter semantics (see
`sim/viewer/src/sc/effects.ts`), projectile frame selection (frames
read as pitch toward/away from the camera), nested clips sharing one clock (render.py's model),
the King turret frame mapping (36 frames over 180 degrees), health-bar placement, HUD layout
(card slots from the `cardArea`/`nextCard1` placeholders, elixir-bar stretching). Not
implemented: 9-slice scaling grids, particle tails/ribbon trails, damage flash (`filter_damage`
has no export; the game does it in code).
