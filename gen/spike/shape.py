"""M4a spike: image(s) -> untextured mesh with Hunyuan3D-2 (mini turbo, or mv turbo for several views).

usage: shape.py OUT.glb FRONT.png [--back BACK.png] [--left LEFT.png]
One image uses Hunyuan3D-2mini-Turbo; extra views switch to Hunyuan3D-2mv-Turbo.
"""
import os
import sys
import time

GEN = os.path.expanduser("~/.local/share/game-studio/gen")
os.environ.setdefault("HY3DGEN_MODELS", f"{GEN}/models")
os.environ.setdefault("U2NET_HOME", f"{GEN}/models/u2net")

import torch  # noqa: E402
from hy3dgen.rembg import BackgroundRemover  # noqa: E402
from hy3dgen.shapegen import DegenerateFaceRemover, FaceReducer, FloaterRemover, Hunyuan3DDiTFlowMatchingPipeline  # noqa: E402
from PIL import Image  # noqa: E402


def report(label: str, t0: float) -> None:
    print(f"{label}: {time.time() - t0:.1f}s, peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB", flush=True)
    torch.cuda.reset_peak_memory_stats()


def main() -> None:
    out, front = sys.argv[1], sys.argv[2]
    views = {"front": front}
    for flag in ("--back", "--left"):
        if flag in sys.argv:
            views[flag[2:]] = sys.argv[sys.argv.index(flag) + 1]

    t0 = time.time()
    remover = BackgroundRemover()
    images = {k: remover(Image.open(v).convert("RGB")) for k, v in views.items()}
    report("background removal", t0)

    t0 = time.time()
    multi = len(images) > 1
    repo, sub = ("tencent/Hunyuan3D-2mv", "hunyuan3d-dit-v2-mv-turbo") if multi else ("tencent/Hunyuan3D-2mini", "hunyuan3d-dit-v2-mini-turbo")
    pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(repo, subfolder=sub, use_safetensors=True, variant="fp16", device="cuda")
    pipe.enable_flashvdm()
    report(f"load {sub}", t0)

    t0 = time.time()
    mesh = pipe(
        image=images if multi else images["front"],
        num_inference_steps=5,
        octree_resolution=380,
        num_chunks=20000,
        generator=torch.manual_seed(12345),
        output_type="trimesh",
    )[0]
    report("shape", t0)

    t0 = time.time()
    raw_faces = len(mesh.faces)
    mesh = FloaterRemover()(mesh)
    mesh = DegenerateFaceRemover()(mesh)
    mesh = FaceReducer()(mesh, max_facenum=40000)
    report(f"cleanup ({raw_faces} -> {len(mesh.faces)} faces)", t0)
    mesh.export(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
