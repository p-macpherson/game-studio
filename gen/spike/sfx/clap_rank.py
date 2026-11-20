"""M7a spike: does CLAP rank takes sensibly? Scores every take in OUT/<model>/ against every prompt.

usage: python clap_rank.py OUT_DIR
"""
import json, os, sys

import soundfile as sf
import torch
import torchaudio
from transformers import ClapModel, ClapProcessor

GEN = os.environ.get("GAME_STUDIO_GEN", os.path.expanduser("~/.local/share/game-studio/gen"))
sys.path.insert(0, os.path.dirname(__file__))
from sao_spike_prompts import SOUNDS  # noqa: E402

out = sys.argv[1]


def emb(x):  # transformers 5 returns an output object whose pooler_output is the projected embedding
	return torch.nn.functional.normalize(x if torch.is_tensor(x) else x.pooler_output, dim=-1)

repo = f"{GEN}/models/laion/larger_clap_general"
model = ClapModel.from_pretrained(repo).to("cuda").eval()
proc = ClapProcessor.from_pretrained(repo)
names = [s[0] for s in SOUNDS]
with torch.no_grad():
	text = emb(model.get_text_features(**proc(text=[s[1] for s in SOUNDS], return_tensors="pt", padding=True).to("cuda")))
report = {}
for m in sorted(d for d in os.listdir(out) if os.path.isdir(f"{out}/{d}") and d != "listen"):
	for f in sorted(os.listdir(f"{out}/{m}")):
		if not f.endswith(".wav"):
			continue
		data, sr = sf.read(f"{out}/{m}/{f}", dtype="float32", always_2d=True)
		mono = torchaudio.functional.resample(torch.from_numpy(data.mean(1)), sr, 48000)
		with torch.no_grad():
			a = emb(model.get_audio_features(**proc(audio=[mono.numpy()], sampling_rate=48000, return_tensors="pt").to("cuda")))
		sims = (a @ text.T)[0].tolist()
		sound = f.rsplit("-", 1)[0]
		report[f"{m}/{f}"] = {"own": round(sims[names.index(sound)], 3), "best_match": names[max(range(len(sims)), key=sims.__getitem__)]}
		print(f"{m}/{f}", report[f"{m}/{f}"], flush=True)
json.dump(report, open(f"{out}/clap.json", "w"), indent=1)
