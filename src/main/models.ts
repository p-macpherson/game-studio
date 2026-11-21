// 3D model pipeline over the generation service. A model lives in assets/models/<name>/:
//   <name>.glb        engine-ready (what the game loads)
//   thumbnail.png     rendered by the finalize step
//   model.json        how it was made (ModelManifest)
//   concepts/*.png    concept images
//   source/           intermediates: shape.glb, textured.glb, rigged.glb, plus any edits
// Every step reads and writes inside one checkout (the main checkout or a session's worktree).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ANIMATION_CLIPS, type ConceptImage, type ConceptRecord, DEFAULT_CLIPS, type GenJobKind, LIBRARY_CLIPS, type ModelManifest, PROCEDURAL_CLIPS } from "../shared/gen";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export const MODELS_DIR = "assets/models";
/** Compared on the robot: 3 passes fix most joint artefacts; 12 start to make joints lumpy. */
const SKIN_SMOOTHING_PASSES = 3;
/** What the generation models write into a model's source/ folder (anything else there is an agent's own). */
const GENERATED_SOURCES = ["shape.glb", "textured.glb", "rigged.glb"];

export type { PipelineContext } from "./studio-requests";

/** The 3D Models section's requests (see studio-requests.ts). `preview` renders a model in the game's engine (RunService.preview). */
export function modelRequests(pipeline: ModelPipeline, preview?: (sessionId: string, model: string) => Promise<{ images: string[]; errors: string[] }>): StudioRequestHandlers {
	const step = (what: string) => (p: { model: string }) => ({ label: `Model ${p.model}: ${what}`, scopes: [{ path: `${MODELS_DIR}/${p.model}` }] });
	type P<M extends "concepts" | "generate" | "retexture" | "rig" | "rigProp" | "animate" | "finalize"> = Parameters<ModelPipeline[M]>[1];
	return {
		generate_concepts: handler((ctx, p: P<"concepts">) => pipeline.concepts(ctx, p), step("concepts")),
		generate_model: handler((ctx, p: P<"generate">) => pipeline.generate(ctx, p), step("generated")),
		retexture_model: handler((ctx, p: P<"retexture">) => pipeline.retexture(ctx, p), step("retextured")),
		rig_model: handler((ctx, p: P<"rig">) => pipeline.rig(ctx, p), step("rigged")),
		rig_prop: handler((ctx, p: P<"rigProp">) => pipeline.rigProp(ctx, p), step("prop rig")),
		animate_model: handler((ctx, p: P<"animate">) => pipeline.animate(ctx, p), step("animated")),
		finalize_model: handler((ctx, p: P<"finalize">) => pipeline.finalize(ctx, p), step("finalized")),
		preview_model: handler((ctx, p: { model: string }) => {
			if (!preview) throw new Error("In-engine previews aren't available here");
			return preview(ctx.sessionId, p.model);
		}),
	};
}

export class ModelPipeline {
	constructor(private readonly gen: GenService) {}

	dir(ctx: PipelineContext, name: string): string {
		if (!ASSET_NAME.test(name)) throw new Error(`Model names are lower-kebab-case, with "/" for folders (e.g. "treasure-chest", "props/barrel"), not "${name}"`);
		return safeJoin(ctx.cwd, `${MODELS_DIR}/${name}`);
	}

	manifest(ctx: PipelineContext, name: string): ModelManifest | null {
		const file = join(this.dir(ctx, name), "model.json");
		// The folder is the truth: a model moved into another folder keeps working before its manifest is rewritten.
		return existsSync(file) ? { ...(JSON.parse(readFileSync(file, "utf8")) as ModelManifest), name } : null;
	}

	async concepts(
		ctx: PipelineContext,
		p: { model: string; prompt: string; count?: number; references?: string[]; seed?: number },
	): Promise<{ images: string[]; seeds: number[]; sheet?: string }> {
		const out = join(this.dir(ctx, p.model), "concepts");
		const count = Math.min(Math.max(Math.round(p.count ?? 4), 1), 8);
		const references = (p.references ?? []).map((r) => this.input(ctx, r));
		const r = await this.step(ctx, "image", `Concepts for ${p.model}`, {
			prompt: p.prompt,
			out_dir: out,
			name: leafName(p.model), // the files' prefix: a model in a folder ("props/barrel") is still "barrel-<seed>.png"
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
		// The worker's contact sheet (all images, numbered) comes back as a data URL for the agent to look at.
		let sheet: string | undefined;
		if (typeof r.sheet === "string" && existsSync(r.sheet)) {
			sheet = `data:image/${r.sheet.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(r.sheet).toString("base64")}`;
			rmSync(r.sheet, { force: true });
		}
		return { images: images.map((f) => this.rel(ctx, f)), seeds, sheet };
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
		return this.remakeRig(ctx, manifest, textured);
	}

	async rig(ctx: PipelineContext, p: { model: string }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		manifest.rig = "auto";
		manifest.propRig = undefined;
		manifest.clips = undefined;
		manifest.bones = undefined;
		return this.finalizeStep(ctx, manifest, await this.rigStep(ctx, manifest, this.unrigged(dir)));
	}

	/** A hinge rig for a prop (lid, door), with `open` and `close` clips. Replaces any rig the model had. */
	async rigProp(ctx: PipelineContext, p: { model: string; split?: number; hinge?: string; angle?: number }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		manifest.rig = "prop";
		manifest.propRig = { split: p.split ?? 0.6, hinge: p.hinge ?? "back", angle: p.angle ?? 100 };
		manifest.clips = undefined;
		manifest.bones = undefined;
		return this.finalizeStep(ctx, manifest, await this.propRigStep(ctx, manifest, this.unrigged(dir)));
	}

	/**
	 * Names a rigged character's bones by role and gives it exactly these clips (idle, walk and wave by default; see
	 * ANIMATION_CLIPS): most are retargeted from the animation library, wave is keyed procedurally.
	 */
	async animate(ctx: PipelineContext, p: { model: string; clips?: string[] }) {
		const { manifest } = this.existing(ctx, p.model);
		if (manifest.rig === "prop") throw new Error(`"${p.model}" has a prop rig, which comes with its own open/close clips`);
		if (!manifest.rigged || !manifest.stats) throw new Error(`"${p.model}" isn't rigged yet: rig it first`);
		const result = await this.animateStep(ctx, manifest, p.clips);
		return { ...(await this.finalizeStep(ctx, manifest, result)), bones: manifest.bones, clips: manifest.clips };
	}

	async finalize(ctx: PipelineContext, p: { model: string; from?: string; height?: number }) {
		const { dir, manifest } = this.existing(ctx, p.model);
		if (p.height) manifest.height = p.height;
		const from = p.from ? this.input(ctx, p.from) : this.latestSource(dir, manifest);
		return this.finalizeStep(ctx, manifest, from);
	}

	private writeManifest(ctx: PipelineContext, manifest: ModelManifest): void {
		const dir = this.dir(ctx, manifest.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "model.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	}

	/** After the mesh or texture changed: remake whatever rig and clips the model had, then finalize. */
	private async remakeRig(ctx: PipelineContext, manifest: ModelManifest, from: string) {
		if (manifest.rig === "prop" && manifest.propRig) return this.finalizeStep(ctx, manifest, await this.propRigStep(ctx, manifest, from));
		if (!manifest.rigged) return this.finalizeStep(ctx, manifest, from);
		const finalized = await this.finalizeStep(ctx, manifest, await this.rigStep(ctx, manifest, from));
		if (!manifest.clips?.length) return finalized;
		return this.finalizeStep(ctx, manifest, await this.animateStep(ctx, manifest, manifest.clips));
	}

	private async propRigStep(ctx: PipelineContext, manifest: ModelManifest, from: string): Promise<string> {
		const out = join(this.dir(ctx, manifest.name), "source/prop-rig.glb");
		this.record(manifest, "rig_prop", await this.step(ctx, "rig_prop", `Prop rig for ${manifest.name}`, { in: from, out, ...manifest.propRig }));
		manifest.rigged = true;
		return out;
	}

	/** Runs on the engine-ready model (right scale), writing source/animated.glb. */
	private async animateStep(ctx: PipelineContext, manifest: ModelManifest, clips?: string[]): Promise<string> {
		const dir = this.dir(ctx, manifest.name);
		const out = join(dir, "source/animated.glb");
		const wanted = [...new Set(clips?.length ? clips : DEFAULT_CLIPS)];
		const unknown = wanted.filter((c) => !(ANIMATION_CLIPS as string[]).includes(c));
		if (unknown.length) throw new Error(`No clip called ${unknown.map((c) => `"${c}"`).join(", ")}: choose from ${ANIMATION_CLIPS.join(", ")}`);
		// From the library when it's installed; without it idle and walk are keyed procedurally, as wave always is.
		const library = this.gen.animationLibrary();
		const installed = existsSync(library);
		const retargeted = wanted.filter((c) => c in LIBRARY_CLIPS && (installed || !(PROCEDURAL_CLIPS as readonly string[]).includes(c)));
		if (retargeted.length && !installed) {
			throw new Error(`The animation library isn't installed (Settings → Asset generation → Install), so ${retargeted.join(", ")} can't be made: without it there are only ${PROCEDURAL_CLIPS.join(", ")}`);
		}
		const keyed = wanted.filter((c) => !retargeted.includes(c));
		const r = await this.step(ctx, "animate", `Bones and clips for ${manifest.name}`, { in: join(dir, `${leafName(manifest.name)}.glb`), out, clips: keyed });
		if (!r.biped) throw new Error(`Can't animate "${manifest.name}" automatically: ${(r.problems as string[]).join("; ")}`);
		this.record(manifest, "animate", r);
		if (retargeted.length) {
			const from = Object.fromEntries(retargeted.map((c) => [c, LIBRARY_CLIPS[c as keyof typeof LIBRARY_CLIPS]]));
			this.record(manifest, "retarget", await this.step(ctx, "retarget", `Library clips for ${manifest.name}`, { in: out, out, library, clips: from }));
		}
		manifest.bones = r.roles as Record<string, string>;
		manifest.clips = wanted;
		return out;
	}

	/** The newest mesh without a rig: textured if there is one, else the bare shape. */
	private unrigged(dir: string): string {
		const textured = join(dir, "source/textured.glb");
		return existsSync(textured) ? textured : join(dir, "source/shape.glb");
	}

	private async rigStep(ctx: PipelineContext, manifest: ModelManifest, from: string): Promise<string> {
		const out = join(this.dir(ctx, manifest.name), "source/rigged.glb");
		this.record(manifest, "rig", await this.step(ctx, "rig", `Rig for ${manifest.name}`, { mesh: from, out }));
		manifest.rigged = true;
		manifest.rig = "auto";
		return out;
	}

	private async finalizeStep(ctx: PipelineContext, manifest: ModelManifest, from: string) {
		const dir = this.dir(ctx, manifest.name);
		const glb = join(dir, `${leafName(manifest.name)}.glb`);
		const thumbnail = join(dir, "thumbnail.png");
		// UniRig's raw weights crumple necks and dent shoulders; a light smoothing fixes most of it. It always starts
		// from the raw rig in source/, so re-finalizing gives the same result. An agent's own edits aren't touched.
		const smooth_weights = from === join(dir, "source/rigged.glb") ? SKIN_SMOOTHING_PASSES : 0;
		// Straight from a generation model: small pieces floating clear of the body are debris and are removed (and, on a
		// fresh rig, pieces touching it are bound to it). Not for a file an agent made: its loose parts may be meant.
		const clean = GENERATED_SOURCES.some((f) => from === join(dir, "source", f));
		const stats = await this.step(ctx, "finalize", `Finalize ${manifest.name}`, { in: from, out: glb, height: manifest.height ?? 1, thumbnail, smooth_weights, clean });
		this.record(manifest, "finalize", stats);
		manifest.source = relative(dir, from);
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

	/** What the model was last finalized from; for older manifests without that, the most recently written source
	 * mesh (file times are only a guess: a git checkout gives every file the same time). */
	private latestSource(dir: string, manifest: ModelManifest): string {
		if (manifest.source && existsSync(join(dir, manifest.source))) return join(dir, manifest.source);
		const candidates = ["edited.glb", "animated.glb", "prop-rig.glb", "rigged.glb", "textured.glb", "shape.glb"]
			.map((f) => join(dir, "source", f))
			.filter((f) => existsSync(f));
		if (!candidates.length) throw new Error(`Nothing to finalize in ${dir}/source`);
		return candidates.reduce((a, b) => (statSync(b).mtimeMs > statSync(a).mtimeMs ? b : a));
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
