// Images (assets/images/): generating them with the local image model (FLUX.2 Klein, the image worker's `image` job,
// no added style), adding a person's own files, and removing them. A generated PNG carries its prompt and seed inside
// it (shared/images.ts), so the record follows the file through moves and renames.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ASSET_NAME } from "../shared/asset-names";
import { IMAGE_ASPECTS, IMAGE_EXTENSIONS, IMAGES_DIR, type ImageAspect, imageInfo, withImageRecord } from "../shared/images";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export interface GenerateImageParams {
	/** Where under assets/images/, without the extension: "concept/characters/knight". */
	path: string;
	prompt: string;
	count?: number;
	aspect?: ImageAspect;
	references?: string[];
	seed?: number;
	/** Write over images already at those paths. */
	replace?: boolean;
}

/** The image's path under assets/images/ ("concept/knight" or "assets/images/concept/knight.png"), checked. */
export function imagePath(path: string): string {
	const name = path.replace(/^\.?\/+/, "").replace(new RegExp(`^${IMAGES_DIR}/`), "").replace(/\.(png|jpe?g|webp|gif)$/i, "");
	if (!ASSET_NAME.test(name)) throw new Error(`Image paths are lower-kebab-case folders and a name under ${IMAGES_DIR}/, e.g. "concept/characters/knight", not "${path}"`);
	return name;
}

/** What `count` images at `name` are called: `name.png` alone, else `name-1.png`, `name-2.png`… */
export const generatedNames = (name: string, count: number) => (count === 1 ? [`${name}.png`] : Array.from({ length: count }, (_, i) => `${name}-${i + 1}.png`));

export class ImagePipeline {
	constructor(private readonly gen: GenService) {}

	async generate(ctx: PipelineContext, p: GenerateImageParams): Promise<{ images: string[]; seeds: number[]; size: string; sheet?: string }> {
		const name = imagePath(p.path);
		const count = Math.min(Math.max(Math.round(p.count ?? 1), 1), 8);
		const aspect = p.aspect ?? "square";
		const dims = IMAGE_ASPECTS[aspect];
		if (!dims) throw new Error(`aspect is one of ${Object.keys(IMAGE_ASPECTS).join(", ")}`);
		const targets = generatedNames(name, count).map((f) => `${IMAGES_DIR}/${f}`);
		const taken = targets.filter((t) => existsSync(safeJoin(ctx.cwd, t)));
		if (taken.length && !p.replace) throw new Error(`${taken.join(", ")} already exist${taken.length === 1 ? "s" : ""}: choose another path, or pass replace: true to write over ${taken.length === 1 ? "it" : "them"}`);
		const references = (p.references ?? []).map((r) => {
			const full = safeJoin(ctx.cwd, r);
			if (!existsSync(full)) throw new Error(`${r} doesn't exist`);
			return full;
		});
		const tmp = mkdtempSync(join(tmpdir(), "gs-images-"));
		try {
			let last = "";
			const label = `Image ${name}`;
			const r = await this.gen.run(
				"image",
				{ prompt: p.prompt, raw_prompt: true, out_dir: tmp, name: "image", count, seed: p.seed, references, width: dims[0], height: dims[1] },
				{
					label,
					sessionId: ctx.sessionId,
					onProgress: (job) => {
						if (job.status === "running" && ctx.onJob) ctx.onJob(job);
						const text = `${label}: ${job.progress?.message ?? job.status}`;
						if (text !== last) ctx.progress?.((last = text));
					},
				},
			);
			const made = r.images as string[];
			const seeds = r.seeds as number[];
			const at = new Date().toISOString();
			made.forEach((file, i) => {
				const out = safeJoin(ctx.cwd, targets[i]);
				mkdirSync(dirname(out), { recursive: true });
				const record = { prompt: p.prompt, seed: seeds[i], model: String(r.model), ...(p.references?.length ? { references: p.references } : {}), at };
				writeFileSync(out, withImageRecord(readFileSync(file), record));
			});
			let sheet: string | undefined;
			if (typeof r.sheet === "string" && existsSync(r.sheet)) {
				sheet = `data:image/${r.sheet.endsWith(".png") ? "png" : "jpeg"};base64,${readFileSync(r.sheet).toString("base64")}`;
				rmSync(r.sheet, { force: true });
			}
			return { images: targets.slice(0, made.length), seeds, size: `${dims[0]} × ${dims[1]}`, sheet };
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}

/** A file name made safe: lower-case words joined by hyphens, its image extension kept. */
export function addedName(file: string): string {
	const ext = (file.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
	const stem = file.slice(0, file.length - ext.length).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "image";
	return `${stem}${ext === ".jpeg" ? ".jpg" : ext}`;
}

/** A person's own pictures, copied into a folder of assets/images/ as they are (a name already taken gets -2, -3…). */
export function addImages(cwd: string, folder: string, files: { name: string; data: string }[]): string[] {
	const dir = folder.replace(/^\/+|\/+$/g, "");
	if (dir && !ASSET_NAME.test(dir)) throw new Error(`Folders are lower-kebab-case, e.g. "concept/characters", not "${folder}"`);
	const base = dir ? `${IMAGES_DIR}/${dir}` : IMAGES_DIR;
	mkdirSync(safeJoin(cwd, base), { recursive: true });
	return files.map((f) => {
		const bytes = Buffer.from(f.data, "base64");
		if (!imageInfo(bytes).kind) throw new Error(`${f.name} isn't a PNG, JPEG, WebP or GIF image`);
		const name = addedName(f.name);
		if (!IMAGE_EXTENSIONS.some((e) => name.endsWith(e))) throw new Error(`${f.name} needs one of ${IMAGE_EXTENSIONS.join(", ")} as its extension`);
		const ext = name.slice(name.lastIndexOf("."));
		const stem = name.slice(0, -ext.length);
		let out = `${base}/${name}`;
		for (let i = 2; existsSync(safeJoin(cwd, out)); i++) out = `${base}/${stem}-${i}${ext}`;
		writeFileSync(safeJoin(cwd, out), bytes);
		return out;
	});
}

/** The Images section's requests: generate_image (agents' tool too), add_images and delete_image (a person's). */
export function imageRequests(pipeline: ImagePipeline): StudioRequestHandlers {
	const folderOf = (name: string) => (name.includes("/") ? `${IMAGES_DIR}/${name.slice(0, name.lastIndexOf("/"))}` : IMAGES_DIR);
	return {
		generate_image: handler(
			(ctx, p: GenerateImageParams) => pipeline.generate(ctx, p),
			(p) => ({ label: `Image ${p.path}: generated`, scopes: [{ path: folderOf(imagePath(p.path)) }] }),
		),
		add_images: handler(
			(ctx, p: { folder: string; files: { name: string; data: string }[] }) => ({ images: addImages(ctx.cwd, p.folder, p.files) }),
			(p) => ({ label: `Images: ${p.files.length === 1 ? p.files[0].name : `${p.files.length} images`} added`, scopes: [{ path: p.folder ? `${IMAGES_DIR}/${p.folder}` : IMAGES_DIR }] }),
		),
		delete_image: handler(
			(ctx, p: { path: string }) => {
				if (!p.path.startsWith(`${IMAGES_DIR}/`) || !IMAGE_EXTENSIONS.some((e) => p.path.toLowerCase().endsWith(e))) throw new Error(`${p.path} isn't an image in ${IMAGES_DIR}/`);
				const full = safeJoin(ctx.cwd, p.path);
				if (!existsSync(full)) throw new Error(`${p.path} doesn't exist`);
				rmSync(full);
				return { deleted: p.path };
			},
			(p) => ({ label: `Image ${p.path.slice(IMAGES_DIR.length + 1)}: deleted`, scopes: [{ path: p.path }] }),
		),
	};
}
