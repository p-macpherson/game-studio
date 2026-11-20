"""M5a spike: can a cover of a score loop? Cover a 3-pass render, keep the middle pass, check timing and the seam.

    ACESTEP_CHECKPOINTS_DIR=... <gen>/envs/acestep/bin/python acestep_loop.py <score3.wav> <loop_seconds> <out_dir>
"""
import json
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch
from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.llm_inference import LLMHandler

src, loop_s, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
os.makedirs(out, exist_ok=True)
CAPTION = os.environ.get("CAPTION", "whimsical fantasy adventure game music, playful goblin theme, wooden flute melody, pizzicato and warm strings, light hand percussion, instrumental")
dit = AceStepHandler()
dit.initialize_service(project_root="", config_path="acestep-v15-turbo", device="cuda", offload_to_cpu=True)
llm = LLMHandler()


def onset_env(x: np.ndarray, sr: int, hop: int = 512) -> np.ndarray:
    mono = x.mean(1) if x.ndim > 1 else x
    frames = np.lib.stride_tricks.sliding_window_view(mono, 2048)[::hop]
    mag = np.abs(np.fft.rfft(frames * np.hanning(2048), axis=1))
    flux = np.maximum(np.diff(np.log1p(mag), axis=0), 0).sum(1)
    return (flux - flux.mean()) / (flux.std() + 1e-9)


score, sr = sf.read(src)
n = int(round(loop_s * sr))
for strength in (0.8, 0.6):
    torch.cuda.reset_peak_memory_stats()
    t = time.time()
    p = GenerationParams(task_type="cover", src_audio=src, caption=CAPTION, instrumental=True, lyrics="[Instrumental]", bpm=int(os.environ.get("BPM", "100")),
                         keyscale=os.environ.get("KEY", "D minor"), timesignature="4", thinking=False, seed=7, shift=3.0, audio_cover_strength=strength)
    r = generate_music(dit, llm, p, GenerationConfig(batch_size=1, audio_format="wav"), save_dir=os.path.join(out, f"c{strength}"))
    secs = time.time() - t
    cover, csr = sf.read(r.audios[0]["path"])
    nc = int(round(loop_s * csr))
    mid = cover[nc : 2 * nc]
    sf.write(os.path.join(out, f"loop-{strength}.wav"), mid, csr)
    # Timing: lag (in ms) maximising the onset-envelope correlation with the score's middle pass (resampled to csr).
    ref = score[n : 2 * n].mean(1)
    ref = np.interp(np.linspace(0, len(ref) - 1, nc), np.arange(len(ref)), ref)
    a, b = onset_env(ref, csr), onset_env(mid, csr)
    m = min(len(a), len(b))
    lags = range(-20, 21)
    corr = [float(np.dot(a[max(0, -l) : m - max(0, l)], b[max(0, l) : m - max(0, -l)])) / m for l in lags]
    best = lags[int(np.argmax(corr))]
    # Seam: jump from the loop's last sample to its first, against the typical sample-to-sample step.
    left = mid[:, 0]
    steps = np.abs(np.diff(left))
    rms_end, rms_start = np.sqrt((left[-csr // 10 :] ** 2).mean()), np.sqrt((left[: csr // 10] ** 2).mean())
    print("RESULT", json.dumps({"strength": strength, "seconds": round(secs, 1), "vram_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2),
          "length_s": round(len(cover) / sr, 1), "lag_ms": round(best * 512 / csr * 1000), "onset_corr": round(max(corr), 2),
          "seam_jump": round(float(abs(left[0] - left[-1])), 4), "median_step": round(float(np.median(steps)), 4),
          "p99_step": round(float(np.percentile(steps, 99)), 4), "rms_end_start": [round(float(rms_end), 3), round(float(rms_start), 3)]}))
