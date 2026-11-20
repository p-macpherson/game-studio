"""Audio worker (env: stable-audio): sound effect takes with Stable Audio Open Small, scored with CLAP.

op "sound": {prompt, seconds (<= 11), seeds: [int], out_dir, name="main"}
  -> {takes: [{seed, path, clap}], model}
Each take is generated on its own with its seed, so a take can be made again from its seed. CLAP (LAION
larger_clap_general) scores how well each take matches the prompt; a listening test showed it doesn't rank good
takes like a person does, so the studio only uses it to flag takes far below the rest of their batch.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from protocol import GEN, MODELS, Job, serve  # noqa: E402

# The model's T5 text encoder is loaded by name ("t5-base"): setup.sh downloads it into the studio's cache.
os.environ.setdefault("HF_HOME", os.path.join(GEN, "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402

SAO = os.path.join(MODELS, "stabilityai/stable-audio-open-small")
CLAP = os.path.join(MODELS, "laion/larger_clap_general")
_model = None
_clap = None


def model(job: Job):
    global _model
    if _model is None:
        job.progress("Loading Stable Audio Open Small")
        from stable_audio_tools.models.factory import create_model_from_config
        from stable_audio_tools.models.utils import load_ckpt_state_dict

        config = json.load(open(os.path.join(SAO, "model_config.json")))
        m = create_model_from_config(config)
        m.load_state_dict(load_ckpt_state_dict(os.path.join(SAO, "model.safetensors")))
        _model = (m.to("cuda").eval().requires_grad_(False), config)
    return _model


def clap(job: Job):
    global _clap
    if _clap is None:
        job.progress("Loading CLAP")
        from transformers import ClapModel, ClapProcessor

        _clap = (ClapModel.from_pretrained(CLAP).to("cuda").eval(), ClapProcessor.from_pretrained(CLAP))
    return _clap


def embedding(x):  # transformers 5 returns an output object whose pooler_output is the projected embedding
    return torch.nn.functional.normalize(x if torch.is_tensor(x) else x.pooler_output, dim=-1)


def sound(job: Job, p: dict) -> dict:
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    m, config = model(job)
    sr, max_size = config["sample_rate"], config["sample_size"]
    seconds = min(float(p["seconds"]), max_size / sr - 0.3)
    # Only as much audio as needed: a multiple of the autoencoder's 2048-sample stride, with a little room.
    size = min(max_size, int((seconds + 0.3) * sr) // 2048 * 2048 + 2048)
    out_dir, name, seeds = p["out_dir"], p.get("name", "main"), [int(s) for s in p["seeds"]]
    os.makedirs(out_dir, exist_ok=True)
    takes = []
    for i, seed in enumerate(seeds):
        job.progress(f"Generating take {i + 1} of {len(seeds)}", i / len(seeds))
        audio = generate_diffusion_cond(
            m,
            conditioning=[{"prompt": p["prompt"], "seconds_start": 0, "seconds_total": seconds}],
            steps=8,
            cfg_scale=1.0,
            sampler_type="pingpong",
            sample_size=size,
            seed=seed,
            device="cuda",
        )
        clip = audio[0, :, : int(seconds * sr)].float().clamp(-1, 1).cpu()
        path = os.path.join(out_dir, f"{name}-{seed}.wav")
        sf.write(path, clip.T.numpy(), sr, subtype="PCM_16")
        takes.append({"seed": seed, "path": path, "clip": clip})

    job.progress("Scoring takes against the prompt", 0.95)
    cm, proc = clap(job)
    with torch.no_grad():
        text = embedding(cm.get_text_features(**proc(text=[p["prompt"]], return_tensors="pt", padding=True).to("cuda")))
        for t in takes:
            mono = torchaudio.functional.resample(t.pop("clip").mean(0), sr, 48000).numpy()
            a = embedding(cm.get_audio_features(**proc(audio=[mono], sampling_rate=48000, return_tensors="pt").to("cuda")))
            t["clap"] = round(float((a @ text.T)[0, 0]), 4)
    return {"takes": takes, "model": "stable-audio-open-small"}


if __name__ == "__main__":
    serve({"sound": sound})
