"""The vocals spike's test lines and its listening page, shared by the model scripts."""
import html, json

REFERENCE = "The path runs along the river for a mile or so, then turns north through the pines. Most travellers stop at the old mill to rest before the climb, and I would suggest you do the same."

# Character voices: Kokoro voice ids (a = American, b = British).
VOICES = {"narrator": "bm_george", "merchant": "bm_lewis", "guard": "am_michael", "scout": "af_bella", "widow": "bf_emma", "hero": "af_heart"}

# (id, character, direction, text, exaggeration, cfg_weight, text for Turbo with tags or None)
LINES = [
    ("01-narration", "narrator", "calm, grave narration", "Long before the first lantern was lit, the forest kept its gold in silence. Nobody came looking. Nobody dared.", 0.4, 0.5, None),
    ("02-merchant", "merchant", "cheerful, a bit sly", "Ah, a customer! Come in, come in. Mind the barrel, it bites.", 0.7, 0.4, "Ah, a customer! Come in, come in. Mind the barrel, [chuckle] it bites."),
    ("03-guard-shout", "guard", "angry shout", "Stop right there! Drop the chest, now, or I call the whole watch down on you!", 1.0, 0.3, None),
    ("04-scout-fear", "scout", "frightened, hushed", "Did you hear that? Something's in the trees. Please, don't leave me here.", 0.6, 0.3, "[gasp] Did you hear that? Something's in the trees. Please, don't leave me here."),
    ("05-widow-grief", "widow", "quiet grief", "He promised he'd come back before winter. I kept the lantern lit every night. Every single night.", 0.5, 0.4, "[sigh] He promised he'd come back before winter. I kept the lantern lit every night. Every single night."),
    ("06-hero-triumph", "hero", "overjoyed", "We found it! All of it! I told you the map was real!", 0.9, 0.3, "We found it! All of it! [laugh] I told you the map was real!"),
    ("07-narrator-sarcasm", "narrator", "dry sarcasm", "Oh, wonderful. Another hero. Do try not to die on the doorstep this time.", 0.6, 0.5, None),
]


def write_page(OUT, clips):
    """Merges these clips with those of earlier runs (clips.json) and writes index.html."""
    record = OUT / "clips.json"
    known = {c["file"]: c for c in (json.loads(record.read_text()) if record.exists() else [])}
    known.update({c["file"]: c for c in clips})
    record.write_text(json.dumps(sorted(known.values(), key=lambda c: c["file"]), indent=1))
    rows = []
    for lid, character, direction, text, *_ in LINES:
        rows.append(f"<h2>{html.escape(lid)} · {character} · <i>{html.escape(direction)}</i></h2><p>{html.escape(text)}</p>")
        for c in sorted((c for c in known.values() if c["line"] == lid), key=lambda c: c["file"]):
            note = f" · <code>{html.escape(c['text'])}</code>" if c["text"] != text else ""
            rows.append(f"<div><audio controls preload='none' src='{c['file']}'></audio> {html.escape(c['model'])} · {c['seconds']}s{note}</div>")
    rows.append("<h2>Reference voices (Kokoro, neutral)</h2>" + "".join(f"<div><audio controls preload='none' src='ref-{c}.wav'></audio> {c} ({v})</div>" for c, v in VOICES.items()))
    (OUT / "index.html").write_text("<meta charset='utf-8'><title>Vocals spike</title><style>body{font:15px system-ui;max-width:860px;margin:2em auto;background:#16181d;color:#d8dce3}div{display:flex;gap:12px;align-items:center;margin:6px 0}h2{font-size:16px;margin-top:2em}audio{height:32px}</style><h1>Vocals spike</h1>" + "\n".join(rows))
    print("wrote", OUT / "index.html")
