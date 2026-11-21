"""M10a spike: cut generated UI art out of its plain background two ways (rembg's u2net vs keying the flat
background, flood-filled from the edges so light insides survive), then test it as UI: frames as 9-slices at
three sizes over a game screenshot, icons at 48/96 px on dark, light and the game. Run in the hunyuan3d env (rembg):
  envs/hunyuan3d/bin/python gen/spike/ui_cut.py <dir> <game.png>
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

os.environ.setdefault("U2NET_HOME", os.path.expanduser("~/.local/share/game-studio/gen/models/u2net"))
from rembg import new_session, remove  # noqa: E402

DIR, GAME = sys.argv[1], sys.argv[2]
FRAMES = ["panel", "button"]
ICONS = ["coin", "chest", "map"]
SEEDS = [11, 12]


def key_cut(img: Image.Image, tol: float = 38) -> Image.Image:
    """Removes the background connected to the image edges whose colour is near the corners' (flat backgrounds)."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    bg = np.median(np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3), a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)]), axis=0)
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
    alpha = np.where(seen, 0, 255).astype(np.uint8)
    # A soft edge: partly-background pixels at the boundary fade with their distance from the background colour.
    edge = np.asarray(Image.fromarray(alpha).filter(ImageFilter.MaxFilter(3))) != np.asarray(Image.fromarray(alpha).filter(ImageFilter.MinFilter(3)))
    soft = np.clip((dist - tol * 0.5) / (tol * 1.5), 0, 1) * 255
    alpha = np.where(edge & ~seen, np.maximum(alpha * 0 + soft, 0), alpha).astype(np.uint8)
    out = img.convert("RGBA")
    out.putalpha(Image.fromarray(alpha))
    return out


def crop(img: Image.Image) -> Image.Image:
    box = img.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    return img.crop(box) if box else img


def symmetric(img: Image.Image) -> Image.Image:
    """The top-left quarter mirrored into all four: an exactly symmetric frame (clean 9-slice edges)."""
    w, h = img.size
    q = img.crop((0, 0, w // 2, h // 2))
    out = Image.new("RGBA", (w // 2 * 2, h // 2 * 2))
    out.paste(q, (0, 0))
    out.paste(q.transpose(Image.FLIP_LEFT_RIGHT), (w // 2, 0))
    out.paste(q.transpose(Image.FLIP_TOP_BOTTOM), (0, h // 2))
    out.paste(q.transpose(Image.ROTATE_180), (w // 2, h // 2))
    return out


def nine_slice(img: Image.Image, size, inset: float) -> Image.Image:
    """Corners kept at their size (scaled by `scale`), edges and centre stretched: how the engine would draw it."""
    w, h = img.size
    m = int(min(w, h) * inset)
    tw, th = size
    s = min(1.0, (min(tw, th) / 2) / m)  # corners shrink only if the target is too small for them
    d = max(1, int(m * s))
    out = Image.new("RGBA", (tw, th))
    xs_src, ys_src = [0, m, w - m, w], [0, m, h - m, h]
    xs_dst, ys_dst = [0, d, tw - d, tw], [0, d, th - d, th]
    for i in range(3):
        for j in range(3):
            src = img.crop((xs_src[i], ys_src[j], xs_src[i + 1], ys_src[j + 1]))
            dw, dh = xs_dst[i + 1] - xs_dst[i], ys_dst[j + 1] - ys_dst[j]
            if dw > 0 and dh > 0:
                out.paste(src.resize((dw, dh), Image.LANCZOS), (xs_dst[i], ys_dst[j]))
    return out


def checker(size) -> Image.Image:
    im = Image.new("RGB", size, (200, 200, 200))
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], 16):
        for x in range(0, size[0], 16):
            if (x // 16 + y // 16) % 2:
                d.rectangle((x, y, x + 15, y + 15), fill=(150, 150, 150))
    return im


def main():
    session = new_session("u2net")
    game = Image.open(GAME).convert("RGB").resize((1280, 720))
    cuts = {}
    for name in FRAMES + ICONS:
        for seed in SEEDS:
            raw = Image.open(os.path.join(DIR, f"{name}-{seed}.png")).convert("RGB")
            for method, cut in (("rembg", remove(raw, session=session)), ("key", key_cut(raw))):
                c = crop(cut)
                c.save(os.path.join(DIR, f"cut-{name}-{seed}-{method}.png"))
                cuts[(name, seed, method)] = c

    # Cut-outs on a checkerboard: how clean is each edge?
    for name in FRAMES + ICONS:
        tiles = []
        for seed in SEEDS:
            for method in ("rembg", "key"):
                c = cuts[(name, seed, method)]
                t = checker((300, 300 if name != "button" else 150))
                c2 = c.copy()
                c2.thumbnail((280, t.size[1] - 20))
                t.paste(c2, ((300 - c2.width) // 2, (t.size[1] - c2.height) // 2), c2)
                ImageDraw.Draw(t).text((6, 4), f"{seed} {method}", fill=(0, 0, 0))
                tiles.append(t)
        sheet = Image.new("RGB", (300 * len(tiles), tiles[0].size[1]))
        for i, t in enumerate(tiles):
            sheet.paste(t, (300 * i, 0))
        sheet.save(os.path.join(DIR, f"sheet-cut-{name}.png"))

    # Frames as 9-slices over the game: a HUD panel, a menu panel, a wide banner; buttons as a menu.
    for name in FRAMES:
        for seed in SEEDS:
            for method in ("rembg", "key"):
                for sym in (False, True):
                    f = cuts[(name, seed, method)]
                    if sym:
                        f = symmetric(f)
                    scene = game.copy().convert("RGBA")
                    inset = 0.28 if name == "panel" else 0.35
                    if name == "panel":
                        layout = [((24, 24), (300, 120)), ((470, 150), (340, 420)), ((340, 40), (600, 90))]
                    else:
                        layout = [((520, 220 + i * 90), (240, 70)) for i in range(4)] + [((40, 600), (160, 56))]
                    for pos, size in layout:
                        piece = nine_slice(f, size, inset)
                        scene.alpha_composite(piece, pos)
                    tag = f"{name}-{seed}-{method}{'-sym' if sym else ''}"
                    ImageDraw.Draw(scene).text((10, 700), tag, fill=(255, 255, 255))
                    scene.convert("RGB").save(os.path.join(DIR, f"nine-{tag}.png"))

    # Icons small, where they'll be used: 48 px and 96 px, on dark, light and the game.
    for name in ICONS:
        rows = []
        for seed in SEEDS:
            for method in ("rembg", "key"):
                row = Image.new("RGB", (3 * 170, 120), (0, 0, 0))
                for k, bg in enumerate([Image.new("RGB", (170, 120), (24, 26, 34)), Image.new("RGB", (170, 120), (236, 232, 220)), game.crop((600, 400, 770, 520))]):
                    tile = bg.copy().convert("RGBA")
                    for px, x in ((48, 12), (96, 66)):
                        ic = cuts[(name, seed, method)].copy()
                        ic.thumbnail((px, px), Image.LANCZOS)
                        tile.alpha_composite(ic, (x, (120 - ic.height) // 2))
                    row.paste(tile.convert("RGB"), (k * 170, 0))
                ImageDraw.Draw(row).text((4, 2), f"{seed} {method}", fill=(255, 0, 255))
                rows.append(row)
        sheet = Image.new("RGB", (510, 120 * len(rows)))
        for i, r in enumerate(rows):
            sheet.paste(r, (0, 120 * i))
        sheet.save(os.path.join(DIR, f"sheet-icons-{name}.png"))


main()
