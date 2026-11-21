"""Fake worker for tests (GAME_STUDIO_GEN_FAKE=1): speaks the real protocol but writes fixture files instead of
running models, so the queue, tools and UI can be exercised without a GPU. Runs on any Python 3.

Ops: image, surface, surface_make, shape, texture, rig, sound (same params and result shapes as the real workers). For testing the service
itself, any op accepts "crash", "fail" and "sleep" params (see step). FAKE_WORKER_DELAY sets the default delay.
"""
import math
import os
import random
import shutil
import struct
import tempfile
import sys
import time
import wave

sys.path.insert(0, os.path.dirname(__file__))
from protocol import Job, serve  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
DELAY = float(os.environ.get("FAKE_WORKER_DELAY", "0.05"))


def step(job: Job, op: str, p: dict) -> None:
    """Test hooks in any op's params: {"crash": true} exits the worker, {"fail": "msg"} raises, {"fail_once": path}
    raises a CUDA out-of-memory error the first time (marking the path), {"sleep": s} waits."""
    if p.get("crash"):
        os._exit(3)
    if p.get("fail"):
        raise RuntimeError(p["fail"])
    if p.get("fail_once") and not os.path.exists(p["fail_once"]):
        open(p["fail_once"], "w").close()
        raise RuntimeError("CUDA out of memory (fake)")
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
    fd, sheet = tempfile.mkstemp(prefix="gs-concepts-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), sheet)
    return {"images": images, "seeds": [seed + i for i in range(count)], "model": "fake", "prompt": p["prompt"], "sheet": sheet}


def surface(job: Job, p: dict) -> dict:
    step(job, "surface", p)
    count, seed, name = int(p.get("count", 2)), int(p.get("seed") or 1), p["name"]
    images, seeds, methods = [], [], []
    for i in range(count):
        for method in ("roll", "quilt"):
            images.append(copy("concept.png", os.path.join(p["out_dir"], f"{name}-{seed + i}-{method}.png")))
            seeds.append(seed + i)
            methods.append(method)
    fd, sheet = tempfile.mkstemp(prefix="gs-surfaces-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), sheet)
    return {"images": images, "seeds": seeds, "methods": methods, "model": "fake", "prompt": p["prompt"], "sheet": sheet}


def surface_make(job: Job, p: dict) -> dict:
    step(job, "surface_make", p)
    files = [os.path.join(p["out_dir"], f"{p['name']}{s}.png") for s in ("", "_normal", "_roughness")]
    for f in files:
        os.makedirs(p["out_dir"], exist_ok=True)
        shutil.copyfile(p["source"], f)
    fd, preview = tempfile.mkstemp(prefix="gs-surfaces-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), preview)
    return {"files": files, "preview": preview}


def ui_cut(job: Job, p: dict) -> dict:
    step(job, "ui_cut", p)
    os.makedirs(p["out_dir"], exist_ok=True)
    out = []
    for src in p["images"]:
        f = os.path.join(p["out_dir"], os.path.basename(src))
        shutil.copyfile(src, f)
        out.append({"file": f, "slice": [] if p["kind"] == "icon" else [10, 10, 10, 10]})
    fd, sheet = tempfile.mkstemp(prefix="gs-ui-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), sheet)
    return {"candidates": out, "sheet": sheet}


def ui_make(job: Job, p: dict) -> dict:
    step(job, "ui_make", p)
    f = os.path.join(p["out_dir"], f"{p['name']}.png")
    shutil.copyfile(p["source"], f)
    fd, preview = tempfile.mkstemp(prefix="gs-ui-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), preview)
    s = [int(v) for v in p["slice"]] if p.get("slice") else ([] if p["kind"] == "icon" else [10, 10, 10, 10])
    return {"file": f, "slice": s, "preview": preview}


def particle_cut(job: Job, p: dict) -> dict:
    step(job, "particle_cut", p)
    os.makedirs(p["out_dir"], exist_ok=True)
    out = []
    for src in p["images"]:
        f = os.path.join(p["out_dir"], os.path.splitext(os.path.basename(src))[0] + ".png")
        shutil.copyfile(src, f)
        out.append({"file": f})
    fd, sheet = tempfile.mkstemp(prefix="gs-particles-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), sheet)
    return {"candidates": out, "sheet": sheet}


def particle_make(job: Job, p: dict) -> dict:
    step(job, "particle_make", p)
    os.makedirs(p["out_dir"], exist_ok=True)
    f = os.path.join(p["out_dir"], f"{p['name']}.png")
    shutil.copyfile(p.get("source") or os.path.join(FIXTURES, "concept.png"), f)
    fd, preview = tempfile.mkstemp(prefix="gs-particles-", suffix=".png")
    os.close(fd)
    shutil.copyfile(os.path.join(FIXTURES, "concept.png"), preview)
    fb = (p.get("recipe") or {}).get("flipbook") or [1, 1]
    return {"file": f, "flipbook": fb, "preview": preview}


def shape(job: Job, p: dict) -> dict:
    step(job, "shape", p)
    return {"mesh": copy("cube.glb", p["out"]), "faces": 12, "vertices": 24, "seed": int(p.get("seed") or 1), "model": "fake"}


def texture(job: Job, p: dict) -> dict:
    step(job, "texture", p)
    return {"mesh": copy("textured.glb", p["out"]), "model": "fake"}


def sound(job: Job, p: dict) -> dict:
    step(job, "sound", p)
    # A stand-in take per seed: 0.2 s of silence, then a decaying tone whose pitch and level depend on the seed,
    # then silence to the requested length (so trimming and levels have something to do). 16-bit stereo 44.1 kHz.
    takes = []
    for seed in p["seeds"]:
        rng = random.Random(seed)
        freq, level, rate = 200 + rng.random() * 800, 0.2 + rng.random() * 0.5, 44100
        n = int(float(p["seconds"]) * rate)
        path = os.path.join(p["out_dir"], f"{p.get('name', 'main')}-{seed}.wav")
        os.makedirs(p["out_dir"], exist_ok=True)
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(rate)
            frames = bytearray()
            for i in range(n):
                t = i / rate - 0.2
                v = 0.0 if t < 0 else level * math.sin(2 * math.pi * freq * t) * math.exp(-t * 6)
                s = int(max(-1, min(1, v)) * 32767)
                frames += struct.pack("<hh", s, s)
            w.writeframes(bytes(frames))
        takes.append({"seed": seed, "path": path, "clap": round(0.3 + (seed % 7) * 0.02, 4)})
    return {"takes": takes, "model": "fake"}


def rig(job: Job, p: dict) -> dict:
    step(job, "rig", p)
    # A small rigged stick figure shaped like UniRig's output (fixtures/make_biped.py), so animate.py has a biped.
    return {"mesh": copy("biped.glb", p["out"]), "model": "fake"}


if __name__ == "__main__":
    serve({"image": image, "surface": surface, "surface_make": surface_make, "ui_cut": ui_cut, "ui_make": ui_make, "particle_cut": particle_cut, "particle_make": particle_make, "shape": shape, "texture": texture, "rig": rig, "sound": sound})
