import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWav, toDb } from "./audio-dsp";
import { GenService } from "./gen";
import { generationRequests, ModelPipeline } from "./models";
import { SessionService } from "./sessions";
import { SoundError, SoundPipeline } from "./sounds";
import { inProcessHost, makeRepo, tempDir, waitFor } from "./test-helpers";

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

/** Decodes an OGG to float samples (left channel). */
function decode(file: string): { left: number[]; seconds: number } {
	const wav = join(tempDir(), "decoded.wav");
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-c:a", "pcm_s16le", wav]);
	const { audio, rate } = decodeWav(readFileSync(wav));
	return { left: Array.from(audio[0]), seconds: audio[0].length / rate };
}

const soundJson = (cwd: string, name: string) => JSON.parse(readFileSync(join(cwd, "assets/sounds", name, "sound.json"), "utf8"));
const writeSound = (cwd: string, name: string, sound: unknown) => {
	mkdirSync(join(cwd, "assets/sounds", name), { recursive: true });
	writeFileSync(join(cwd, "assets/sounds", name, "sound.json"), JSON.stringify(sound));
};

describe.skipIf(!has("ffmpeg"))("SoundPipeline", () => {
	it("generates takes into a new sound, then renders it trimmed, levelled and faded", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		const r = await sounds.generateTakes({ cwd }, { name: "chest-open", prompt: "a chest creaking open", seconds: 1, count: 3, seed: 10 });
		expect(r.created).toBe(true);
		expect(r.takes.map((t) => [t.seed, t.file])).toEqual([10, 11, 12].map((s) => [s, `assets/sounds/chest-open/takes/main-${s}.wav`]));
		expect(r.takes[0]).toMatchObject({ seconds: 1, events: 1 });
		expect(r.sheet).toMatch(/^data:image\/png;base64,/);
		expect(soundJson(cwd, "chest-open")).toEqual({ layers: [{ generate: { prompt: "a chest creaking open", seconds: 1 }, takes: [10] }] });
		expect(sounds.takeRecords(cwd, "chest-open")["main-11.wav"]).toMatchObject({ layer: "main", prompt: "a chest creaking open", seed: 11, model: "fake" });

		const out = await sounds.render({ cwd }, { name: "chest-open" });
		expect(out.variants.map((v) => v.file)).toEqual(["assets/sounds/chest-open/chest-open.ogg"]);
		// The take starts with 0.2 s of silence, which is trimmed (5 ms kept); its peak is brought up to -1 dBFS.
		const { left, seconds } = decode(join(cwd, "assets/sounds/chest-open/chest-open.ogg"));
		expect(seconds).toBeGreaterThan(0.7);
		expect(seconds).toBeLessThan(0.82);
		expect(toDb(left.reduce((p, v) => Math.max(p, Math.abs(v)), 0))).toBeCloseTo(-1, 0);
		expect(Math.abs(left[0])).toBeLessThan(0.002); // faded in
		expect(JSON.parse(readFileSync(join(cwd, "assets/sounds/chest-open/render.json"), "utf8"))).toMatchObject({ files: ["chest-open.ogg"] });
	});

	it("renders one file per variant, generates takes it doesn't have, and removes variants it no longer has", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		const footstep = { layers: [{ generate: { prompt: "a footstep on grass", seconds: 0.6 }, takes: [3, 4, 5] }, { synth: { wave: "noise", seconds: 0.05 }, gain: -20 }] };
		writeSound(cwd, "footstep", footstep);
		const r = await sounds.render({ cwd }, { name: "footstep" });
		expect(r.variants.map((v) => v.file.split("/").pop())).toEqual(["footstep.ogg", "footstep-2.ogg", "footstep-3.ogg"]);
		expect(existsSync(join(cwd, "assets/sounds/footstep/takes/main-5.wav"))).toBe(true);

		writeSound(cwd, "footstep", { ...footstep, layers: [{ ...footstep.layers[0], takes: [4] }] });
		await sounds.render({ cwd }, { name: "footstep" });
		expect(existsSync(join(cwd, "assets/sounds/footstep/footstep.ogg"))).toBe(true);
		expect(existsSync(join(cwd, "assets/sounds/footstep/footstep-2.ogg"))).toBe(false);
		expect(existsSync(join(cwd, "assets/sounds/footstep/footstep-3.ogg"))).toBe(false);
	});

	it("crossfades a loop's end into its start, so it loops without a jump", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		// 220.5 Hz doesn't fit a whole number of cycles into the loop, so a plain cut would jump.
		writeSound(cwd, "hum", { loop: true, trim: false, layers: [{ synth: { wave: "sine", freq: 220.5, seconds: 2, decay: 60 } }] });
		await sounds.render({ cwd }, { name: "hum" });
		const { left, seconds } = decode(join(cwd, "assets/sounds/hum/hum.ogg"));
		expect(seconds).toBeCloseTo(1.5, 1); // the last quarter went into the crossfade
		const steps = left.slice(1).map((v, i) => Math.abs(v - left[i]));
		expect(Math.abs(left[0] - left[left.length - 1])).toBeLessThanOrEqual(Math.max(...steps) * 1.2);
	});

	it("refuses a broken sound with every problem listed", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		writeSound(cwd, "broken", { layers: [{ generate: { prompt: "a door", seconds: 20 } }, { synth: { wave: "sine", seconds: 1 } }], reverb: 2 });
		const err = await sounds.render({ cwd }, { name: "broken" }).catch((e) => e);
		expect(err).toBeInstanceOf(SoundError);
		expect(err.message).toBe(
			"sound.json has 4 problem(s):\n" +
				"- reverb: Must be a number from 0 to 1\n" +
				"- layers[0].generate.seconds: Must be a number from 0.1 to 11 seconds (the model's limit)\n" +
				"- layers[0].takes: Pick at least one take by its seed (generate_sound_takes lists them)\n" +
				"- layers[1].synth.freq: A frequency in Hz",
		);
		await expect(sounds.render({ cwd }, { name: "../x" })).rejects.toThrow(/lower-kebab-case/);
	});

	it("serves an agent's generate_sound_takes in its session's worktree", async () => {
		const root = tempDir();
		const project = makeRepo(join(root, "game"), { "README.md": "game" });
		const gen = fakeGen();
		const sessions = new SessionService({
			host: await inProcessHost(join(root, "pi")),
			settings: () => ({ engineRepo: join(root, "x"), studioRepo: join(root, "x"), worktreeRoot: join(root, "wt"), recentProjects: [] }),
			projectPath: () => project,
			agentTypes: () => [{ id: "sound-designer", name: "Sound", description: "", targets: ["project"], skills: [], prompt: "", source: "builtin" }],
			skillsDir: join(root, "skills"),
			emit: () => {},
			...generationRequests(new ModelPipeline(gen), gen, { sounds: new SoundPipeline({ gen }) }),
		});
		try {
			const prompt = 'tool generate_sound_takes {"name": "gold", "prompt": "coins clinking", "seconds": 1, "count": 2}';
			const s = await sessions.create({ agentType: "sound-designer", target: "project", model: "faux/echo", prompt });
			await waitFor(() => sessions.get(s.id).status === "idle", 20_000);
			expect(existsSync(join(s.worktreePath, "assets/sounds/gold/sound.json"))).toBe(true);
			expect(existsSync(join(project, "assets/sounds/gold"))).toBe(false);
			expect(JSON.stringify((await sessions.messages(s.id)).at(-1))).toContain("brightness_hz");
		} finally {
			sessions.dispose();
		}
	}, 30_000);
});
