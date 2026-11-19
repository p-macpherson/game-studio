"""UniRig worker (env: unirig): mesh -> rigged mesh (skeleton + skin weights).

op "rig": {mesh, out, seed=12345} -> {mesh, model}

Runs UniRig's own inference scripts (each step loads its model, about 10 s). The result still needs the
Blender finalize step: UniRig writes one vertex per triangle corner, which the engine can't render.
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from protocol import GEN, Job, serve  # noqa: E402

REPO = os.path.join(GEN, "src/UniRig")


def run(job: Job, script: str, args: list[str], message: str, fraction: float) -> None:
    job.progress(message, fraction)
    env = {**os.environ, "HF_HOME": os.path.join(GEN, "hf"), "HF_HUB_OFFLINE": "1", "PATH": f"{os.path.dirname(sys.executable)}:{os.environ['PATH']}"}
    proc = subprocess.run(["bash", f"launch/inference/{script}", *args], cwd=REPO, env=env, capture_output=True, text=True)
    sys.stderr.write(proc.stdout[-4000:] + proc.stderr[-4000:])
    # The scripts exit 0 even when their Python step fails; the missing output file is the real signal.
    if proc.returncode != 0:
        raise RuntimeError(f"{script} failed (exit {proc.returncode})")


def rig(job: Job, p: dict) -> dict:
    out = p["out"]
    with tempfile.TemporaryDirectory(prefix="unirig-") as tmp:
        # UniRig writes intermediates next to its input, so work on a copy in the temp folder.
        mesh = os.path.join(tmp, "input" + os.path.splitext(p["mesh"])[1])
        shutil.copyfile(p["mesh"], mesh)
        skeleton, skin = os.path.join(tmp, "skeleton.fbx"), os.path.join(tmp, "skin.fbx")
        seed = str(p.get("seed", 12345))
        run(job, "generate_skeleton.sh", ["--input", mesh, "--output", skeleton, "--seed", seed], "Predicting the skeleton", 0.1)
        if not os.path.exists(skeleton):
            raise RuntimeError("UniRig produced no skeleton (see the worker log)")
        run(job, "generate_skin.sh", ["--input", skeleton, "--output", skin], "Predicting skin weights", 0.5)
        if not os.path.exists(skin):
            raise RuntimeError("UniRig produced no skin weights (see the worker log)")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        run(job, "merge.sh", ["--source", skin, "--target", mesh, "--output", out], "Merging the rig into the mesh", 0.9)
    if not os.path.exists(out):
        raise RuntimeError("UniRig's merge produced no output (see the worker log)")
    return {"mesh": out, "model": "UniRig articulation-xl"}


if __name__ == "__main__":
    serve({"rig": rig})
