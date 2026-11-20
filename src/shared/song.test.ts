import { describe, expect, it } from "vitest";
import { gmProgram, parseSong, pitchOf, type Song } from "./song";

const Q = 480; // ticks per quarter note

function song(over: Partial<Song> = {}): Song {
	return {
		title: "Test",
		tempo: 120,
		instruments: { lead: { program: "flute" }, drums: { drums: true } },
		sections: { A: { bars: 2, tracks: { lead: "C4:q D4 E4:e F4 G4:q | [C4 E4 G4]:h. r:q" } } },
		arrangement: ["A"],
		...over,
	};
}

describe("parseSong", () => {
	it("lays out notes: carried durations, dots, chords, rests, and repeats a short pattern to fill its section", () => {
		const { timeline, errors } = parseSong(
			song({
				sections: {
					A: { bars: 2, tracks: { lead: "C4:q D4 E4:e F4 G4:q | [C4 E4 G4]:h. r:q", drums: "kick:q hat snare hat" } },
					B: { bars: 1, tracks: { lead: "A4:e3 B4 C5 r:q r:h" } },
				},
				arrangement: ["A", "B", "A"],
			}),
		);
		expect(errors).toEqual([]);
		const lead = timeline!.tracks.find((t) => t.id === "lead")!;
		// Bar 1: C D (quarters) E F (eighths) G (quarter); bar 2: a dotted-half chord.
		expect(lead.notes.slice(0, 8).map((n) => [n.tick, n.ticks, n.pitch])).toEqual([
			[0, Q, 60], [Q, Q, 62], [2 * Q, Q / 2, 64], [2.5 * Q, Q / 2, 65], [3 * Q, Q, 67],
			[4 * Q, 3 * Q, 60], [4 * Q, 3 * Q, 64], [4 * Q, 3 * Q, 67],
		]);
		// Section B starts at bar 3 with eighth-note triplets.
		expect(lead.notes.filter((n) => n.tick >= 8 * Q && n.tick < 12 * Q).map((n) => [n.tick, n.ticks])).toEqual([[8 * Q, 160], [8 * Q + 160, 160], [8 * Q + 320, 160]]);
		// The one-bar drum pattern fills section A's two bars, and A plays again after B.
		const drums = timeline!.tracks.find((t) => t.id === "drums")!;
		expect(drums.channel).toBe(9);
		expect(drums.notes.filter((n) => n.pitch === 36).map((n) => n.tick)).toEqual([0, 4 * Q, 12 * Q, 16 * Q]);
		expect(timeline!.sections).toEqual([
			{ name: "A", tick: 0, ticks: 8 * Q },
			{ name: "B", tick: 8 * Q, ticks: 4 * Q },
			{ name: "A", tick: 12 * Q, ticks: 8 * Q },
		]);
		expect(timeline!.seconds).toBe(10); // 20 beats at 120 bpm
	});

	it("ties notes across bar lines, repeats bars with %, and accents", () => {
		const { timeline, errors } = parseSong(song({ sections: { A: { bars: 3, tracks: { lead: "C4:h E4:h~ | E4:q G4! r:h | %" } } } }));
		expect(errors).toEqual([]);
		const notes = timeline!.tracks[0].notes;
		expect(notes.map((n) => [n.tick, n.ticks, n.pitch])).toEqual([
			[0, 2 * Q, 60], [2 * Q, 3 * Q, 64], [5 * Q, Q, 67], [8 * Q, Q, 64], [9 * Q, Q, 67],
		]);
		expect(notes[2].velocity).toBeGreaterThan(notes[1].velocity);
	});

	it("says exactly what's wrong and where", () => {
		const { errors, timeline } = parseSong(
			song({
				instruments: { lead: { program: "flutey thing" }, bass: { program: "string ensemble" }, drums: { drums: true } },
				sections: { A: { bars: 2, tracks: { bass: "C2:q D2 E2 | F2:w", drums: "kick:q boom", ghost: "C4:w" } } },
				arrangement: ["A", "Chorus"],
			}),
		);
		expect(timeline).toBeNull();
		expect(errors).toEqual([
			{ at: "instruments.lead.program", message: expect.stringMatching(/"flutey thing" isn't a General MIDI instrument\. Did you mean "flute"/) },
			{ at: "sections.A.tracks.bass", message: "bar 1 has 3 beats, but a bar is 4" },
			{ at: "sections.A.tracks.drums", message: expect.stringMatching(/^bar 1: "boom" isn't a drum/) },
			{ at: "sections.A.tracks.ghost", message: 'No instrument "ghost" (instruments: lead, bass, drums)' },
			{ at: "arrangement[1]", message: 'No section "Chorus" (sections: A)' },
		]);
		expect(parseSong(song({ sections: { A: { bars: 3, tracks: { lead: "C4:w | D4:w" } } } })).errors[0].message).toMatch(/don't fill the section's 3 bars/);
	});
});

describe("names", () => {
	it("reads pitches and forgiving General MIDI names", () => {
		expect([pitchOf("C4"), pitchOf("F#3"), pitchOf("Bb2"), pitchOf("H4")]).toEqual([60, 54, 46, null]);
		expect([gmProgram("Flute"), gmProgram("string ensemble"), gmProgram("nylon guitar"), gmProgram(200)]).toEqual([73, 48, 24, null]);
	});
});
