"""Image worker (env: image): concept images with FLUX.2 Klein 4B, from a prompt and optional reference images.

op "image": {prompt, out_dir, name?, count=1, width=1024, height=1024, seed?, steps=4, references?: [path]}
  -> {images: [path], seeds: [int]}
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
    return {"images": images, "seeds": seeds, "model": "FLUX.2-klein-4B", "prompt": prompt}


if __name__ == "__main__":
    serve({"image": image})
