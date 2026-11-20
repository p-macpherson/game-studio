"""M9a spike: seamless tileable textures from FLUX.2 Klein, made seamless three ways, with CPU-derived normal and
roughness maps. Run in the image env:  envs/image/bin/python gen/spike/tiles.py <out_dir>

For each surface: base (plain), roll (latents rolled every step + circular VAE decoder), repair (shift by half,
Klein edits the seam cross, blended back), cpu (histogram-preserving offset blend of base). Writes per variant the
tile, a 3x3 tiling, normal and roughness maps, a seam score (wrap-edge difference / interior neighbour difference:
1.0 = invisible), and a contact sheet per surface.
"""
import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "workers"))
from image_worker import pipeline  # noqa: E402  (loads Klein in fp8 with CPU offload, as the studio does)

OUT = sys.argv[1]
SIZE = 1024
SURFACES = {
    "grass": "short stylised grass ground with small clover leaves and a few tiny pebbles",
    "cobblestone": "cobblestone path, rounded grey stones with thin mossy gaps between them",
    "planks": "wooden floor planks, warm brown wood with grain and a few knots, planks running horizontally",
    "stone-wall": "mossy stone wall of irregular grey stone blocks with mortar",
}
STYLE = "seamless tileable texture, top-down orthographic view, flat even lighting, no shadows, no perspective, fills the whole frame, stylised hand-painted game texture, calm palette"


class Job:
    def progress(self, msg, frac=None):
        print(msg, flush=True)


def seam_score(img: np.ndarray) -> float:
    """How much the wrap-around edges differ, relative to ordinary neighbouring pixels (1.0 = no visible seam)."""
    a = img.astype(np.float32)
    wrap = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0] - a[-1]).mean()) / 2
    inner = (np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()) / 2
    return float(wrap / max(inner, 1e-6))


def tile3(img: Image.Image) -> Image.Image:
    w, h = img.size
    out = Image.new("RGB", (w * 3, h * 3))
    for y in range(3):
        for x in range(3):
            out.paste(img, (x * w, y * h))
    return out.resize((1536, 1536), Image.LANCZOS)


def generate(pipe, prompt, seed, roll=False, ref=None, steps=4):
    kwargs = {}
    if ref is not None:
        kwargs["image"] = [ref]
    shifts = [0, 0]
    if roll:
        grid = SIZE // 16
        rng = np.random.default_rng(seed)

        def cb(p, i, t, k):
            if i == steps - 1:  # no shift after the last step: nothing would smooth its seam
                return {}
            lat = k["latents"]
            b, n, c = lat.shape
            g = lat.permute(0, 2, 1).reshape(b, c, grid, grid)
            dy, dx = (int(v) for v in rng.integers(0, grid, 2))
            shifts[0] += dy
            shifts[1] += dx
            g = torch.roll(g, shifts=(dy, dx), dims=(2, 3))
            return {"latents": g.reshape(b, c, grid * grid).permute(0, 2, 1)}

        kwargs.update(callback_on_step_end=cb, callback_on_step_end_tensor_inputs=["latents"])
    convs = [m for m in pipe.vae.decoder.modules() if isinstance(m, torch.nn.Conv2d)]
    for m in convs:
        m.padding_mode = "circular" if roll else "zeros"
    try:
        img = pipe(prompt=prompt, height=SIZE, width=SIZE, num_inference_steps=steps, generator=torch.Generator("cpu").manual_seed(seed), **kwargs).images[0]
    finally:
        for m in convs:
            m.padding_mode = "zeros"
    if roll:  # undo the accumulated shift (16 px per token), so it lines up with the base image
        img = Image.fromarray(np.roll(np.asarray(img), (-shifts[0] * 16 % SIZE, -shifts[1] * 16 % SIZE), axis=(0, 1)))
    return img


def periodic(pipe, prompt, seed, steps=4):
    """Seamless by construction: Klein draws a 1.5x canvas laid out so the tile's wrap-around seam falls in the middle,
    and after every step all canvas tokens for the same tile position are averaged, so the canvas stays an exact
    repeat while the model sees real context across the seam. The tile is cropped from inside the canvas."""
    tile, canvas = SIZE // 16, SIZE * 3 // 2 // 16  # tokens: 64, 96
    off = (tile - canvas // 2) % tile  # canvas token c is tile token (c + off) % tile; the seam lands mid-canvas
    idx = (torch.arange(canvas) + off) % tile
    ch = pipe.transformer.config.in_channels
    g = torch.Generator("cpu").manual_seed(seed)
    noise = torch.randn(1, ch, tile, tile, generator=g)[:, :, idx][:, :, :, idx].to(torch.bfloat16)

    def fold(grid):
        acc = torch.zeros(grid.shape[0], grid.shape[1], tile, tile, dtype=torch.float32, device=grid.device)
        cnt = torch.zeros(tile, tile, device=grid.device)
        ii = idx.to(grid.device)
        for y in range(canvas):
            acc[:, :, ii[y]].index_add_(2, ii, grid[:, :, y].float())
            cnt[ii[y]].index_add_(0, ii, torch.ones(canvas, device=grid.device))
        return (acc / cnt).to(grid.dtype)

    def cb(p, i, t, k):
        lat = k["latents"]
        b, n, c = lat.shape
        grid = lat.permute(0, 2, 1).reshape(b, c, canvas, canvas)
        t_ = fold(grid)
        ii = idx.to(grid.device)
        grid = t_[:, :, ii][:, :, :, ii]
        return {"latents": grid.reshape(b, c, canvas * canvas).permute(0, 2, 1)}

    img = pipe(
        prompt=prompt, height=canvas * 16, width=canvas * 16, num_inference_steps=steps, latents=noise,
        generator=torch.Generator("cpu").manual_seed(seed), callback_on_step_end=cb, callback_on_step_end_tensor_inputs=["latents"],
    ).images[0]
    # A crop starting where tile token 0 is: canvas token (tile - off) % tile.
    s = ((tile - off) % tile) * 16
    return img.crop((s, s, s + SIZE, s + SIZE))


def cross_mask(size: int, band: int) -> np.ndarray:
    """1 on a cross through the middle (the seams after shifting by half), feathered to 0."""
    d = np.abs(np.arange(size) - size / 2)
    line = np.clip(1 - (d - band / 2) / (band / 2), 0, 1)
    line = line * line * (3 - 2 * line)
    return np.maximum(line[None, :], line[:, None])


def repair(pipe, base: Image.Image, prompt: str, seed: int) -> Image.Image:
    shifted = np.roll(np.asarray(base), (SIZE // 2, SIZE // 2), axis=(0, 1))
    edit = generate(
        pipe,
        f"the same {prompt} texture, with the straight seam lines through the middle removed so the pattern flows continuously; keep the colours, scale and style identical",
        seed,
        ref=Image.fromarray(shifted),
    )
    # The edit comes back in a slightly different tone: match its colours to the shifted original first.
    e = np.asarray(edit).astype(np.float32)
    s = shifted.astype(np.float32)
    e = (e - e.mean((0, 1))) / (e.std((0, 1)) + 1e-6) * s.std((0, 1)) + s.mean((0, 1))
    m = cross_mask(SIZE, 192)[..., None]
    out = s * (1 - m) + e * m
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def cpu_blend(base: Image.Image) -> Image.Image:
    """Heitz & Neyret style: base in the middle, its half-shifted copy at the edges, variance-preserving blend."""
    a = np.asarray(base).astype(np.float32)
    b = np.roll(a, (SIZE // 2, SIZE // 2), axis=(0, 1))
    d = np.minimum(np.arange(SIZE), SIZE - 1 - np.arange(SIZE)) / (SIZE / 2)  # 0 at the edges, 1 in the middle
    w1 = np.clip(np.minimum(d[None, :], d[:, None]) * 2.5, 0, 1)
    w1 = (w1 * w1 * (3 - 2 * w1))[..., None]
    w2 = 1 - w1
    mean = a.mean(axis=(0, 1))
    out = ((a - mean) * w1 + (b - mean) * w2) / np.sqrt(w1**2 + w2**2) + mean
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def wrap_blur(x: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur with wrap-around edges (via FFT), so the maps tile like the colour does."""
    h, w = x.shape
    fy, fx = np.fft.fftfreq(h)[:, None], np.fft.fftfreq(w)[None, :]
    return np.real(np.fft.ifft2(np.fft.fft2(x) * np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))))


def maps(img: Image.Image, strength=4.0):
    lum = np.asarray(img.convert("L")).astype(np.float32) / 255
    height = wrap_blur(lum, 1.2) - wrap_blur(lum, 40)  # fine relief, without large lighting gradients
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    n = np.stack([-dx * strength * 10, dy * strength * 10, np.ones_like(dx)], -1)  # OpenGL (+Y up) convention
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))
    # Rougher in the crevices (dark, low), a little smoother on raised, bright parts.
    h = (height - height.min()) / max(np.ptp(height), 1e-6)
    rough = np.clip(0.95 - 0.3 * h, 0.5, 1.0)
    roughness = Image.fromarray((rough * 255).astype(np.uint8))
    return normal, roughness


def sheet(name: str, cells: list[tuple[str, Image.Image, float]]) -> Image.Image:
    w = 600
    out = Image.new("RGB", (w * len(cells), w + 40), (24, 24, 28))
    d = ImageDraw.Draw(out)
    for i, (label, img, score) in enumerate(cells):
        out.paste(tile3(img).resize((w, w), Image.LANCZOS), (i * w, 40))
        d.text((i * w + 10, 12), f"{name} / {label}   seam {score:.2f}", fill=(230, 230, 230))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    pipe = pipeline(Job())
    report = {}
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else set(SURFACES)
    for i, (name, subject) in enumerate(SURFACES.items()):
        seed = 1000 + i
        if name not in only:
            continue
        prompt = f"{subject}, {STYLE}"
        t0 = time.time()
        base = generate(pipe, prompt, seed)
        t_base = time.time() - t0
        t0 = time.time()
        rolled = generate(pipe, prompt, seed, roll=True)
        t_roll = time.time() - t0
        rolled8 = generate(pipe, prompt, seed, roll=True, steps=8)
        t0 = time.time()
        per4 = periodic(pipe, prompt, seed)
        report_p = round(time.time() - t0, 1)
        per8 = periodic(pipe, prompt, seed, steps=8)
        t0 = time.time()
        repaired = repair(pipe, base, subject, seed)
        t_repair = time.time() - t0
        cpu = cpu_blend(base)
        variants = {"base": base, "periodic": per4, "periodic8": per8, "roll8": rolled8, "repair": repaired, "cpu": cpu}
        cells = []
        report[name] = {"seconds": {"base": round(t_base, 1), "roll": round(t_roll, 1), "repair": round(t_repair, 1), "periodic": report_p}, "seam": {}}
        for label, img in variants.items():
            score = seam_score(np.asarray(img))
            report[name]["seam"][label] = round(score, 2)
            img.save(f"{OUT}/{name}-{label}.png")
            tile3(img).save(f"{OUT}/{name}-{label}-3x3.png")
            normal, rough = maps(img)
            normal.save(f"{OUT}/{name}-{label}_normal.png")
            rough.save(f"{OUT}/{name}-{label}_roughness.png")
            cells.append((label, img, score))
        sheet(name, cells).save(f"{OUT}/sheet-{name}.png")
        print(json.dumps({name: report[name]}), flush=True)
    json.dump(report, open(f"{OUT}/report.json", "w"), indent=1)


if __name__ == "__main__":
    main()
