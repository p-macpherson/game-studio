"""Tileable surface textures (M9): the CPU side, shared by the image worker. Quilting makes a generated image seamless
(overlap opposite edges, cut along the path where the two agree best, no blending); normal and roughness maps are
derived from the colour; previews tile an image 2x2 so an agent can see seams. Numbers came from the M9a spike."""
import os
import tempfile

import numpy as np
from PIL import Image, ImageDraw


def min_cut(err: np.ndarray) -> np.ndarray:
    """Per row, the column of the cheapest top-to-bottom path through err (steps of at most one column)."""
    h, w = err.shape
    cost = err.copy()
    for y in range(1, h):
        prev = cost[y - 1]
        cost[y] += np.minimum(prev, np.minimum(np.r_[np.inf, prev[:-1]], np.r_[prev[1:], np.inf]))
    path = np.zeros(h, dtype=int)
    path[-1] = int(np.argmin(cost[-1]))
    for y in range(h - 2, -1, -1):
        x = path[y + 1]
        lo, hi = max(0, x - 1), min(w, x + 2)
        path[y] = lo + int(np.argmin(cost[y, lo:hi]))
    return path


def _quilt_x(a: np.ndarray, w: int) -> np.ndarray:
    s = a.shape[1]
    err = ((a[:, :w].astype(np.float32) - a[:, s - w :].astype(np.float32)) ** 2).sum(-1)
    out = a[:, : s - w].copy()
    for y, x in enumerate(min_cut(err)):
        out[y, :x] = a[y, s - w : s - w + x]  # left of the cut: the strip from the right edge
    return out


def quilt(img: Image.Image, overlap: int = 128) -> Image.Image:
    """Seamless by cutting: the cropped image's edges meet, across the wrap, pixels that were neighbours."""
    a = _quilt_x(np.asarray(img.convert("RGB")), overlap)
    a = _quilt_x(a.transpose(1, 0, 2), overlap).transpose(1, 0, 2)
    return Image.fromarray(a).resize(img.size, Image.LANCZOS)


def _wrap_blur(x: np.ndarray, sigma: float) -> np.ndarray:
    h, w = x.shape
    fy, fx = np.fft.fftfreq(h)[:, None], np.fft.fftfreq(w)[None, :]
    return np.real(np.fft.ifft2(np.fft.fft2(x) * np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))))


def maps(img: Image.Image, strength: float = 4.0, roughness: tuple[float, float] = (0.55, 0.95)) -> tuple[Image.Image, Image.Image]:
    """Normal (tangent space, +Y up) and roughness from the colour's brightness, tiling like the colour does."""
    lum = np.asarray(img.convert("L")).astype(np.float32) / 255
    height = _wrap_blur(lum, 1.2) - _wrap_blur(lum, 40)  # fine relief, not large lighting gradients
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    n = np.stack([-dx * strength * 10, dy * strength * 10, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))
    lo, hi = roughness
    h = (height - height.min()) / max(float(np.ptp(height)), 1e-6)
    rough = Image.fromarray((np.clip(hi - (hi - lo) * h, 0, 1) * 255).astype(np.uint8))  # rougher in crevices
    return normal, rough


def tiled(img: Image.Image, n: int = 2, size: int = 512) -> Image.Image:
    w, h = img.size
    out = Image.new("RGB", (w * n, h * n))
    for y in range(n):
        for x in range(n):
            out.paste(img.convert("RGB"), (x * w, y * h))
    return out.resize((size, size), Image.LANCZOS)


def sheet(images: list[Image.Image], labels: list[str]) -> str:
    """Images side by side (2x2 tilings), labelled, as a temp JPEG for an agent to look at."""
    size, cols = 400, min(4, len(images))
    rows = (len(images) + cols - 1) // cols
    out = Image.new("RGB", (cols * size, rows * (size + 22)), "white")
    d = ImageDraw.Draw(out)
    for i, (img, label) in enumerate(zip(images, labels)):
        x, y = (i % cols) * size, (i // cols) * (size + 22)
        out.paste(tiled(img, 2, size), (x, y + 22))
        d.text((x + 6, y + 5), label, fill="black")
    fd, path = tempfile.mkstemp(prefix="gs-surfaces-", suffix=".jpg")
    os.close(fd)
    out.save(path, quality=85)
    return path


def make(p: dict) -> dict:
    """The final texture from a chosen candidate: <name>.png, <name>_normal.png, <name>_roughness.png, and a preview."""
    src = Image.open(p["source"]).convert("RGB")
    out_dir, name = p["out_dir"], p["name"]
    os.makedirs(out_dir, exist_ok=True)
    normal, rough = maps(src, float(p.get("normal_strength", 4)), tuple(p.get("roughness", (0.55, 0.95))))
    files = [os.path.join(out_dir, f"{name}{suffix}.png") for suffix in ("", "_normal", "_roughness")]
    for img, f in zip((src, normal, rough), files):
        img.save(f, optimize=True)
    return {"files": files, "preview": sheet([src, normal, rough], ["colour, tiled 2x2", "normal", "roughness"])}
