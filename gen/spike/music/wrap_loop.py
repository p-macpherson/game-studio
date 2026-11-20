"""M5a spike: make a seamless loop from a generated 3-pass track (any audio whose bars follow the score's grid).

    python wrap_loop.py <three_pass.wav> <loop_seconds> <out.wav> [fade_ms]

The loop is the middle pass. Its first `fade` samples are crossfaded from the audio that really followed the
middle pass (the start of pass three) into the middle pass's own start, so the jump from the loop's end back
to its start lands on the true continuation.
"""
import sys

import numpy as np
import soundfile as sf

src, loop_s, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
fade_ms = float(sys.argv[4]) if len(sys.argv) > 4 else 150
x, sr = sf.read(src, always_2d=True)
n, f = int(round(loop_s * sr)), int(sr * fade_ms / 1000)
loop = x[n : 2 * n].copy()
t = np.linspace(0, np.pi / 2, f)[:, None]
loop[:f] = x[2 * n : 2 * n + f] * np.cos(t) + loop[:f] * np.sin(t)  # equal-power crossfade
sf.write(out, loop, sr)
left = loop[:, 0]
print(f"seam jump {abs(left[0] - left[-1]):.4f}, median step {np.median(np.abs(np.diff(left))):.4f}, p99 {np.percentile(np.abs(np.diff(left)), 99):.4f}")
