"""M7a spike: Stable Audio Open 1.0 vs Small on Goblin Gold's sounds (takes, seconds per take, VRAM).

usage: python sao_spike.py {1.0|small} OUT_DIR [TAKES]
Weights in $GEN/models/stabilityai/stable-audio-open-{1.0,small}; t5-base comes through HF_HOME.
"""
import json, os, sys, time

import soundfile as sf
import torch
from stable_audio_tools.inference.generation import generate_diffusion_cond
from stable_audio_tools.models.factory import create_model_from_config
from stable_audio_tools.models.utils import load_ckpt_state_dict

sys.path.insert(0, os.path.dirname(__file__))
from sao_spike_prompts import SOUNDS  # noqa: E402

GEN = os.environ.get("GAME_STUDIO_GEN", os.path.expanduser("~/.local/share/game-studio/gen"))
# Each model's recommended sampler settings (model cards).
SETTINGS = {
	"1.0": dict(steps=100, cfg_scale=7.0, sampler_type="dpmpp-3m-sde", sigma_min=0.3, sigma_max=500),
	"small": dict(steps=8, cfg_scale=1.0, sampler_type="pingpong"),
}

which, out = sys.argv[1], sys.argv[2]
takes = int(sys.argv[3]) if len(sys.argv) > 3 else 4
os.makedirs(out, exist_ok=True)
root = f"{GEN}/models/stabilityai/stable-audio-open-{which}"
t0 = time.time()
config = json.load(open(f"{root}/model_config.json"))
model = create_model_from_config(config)
model.load_state_dict(load_ckpt_state_dict(f"{root}/model.safetensors"))
model = model.to("cuda").eval().requires_grad_(False)
if which == "1.0":
	model = model.half()
sr, max_size = config["sample_rate"], config["sample_size"]
load_s = time.time() - t0
results = []
for name, prompt, seconds in SOUNDS:
	seconds = min(seconds, max_size / sr - 0.5)
	# Generate only as much audio as needed (a multiple of the autoencoder's 2048-sample stride).
	size = min(max_size, int((seconds + 0.5) * sr) // 2048 * 2048 + 2048)
	torch.cuda.reset_peak_memory_stats()
	torch.cuda.synchronize()
	t = time.time()
	audio = generate_diffusion_cond(
		model,
		conditioning=[{"prompt": prompt, "seconds_start": 0, "seconds_total": seconds}] * takes,
		batch_size=takes,
		sample_size=size,
		seed=1234,
		device="cuda",
		**SETTINGS[which],
	)
	torch.cuda.synchronize()
	elapsed = time.time() - t
	peak = torch.cuda.max_memory_allocated() / 2**30
	audio = audio.float().clamp(-1, 1).cpu()
	for i in range(takes):
		clip = audio[i, :, : int(seconds * sr)].T.numpy()
		sf.write(f"{out}/{name}-{i + 1}.wav", clip, sr, subtype="PCM_16")
	results.append({"sound": name, "prompt": prompt, "seconds": seconds, "takes": takes, "batch_s": round(elapsed, 2), "peak_gb": round(peak, 2)})
	print(json.dumps(results[-1]), flush=True)
json.dump({"model": which, "load_s": round(load_s, 1), "results": results}, open(f"{out}/timings.json", "w"), indent=1)
