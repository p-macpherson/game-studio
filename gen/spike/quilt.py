"""M9a spike: make a texture tileable by quilting (min-error cuts across the wrap), no generation.

Overlap the image's right strip with its left strip, cut along the path where the two agree best, and keep the
cropped width (S - w): its right edge now meets, across the wrap, pixels that were its neighbours. Then the same
top to bottom. Usage: python quilt.py <dir> <name>... (reads <dir>/<name>-base.png, writes <name>-quilt*).
"""
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, __import__("os").path.dirname(__file__))
from tiles import maps, seam_score, tile3  # noqa: E402


def min_cut(err: np.ndarray) -> np.ndarray:
    """Per row, the column of the cheapest top-to-bottom path through err (steps of at most one column)."""
    h, w = err.shape
    cost = err.copy()
    for y in range(1, h):
        prev = cost[y - 1]
        best = np.minimum(prev, np.minimum(np.r_[np.inf, prev[:-1]], np.r_[prev[1:], np.inf]))
        cost[y] += best
    path = np.zeros(h, dtype=int)
    path[-1] = int(np.argmin(cost[-1]))
    for y in range(h - 2, -1, -1):
        x = path[y + 1]
        lo, hi = max(0, x - 1), min(w, x + 2)
        path[y] = lo + int(np.argmin(cost[y, lo:hi]))
    return path


def quilt_x(a: np.ndarray, w: int) -> np.ndarray:
    s = a.shape[1]
    left, right = a[:, :w].astype(np.float32), a[:, s - w :].astype(np.float32)
    err = ((left - right) ** 2).sum(-1)
    path = min_cut(err)
    out = a[:, : s - w].copy()
    for y, x in enumerate(path):
        out[y, :x] = a[y, s - w : s - w + x]  # left of the cut: the strip from the right edge
    return out


def quilt(img: Image.Image, w: int = 128) -> Image.Image:
    a = np.asarray(img)
    a = quilt_x(a, w)
    a = quilt_x(a.transpose(1, 0, 2), w).transpose(1, 0, 2)
    size = img.size[0]
    return Image.fromarray(a).resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    d = sys.argv[1]
    for name in sys.argv[2:]:
        q = quilt(Image.open(f"{d}/{name}-base.png").convert("RGB"))
        q.save(f"{d}/{name}-quilt.png")
        tile3(q).save(f"{d}/{name}-quilt-3x3.png")
        n, r = maps(q)
        n.save(f"{d}/{name}-quilt_normal.png")
        r.save(f"{d}/{name}-quilt_roughness.png")
        print(name, "seam", round(seam_score(np.asarray(q)), 2))
