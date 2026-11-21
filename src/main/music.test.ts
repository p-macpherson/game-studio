import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenService } from "./gen";
import { generationRequests, ModelPipeline } from "./models";
import { MusicPipeline, readWav, SongError, songHash, toMidi } from "./music";
import { parseSong } from "../shared/song";
import { SessionService } from "./sessions";
import { inProcessHost, makeRepo, tempDir, waitFor } from "./test-helpers";

const soundfont = process.env.GAME_STUDIO_SOUNDFONT ?? join(homedir(), ".local/share/game-studio/gen/models/soundfonts/GeneralUser-GS.sf2");
const has = (cmd: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, cmd)));
const canRender = has("fluidsynth") && has("ffmpeg") && existsSync(soundfont);

const SONG = {
	title: "Loop test",
	tempo: 120,
	instruments: { pad: { program: "string ensemble 1", reverb: 0.8 }, lead: { program: "flute" }, drums: { drums: true } },
	sections: {
		A: { bars: 2, tracks: { pad: "[D3 F3 A3]:w | [C3 E3 G3]:w", lead: "A4:q D5 F5 A5 | G5:h E5", drums: "kick:q hat snare hat" } },
	},
	arrangement: ["A", "A"],
};

/** Each MIDI track's notes as [tick, on/off, pitch, velocity] (the writer never uses running status). */
function midiNotes(midi: Uint8Array): [number, "on" | "off", number, number][][] {
	const tracks: [number, "on" | "off", number, number][][] = [];
	let i = 14;
	while (i < midi.length) {
		const end = i + 8 + ((midi[i + 4] << 24) | (midi[i + 5] << 16) | (midi[i + 6] << 8) | midi[i + 7]);
		const notes: [number, "on" | "off", number, number][] = [];
		let tick = 0;
		i += 8;
		while (i < end) {
			let d = 0;
			do d = (d << 7) | (midi[i] & 0x7f);
			while (midi[i++] & 0x80);
			tick += d;
			const s = midi[i];
			if (s === 0xff) i += 3 + midi[i + 2];
			else if ((s & 0xf0) === 0xc0) i += 2;
			else {
				if ((s & 0xf0) === 0x90) notes.push([tick, "on", midi[i + 1], midi[i + 2]]);
				if ((s & 0xf0) === 0x80) notes.push([tick, "off", midi[i + 1], 0]);
				i += 3;
			}
		}
		tracks.push(notes);
	}
	return tracks;
}

describe("toMidi humanizing", () => {
	const fast = { title: "t", tempo: 120, instruments: { lead: { program: "flute" } }, sections: { A: { bars: 1, tracks: { lead: "A4:s A4 A4 A4 A4 A4 A4 A4 C5:q D5" } } }, arrangement: ["A", "A"] };
	const notesOf = (song: object, passes: number) => {
		const { song: s, timeline } = parseSong(song);
		return midiNotes(toMidi(s!, timeline!, passes))[1];
	};

	it("nudges notes off the grid but never starts one before the same pitch has ended", () => {
		const notes = notesOf({ ...fast, humanize: 1 }, 3);
		expect(notes.filter(([, kind]) => kind === "on").some(([tick]) => tick % 120 !== 0)).toBe(true);
		const sounding = new Map<number, boolean>();
		for (const [, kind, pitch] of notes) {
			if (kind === "on") expect(sounding.get(pitch), `pitch ${pitch} restarted while sounding`).not.toBe(true);
			sounding.set(pitch, kind === "on");
		}
		expect(notesOf({ ...fast, humanize: 0 }, 1).every(([tick]) => tick % 120 === 0)).toBe(true);
	});

	it("plays every pass of a loop the same way", () => {
		const { timeline } = parseSong(fast);
		const total = timeline!.totalTicks;
		const ons = notesOf({ ...fast, humanize: 1 }, 3).filter(([, kind]) => kind === "on");
		const pass = (p: number) => ons.filter(([tick]) => tick >= p * total - 20 && tick < (p + 1) * total - 20).map(([tick, , pitch, v]) => [tick - p * total, pitch, v]);
		expect(pass(2)).toEqual(pass(1));
		expect(pass(1).length).toBe(timeline!.tracks[0].notes.length);
	});
});

describe.skipIf(!canRender)("MusicPipeline", () => {
	it("renders a song to an OGG that is exactly one loop long and loops without a jump", async () => {
		const cwd = tempDir();
		const dir = join(cwd, "assets/music/loop-test");
		mkdirSync(dir, { recursive: true });
		const text = JSON.stringify(SONG, null, 2);
		writeFileSync(join(dir, "song.json"), text);
		const music = new MusicPipeline({ soundfont: () => soundfont });
		const r = await music.render({ cwd }, { name: "loop-test" });
		expect(r).toMatchObject({ ogg: "assets/music/loop-test/loop-test.ogg", seconds: 8, loop: true, sections: [{ name: "A", bars: 2 }, { name: "A", bars: 2 }] });
		expect(r.tracks.map((t) => [t.id, t.instrument])).toEqual([["pad", "string ensemble 1"], ["lead", "flute"], ["drums", "drums"]]);
		expect(JSON.parse(readFileSync(join(dir, "render.json"), "utf8"))).toMatchObject({ song: songHash(text), loop: true });

		// Decode it: 8 s (16 beats at 120 bpm). The loop starts on a kick, as bar 2 does at 2 s: the jump from the last
		// sample back to the first must look like any kick's attack, not a cut (the start carries the end's tails).
		const wav = join(cwd, "decoded.wav");
		execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "loop-test.ogg"), "-c:a", "pcm_s16le", wav]);
		const pcm = readWav(readFileSync(wav));
		expect(pcm.frames / pcm.rate).toBeCloseTo(8, 2);
		const left = Array.from({ length: pcm.frames }, (_, i) => pcm.data.readInt16LE(i * 4));
		const seam = Math.abs(left[0] - left[left.length - 1]);
		const bar2 = 2 * pcm.rate;
		const kickSteps = left.slice(bar2 - 220, bar2 + 220).map((v, i, a) => (i ? Math.abs(v - a[i - 1]) : 0));
		expect(seam).toBeLessThanOrEqual(Math.max(...kickSteps));
		// The reverb tail is there at the start: the first 50 ms aren't silent even though the pad re-attacks.
		const rms = Math.sqrt(left.slice(0, pcm.rate / 20).reduce((s, v) => s + v * v, 0) / (pcm.rate / 20));
		expect(rms).toBeGreaterThan(200);
	}, 60_000);

	it("plays the song in its space: a hall rings on where a dry render stops", async () => {
		const cwd = tempDir();
		const tailRms = async (space: string) => {
			const dir = join(cwd, "assets/music", space);
			mkdirSync(dir, { recursive: true });
			const song = { title: space, tempo: 120, loop: false, space, humanize: 0, instruments: { keys: { program: "marimba", reverb: 1 } }, sections: { A: { bars: 1, tracks: { keys: "C5:q r:q r:h" } } }, arrangement: ["A"] };
			writeFileSync(join(dir, "song.json"), JSON.stringify(song));
			await new MusicPipeline({ soundfont: () => soundfont }).render({ cwd }, { name: space });
			const wav = join(cwd, `${space}.wav`);
			execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, `${space}.ogg`), "-c:a", "pcm_s16le", wav]);
			const pcm = readWav(readFileSync(wav));
			// 1.2-1.7 s: the marimba note (0-0.5 s) has died away by then; a hall is still sounding.
			const from = Math.round(1.2 * pcm.rate);
			const n = Math.round(0.5 * pcm.rate);
			let sum = 0;
			for (let i = from; i < from + n; i++) sum += pcm.data.readInt16LE(i * 4) ** 2;
			return Math.sqrt(sum / n);
		};
		const [dry, hall] = [await tailRms("dry"), await tailRms("hall")];
		expect(hall).toBeGreaterThan(dry * 1.5); // the same with no reverb at all
	}, 60_000);

	it("renders each track as a stem, one loop long, together as loud as the mix, once per score", async () => {
		const cwd = tempDir();
		const dir = join(cwd, "assets/music/stem-test");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "song.json"), JSON.stringify(SONG));
		const music = new MusicPipeline({ soundfont: () => soundfont });
		await music.edit({ cwd }, { name: "stem-test", space: "hall", humanize: 0.2 });
		expect(JSON.parse(readFileSync(join(dir, "song.json"), "utf8"))).toMatchObject({ space: "hall", humanize: 0.2 });
		const cache = tempDir();
		const stems = await music.stems({ cwd }, "stem-test", cache);
		expect(stems.map((s) => s.track)).toEqual(["pad", "lead", "drums"]);
		const seconds = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }));
		for (const s of stems) expect(seconds(s.file)).toBeCloseTo(8, 1);
		// Integrated loudness (LUFS) from ffmpeg's ebur128 summary.
		const loud = (args: string[]) => {
			const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats ${args.map((a) => `'${a}'`).join(" ")} -f null - 2>&1 | grep -E '^\\s+I:' | tail -1`], { encoding: "utf8" });
			return Number(/(-?[\d.]+) LUFS/.exec(out)?.[1]);
		};
		const mix = loud(["-i", join(dir, "stem-test.ogg"), "-af", "ebur128"]);
		const together = loud([...stems.flatMap((s) => ["-i", s.file]), "-filter_complex", `${stems.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${stems.length}:normalize=0,ebur128`]);
		expect(Math.abs(together - mix)).toBeLessThan(1.5); // 2.9 LU off without the mix's level applied
		// The same score: the same files, not rendered again.
		const before = statSync(stems[0].file).mtimeMs;
		expect(await music.stems({ cwd }, "stem-test", cache)).toEqual(stems);
		expect(statSync(stems[0].file).mtimeMs).toBe(before);
	}, 120_000);

	it("previews any General MIDI instrument or the drum kit as a short OGG", async () => {
		const music = new MusicPipeline({ soundfont: () => soundfont });
		const cache = tempDir();
		for (const instrument of ["cello", "drums"]) {
			const ogg = await music.preview(instrument, cache);
			expect(ogg.subarray(0, 4).toString("ascii")).toBe("OggS");
		}
		await expect(music.preview("kazoo", cache)).rejects.toThrow(/isn't a General MIDI instrument/);
	}, 60_000);

	it("refuses a broken score with every problem listed", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, "assets/music/broken"), { recursive: true });
		writeFileSync(join(cwd, "assets/music/broken/song.json"), JSON.stringify({ ...SONG, arrangement: ["A", "B"] }));
		const music = new MusicPipeline({ soundfont: () => soundfont });
		const err = await music.render({ cwd }, { name: "broken" }).catch((e) => e);
		expect(err).toBeInstanceOf(SongError);
		expect(err.message).toBe('song.json has 1 problem(s):\n- arrangement[1]: No section "B" (sections: A)');
		await expect(music.render({ cwd }, { name: "../x" })).rejects.toThrow(/lower-kebab-case/);
	});

	it("serves an agent's render_song in its session's worktree", async () => {
		const root = tempDir();
		const project = makeRepo(join(root, "game"), { "assets/music/loop-test/song.json": JSON.stringify(SONG) });
		const gen = new GenService({ root: tempDir(), codeDir: join(process.cwd(), "gen"), emit: () => {}, fake: true });
		const sessions = new SessionService({
			host: await inProcessHost(join(root, "pi")),
			settings: () => ({ engineRepo: join(root, "x"), studioRepo: join(root, "x"), worktreeRoot: join(root, "wt"), recentProjects: [] }),
			projectPath: () => project,
			agentTypes: () => [{ id: "music-composer", name: "Music", description: "", targets: ["project"], skills: [], prompt: "", source: "builtin" }],
			skillsDir: join(root, "skills"),
			emit: () => {},
			...generationRequests(new ModelPipeline(gen), gen, { music: new MusicPipeline({ soundfont: () => soundfont }) }),
		});
		try {
			const s = await sessions.create({ agentType: "music-composer", target: "project", model: "faux/echo", prompt: 'tool render_song {"name": "loop-test"}' });
			await waitFor(() => sessions.get(s.id).status === "idle", 20_000);
			expect(existsSync(join(s.worktreePath, "assets/music/loop-test/loop-test.ogg"))).toBe(true);
			expect(existsSync(join(project, "assets/music/loop-test/loop-test.ogg"))).toBe(false);
			const reply = JSON.stringify((await sessions.messages(s.id)).at(-1));
			expect(reply).toContain("string ensemble 1");
		} finally {
			sessions.dispose();
			await gen.dispose();
		}
	}, 30_000);
});
