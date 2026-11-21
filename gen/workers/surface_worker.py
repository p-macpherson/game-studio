"""Surface worker (env: image, CPU only): the maps of a tileable texture from its chosen candidate.

op "surface_make": {source, out_dir, name, normal_strength?, roughness?} -> {files, preview}
Needs only NumPy and Pillow, so it starts in a moment and runs beside whichever model worker holds the GPU.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from protocol import Job, serve  # noqa: E402


def surface_make(job: Job, p: dict) -> dict:
    from surfaces import make

    job.progress("Normal and roughness maps")
    return make(p)


if __name__ == "__main__":
    serve({"surface_make": surface_make})
