// Images pasted or dropped into a message box, waiting to be sent with it: a tray of thumbnails above the box, each
// removable. They are scaled down here (PASTED_IMAGE_SIDE) so the agent's context and the transcript stay small.
// Kept per box (a session's composer, the new-session prompt) while the studio is open, like an unsent draft.
import { useEffect, useState } from "react";
import { MAX_PASTED_IMAGES, PASTED_IMAGE_SIDE, PASTED_IMAGE_TYPES, type PastedImage } from "../../shared/attachments";
import { useStudio } from "../store";

interface Waiting extends PastedImage {
	id: number;
	/** A data URL for the thumbnail. */
	url: string;
}

const boxes = new Map<string, Waiting[]>();
const listeners = new Set<() => void>();
let nextId = 1;
const changed = () => {
	for (const l of listeners) l();
};

/** Decodes an image file and scales it to fit; a PNG stays a PNG (transparency, pixel art), anything else becomes a JPEG. */
async function prepare(file: Blob): Promise<Waiting> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, PASTED_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
	const url = canvas.toDataURL(mimeType, 0.9);
	return { id: nextId++, url, mimeType, data: url.slice(url.indexOf(",") + 1) };
}

const imagesIn = (data: DataTransfer | null): File[] => [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));

/**
 * The images waiting in the box called `key`. Spread `handlers` on the textarea (paste and drop); render `tray`
 * above it; `take()` hands them over for sending and empties the box.
 */
export function usePastedImages(key: string) {
	const [, redraw] = useState(0);
	useEffect(() => {
		const l = () => redraw((n) => n + 1);
		listeners.add(l);
		return () => void listeners.delete(l);
	}, []);
	const images = boxes.get(key) ?? [];

	const add = async (files: File[]) => {
		const { showError, notify } = useStudio.getState();
		for (const file of files) {
			if ((boxes.get(key) ?? []).length >= MAX_PASTED_IMAGES) {
				notify(`At most ${MAX_PASTED_IMAGES} images in one message`);
				break;
			}
			try {
				const image = await prepare(file);
				boxes.set(key, [...(boxes.get(key) ?? []), image]);
				changed();
			} catch {
				showError(`Couldn't read ${file.name || "the pasted image"} as an image (PNG, JPEG and WebP work)`);
			}
		}
	};
	const remove = (id: number) => {
		boxes.set(key, (boxes.get(key) ?? []).filter((i) => i.id !== id));
		changed();
	};
	const take = (): PastedImage[] => {
		const out = (boxes.get(key) ?? []).map(({ data, mimeType }) => ({ data, mimeType }));
		boxes.delete(key);
		changed();
		return out;
	};

	const handlers = {
		onPaste: (e: React.ClipboardEvent) => {
			const files = imagesIn(e.clipboardData);
			if (!files.length) return; // text: the box's own paste
			e.preventDefault();
			void add(files);
		},
		onDragOver: (e: React.DragEvent) => {
			if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
		},
		onDrop: (e: React.DragEvent) => {
			const files = imagesIn(e.dataTransfer);
			if (!files.length) return;
			e.preventDefault();
			void add(files);
		},
	};

	const tray = images.length > 0 && (
		<div className="pasted-tray" data-testid="pasted-tray">
			{images.map((i) => (
				<span key={i.id} className="pasted-image" data-testid="pasted-image">
					<img src={i.url} alt="" onClick={() => useStudio.getState().showImages(images.map((x, n) => ({ src: x.url, label: `Image ${n + 1}` })), images.indexOf(i))} />
					<button className="pasted-remove" onClick={() => remove(i.id)} title="Don't send this image" aria-label="Remove image" data-testid="pasted-remove">
						✕
					</button>
				</span>
			))}
		</div>
	);
	return { images, handlers, tray, take };
}

/** The file types a paste accepts, for hints. */
export const PASTE_HINT = `Paste or drop images (${Object.values(PASTED_IMAGE_TYPES).join(", ")}) to show them to the agent`;
