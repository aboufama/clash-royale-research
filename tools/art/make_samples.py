"""Produce the proof-of-concept renders in extracted/art/samples/.

  python make_samples.py [--scale 2]

(a) Knight run + attack, 9 authored directions (sheets + JSON) and a 16-direction overview
(b) King tower (blue/red) with the King + turret overlays; Princess tower composite
(c) projectiles: arrow (Archers / Princess tower), cannonball (Musketeer / King), fireball
(d) arena ground: training arena + Goblin Stadium backgrounds
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apk  # noqa: E402
from render import Scene, make_sheet  # noqa: E402

OUT = apk.ROOT / "extracted" / "art" / "samples"


def scene(name: str) -> Scene:
    return Scene(apk.pull_sc(f"sc/{name}.sc"))


def save_anim(s: Scene, export: str, out: Path, scale: float, frames=None):
    oid = s.export_id(export)
    n = s.frame_count(oid)
    frames = list(range(n)) if frames is None else frames
    imgs, meta = s.render_frames(oid, frames, scale)
    cols = max(1, math.ceil(math.sqrt(len(imgs))))
    make_sheet(imgs, cols).save(out / f"{export}.png")
    mc = s.sc.movieclips[oid]
    meta.update({"export": export, "fps": mc.framerate, "frames": frames, "columns": cols,
                 "labels": {i: f.label for i, f in enumerate(mc.frames) if f.label}})
    (out / f"{export}.json").write_text(json.dumps(meta, indent=1))
    return imgs, meta


def on_bg(img: Image.Image, color=(96, 110, 96, 255)) -> Image.Image:
    bg = Image.new("RGBA", img.size, color)
    bg.alpha_composite(img)
    return bg


def stack_at_origin(layers: list, pad=4) -> Image.Image:
    """Composite rendered clips (imgs, meta, offset) so their local origins coincide; empty clips skipped."""
    layers = [(imgs[0], m, off) for imgs, m, off in layers if imgs]
    x0 = min(-m["anchor"][0] + dx for im, m, (dx, dy) in layers)
    y0 = min(-m["anchor"][1] + dy for im, m, (dx, dy) in layers)
    x1 = max(-m["anchor"][0] + dx + im.width for im, m, (dx, dy) in layers)
    y1 = max(-m["anchor"][1] + dy + im.height for im, m, (dx, dy) in layers)
    canvas = Image.new("RGBA", (int(x1 - x0) + 2 * pad, int(y1 - y0) + 2 * pad), (0, 0, 0, 0))
    for im, m, (dx, dy) in layers:
        canvas.alpha_composite(im, (int(round(-m["anchor"][0] + dx - x0)) + pad,
                                    int(round(-m["anchor"][1] + dy - y0)) + pad))
    return canvas


def knight(scale: float):
    out = OUT / "knight"
    out.mkdir(parents=True, exist_ok=True)
    s = scene("chr_knight")
    for anim in ("run1", "attack1"):
        for d in range(1, 10):
            save_anim(s, f"Knight_{anim}_{d}", out, scale)
    # individual frames for one direction of each animation
    for exp in ("Knight_attack1_3", "Knight_run1_7"):
        oid = s.export_id(exp)
        imgs, _ = s.render_frames(oid, list(range(s.frame_count(oid))), scale)
        d = out / f"{exp}_frames"
        d.mkdir(exist_ok=True)
        for i, im in enumerate(imgs):
            im.save(d / f"{i:03d}.png")
    # 16-direction overview: authored 1..9 (north -> east -> south) + mirrored 8..2 (south-west -> north-west)
    cells = []
    for team, prefix in (("blue", "Knight"), ("red", "Knight_enemy")):
        row = []
        for d in list(range(1, 10)) + list(range(8, 1, -1)):
            mirrored = len(row) >= 9
            imgs, meta = s.render_frames(s.export_id(f"{prefix}_run1_{d}"), [0], scale)
            im = imgs[0]
            ax, ay = meta["anchor"]
            if mirrored:
                im = ImageOps.mirror(im)
                ax = im.width - ax
            cell = Image.new("RGBA", (int(120 * scale / 2 + 40), int(130 * scale / 2 + 40)), (96, 110, 96, 255))
            cx, cy = cell.width // 2, int(cell.height * 0.8)
            cell.alpha_composite(im, (int(cx - ax), int(cy - ay)))
            dr = ImageDraw.Draw(cell)
            dr.text((4, 2), f"{team} d{d}{' (flip)' if mirrored else ''}", fill=(255, 255, 0, 255))
            dr.ellipse((cx - 2, cy - 2, cx + 2, cy + 2), fill=(255, 0, 0, 255))
            row.append(cell)
        cells.append(row)
    w, h = cells[0][0].size
    ov = Image.new("RGBA", (w * 16, h * 2))
    for r, row in enumerate(cells):
        for c, cell in enumerate(row):
            ov.paste(cell, (c * w, r * h))
    ov.save(out / "knight_16_directions_run_frame0.png")
    print("knight:", s.warnings or "ok")


def towers(scale: float):
    out = OUT / "towers"
    out.mkdir(parents=True, exist_ok=True)
    bt = scene("building_tower")
    king = scene("chr_king")
    pr = scene("chr_princess")
    for team in ("blue", "red"):
        t_imgs, t_meta = bt.render_frames(bt.export_id(f"KingTower_{team}"), [0], scale)
        t_imgs[0].save(out / f"KingTower_{team}.png")
        k_imgs, k_meta = king.render_frames(king.export_id(f"King_{team}"), [0], scale)
        k_imgs[0].save(out / f"King_{team}.png")
        tur = "default_blue_turret" if team == "blue" else "default_red_turret_mid"
        u_imgs, u_meta = king.render_frames(king.export_id(tur), [0], scale)
        comp = stack_at_origin([(t_imgs, t_meta, (0, 0)), (u_imgs, u_meta, (0, 0)), (k_imgs, k_meta, (0, 0))])
        on_bg(comp).save(out / f"KingTower_{team}_with_king_composite.png")
        # princess tower: base + princess (idle, facing camera) + top
        b_imgs, b_meta = bt.render_frames(bt.export_id(f"StarTower_base_{team}"), [0], scale)
        tp_imgs, tp_meta = bt.render_frames(bt.export_id(f"StarTower_top_{team}"), [0], scale)
        pname = "princess_tower_idle1_9" if team == "blue" else "princess_tower_red_idle1_1"
        if pname not in pr.sc.exports:
            pname = next(n for n in pr.sc.exports if n.startswith("princess_tower") and "idle" in n)
        p_imgs, p_meta = pr.render_frames(pr.export_id(pname), [0], scale)
        b_imgs[0].save(out / f"StarTower_base_{team}.png")
        tp_imgs[0].save(out / f"StarTower_top_{team}.png")
        comp = stack_at_origin([(b_imgs, b_meta, (0, 0)), (p_imgs, p_meta, (0, 0)), (tp_imgs, tp_meta, (0, 0))])
        on_bg(comp).save(out / f"PrincessTower_{team}_composite.png")
    # King tower activation animation (labels idle/start/stop)
    save_anim(bt, "KingTower_blue", out, scale, frames=list(range(0, 98, 4)))
    print("towers:", bt.warnings | king.warnings | pr.warnings or "ok")


def projectiles(scale: float):
    out = OUT / "projectiles"
    out.mkdir(parents=True, exist_ok=True)
    fx = scene("effects")
    for exp in ("projectile_arrow_basic_enemy", "projectile_arrow_shadow", "projectile_cannonball_small",
                "fireball_projectile1"):
        if exp in fx.sc.exports:
            save_anim(fx, exp, out, scale * 2)
    print("projectiles:", fx.warnings or "ok")


def arenas(scale: float):
    out = OUT / "arena"
    out.mkdir(parents=True, exist_ok=True)
    for sc_name, exp in (("arena_training", "training_area_bg"), ("level_goblin_arena", "goblin_bgr")):
        s = scene(sc_name)
        imgs, meta = s.render_frames(s.export_id(exp), [0], 1.0)
        imgs[0].save(out / f"{exp}.png")
        meta["export"] = exp
        (out / f"{exp}.json").write_text(json.dumps(meta, indent=1))
        print("arena", exp, imgs[0].size, s.warnings or "ok")


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--assets", help="asset zip or unpacked dir (default $CR_ASSETS / game-files/asset-pack)")
    ap.add_argument("--scale", type=float, default=1.5,
                    help="unit render scale; ~1.5 = native atlas resolution for chr_* (shape/texel ratio 0.66)")
    ap.add_argument("--only", choices=["knight", "towers", "projectiles", "arenas"])
    args = ap.parse_args()
    apk.set_source(args.assets)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("knight", knight), ("towers", towers), ("projectiles", projectiles), ("arenas", arenas)):
        if args.only in (None, name):
            fn(args.scale)


if __name__ == "__main__":
    main()
