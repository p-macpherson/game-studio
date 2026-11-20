"""Brightness check for Hunyuan3D-Paint's bakes (numpy + Pillow only, so it runs in any env).

Measured on the demo game's models: a healthy bake's median colour is 0.8-0.9 of its concept's (the de-lighting
step removes highlights), but dark materials come out much lighter (a charcoal basalt concept baked to pale grey:
1.5x). Medians, because parts no painting camera saw (a rock's underside) bake nearly black and would drag a
mean down. A bake brighter than its concept is pulled back to the usual ratio,
per channel (which also undoes the slight hue shift that comes with it). Other bakes are left alone.
"""
import numpy as np
from PIL import Image, ImageDraw

USUAL_RATIO = 0.85


def used_texels(uv: np.ndarray, faces: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Mask of the texels the mesh's UV triangles cover (the rest is padding)."""
    w, h = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    pts = np.stack([uv[:, 0] * (w - 1), (1 - uv[:, 1]) * (h - 1)], axis=1)
    for f in faces:
        draw.polygon([tuple(pts[i]) for i in f], fill=255)
    return np.array(mask) > 0


def match_concept_brightness(texture: Image.Image, uv: np.ndarray, faces: np.ndarray, concept: Image.Image) -> tuple[Image.Image, list[float] | None]:
    """Returns the texture, darkened if the bake came out brighter than the concept, and the gains applied."""
    cut = np.asarray(concept.convert("RGBA")).astype(np.float32)
    obj = cut[cut[..., 3] > 128][:, :3]
    rgb = texture.convert("RGB")
    tex = np.asarray(rgb).astype(np.float32)
    used = tex[used_texels(uv, faces, rgb.size)]
    if len(obj) < 100 or len(used) < 100:
        return texture, None
    concept_mid, tex_mid = np.median(obj, 0), np.maximum(np.median(used, 0), 1)
    if tex_mid.mean() <= concept_mid.mean():
        return texture, None
    gains = np.minimum(USUAL_RATIO * concept_mid / tex_mid, 1)
    out = Image.fromarray(np.clip(tex * gains, 0, 255).astype(np.uint8))
    if texture.mode == "RGBA":
        out.putalpha(texture.getchannel("A"))
    return out, [round(float(g), 3) for g in gains]
