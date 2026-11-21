"""M10a spike: generated UI art from FLUX.2 Klein: 9-slice frames (a panel, a button) and icons, on a plain
background, to be cut out by ui_cut.py. Run in the image env:  envs/image/bin/python gen/spike/ui_art.py <out_dir>
"""
import json
import os
import sys
import time

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "workers"))
from image_worker import pipeline  # noqa: E402

OUT = sys.argv[1]
STYLE = "whimsical hand-painted fantasy game UI art, warm colours, clean shapes, bold readable forms, no text, no letters"
BG = "isolated on a plain flat white background"
ASSETS = {
    "panel": ("a rectangular game UI panel frame: a carved dark wooden border with small gold rivets in the corners, the inside is plain flat empty parchment, seen straight on, perfectly symmetrical, centred and filling most of the image", 1024, 1024),
    "button": ("a wide game UI button: a rounded wooden plaque with a thin gold rim, its centre plain and flat, seen straight on, perfectly symmetrical, centred", 1024, 512),
    "coin": ("a single shiny gold coin icon with a goblin face stamped on it, game inventory icon, centred", 1024, 1024),
    "chest": ("a single small wooden treasure chest icon with gold trim, game inventory icon, front three-quarter view, centred", 1024, 1024),
    "map": ("a single rolled-up parchment treasure map icon tied with a red ribbon, game inventory icon, centred", 1024, 1024),
}
SEEDS = [11, 12]


class Job:
    def progress(self, msg, frac=None):
        print(msg, flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    pipe = pipeline(Job())
    log = []
    for name, (prompt, w, h) in ASSETS.items():
        for seed in SEEDS:
            t = time.time()
            img = pipe(prompt=f"{prompt}, {STYLE}, {BG}", width=w, height=h, num_inference_steps=4, generator=torch.Generator("cpu").manual_seed(seed)).images[0]
            path = os.path.join(OUT, f"{name}-{seed}.png")
            img.save(path)
            log.append({"name": name, "seed": seed, "seconds": round(time.time() - t, 1)})
            print(log[-1], flush=True)
    json.dump(log, open(os.path.join(OUT, "generated.json"), "w"), indent=1)


main()
