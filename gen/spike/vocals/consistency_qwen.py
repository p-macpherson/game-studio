"""Vocals spike: keeping one voice per character with Qwen3-TTS.

Each character's voice is designed once (a neutral reference clip). Then each line is made three ways:
  design          VoiceDesign again from the same description, with the line's direction (acted, voice may drift)
  clone           the Base model cloning the reference (same voice, no direction)
  clone-directed  the same, with the direction passed as an instruction (not documented for Base: a try)
and consistency_convert.py (Chatterbox env) adds:
  design-converted  the acted "design" clip with its timbre converted to the reference voice
Stage "score" measures how close each clip's voice is to the reference (cosine of the Base model's speaker embeddings).

  python consistency_qwen.py <out-dir> design | clone | score
"""
import html, json, sys, time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

from lines import REFERENCE

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
STAGE = sys.argv[2]

CHARACTERS = {
    "narrator": "An older British man with a deep, warm, slightly gravelly voice; an unhurried storyteller.",
    "hero": "A young woman in her twenties with a clear, bright, energetic voice.",
}
LINES = {
    "narrator": [
        ("1-grave", "Calm, grave narration, slow.", "Long before the first lantern was lit, the forest kept its gold in silence. Nobody came looking. Nobody dared."),
        ("2-sarcasm", "Dry, weary sarcasm, deadpan.", "Oh, wonderful. Another hero. Do try not to die on the doorstep this time."),
        ("3-shout", "Shouting in alarm, urgent, at the top of his voice.", "Run! Run, all of you, the bridge is coming down!"),
        ("4-sad", "Soft and sorrowful, almost to himself.", "And so the lantern went out, and nobody was left to light it."),
    ],
    "hero": [
        ("1-triumph", "Overjoyed and out of breath, shouting with excitement.", "We found it! All of it! I told you the map was real!"),
        ("2-defiant", "Cold, quiet defiance, steady and low.", "I'm not afraid of you. Not anymore."),
        ("3-nervous", "Nervous and uncertain, calling out into an empty room.", "Wait, where did everybody go? Hello?"),
        ("4-pleading", "Pleading, near tears, voice breaking.", "Please. He's all I have left."),
    ],
}
if STAGE == "lines":
    (Path(__file__).parent / "consistency_lines.tsv").write_text("".join(f"{c}\t{lid}\t{d}\t{t}\n" for c, ls in LINES.items() for lid, d, t in ls))
    sys.exit()

METHODS_EXTRA = ["design-seedvc", "design-seedvc-strong", "omni-clone", "omni-from-design"]
METHODS = ["design", "clone", "clone-directed", "xvec-directed", "xvec-directed-hot", "design-converted"] + METHODS_EXTRA


def load(kind):
    return Qwen3TTSModel.from_pretrained(f"Qwen/Qwen3-TTS-12Hz-1.7B-{kind}", device_map="cuda:0", dtype=torch.bfloat16)


def put(name, wav, sr, t):
    sf.write(OUT / name, wav, sr)
    print(f"  {name}  {len(wav) / sr:.1f}s  ({time.time() - t:.1f}s)", flush=True)


if STAGE == "design":
    model = load("VoiceDesign")
    for character, voice in CHARACTERS.items():
        torch.manual_seed(7)
        t = time.time()
        wavs, sr = model.generate_voice_design(text=REFERENCE, language="English", instruct=f"{voice} Neutral, relaxed, conversational.")
        put(f"{character}-voice.wav", wavs[0], sr, t)
        for i, (lid, direction, text) in enumerate(LINES[character]):
            torch.manual_seed(11 + i)
            t = time.time()
            wavs, sr = model.generate_voice_design(text=text, language="English", instruct=f"{voice} {direction}")
            put(f"{character}-{lid}-design.wav", wavs[0], sr, t)

if STAGE == "clone":
    model = load("Base")
    for character in CHARACTERS:
        prompt = model.create_voice_clone_prompt(ref_audio=str(OUT / f"{character}-voice.wav"), ref_text=REFERENCE)
        for i, (lid, direction, text) in enumerate(LINES[character]):
            torch.manual_seed(11 + i)
            t = time.time()
            wavs, sr = model.generate_voice_clone(text=text, language="English", voice_clone_prompt=prompt)
            put(f"{character}-{lid}-clone.wav", wavs[0], sr, t)
            try:
                torch.manual_seed(11 + i)
                t = time.time()
                ids = [model._tokenize_texts([model._build_instruct_text(direction)])[0]]
                wavs, sr = model.generate_voice_clone(text=text, language="English", voice_clone_prompt=prompt, instruct_ids=ids)
                put(f"{character}-{lid}-clone-directed.wav", wavs[0], sr, t)
            except Exception as err:  # the Base model may not take instructions
                print("  clone-directed failed:", repr(err)[:300], flush=True)

if STAGE == "expressive":
    # clone-directed keeps the voice but acts less than "design". A guess at why: cloning continues from the neutral
    # reference clip, prosody included. So: give the model only the voice's embedding (no clip to continue from), with
    # the direction; and the same sampled more freely.
    model = load("Base")
    print("generate defaults:", getattr(model, "generate_defaults", None), flush=True)
    base_temp = float((getattr(model, "generate_defaults", None) or {}).get("temperature", 0.9))
    for character in CHARACTERS:
        prompt = model.create_voice_clone_prompt(ref_audio=str(OUT / f"{character}-voice.wav"), x_vector_only_mode=True)
        for i, (lid, direction, text) in enumerate(LINES[character]):
            ids = [model._tokenize_texts([model._build_instruct_text(direction)])[0]]
            for method, extra in (("xvec-directed", {}), ("xvec-directed-hot", {"temperature": base_temp + 0.3})):
                torch.manual_seed(11 + i)
                t = time.time()
                wavs, sr = model.generate_voice_clone(text=text, language="English", voice_clone_prompt=prompt, instruct_ids=ids, **extra)
                put(f"{character}-{lid}-{method}.wav", wavs[0], sr, t)

if STAGE == "score":
    model = load("Base")
    embed = lambda path: model.create_voice_clone_prompt(ref_audio=str(path), x_vector_only_mode=True)[0].ref_spk_embedding.float().flatten()
    cos = lambda a, b: round(float(torch.nn.functional.cosine_similarity(a, b, dim=0)), 3)
    scores = {}
    for character in CHARACTERS:
        ref = embed(OUT / f"{character}-voice.wav")
        for method in METHODS:
            vals = [cos(ref, embed(f)) for lid, *_ in LINES[character] if (f := OUT / f"{character}-{lid}-{method}.wav").exists()]
            if vals:
                scores[f"{character} / {method}"] = {"mean": round(sum(vals) / len(vals), 3), "min": min(vals), "each": vals}
    other = cos(embed(OUT / "narrator-voice.wav"), embed(OUT / "hero-voice.wav"))
    scores["narrator vs hero reference (two different people)"] = other
    (OUT / "scores.json").write_text(json.dumps(scores, indent=1))
    print(json.dumps(scores, indent=1))
    rows = ["<p>Voice match to the character's reference: 1.0 is the same voice; the two characters' references score %.2f against each other.</p>" % other]
    for character, voice in CHARACTERS.items():
        rows.append(f"<h2>{character}</h2><p>{html.escape(voice)}</p><div><audio controls preload='none' src='{character}-voice.wav'></audio> <b>reference voice</b> (designed once)</div>")
        for lid, direction, text in LINES[character]:
            rows.append(f"<h3>{html.escape(text)} <i>({html.escape(direction)})</i></h3>")
            for method in METHODS:
                if (OUT / f"{character}-{lid}-{method}.wav").exists():
                    rows.append(f"<div><audio controls preload='none' src='{character}-{lid}-{method}.wav'></audio> {method}</div>")
        rows.append("<p>" + " · ".join(f"{m}: match {scores[f'{character} / {m}']['mean']} (worst {scores[f'{character} / {m}']['min']})" for m in METHODS if f"{character} / {m}" in scores) + "</p>")
    (OUT / "index.html").write_text("<meta charset='utf-8'><title>Vocals: one voice per character</title><style>body{font:15px system-ui;max-width:900px;margin:2em auto;background:#16181d;color:#d8dce3}div{display:flex;gap:12px;align-items:center;margin:6px 0}h2{margin-top:2em}h3{font-size:14px;font-weight:500;margin-top:1.5em}audio{height:32px}</style><h1>One voice per character</h1>" + "\n".join(rows))
    print("wrote", OUT / "index.html")
