import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenService } from "./gen";
import { generationRequests, ModelPipeline } from "./models";
import { MusicPipeline, readWav, SongError, songHash } from "./music";
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
