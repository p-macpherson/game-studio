// Tileable surface textures (M9): candidates from FLUX.2 Klein made seamless two ways (the image worker's "surface"
// job), and the texture made from a chosen one: the colour plus normal and roughness maps derived on the CPU
// ("surface_make"). texture.json (src/shared/texture.ts) is the asset; see the vault note "M9 Textures".
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import type { GenJobKind } from "../shared/gen";
import { type CandidateRecord, formatTexture, parseTexture, TEXTURE_DEFAULTS, type TextureFile, textureFiles, validateTexture } from "../shared/texture";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export const TEXTURES_DIR = "assets/textures";

export class TextureError extends Error {}

export class TexturePipeline {
	constructor(private readonly gen: GenService) {}

	dir(cwd: string, name: string): string {
		if (!ASSET_NAME.test(name)) throw new TextureError(`Texture names are lower-kebab-case, with "/" for folders (e.g. "grass", "ground/cobblestone"), not "${name}"`);
		return safeJoin(cwd, `${TEXTURES_DIR}/${name}`);
	}

	read(cwd: string, name: string): TextureFile | null {
		const file = join(this.dir(cwd, name), "texture.json");
		if (!existsSync(file)) return null;
		const { texture, problems } = parseTexture(readFileSync(file, "utf8"));
		if (!texture) throw new TextureError(`texture.json has problems: ${problems.map((p) => `${p.at ? `${p.at}: ` : ""}${p.message}`).join("; ")}`);
		return texture;
	}

	candidateRecords(cwd: string, name: string): Record<string, CandidateRecord> {
		const file = join(this.dir(cwd, name), "candidates/candidates.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	}

	/** New seamless candidates (two per seed: rolled and quilted), recorded; creates texture.json on the first run. */
	async candidates(ctx: PipelineContext, p: { name: string; prompt: string; count?: number; seed?: number }) {
		const dir = this.dir(ctx.cwd, p.name);
		const out = join(dir, "candidates");
		mkdirSync(out, { recursive: true });
		const count = Math.min(Math.max(Math.round(p.count ?? 2), 1), 4);
		const r = await this.step(ctx, "surface", `Surfaces for ${p.name}`, { prompt: p.prompt, out_dir: out, name: leafName(p.name), count, seed: p.seed });
		const images = r.images as string[];
		const records = this.candidateRecords(ctx.cwd, p.name);
		const at = new Date().toISOString();
		images.forEach((f, i) => {
			records[basename(f)] = { prompt: p.prompt, seed: (r.seeds as number[])[i], method: (r.methods as string[])[i], model: String(r.model), at };
		});
		writeFileSync(join(out, "candidates.json"), `${JSON.stringify(records, null, "\t")}\n`);
		const existing = this.read(ctx.cwd, p.name);
		if (!existing) writeFileSync(join(dir, "texture.json"), formatTexture({ prompt: p.prompt, tile: TEXTURE_DEFAULTS.tile }));
		return {
			candidates: images.map((f, i) => ({ source: `candidates/${basename(f)}`, seed: (r.seeds as number[])[i], method: (r.methods as string[])[i] })),
			sheet: this.dataUrl(r.sheet),
		};
	}

	/**
	 * Makes (or remakes) the texture: applies the changes to texture.json (validated), then writes the colour,
	 * normal and roughness maps from its chosen candidate. Returns the files and a preview for checking seams.
	 */
	async make(ctx: PipelineContext, p: { name: string; source?: string; tile?: number; normal_strength?: number; roughness?: [number, number]; notes?: string }) {
		const dir = this.dir(ctx.cwd, p.name);
		const current = this.read(ctx.cwd, p.name) ?? { tile: TEXTURE_DEFAULTS.tile };
		const next: TextureFile = { ...current };
		for (const k of ["source", "tile", "normal_strength", "roughness", "notes"] as const) if (p[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = p[k];
		const problems = validateTexture(next);
		if (problems.length) throw new TextureError(problems.map((x) => `${x.at}: ${x.message}`).join("; "));
		if (!next.source) throw new TextureError(`No candidate chosen for ${p.name}: pass source (one of its candidates/…png)`);
		const source = join(dir, next.source);
		if (!existsSync(source)) throw new TextureError(`${next.source} isn't in ${TEXTURES_DIR}/${p.name}/`);
		writeFileSync(join(dir, "texture.json"), formatTexture(next));
		const r = await this.step(ctx, "surface_make", `Maps for ${p.name}`, {
			source,
			out_dir: dir,
			name: leafName(p.name),
			normal_strength: next.normal_strength ?? TEXTURE_DEFAULTS.normal_strength,
			roughness: next.roughness ?? TEXTURE_DEFAULTS.roughness,
		});
		return {
			files: textureFiles(leafName(p.name)).map((f) => `${TEXTURES_DIR}/${p.name}/${f}`),
			tile: next.tile,
			preview: this.dataUrl(r.preview),
		};
	}

	private dataUrl(file: unknown): string | undefined {
		if (typeof file !== "string" || !existsSync(file)) return undefined;
		const url = `data:image/${file.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(file).toString("base64")}`;
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

/** The Textures section's requests (see studio-requests.ts). */
export function textureRequests(textures: TexturePipeline): StudioRequestHandlers {
	const step = (name: string, what: string) => ({ label: `Texture ${name}: ${what}`, scopes: [{ path: `${TEXTURES_DIR}/${name}` }] });
	return {
		generate_texture: handler((ctx, p: Parameters<TexturePipeline["candidates"]>[1]) => textures.candidates(ctx, p), (p) => step(p.name, "new candidates")),
		make_texture: handler((ctx, p: Parameters<TexturePipeline["make"]>[1]) => textures.make(ctx, p), (p) => step(p.name, "made")),
	};
}
