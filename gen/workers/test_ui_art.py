"""Tests for ui_art.py on synthetic images (run in the image env: envs/image/bin/python gen/workers/test_ui_art.py)."""
import os
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import ui_art  # noqa: E402


def pill(w=500, h=200) -> Image.Image:
    im = Image.new("RGB", (w + 100, h + 100), "white")
    ImageDraw.Draw(im).rounded_rectangle((50, 50, 50 + w, 50 + h), radius=h // 2, fill=(150, 80, 30), outline=(220, 170, 40), width=8)
    return im


def framed_panel(size=600, border=60) -> Image.Image:
    im = Image.new("RGB", (size + 80, size + 80), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((40, 40, 40 + size, 40 + size), fill=(90, 55, 30))
    d.rectangle((40 + border, 40 + border, 40 + size - border, 40 + size - border), fill=(245, 232, 200))  # parchment, near-white
    for cx, cy in ((40 + 30, 40 + 30), (40 + size - 30, 40 + 30), (40 + 30, 40 + size - 30), (40 + size - 30, 40 + size - 30)):
        d.ellipse((cx - 40, cy - 40, cx + 40, cy + 40), fill=(200, 160, 40))  # corner studs reaching past the border
    return im


def test_key_cut_keeps_light_insides():
    cut = ui_art.crop(ui_art.key_cut(framed_panel()))
    a = np.asarray(cut)[:, :, 3]
    h, w = a.shape
    assert a[h // 2, w // 2] == 255, "the parchment inside the frame is kept (it isn't connected to the edges)"
    assert cut.size == (621, 621), cut.size  # the frame, plus the studs overhanging it by 10 px
    corner = ui_art.key_cut(framed_panel())
    assert np.asarray(corner)[5, 5, 3] == 0, "the white background is gone"


def test_pill_slices_cover_its_round_ends():
    img = ui_art.crop(ui_art.key_cut(pill()))
    l, t, r, b = ui_art.detect_slice(img, "button")
    h = img.size[1]
    assert l >= h * 0.45, f"the whole round end is a corner: {l} for height {h}"
    assert l == r and t == b


def test_frame_slices_hold_border_and_corner_studs():
    img = ui_art.crop(ui_art.key_cut(framed_panel()))
    l, t, r, b = ui_art.detect_slice(img, "frame")
    # The crop starts at the studs' 10 px overhang; the border ends 70 px in, the studs 80 px in.
    assert l >= 80, f"the corner studs (reaching 80 px in) stay in the corner, beyond the plain border (70): {l}"
    assert l < 300


def test_cut_and_make_write_candidates_and_the_asset():
    d = tempfile.mkdtemp()
    src = os.path.join(d, "button-1.png")
    pill().save(src)
    r = ui_art.cut({"images": [src], "out_dir": os.path.join(d, "candidates"), "kind": "button"})
    c = r["candidates"][0]
    assert os.path.exists(c["file"]) and os.path.exists(r["sheet"]) and len(c["slice"]) == 4
    m = ui_art.make({"source": c["file"], "out_dir": d, "name": "button", "kind": "button", "slice": [40, 30, 40, 30]})
    assert m["slice"] == [40, 30, 40, 30] and Image.open(m["file"]).mode == "RGBA"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
