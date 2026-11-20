import type { ModuleInfo } from "../../shared/modules";
import { parseSound, variantCount } from "../../shared/sound";

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

/** The sound's folder name from its asset path (`assets/sounds/<name>/sound.json`). */
export const soundName = (assetPath: string) => assetPath.split("/").at(-2) ?? assetPath;

export function summarizeSound(text: string, path: string): { title: string; excerpt: string } {
	const { sound, problems } = parseSound(text);
	const prompt = sound?.layers.find((l) => l.generate)?.generate?.prompt;
	const variants = sound ? variantCount(sound) : 0;
	const facts = sound
		? [sound.loop ? "loop" : "one-shot", variants > 1 && `${variants} variants`, sound.layers.length > 1 && `${sound.layers.length} layers`]
		: [`${problems.length} problem${problems.length > 1 ? "s" : ""} in sound.json`];
	const excerpt = [sound?.notes ?? prompt, facts.filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
	return { title: soundName(path), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
