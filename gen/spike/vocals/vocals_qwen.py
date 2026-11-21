"""Vocals spike, Qwen3-TTS VoiceDesign (Apache-2.0): each line spoken by a voice described in words, directed in words.

  HF_HOME=~/.local/share/game-studio/gen/hf ~/.local/share/game-studio/gen/envs/vocals-spike-qwen/bin/python vocals_qwen.py <out-dir>
"""
import sys, time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

from lines import LINES, write_page

OUT = Path(sys.argv[1])

CHARACTERS = {
    "narrator": "An older British man with a deep, warm, slightly gravelly voice; an unhurried storyteller.",
    "merchant": "A middle-aged Englishman with a bright, reedy voice; a sly, talkative travelling merchant.",
    "guard": "A burly man in his thirties with a rough, loud, commanding voice.",
    "scout": "A young woman with a light, breathy voice.",
    "widow": "An elderly woman with a soft, worn voice.",
    "hero": "A young woman in her twenties with a clear, bright, energetic voice.",
}
DIRECTIONS = {
    "01-narration": "Calm, grave narration, slow, with weight on the last two short sentences.",
    "02-merchant": "Cheerful and welcoming, then a sly, amused warning on the last sentence.",
    "03-guard-shout": "Shouting in anger across a courtyard, urgent and threatening.",
    "04-scout-fear": "Frightened and hushed, almost whispering, voice shaking, pleading at the end.",
    "05-widow-grief": "Quiet grief, holding back tears, slow, the voice nearly breaking on the last sentence.",
    "06-hero-triumph": "Overjoyed and out of breath, shouting with excitement, laughing with relief.",
    "07-narrator-sarcasm": "Dry, weary sarcasm, deadpan, unimpressed.",
}

model = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0", dtype=torch.bfloat16)
clips = []
for lid, character, direction, text, *_ in LINES:
    instruct = f"{CHARACTERS[character]} {DIRECTIONS[lid]}"
    for take in (1, 2):
        torch.manual_seed(100 * take + int(lid[:2]))
        t = time.time()
        wavs, sr = model.generate_voice_design(text=text, language="English", instruct=instruct)
        name = f"{lid}-qwen3-design-take{take}.wav"
        sf.write(OUT / name, wavs[0], sr)
        took = time.time() - t
        clips.append({"file": name, "seconds": round(len(wavs[0]) / sr, 2), "line": lid, "character": character, "direction": direction, "model": f"Qwen3-TTS VoiceDesign, take {take} · “{instruct}”", "text": text, "took": took})
        print(f"  {name}  {len(wavs[0]) / sr:.1f}s  ({took:.1f}s to make)", flush=True)
print(f"   {torch.cuda.max_memory_allocated() / 2**30:.1f} GB peak")
write_page(OUT, clips)
