"""Makes the engine demo's UI art from the M10a spike's cut-outs: a symmetric panel frame and a pill button with
their slice insets beside them (frame.json {"slice": [l, t, r, b]}), and a coin icon. hunyuan3d or image env.
  python gen/spike/ui_demo_art.py <spike-out/ui> <engine>/examples/demo/assets/ui/art
"""
import json
import os
import sys

from PIL import Image

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def symmetric(img):
    w, h = img.size
    q = img.crop((0, 0, w // 2, h // 2))
    o = Image.new("RGBA", (w // 2 * 2, h // 2 * 2))
    o.paste(q, (0, 0))
    o.paste(q.transpose(Image.FLIP_LEFT_RIGHT), (w // 2, 0))
    o.paste(q.transpose(Image.FLIP_TOP_BOTTOM), (0, h // 2))
    o.paste(q.transpose(Image.ROTATE_180), (w // 2, h // 2))
    return o


panel = symmetric(Image.open(os.path.join(src, "cut-panel-12-key.png")))
panel.thumbnail((512, 512), Image.LANCZOS)
panel.save(os.path.join(out, "panel.png"))
d = round(min(panel.size) * 0.22)
json.dump({"slice": [d, d, d, d]}, open(os.path.join(out, "panel.json"), "w"))

button = symmetric(Image.open(os.path.join(src, "cut-button-12-key.png")))
button.thumbnail((512, 256), Image.LANCZOS)
button.save(os.path.join(out, "button.png"))
cap = button.size[1] // 2  # the round ends are corners: the whole cap
json.dump({"slice": [cap, round(button.size[1] * 0.3), cap, round(button.size[1] * 0.3)]}, open(os.path.join(out, "button.json"), "w"))

coin = Image.open(os.path.join(src, "cut-coin-11-key.png"))
coin.thumbnail((128, 128), Image.LANCZOS)
coin.save(os.path.join(out, "coin.png"))
print(panel.size, button.size, coin.size)
