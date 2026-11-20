"""Hunyuan3D worker (env: hunyuan3d): image(s) -> mesh, and mesh + image -> textured mesh.

op "shape":   {image, back?, out, faces=40000, seed?, steps=5, octree_resolution=380}
  -> {mesh, faces, vertices, model}
op "texture": {mesh, image, out} -> {mesh, model}

One image uses Hunyuan3D-2mini-Turbo; a back view switches to Hunyuan3D-2mv-Turbo. Models stay loaded between
requests (the service stops this worker when another needs the GPU). Only one of shape/paint is kept loaded.
"""
import gc
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from protocol import GEN, MODELS, Job, serve  # noqa: E402
from texture_fix import match_concept_brightness  # noqa: E402

os.environ.setdefault("HY3DGEN_MODELS", MODELS)
os.environ.setdefault("U2NET_HOME", os.path.join(MODELS, "u2net"))

import torch  # noqa: E402,I001  (torch must load before the compiled texture extensions)
import trimesh  # noqa: E402
from hy3dgen.rembg import BackgroundRemover  # noqa: E402
from hy3dgen.shapegen import DegenerateFaceRemover, FaceReducer, FloaterRemover, Hunyuan3DDiTFlowMatchingPipeline  # noqa: E402
from PIL import Image  # noqa: E402

_loaded: dict[str, object] = {}
_remover = None

SHAPE_MODELS = {
    "single": ("tencent/Hunyuan3D-2mini", "hunyuan3d-dit-v2-mini-turbo"),
    "multi": ("tencent/Hunyuan3D-2mv", "hunyuan3d-dit-v2-mv-turbo"),
}


def load(job: Job, key: str):
    """Keeps at most one big model on the GPU: loading one releases the others."""
    if key in _loaded:
        return _loaded[key]
    for other in list(_loaded):
        del _loaded[other]
    gc.collect()
    torch.cuda.empty_cache()
    if key == "paint":
        from hy3dgen.texgen import Hunyuan3DPaintPipeline

        job.progress("Loading Hunyuan3D-Paint")
        # The paint unet's own loader torch.loads its 7.3 GB fp32 checkpoint into RAM beside the fp32 model:
        # about 20 GB of RAM at peak, enough to get the studio OOM-killed on a 32 GB machine in normal use.
        # Memory-mapping the checkpoint keeps it in the page cache instead (peak 8 GB).
        real_load = torch.load
        torch.load = lambda *a, **k: real_load(*a, **{**k, "mmap": True})
        try:
            pipe = Hunyuan3DPaintPipeline.from_pretrained("tencent/Hunyuan3D-2", subfolder="hunyuan3d-paint-v2-0-turbo")
        finally:
            torch.load = real_load
        pipe.enable_model_cpu_offload()
    else:
        repo, sub = SHAPE_MODELS[key]
        job.progress(f"Loading {sub}")
        pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(repo, subfolder=sub, use_safetensors=True, variant="fp16", device="cuda")
        pipe.enable_flashvdm()
    _loaded[key] = pipe
    return pipe


def cutout(job: Job, path: str) -> Image.Image:
    global _remover
    if _remover is None:
        job.progress("Loading background remover")
        _remover = BackgroundRemover()
    return _remover(Image.open(path).convert("RGB"))


def shape(job: Job, p: dict) -> dict:
    views = {"front": p["image"]}
    if p.get("back"):
        views["back"] = p["back"]
    job.progress("Removing backgrounds")
    images = {k: cutout(job, v) for k, v in views.items()}
    key = "multi" if len(images) > 1 else "single"
    pipe = load(job, key)
    seed = int(p["seed"]) if p.get("seed") is not None else random.randrange(2**31)
    job.progress("Generating shape", 0.3)
    mesh = pipe(
        image=images if key == "multi" else images["front"],
        num_inference_steps=int(p.get("steps", 5)),
        octree_resolution=int(p.get("octree_resolution", 380)),
        num_chunks=20000,
        generator=torch.manual_seed(seed),
        output_type="trimesh",
    )[0]
    job.progress("Cleaning up the mesh", 0.8)
    mesh = FloaterRemover()(mesh)
    mesh = DegenerateFaceRemover()(mesh)
    mesh = FaceReducer()(mesh, max_facenum=int(p.get("faces", 40000)))
    os.makedirs(os.path.dirname(p["out"]), exist_ok=True)
    mesh.export(p["out"])
    return {"mesh": p["out"], "faces": len(mesh.faces), "vertices": len(mesh.vertices), "seed": seed, "model": SHAPE_MODELS[key][1]}


def texture(job: Job, p: dict) -> dict:
    image = cutout(job, p["image"])
    pipe = load(job, "paint")
    job.progress("Painting texture", 0.3)
    textured = pipe(trimesh.load(p["mesh"], force="mesh"), image=image)
    # The pipeline's mesh has a SimpleMaterial (texture in .image); a reloaded glb has a PBRMaterial.
    material = textured.visual.material
    field = "image" if hasattr(material, "image") else "baseColorTexture"
    corrected, gains = match_concept_brightness(getattr(material, field), textured.visual.uv, textured.faces, image)
    setattr(material, field, corrected)
    os.makedirs(os.path.dirname(p["out"]), exist_ok=True)
    textured.export(p["out"])
    return {"mesh": p["out"], "model": "hunyuan3d-paint-v2-0-turbo", **({"brightness_gains": gains} if gains else {})}


if __name__ == "__main__":
    os.chdir(GEN)
    serve({"shape": shape, "texture": texture})
