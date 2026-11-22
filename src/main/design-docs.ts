// The design docs of a checkout: read for a session's design brief, and the Design Docs section's own steps
// (editing a doc, setting its status, adding reference images, adding the standard docs a project lacks).
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
	DESIGN_DOCS,
	DOC_ROOT,
	DOC_STATUSES,
	type DocStatus,
	REFERENCE_DIR,
	STATUS_LABEL,
	addDocImage,
	docPath,
	docTemplate,
	missingDocs,
	setDocStatus,
} from "../shared/design-docs";
import { safeJoin, walk } from "./assets";
import { type StudioRequestHandlers, handler } from "./studio-requests";

/** Every design doc of a checkout, with its text. */
export function readDesignDocs(root: string): { path: string; text: string }[] {
	return walk(join(root, DOC_ROOT), root)
		.filter((p) => p.toLowerCase().endsWith(".md"))
		.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** Writes the standard docs a checkout doesn't have yet; returns their paths. */
export function addStandardDocs(root: string): string[] {
	const missing = missingDocs(readDesignDocs(root).map((d) => d.path));
	for (const def of missing) {
		const file = join(root, docPath(def));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, docTemplate(def));
	}
	return missing.map(docPath);
}

function docFile(root: string, path: string, mustExist: boolean): string {
	if (!path.startsWith(`${DOC_ROOT}/`) || !path.toLowerCase().endsWith(".md")) throw new Error(`${path} isn't a design doc`);
	const file = safeJoin(root, path);
	if (mustExist && !existsSync(file)) throw new Error(`No design doc at ${path}`);
	return file;
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** The Design Docs section's steps (people's edits; agents edit the files themselves). */
export function designDocRequests(): StudioRequestHandlers {
	return {
		write_doc: handler(
			(ctx, p: { path: string; text: string }) => {
				const file = docFile(ctx.cwd, p.path, false);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, p.text.endsWith("\n") ? p.text : `${p.text}\n`);
				return { path: p.path };
			},
			(p) => ({ label: `Doc ${leaf(p.path)}: edited`, scopes: [{ path: p.path }] }),
		),
		set_doc_status: handler(
			(ctx, p: { path: string; status: DocStatus }) => {
				if (!DOC_STATUSES.includes(p.status)) throw new Error(`A doc's status is one of: ${DOC_STATUSES.join(", ")}`);
				const file = docFile(ctx.cwd, p.path, true);
				writeFileSync(file, setDocStatus(readFileSync(file, "utf8"), p.status));
				return { path: p.path, status: p.status };
			},
			(p) => ({ label: `Doc ${leaf(p.path)}: ${(STATUS_LABEL[p.status] ?? p.status).toLowerCase()}`, scopes: [{ path: p.path }] }),
		),
		// A reference image: saved in docs/design/references/ (scaled down if it's huge) and, unless `insert` is false,
		// added to the doc's References section. Returns the markdown that shows it.
		add_doc_image: handler(
			async (ctx, p: { path: string; name: string; data: string; caption?: string; insert?: boolean }) => {
				const file = docFile(ctx.cwd, p.path, true);
				const bytes = Buffer.from(p.data, "base64");
				const kind = imageKind(bytes);
				if (!kind) throw new Error(`${p.name} isn't a PNG, JPEG, WebP or GIF image`);
				// Photos stay JPEG; everything else becomes PNG (keeps transparency).
				const ext = kind === "jpeg" || kind === "webp" ? "jpg" : "png";
				const stem = (p.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reference").slice(0, 60);
				const dir = safeJoin(ctx.cwd, REFERENCE_DIR);
				mkdirSync(dir, { recursive: true });
				let name = `${stem}.${ext}`;
				for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem}-${i}.${ext}`;
				await saveScaled(bytes, kind, join(dir, name));
				const src = relative(dirname(file), join(dir, name)).split(sep).join("/");
				const caption = (p.caption ?? "").trim() || stem.replace(/-/g, " ");
				if (p.insert !== false) writeFileSync(file, addDocImage(readFileSync(file, "utf8"), src, caption));
				return { image: `${REFERENCE_DIR}/${name}`, markdown: `![${caption}](${src.split("/").map(encodeURIComponent).join("/")})` };
			},
			(p) => ({ label: `Doc ${leaf(p.path)}: reference image added`, scopes: [{ path: p.path }, { path: REFERENCE_DIR }] }),
		),
		add_standard_docs: handler(
			(ctx) => ({ added: addStandardDocs(ctx.cwd) }),
			() => ({ label: "Added the standard design docs", scopes: DESIGN_DOCS.map((d) => ({ path: docPath(d) })) }),
		),
	};
}

/** The image type from a file's first bytes. */
export function imageKind(b: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
	if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return "png";
	if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
	if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
	if (b.length > 6 && b.toString("ascii", 0, 3) === "GIF") return "gif";
	return null;
}

/** Reference images are for looking at: at most 1600 px on the long side keeps the repo (and agents' context) small. */
const MAX_SIDE = 1600;

async function saveScaled(bytes: Buffer, kind: string, out: string): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), "gs-ref-"));
	try {
		const input = join(tmp, `in.${kind}`);
		writeFileSync(input, bytes);
		const scale = `scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'`;
		const args = ["-v", "error", "-y", "-i", input, "-frames:v", "1", "-vf", scale, ...(out.endsWith(".jpg") ? ["-q:v", "3"] : []), out];
		await new Promise<void>((resolve) => execFile("ffmpeg", args, (err) => (err ? (copyFileSync(input, out), resolve()) : resolve())));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
