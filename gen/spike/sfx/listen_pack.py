"""M7a spike: processes takes into a listening pack, plus the loop test and agent-view images.

Each take: leading/trailing silence trimmed (-50 dBFS), peak-normalised to -1 dBFS, 5 ms fade in, 60 ms fade out, OGG.
forest: the best-scoring take of each model wrapped into a seamless loop (its last 2 s crossfaded into its start),
plus -x3 (three times in a row) to hear the seam. Agent view: waveform over spectrogram, one PNG per take.

usage: python listen_pack.py OUT_DIR
"""
import json, os, subprocess, sys

import numpy as np
import soundfile as sf

out = sys.argv[1]
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
clap = json.load(open(f"{out}/clap.json"))
pack = f"{out}/listen"
os.makedirs(pack, exist_ok=True)


def ogg(path, data, sr):
	tmp = path + ".wav"
	sf.write(tmp, data, sr, subtype="PCM_16")
	subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", tmp, "-c:a", "libvorbis", "-q:a", "6", path], check=True)
	os.remove(tmp)


def trim(x, sr, db=-50):
	loud = np.flatnonzero(np.abs(x).max(1) > 10 ** (db / 20))
	return x[max(0, loud[0] - int(0.005 * sr)) : loud[-1] + 1] if len(loud) else x


def fades(x, sr, fin=0.005, fout=0.06):
	x = x.copy()
	a, b = int(fin * sr), min(int(fout * sr), len(x))
	x[:a] *= np.linspace(0, 1, a)[:, None]
	x[len(x) - b :] *= np.linspace(1, 0, b)[:, None]
	return x


rows = []
for key, score in sorted(clap.items()):
	model, f = key.split("/")
	sound, take = f[:-4].rsplit("-", 1)
	x, sr = sf.read(f"{out}/{model}/{f}", dtype="float32", always_2d=True)
	y = trim(x, sr) if sound != "forest" else x
	peak = float(np.abs(y).max())
	y = fades(y / peak * 10 ** (-1 / 20), sr) if sound != "forest" else y / peak * 10 ** (-1 / 20)
	os.makedirs(f"{pack}/{sound}", exist_ok=True)
	name = f"{pack}/{sound}/{model}-take{take}.ogg"
	ogg(name, y, sr)
	# Agent view: waveform above spectrogram.
	img = f"{pack}/{sound}/{model}-take{take}.png"
	subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", name, "-filter_complex",
		"[0:a]asplit[a][b];[a]showwavespic=s=800x120:split_channels=0:colors=0x4ea1ff[w];"
		"[b]showspectrumpic=s=800x240:legend=0:scale=log:fscale=log:color=intensity[s];[w][s]vstack", "-frames:v", "1", img], check=True)
	rows.append({"file": name[len(out) + 1 :], "seconds": round(len(y) / sr, 2), "raw_peak_db": round(20 * np.log10(peak), 1), "clap": score["own"]})

# Seamless ambience loop from each model's best forest take.
for model in ("1.0", "small"):
	best = max((k for k in clap if k.startswith(model + "/forest")), key=lambda k: clap[k]["own"])
	x, sr = sf.read(f"{out}/{best}", dtype="float32", always_2d=True)
	x = x / np.abs(x).max() * 10 ** (-3 / 20)
	F = int(2 * sr)
	loop = x[: len(x) - F].copy()
	ramp = np.linspace(0, 1, F)[:, None]
	loop[:F] = x[:F] * np.sqrt(ramp) + x[len(x) - F :] * np.sqrt(1 - ramp)  # equal-power: the tail fades into the head
	ogg(f"{pack}/forest/{model}-loop.ogg", loop, sr)
	ogg(f"{pack}/forest/{model}-loop-x3.ogg", np.concatenate([loop] * 3), sr)
	rows.append({"file": f"listen/forest/{model}-loop.ogg", "from": best, "seconds": round(len(loop) / sr, 2)})
json.dump(rows, open(f"{pack}/index.json", "w"), indent=1)
print(json.dumps(rows, indent=0))
