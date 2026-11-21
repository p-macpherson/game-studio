// Effects (M12): effect files (assets/effects/<name>.json, src/shared/effect.ts), previewed over time in the game's
// engine (RunService.previewEffect), and particle textures (assets/effects/textures/<name>/): sprites generated with
// FLUX.2 Klein (on black for glows, on white for solid things) and cut out, or made procedurally (soft dots, smoke and
// dust flipbooks, sparks, rings), on the CPU (gen/workers/particle_art.py). Agents write effect files directly. See the
// vault note "M12 Particles".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import { PARTICLE_FRAMING, PARTICLE_TEXTURE_DIR, type ParticleMode, type ParticleRecipe, type ParticleTextureFile, validateParticleTexture } from "../shared/effect";
import type { GenJobKind } from "../shared/gen";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import type { EffectPreview } from "./runner";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export class ParticleTexturePipeline {
	constructor(private readonly gen: GenService) {}

	dir(cwd: string, name: string): string {
		if (!ASSET_NAME.test(name)) throw new Error(`Particle texture names are lower-kebab-case, with "/" for folders (e.g. "spark", "smoke/puff"), not "${name}"`);
		return safeJoin(cwd, `${PARTICLE_TEXTURE_DIR}/${name}`);
	}

	private file(cwd: string, name: string): string {
		return join(this.dir(cwd, name), `${leafName(name)}.json`);
	}

	read(cwd: string, name: string): ParticleTextureFile | null {
		const f = this.file(cwd, name);
		if (!existsSync(f)) return null;
		const v = JSON.parse(readFileSync(f, "utf8")) as ParticleTextureFile;
		const problems = validateParticleTexture(v);
		if (problems.length) throw new Error(`${leafName(name)}.json: ${problems.join("; ")}`);
		return v;
	}

	private write(cwd: string, name: string, v: ParticleTextureFile) {
		mkdirSync(this.dir(cwd, name), { recursive: true });
		writeFileSync(this.file(cwd, name), `${JSON.stringify(v, null, "\t")}\n`);
	}

	/** Generated candidates: FLUX on the GPU (on black for glows, on white for solid sprites), cut out on the CPU. */
	async candidates(ctx: PipelineContext, p: { name: string; mode: "glow" | "solid"; prompt: string; style?: string; count?: number; seed?: number }) {
		if (p.mode !== "glow" && p.mode !== "solid") throw new Error('mode is "glow" (sparks, embers, flames, magic) or "solid" (leaves, coins, petals, debris)');
		const existing = this.read(ctx.cwd, p.name);
		if (existing && existing.mode !== p.mode) throw new Error(`${p.name} is a ${existing.mode} texture, not ${p.mode}`);
		const out = join(this.dir(ctx.cwd, p.name), "candidates");
		mkdirSync(out, { recursive: true });
		const raw = mkdtempSync(join(tmpdir(), "gs-particles-"));
		try {
			const count = Math.min(Math.max(Math.round(p.count ?? 3), 1), 4);
			const prompt = [p.prompt, p.style, PARTICLE_FRAMING[p.mode]].filter(Boolean).join(", ");
			const g = await this.step(ctx, "image", `Particle texture ${p.name}`, { prompt, raw_prompt: true, out_dir: raw, name: leafName(p.name), count, seed: p.seed, width: 512, height: 512 });
			const c = await this.step(ctx, "particle_cut", `Cutting out ${p.name}`, { images: g.images, out_dir: out, mode: p.mode });
			const records = this.candidateRecords(ctx.cwd, p.name);
			const at = new Date().toISOString();
			const candidates = (c.candidates as { file: string }[]).map((x, i) => {
				const file = basename(x.file);
				records[file] = { prompt: p.prompt, style: p.style, seed: (g.seeds as number[])[i], model: String(g.model), at };
				return { source: `candidates/${file}`, seed: (g.seeds as number[])[i] };
			});
			writeFileSync(join(out, "candidates.json"), `${JSON.stringify(records, null, "\t")}\n`);
			if (!existing) this.write(ctx.cwd, p.name, { mode: p.mode, prompt: p.prompt });
			return { candidates, sheet: this.dataUrl(c.sheet) };
		} finally {
			rmSync(raw, { recursive: true, force: true });
		}
	}

	candidateRecords(cwd: string, name: string): Record<string, unknown> {
		const f = join(this.dir(cwd, name), "candidates/candidates.json");
		return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
	}

	/**
	 * Makes the texture: from a chosen candidate (generated modes), or procedurally from `recipe` (no GPU, instant).
	 * Returns the path effects use, its flipbook layout and a preview over dark and light.
	 */
	async make(ctx: PipelineContext, p: { name: string; source?: string; recipe?: ParticleRecipe; notes?: string }) {
		const current = this.read(ctx.cwd, p.name);
		let next: ParticleTextureFile;
		if (p.recipe) {
			next = { mode: "procedural", recipe: p.recipe, ...(current?.notes ? { notes: current.notes } : {}) };
		} else {
			if (!current) throw new Error(`No particle texture "${p.name}" yet: generate candidates first, or pass a recipe for a procedural one`);
			if (current.mode === "procedural") throw new Error(`${p.name} is procedural: pass its recipe`);
			next = { ...current, ...(p.source ? { source: p.source } : {}) };
			if (!next.source) throw new Error(`No candidate chosen for ${p.name}: pass source (one of its candidates/…png)`);
			if (!existsSync(join(this.dir(ctx.cwd, p.name), next.source))) throw new Error(`${next.source} isn't in ${PARTICLE_TEXTURE_DIR}/${p.name}/`);
		}
		if (p.notes !== undefined) next.notes = p.notes;
		const problems = validateParticleTexture(next);
		if (problems.length) throw new Error(problems.join("; "));
		const dir = this.dir(ctx.cwd, p.name);
		const r = await this.step(ctx, "particle_make", `Making ${p.name}`, {
			out_dir: dir,
			name: leafName(p.name),
			...(next.mode === "procedural" ? { recipe: next.recipe } : { source: join(dir, next.source!) }),
		});
		const flipbook = r.flipbook as [number, number];
		if (flipbook[0] * flipbook[1] > 1) next.flipbook = flipbook;
		else delete next.flipbook;
		this.write(ctx.cwd, p.name, next);
		return { file: `effects/textures/${p.name}/${leafName(p.name)}.png`, ...(next.flipbook ? { flipbook: next.flipbook } : {}), preview: this.dataUrl(r.preview) };
	}

	private dataUrl(file: unknown): string | undefined {
		if (typeof file !== "string" || !existsSync(file)) return undefined;
		const url = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
		rmSync(file, { force: true });
		return url;
	}

	private async step(ctx: PipelineContext, kind: GenJobKind, label: string, params: Record<string, unknown>) {
		let last = "";
		return this.gen.run(kind, params, {
			label,
			sessionId: ctx.sessionId,
			onProgress: (job) => {
				if (job.status === "running" && ctx.onJob) ctx.onJob(job);
				const text = `${label}: ${job.progress?.message ?? job.status}`;
				if (text !== last) ctx.progress?.((last = text));
			},
		});
	}
}

export type EffectPreviewer = (sessionId: string, p: EffectPreview) => Promise<unknown>;

/** Particle textures (the Effects section's steps and agents' tools) and the effect preview (see studio-requests.ts). */
export function effectRequests(textures: ParticleTexturePipeline, preview?: EffectPreviewer): StudioRequestHandlers {
	const step = (name: string, what: string) => ({ label: `Particle texture ${name}: ${what}`, scopes: [{ path: `${PARTICLE_TEXTURE_DIR}/${name}` }] });
	return {
		generate_particle_texture: handler(
			(ctx, p: Parameters<ParticleTexturePipeline["candidates"]>[1]) => textures.candidates(ctx, p),
			(p) => step(p.name, "new candidates"),
		),
		make_particle_texture: handler((ctx, p: Parameters<ParticleTexturePipeline["make"]>[1]) => textures.make(ctx, p), (p) => step(p.name, "made")),
		preview_effect: handler((ctx, p: EffectPreview) => {
			if (!preview) throw new Error("Effect previews need the game's engine, which isn't available here");
			return preview(ctx.sessionId, p);
		}),
	};
}

export type { ParticleMode };
