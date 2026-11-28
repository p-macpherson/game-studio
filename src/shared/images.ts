// Images: any picture the project keeps in assets/images/ (concept art, map designs, UI mockups, mood boards, keyframes,
// or art the game shows), in folders that suit the project. A generated image carries how it was made inside the PNG
// itself (text chunks), so the record goes wherever the file is moved or renamed.

export const IMAGES_DIR = "assets/images";
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/** The shapes `generate_image` makes, in pixels (multiples of 16, about a megapixel: what FLUX.2 Klein does well). */
export const IMAGE_ASPECTS = {
	square: [1024, 1024],
	landscape: [1344, 768],
	portrait: [768, 1344],
	wide: [1536, 640],
} as const;
export type ImageAspect = keyof typeof IMAGE_ASPECTS;

/** How a generated image was made (the PNG's "game-studio" text chunk). */
export interface ImageRecord {
	prompt: string;
	seed?: number;
	model?: string;
	references?: string[];
	at?: string;
}

export interface ImageInfo {
	kind: "png" | "jpeg" | "webp" | "gif" | null;
	width?: number;
	height?: number;
	/** A PNG's text chunks (tEXt and uncompressed iTXt), e.g. "Description". */
	text: Record<string, string>;
	record?: ImageRecord;
}

const RECORD_KEY = "game-studio";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The image type, size and (for a PNG) text chunks, from the file's bytes; nothing is decoded. */
export function imageInfo(b: Uint8Array): ImageInfo {
	const text: Record<string, string> = {};
	if (b.length > 24 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
		const info: ImageInfo = { kind: "png", width: u32(b, 16), height: u32(b, 20), text };
		for (let at = 8; at + 8 <= b.length; ) {
			const len = u32(b, at);
			const type = ascii(b, at + 4, at + 8);
			const data = b.subarray(at + 8, at + 8 + len);
			if (type === "tEXt") {
				const nul = data.indexOf(0);
				if (nul > 0) text[ascii(data, 0, nul)] = new TextDecoder("latin1").decode(data.subarray(nul + 1));
			} else if (type === "iTXt") {
				// keyword \0 compression-flag compression-method language \0 translated-keyword \0 text
				const nul = data.indexOf(0);
				if (nul > 0 && data[nul + 1] === 0) {
					const lang = data.indexOf(0, nul + 3);
					const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1);
					if (translated >= 0) text[ascii(data, 0, nul)] = new TextDecoder().decode(data.subarray(translated + 1));
				}
			} else if (type === "IDAT" || type === "IEND") break; // text chunks that matter come first
			at += 12 + len;
		}
		try {
			if (text[RECORD_KEY]) info.record = JSON.parse(text[RECORD_KEY]) as ImageRecord;
		} catch {
			// a hand-edited chunk: shown as text only
		}
		return info;
	}
	if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		// The first start-of-frame marker holds the size.
		for (let at = 2; at + 9 < b.length; ) {
			if (b[at] !== 0xff) break;
			const marker = b[at + 1];
			if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
				at += 2;
				continue;
			}
			const len = (b[at + 2] << 8) | b[at + 3];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { kind: "jpeg", height: (b[at + 5] << 8) | b[at + 6], width: (b[at + 7] << 8) | b[at + 8], text };
			}
			at += 2 + len;
		}
		return { kind: "jpeg", text };
	}
	if (b.length > 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
		const chunk = ascii(b, 12, 16);
		if (chunk === "VP8 ") return { kind: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, text };
		if (chunk === "VP8L") {
			const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
			return { kind: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, text };
		}
		if (chunk === "VP8X") return { kind: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), text };
		return { kind: "webp", text };
	}
	if (b.length > 10 && ascii(b, 0, 3) === "GIF") return { kind: "gif", width: u16le(b, 6), height: u16le(b, 8), text };
	return { kind: null, text };
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(b: Uint8Array): number {
	let c = 0xffffffff;
	for (const v of b) c = CRC_TABLE[(c ^ v) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** An uncompressed iTXt chunk (UTF-8 text). */
function itxt(keyword: string, value: string): Uint8Array {
	const enc = new TextEncoder();
	const data = new Uint8Array([...enc.encode(keyword), 0, 0, 0, 0, 0, ...enc.encode(value)]);
	const typed = new Uint8Array([...enc.encode("iTXt"), ...data]);
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(typed, 4);
	view.setUint32(8 + data.length, crc32(typed));
	return out;
}

/**
 * The PNG with how it was made written into it, right after its header: "Description" (the prompt, which image viewers
 * show) and "game-studio" (the whole record as JSON). Chunks with those keywords already there are replaced.
 */
export function withImageRecord(png: Uint8Array, record: ImageRecord): Uint8Array {
	const info = imageInfo(png);
	if (info.kind !== "png") throw new Error("Only a PNG can carry how it was made");
	const kept: Uint8Array[] = [png.subarray(0, 8)];
	for (let at = 8; at + 8 <= png.length; ) {
		const len = u32(png, at);
		const type = ascii(png, at + 4, at + 8);
		const chunk = png.subarray(at, at + 12 + len);
		const data = chunk.subarray(8, 8 + len);
		const keyword = type === "tEXt" || type === "iTXt" ? ascii(data, 0, Math.max(0, data.indexOf(0))) : "";
		if (keyword !== RECORD_KEY && keyword !== "Description") kept.push(chunk);
		if (type === "IHDR") kept.push(itxt("Description", record.prompt), itxt(RECORD_KEY, JSON.stringify(record)));
		at += 12 + len;
	}
	const out = new Uint8Array(kept.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of kept) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/** "1024 × 768 PNG · 1.2 MB" */
export function describeImage(info: ImageInfo, bytes: number): string {
	const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
	const dims = info.width && info.height ? `${info.width} × ${info.height} ` : "";
	return `${dims}${(info.kind ?? "image").toUpperCase()} · ${size}`;
}
