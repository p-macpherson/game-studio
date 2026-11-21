---
name: voice-lines
description: Game Studio's voice format (assets/voices/<name>/voice.json), describing a voice and directing a line for Qwen3-TTS VoiceDesign, reading the voice match, and dealing with a voice that drifts between takes. Use whenever making or changing a character's voice lines.
---
# Voice lines

A character's voice is `assets/voices/<name>/voice.json`. Each **line** has its words and a direction. **Takes**
(`takes/<line>-<seed>.wav`, made by `generate_voice_takes`) are performances of a line; the line's chosen `take` is
rendered to `<line>.ogg`, which the game plays with `engine.play_sound("voices/<name>/<line>.ogg")`.

```json
{
	"voice": "An older British man with a deep, warm, slightly gravelly voice; an unhurried storyteller.",
	"notes": "The narrator: heard over the title screen and the ending.",
	"lines": [
		{"id": "intro", "text": "Long before the first lantern was lit, the forest kept its gold in silence.", "direction": "Calm, grave narration, slow.", "take": "intro-812"},
		{"id": "warning", "text": "Run! Run, all of you, the bridge is coming down!", "direction": "Shouting in alarm, urgent, at the top of his voice."}
	]
}
```

| Field | |
|---|---|
| `voice` | Who is speaking, in one or two sentences. Fixed for the character |
| `language` | Default `"English"` |
| `notes` | Who the character is, where the lines play (for people; the model doesn't see it) |
| `lines[].id` | lower-kebab-case; names the file. Game code refers to it: don't rename |
| `lines[].text` | The words, at most 600 characters. Longer speeches: several lines |
| `lines[].direction` | How this line is said |
| `lines[].take` | The chosen take's id (`<line>-<seed>`). The tools set it; change it to choose another |

## How takes are made
The model (Qwen3-TTS VoiceDesign) is given `voice` + `direction` as one instruction and performs the text. There is
no stored voice: every take is a new speaker invented from the description. That is why the acting is good (the
performance isn't tied to a neutral reference recording) and why **the voice drifts**: two takes are two slightly
different people. The studio's answer is to generate several takes and keep the ones that sound like the same person.

## Describing a voice
Say what a casting note would: age, gender, accent, the physical sound of the voice, and a word or two of character.

- Good: "A burly man in his thirties with a rough, loud, commanding voice."
- Good: "An elderly woman with a soft, worn voice."
- Too thin ("a male voice"): every take will be a different man.
- Don't put a mood in the voice ("an angry old man"): moods belong in directions, or every line comes out angry.

The more specific the description, the less the voice drifts. Write it once and leave it: changing it outdates every
line, and all of them must be performed again.

## Directing a line
One or two short sentences about delivery: emotion, energy, pace, volume, who it's said to.

- "Dry, weary sarcasm, deadpan."
- "Frightened and hushed, almost whispering, voice shaking, pleading at the end."
- "Overjoyed and out of breath, shouting with excitement."

Extreme directions (shouting, whispering, sobbing) drift the most, since a shouted voice shares less with a calm one.
Expect to need more takes for them. Punctuation in the text also steers the read: "Run! Run, all of you" is performed
differently from "Run, run, all of you."

## Reading the results
You can't listen. `generate_voice_takes` and `render_voice` return, per take or line:

| | |
|---|---|
| `match` | How close the take's voice measures to the character's *other* chosen lines: 1 = identical. Absent for a voice's first line |
| `drifted` | match below 0.93 against two or more other lines: plainly not the same person |
| `outdated` | The chosen take was performed from an earlier text, direction or voice |
| `seconds` | Speech runs at roughly 2.5 words a second. Much shorter: words were dropped. Much longer: a ramble or a long silence |
| `peak_db`, `loudness_db`, `clipped` | Levels; a shout that clipped should be redone |

**The match is weak evidence.** Measured on real takes, a character's own takes score 0.94-0.99 against its other
lines (mean 0.97), but another character's takes score 0.90-0.99 (mean 0.95), and two men's voices are nearly
indistinguishable by it. A shouted or whispered line scores lower than a calm one from the very same voice. So:

- Use it to **compare takes of one line** (prefer the higher) and to catch a voice that is plainly someone else.
- Don't treat a good match as proof the voice is right, and never report "the voice is consistent" from it.
- It says nothing about the acting. Only the user's ears settle either question: ask them to listen.

## Working order
1. The **first line sets the voice**: make it a calm, typical line for the character, generate 4-6 takes, and ask the
   user to pick the one that *is* the character (`open_in_studio`). Everything after is matched against it.
2. Then the other lines, 4 takes each. The tool picks the best match.
3. For a line whose chosen take is `drifted`: `generate_voice_takes` again (new seeds, up to 8). After two more
   rounds, soften the direction a little, or tell the user that this line is the nearest you could get.
4. When the user says a line doesn't sound like the character, the same: more takes of that line, and let them pick.
5. Never change `voice` to fix one line.
