import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { designDocRequests } from "./design-docs";
import { tempDir } from "./test-helpers";

const doc = "docs/design/Art Style.md";

function project() {
	const cwd = tempDir();
	mkdirSync(join(cwd, "docs/design"), { recursive: true });
	writeFileSync(join(cwd, doc), "---\nstatus: draft\n---\n# Art Style\n\n## Palette\nGreens.\n");
	return cwd;
}

function png(w: number, h: number): string {
	const out = join(tempDir(), "x.png");
	execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=green:s=${w}x${h}`, "-frames:v", "1", out]);
	return readFileSync(out).toString("base64");
}

const add = designDocRequests().add_doc_image!;
const run = (cwd: string, p: Record<string, unknown>) => add.run({ cwd, sessionId: "t" }, { path: doc, ...p }) as Promise<{ image: string; markdown: string }>;

describe("add_doc_image", () => {
	it("saves a reference image (scaled to 1600 px) in docs/design/references and links it in the References section", async () => {
		const cwd = project();
		const r = await run(cwd, { name: "Forest Glade.png", data: png(2000, 1000), caption: "palette and lighting" });
		expect(r).toEqual({ image: "docs/design/references/forest-glade.png", markdown: "![palette and lighting](references/forest-glade.png)" });
		const saved = readFileSync(join(cwd, r.image));
		expect([saved.readUInt32BE(16), saved.readUInt32BE(20)]).toEqual([1600, 800]);
		await run(cwd, { name: "forest glade.png", data: png(64, 64), caption: "props" });
		expect(existsSync(join(cwd, "docs/design/references/forest-glade-2.png"))).toBe(true);
		expect(readFileSync(join(cwd, doc), "utf8")).toContain(
			"## References\n![palette and lighting](references/forest-glade.png)\n![props](references/forest-glade-2.png)\n",
		);
	});

	it("refuses what isn't an image, and only returns the markdown when told not to insert it", async () => {
		const cwd = project();
		await expect(run(cwd, { name: "notes.png", data: Buffer.from("hello").toString("base64") })).rejects.toThrow(/isn't a PNG/);
		const before = readFileSync(join(cwd, doc), "utf8");
		const r = await run(cwd, { name: "a.png", data: png(32, 32), insert: false });
		expect(r.markdown).toBe("![a](references/a.png)");
		expect(readFileSync(join(cwd, doc), "utf8")).toBe(before);
	});
});
