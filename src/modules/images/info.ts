import type { ModuleInfo } from "../../shared/modules";
import { describeImage, IMAGE_EXTENSIONS, IMAGES_DIR, imageInfo } from "../../shared/images";

/**
 * Images: concept art, map designs, UI mockups and any other picture the project keeps, in assets/images/<folders>/,
 * the folders chosen to suit the project. Mostly for planning; one the game loads ships like any other asset.
 */
export const images: ModuleInfo = {
	id: "images",
	name: "Images",
	icon: "🖼️",
	roots: [IMAGES_DIR],
	extensions: IMAGE_EXTENSIONS,
	agentType: "concept-artist",
	noun: "image",
};

/** "knight" from assets/images/concept/characters/knight.png (the folders show in the tree). */
export const imageTitle = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

export function summarizeImage(bytes: Uint8Array, path: string): { title: string; excerpt: string } {
	const info = imageInfo(bytes);
	const about = info.record?.prompt ?? info.text.Description ?? "";
	return { title: imageTitle(path), excerpt: [describeImage(info, bytes.length), about].filter(Boolean).join(" · ") };
}
