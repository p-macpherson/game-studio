// Sound effects. A sound lives in assets/sounds/<name>/:
//   sound.json      how it's made (src/shared/sound.ts): the asset
//   <name>.ogg      what the game plays, plus <name>-2.ogg… when it has variants
//   takes/          generated takes, <layer>-<seed>.wav, and takes.json (prompt, seed, model, CLAP score of each)
//   render.json     which sound.json the OGGs were rendered from, so a stale render shows
// Takes come from Stable Audio Open Small on the GPU (the generation service's "sound" job); mixing and
// processing are ours (audio-dsp.ts, on the CPU); ffmpeg encodes the OGGs and draws waveforms and spectrograms.
import { endsOfLive, liveAt, liveCode } from "../shared/live-effects";
import type { SoundEffects } from "../shared/sound-fx";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatSound,
	MAX_GENERATE_SECONDS,
	type Processing,
	parseSound,
	processingOf,
	type Sound,
	SOUND_NAME,
	type SoundProblem,
	type TakeRecord,
	takeId,
	type Variant,
	validateSound,
	variantFile,
} from "../shared/sound";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import { safeJoin } from "./assets";
import {
	type Audio,
	fades,
	filter,
	frames,
	loopCrossfade,
	type Measurements,
	mix,
	normalizePeak,
	pitchShift,
	RATE,
	reverb,
	trimSilence,
} from "./audio-dsp";
import { type AudioRun, inlineAudio } from "./audio-runner";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export const SOUNDS_DIR = "assets/sounds";
/** A take whose CLAP score is this far below its batch's median probably isn't the sound asked for. */
const OFF_PROMPT = 0.15;

export interface TakeInfo extends Measurements {
	/** Use it in a variant's layers as {"take": id}. */
	id: string;
	file: string;
	clap?: number;
	/** CLAP scored it far below the rest of its batch: probably not the sound asked for. */
	off_prompt?: boolean;
}

export interface SoundRenderInfo {
	/** sha1 of the sound.json it was rendered from. */
	sound: string;
	files: string[];
	renderedAt: string;
}

export interface SoundRenderResult {
	loop: boolean;
	variants: ({ file: string } & Measurements)[];
	/** Waveform over spectrogram of every variant, top to bottom, then the live previews (a PNG data URL). */
	sheet?: string;
	/** With `"live"` in sound.json: the first variant as the game will play it at the value's 0, 0.5 and 1, and the game code. */
	live?: { value: string; code: string; previews: ({ at: number; pitch: number; effects: SoundEffects } & Measurements)[] };
}

export class SoundError extends Error {
	constructor(readonly problems: SoundProblem[]) {
		super(`sound.json has ${problems.length} problem(s):\n${problems.map((p) => `- ${p.at ? `${p.at}: ` : ""}${p.message}`).join("\n")}`);
	}
}

export const soundHash = (text: string) => createHash("sha1").update(text).digest("hex");

/** The processing fields the section edits directly. */
export type SoundEdits = { [K in "notes" | "length" | "pitch" | "highpass" | "lowpass" | "reverb" | "peak" | "loop" | "fade" | "live"]?: Sound[K] | null };
const EDITABLE: (keyof SoundEdits)[] = ["notes", "length", "pitch", "highpass", "lowpass", "reverb", "peak", "loop", "fade", "live"];

export interface SoundUsage {
	path: string;
	line: number;
	text: string;
}

/** Where the game refers to a sound (`sounds/<name>/`): its code, scenes and prefabs. */
export function soundUsages(cwd: string, name: string): SoundUsage[] {
	const needle = `sounds/${name}/`;
	const out: SoundUsage[] = [];
	const walk = (rel: string, ext: string) => {
		const dir = join(cwd, rel);
		if (!existsSync(dir)) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const path = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(path, ext);
			else if (e.name.endsWith(ext)) {
				readFileSync(join(cwd, path), "utf8")
					.split("\n")
					.forEach((text, i) => text.includes(needle) && out.push({ path, line: i + 1, text: text.trim().slice(0, 200) }));
			}
		}
	};
	walk("game", ".odin");
	walk("assets/scenes", ".json");
	walk("assets/prefabs", ".json");
	return out;
}

/** A variant's mix → its file, in the documented order: trim, length, pitch, filters, reverb, loop, level, fades. */
export function processSound(sound: Processing & { loop?: boolean }, a: Audio): Audio {
	let x = a;
	const trim = sound.trim !== false;
	if (trim) x = trimSilence(x, typeof sound.trim === "object" ? (sound.trim.threshold ?? -50) : -50);
	if (sound.length && frames(x) > sound.length * RATE) x = x.map((ch) => ch.slice(0, Math.round(sound.length! * RATE)));
	if (sound.pitch) x = pitchShift(x, sound.pitch);
	if (sound.highpass) x = filter(x, "highpass", sound.highpass);
	if (sound.lowpass) x = filter(x, "lowpass", sound.lowpass);
	if (sound.reverb) {
		x = reverb(x, sound.reverb);
		if (trim) x = trimSilence(x, -60); // the inaudible end of the reverb tail
	}
	if (sound.loop) x = loopCrossfade(x, sound.crossfade ?? Math.min(2, frames(x) / RATE / 4));
	x = normalizePeak(x, sound.peak ?? -1);
	return sound.loop ? x : fades(x, sound.fade?.in ?? 0.005, sound.fade?.out ?? 0.05);
}

export class SoundPipeline {
	constructor(private readonly deps: { gen: GenService; ffmpeg?: string; audio?: AudioRun }) {}

	/** The heavy steps on whole buffers (audio-jobs.ts): in a worker thread in the app, inline otherwise. */
	private get audio(): AudioRun {
		return this.deps.audio ?? inlineAudio;
	}

	dir(cwd: string, name: string): string {
		if (!ASSET_NAME.test(name)) throw new Error(`A sound's name is lower-kebab-case, with "/" for folders (e.g. "chest-open", "ui/click"), not "${name}"`);
		return safeJoin(cwd, `${SOUNDS_DIR}/${name}`);
	}

	/**
	 * Generates `count` takes from a prompt, each with its own seed, into takes/ as `<group>-<seed>.wav`. The
	 * first takes of a new sound also write its sound.json (one variant: the first take that isn't off-prompt), so
	 * the sound exists and renders from then on.
	 */
	async generateTakes(
		ctx: PipelineContext,
		p: { name: string; prompt: string; seconds: number; count?: number; group?: string; seed?: number },
	): Promise<{ takes: TakeInfo[]; sheet?: string; created: boolean }> {
		const dir = this.dir(ctx.cwd, p.name);
		const group = p.group ?? "main";
		if (!SOUND_NAME.test(group)) throw new Error(`A group's name is lower-kebab-case, not "${group}"`);
		if (!(p.seconds >= 0.1 && p.seconds <= MAX_GENERATE_SECONDS)) throw new Error(`seconds must be from 0.1 to ${MAX_GENERATE_SECONDS} (the model's limit)`);
		if (!p.prompt?.trim()) throw new Error("Describe the sound in prompt");
		const count = Math.min(Math.max(Math.round(p.count ?? 6), 1), 12);
		const base = p.seed ?? Math.floor(Math.random() * (2 ** 31 - 100));
		const seeds = Array.from({ length: count }, (_, i) => base + i);
		const generated = await this.takes(ctx, p.name, group, p.prompt, p.seconds, seeds);
		const infos = await Promise.all(generated.map((t) => this.takeInfo(ctx, dir, takeId(group, t.seed), t.clap)));
		const scores = infos.map((t) => t.clap).filter((c): c is number => c !== undefined);
		if (scores.length > 2) {
			const median = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)];
			for (const t of infos) if (t.clap !== undefined && t.clap < median - OFF_PROMPT) t.off_prompt = true;
		}
		const file = join(dir, "sound.json");
		const created = !existsSync(file);
		if (created) {
			const first = infos.find((t) => !t.off_prompt) ?? infos[0];
			writeFileSync(file, formatSound({ variants: [{ layers: [{ take: first.id }] }] }));
		}
		return { takes: infos, sheet: await this.sheet(infos.map((t) => join(ctx.cwd, t.file))), created };
	}

	/**
	 * The Sound Effects section's edits, written into sound.json and rendered: the variants (as the section
	 * composed them) and the shared processing fields (null removes one).
	 */
	async edit(ctx: PipelineContext, p: { name: string; variants?: Variant[]; set?: SoundEdits }): Promise<SoundRenderResult> {
		const file = join(this.dir(ctx.cwd, p.name), "sound.json");
		const sound = JSON.parse(readFileSync(file, "utf8")) as Sound;
		if (p.variants) sound.variants = p.variants;
		for (const [k, v] of Object.entries(p.set ?? {})) {
			if (!EDITABLE.includes(k as keyof SoundEdits)) throw new Error(`Can't edit "${k}" here (only ${EDITABLE.join(", ")})`);
			if (v === null) delete (sound as unknown as Record<string, unknown>)[k];
			else (sound as unknown as Record<string, unknown>)[k] = v;
		}
		const problems = validateSound(sound);
		if (problems.length) throw new SoundError(problems);
		writeFileSync(file, formatSound(sound));
		return this.render(ctx, { name: p.name });
	}

	/** Every take of a sound with how it was made, by file name. */
	takeRecords(cwd: string, name: string): Record<string, TakeRecord> {
		const file = join(this.dir(cwd, name), "takes/takes.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	}

	/** Validates sound.json and renders its variants to OGG (generating any takes it uses that aren't there). */
	async render(ctx: PipelineContext, p: { name: string }): Promise<SoundRenderResult> {
		const dir = this.dir(ctx.cwd, p.name);
		const file = join(dir, "sound.json");
		if (!existsSync(file)) throw new Error(`No ${SOUNDS_DIR}/${p.name}/sound.json yet: generate takes or write it first`);
		const text = readFileSync(file, "utf8");
		const { sound, problems } = parseSound(text);
		if (!sound) throw new SoundError(problems);

		// Takes it uses but that aren't there (a fresh clone without LFS files, say) are generated again from their record.
		const used = [...new Set(sound.variants.flatMap((v) => v.layers.flatMap((l) => ("take" in l ? [l.take] : []))))];
		const records = this.takeRecords(ctx.cwd, p.name);
		for (const id of used.filter((id) => !existsSync(join(dir, "takes", `${id}.wav`)))) {
			const r = records[`${id}.wav`];
			if (!r) throw new SoundError([{ at: "variants", message: `Take "${id}" isn't in takes/ and takes.json doesn't say how it was made` }]);
			await this.takes(ctx, p.name, r.group, r.prompt, r.seconds, [r.seed]);
		}

		const tmp = mkdtempSync(join(tmpdir(), "gs-sound-"));
		try {
			const variants: SoundRenderResult["variants"] = [];
			const wavs: string[] = [];
			for (const [i, v] of sound.variants.entries()) {
				ctx.progress?.(`Rendering ${variantFile(leafName(p.name), i)}`);
				const wav = join(tmp, `v${i}.wav`);
				const measured = await this.audio("renderVariant", { dir, layers: v.layers, processing: processingOf(sound, v), out: wav });
				await this.ffmpeg(["-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "6", join(dir, variantFile(leafName(p.name), i))]);
				wavs.push(wav);
				variants.push({ file: `${SOUNDS_DIR}/${p.name}/${variantFile(leafName(p.name), i)}`, ...measured });
			}
			// Fewer variants than last time: remove the extra files.
			for (const f of readdirSync(dir)) {
				const m = new RegExp(`^${leafName(p.name)}-(\\d+)\\.ogg$`).exec(f);
				if (m && Number(m[1]) > sound.variants.length) rmSync(join(dir, f));
			}
			// Live effects aren't in the files: the game applies them. Previewed on the first variant at 0, ½ and 1.
			let live: SoundRenderResult["live"];
			if (sound.live && wavs.length) {
				const ends = endsOfLive(sound.live);
				const previews: NonNullable<SoundRenderResult["live"]>["previews"] = [];
				for (const t of [0, 0.5, 1]) {
					ctx.progress?.(`Previewing live effects at ${sound.live.value} = ${t}`);
					const { pitch, effects } = liveAt(ends, t);
					const out = join(tmp, `live-${t}.wav`);
					previews.push({ at: t, pitch: Number(pitch.toFixed(3)), effects, ...(await this.audio("liveVariant", { file: wavs[0], pitch, effects, out })) });
					wavs.push(out);
				}
				const gamePath = `sounds/${p.name}/${variantFile(leafName(p.name), 0)}`;
				live = { value: sound.live.value, code: liveCode(ends, gamePath, sound.live.value, !!sound.loop), previews };
			}
			const info: SoundRenderInfo = { sound: soundHash(text), files: variants.map((v) => v.file.split("/").pop()!), renderedAt: new Date().toISOString() };
			writeFileSync(join(dir, "render.json"), `${JSON.stringify(info, null, "\t")}\n`);
			return { loop: !!sound.loop, variants, sheet: await this.sheet(wavs), ...(live ? { live } : {}) };
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	/** Runs the generation job for some seeds of a layer and records them in takes/takes.json. */
	private async takes(ctx: PipelineContext, name: string, group: string, prompt: string, seconds: number, seeds: number[]) {
		const out = join(this.dir(ctx.cwd, name), "takes");
		mkdirSync(out, { recursive: true });
		const label = `Takes for ${name}`;
		let last = "";
		const r = await this.deps.gen.run("sound", { prompt, seconds, seeds, out_dir: out, name: group }, {
			label,
			sessionId: ctx.sessionId,
			onProgress: (job) => {
				if (job.status === "running" && ctx.onJob) ctx.onJob(job);
				const text = `${label}: ${job.progress?.message ?? job.status}`;
				if (text !== last) ctx.progress?.((last = text));
			},
		});
		const takes = r.takes as { seed: number; path: string; clap?: number }[];
		const records = this.takeRecords(ctx.cwd, name);
		const at = new Date().toISOString();
		for (const t of takes) records[`${takeId(group, t.seed)}.wav`] = { group, prompt, seconds, seed: t.seed, model: String(r.model), clap: t.clap, at };
		writeFileSync(join(out, "takes.json"), `${JSON.stringify(records, null, "\t")}\n`);
		return takes;
	}

	private async takeInfo(ctx: PipelineContext, dir: string, id: string, clap?: number): Promise<TakeInfo> {
		const file = join(dir, "takes", `${id}.wav`);
		return { id, file: file.slice(ctx.cwd.length + 1), ...(clap === undefined ? {} : { clap: Math.round(clap * 1000) / 1000 }), ...(await this.audio("measureWav", { file })) };
	}

	/** Waveform (top) over spectrogram (log frequency) for each file, stacked in order, as a PNG data URL. */
	private async sheet(files: string[]): Promise<string | undefined> {
		if (!files.length) return undefined;
		const tmp = mkdtempSync(join(tmpdir(), "gs-sheet-"));
		try {
			const out = join(tmp, "sheet.png");
			const graph = files.map(
				(_, i) =>
					`[${i}:a]asplit[a${i}][b${i}];[a${i}]showwavespic=s=640x56:scale=sqrt:colors=0x4ea1ff[w${i}];` +
					`[b${i}]showspectrumpic=s=640x112:legend=0:scale=log:fscale=log:color=intensity[s${i}];[w${i}][s${i}]vstack,pad=640:176:0:0:white[p${i}]`,
			);
			const stack = files.length > 1 ? `;${files.map((_, i) => `[p${i}]`).join("")}vstack=inputs=${files.length}[out]` : "";
			const last = files.length > 1 ? "[out]" : "[p0]";
			await this.ffmpeg(["-y", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex", graph.join(";") + stack, "-map", last, "-frames:v", "1", out]);
			return `data:image/png;base64,${readFileSync(out).toString("base64")}`;
		} catch {
			return undefined; // an image is a nicety; the measurements are still there
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
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

/** The Sound Effects section's requests (see studio-requests.ts). */
export function soundRequests(sounds: SoundPipeline): StudioRequestHandlers {
	type Edit = Parameters<SoundPipeline["edit"]>[1];
	const step = (name: string, what: string) => ({ label: `Sound ${name}: ${what}`, scopes: [{ path: `${SOUNDS_DIR}/${name}` }] });
	return {
		generate_sound: handler((ctx, p: Parameters<SoundPipeline["generateTakes"]>[1]) => sounds.generateTakes(ctx, p), (p) => step(p.name, "new takes")),
		render_sound: handler((ctx, p: { name: string }) => sounds.render(ctx, p), (p) => step(p.name, "rendered")),
		edit_sound: handler((ctx, p: Edit) => sounds.edit(ctx, p), (p) => step(p.name, [...(p.variants ? ["variants"] : []), ...Object.keys(p.set ?? {})].join(", ") || "edited")),
	};
}
