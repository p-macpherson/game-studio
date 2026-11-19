// 3D model pipeline over the generation service. A model lives in assets/models/<name>/:
//   <name>.glb        engine-ready (what the game loads)
//   thumbnail.png     rendered by the finalize step
//   model.json        how it was made (ModelManifest)
//   concepts/*.png    concept images
//   source/           intermediates: shape.glb, textured.glb, rigged.glb, plus any edits
// Every step reads and writes inside one checkout (the main checkout or a session's worktree).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ConceptImage, ConceptRecord, GenJob, GenJobKind, ModelManifest } from "../shared/gen";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import type { StudioRequest } from "./sessions";

export const MODELS_DIR = "assets/models";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface PipelineContext {
	/** Checkout root (absolute). */
	cwd: string;
	sessionId?: string;
	progress?(text: string): void;
	/** Lets a caller cancel the jobs it started. */
	onJob?(job: GenJob): void;
}

/**
 * Serves agents' generation tools (see studio-tools.ts) in their session's worktree, and cancels a tool call's
 * jobs when the agent is stopped. Plug into SessionService's `studioRequest` / `cancelStudioRequest`.
 */
export function generationRequests(pipeline: ModelPipeline, gen: GenService) {
	const jobs = new Map<string, Set<string>>();
	return {
		async studioRequest(req: StudioRequest): Promise<unknown> {
			const started = new Set<string>();
			jobs.set(req.requestId, started);
			const ctx: PipelineContext = { cwd: req.cwd, sessionId: req.sessionId, progress: req.progress, onJob: (j) => started.add(j.id) };
			const p = req.params as never;
			try {
				switch (req.method) {
					case "generate_concepts":
						return await pipeline.concepts(ctx, p);
					case "generate_model":
						return await pipeline.generate(ctx, p);
					case "retexture_model":
						return await pipeline.retexture(ctx, p);
					case "rig_model":
						return await pipeline.rig(ctx, p);
					case "finalize_model":
						return await pipeline.finalize(ctx, p);
				}
			} finally {
				jobs.delete(req.requestId);
			}
		},
		cancelStudioRequest(requestId: string): void {
			for (const id of jobs.get(requestId) ?? []) gen.cancel(id);
		},
	};
}

export class ModelPipeline {
	constructor(private readonly gen: GenService) {}

	dir(ctx: PipelineContext, name: string): string {
		if (!NAME.test(name)) throw new Error(`Model names are lower-kebab-case (e.g. "treasure-chest"), not "${name}"`);
		return safeJoin(ctx.cwd, `${MODELS_DIR}/${name}`);
	}

	manifest(ctx: PipelineContext, name: string): ModelManifest | null {
		const file = join(this.dir(ctx, name), "model.json");
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ModelManifest) : null;
	}

	async concepts(
		ctx: PipelineContext,
		p: { model: string; prompt: string; count?: number; references?: string[]; seed?: number },
	): Promise<{ images: string[]; seeds: number[] }> {
		const out = join(this.dir(ctx, p.model), "concepts");
		const count = Math.min(Math.max(Math.round(p.count ?? 4), 1), 8);
		const references = (p.references ?? []).map((r) => this.input(ctx, r));
		const r = await this.step(ctx, "image", `Concepts for ${p.model}`, {
			prompt: p.prompt,
			out_dir: out,
			name: p.model,
			count,
			seed: p.seed,
			references,
		});
		const images = r.images as string[];
		const seeds = r.seeds as number[];
		// Remember how each image was made, so a model built from it records its prompt.
		const records = this.conceptRecords(out);
		images.forEach((f, i) => {
			records[basename(f)] = {
				prompt: p.prompt,
				seed: seeds[i],
				model: String(r.model),
				references: references.length ? references.map((x) => basename(x)) : undefined,
				at: new Date().toISOString(),
			};
		});
		writeFileSync(join(out, "concepts.json"), `${JSON.stringify(records, null, "\t")}\n`);
		// A model exists from its first concepts on, so it shows in the 3D Models section.
		if (!this.manifest(ctx, p.model)) {
			this.writeManifest(ctx, { name: p.model, description: p.prompt, textured: false, rigged: false, steps: [] });
		}
		return { images: images.map((f) => this.rel(ctx, f)), seeds };
	}

	/** A model's concept images, newest first, with how each was made. */
	conceptImages(ctx: PipelineContext, name: string): ConceptImage[] {
		const dir = join(this.dir(ctx, name), "concepts");
		if (!existsSync(dir)) return [];
		const records = this.conceptRecords(dir);
		return readdirSync(dir)
			.filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
			.map((f) => ({ f, at: records[f]?.at ?? statSync(join(dir, f)).mtime.toISOString() }))
			.sort((a, b) => b.at.localeCompare(a.at) || a.f.localeCompare(b.f))
			.map(({ f }) => ({ path: this.rel(ctx, join(dir, f)), record: records[f] }));
	}

	private conceptRecords(conceptsDir: string): Record<string, ConceptRecord> {
		const file = join(conceptsDir, "concepts.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	}

	async generate(
		ctx: PipelineContext,
		p: { model: string; image: string; height: number; back?: string; texture?: boolean; rig?: boolean; description?: string },
	): Promise<{ manifest: ModelManifest; glb: string; thumbnail: string }> {
		const dir = this.dir(ctx, p.model);
		const image = this.input(ctx, p.image);
		const back = p.back ? this.input(ctx, p.back) : undefined;
		const texture = p.texture ?? true;
		const manifest: ModelManifest = {
			name: p.model,
			description: p.description ?? this.manifest(ctx, p.model)?.description,
			concept: this.keepConcept(dir, image, "concept"),
			conceptSource: this.conceptSource(dir, image),
			back: back ? this.keepConcept(dir, back, "back") : undefined,
			height: p.height,
			textured: texture,
			rigged: !!p.rig,
			steps: [],
		};
		const shape = join(dir, "source/shape.glb");
		this.record(manifest, "shape", await this.step(ctx, "shape", `Shape for ${p.model}`, { image, back, out: shape }));
		let latest = shape;
		if (texture) {
			const textured = join(dir, "source/textured.glb");
			this.record(manifest, "texture", await this.step(ctx, "texture", `Texture for ${p.model}`, { mesh: shape, image, out: textured }));
			latest = textured;
		}
		if (p.rig) latest = await this.rigStep(ctx, manifest, latest);
		return this.finalizeStep(ctx, manifest, latest);
	}

	async retexture(ctx: PipelineContext, p: { model: string; image: string }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		const image = this.input(ctx, p.image);
		manifest.concept = this.keepConcept(dir, image, "concept");
		manifest.conceptSource = this.conceptSource(dir, image);
		const textured = join(dir, "source/textured.glb");
		this.record(manifest, "texture", await this.step(ctx, "texture", `Texture for ${p.model}`, { mesh: join(dir, "source/shape.glb"), image, out: textured }));
		manifest.textured = true;
		const latest = manifest.rigged ? await this.rigStep(ctx, manifest, textured) : textured;
		return this.finalizeStep(ctx, manifest, latest);
	}

	async rig(ctx: PipelineContext, p: { model: string }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		const from = existsSync(join(dir, "source/textured.glb")) ? join(dir, "source/textured.glb") : join(dir, "source/shape.glb");
		manifest.rigged = true;
		return this.finalizeStep(ctx, manifest, await this.rigStep(ctx, manifest, from));
	}

	async finalize(ctx: PipelineContext, p: { model: string; from?: string; height?: number }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		if (p.height) manifest.height = p.height;
		const from = p.from ? this.input(ctx, p.from) : this.latestSource(dir);
		return this.finalizeStep(ctx, manifest, from);
	}

	private writeManifest(ctx: PipelineContext, manifest: ModelManifest): void {
		const dir = this.dir(ctx, manifest.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "model.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	}

	private async rigStep(ctx: PipelineContext, manifest: ModelManifest, from: string): Promise<string> {
		const out = join(this.dir(ctx, manifest.name), "source/rigged.glb");
		this.record(manifest, "rig", await this.step(ctx, "rig", `Rig for ${manifest.name}`, { mesh: from, out }));
		manifest.rigged = true;
		return out;
	}

	private async finalizeStep(ctx: PipelineContext, manifest: ModelManifest, from: string) {
		const dir = this.dir(ctx, manifest.name);
		const glb = join(dir, `${manifest.name}.glb`);
		const thumbnail = join(dir, "thumbnail.png");
		const stats = await this.step(ctx, "finalize", `Finalize ${manifest.name}`, { in: from, out: glb, height: manifest.height ?? 1, thumbnail });
		this.record(manifest, "finalize", stats);
		manifest.stats = { ...stats, mesh: undefined, thumbnail: undefined };
		this.writeManifest(ctx, manifest);
		return { manifest, glb: this.rel(ctx, glb), thumbnail: this.rel(ctx, thumbnail) };
	}

	private async step(ctx: PipelineContext, kind: GenJobKind, label: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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

	private record(manifest: ModelManifest, kind: GenJobKind, r: Record<string, unknown>): void {
		manifest.steps.push({
			kind,
			model: typeof r.model === "string" ? r.model : kind === "finalize" ? "blender" : undefined,
			seed: typeof r.seed === "number" ? r.seed : undefined,
			seconds: typeof r.seconds === "number" ? r.seconds : undefined,
			at: new Date().toISOString(),
		});
	}

	private existing(ctx: PipelineContext, name: string): { dir: string; manifest: ModelManifest } {
		const manifest = this.manifest(ctx, name);
		if (!manifest) throw new Error(`No model "${name}" (no ${MODELS_DIR}/${name}/model.json)`);
		return { dir: this.dir(ctx, name), manifest };
	}

	private latestSource(dir: string): string {
		for (const f of ["rigged.glb", "textured.glb", "shape.glb"]) if (existsSync(join(dir, "source", f))) return join(dir, "source", f);
		throw new Error(`Nothing to finalize in ${dir}/source`);
	}

	/** The record of a concept the studio generated into this model's concepts/ folder. */
	private conceptSource(dir: string, conceptPath: string): ConceptRecord | undefined {
		return this.conceptRecords(join(dir, "concepts"))[basename(conceptPath)];
	}

	/** Copies the concept used for a model into its concepts/ folder (unless it's already there). */
	private keepConcept(dir: string, image: string, name: string): string {
		const concepts = join(dir, "concepts");
		if (image.startsWith(concepts + "/")) return relative(dir, image);
		mkdirSync(concepts, { recursive: true });
		const target = join(concepts, `${name}${image.slice(image.lastIndexOf("."))}`);
		copyFileSync(image, target);
		return relative(dir, target);
	}

	private input(ctx: PipelineContext, path: string): string {
		const full = safeJoin(ctx.cwd, path);
		if (!existsSync(full)) throw new Error(`${path} doesn't exist`);
		return full;
	}

	private rel(ctx: PipelineContext, full: string): string {
		return relative(ctx.cwd, full) || basename(full);
	}
}
