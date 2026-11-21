// Voice lines. A character's voice lives in assets/voices/<name>/:
//   voice.json           the voice (a description) and its lines (src/shared/voice.ts): the asset
//   <line>.ogg           what the game plays for a line: its chosen take, trimmed and levelled
//   takes/               generated takes, <line>-<seed>.wav; takes.json (how each was made) and voiceprints.json
//                        (each take's speaker embedding, for the voice match)
//   render.json          which take each line's OGG was made from, so a stale one shows
// Takes come from Qwen3-TTS VoiceDesign on the GPU (the generation service's "voice" job): the voice description plus
// the line's direction, a fresh performance per seed. The voice drifts a little between takes, so each take gets a
// match against the character's other chosen lines: a rough guide for choosing among takes, and a flag for a voice
// that is plainly someone else.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_NAME } from "../shared/asset-names";
import {
	isDrifted,
	formatVoice,
	instructOf,
	languageOf,
	LINE_ID,
	lineFile,
	matchReferences,
	parseVoice,
	takeIsCurrent,
	type Voice,
	type VoiceLine,
	type VoiceProblem,
	type VoiceTakeRecord,
	validateVoice,
	voiceMatches,
	voiceTakeId,
} from "../shared/voice";
import { safeJoin } from "./assets";
import type { Measurements } from "./audio-dsp";
import { type AudioRun, inlineAudio } from "./audio-runner";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export const VOICES_DIR = "assets/voices";

export interface VoiceTakeInfo extends Measurements {
	id: string;
	file: string;
	/** How close its voice is to the character's other chosen lines (1 = the same); absent for a voice's first line. */
	match?: number;
	/** Its voice is plainly not the character's (see DRIFTED in shared/voice.ts): generate again or pick another. */
	drifted?: boolean;
}

export interface VoiceLineInfo extends Partial<Measurements> {
	id: string;
	/** Repo-relative OGG; absent while the line has no take. */
	file?: string;
	take?: string;
	match?: number;
	drifted?: boolean;
	/** The chosen take was made from an earlier text, direction or voice. */
	outdated?: boolean;
}

/** What the section needs beside voice.json: every take's record and match, and what each OGG was rendered from. */
export interface VoiceTakes {
	records: Record<string, VoiceTakeRecord>;
	matches: Record<string, number>;
	/** Per line: how many other lines its takes are matched against. */
	references: Record<string, number>;
	rendered: Record<string, string>;
}

export class VoiceError extends Error {
	constructor(readonly problems: VoiceProblem[]) {
		super(`voice.json has ${problems.length} problem(s):\n${problems.map((p) => `- ${p.at ? `${p.at}: ` : ""}${p.message}`).join("\n")}`);
	}
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback);
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);

export class VoicePipeline {
	constructor(private readonly deps: { gen: GenService; ffmpeg?: string; audio?: AudioRun }) {}

	private get audio(): AudioRun {
		return this.deps.audio ?? inlineAudio;
	}

	dir(cwd: string, name: string): string {
		if (!ASSET_NAME.test(name)) throw new Error(`A voice's name is lower-kebab-case, with "/" for folders (e.g. "narrator", "villagers/merchant"), not "${name}"`);
		return safeJoin(cwd, `${VOICES_DIR}/${name}`);
	}

	private read(cwd: string, name: string): Voice {
		const file = join(this.dir(cwd, name), "voice.json");
		if (!existsSync(file)) throw new Error(`No ${VOICES_DIR}/${name}/voice.json yet: generate a line's takes (with the voice's description) or write it first`);
		const { voice, problems } = parseVoice(readFileSync(file, "utf8"));
		if (!voice) throw new VoiceError(problems);
		return voice;
	}

	private write(cwd: string, name: string, voice: Voice): void {
		const problems = validateVoice(voice);
		if (problems.length) throw new VoiceError(problems);
		mkdirSync(this.dir(cwd, name), { recursive: true });
		writeFileSync(join(this.dir(cwd, name), "voice.json"), formatVoice(voice));
	}

	takeRecords(cwd: string, name: string): Record<string, VoiceTakeRecord> {
		return readJson(join(this.dir(cwd, name), "takes/takes.json"), {});
	}

	private prints(cwd: string, name: string): Record<string, number[]> {
		return readJson(join(this.dir(cwd, name), "takes/voiceprints.json"), {});
	}

	/** Every take's record and match, and what each line's OGG was rendered from (for the section). */
	takes(cwd: string, name: string): VoiceTakes {
		const dir = this.dir(cwd, name);
		const { voice } = existsSync(join(dir, "voice.json")) ? parseVoice(readFileSync(join(dir, "voice.json"), "utf8")) : { voice: null };
		const records = Object.fromEntries(Object.entries(this.takeRecords(cwd, name)).filter(([f]) => existsSync(join(dir, "takes", f))));
		const prints = this.prints(cwd, name);
		const references = Object.fromEntries((voice?.lines ?? []).map((l) => [l.id, matchReferences(voice!, l.id, prints)]));
		return { records, matches: voice ? voiceMatches(voice, prints) : {}, references, rendered: readJson<{ lines?: Record<string, string> }>(join(dir, "render.json"), {}).lines ?? {} };
	}

	/**
	 * Generates `count` takes of a line, each a fresh performance from its own seed, into takes/<line>-<seed>.wav.
	 * A new voice needs `voice` (its description) and a new line its `text`; `text` and `direction` given for a line
	 * that exists change it. When the line has no take of what it now says, the take whose voice best matches the
	 * character's other lines is chosen (the first, for a voice's first line) and the line is rendered.
	 */
	async generateTakes(
		ctx: PipelineContext,
		p: { name: string; line: string; text?: string; direction?: string; voice?: string; language?: string; count?: number; seed?: number },
	): Promise<{ takes: VoiceTakeInfo[]; chosen?: string; created: boolean; line: VoiceLineInfo }> {
		const dir = this.dir(ctx.cwd, p.name);
		if (!LINE_ID.test(p.line ?? "")) throw new Error(`A line's id is lower-kebab-case (it names its file), not "${p.line}"`);
		const created = !existsSync(join(dir, "voice.json"));
		if (created && !p.voice?.trim()) throw new Error(`${p.name} is a new voice: describe it in "voice" (who is speaking and what they sound like)`);
		const voice: Voice = created ? { voice: p.voice!.trim(), lines: [] } : this.read(ctx.cwd, p.name);
		if (p.voice?.trim()) voice.voice = p.voice.trim();
		if (p.language?.trim()) voice.language = p.language.trim();
		let line = voice.lines.find((l) => l.id === p.line);
		if (!line) {
			if (!p.text?.trim()) throw new Error(`"${p.line}" is a new line: give its text`);
			voice.lines.push((line = { id: p.line, text: p.text.trim() }));
		} else if (p.text?.trim()) line.text = p.text.trim();
		if (p.direction !== undefined) line.direction = p.direction.trim() || undefined;
		this.write(ctx.cwd, p.name, voice);

		const count = Math.min(Math.max(Math.round(p.count ?? 4), 1), 8);
		const base = p.seed ?? Math.floor(Math.random() * (2 ** 31 - 100));
		const seeds = Array.from({ length: count }, (_, i) => base + i);
		const out = join(dir, "takes");
		mkdirSync(out, { recursive: true });
		const label = `Takes of ${p.name}'s "${line.id}"`;
		let last = "";
		const r = await this.deps.gen.run("voice", { text: line.text, instruct: instructOf(voice.voice, line.direction), language: languageOf(voice), seeds, out_dir: out, name: line.id }, {
			label,
			sessionId: ctx.sessionId,
			onProgress: (job) => {
				if (job.status === "running" && ctx.onJob) ctx.onJob(job);
				const text = `${label}: ${job.progress?.message ?? job.status}`;
				if (text !== last) ctx.progress?.((last = text));
			},
		});
		const made = r.takes as { seed: number; path: string; voiceprint?: number[] }[];
		const records = this.takeRecords(ctx.cwd, p.name);
		const prints = this.prints(ctx.cwd, p.name);
		const at = new Date().toISOString();
		for (const t of made) {
			const id = voiceTakeId(line.id, t.seed);
			records[`${id}.wav`] = { line: line.id, text: line.text, ...(line.direction ? { direction: line.direction } : {}), voice: voice.voice, language: languageOf(voice), seed: t.seed, model: String(r.model), at };
			if (t.voiceprint) prints[id] = t.voiceprint;
		}
		writeJson(join(out, "takes.json"), records);
		writeJson(join(out, "voiceprints.json"), prints);

		const matches = voiceMatches(voice, prints);
		const references = matchReferences(voice, line.id, prints);
		const infos: VoiceTakeInfo[] = [];
		for (const t of made) infos.push(await this.takeInfo(ctx, dir, voiceTakeId(line.id, t.seed), matches, references));
		let chosen: string | undefined;
		if (!line.take || !takeIsCurrent(voice, line, records[`${line.take}.wav`])) {
			chosen = [...infos].sort((a, b) => (b.match ?? 0) - (a.match ?? 0))[0].id;
			line.take = chosen;
			this.write(ctx.cwd, p.name, voice);
		}
		const rendered = await this.render(ctx, { name: p.name });
		return { takes: infos, ...(chosen ? { chosen } : {}), created, line: rendered.lines.find((l) => l.id === line.id)! };
	}

	/**
	 * The Voice Lines section's edits, written into voice.json and rendered: the voice's own fields, one line added or
	 * changed (its text, direction or chosen take), or a line removed with its takes.
	 */
	async edit(
		ctx: PipelineContext,
		p: { name: string; set?: { voice?: string; language?: string | null; notes?: string | null }; line?: Partial<VoiceLine> & { id: string }; remove?: string },
	): Promise<{ lines: VoiceLineInfo[] }> {
		const dir = this.dir(ctx.cwd, p.name);
		const voice = this.read(ctx.cwd, p.name);
		for (const [k, v] of Object.entries(p.set ?? {})) {
			if (!["voice", "language", "notes"].includes(k)) throw new Error(`Can't edit "${k}" here (only voice, language, notes)`);
			if (v === null || v === "") delete (voice as unknown as Record<string, unknown>)[k];
			else (voice as unknown as Record<string, unknown>)[k] = v;
		}
		if (p.line) {
			const line = voice.lines.find((l) => l.id === p.line!.id);
			if (!line) voice.lines.push({ id: p.line.id, text: p.line.text ?? "", ...(p.line.direction ? { direction: p.line.direction } : {}) });
			else {
				if (p.line.text !== undefined) line.text = p.line.text;
				if (p.line.direction !== undefined) line.direction = p.line.direction || undefined;
				if (p.line.take !== undefined) {
					if (!existsSync(join(dir, "takes", `${p.line.take}.wav`))) throw new Error(`No take "${p.line.take}" in ${VOICES_DIR}/${p.name}/takes/`);
					line.take = p.line.take;
				}
			}
		}
		if (p.remove) {
			if (!voice.lines.some((l) => l.id === p.remove)) throw new Error(`${p.name} has no line "${p.remove}"`);
			voice.lines = voice.lines.filter((l) => l.id !== p.remove);
			const records = this.takeRecords(ctx.cwd, p.name);
			const prints = this.prints(ctx.cwd, p.name);
			for (const [f, r] of Object.entries(records)) {
				if (r.line !== p.remove) continue;
				rmSync(join(dir, "takes", f), { force: true });
				delete records[f];
				delete prints[f.replace(/\.wav$/, "")];
			}
			if (existsSync(join(dir, "takes"))) {
				writeJson(join(dir, "takes/takes.json"), records);
				writeJson(join(dir, "takes/voiceprints.json"), prints);
			}
		}
		this.write(ctx.cwd, p.name, voice);
		return this.render(ctx, { name: p.name });
	}

	/** Validates voice.json and renders every line that has a take to <line>.ogg (only those whose take changed). */
	async render(ctx: PipelineContext, p: { name: string }): Promise<{ lines: VoiceLineInfo[] }> {
		const dir = this.dir(ctx.cwd, p.name);
		const voice = this.read(ctx.cwd, p.name);
		const records = this.takeRecords(ctx.cwd, p.name);
		const prints = this.prints(ctx.cwd, p.name);
		const matches = voiceMatches(voice, prints);
		const was = readJson<{ lines?: Record<string, string> }>(join(dir, "render.json"), {}).lines ?? {};
		const now: Record<string, string> = {};
		const lines: VoiceLineInfo[] = [];
		const tmp = mkdtempSync(join(tmpdir(), "gs-voice-"));
		try {
			for (const line of voice.lines) {
				if (!line.take) {
					lines.push({ id: line.id });
					continue;
				}
				if (!existsSync(join(dir, "takes", `${line.take}.wav`))) throw new VoiceError([{ at: line.id, message: `Its take "${line.take}" isn't in takes/: generate takes for the line again` }]);
				const ogg = join(dir, lineFile(line.id));
				const wav = join(tmp, `${line.id}.wav`);
				// Speech keeps its own breaths and pauses: only the silence at the ends goes, then the level.
				const measured = await this.audio("renderVariant", { dir, layers: [{ take: line.take }], processing: { peak: -1, fade: { in: 0.005, out: 0.03 } }, out: wav });
				if (was[line.id] !== line.take || !existsSync(ogg)) {
					ctx.progress?.(`Rendering ${lineFile(line.id)}`);
					await this.ffmpeg(["-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-c:a", "libvorbis", "-q:a", "6", ogg]);
				}
				now[line.id] = line.take;
				const match = matches[line.take];
				lines.push({
					id: line.id,
					file: `${VOICES_DIR}/${p.name}/${lineFile(line.id)}`,
					take: line.take,
					...measured,
					...(match === undefined ? {} : { match, ...(isDrifted(match, matchReferences(voice, line.id, prints)) ? { drifted: true } : {}) }),
					...(takeIsCurrent(voice, line, records[`${line.take}.wav`]) ? {} : { outdated: true }),
				});
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		// Lines that are gone (or lost their take): their files go too.
		for (const f of readdirSync(dir)) if (f.endsWith(".ogg") && !now[f.slice(0, -4)]) rmSync(join(dir, f));
		writeJson(join(dir, "render.json"), { lines: now, renderedAt: new Date().toISOString() });
		return { lines };
	}

	private async takeInfo(ctx: PipelineContext, dir: string, id: string, matches: Record<string, number>, references: number): Promise<VoiceTakeInfo> {
		const file = join(dir, "takes", `${id}.wav`);
		const match = matches[id];
		return { id, file: file.slice(ctx.cwd.length + 1), ...(match === undefined ? {} : { match, ...(isDrifted(match, references) ? { drifted: true } : {}) }), ...(await this.audio("measureWav", { file })) };
	}

	private ffmpeg(args: string[]): Promise<void> {
		const cmd = this.deps.ffmpeg ?? "ffmpeg";
		return new Promise((resolve, reject) => {
			const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
			let err = "";
			proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
			proc.on("error", (e) => reject(new Error(`${cmd} isn't available: ${e.message}`)));
			proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
		});
	}
}

/** The Voice Lines section's requests and the agents' voice tools (see studio-requests.ts). */
export function voiceRequests(voices: VoicePipeline): StudioRequestHandlers {
	type Edit = Parameters<VoicePipeline["edit"]>[1];
	const step = (name: string, what: string) => ({ label: `Voice ${name}: ${what}`, scopes: [{ path: `${VOICES_DIR}/${name}` }] });
	return {
		generate_voice: handler((ctx, p: Parameters<VoicePipeline["generateTakes"]>[1]) => voices.generateTakes(ctx, p), (p) => step(p.name, `new takes of "${p.line}"`)),
		render_voice: handler((ctx, p: { name: string }) => voices.render(ctx, p), (p) => step(p.name, "rendered")),
		edit_voice: handler(
			(ctx, p: Edit) => voices.edit(ctx, p),
			(p) => step(p.name, p.remove ? `removed "${p.remove}"` : p.line ? `line "${p.line.id}"` : Object.keys(p.set ?? {}).join(", ") || "edited"),
		),
	};
}
