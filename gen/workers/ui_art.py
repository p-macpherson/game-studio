"""UI art (M10): generated images made into game UI pieces, on the CPU (NumPy and Pillow only).

cut(p): {images, out_dir, kind, mirror?} -> {candidates: [{file, slice}], sheet}
    Each image (generated on a plain flat background) is cut out (the background connected to the edges is keyed out,
    so light insides like parchment survive), cropped, made exactly symmetric for frames and buttons (the top-left
    quarter mirrored), and given slice insets; the sheet shows each candidate the way it will be used: frames and
    buttons stretched to three shapes, icons at 48 and 96 px on dark and light.
make(p): {source, out_dir, name, kind, slice?} -> {file, slice, preview}
    The chosen candidate as the asset's <name>.png (frames up to 512 px, icons 256 px), its insets and a preview.
"""
import os
import tempfile
from collections import deque

import numpy as np
from PIL import Image, ImageDraw

MAX_SIDE = {"frame": 512, "button": 512, "icon": 256}


def key_cut(img: Image.Image, tol: float = 38) -> Image.Image:
    """Removes the background connected to the image's edges whose colour is near the corners' median."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    corners = np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3), a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.linalg.norm(a - bg, axis=2)
    near = dist < tol
    seen = np.zeros((h, w), bool)
    q = deque([(y, x) for y in (0, h - 1) for x in range(w)] + [(y, x) for x in (0, w - 1) for y in range(h)])
    while q:
        y, x = q.popleft()
        if y < 0 or x < 0 or y >= h or x >= w or seen[y, x] or not near[y, x]:
            continue
        seen[y, x] = True
        q.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))
    alpha = np.where(seen, 0, 255).astype(np.float32)
    # Soften the boundary: background-ish pixels next to the cut fade with their distance from the background colour.
    edge = np.zeros_like(seen)
    edge[1:, :] |= seen[:-1, :]
    edge[:-1, :] |= seen[1:, :]
    edge[:, 1:] |= seen[:, :-1]
    edge[:, :-1] |= seen[:, 1:]
    edge &= ~seen
    soft = np.clip((dist - tol * 0.5) / (tol * 1.5), 0, 1) * 255
    alpha[edge] = np.minimum(alpha[edge], soft[edge])
    out = img.convert("RGBA")
    out.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    return out


def crop(img: Image.Image) -> Image.Image:
    box = img.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    return img.crop(box) if box else img


def symmetric(img: Image.Image) -> Image.Image:
    """The top-left quarter mirrored into all four: an exactly symmetric frame, so its 9-slice edges match."""
    w, h = img.size
    q = img.crop((0, 0, w // 2, h // 2))
    out = Image.new("RGBA", (w // 2 * 2, h // 2 * 2))
    out.paste(q, (0, 0))
    out.paste(q.transpose(Image.FLIP_LEFT_RIGHT), (w // 2, 0))
    out.paste(q.transpose(Image.FLIP_TOP_BOTTOM), (0, h // 2))
    out.paste(q.transpose(Image.ROTATE_180), (w // 2, h // 2))
    return out


def _plateau(profile: np.ndarray, frac: float = 0.999) -> int:
    """Where a coverage profile (from one edge to the middle) first reaches its full value: a rounded end's length."""
    top = profile.max()
    if top <= 0:
        return 0
    return int(np.argmax(profile >= top * frac))


def _border(line: np.ndarray, centre_rgb: np.ndarray, tol: float = 40) -> int:
    """How far in from the start of a row of RGB pixels the colour settles to the centre's: the frame's width."""
    d = np.linalg.norm(line - centre_rgb, axis=1)
    run = 0
    for i, v in enumerate(d):
        run = run + 1 if v < tol else 0
        if run >= max(4, len(line) // 40):
            return i - run + 1
    return len(line) // 3


def detect_slice(img: Image.Image, kind: str) -> list[int]:
    """Corner insets [left, top, right, bottom] in pixels. The corner region must hold everything that mustn't stretch:
    a rounded end (where the shape's coverage stops growing) and, for frames, the border with its corner ornaments."""
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    h, w = a.shape[:2]
    alpha = a[:, :, 3] / 255
    cols = alpha.mean(axis=0)
    rows = alpha.mean(axis=1)
    x_round = _plateau(cols[: w // 2])
    y_round = _plateau(rows[: h // 2])
    if kind == "button":
        # A pill: its whole round end is the corner; a rounded rectangle: at least its rounding.
        x = max(x_round, int(h * 0.3))
        y = max(y_round, int(h * 0.3))
    else:
        centre = a[h // 2 - h // 10 : h // 2 + h // 10, w // 2 - w // 10 : w // 2 + w // 10, :3].reshape(-1, 3)
        c = np.median(centre, axis=0)
        bx = _border(a[h // 2, : w // 2, :3], c)
        by = _border(a[: h // 2, w // 2, :3], c)
        # Corner ornaments (rivets, brackets) reach further in than the plain border: give the corners room.
        x = max(x_round, int(bx * 1.6))
        y = max(y_round, int(by * 1.6))
    x = min(x, w // 2 - 1)
    y = min(y, h // 2 - 1)
    return [x, y, x, y]


def nine_slice(img: Image.Image, size: tuple[int, int], s: list[int], border: float) -> Image.Image:
    """Draws `img` stretched to `size` as the engine does (ui.nine_slice): the largest inset drawn `border` px wide."""
    w, h = img.size
    tw, th = size
    k = border / max(max(s), 1)
    d = [v * k for v in s]
    fit = min(1, tw / max(d[0] + d[2], 1e-3), th / max(d[1] + d[3], 1e-3))
    d = [int(round(v * fit)) for v in d]
    sx = [0, s[0], w - s[2], w]
    sy = [0, s[1], h - s[3], h]
    dx = [0, d[0], tw - d[2], tw]
    dy = [0, d[1], th - d[3], th]
    out = Image.new("RGBA", (tw, th))
    for j in range(3):
        for i in range(3):
            src = img.crop((sx[i], sy[j], sx[i + 1], sy[j + 1]))
            dw, dh = dx[i + 1] - dx[i], dy[j + 1] - dy[j]
            if dw > 0 and dh > 0 and src.width > 0 and src.height > 0:
                out.paste(src.resize((dw, dh), Image.LANCZOS), (dx[i], dy[j]))
    return out


def _backdrop(size, dark=True) -> Image.Image:
    im = Image.new("RGB", size, (28, 30, 38) if dark else (232, 228, 216))
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], 20):
        for x in range(0, size[0], 20):
            if (x // 20 + y // 20) % 2:
                d.rectangle((x, y, x + 19, y + 19), fill=(34, 37, 46) if dark else (222, 218, 205))
    return im


def usage_tile(img: Image.Image, kind: str, s: list[int]) -> Image.Image:
    """One candidate the way it'll be used (frames: three shapes; buttons: a menu; icons: 48 and 96 px)."""
    tile = _backdrop((420, 300)).convert("RGBA")
    if kind == "icon":
        light = _backdrop((210, 300), dark=False).convert("RGBA")
        tile.paste(light, (210, 0))
        for x0 in (0, 210):
            for px, x in ((48, 24), (96, 92)):
                ic = img.copy()
                ic.thumbnail((px, px), Image.LANCZOS)
                tile.alpha_composite(ic, (x0 + x, 150 - ic.height // 2))
        return tile
    if kind == "button":
        for i, (w, h) in enumerate([(220, 56), (220, 56), (300, 70), (120, 44)]):
            tile.alpha_composite(nine_slice(img, (w, h), s, 28), ((420 - w) // 2, 18 + i * 70))
        return tile
    tile.alpha_composite(nine_slice(img, (180, 70), s, 18), (14, 14))
    tile.alpha_composite(nine_slice(img, (380, 60), s, 18), (20, 226))
    tile.alpha_composite(nine_slice(img, (190, 130), s, 26), (214, 84))
    return tile


def cut(p: dict) -> dict:
    kind = p["kind"]
    mirror = p.get("mirror", kind != "icon")
    out_dir = p["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    candidates, tiles = [], []
    for src in p["images"]:
        img = crop(key_cut(Image.open(src).convert("RGB")))
        if mirror:
            img = symmetric(img)
        side = MAX_SIDE.get(kind, 512)
        img.thumbnail((side, side), Image.LANCZOS)
        s = detect_slice(img, kind) if kind != "icon" else []
        name = os.path.splitext(os.path.basename(src))[0]
        file = os.path.join(out_dir, f"{name}.png")
        img.save(file)
        candidates.append({"file": file, "slice": s})
        tiles.append(usage_tile(img, kind, s))
    return {"candidates": candidates, "sheet": _sheet(tiles)}


def make(p: dict) -> dict:
    kind = p["kind"]
    img = Image.open(p["source"]).convert("RGBA")
    s = [int(v) for v in p["slice"]] if p.get("slice") else (detect_slice(img, kind) if kind != "icon" else [])
    file = os.path.join(p["out_dir"], f"{p['name']}.png")
    img.save(file)
    return {"file": file, "slice": s, "preview": _sheet([usage_tile(img, kind, s)])}


def _sheet(tiles: list[Image.Image]) -> str:
    cols = min(3, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 420, rows * 300), "white")
    draw = ImageDraw.Draw(sheet)
    for i, t in enumerate(tiles):
        x, y = (i % cols) * 420, (i // cols) * 300
        sheet.paste(t.convert("RGB"), (x, y))
        draw.rectangle((x, y, x + 22, y + 18), fill=(0, 0, 0))
        draw.text((x + 6, y + 3), str(i + 1), fill=(255, 255, 255))
    fd, path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    sheet.save(path, quality=88)
    return path
