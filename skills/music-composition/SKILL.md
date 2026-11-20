---
name: music-composition
description: Writing and editing the game's music as Game Studio song scores (assets/music/<name>/song.json): the format, General MIDI instruments and drums, and how to compose loopable game music. Use whenever creating or changing music.
---
# Game Studio songs

A piece of music is `assets/music/<name>/song.json`, a multi-track score. `render_song` validates it and renders
`<name>.ogg` (FluidSynth with the GeneralUser GS General MIDI SoundFont), which the game plays with
`engine.play_music("music/<name>/<name>.ogg")`. Commit `song.json`, the `.ogg` and `render.json` together.

## The format
```json
{
  "title": "Goblin Gold",
  "tempo": 104,
  "meter": [4, 4],
  "key": "D dorian",
  "loop": true,
  "style": "whimsical folk adventure, wooden flute, pizzicato strings, light hand percussion",
  "instruments": {
    "melody": { "program": "flute", "volume": 0.8, "pan": 0.1, "reverb": 0.35 },
    "pluck":  { "program": "pizzicato strings", "volume": 0.6, "pan": -0.3 },
    "bass":   { "program": "acoustic bass", "volume": 0.75 },
    "drums":  { "drums": true, "volume": 0.6 }
  },
  "sections": {
    "intro": { "bars": 2, "tracks": { "pluck": "D3:e A3 D4 A3 F3 A3 D4 A3 | C3:e G3 C4 G3 E3 G3 C4 G3" } },
    "A": {
      "bars": 4,
      "tracks": {
        "melody": "A4:q D5:e E5 F5:q E5 | D5:q. C5:e A4:h | G4:q C5:e D5 E5:q G5 | F5:h. r:q",
        "pluck": "[D3 F3 A3]:q r [D3 F3 A3] r | [C3 E3 G3]:q r [C3 E3 G3] r",
        "bass": "D2:q. D2:e A2:h | C2:q. C2:e G2:h",
        "drums": "kick:e hat snare:e hat kick:e kick hat:e snare?"
      }
    }
  },
  "arrangement": ["intro", "A", "A"]
}
```
- `tempo` is quarter notes per minute; `meter` is `[beats, unit]` (default `[4, 4]`; `[3, 4]`, `[6, 8]` work).
- `instruments`: track id → `program` (a General MIDI name, see below, or 0-127), or `drums: true` for a drum
  kit. Optional `volume` 0-1 (0.8), `pan` -1..1 (0), `reverb` 0-1 (0.3). At most 15 melodic tracks plus drums.
- `sections`: name → `bars` and each track's **pattern**. A track left out of a section is silent there.
- `arrangement`: section names in playing order; repeat a name to repeat the section.
- `loop` (default true): rendered so the end flows seamlessly into the start. Set false for a stinger or an
  ending that should ring out.
- `style`: a short description of the intended sound, used when a produced version is made from the score.

## Patterns
A pattern is a string of notes. `|` separates bars; each bar must add up to exactly one bar (4 beats in 4/4).
| Write | Means |
|---|---|
| `C4` `F#3` `Bb2` | A pitch: note name, optional `#`/`b`, octave (C4 is middle C) |
| `:w :h :q :e :s :t` | Duration: whole, half, quarter, eighth, sixteenth, thirty-second |
| `:q.` `:e.` | Dotted (1.5x) |
| `:e3` | Triplet (2/3 length): three `:e3` notes fill one quarter |
| `[D3 F3 A3]:h` | A chord |
| `r:q` | A rest |
| `D5:q!` / `D5:q?` | Accented (louder) / soft (ghost note) |
| `D5:h~ \| D5:q` | Tie: the note carries on into the next note of the same pitch |
| `%` | Repeat the previous bar |

- **A duration carries over**: `C4:e D4 E4 F4` is four eighths. Give it on the first note and when it changes.
- **Patterns repeat to fill their section**: a 1-bar drum groove in an 8-bar section plays 8 times. A pattern's
  length must divide the section's bars.
- A pattern without `|` is fine for short grooves, but it must still add up to whole bars.
- Drum tracks use drum names instead of pitches: `kick kick2 snare snare2 rim clap hat pedalhat openhat crash
  crash2 ride ridebell splash china tom1`…`tom6` (high to low) `tambourine cowbell shaker cabasa claves woodblock
  woodblock2 triangle opentriangle bongo bongo2 conga conga2 congamute timbale timbale2 agogo agogo2 guiro
  whistle vibraslap chimes castanets sticks`. Chords work: `[kick crash]:q`.

## General MIDI instruments (GeneralUser GS)
Names are forgiving about case, punctuation and partial words ("string ensemble", "nylon guitar").
- Keys: acoustic grand piano, bright acoustic piano, electric piano 1/2, harpsichord, clavinet, celesta,
  glockenspiel, music box, vibraphone, marimba, xylophone, tubular bells, dulcimer
- Organs and reeds: drawbar organ, rock organ, church organ, reed organ, accordion, harmonica
- Guitars: acoustic guitar nylon/steel, electric guitar jazz/clean/muted, overdriven guitar, distortion guitar
- Basses: acoustic bass, electric bass finger/pick, fretless bass, slap bass 1, synth bass 1/2
- Strings: violin, viola, cello, contrabass, tremolo strings, pizzicato strings, orchestral harp, timpani,
  string ensemble 1/2, synth strings 1, choir aahs, voice oohs
- Brass: trumpet, trombone, tuba, muted trumpet, french horn, brass section
- Woodwinds: soprano/alto/tenor/baritone sax, oboe, english horn, bassoon, clarinet, piccolo, flute, recorder,
  pan flute, shakuhachi, whistle, ocarina
- Synths: lead 1 square, lead 2 sawtooth, lead 3 calliope, pad 1 new age, pad 2 warm, pad 3 polysynth,
  pad 4 choir, pad 7 halo, pad 8 sweep, fx 4 atmosphere, fx 7 echoes
- World: sitar, banjo, shamisen, koto, kalimba, bagpipe, fiddle, steel drums, woodblock, taiko drum

## Composing game music
- **Read the design docs** for the game's mood, setting and where the piece plays (exploration, menu, combat,
  victory). Agree the brief with the user (`ask_user`): mood, tempo feel, instruments, length.
- **Loops**: background music loops. Make the last bar lead back into the first (end on the dominant or with a
  pickup), avoid a big ending, and keep the first beat from sounding like a fresh start. 16-32 bars at a moderate
  tempo is 30-70 s, plenty for a loop; give it at least two contrasting sections (A and B) so it doesn't wear thin.
- **Arrange in layers**: bass on the root and fifth, a harmony layer (chords, arpeggios or pads), one clear
  melody, light percussion. Leave space: not every track plays in every section.
- **Ranges that sound good**: bass C2-C3, chords and pads C3-C5, melody C4-C6, flute and piccolo above C5.
  Keep simultaneous chord notes in different tracks out of each other's way.
- **Velocity matters**: `!` on downbeats and phrase peaks, `?` for ghost notes on hi-hats and inner voices.
- **Check your work with `render_song`**: you can't listen, so compare its summary (bars per section, length in
  seconds, note counts, ranges) with your intent, then tell the user to listen in the Music section.
- **Render after the edit has finished**, never in the same batch of tool calls as the edit: tools in one batch
  can run at the same time, and the render may read the old score. If the summary's sections or length don't
  match your change, render again.
- Edit one section at a time; keep section and track names stable so the user's view stays familiar.
