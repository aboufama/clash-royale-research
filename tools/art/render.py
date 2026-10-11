"""Software renderer for SC2 movie clips -> RGBA frames / sprite sheets.

Walks the display list (MovieClip -> children -> Shape draw commands), composes the
2x3 matrices and color transforms, and rasterizes every textured triangle with an
affine UV mapping and bilinear sampling (numpy). Output is premultiplied-correct
"over" compositing, exported as straight-alpha PNG.

Usage examples:
  python render.py SC_FILE --list
  python render.py SC_FILE --export Knight_run1_3 --frames 0-25 -o OUTDIR
  python render.py SC_FILE --export 'Knight_attack1_*' --sheet -o OUTDIR
"""

from __future__ import annotations

import fnmatch
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sc2  # noqa: E402
import sctx  # noqa: E402
from sc2 import IDENTITY, WHITE, Color, Matrix  # noqa: E402

NO_INDEX = 0xFFFF


@dataclass
class Tri:
    tex: int
    xy: np.ndarray  # (3,2)
    uv: np.ndarray  # (3,2)
    color: Color
    blend: int


class Scene:
    def __init__(self, sc_path: Path, tex_dir: Path | None = None, texture_loader=None):
        self.path = Path(sc_path)
        self.sc = sc2.parse(self.path.read_bytes())
        self.tex_dir = tex_dir or self.path.parent
        self._tex_cache: dict[int, np.ndarray] = {}
        self.texture_loader = texture_loader  # callable(name)->bytes, optional
        self.warnings: set[str] = set()

    # -- textures ------------------------------------------------------------
    def texture(self, i: int) -> np.ndarray:
        if i in self._tex_cache:
            return self._tex_cache[i]
        t = self.sc.textures[i]
        if t.external:
            name = Path(t.external).name
            p = self.tex_dir / name
            data = p.read_bytes() if p.exists() else (self.texture_loader(name) if self.texture_loader else None)
            if data is None:
                raise FileNotFoundError(f"texture {name} not found next to {self.path}")
            if data[8:12] == b"SCTX":
                img = sctx.decode(data)
            elif data[:4] == b"\xabKTX":
                import ktx
                img = ktx.decode(data)
            else:
                raise NotImplementedError(f"unknown texture container for {name}")
        elif t.data:
            # Inline data (KTX if fmt has KhronosTexture flag, else raw pixel_type buffer).
            if t.data[:4] == b"\xabKTX":
                import ktx
                img = ktx.decode(t.data)
            else:
                raise NotImplementedError(f"inline raw texture pixel_type={t.pixel_type}")
        else:
            raise ValueError(f"texture {i} has no data")
        arr = np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
        arr[..., :3] *= arr[..., 3:4]  # premultiply
        self._tex_cache[i] = arr
        return arr

    # -- display list --------------------------------------------------------
    def export_id(self, name: str) -> int:
        return self.sc.exports[name]

    def frame_count(self, oid: int) -> int:
        mc = self.sc.movieclips.get(oid)
        return len(mc.frames) if mc else 1

    def collect(self, oid: int, frame: int, m: Matrix = IDENTITY, c: Color = WHITE, blend: int = 0,
                out: list | None = None, depth: int = 0) -> list[Tri]:
        if out is None:
            out = []
        if depth > 32:
            return out
        sc = self.sc
        if oid in sc.shapes:
            for cmd in sc.shapes[oid].commands:
                v = cmd.verts
                pts = np.array([m.apply(x, y) for x, y, _, _ in v], dtype=np.float64)
                uvs = np.array([(u, vv) for _, _, u, vv in v], dtype=np.float64)
                # SC2 stores vertices in triangle-strip order.
                for k in range(len(v) - 2):
                    out.append(Tri(cmd.texture_index, pts[[k, k + 1, k + 2]], uvs[[k, k + 1, k + 2]], c, blend))
            return out
        mc = sc.movieclips.get(oid)
        if mc is None:
            if oid in sc.textfields:
                self.warnings.add("textfields skipped")
            elif oid in sc.modifiers:
                self.warnings.add("mask modifiers ignored")
            else:
                self.warnings.add(f"unknown object id {oid}")
            return out
        if not mc.frames:
            return out
        f = frame % len(mc.frames)
        start = mc.frame_starts[f]
        mats, cols = sc.banks[mc.bank] if mc.bank < len(sc.banks) else ([], [])
        for child_idx, mi, ci in mc.elements[start : start + mc.frames[f].count]:
            cid = mc.children_ids[child_idx]
            if cid in sc.modifiers:
                self.warnings.add("mask modifiers ignored")
                continue
            cm = mats[mi] if mi != NO_INDEX else IDENTITY
            cc = cols[ci] if ci != NO_INDEX else WHITE
            b = mc.children_blend[child_idx] if child_idx < len(mc.children_blend) else 0
            self.collect(cid, frame, m.mul(cm), c.mul(cc), b or blend, out, depth + 1)
        return out

    # -- rasterization -------------------------------------------------------
    @staticmethod
    def bounds(tris: list[Tri]):
        if not tris:
            return (0, 0, 1, 1)
        allp = np.concatenate([t.xy for t in tris])
        return (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())

    def rasterize(self, tris: list[Tri], origin: tuple[float, float], size: tuple[int, int],
                  scale: float = 1.0) -> np.ndarray:
        W, H = size
        canvas = np.zeros((H, W, 4), dtype=np.float32)
        ox, oy = origin
        for t in tris:
            tex = self.texture(t.tex)
            th, tw = tex.shape[:2]
            P = (t.xy - (ox, oy)) * scale
            x0 = max(int(math.floor(P[:, 0].min())), 0)
            x1 = min(int(math.ceil(P[:, 0].max())), W)
            y0 = max(int(math.floor(P[:, 1].min())), 0)
            y1 = min(int(math.ceil(P[:, 1].max())), H)
            if x1 <= x0 or y1 <= y0:
                continue
            (ax, ay), (bx, by), (cx, cy) = P
            den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(den) < 1e-9:
                continue
            ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float64)
            xs += 0.5
            ys += 0.5
            l0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
            l1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
            l2 = 1.0 - l0 - l1
            eps = -1e-4
            inside = (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
            if not inside.any():
                continue
            u = l0 * t.uv[0, 0] + l1 * t.uv[1, 0] + l2 * t.uv[2, 0]
            v = l0 * t.uv[0, 1] + l1 * t.uv[1, 1] + l2 * t.uv[2, 1]
            # bilinear sample (premultiplied)
            fx = np.clip(u * tw - 0.5, 0, tw - 1)
            fy = np.clip(v * th - 0.5, 0, th - 1)
            ix = np.floor(fx).astype(np.int32)
            iy = np.floor(fy).astype(np.int32)
            ix1 = np.minimum(ix + 1, tw - 1)
            iy1 = np.minimum(iy + 1, th - 1)
            wx = (fx - ix)[..., None].astype(np.float32)
            wy = (fy - iy)[..., None].astype(np.float32)
            s = (tex[iy, ix] * (1 - wx) * (1 - wy) + tex[iy, ix1] * wx * (1 - wy)
                 + tex[iy1, ix] * (1 - wx) * wy + tex[iy1, ix1] * wx * wy)
            col = t.color
            if col is not WHITE:
                a = s[..., 3:4]
                rgb = s[..., :3] * np.array([col.r_mul, col.g_mul, col.b_mul], np.float32) \
                    + a * (np.array([col.r_add, col.g_add, col.b_add], np.float32) / 255.0)
                s = np.concatenate([np.minimum(rgb, a), a], axis=-1) * np.float32(col.a_mul)
            s *= inside[..., None]
            dst = canvas[y0:y1, x0:x1]
            if t.blend in (0, 1):  # normal
                dst *= (1.0 - s[..., 3:4])
                dst += s
            else:  # additive-ish (glows/fx); alpha left unchanged
                self.warnings.add(f"blend mode {t.blend} approximated as additive")
                dst[..., :3] = np.minimum(dst[..., :3] + s[..., :3], 1.0)
                dst[..., 3:4] = np.maximum(dst[..., 3:4], np.minimum(s[..., 3:4], 1.0))
        return canvas

    @staticmethod
    def to_image(canvas: np.ndarray) -> Image.Image:
        a = canvas[..., 3:4]
        rgb = np.where(a > 1e-6, canvas[..., :3] / np.maximum(a, 1e-6), 0)
        out = np.concatenate([rgb, a], axis=-1)
        return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")

    def render_frames(self, oid: int, frames: list[int], scale: float = 1.0, pad: int = 2):
        """Render frames with a shared canvas. Returns (images, meta)."""
        per = [self.collect(oid, f) for f in frames]
        bs = [self.bounds(t) for t in per if t]
        if not bs:
            return [], {}
        x0 = min(b[0] for b in bs) - pad / scale
        y0 = min(b[1] for b in bs) - pad / scale
        x1 = max(b[2] for b in bs) + pad / scale
        y1 = max(b[3] for b in bs) + pad / scale
        W = int(math.ceil((x1 - x0) * scale))
        H = int(math.ceil((y1 - y0) * scale))
        imgs = [self.to_image(self.rasterize(t, (x0, y0), (W, H), scale)) for t in per]
        meta = {"width": W, "height": H, "scale": scale,
                # pixel position of the clip's local origin (0,0) inside each frame
                "anchor": [round(float(-x0 * scale), 2), round(float(-y0 * scale), 2)]}
        return imgs, meta


def parse_range(spec: str | None, n: int) -> list[int]:
    if not spec or spec == "all":
        return list(range(n))
    out = []
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), min(int(b), n - 1) + 1))
        else:
            out.append(int(part))
    return [f for f in out if 0 <= f < n]


def make_sheet(imgs: list[Image.Image], cols: int | None = None) -> Image.Image:
    n = len(imgs)
    cols = cols or max(1, math.ceil(math.sqrt(n)))
    rows = math.ceil(n / cols)
    w, h = imgs[0].size
    sheet = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        sheet.paste(im, ((i % cols) * w, (i // cols) * h))
    return sheet


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sc", type=Path)
    ap.add_argument("--tex-dir", type=Path, default=None, help="dir with *.sctx (default: next to .sc)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--export", action="append", default=[], help="export name or glob (repeatable)")
    ap.add_argument("--frames", default="all", help="e.g. 0-10,15 (default all)")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--sheet", action="store_true", help="write one sprite sheet + json per export")
    ap.add_argument("--no-frames", action="store_true", help="with --sheet, skip individual frame PNGs")
    ap.add_argument("-o", "--out", type=Path, default=Path("."))
    args = ap.parse_args()

    scene = Scene(args.sc, args.tex_dir)
    if args.list:
        print(sc2.summary(scene.sc))
        return
    names = []
    for pat in args.export:
        names.extend(sorted(n for n in scene.sc.exports if fnmatch.fnmatchcase(n, pat)))
    if not names:
        sys.exit("no exports matched; use --list")
    args.out.mkdir(parents=True, exist_ok=True)
    for name in names:
        oid = scene.export_id(name)
        mc = scene.sc.movieclips.get(oid)
        frames = parse_range(args.frames, scene.frame_count(oid))
        imgs, meta = scene.render_frames(oid, frames, args.scale)
        if not imgs:
            print(f"{name}: nothing to draw")
            continue
        safe = name.replace("/", "_")
        if not (args.sheet and args.no_frames):
            d = args.out / safe
            d.mkdir(exist_ok=True)
            for f, im in zip(frames, imgs):
                im.save(d / f"{f:03d}.png")
        if args.sheet:
            cols = max(1, math.ceil(math.sqrt(len(imgs))))
            make_sheet(imgs, cols).save(args.out / f"{safe}.png")
            meta.update({"export": name, "fps": mc.framerate if mc else 0, "frames": frames, "columns": cols,
                         "labels": {i: fr.label for i, fr in enumerate(mc.frames) if fr.label} if mc else {}})
            (args.out / f"{safe}.json").write_text(json.dumps(meta, indent=1))
        print(f"{name}: {len(imgs)} frames {meta['width']}x{meta['height']} anchor={meta['anchor']}")
    if scene.warnings:
        print("warnings:", "; ".join(sorted(scene.warnings)))


if __name__ == "__main__":
    main()
