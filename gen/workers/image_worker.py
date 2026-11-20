"""Image worker (env: image): concept images with FLUX.2 Klein 4B, from a prompt and optional reference images.

op "image": {prompt, out_dir, name?, count=1, width=1024, height=1024, seed?, steps=4, references?: [path]}
  -> {images: [path], seeds: [int]}
op "surface": {prompt, out_dir, name, count=2, seed?} -> {images: [path], seeds, methods, sheet}: tileable surface
  candidates, two per seed: "roll" (latents shifted every step, 8 steps, circular decoder) and "quilt" (a plain image
  made seamless by cutting); see surfaces.py and the vault note M9 Textures
op "surface_make": {source, out_dir, name, normal_strength?, roughness?} -> {files, preview} (CPU only)
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from protocol import MODELS, Job, serve  # noqa: E402

import torch  # noqa: E402
from diffusers import Flux2KleinPipeline  # noqa: E402
from diffusers.hooks import apply_layerwise_casting  # noqa: E402
from PIL import Image  # noqa: E402

MODEL = os.path.join(MODELS, "black-forest-labs/FLUX.2-klein-4B")
# Concept art meant for image-to-3D: one object, whole, on plain white, evenly lit.
ASSET_STYLE = "single object centred, full view, plain white background, soft even studio lighting, no shadow on background"
_pipe = None


def pipeline(job: Job):
    global _pipe
    if _pipe is None:
        job.progress("Loading FLUX.2 Klein")
        pipe = Flux2KleinPipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16)
        # In bf16 the text encoder (8 GB) and transformer (7.75 GB) each exceed a 10 GB card beside a desktop.
        # Store weights in fp8 (compute in bf16) and keep only one on the GPU at a time.
        skip = ("norm", "embed", "lm_head", "proj_out", "x_embedder", "context_embedder")
        apply_layerwise_casting(pipe.text_encoder, storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16, skip_modules_pattern=skip)
        pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
        pipe.enable_model_cpu_offload()
        _pipe = pipe
    return _pipe


def image(job: Job, p: dict) -> dict:
    pipe = pipeline(job)
    out_dir = p["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    count = int(p.get("count", 1))
    base_seed = int(p["seed"]) if p.get("seed") is not None else random.randrange(2**31)
    prompt = p["prompt"] if p.get("raw_prompt") else f"{p['prompt']}, {ASSET_STYLE}"
    refs = [Image.open(r).convert("RGB") for r in p.get("references") or []]
    name = p.get("name", "concept")
    images, seeds = [], []
    for i in range(count):
        seed = base_seed + i
        job.progress(f"Generating image {i + 1} of {count}", i / count)
        kwargs = {"image": refs} if refs else {}
        result = pipe(
            prompt=prompt,
            height=int(p.get("height", 1024)),
            width=int(p.get("width", 1024)),
            num_inference_steps=int(p.get("steps", 4)),
            generator=torch.Generator("cpu").manual_seed(seed),
            **kwargs,
        ).images[0]
        path = os.path.join(out_dir, f"{name}-{seed}.png" if count > 1 or p.get("seed") is None else f"{name}.png")
        result.save(path)
        images.append(path)
        seeds.append(seed)
    return {"images": images, "seeds": seeds, "model": "FLUX.2-klein-4B", "prompt": prompt, "sheet": contact_sheet(images)}


def contact_sheet(paths: list[str]) -> str:
    """All the images side by side, numbered, as one small JPEG (a temp file) so an agent sees every option at once."""
    import tempfile

    from PIL import ImageDraw

    size, cols = 320, min(4, len(paths))
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * size, rows * size), "white")
    draw = ImageDraw.Draw(sheet)
    for i, path in enumerate(paths):
        x, y = (i % cols) * size, (i // cols) * size
        sheet.paste(Image.open(path).convert("RGB").resize((size, size)), (x, y))
        draw.rectangle((x + 6, y + 6, x + 34, y + 34), fill="black")
        draw.text((x + 15, y + 12), str(i + 1), fill="white")
    fd, out = tempfile.mkstemp(prefix="gs-concepts-", suffix=".jpg")
    os.close(fd)
    sheet.save(out, quality=85)
    return out


SURFACE_STYLE = "seamless tileable texture, top-down orthographic view, flat even lighting, no shadows, no perspective, fills the whole frame"


def _surface_image(pipe, prompt: str, seed: int, roll: bool) -> Image.Image:
    """A 1024 px surface image; with roll, latents shift by a random offset before every step but the last, and the
    decoder pads circularly, so no fixed seam forms (8 steps give the shifts time to heal)."""
    import numpy as np

    size, steps = 1024, 8 if roll else 4
    grid = size // 16
    rng = np.random.default_rng(seed)
    shift = [0, 0]

    def cb(p, i, t, k):
        if i == steps - 1:
            return {}
        lat = k["latents"]
        b, n, c = lat.shape
        g = lat.permute(0, 2, 1).reshape(b, c, grid, grid)
        dy, dx = (int(v) for v in rng.integers(0, grid, 2))
        shift[0] += dy
        shift[1] += dx
        g = torch.roll(g, shifts=(dy, dx), dims=(2, 3))
        return {"latents": g.reshape(b, c, grid * grid).permute(0, 2, 1)}

    convs = [m for m in pipe.vae.decoder.modules() if isinstance(m, torch.nn.Conv2d)]
    for m in convs:
        m.padding_mode = "circular" if roll else "zeros"
    try:
        kwargs = {"callback_on_step_end": cb, "callback_on_step_end_tensor_inputs": ["latents"]} if roll else {}
        img = pipe(prompt=prompt, height=size, width=size, num_inference_steps=steps, generator=torch.Generator("cpu").manual_seed(seed), **kwargs).images[0]
    finally:
        for m in convs:
            m.padding_mode = "zeros"
    if roll:
        img = Image.fromarray(np.roll(np.asarray(img), (-shift[0] * 16 % size, -shift[1] * 16 % size), axis=(0, 1)))
    return img


def surface(job: Job, p: dict) -> dict:
    from surfaces import quilt, sheet

    pipe = pipeline(job)
    out_dir, name = p["out_dir"], p["name"]
    os.makedirs(out_dir, exist_ok=True)
    count = int(p.get("count", 2))
    base_seed = int(p["seed"]) if p.get("seed") is not None else random.randrange(2**31)
    prompt = f"{p['prompt']}, {SURFACE_STYLE}"
    images, seeds, methods, shown = [], [], [], []
    for i in range(count):
        seed = base_seed + i
        job.progress(f"Surface {i + 1} of {count}: rolled", i / count)
        rolled = _surface_image(pipe, prompt, seed, roll=True)
        job.progress(f"Surface {i + 1} of {count}: quilted", (i + 0.5) / count)
        quilted = quilt(_surface_image(pipe, prompt, seed, roll=False))
        for method, img in (("roll", rolled), ("quilt", quilted)):
            path = os.path.join(out_dir, f"{name}-{seed}-{method}.png")
            img.save(path, optimize=True)
            images.append(path)
            seeds.append(seed)
            methods.append(method)
            shown.append(img)
    labels = [f"{i + 1}: {os.path.basename(f)}" for i, f in enumerate(images)]
    return {"images": images, "seeds": seeds, "methods": methods, "model": "FLUX.2-klein-4B", "prompt": prompt, "sheet": sheet(shown, labels)}


def surface_make(job: Job, p: dict) -> dict:
    from surfaces import make

    job.progress("Normal and roughness maps")
    return make(p)


if __name__ == "__main__":
    serve({"image": image, "surface": surface, "surface_make": surface_make})
