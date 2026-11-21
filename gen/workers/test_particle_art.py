"""Tests for particle_art.py on synthetic images (run in the image env: envs/image/bin/python gen/workers/test_particle_art.py)."""
import os
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import particle_art  # noqa: E402


def test_glow_cut_takes_alpha_from_brightness_and_centres_it():
    im = Image.new("RGB", (512, 512), "black")
    ImageDraw.Draw(im).ellipse((40, 300, 140, 400), fill=(255, 160, 40))  # an ember, off centre
    sprite = particle_art.square(particle_art.glow_cut(im), 256)
    a = np.asarray(sprite)[..., 3]
    ys, xs = np.nonzero(a > 128)
    assert abs(xs.mean() - 128) < 6 and abs(ys.mean() - 128) < 6, "centred"
    assert a[0, 0] == 0 and a[128, 128] > 240, "black is clear, the ember opaque"
    rgb = np.asarray(sprite)[128, 128, :3]
    assert rgb[0] > 240 and 140 < rgb[1] < 180, "colour kept (not darkened by the alpha)"


def test_solid_cut_keeps_dark_colours_opaque():
    im = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(im).ellipse((180, 180, 330, 330), fill=(30, 90, 30))  # a dark leaf: a brightness alpha would lose it
    out = tempfile.mkdtemp()
    src = os.path.join(out, "leaf-1.png")
    im.save(src)
    r = particle_art.cut({"images": [src], "out_dir": os.path.join(out, "c"), "mode": "solid"})
    a = np.asarray(Image.open(r["candidates"][0]["file"]))[..., 3]
    assert a[128, 128] == 255 and a[2, 2] == 0


def test_flipbook_frames_grow_and_fade():
    img, fb = particle_art.procedural({"shape": "smoke", "flipbook": [4, 4], "seed": 3})
    assert fb == [4, 4] and img.size == (512, 512)
    a = np.asarray(img)[..., 3].astype(float)
    first, last = a[:128, :128], a[384:, 384:]
    assert (last > 10).sum() > (first > 10).sum(), "later frames are bigger"
    assert last.max() < first.max(), "and fainter"


def test_unknown_shapes_and_still_shapes_in_flipbooks_are_refused():
    for recipe in ({"shape": "blob"}, {"shape": "spark", "flipbook": [2, 2]}):
        try:
            particle_art.procedural(recipe)
        except ValueError:
            continue
        raise AssertionError(f"{recipe} should be refused")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
