"""M4a spike: concept images with FLUX.2 Klein 4B on a 10 GB GPU.

usage: image.py OUT_DIR [--edit REF.png PROMPT]
Generates a few game-asset concepts (and optionally an edit of a reference image), printing the time and
peak VRAM of each step.
"""
import os
import sys
import time

import torch
from diffusers import Flux2KleinPipeline
from diffusers.hooks import apply_layerwise_casting
from PIL import Image

GEN = os.path.expanduser("~/.local/share/game-studio/gen")
MODEL = f"{GEN}/models/black-forest-labs/FLUX.2-klein-4B"

STYLE = "game asset concept art, single object centred, full view, plain white background, soft even studio lighting, no shadow on background"
CONCEPTS = {
    "chest": f"a stylised wooden treasure chest with iron bands and a brass lock, {STYLE}",
    "robot": f"a small round friendly robot explorer character with stubby legs and one big eye, standing in a T-pose, front view, {STYLE}",
    "lantern": f"an old iron hanging lantern with glass panes, {STYLE}",
}


def report(label: str, t0: float) -> None:
    peak = torch.cuda.max_memory_allocated() / 2**30
    print(f"{label}: {time.time() - t0:.1f}s, peak VRAM {peak:.2f} GiB", flush=True)
    torch.cuda.reset_peak_memory_stats()


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    pipe = Flux2KleinPipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16)
    # In bf16 the text encoder (8 GB) and the transformer (7.75 GB) each exceed what a 10 GB card has free
    # beside a desktop. Store their weights in fp8 (computing in bf16) and keep only one on the GPU at a time.
    skip = ("norm", "embed", "lm_head", "proj_out", "x_embedder", "context_embedder")
    apply_layerwise_casting(pipe.text_encoder, storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16, skip_modules_pattern=skip)
    pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    report("load", t0)

    if "--views" in sys.argv:
        # Other views of an existing concept, as references for multi-view image-to-3D.
        ref = Image.open(sys.argv[sys.argv.index("--views") + 1]).convert("RGB")
        views = {
            "left": "the exact same object seen from its left side, side view, orthographic, same design, colours and materials",
            "back": "the exact same object seen from behind, back view, orthographic, same design, colours and materials",
        }
        for name, prompt in views.items():
            t0 = time.time()
            image = pipe(prompt=f"{prompt}, {STYLE}", image=[ref], height=1024, width=1024, num_inference_steps=4, generator=torch.Generator("cpu").manual_seed(1)).images[0]
            image.save(f"{out}/{name}.png")
            report(f"view {name}", t0)
        return

    for name, prompt in CONCEPTS.items():
        t0 = time.time()
        image = pipe(prompt=prompt, height=1024, width=1024, num_inference_steps=4, generator=torch.Generator("cpu").manual_seed(1)).images[0]
        image.save(f"{out}/{name}.png")
        report(f"concept {name}", t0)

    if "--edit" in sys.argv:
        i = sys.argv.index("--edit")
        ref, prompt = sys.argv[i + 1], sys.argv[i + 2]
        t0 = time.time()
        image = pipe(prompt=prompt, image=[Image.open(ref).convert("RGB")], height=1024, width=1024, num_inference_steps=4, generator=torch.Generator("cpu").manual_seed(1)).images[0]
        image.save(f"{out}/edit.png")
        report("edit", t0)


if __name__ == "__main__":
    main()
