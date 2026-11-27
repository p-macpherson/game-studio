import { describe, expect, it } from "vitest";
import { emptyEnds, LIVE_PRESETS, type LiveEnds, liveAt, liveCode } from "./live-effects";

const ends = (set: Partial<Record<keyof LiveEnds, [string, string]>>): LiveEnds => ({ ...emptyEnds(), ...set });

describe("live effects", () => {
	it("goes straight between the two ends; blank is off (pitch 1)", () => {
		const e = ends({ pitch: ["", "1.3"], bandpass: ["1200", "2700"], comb_mix: ["", "0.6"], comb_ms: ["4", "4"] });
		expect(liveAt(e, 0)).toEqual({ pitch: 1, effects: { bandpass: 1200, comb_ms: 4 } });
		const half = liveAt(e, 0.5);
		expect(half.pitch).toBeCloseTo(1.15);
		expect(half.effects).toEqual({ bandpass: 1950, comb_ms: 4, comb_mix: 0.3 });
		expect(liveAt(emptyEnds(), 0.7)).toEqual({ pitch: 1, effects: {} });
	});

	it("writes the play_sound call the preview plays", () => {
		const e = ends({ pitch: ["", "1.3"], lowpass: ["20000", "800"], comb_ms: ["4", "4"], comb_mix: ["", "0.6"] });
		expect(liveCode(e, "sounds/laser/laser.ogg", "heat", false)).toBe(
			[
				"// heat: 0..1, from the game",
				'engine.play_sound("sounds/laser/laser.ogg", pitch = 1 + heat * 0.3, effects = {',
				"\tlowpass = 20000 - heat * 19200,",
				"\tcomb_ms = 4,",
				"\tcomb_mix = heat * 0.6,",
				"})",
			].join("\n"),
		);
		// Nothing changing: constants, no variable
		expect(liveCode(ends({ highpass: ["400", "400"] }), "sounds/a/a.ogg", "heat", false)).toBe('engine.play_sound("sounds/a/a.ogg", effects = {\n\thighpass = 400,\n})');
		expect(liveCode(emptyEnds(), "sounds/a/a.ogg", "heat", false)).toBe('engine.play_sound("sounds/a/a.ogg")');
	});

	it("changes a loop while it plays", () => {
		const code = liveCode(ends({ lowpass: ["600", "3000"] }), "sounds/hum/hum.ogg", "speed", true);
		expect(code).toContain('id := engine.play_sound("sounds/hum/hum.ogg", effects = {\n\tlowpass = 600 + speed * 2400,\n})');
		expect(code).toContain("engine.set_voice_effects(id, {\n\tlowpass = 600 + speed * 2400,\n})");
		expect(code).not.toContain("set_voice_pitch");
	});

	it("presets keep the ring's note fixed (its delay at both ends)", () => {
		for (const p of LIVE_PRESETS) if (p.at1.comb_ms) expect(p.at0?.comb_ms).toBe(p.at1.comb_ms);
	});
});
