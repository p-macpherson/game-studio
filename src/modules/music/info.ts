import { leafName, nameFromPath } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { GM_PROGRAMS, parseSong, type Song } from "../../shared/song";

/** A piece is a folder, `assets/music/<name>/`; its score `song.json` stands for it as the module's asset. */
export const music: ModuleInfo = {
	id: "music",
	name: "Music",
	icon: "🎵",
	roots: ["assets/music"],
	extensions: ["/song.json"],
	agentType: "music-composer",
	noun: "piece",
};

/** The piece's name from its asset path: its folder under assets/music (`themes/goblin` for `assets/music/themes/goblin/song.json`). */
export const pieceName = (assetPath: string) => nameFromPath("assets/music", assetPath);

export const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

export function summarizeSong(text: string, path: string): { title: string; excerpt: string } {
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// A half-written score still lists, by folder name.
	}
	const song = json as Partial<Song> | null;
	const { timeline, errors } = json ? parseSong(json) : { timeline: null, errors: [{ at: "", message: "not valid JSON" }] };
	const instruments = Object.values(song?.instruments ?? {}).map((i) => (i.drums ? "drums" : typeof i.program === "number" ? GM_PROGRAMS[i.program] : i.program));
	const facts = [
		song?.key,
		song?.tempo && `${song.tempo} bpm`,
		instruments.length && `${instruments.join(", ")}`,
		timeline && `${formatTime(timeline.seconds)}${song?.loop === false ? "" : " loop"}`,
		errors.length && `${errors.length} problem${errors.length > 1 ? "s" : ""} in the score`,
	].filter(Boolean);
	const excerpt = [song?.style, facts.join(" · ")].filter(Boolean).join(" — ");
	return { title: song?.title || leafName(pieceName(path)), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
