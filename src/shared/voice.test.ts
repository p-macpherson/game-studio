import { describe, expect, it } from "vitest";
import { formatVoice, parseVoice, takeIsCurrent, type Voice, validateVoice, voiceMatches } from "./voice";

const voice: Voice = {
	voice: "An old man.",
	lines: [
		{ id: "intro", text: "Long ago.", direction: "Calm.", take: "intro-1" },
		{ id: "warning", text: "Run!", take: "warning-7" },
		{ id: "end", text: "The end." },
	],
};

describe("voice.json", () => {
	it("round-trips, one line per line", () => {
		const text = formatVoice(voice);
		expect(parseVoice(text)).toEqual({ voice, problems: [] });
		expect(text.split("\n").filter((l) => l.includes('"id"'))).toHaveLength(3);
	});

	it("lists what's wrong", () => {
		const problems = validateVoice({ voice: "", lines: [{ id: "Bad Id", text: "x" }, { id: "a", text: "" }, { id: "a", text: "y", take: "b-1" }] });
		expect(problems.map((p) => p.at)).toEqual(["voice", "lines[0]", "lines[1]", "lines[2]", "lines[2]"]);
		expect(parseVoice("{").voice).toBeNull();
	});

	it("knows a take made from an earlier text, direction or voice", () => {
		const record = { line: "intro", text: "Long ago.", direction: "Calm.", voice: "An old man.", language: "English", seed: 1, model: "m", at: "" };
		expect(takeIsCurrent(voice, voice.lines[0], record)).toBe(true);
		expect(takeIsCurrent(voice, voice.lines[0], { ...record, direction: "Angry." })).toBe(false);
		expect(takeIsCurrent({ ...voice, voice: "A young man." }, voice.lines[0], record)).toBe(false);
	});

	it("matches each take against the other lines' chosen takes", () => {
		const prints = { "intro-1": [1, 0], "warning-7": [1, 0.1], "warning-8": [0, 1], "end-3": [1, 0.05] };
		const m = voiceMatches(voice, prints);
		expect(m["warning-7"]).toBeGreaterThan(0.99); // against intro-1
		expect(m["warning-8"]).toBe(0);
		expect(m["intro-1"]).toBeGreaterThan(0.99); // against warning-7 (end has no chosen take)
		expect(m["end-3"]).toBeGreaterThan(0.99); // against both
		// One line with a take: nothing to compare it with.
		expect(voiceMatches({ voice: "x", lines: [voice.lines[0]] }, prints)).toEqual({});
	});
});
