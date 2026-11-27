---
name: sound-design
description: Game Studio's sound effect format (assets/sounds/<name>/sound.json), generating takes with Stable Audio Open Small, judging them without listening, variants, loops, synth layers, levels, and live effects (sounds the game changes as it plays). Use whenever making or changing a sound effect.
---
# Sound effects

A sound is `assets/sounds/<name>/sound.json`. **Takes** (`takes/<group>-<seed>.wav`, made by `generate_sound_takes`)
are the raw material. **Variants** are the files the game plays (`<name>.ogg`, `<name>-2.ogg`…; it picks one at
random each time): each mixes its own layers, usually just one take, then the sound's processing. `render_sound`
validates and renders it.

```json
{
  "notes": "Footsteps on the clearing's grass: one per half walk cycle, a random variant each time.",
  "length": 0.3,
  "highpass": 60,
  "variants": [
    {"layers": [{"take": "main-8811"}]},
    {"layers": [{"take": "main-8814"}]},
    {"layers": [{"take": "main-8815"}], "length": 0.25},
    {"layers": [{"take": "main-8817"}, {"take": "twig-402", "gain": -8, "at": 0.02}]}
  ]
}
```

## Fields
| Field | Meaning |
|---|---|
| `variants[].layers` | What the variant mixes: `{"take": "<id>"}` (a take, by the id `generate_sound_takes` gave) or `{"synth": {…}}` |
| `layers[].gain`, `layers[].at` | dB against the variant's other layers (each is levelled first, so 0 means as loud as the others); seconds from the start (takes start at their first sound) |
| synth layer | Nested under `synth`, beside the layer's `gain`/`at`: `{"synth": {"wave": "sine", "seconds": 0.3, "freq": 2600, "to": 3900, "decay": 0.25}, "gain": -18}`. Fields: `wave` (sine, square, saw, triangle, noise), `seconds`, `freq`, `to` (sweep end), `attack`, `decay` (to -60 dB), `vibrato {rate, depth}`, `highpass`, `lowpass` |
| `loop` | A seamless loop: the end is crossfaded into the start (`crossfade` seconds, default a quarter of its length, at most 2) |
| `trim` | Cuts the silence at both ends (quieter than `threshold` dB below the peak, default -50); `false` keeps it |
| `length` | Seconds: cut after this long (after trimming, before the fade-out), e.g. to keep one footstep of a take |
| `pitch` | Semitones, tape-style: down is also longer and darker |
| `highpass`, `lowpass` | Hz: remove rumble below / harshness above |
| `reverb` | 0-1: room reverb, adds a tail |
| `peak` | dBFS after processing (default -1). Every variant is levelled to this; balance sounds in the game with `volume` |
| `fade` | `{in, out}` seconds (default 0.005 and 0.05); not for loops |
| `notes` | What it's for and how the game plays it |
| `live` | How the game changes it while it plays (see "Live effects"): not rendered into the files |

The processing fields (`trim` to `crossfade`) on the sound apply to every variant; the same field on a variant
overrides it for that variant. Each variant renders: layers levelled and mixed, then trim, length, pitch, filters,
reverb, loop, level, fades.

**Keep variants simple.** One good take per variant usually sounds best: a listening test found layered variants
worse than their takes. Layer only for a reason (a whoosh and a separate thud, a quiet synth sparkle on coins), and
keep added layers well below the main one (-8 to -15 dB).

## Prompting the model
Stable Audio Open Small makes up to 11 s of 44.1 kHz stereo; takes cost a fraction of a second, so make 6-8.
- Describe **one** sound: the source and its material, the action, and how it's recorded: "an old wooden chest lid
  creaking open slowly, rusty hinges creak, close-up foley, dry". "Close-up", "dry" and "foley" keep it clean;
  "distant", "in a stone hall" or "outdoors" place it.
- No music words (it drifts into music) and no speech. For exact pitches (chimes, UI tones) use a synth layer.
- Generate a little longer than the sound: trimming removes the silence after it. One-shots 1-4 s, loops 8-11 s.
- "a single X" still often gives two or a noise bed: check `events`, and keep the first one with `length`.

## Judging takes without listening
Each take comes back measured, with an image (waveform over a log-frequency spectrogram, low frequencies at the
bottom; each image stretched to the same width, so read lengths from `seconds`).

| Measurement | Read it as |
|---|---|
| `events` | Separate hits. A footstep or a click should be 1; a creak or a coin pile can be several |
| `attack` | Seconds to reach near its peak: short is a hit, long is a swell or a slow creak |
| `tail` | Seconds it rings out after its last loud part |
| `brightness_hz` | Spectral centroid: low is dull or boomy, high is bright, hissy or metallic |
| `peak_db`, `loudness_db`, `clipped` | A very quiet take (peak below about -25 dBFS) gets noisy when levelled; `clipped` > 0 is distorted |
| `clap`, `off_prompt` | CLAP's match to the prompt. Only flags takes far off it: it does **not** pick the best of good takes |

In the image, tonal sounds (creaks, squeals, chimes) show horizontal lines; noise (rustles, wind, scrapes) shows a
smear; hits show vertical stripes. Pick takes whose shape fits the brief, then let the user listen.

## Variants, loops, levels
- Sounds heard over and over get variants: footsteps 4-6, hits 3-4, one take each. Pick takes with similar
  loudness and brightness, so they sound like the same thing.
- Ambience loops: 8-11 s, `"loop": true`. Avoid takes with a distinctive one-off event (a single loud bird call
  repeats noticeably every loop).
- Everything is levelled to `peak`, so the game sets the balance: roughly footsteps 0.3-0.5, UI 0.5, impacts and
  pickups 0.7-1, ambience 0.3-0.5.

## Synth layers
For tones and accents: a coin's sparkle is two sines a fifth apart (e.g. 1568 and 2349 Hz, the second `at` 0.06,
`decay` 0.4); a UI tick is a square at 1200 Hz for 0.03 s. A UI sound can be synth layers only. Over a generated
take, keep a synth layer quiet (-10 dB or lower): it is levelled like the take, so 0 dB is as loud as the take.

## Live effects
A sound that should change with the game's state (a gun that rises and goes hollow as it heats, an engine hum that
opens up with speed, a voice muffled behind a wall, a radio) is **one dry sound** plus the change, written as
`"live"`: the engine applies pitch and the effects while it plays, between two ends of a 0..1 value in the game.
Don't render a variant per state.

```json
"live": {"value": "heat",
  "at0": {"bandpass": 1200, "resonance": 1, "comb_ms": 4},
  "at1": {"pitch": 1.3, "bandpass": 2700, "resonance": 4, "comb_ms": 4, "comb_feedback": 0.7, "comb_mix": 0.6}}
```

| Field | Meaning |
|---|---|
| `value` | The game's 0..1 value, as named in its code (`heat`, `speed`, `damage`) |
| `at0`, `at1` | The settings at 0 and at 1; each field goes straight between them. Missing is off (pitch 1) |
| `pitch` | Playback speed (0.05-4): 2 is an octave up and half as long |
| `lowpass`, `highpass` | Hz: muffled (behind a wall, underwater: 300-800) / thin (a small speaker: 300-600) |
| `bandpass` | Hz: keep only around it: radio, boxy, tinny |
| `resonance` | 0.1-20: the filters' peak at their frequency; 2-5 sounds resonant, more whistles |
| `comb_ms` | 0.5-20 ms: the hollow, tube-like ring; it rings at 1000/`comb_ms` Hz and its multiples |
| `comb_feedback` | -0.95 to 0.95: how long and strong it rings (negative: odd harmonics only, hollower) |
| `comb_mix` | 0-1: how much of the ring is heard |

- A filter that should come in gradually needs **both ends**: `"lowpass"` 20000 at 0 and 800 at 1 (missing at one
  end means 0, off, and the straight line from 0 is not what you want).
- Keep `comb_ms` the same at both ends unless the ring's note should slide; fade the ring in with `comb_mix` and
  `comb_feedback`.
- The ring and filters stop when the sound ends (no tail). If it should ring on, leave quiet room at the end
  (a longer `length`, a slower `fade.out`).
- `render_sound` previews the first variant at 0, 0.5 and 1 (`live.previews`: measured, and below the variants
  in the picture) and returns the game code (`live.code`). Check the change shows (brightness falling as a
  low-pass closes, peaks appearing for a ring) and give the code to whoever writes the game code.
- The user can try it in the Sound Effects section (Try live effects): sliders, the same effects, and they can
  save their changes into `"live"`.
- At most 32 sounds have effects at once in the game (16 in a web build); after that a sound plays dry. Fine for a
  weapon or an engine, not for every footstep.

## In the game
`engine.play_sound("sounds/<name>/<name>.ogg", volume = 0.5, pitch = 1)` (pick a variant at random and jitter the
pitch by a few percent for repeated sounds); `engine.play_sound_at(path, position)` for sounds in the world; an
`Audio_Source` with `loop` and `autoplay` for an ambience. Tests run with audio off but the engine logs every
sound: `{"cmd": "assert", "sound": "chest-open", "frames": 5}`. With `"live"`: `play_sound(path, pitch = …, effects = {…})`, and for
a sound that keeps playing `set_voice_effects(id, {…})` / `set_voice_pitch(id, …)` every frame, or an `Audio_Source`'s
`effects` (`live.code` from `render_sound` has it written out; the engine's `docs/making-a-game.md`, "Sound effects:
filters and ring").
