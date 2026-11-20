"""M5a spike: ACE-Step 1.5 (turbo DiT, no LM) on the 3080. Text-to-music, and covers of a FluidSynth-rendered score.

    ACESTEP_CHECKPOINTS_DIR=<gen>/models/ACE-Step/Ace-Step1.5 <gen>/envs/acestep/bin/python acestep_spike.py <score.wav> <out_dir>
"""
import json
import os
import sys
import time

import torch
from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.llm_inference import LLMHandler

score, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
CAPTION = "whimsical fantasy adventure game music, playful goblin theme, wooden flute melody, pizzicato and warm strings, light hand percussion, instrumental"

t = time.time()
dit = AceStepHandler()
status, ok = dit.initialize_service(project_root="", config_path="acestep-v15-turbo", device="cuda", offload_to_cpu=False)
print("init", ok, status[:200].replace("\n", " "), f"{time.time() - t:.1f}s")
llm = LLMHandler()  # not initialised: DiT only


def run(name: str, **kw) -> None:
    torch.cuda.reset_peak_memory_stats()
    t = time.time()
    params = GenerationParams(caption=CAPTION, instrumental=True, lyrics="[Instrumental]", bpm=100, keyscale="D minor", timesignature="4",
                              thinking=False, seed=7, shift=3.0, **kw)
    result = generate_music(dit, llm, params, GenerationConfig(batch_size=1, audio_format="wav"), save_dir=os.path.join(out, name))
    info = {"name": name, "ok": result.success, "error": result.error, "seconds": round(time.time() - t, 1),
            "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2), "files": [a["path"] for a in result.audios] if result.success else []}
    print("RESULT", json.dumps(info))


run("text2music", duration=30)
run("cover-0.8", task_type="cover", src_audio=score, audio_cover_strength=0.8)
run("cover-0.5", task_type="cover", src_audio=score, audio_cover_strength=0.5)
