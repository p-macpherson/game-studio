import { leafName, nameFromPath } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseVoice } from "../../shared/voice";

/** A character's voice is a folder, `assets/voices/<name>/`; its `voice.json` stands for it as the module's asset. */
export const voices: ModuleInfo = {
	id: "voices",
	name: "Voice Lines",
	icon: "🗣️",
	roots: ["assets/voices"],
	extensions: ["/voice.json"],
	agentType: "voice-director",
	noun: "voice",
};

/** The voice's name from its asset path: its folder under assets/voices. */
export const voiceName = (assetPath: string) => nameFromPath("assets/voices", assetPath);

export function summarizeVoice(text: string, path: string): { title: string; excerpt: string } {
	const { voice, problems } = parseVoice(text);
	const n = voice?.lines.length ?? 0;
	const waiting = voice?.lines.filter((l) => !l.take).length ?? 0;
	const facts = voice ? [`${n} line${n === 1 ? "" : "s"}`, ...(waiting ? [`${waiting} without a take`] : [])] : [`${problems.length} problem${problems.length > 1 ? "s" : ""} in voice.json`];
	const excerpt = [voice?.notes ?? voice?.voice, facts.join(" · ")].filter(Boolean).join(" — ");
	return { title: leafName(voiceName(path)), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
