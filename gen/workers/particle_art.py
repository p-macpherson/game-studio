"""Particle textures (M12): sprites for effects, on the CPU (NumPy and Pillow only).

cut(p): {images, out_dir, mode} -> {candidates: [{file}], sheet}
    Generated images cut out and centred on a square: mode "glow" (sparks, embers, flames: generated on black, alpha from
    brightness) or "solid" (leaves, coins, petals: generated on white, keyed out as UI art is). The sheet shows each over
    dark and light.
make(p): {out_dir, name, source?, recipe?, size?} -> {file, preview, flipbook}
    The texture as <name>.png: from a chosen candidate (source), or procedural (recipe: {shape, flipbook?, seed?}). Shapes:
    dot, soft, smoke, dust, spark, star, ember, streak, ring; a flipbook [columns, rows] animates smoke and dust growing
    and thinning, and a ring spreading (ripples). Procedural textures are white: effects colour them.
"""
import os
import tempfile

import numpy as np
from PIL import Image, ImageDraw

from ui_art import crop, key_cut

SHAPES = ["dot", "soft", "smoke", "dust", "spark", "star", "ember", "streak", "ring"]
ANIMATED = {"smoke", "dust", "ring"}


def glow_cut(img: Image.Image) -> Image.Image:
    """A sprite on black: alpha from brightness (the brightest channel), colour un-premultiplied; the border forced clear."""
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    alpha = np.clip((a.max(axis=2) - 0.03) / 0.97, 0, 1)
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]) / (0.03 * w)
    alpha *= np.clip(edge, 0, 1)
    rgb = np.where(alpha[..., None] > 1e-3, a / np.maximum(alpha[..., None], 1e-3), 0)
    return Image.fromarray((np.dstack([np.clip(rgb, 0, 1), alpha]) * 255).astype(np.uint8), "RGBA")


def square(img: Image.Image, side: int, margin: float = 0.06) -> Image.Image:
    """Cropped to what's visible and centred on a transparent square, a small margin round it."""
    img = crop(img)
    w, h = img.size
    s = int(max(w, h) * (1 + 2 * margin))
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, ((s - w) // 2, (s - h) // 2))
    return out.resize((side, side), Image.LANCZOS)


def sheet(images: list, path: str, cell: int = 160) -> str:
    """Each image over a dark and a light tile, side by side."""
    out = Image.new("RGB", (cell * max(len(images), 1), cell * 2), (30, 30, 30))
    for i, im in enumerate(images):
        sp = im.resize((cell - 12, int((cell - 12) * im.height / im.width)), Image.LANCZOS)
        for row, bg in enumerate([(24, 28, 36), (190, 200, 205)]):
            tile = Image.new("RGBA", (cell, cell), bg + (255,))
            tile.alpha_composite(sp, (6, (cell - sp.height) // 2))
            out.paste(tile.convert("RGB"), (i * cell, row * cell))
    out.save(path)
    return path


def tmp_png(prefix: str) -> str:
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=".png")
    os.close(fd)
    return path


def cut(p: dict) -> dict:
    os.makedirs(p["out_dir"], exist_ok=True)
    mode = p.get("mode", "glow")
    out, shown = [], []
    for src in p["images"]:
        img = Image.open(src)
        sprite = square(glow_cut(img) if mode == "glow" else key_cut(img), 256)
        f = os.path.join(p["out_dir"], os.path.splitext(os.path.basename(src))[0] + ".png")
        sprite.save(f)
        out.append({"file": f})
        shown.append(sprite)
    return {"candidates": out, "sheet": sheet(shown, tmp_png("gs-particles-"))}


# --- Procedural ------------------------------------------------------------------------------------------------------


def value_noise(shape, scale, rng):
    h, w = shape
    grid = rng.random((int(h / scale) + 2, int(w / scale) + 2))
    yy, xx = np.mgrid[0:h, 0:w] / scale
    x0, y0 = xx.astype(int), yy.astype(int)
    fx, fy = xx - x0, yy - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b, c, d = grid[y0, x0], grid[y0, x0 + 1], grid[y0 + 1, x0], grid[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(shape, rng, base, octaves=4):
    s, amp, total = np.zeros(shape), 0.5, 0.0
    for o in range(octaves):
        s += amp * value_noise(shape, base / (2 ** o), rng)
        total += amp
        amp *= 0.5
    return s / total


def polar(size):
    yy, xx = (np.mgrid[0:size, 0:size] + 0.5) / size * 2 - 1
    return np.sqrt(xx * xx + yy * yy), np.arctan2(yy, xx), xx, yy


def shape_alpha(shape: str, size: int, rng, t: float = 0.0, noise=None) -> np.ndarray:
    """One frame's alpha: t from 0 to 1 over a flipbook (0 for a still)."""
    r, ang, xx, yy = polar(size)
    if shape == "dot":
        return np.clip(1 - r, 0, 1) ** 2
    if shape == "soft":
        return np.exp(-(r * 2.2) ** 2)
    if shape in ("smoke", "dust"):
        n = noise if noise is not None else fbm((size, size), rng, size / (6 if shape == "smoke" else 12))
        grow = 0.55 + 0.45 * t
        rough = 0.6 if shape == "smoke" else 0.9
        a = np.clip(1 - r / grow * (1 + rough * (n - 0.5)), 0, 1) ** (1.5 if shape == "smoke" else 2)
        return a * (0.6 + 0.6 * n) * (1 - 0.7 * t)
    if shape == "spark":
        rays = np.abs(np.cos(ang * 2)) ** 60
        return np.clip(np.exp(-r * 18) * 2 + rays * np.exp(-r * 3.5), 0, 1)
    if shape == "star":
        rays = np.maximum(np.abs(np.cos(ang * 2)) ** 40, 0.6 * np.abs(np.cos(ang * 2 + np.pi / 2 * 0.5)) ** 40)
        return np.clip(np.exp(-r * 12) * 2 + rays * np.exp(-r * 4), 0, 1)
    if shape == "ember":
        return np.clip(np.exp(-r * 6) * 1.6, 0, 1)
    if shape == "streak":
        return np.clip(np.exp(-(xx * 1.2) ** 2 * 3 - (yy * 9) ** 2), 0, 1)
    if shape == "ring":
        radius = 0.35 + 0.55 * t
        width = 0.08 * (1 - 0.5 * t)
        return np.exp(-((r - radius) / width) ** 2) * (1 - t)
    raise ValueError(f"unknown shape {shape!r} ({', '.join(SHAPES)})")


def procedural(recipe: dict) -> tuple:
    shape = recipe.get("shape", "dot")
    if shape not in SHAPES:
        raise ValueError(f"unknown shape {shape!r} ({', '.join(SHAPES)})")
    rng = np.random.default_rng(int(recipe.get("seed", 1)))
    fb = recipe.get("flipbook")
    if not fb:
        a = shape_alpha(shape, 256, rng)
        return Image.fromarray((np.dstack([np.ones((256, 256, 3)), np.clip(a, 0, 1)]) * 255).astype(np.uint8), "RGBA"), [1, 1]
    cols, rows = int(fb[0]), int(fb[1])
    if shape not in ANIMATED:
        raise ValueError(f"a flipbook animates {', '.join(sorted(ANIMATED))}, not {shape}")
    cell = 128
    frames = cols * rows
    # One noise field drifting under every frame, so the frames belong together.
    base = fbm((cell * 2, cell * 2), rng, cell / (6 if shape == "smoke" else 12))
    alpha = np.zeros((rows * cell, cols * cell))
    for f in range(frames):
        t = f / max(frames - 1, 1)
        n = base[int(t * 40):int(t * 40) + cell, int(t * 25):int(t * 25) + cell]
        y, x = (f // cols) * cell, (f % cols) * cell
        alpha[y:y + cell, x:x + cell] = shape_alpha(shape, cell, rng, t, n)
    h, w = alpha.shape
    return Image.fromarray((np.dstack([np.ones((h, w, 3)), np.clip(alpha, 0, 1)]) * 255).astype(np.uint8), "RGBA"), [cols, rows]


def make(p: dict) -> dict:
    os.makedirs(p["out_dir"], exist_ok=True)
    if p.get("recipe"):
        img, flipbook = procedural(p["recipe"])
    else:
        img, flipbook = Image.open(p["source"]).convert("RGBA"), [1, 1]
        side = int(p.get("size") or 256)
        img = img.resize((side, side), Image.LANCZOS)
    f = os.path.join(p["out_dir"], f"{p['name']}.png")
    img.save(f)
    return {"file": f, "flipbook": flipbook, "preview": sheet([img], tmp_png("gs-particles-"), cell=256 if flipbook == [1, 1] else 384)}
