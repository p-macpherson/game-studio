import { leafName, nameFromPath } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { GM_PROGRAMS, parseSong, type Song, type Timeline } from "../../shared/song";

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

/** The General MIDI families, 8 programs each, in program order: how the instrument picker groups them. */
export const GM_FAMILIES = ["Piano", "Chromatic percussion", "Organ", "Guitar", "Bass", "Strings", "Ensemble", "Brass", "Reed", "Pipe", "Synth lead", "Synth pad", "Synth effects", "World", "Percussive", "Sound effects"];

/** A new track's id from its instrument ("string ensemble 1" → "string-ensemble"), unique among `taken`. */
export function trackIdFor(instrument: string, taken: string[]): string {
	const base = instrument.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "part";
	let id = base;
	for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
	return id;
}

/** Absolute bars `from`-`to` (1-based, inclusive) as the arrangement entries they fall in, with each section's own bars. */
export function barsInSections(timeline: Timeline, from: number, to: number): { section: string; entry: number; first: number; last: number; at: number }[] {
	const out: { section: string; entry: number; first: number; last: number; at: number }[] = [];
	timeline.sections.forEach((s, entry) => {
		const start = s.tick / timeline.ticksPerBar + 1;
		const end = start + s.ticks / timeline.ticksPerBar - 1;
		const lo = Math.max(from, start);
		const hi = Math.min(to, end);
		if (lo <= hi) out.push({ section: s.name, entry, first: lo - start + 1, last: hi - start + 1, at: lo });
	});
	return out;
}

const songPath = (name: string) => `assets/music/${name}/song.json`;
const userNotes = (feedback?: string) => (feedback?.trim() ? `\n\nThe user's feedback, in their words:\n> ${feedback.trim().replace(/\n/g, "\n> ")}` : "");
const closing = (name: string) =>
	`\n\nRender it with render_song {"name": "${name}"} and check the summary (notes, ranges) against what was asked. Reply with what you changed and why, in a few sentences.`;

/**
 * The Music Composer's brief for rewriting one track: everywhere, or only absolute bars `range`. Bars belong to
 * sections, and a section listed more than once in the arrangement shares its patterns; a pattern shorter than its
 * section repeats. Both are spelled out, so the composer changes what the user picked and nothing else.
 */
export function recomposeBrief(p: { name: string; song: Song; timeline: Timeline; track: string; range?: { from: number; to: number }; feedback?: string }): string {
	const inst = p.song.instruments[p.track];
	const sound = inst?.drums ? "drums" : typeof inst?.program === "number" ? GM_PROGRAMS[inst.program] : inst?.program;
	const keep = "Keep every other track, the form (sections and arrangement), tempo, key and meter exactly as they are.";
	if (!p.range) {
		return `Recompose the \`${p.track}\` part (${sound}) of ${songPath(p.name)} across the whole piece: rewrite its pattern in every section (sections.*.tracks.${p.track}). ${keep}${userNotes(p.feedback)}${closing(p.name)}`;
	}
	const parts = barsInSections(p.timeline, p.range.from, p.range.to);
	const lines = parts.map((x) => {
		const repeats = p.timeline.sections
			.map((s, i) => ({ s, i }))
			.filter(({ s, i }) => s.name === x.section && i !== x.entry)
			.map(({ s }) => `bar ${s.tick / p.timeline.ticksPerBar + 1}`);
		const sectionBars = p.song.sections[x.section]?.bars ?? 0;
		const span = x.first === x.last ? `bar ${x.first}` : `bars ${x.first}-${x.last}`;
		return `- section "${x.section}", its ${span} of ${sectionBars} (piece bar ${x.at}${x.first === x.last ? "" : `-${x.at + x.last - x.first}`})${repeats.length ? `. "${x.section}" also plays at ${repeats.join(", ")}: its pattern is shared, so the change is heard there too; if it should only change here, copy the section under a new name and use the copy at this point of the arrangement` : ""}`;
	});
	const which = p.range.from === p.range.to ? `bar ${p.range.from}` : `bars ${p.range.from}-${p.range.to}`;
	return `Recompose the \`${p.track}\` part (${sound}) of ${songPath(p.name)} in ${which} of the piece only:
${lines.join("\n")}

Rewrite only those bars of \`${p.track}\`. If its pattern in a section is shorter than the section (it repeats to fill it), write it out in full first, so only the chosen bars change. ${keep} The new bars should lead in from the bar before and into the bar after.${userNotes(p.feedback)}${closing(p.name)}`;
}

/** The Music Composer's brief for a new part on `instrument` (a General MIDI name or "drums"), as track `id`. */
export function addPartBrief(p: { name: string; instrument: string; id: string; notes?: string }): string {
	const entry = p.instrument === "drums" ? `{"drums": true}` : `{"program": "${p.instrument}"}`;
	return `Add a new part to ${songPath(p.name)}: a track \`${p.id}\` playing ${p.instrument === "drums" ? "a drum kit" : p.instrument} (instruments.${p.id} = ${entry}, plus volume, pan and reverb that sit it in the mix). Compose its pattern for the sections where it adds something, fitting the existing harmony, rhythm and register (it may rest in some). Keep every other track, the form, tempo and key as they are.${userNotes(p.notes)}${closing(p.name)}`;
}
