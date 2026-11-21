"""Voice worker (env: voice): voice-line takes with Qwen3-TTS VoiceDesign (Apache-2.0), each with its voiceprint.

op "voice": {text, instruct, language="English", seeds: [int], out_dir, name}
  -> {takes: [{seed, path, voiceprint}], model}
`instruct` describes the voice and how the line is said; each seed is a fresh performance (and a slightly different
voice). The voiceprint is the speaker embedding of Qwen3-TTS's own speaker encoder (ECAPA-TDNN; it ships only in the
Base model, so setup.sh keeps a copy of just that part): the studio compares voiceprints to tell which takes sound
like the character's other lines.

  voice_worker.py --extract-speaker-encoder <Base model dir> <out dir>     (setup.sh)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from protocol import GEN, MODELS, Job, serve  # noqa: E402

os.environ.setdefault("HF_HOME", os.path.join(GEN, "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch  # noqa: E402

DESIGN = os.path.join(MODELS, "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
SPEAKER = os.path.join(MODELS, "Qwen/Qwen3-TTS-speaker-encoder")
PREFIX = "speaker_encoder."
_model = None
_speaker = None


def extract_speaker_encoder(base_dir: str, out_dir: str) -> None:
    from safetensors import safe_open
    from safetensors.torch import save_file

    os.makedirs(out_dir, exist_ok=True)
    with safe_open(os.path.join(base_dir, "model.safetensors"), "pt") as f:
        save_file({k[len(PREFIX) :]: f.get_tensor(k) for k in f.keys() if k.startswith(PREFIX)}, os.path.join(out_dir, "model.safetensors"))
    config = json.load(open(os.path.join(base_dir, "config.json")))["speaker_encoder_config"]
    json.dump(config, open(os.path.join(out_dir, "config.json"), "w"), indent=1)


def model(job: Job):
    global _model
    if _model is None:
        job.progress("Loading Qwen3-TTS VoiceDesign")
        from qwen_tts import Qwen3TTSModel

        _model = Qwen3TTSModel.from_pretrained(DESIGN, device_map="cuda:0", dtype=torch.bfloat16)
    return _model


def speaker():
    """The speaker encoder alone, or None when it isn't installed (takes then come without voiceprints)."""
    global _speaker
    if _speaker is None and os.path.exists(os.path.join(SPEAKER, "model.safetensors")):
        from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSSpeakerEncoderConfig
        from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSSpeakerEncoder
        from safetensors.torch import load_file

        config = Qwen3TTSSpeakerEncoderConfig(**json.load(open(os.path.join(SPEAKER, "config.json"))))
        encoder = Qwen3TTSSpeakerEncoder(config)
        encoder.load_state_dict(load_file(os.path.join(SPEAKER, "model.safetensors")))
        _speaker = encoder.to("cuda").eval()
    return _speaker


@torch.inference_mode()
def voiceprint(wav, sr: int):
    encoder = speaker()
    if encoder is None:
        return None
    import librosa
    from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram

    audio = wav if sr == 24000 else librosa.resample(wav, orig_sr=sr, target_sr=24000)
    # As Qwen3TTSForConditionalGeneration.extract_speaker_embedding does it.
    mels = mel_spectrogram(torch.from_numpy(audio).float().unsqueeze(0), n_fft=1024, num_mels=128, sampling_rate=24000, hop_size=256, win_size=1024, fmin=0, fmax=12000).transpose(1, 2)
    return [round(float(v), 4) for v in encoder(mels.to("cuda"))[0].float().cpu()]


def voice(job: Job, p: dict) -> dict:
    import soundfile as sf

    m = model(job)
    out_dir, name, seeds = p["out_dir"], p["name"], [int(s) for s in p["seeds"]]
    os.makedirs(out_dir, exist_ok=True)
    takes = []
    for i, seed in enumerate(seeds):
        job.progress(f"Performing take {i + 1} of {len(seeds)}", i / len(seeds))
        torch.manual_seed(seed)
        wavs, sr = m.generate_voice_design(text=p["text"], language=p.get("language") or "English", instruct=p.get("instruct") or "")
        path = os.path.join(out_dir, f"{name}-{seed}.wav")
        sf.write(path, wavs[0], sr, subtype="PCM_16")
        take = {"seed": seed, "path": path}
        print_ = voiceprint(wavs[0], sr)
        if print_ is not None:
            take["voiceprint"] = print_
        takes.append(take)
    return {"takes": takes, "model": "qwen3-tts-12hz-1.7b-voicedesign"}


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--extract-speaker-encoder":
        extract_speaker_encoder(sys.argv[2], sys.argv[3])
    else:
        serve({"voice": voice})
