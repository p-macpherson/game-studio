// Moving and renaming a section's assets (or folders of them) in a checkout, keeping the game working: the files
// move, a renamed folder-shaped asset's own files follow its new name (barrel.glb → cask.glb), and every reference is
// rewritten: quoted paths in the project's JSON, game code and tests (as the engine loads them, from assets/, or from
// the repo root), file names inside the asset's own JSON (render.json), and relative links between markdown docs.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { leafName, nameFromPath } from "../shared/asset-names";
import type { ModuleInfo, MoveResult } from "../shared/modules";
import { safeJoin } from "./assets";

const PART = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_PART = /^[\w][\w .-]*$/;
/** Where references can be: the game's data, code, tests and docs. */
const SCANNED = [/^assets\/.*\.json$/, /^game\/.*\.(odin|json|jsonl)$/, /^tests\/.*\.(jsonl|json|odin)$/, /^docs\/.*\.md$/];
const CODE = /^(game|tests)\//;

/**
 * Moves `from` to `to` (repo-relative) inside one root of the section, in the checkout at `root`: an asset (its
 * file, or its manifest standing for its folder) or a folder of assets. Throws, changing nothing, if the target
 * exists, leaves the root, nests an asset inside another, or changes a file's type.
 */
export function moveAsset(root: string, info: ModuleInfo, from: string, to: string): MoveResult {
	const manifest = info.extensions.every((e) => e.startsWith("/")) ? info.extensions[0].slice(1) : null;
	const base = info.roots.find((r) => from === r || from.startsWith(`${r}/`));
	if (!base || from === base) throw new Error(`${from} isn't in ${info.name}`);
	if (to !== base && !to.startsWith(`${base}/`)) throw new Error(`${to} has to stay in ${base}/`);
	if (to === from) throw new Error("That's where it already is");
	const fromFull = safeJoin(root, from);
	if (!existsSync(fromFull)) throw new Error(`${from} doesn't exist`);
	// A folder-shaped asset moves as its folder.
	const isAsset = !!manifest && from.endsWith(`/${manifest}`);
	if (isAsset && !to.endsWith(`/${manifest}`)) throw new Error(`A ${info.noun} is a folder with its ${manifest}`);
	const src = isAsset ? dirname(from) : from;
	const dst = isAsset ? dirname(to) : to;
	if (dst === base || dst.startsWith(`${src}/`)) throw new Error("A folder can't move into itself");
	if (existsSync(safeJoin(root, dst))) throw new Error(`${dst} already exists`);
	const folder = statSync(safeJoin(root, src)).isDirectory();
	const parts = dst.slice(base.length + 1).split("/");
	if (manifest) {
		if (!parts.every((p) => PART.test(p))) throw new Error(`Names are lower-kebab-case, with "/" for folders, not "${parts.join("/")}"`);
		// No asset inside another: no folder on the way may be an asset.
		for (let i = 1; i < parts.length; i++) {
			const up = [base, ...parts.slice(0, i)].join("/");
			if (existsSync(safeJoin(root, `${up}/${manifest}`))) throw new Error(`${up} is a ${info.noun}: ${info.noun}s can't go inside it`);
		}
	} else {
		if (!parts.every((p) => FILE_PART.test(p) && p !== "." && p !== "..")) throw new Error(`"${parts.join("/")}" isn't a valid path`);
		const ext = (p: string) => p.slice(p.lastIndexOf("."));
		if (!folder && ext(src).toLowerCase() !== ext(dst).toLowerCase()) throw new Error(`Keep the ${ext(src)} extension`);
	}

	// Every file and where it goes.
	const moves = new Map<string, string>();
	if (folder) for (const f of walk(safeJoin(root, src))) moves.set(`${src}/${f}`, `${dst}/${f}`);
	else moves.set(src, dst);
	// A renamed asset's own files named after it follow (barrel.glb, footstep-2.ogg; not concepts/ or takes/).
	const renamed = new Map<string, string>();
	if (isAsset && leafName(src) !== leafName(dst)) {
		const [was, now] = [leafName(src), leafName(dst)];
		const named = new RegExp(`^${was}(-\\d+)?\\.[^/]+$`);
		for (const [a, b] of moves) {
			const file = b.slice(dst.length + 1);
			if (!file.includes("/") && named.test(file)) {
				const next = now + file.slice(was.length);
				moves.set(a, `${dst}/${next}`);
				renamed.set(file, next);
			}
		}
	}

	for (const [a, b] of moves) {
		mkdirSync(dirname(safeJoin(root, b)), { recursive: true });
		renameSync(safeJoin(root, a), safeJoin(root, b));
	}
	if (folder) removeEmpty(safeJoin(root, src));
	for (let d = dirname(src); d !== base && d.startsWith(`${base}/`); d = dirname(d)) removeEmpty(safeJoin(root, d), false);

	const updated = new Set<string>();
	const write = (path: string, before: string, after: string) => {
		if (after === before) return;
		writeFileSync(safeJoin(root, path), after);
		updated.add(path);
	};
	// A moved manifest's "name" follows its folder.
	if (manifest) {
		for (const b of moves.values()) {
			if (!b.endsWith(`/${manifest}`)) continue;
			const text = readFileSync(safeJoin(root, b), "utf8");
			write(b, text, text.replace(/^(\s*"name":\s*)"[^"\n]*"/m, (_, key) => key + JSON.stringify(nameFromPath(base, b))));
		}
	}
	// Inside the renamed asset: its JSON naming its own files (render.json's list).
	if (renamed.size) {
		for (const b of moves.values()) {
			if (!b.endsWith(".json") || b.slice(dst.length + 1).includes("/")) continue;
			const text = readFileSync(safeJoin(root, b), "utf8");
			write(b, text, text.replace(/"([^"\n]+)"/g, (m, s: string) => (renamed.has(s) ? JSON.stringify(renamed.get(s)) : m)));
		}
	}
	// Quoted paths everywhere: as the engine loads them (from assets/) and from the repo root.
	const quoted = new Map<string, string>();
	for (const [a, b] of moves) {
		quoted.set(a, b);
		if (a.startsWith("assets/")) quoted.set(a.slice(7), b.slice(7));
	}
	const back = new Map([...moves].map(([a, b]) => [b, a]));
	const scanned = ["assets", "game", "tests", "docs"].flatMap((d) => walk(join(root, d), `${d}/`)).filter((p) => SCANNED.some((r) => r.test(p)));
	for (const path of scanned) {
		const text = readFileSync(safeJoin(root, path), "utf8");
		let next = text.replace(/"([^"\n]+)"/g, (m, s: string) => (quoted.has(s) ? JSON.stringify(quoted.get(s)) : m));
		if (path.endsWith(".md")) next = relinkMarkdown(next, back.get(path) ?? path, path, moves);
		write(path, text, next);
	}
	const code = [...moves.values(), ...updated].some((p) => CODE.test(p));
	return { to: isAsset ? `${dst}/${manifest}` : dst, files: moves.size, updated: [...updated].sort(), code };
}

/** Relative markdown links `](target)` of a doc that was at `was` and is now at `now`, after `moves`. */
function relinkMarkdown(text: string, was: string, now: string, moves: Map<string, string>): string {
	return text.replace(/\]\(([^)\s]+)\)/g, (m, link: string) => {
		if (/^([a-z]+:|#|\/)/i.test(link)) return m;
		const [target, anchor = ""] = link.split(/(?=#)/);
		const old = posix.normalize(posix.join(posix.dirname(was), decodeURI(target)));
		const dest = moves.get(old) ?? old;
		const rel = posix.relative(posix.dirname(now), dest);
		return rel === posix.normalize(decodeURI(target)) ? m : `](${encodeURI(rel)}${anchor})`;
	});
}

/** Files under `dir`, relative to it, skipping dot-folders (.git, .studio). */
function walk(dir: string, prefix = ""): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.name.startsWith(".") && e.isDirectory() ? [] : e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
	);
}

/** Removes empty folders under (and including) `dir`; with `deep` false, only `dir` itself if it's empty. */
function removeEmpty(dir: string, deep = true): void {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
	if (deep) for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmpty(join(dir, e.name));
	if (readdirSync(dir).length === 0) rmdirSync(dir);
}

