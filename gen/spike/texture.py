"""M4a spike: texture an untextured mesh from its concept image with Hunyuan3D-Paint 2.0 Turbo.

usage: texture.py IN.glb CONCEPT.png OUT.glb
Uses model CPU offload so the delight and multiview diffusion models take turns on a 10 GB GPU.
"""
import os
import sys
import time

GEN = os.path.expanduser("~/.local/share/game-studio/gen")
os.environ.setdefault("HY3DGEN_MODELS", f"{GEN}/models")
os.environ.setdefault("U2NET_HOME", f"{GEN}/models/u2net")

import torch  # noqa: E402,I001  (torch must load before the compiled extensions)
import trimesh  # noqa: E402
from hy3dgen.rembg import BackgroundRemover  # noqa: E402
from hy3dgen.texgen import Hunyuan3DPaintPipeline  # noqa: E402
from PIL import Image  # noqa: E402


def report(label: str, t0: float) -> None:
    print(f"{label}: {time.time() - t0:.1f}s, peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB", flush=True)
    torch.cuda.reset_peak_memory_stats()


def main() -> None:
    src, concept, out = sys.argv[1:4]
    t0 = time.time()
    pipe = Hunyuan3DPaintPipeline.from_pretrained("tencent/Hunyuan3D-2", subfolder="hunyuan3d-paint-v2-0-turbo")
    pipe.enable_model_cpu_offload()
    report("load paint", t0)

    image = BackgroundRemover()(Image.open(concept).convert("RGB"))
    mesh = trimesh.load(src, force="mesh")
    t0 = time.time()
    textured = pipe(mesh, image=image)
    report("texture", t0)
    textured.export(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
