import { describe, expect, it } from "vitest";
import { parseSong, type Song } from "../../shared/song";
import { barsInSections, recomposeBrief, trackIdFor } from "./info";

// intro (2 bars) A (4) B (2) A (4): bars 1-2, 3-6, 7-8, 9-12.
const SONG: Song = {
	title: "t",
	tempo: 120,
	instruments: { flute: { program: "flute" }, perc: { drums: true } },
	sections: {
		intro: { bars: 2, tracks: { flute: "C5:w | D5:w" } },
		A: { bars: 4, tracks: { flute: "C5:q D5 E5 F5 | G5:w | E5:h C5 | D5:w", perc: "kick:q hat snare hat" } },
		B: { bars: 2, tracks: { flute: "A5:w | G5:w" } },
	},
	arrangement: ["intro", "A", "B", "A"],
};
const timeline = parseSong(SONG).timeline!;

describe("music briefs", () => {
	it("maps piece bars to the sections they fall in", () => {
		expect(barsInSections(timeline, 5, 8)).toEqual([
			{ section: "A", entry: 1, first: 3, last: 4, at: 5 },
			{ section: "B", entry: 2, first: 1, last: 2, at: 7 },
		]);
		expect(barsInSections(timeline, 12, 12)).toEqual([{ section: "A", entry: 3, first: 4, last: 4, at: 12 }]);
	});

	it("tells the composer which section bars to rewrite and that a repeated section shares its pattern", () => {
		const brief = recomposeBrief({ name: "theme", song: SONG, timeline, track: "flute", range: { from: 5, to: 6 }, feedback: "more playful,\nfewer long notes" });
		expect(brief).toContain("assets/music/theme/song.json in bars 5-6 of the piece only");
		expect(brief).toContain('section "A", its bars 3-4 of 4 (piece bar 5-6). "A" also plays at bar 9');
		expect(brief).toContain("write it out in full first");
		expect(brief).toContain("> more playful,\n> fewer long notes");
		expect(recomposeBrief({ name: "theme", song: SONG, timeline, track: "flute", range: { from: 7, to: 7 } })).not.toContain("also plays");
		expect(recomposeBrief({ name: "theme", song: SONG, timeline, track: "perc" })).toContain("whole piece");
	});

	it("names a new track after its instrument without clashing", () => {
		expect(trackIdFor("string ensemble 1", [])).toBe("string-ensemble");
		expect(trackIdFor("flute", ["flute", "flute-2"])).toBe("flute-3");
	});
});
