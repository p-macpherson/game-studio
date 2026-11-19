"""JSON-lines protocol between Game Studio's generation service and a model worker.

The service writes one request per line to stdin: {"id": ..., "op": "...", "params": {...}}.
The worker answers on stdout, one JSON object per line:
    {"event": "ready"}                                    once, after startup
    {"id": ..., "event": "progress", "message": "...", "fraction": 0.5}
    {"id": ..., "event": "done", "result": {...}}
    {"id": ..., "event": "error", "error": "..."}
Requests are handled one at a time. Anything else a library prints goes to stderr, so stdout stays clean.
This file has no dependencies; every model environment imports it.
"""
import json
import os
import sys
import time
import traceback
from typing import Any, Callable

# Libraries print to stdout freely; keep the real stdout for protocol messages only.
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

GEN = os.environ.get("GAME_STUDIO_GEN", os.path.expanduser("~/.local/share/game-studio/gen"))
MODELS = os.path.join(GEN, "models")


def send(message: dict[str, Any]) -> None:
    _out.write(json.dumps(message) + "\n")
    _out.flush()


class Job:
    def __init__(self, job_id: Any):
        self.id = job_id

    def progress(self, message: str, fraction: float | None = None) -> None:
        send({"id": self.id, "event": "progress", "message": message, "fraction": fraction})


def gpu_peak_gib() -> float | None:
    try:
        import torch

        return round(torch.cuda.max_memory_allocated() / 2**30, 2)
    except Exception:
        return None


def serve(ops: dict[str, Callable[[Job, dict[str, Any]], dict[str, Any]]]) -> None:
    """Runs the request loop. Each op returns its result dict; exceptions become error replies."""
    send({"event": "ready", "ops": sorted(ops)})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        job = Job(req.get("id"))
        op = ops.get(req.get("op"))
        if op is None:
            send({"id": job.id, "event": "error", "error": f"unknown op {req.get('op')!r}"})
            continue
        started = time.time()
        try:
            try:
                import torch

                torch.cuda.reset_peak_memory_stats()
            except Exception:
                pass
            result = op(job, req.get("params") or {})
            result.setdefault("seconds", round(time.time() - started, 1))
            peak = gpu_peak_gib()
            if peak is not None:
                result.setdefault("peak_vram_gib", peak)
            send({"id": job.id, "event": "done", "result": result})
        except Exception as e:  # report and keep serving
            traceback.print_exc()
            send({"id": job.id, "event": "error", "error": f"{type(e).__name__}: {e}"})
