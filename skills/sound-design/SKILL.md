---
name: sound-design
description: Game Studio's sound effect format (assets/sounds/<name>/sound.json), generating takes with Stable Audio Open Small, judging them without listening, variants, loops, synth layers and levels. Use whenever making or changing a sound effect.
---
# Sound effects

A sound is `assets/sounds/<name>/sound.json`: layers are mixed (each at its `at` offset and `gain`), then
processed into one OGG per variant. `render_sound` validates and renders it; `generate_sound_takes` makes takes.

```json
{
  "notes": "Footsteps on the clearing's grass: one per half walk cycle, a random variant each time.",
  "layers": [
    {"generate": {"prompt": "a single footstep on soft grass and dirt, close-up foley, dry", "seconds": 1.5}, "takes": [8811, 8814, 8815, 8817]},
    {"synth": {"wave": "noise", "seconds": 0.04, "lowpass": 900}, "gain": -18}
  ],
  "highpass": 60,
  "fade": {"out": 0.08}
}
```

## Fields
| Field | Meaning |
|---|---|
| `layers[].generate` | `{prompt, seconds}`: a generated layer (Stable Audio Open Small, up to 11 s) |
| `layers[].takes` | The takes used, by seed: one per variant, or one for every variant. The variant count is the longest list |
| `layers[].synth` | `{wave (sine, square, saw, triangle, noise), seconds, freq, to (sweep end), attack, decay (to -60 dB), vibrato {rate, depth}, highpass, lowpass}` |
| `layers[].name` | Names a generated layer's takes (`takes/<name>-<seed>.wav`); default "main". Two generated layers need different names |
| `layers[].gain`, `layers[].at` | dB (default 0); seconds from the start (default 0) |
| `loop` | A seamless loop: the end is crossfaded into the start (`crossfade` seconds, default a quarter of its length, at most 2) |
| `trim` | Cuts the silence at both ends (quieter than `threshold` dB below the peak, default -50); `false` keeps it |
| `pitch` | Semitones, tape-style: down is also longer and darker |
| `highpass`, `lowpass` | Hz: remove rumble below / harshness above |
| `reverb` | 0-1: room reverb, adds a tail |
| `peak` | dBFS after processing (default -1). Every sound is levelled to this; balance sounds in the game with `volume` |
| `fade` | `{in, out}` seconds (default 0.005 and 0.05); not for loops |
| `notes` | What it's for and how the game plays it |

Processing runs in this order: mix, trim, pitch, filters, reverb, loop, level, fades.

## Prompting the model
Stable Audio Open Small makes up to 11 s of 44.1 kHz stereo; takes cost a fraction of a second, so make 6-8.
- Describe **one** sound: the source and its material, the action, and how it's recorded: "an old wooden chest lid
  creaking open slowly, rusty hinges creak, close-up foley, dry". "Close-up", "dry" and "foley" keep it clean;
  "distant", "in a stone hall" or "outdoors" place it.
- No music words (it drifts into music) and no speech. For exact pitches (chimes, UI tones) use a synth layer.
- Generate a little longer than the sound: trimming removes the silence after it. One-shots 1-4 s, loops 8-11 s.
- "a single X" still often gives two or a noise bed: check `events`.

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
- Sounds heard over and over get variants: footsteps 4-6, hits 3-4. Pick takes with similar loudness and brightness,
  so they sound like the same thing.
- Ambience loops: 8-11 s, `"loop": true`. Avoid takes with a distinctive one-off event (a single loud bird call
  repeats noticeably every loop).
- Everything is levelled to `peak`, so the game sets the balance: roughly footsteps 0.3-0.5, UI 0.5, impacts and
  pickups 0.7-1, ambience 0.3-0.5.

## Synth layers
For tones and accents: a coin's sparkle is two sines a fifth apart (e.g. 1568 and 2349 Hz, the second `at` 0.06,
`decay` 0.4); a UI tick is a square at 1200 Hz for 0.03 s; a whoosh is noise swept by its filters. Layer a quiet
synth over a generated take to add brightness or a clear start.

## In the game
`engine.play_sound("sounds/<name>/<name>.ogg", volume = 0.5, pitch = 1)` (pick a variant at random and jitter the
pitch by a few percent for repeated sounds); `engine.play_sound_at(path, position)` for sounds in the world; an
`Audio_Source` with `loop` and `autoplay` for an ambience. Tests run with audio off but the engine logs every
sound: `{"cmd": "assert", "sound": "chest-open", "frames": 5}`.
