"""Surface worker (env: image, CPU only): image steps that need no model.

op "surface_make": {source, out_dir, name, normal_strength?, roughness?} -> {files, preview}  (a texture's maps)
op "ui_cut": {images, out_dir, kind, mirror?} -> {candidates, sheet}  (generated UI art cut out; see ui_art.py)
op "ui_make": {source, out_dir, name, kind, slice?} -> {file, slice, preview}
op "particle_cut": {images, out_dir, mode} -> {candidates, sheet}  (generated particle sprites cut out; see particle_art.py)
op "particle_make": {out_dir, name, source? | recipe?} -> {file, flipbook, preview}
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


def ui_cut(job: Job, p: dict) -> dict:
    from ui_art import cut

    job.progress("Cutting out the UI art")
    return cut(p)


def ui_make(job: Job, p: dict) -> dict:
    from ui_art import make

    job.progress("Making the UI art")
    return make(p)


def particle_cut(job: Job, p: dict) -> dict:
    from particle_art import cut

    job.progress("Cutting out the particle sprites")
    return cut(p)


def particle_make(job: Job, p: dict) -> dict:
    from particle_art import make

    job.progress("Making the particle texture")
    return make(p)


if __name__ == "__main__":
    serve({"surface_make": surface_make, "ui_cut": ui_cut, "ui_make": ui_make, "particle_cut": particle_cut, "particle_make": particle_make})
