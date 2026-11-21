// UI (M10): screens (assets/ui/<name>.json, src/shared/ui-screen.ts) edited by id, and UI art (assets/ui/art/<name>/,
// src/shared/ui-art.ts) generated with FLUX.2 Klein on a plain background, then cut out, mirrored and sliced on the CPU
// (gen/workers/ui_art.py). See the vault note "M10 UI".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import type { GenJobKind } from "../shared/gen";
import { formatUiArt, parseUiArt, UI_ART_FRAMING, UI_ART_KINDS, type UiArtFile, type UiArtKind, uiArtPrompt, validateUiArt } from "../shared/ui-art";
import { applyUiEdits, describeUiEdit, formatUiScreen, parseUiScreen, type UiEdit, type UiScreen } from "../shared/ui-screen";
import { safeJoin } from "./assets";
import type { GenService } from "./gen";
import { handler, type PipelineContext, type StudioRequestHandlers } from "./studio-requests";

export const UI_DIR = "assets/ui";
export const UI_ART_DIR = "assets/ui/art";

export class UiError extends Error {}

const checkName = (name: string, what: string) => {
	if (!ASSET_NAME.test(name)) throw new UiError(`${what} names are lower-kebab-case, with "/" for folders (e.g. "pause", "menus/title"), not "${name}"`);
};

/** A screen's file in a checkout. */
export function screenFile(cwd: string, name: string): string {
	checkName(name, "Screen");
	if (name === "art" || name.startsWith("art/")) throw new UiError('"art" holds UI art, not screens: pick another name');
	return safeJoin(cwd, `${UI_DIR}/${name}.json`);
}

/** Reads and validates a screen (assets are checked against the checkout). */
export function readScreen(cwd: string, name: string): { screen: UiScreen | null; problems: string[] } {
	const file = screenFile(cwd, name);
	if (!existsSync(file)) throw new UiError(`No ${UI_DIR}/${name}.json yet`);
	const { screen, problems } = parseUiScreen(readFileSync(file, "utf8"), { exists: (p) => existsSync(safeJoin(cwd, `assets/${p}`)) });
	return { screen, problems: problems.map((p) => `${p.at ? `${p.at}: ` : ""}${p.message}`) };
}

/** Applies structured edits to a screen (creating it when `create` and missing) and writes it formatted. */
export function editScreen(cwd: string, p: { screen: string; edits: UiEdit[]; create?: boolean }): { problems: string[] } {
	const file = screenFile(cwd, p.screen);
	let screen: UiScreen;
	if (!existsSync(file)) {
		if (!p.create) throw new UiError(`No ${UI_DIR}/${p.screen}.json: pass create: true to start it`);
		screen = { elements: [] };
	} else {
		const r = parseUiScreen(readFileSync(file, "utf8"));
		if (!r.screen) throw new UiError(`${UI_DIR}/${p.screen}.json can't be edited until it's fixed: ${r.problems.map((x) => x.message).join("; ")}`);
		screen = r.screen;
	}
	const next = applyUiEdits(screen, p.edits);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, formatUiScreen(next));
	return { problems: readScreen(cwd, p.screen).problems };
}

export class UiArtPipeline {
	constructor(private readonly gen: GenService) {}

	dir(cwd: string, name: string): string {
		checkName(name, "UI art");
		return safeJoin(cwd, `${UI_ART_DIR}/${name}`);
	}

	private assetFile(cwd: string, name: string): string {
		return join(this.dir(cwd, name), `${leafName(name)}.json`);
	}

	read(cwd: string, name: string): UiArtFile | null {
		const file = this.assetFile(cwd, name);
		if (!existsSync(file)) return null;
		const { art, problems } = parseUiArt(readFileSync(file, "utf8"));
		if (!art) throw new UiError(`${leafName(name)}.json has problems: ${problems.map((p) => `${p.at ? `${p.at}: ` : ""}${p.message}`).join("; ")}`);
		return art;
	}

	/** New candidates: generated on the GPU, then cut out (and made symmetric for frames and buttons) on the CPU. */
	async candidates(ctx: PipelineContext, p: { name: string; kind: UiArtKind; prompt: string; style?: string; count?: number; seed?: number }) {
		if (!UI_ART_KINDS.includes(p.kind)) throw new UiError(`kind is one of ${UI_ART_KINDS.join(", ")}`);
		const existing = this.read(ctx.cwd, p.name);
		if (existing && existing.kind !== p.kind) throw new UiError(`${p.name} is a ${existing.kind}, not a ${p.kind}`);
		const dir = this.dir(ctx.cwd, p.name);
		const out = join(dir, "candidates");
		mkdirSync(out, { recursive: true });
		const raw = mkdtempSync(join(tmpdir(), "gs-ui-art-"));
		try {
			const count = Math.min(Math.max(Math.round(p.count ?? 3), 1), 4);
			const { width, height } = UI_ART_FRAMING[p.kind];
			const prompt = uiArtPrompt(p.kind, p.prompt, p.style);
			const g = await this.step(ctx, "image", `UI art for ${p.name}`, { prompt, raw_prompt: true, out_dir: raw, name: leafName(p.name), count, seed: p.seed, width, height });
			const c = await this.step(ctx, "ui_cut", `Cutting out ${p.name}`, { images: g.images, out_dir: out, kind: p.kind, mirror: existing?.mirror ?? p.kind !== "icon" });
			const records = this.candidateRecords(ctx.cwd, p.name);
			const at = new Date().toISOString();
			const candidates = (c.candidates as { file: string; slice: number[] }[]).map((x, i) => {
				const file = basename(x.file);
				records[file] = { prompt: p.prompt, style: p.style, seed: (g.seeds as number[])[i], model: String(g.model), slice: x.slice, at };
				return { source: `candidates/${file}`, seed: (g.seeds as number[])[i], slice: x.slice };
			});
			writeFileSync(join(out, "candidates.json"), `${JSON.stringify(records, null, "\t")}\n`);
			if (!existing) writeFileSync(this.assetFile(ctx.cwd, p.name), formatUiArt({ kind: p.kind, prompt: p.prompt }));
			return { candidates, sheet: this.dataUrl(c.sheet) };
		} finally {
			rmSync(raw, { recursive: true, force: true });
		}
	}

	candidateRecords(cwd: string, name: string): Record<string, unknown> {
		const file = join(this.dir(cwd, name), "candidates/candidates.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	}

	/**
	 * Makes (or remakes) the piece from its chosen candidate: <leaf>.png, and its slice insets in <leaf>.json (the
	 * candidate's detected ones unless given). Returns the engine path screens use, the insets and a preview.
	 */
	async make(ctx: PipelineContext, p: { name: string; source?: string; slice?: [number, number, number, number]; notes?: string; mirror?: boolean }) {
		const current = this.read(ctx.cwd, p.name);
		if (!current) throw new UiError(`No UI art "${p.name}" yet: generate candidates first (generate_ui_art)`);
		const next: UiArtFile = { ...current };
		for (const k of ["source", "slice", "notes", "mirror"] as const) if (p[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = p[k];
		if (p.source !== undefined && p.slice === undefined) delete next.slice; // a new candidate: its own insets
		const problems = validateUiArt(next);
		if (problems.length) throw new UiError(problems.map((x) => `${x.at}: ${x.message}`).join("; "));
		if (!next.source) throw new UiError(`No candidate chosen for ${p.name}: pass source (one of its candidates/…png)`);
		const dir = this.dir(ctx.cwd, p.name);
		const source = join(dir, next.source);
		if (!existsSync(source)) throw new UiError(`${next.source} isn't in ${UI_ART_DIR}/${p.name}/`);
		const r = await this.step(ctx, "ui_make", `Making ${p.name}`, { source, out_dir: dir, name: leafName(p.name), kind: next.kind, slice: next.slice });
		const slice = r.slice as number[];
		if (next.kind !== "icon") next.slice = slice as [number, number, number, number];
		writeFileSync(this.assetFile(ctx.cwd, p.name), formatUiArt(next));
		return { file: `ui/art/${p.name}/${leafName(p.name)}.png`, kind: next.kind, slice: next.kind === "icon" ? undefined : slice, preview: this.dataUrl(r.preview) };
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

export type UiPreview = (sessionId: string, p: { screen: string; values?: Record<string, unknown> }) => Promise<unknown>;

/** The UI section's requests and the agents' UI tools (see studio-requests.ts). */
export function uiRequests(art: UiArtPipeline, preview?: UiPreview): StudioRequestHandlers {
	const artStep = (name: string, what: string) => ({ label: `UI art ${name}: ${what}`, scopes: [{ path: `${UI_ART_DIR}/${name}` }] });
	return {
		generate_ui_art: handler((ctx, p: Parameters<UiArtPipeline["candidates"]>[1]) => art.candidates(ctx, p), (p) => artStep(p.name, "new candidates")),
		make_ui_art: handler((ctx, p: Parameters<UiArtPipeline["make"]>[1]) => art.make(ctx, p), (p) => artStep(p.name, "made")),
		edit_ui: handler(
			(ctx, p: { screen: string; edits: UiEdit[]; create?: boolean }) => editScreen(ctx.cwd, p),
			(p) => ({ label: `Screen ${p.screen}: ${[...new Set((p.edits ?? []).map(describeUiEdit))].join(", ") || "edited"}`, scopes: [{ path: `${UI_DIR}/${p.screen}.json` }] }),
		),
		preview_ui: handler((ctx, p: { screen: string; values?: Record<string, unknown> }) => {
			if (!preview) throw new UiError("Screen previews aren't available here");
			return preview(ctx.sessionId, p);
		}),
	};
}

