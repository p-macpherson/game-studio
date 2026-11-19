"""Fake worker for tests (GAME_STUDIO_GEN_FAKE=1): speaks the real protocol but writes fixture files instead of
running models, so the queue, tools and UI can be exercised without a GPU. Runs on any Python 3.

Ops: image, shape, texture, rig (same params and result shapes as the real workers). For testing the service
itself, any op accepts "crash", "fail" and "sleep" params (see step). FAKE_WORKER_DELAY sets the default delay.
"""
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from protocol import Job, serve  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
DELAY = float(os.environ.get("FAKE_WORKER_DELAY", "0.05"))


def step(job: Job, op: str, p: dict) -> None:
    """Test hooks in any op's params: {"crash": true} exits the worker, {"fail": "msg"} raises, {"sleep": s} waits."""
    if p.get("crash"):
        os._exit(3)
    if p.get("fail"):
        raise RuntimeError(p["fail"])
    job.progress(f"Faking {op}", 0.5)
    time.sleep(float(p.get("sleep", DELAY)))


def copy(fixture: str, out: str) -> str:
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    shutil.copyfile(os.path.join(FIXTURES, fixture), out)
    return out


def image(job: Job, p: dict) -> dict:
    step(job, "image", p)
    count, seed = int(p.get("count", 1)), int(p.get("seed") or 1)
    name = p.get("name", "concept")
    images = [copy("concept.png", os.path.join(p["out_dir"], f"{name}-{seed + i}.png")) for i in range(count)]
    return {"images": images, "seeds": [seed + i for i in range(count)], "model": "fake", "prompt": p["prompt"]}


def shape(job: Job, p: dict) -> dict:
    step(job, "shape", p)
    return {"mesh": copy("cube.glb", p["out"]), "faces": 12, "vertices": 24, "seed": int(p.get("seed") or 1), "model": "fake"}


def texture(job: Job, p: dict) -> dict:
    step(job, "texture", p)
    return {"mesh": copy("cube.glb", p["out"]), "model": "fake"}


def rig(job: Job, p: dict) -> dict:
    step(job, "rig", p)
    return {"mesh": copy("cube.glb", p["out"]), "model": "fake"}


if __name__ == "__main__":
    serve({"image": image, "shape": shape, "texture": texture, "rig": rig})
