import { leafName, nameFromPath } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseSound } from "../../shared/sound";

/** A sound is a folder, `assets/sounds/<name>/`; its `sound.json` stands for it as the module's asset. */
export const sounds: ModuleInfo = {
	id: "sounds",
	name: "Sound Effects",
	icon: "🔊",
	roots: ["assets/sounds"],
	extensions: ["/sound.json"],
	agentType: "sound-designer",
	noun: "sound",
};

/** The sound's name from its asset path: its folder under assets/sounds (`ui/click` for `assets/sounds/ui/click/sound.json`). */
export const soundName = (assetPath: string) => nameFromPath("assets/sounds", assetPath);

export function summarizeSound(text: string, path: string): { title: string; excerpt: string } {
	const { sound, problems } = parseSound(text);
	const n = sound?.variants.length ?? 0;
	const facts = sound
		? [sound.loop ? "loop" : "one-shot", `${n} variant${n > 1 ? "s" : ""}`]
		: [`${problems.length} problem${problems.length > 1 ? "s" : ""} in sound.json`];
	const excerpt = [sound?.notes, facts.join(" · ")].filter(Boolean).join(" — ");
	return { title: leafName(soundName(path)), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
