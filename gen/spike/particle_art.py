"""M12a spike: particle textures. FLUX.2 Klein sprites on black (alpha from brightness) against procedural ones made
with numpy, and whether a generated 4x4 flipbook holds together. Run in the image env:
    envs/image/bin/python gen/spike/particle_art.py <out_dir>          (generate + procedural + sheets)
    envs/image/bin/python gen/spike/particle_art.py <out_dir> --no-gen (procedural + sheets only)
"""
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

OUT = sys.argv[1]
GEN = "--no-gen" not in sys.argv
STYLE = "stylised hand-painted game visual effect sprite, soft edges"
BG = "a single element centred and isolated on a pure black background, nothing else"
SPRITES = {
    "smoke": "a soft round puff of white smoke, wispy edges",
    "dust": "a soft cloud of light brown dust, irregular and wispy",
    "spark": "a bright four-pointed star sparkle, thin sharp rays, white hot centre",
    "ember": "a small glowing orange ember, soft glow around it",
    "leaf": "a single small green leaf, flat, seen from above",
    "flame": "a single soft flame wisp, orange and yellow, glowing",
}
FLIPBOOK = "a sprite sheet of 16 frames in a 4 by 4 grid, each frame the same puff of white smoke expanding and fading from small and dense to large and faint, evenly spaced, " + BG
SEEDS = [21, 22]


def gen_all():
    import torch
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "workers"))
    from image_worker import pipeline

    class Job:
        def progress(self, msg, frac=None):
            print(msg, flush=True)

    pipe = pipeline(Job())
    log = []
    jobs = [(n, f"{p}, {STYLE}, {BG}", 512) for n, p in SPRITES.items()] + [("flipbook", f"{FLIPBOOK}, {STYLE}", 1024)]
    for name, prompt, size in jobs:
        for seed in SEEDS:
            t = time.time()
            img = pipe(prompt=prompt, width=size, height=size, num_inference_steps=4, generator=torch.Generator("cpu").manual_seed(seed)).images[0]
            img.save(os.path.join(OUT, f"gen-{name}-{seed}.png"))
            log.append({"name": name, "seed": seed, "seconds": round(time.time() - t, 1)})
            print(log[-1], flush=True)
    json.dump(log, open(os.path.join(OUT, "generated.json"), "w"), indent=1)


def to_rgba(img):
    """A sprite on black: alpha from brightness (max channel), colour un-premultiplied; edges forced to zero."""
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    alpha = a.max(axis=2)
    alpha = np.clip((alpha - 0.03) / 0.97, 0, 1)  # the black isn't quite black
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]) / (0.04 * w)
    alpha *= np.clip(edge, 0, 1)
    rgb = np.where(alpha[..., None] > 1e-3, a / np.maximum(alpha[..., None], 1e-3), 0)
    return Image.fromarray((np.dstack([np.clip(rgb, 0, 1), alpha]) * 255).astype(np.uint8), "RGBA")


def value_noise(shape, scale, rng):
    h, w = shape
    gh, gw = int(h / scale) + 2, int(w / scale) + 2
    grid = rng.random((gh, gw))
    yy, xx = np.mgrid[0:h, 0:w] / scale
    x0, y0 = xx.astype(int), yy.astype(int)
    fx, fy = xx - x0, yy - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = grid[y0, x0], grid[y0, x0 + 1]
    c, d = grid[y0 + 1, x0], grid[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(shape, rng, base=24, octaves=4):
    s, amp, total = np.zeros(shape), 0.5, 0
    for o in range(octaves):
        s += amp * value_noise(shape, base / (2 ** o), rng)
        total += amp
        amp *= 0.5
    return s / total


def radial(size):
    yy, xx = (np.mgrid[0:size, 0:size] + 0.5) / size * 2 - 1
    return np.sqrt(xx * xx + yy * yy), np.arctan2(yy, xx)


def rgba(rgb, alpha):
    return Image.fromarray((np.dstack([np.broadcast_to(np.array(rgb, np.float32), alpha.shape + (3,)), np.clip(alpha, 0, 1)]) * 255).astype(np.uint8), "RGBA")


def procedural(rng):
    S = 256
    r, ang = radial(S)
    out = {}
    out["dot"] = rgba((1, 1, 1), np.clip(1 - r, 0, 1) ** 2)
    n = fbm((S, S), rng, 40)
    out["smoke"] = rgba((1, 1, 1), np.clip(1 - r * (1.1 + 0.6 * (n - 0.5)), 0, 1) ** 1.5 * (0.6 + 0.6 * n))
    out["dust"] = rgba((0.72, 0.6, 0.45), np.clip(1 - r * (1.2 + 0.9 * (fbm((S, S), rng, 20) - 0.5)), 0, 1) ** 2 * 0.9)
    rays = np.maximum(np.abs(np.cos(ang * 2)) ** 60, 0)
    out["spark"] = rgba((1, 0.97, 0.85), np.clip(np.exp(-r * 18) * 2 + rays * np.exp(-r * 3.5), 0, 1))
    out["ember"] = rgba((1, 0.55, 0.15), np.clip(np.exp(-r * 6) * 1.6, 0, 1))
    yy, xx = (np.mgrid[0:S, 0:S] + 0.5) / S * 2 - 1
    out["streak"] = rgba((1, 0.9, 0.6), np.clip(np.exp(-(xx * 1.2) ** 2 * 3 - (yy * 9) ** 2), 0, 1))
    # 4x4 flipbook: a smoke puff expanding and thinning, the same noise drifting so frames belong together.
    F, cell = 4, 128
    sheet = np.zeros((F * cell, F * cell))
    base = fbm((cell * 2, cell * 2), rng, 30)
    rr, _ = radial(cell)
    for f in range(16):
        t = f / 15
        grow = 0.45 + 0.55 * t
        nn = base[int(t * 40):int(t * 40) + cell, int(t * 25):int(t * 25) + cell]
        a = np.clip(1 - rr / grow * (1 + 0.5 * (nn - 0.5)), 0, 1) ** 1.5 * (1 - 0.7 * t) * (0.6 + 0.6 * nn)
        sheet[(f // F) * cell:(f // F + 1) * cell, (f % F) * cell:(f % F + 1) * cell] = a
    out["flipbook"] = rgba((1, 1, 1), sheet)
    return out


def contact(items, path, cell=160):
    """Each sprite over a dark and a light background, labelled."""
    names = list(items)
    sheet = Image.new("RGB", (cell * len(names), cell * 2 + 18), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    for i, n in enumerate(names):
        sp = items[n].resize((cell - 10, cell - 10), Image.LANCZOS)
        for row, bg in enumerate([(24, 28, 36), (190, 200, 205)]):
            tile = Image.new("RGBA", (cell, cell), bg + (255,))
            tile.alpha_composite(sp, (5, 5))
            sheet.paste(tile.convert("RGB"), (i * cell, row * cell))
        d.text((i * cell + 6, cell * 2 + 3), n, fill=(230, 230, 230))
    sheet.save(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    if GEN:
        gen_all()
    rng = np.random.default_rng(7)
    proc = procedural(rng)
    for n, im in proc.items():
        im.save(os.path.join(OUT, f"proc-{n}.png"))
    contact(proc, os.path.join(OUT, "sheet-procedural.png"))
    for seed in SEEDS:
        gen = {}
        for n in list(SPRITES) + ["flipbook"]:
            p = os.path.join(OUT, f"gen-{n}-{seed}.png")
            if os.path.exists(p):
                gen[n] = to_rgba(Image.open(p))
                gen[n].save(os.path.join(OUT, f"cut-{n}-{seed}.png"))
        if gen:
            contact(gen, os.path.join(OUT, f"sheet-generated-{seed}.png"))


main()
