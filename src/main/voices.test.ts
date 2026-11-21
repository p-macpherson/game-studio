import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenService } from "./gen";
import { tempDir } from "./test-helpers";
import { VoiceError, VoicePipeline } from "./voices";

const has = (cmd: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, cmd)));
let services: GenService[] = [];
const fakeGen = () => {
	const gen = new GenService({ root: tempDir(), codeDir: resolve("gen"), emit: () => {}, fake: true });
	services.push(gen);
	return gen;
};
afterEach(async () => {
	await Promise.all(services.map((s) => s.dispose()));
	services = [];
});

const dirOf = (cwd: string, name: string) => join(cwd, "assets/voices", name);
const voiceJson = (cwd: string, name: string) => JSON.parse(readFileSync(join(dirOf(cwd, name), "voice.json"), "utf8"));

describe.skipIf(!has("ffmpeg"))("VoicePipeline", () => {
	it("performs a new voice's first line, then picks later lines' takes by how well their voice matches", async () => {
		const cwd = tempDir();
		const voices = new VoicePipeline({ gen: fakeGen() });
		await expect(voices.generateTakes({ cwd }, { name: "narrator", line: "intro", text: "Long ago." })).rejects.toThrow(/new voice/);
		const first = await voices.generateTakes({ cwd }, { name: "narrator", line: "intro", text: "Long ago.", direction: "Calm.", voice: "An old man.", count: 2, seed: 11 });
		expect(first.created).toBe(true);
		expect(first.takes.map((t) => [t.id, t.match])).toEqual([["intro-11", undefined], ["intro-12", undefined]]);
		expect(first.chosen).toBe("intro-11");
		expect(existsSync(join(dirOf(cwd, "narrator"), "intro.ogg"))).toBe(true);

		// The fake worker's seed 20 drifts (its voiceprint leans away): it isn't chosen. Against one other line nothing
		// is called drifted; against two it is.
		const second = await voices.generateTakes({ cwd }, { name: "narrator", line: "warning", text: "Run!", count: 3, seed: 20 });
		const byId = Object.fromEntries(second.takes.map((t) => [t.id, t]));
		expect(byId["warning-20"].match).toBeLessThan(0.93);
		expect(byId["warning-20"].drifted).toBeUndefined();
		const third = await voices.generateTakes({ cwd }, { name: "narrator", line: "end", text: "The end.", count: 2, seed: 40 });
		expect(third.takes.map((t) => [t.id, t.drifted])).toEqual([["end-40", true], ["end-41", undefined]]);
		expect(third.chosen).toBe("end-41");
		expect(byId["warning-21"].match).toBeGreaterThan(0.99);
		expect(second.chosen).not.toBe("warning-20");
		expect(voiceJson(cwd, "narrator").lines.map((l: { id: string; take: string }) => [l.id, l.take])).toEqual([["intro", "intro-11"], ["warning", second.chosen], ["end", "end-41"]]);
		expect(voices.takeRecords(cwd, "narrator")["warning-21.wav"]).toMatchObject({ line: "warning", text: "Run!", voice: "An old man.", seed: 21, model: "fake" });

		// More takes of a line that has a current take don't replace the choice.
		const more = await voices.generateTakes({ cwd }, { name: "narrator", line: "warning", count: 1, seed: 31 });
		expect(more.chosen).toBeUndefined();
		expect(more.line.take).toBe(second.chosen);
	}, 30_000);

	it("edits lines: another take, a changed text (outdated until performed again), a removed line", async () => {
		const cwd = tempDir();
		const voices = new VoicePipeline({ gen: fakeGen() });
		await voices.generateTakes({ cwd }, { name: "hero", line: "win", text: "We found it!", voice: "A young woman.", count: 2, seed: 1 });
		await voices.generateTakes({ cwd }, { name: "hero", line: "plea", text: "Please.", count: 1, seed: 6 });
		const dir = dirOf(cwd, "hero");

		const used = await voices.edit({ cwd }, { name: "hero", line: { id: "win", take: "win-2" } });
		expect(used.lines[0]).toMatchObject({ id: "win", take: "win-2", file: "assets/voices/hero/win.ogg" });
		expect(voices.takes(cwd, "hero").rendered).toEqual({ win: "win-2", plea: "plea-6" });
		await expect(voices.edit({ cwd }, { name: "hero", line: { id: "win", take: "win-99" } })).rejects.toThrow(/No take/);

		const changed = await voices.edit({ cwd }, { name: "hero", line: { id: "win", text: "We found all of it!" } });
		expect(changed.lines[0].outdated).toBe(true);
		const again = await voices.generateTakes({ cwd }, { name: "hero", line: "win", count: 1, seed: 40 });
		expect(again.chosen).toBe("win-40"); // the old take is of the old text
		expect(again.line.outdated).toBeUndefined();

		await voices.edit({ cwd }, { name: "hero", remove: "plea" });
		expect(existsSync(join(dir, "plea.ogg"))).toBe(false);
		expect(existsSync(join(dir, "takes/plea-6.wav"))).toBe(false);
		expect(Object.keys(voices.takes(cwd, "hero").records).every((f) => f.startsWith("win-"))).toBe(true);

		writeFileSync(join(dir, "voice.json"), JSON.stringify({ voice: "", lines: [] }));
		await expect(voices.render({ cwd }, { name: "hero" })).rejects.toBeInstanceOf(VoiceError);
	}, 30_000);
});
