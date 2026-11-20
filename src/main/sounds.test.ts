import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeVariants } from "../shared/sound";
import { decodeWav, encodeWav, synth, toDb } from "./audio-dsp";
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

const dirOf = (cwd: string, name: string) => join(cwd, "assets/sounds", name);
const soundJson = (cwd: string, name: string) => JSON.parse(readFileSync(join(dirOf(cwd, name), "sound.json"), "utf8"));
const writeSound = (cwd: string, name: string, sound: unknown) => {
	mkdirSync(dirOf(cwd, name), { recursive: true });
	writeFileSync(join(dirOf(cwd, name), "sound.json"), JSON.stringify(sound));
};

describe.skipIf(!has("ffmpeg"))("SoundPipeline", () => {
	it("generates takes into a new sound, then renders it trimmed, levelled and faded", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		const r = await sounds.generateTakes({ cwd }, { name: "chest-open", prompt: "a chest creaking open", seconds: 1, count: 3, seed: 10 });
		expect(r.created).toBe(true);
		expect(r.takes.map((t) => [t.id, t.file])).toEqual([10, 11, 12].map((s) => [`main-${s}`, `assets/sounds/chest-open/takes/main-${s}.wav`]));
		expect(r.takes[0]).toMatchObject({ seconds: 1, events: 1 });
		expect(r.sheet).toMatch(/^data:image\/png;base64,/);
		expect(soundJson(cwd, "chest-open")).toEqual({ variants: [{ layers: [{ take: "main-10" }] }] });
		expect(sounds.takeRecords(cwd, "chest-open")["main-11.wav"]).toMatchObject({ group: "main", prompt: "a chest creaking open", seed: 11, model: "fake" });

		const out = await sounds.render({ cwd }, { name: "chest-open" });
		expect(out.variants.map((v) => v.file)).toEqual(["assets/sounds/chest-open/chest-open.ogg"]);
		// The take starts with 0.2 s of silence, which is trimmed (5 ms kept); its peak is brought up to -1 dBFS.
		const { left, seconds } = decode(join(dirOf(cwd, "chest-open"), "chest-open.ogg"));
		expect(seconds).toBeGreaterThan(0.7);
		expect(seconds).toBeLessThan(0.82);
		expect(toDb(left.reduce((p, v) => Math.max(p, Math.abs(v)), 0))).toBeCloseTo(-1, 0);
		expect(Math.abs(left[0])).toBeLessThan(0.002); // faded in
		expect(JSON.parse(readFileSync(join(dirOf(cwd, "chest-open"), "render.json"), "utf8"))).toMatchObject({ files: ["chest-open.ogg"] });
	});

	it("renders one file per variant with its own overrides, remakes a missing take, and drops variants it no longer has", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		await sounds.generateTakes({ cwd }, { name: "footstep", prompt: "a footstep on grass", seconds: 0.6, count: 3, seed: 3 });
		rmSync(join(dirOf(cwd, "footstep"), "takes/main-5.wav")); // e.g. a clone without its LFS files
		const variants = composeVariants(["main-3", "main-4", "main-5"], 3, 1);
		writeSound(cwd, "footstep", { variants });
		const r = await sounds.render({ cwd }, { name: "footstep" });
		expect(r.variants.map((v) => v.file.split("/").pop())).toEqual(["footstep.ogg", "footstep-2.ogg", "footstep-3.ogg"]);
		expect(existsSync(join(dirOf(cwd, "footstep"), "takes/main-5.wav"))).toBe(true);

		writeSound(cwd, "footstep", { length: 0.3, variants: [{ ...variants[1], length: 0.25 }] });
		await sounds.render({ cwd }, { name: "footstep" });
		expect(decode(join(dirOf(cwd, "footstep"), "footstep.ogg")).seconds).toBeCloseTo(0.25, 2);
		expect(existsSync(join(dirOf(cwd, "footstep"), "footstep-2.ogg"))).toBe(false);
		expect(existsSync(join(dirOf(cwd, "footstep"), "footstep-3.ogg"))).toBe(false);
	});

	it("levels each layer before its gain, so a quiet take isn't buried under a synth layer", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		// A take as quiet as real ones can be (a 440 Hz tone at -30 dBFS), under noise at -12 dB.
		const takes = join(dirOf(cwd, "hum"), "takes");
		mkdirSync(takes, { recursive: true });
		const tone = synth({ wave: "sine", freq: 440, seconds: 0.5, decay: 60 }).map((v) => v * 10 ** (-30 / 20));
		writeFileSync(join(takes, "main-1.wav"), encodeWav([tone, tone]));
		writeSound(cwd, "hum", { variants: [{ layers: [{ take: "main-1" }, { synth: { wave: "noise", seconds: 0.5 }, gain: -12 }] }] });
		const r = await sounds.render({ cwd }, { name: "hum" });
		expect(r.variants[0].brightness_hz).toBeLessThan(2000); // the tone, not the noise (about 11 kHz)
	});

	it("crossfades a loop's end into its start, so it loops without a jump", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		// 220.5 Hz doesn't fit a whole number of cycles into the loop, so a plain cut would jump.
		writeSound(cwd, "hum", { loop: true, trim: false, variants: [{ layers: [{ synth: { wave: "sine", freq: 220.5, seconds: 2, decay: 60 } }] }] });
		await sounds.render({ cwd }, { name: "hum" });
		const { left, seconds } = decode(join(dirOf(cwd, "hum"), "hum.ogg"));
		expect(seconds).toBeCloseTo(1.5, 1); // the last quarter went into the crossfade
		const steps = left.slice(1).map((v, i) => Math.abs(v - left[i]));
		expect(Math.abs(left[0] - left[left.length - 1])).toBeLessThanOrEqual(Math.max(...steps) * 1.2);
	});

	it("refuses a broken sound with every problem listed", async () => {
		const cwd = tempDir();
		const sounds = new SoundPipeline({ gen: fakeGen() });
		writeSound(cwd, "broken", { reverb: 2, variants: [{ layers: [{ take: "nope" }, { synth: { wave: "sine", seconds: 1 } }], length: -1 }, { layers: [] }] });
		const err = await sounds.render({ cwd }, { name: "broken" }).catch((e) => e);
		expect(err).toBeInstanceOf(SoundError);
		expect(err.message).toBe(
			"sound.json has 5 problem(s):\n" +
				"- reverb: Must be a number from 0 to 1\n" +
				"- variants[0].length: Must be a number from 0.01 to 60 seconds\n" +
				'- variants[0].layers[0].take: A take id like "main-1565909407" (its group and seed)\n' +
				"- variants[0].layers[1].synth.freq: A frequency in Hz\n" +
				"- variants[1].layers: At least one layer: a take or a synth",
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

describe("composeVariants", () => {
	it("makes X variants of Y different takes each, spreading the takes evenly", () => {
		const v = composeVariants(["a-1", "b-2", "c-3"], 3, 2).map((x) => x.layers.map((l) => ("take" in l ? l.take : "")));
		expect(v).toEqual([["a-1", "b-2"], ["c-3", "a-1"], ["b-2", "c-3"]]);
	});
});
