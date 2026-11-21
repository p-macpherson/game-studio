// The design docs of a checkout: read for a session's design brief, and the Design Docs section's own steps
// (editing a doc, setting its status, adding the standard docs a project lacks).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DESIGN_DOCS, DOC_ROOT, DOC_STATUSES, type DocStatus, STATUS_LABEL, docPath, docTemplate, missingDocs, setDocStatus } from "../shared/design-docs";
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
		add_standard_docs: handler(
			(ctx) => ({ added: addStandardDocs(ctx.cwd) }),
			() => ({ label: "Added the standard design docs", scopes: DESIGN_DOCS.map((d) => ({ path: docPath(d) })) }),
		),
	};
}
