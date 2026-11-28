import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { imageInfo, withImageRecord } from "../shared/images";
import { AssetService } from "./assets";
import { GenService } from "./gen";
import { addImages, addedName, ImagePipeline, imagePath, imageRequests } from "./images";
import type { SessionService } from "./sessions";
import { tempDir } from "./test-helpers";

const PNG = readFileSync(resolve("gen/workers/fixtures/concept.png"));
let services: GenService[] = [];
const fakeGen = () => {
	const gen = new GenService({ root: tempDir(), codeDir: resolve("gen"), emit: () => {}, fake: true });
	services.push(gen);
	return gen;
};
afterEach(async () => {
	await Promise.all(services.map((s) => s.dispose()));
	services = [];
});
/** Every chunk's checksum, against Node's own CRC-32: strict readers (Pillow) refuse a PNG with a bad one. */
const chunksValid = (png: Uint8Array) => {
	const b = Buffer.from(png);
	for (let at = 8; at < b.length; ) {
		const len = b.readUInt32BE(at);
		if (crc32(b.subarray(at + 4, at + 8 + len)) !== b.readUInt32BE(at + 8 + len)) return false;
		at += 12 + len;
	}
	return true;
};
/** ffmpeg decodes the whole file: the chunks written into a PNG must leave it a valid image. */
const decodes = (file: string) => {
	execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { stdio: "pipe" });
	return true;
};

describe("image files", () => {
	it("reads a PNG's size, and a record written into it comes back, replacing an older one, with the image still valid", () => {
		const before = imageInfo(PNG);
		expect(before.kind).toBe("png");
		expect(before.width).toBeGreaterThan(0);
		const once = withImageRecord(PNG, { prompt: "a knight — in ink", seed: 3, model: "fake" });
		const twice = withImageRecord(once, { prompt: "a knight, redrawn", seed: 4 });
		const info = imageInfo(twice);
		expect(info).toMatchObject({ kind: "png", width: before.width, height: before.height, record: { prompt: "a knight, redrawn", seed: 4 } });
		expect(info.text.Description).toBe("a knight, redrawn");
		expect(imageInfo(once).record?.prompt).toBe("a knight — in ink");
		const file = join(tempDir(), "x.png");
		writeFileSync(file, twice);
		expect(decodes(file)).toBe(true);
		expect(chunksValid(twice)).toBe(true);
	});

	it("reads JPEG, WebP and GIF sizes from their headers", () => {
		const dir = tempDir();
		for (const ext of ["jpg", "webp", "gif"]) {
			const file = join(dir, `x.${ext}`);
			execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=96x40", "-frames:v", "1", file]);
			expect(imageInfo(readFileSync(file)), ext).toMatchObject({ width: 96, height: 40 });
		}
	});
});

describe("Images", () => {
	it("generates one image at its path, or numbered variations, each carrying its prompt; refuses to write over one", async () => {
		const cwd = tempDir();
		const images = new ImagePipeline(fakeGen());
		const one = await images.generate({ cwd }, { path: "maps/harbour-town", prompt: "top-down map of a harbour town", aspect: "landscape", seed: 5 });
		expect(one.images).toEqual(["assets/images/maps/harbour-town.png"]);
		expect(one.size).toBe("1344 × 768");
		expect(one.sheet).toMatch(/^data:image\/png;base64,/);
		expect(imageInfo(readFileSync(join(cwd, one.images[0]))).record).toMatchObject({ prompt: "top-down map of a harbour town", seed: 5, model: "fake" });

		const many = await images.generate({ cwd }, { path: "assets/images/concept/knight.png", prompt: "a knight", count: 3, seed: 1 });
		expect(many.images).toEqual(["assets/images/concept/knight-1.png", "assets/images/concept/knight-2.png", "assets/images/concept/knight-3.png"]);
		expect(many.images.map((p) => imageInfo(readFileSync(join(cwd, p))).record?.seed)).toEqual([1, 2, 3]);

		await expect(images.generate({ cwd }, { path: "maps/harbour-town", prompt: "again" })).rejects.toThrow(/already exists/);
		await images.generate({ cwd }, { path: "maps/harbour-town", prompt: "again", replace: true });
		expect(imageInfo(readFileSync(join(cwd, "assets/images/maps/harbour-town.png"))).record?.prompt).toBe("again");
		expect(() => imagePath("Maps/Harbour Town")).toThrow(/lower-kebab-case/);
	});

	it("adds a person's files under tidy names without overwriting, refuses what isn't an image, and deletes", async () => {
		const cwd = tempDir();
		const data = PNG.toString("base64");
		expect(addImages(cwd, "ui/mockups", [{ name: "Main Menu v2.PNG", data }, { name: "Main Menu v2.png", data }])).toEqual([
			"assets/images/ui/mockups/main-menu-v2.png",
			"assets/images/ui/mockups/main-menu-v2-2.png",
		]);
		expect(addedName("photo.JPEG")).toBe("photo.jpg");
		expect(() => addImages(cwd, "", [{ name: "notes.png", data: Buffer.from("hello").toString("base64") }])).toThrow(/isn't a PNG/);
		expect(() => addImages(cwd, "Bad Folder", [{ name: "a.png", data }])).toThrow(/lower-kebab-case/);
		const del = imageRequests(new ImagePipeline(fakeGen())).delete_image!;
		await del.run({ cwd, sessionId: "s" }, { path: "assets/images/ui/mockups/main-menu-v2-2.png" });
		expect(existsSync(join(cwd, "assets/images/ui/mockups/main-menu-v2-2.png"))).toBe(false);
		expect(() => del.run({ cwd, sessionId: "s" }, { path: "assets/models/x/x.png" })).toThrow(/isn't an image/);
	});

	it("are listed in their section with size and prompt, found by either, and never read as text", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, "assets/images/concept"), { recursive: true });
		writeFileSync(join(cwd, "assets/images/concept/troll.png"), withImageRecord(PNG, { prompt: "a swamp troll with a lantern" }));
		const service = new AssetService(() => cwd, { worktreeChangedFiles: async () => [] } as unknown as SessionService);
		const [troll] = await service.list("images");
		expect(troll).toMatchObject({ path: "assets/images/concept/troll.png", title: "troll" });
		expect(troll.excerpt).toMatch(/^\d+ × \d+ PNG · \d+ KB · a swamp troll with a lantern$/);
		expect(service.search("images", "lantern").map((h) => h.path)).toEqual(["assets/images/concept/troll.png"]);
		expect(service.search("images", "concept/troll").length).toBe(1);
		expect(service.read("assets/images/concept/troll.png")).toBe("");
	});
});
