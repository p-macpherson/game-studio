/**
 * The studio's voice format (`assets/voices/<name>/voice.json`): one character's voice and the lines it speaks.
 * The voice is a description in words; each line has its text and a direction (how it's said). Generated **takes**
 * (`takes/<line>-<seed>.wav`, how each was made in takes/takes.json) are the raw material; a line's chosen take is
 * levelled into the file the game plays, `<line>.ogg`. Every take is a fresh performance by a voice made from the
 * description, so the voice drifts a little between takes: each take's **match** says how close its voice is to the
 * character's other chosen lines, and a take that drifts is generated again. See the vault note "Voice Lines" and
 * skills/voice-lines/SKILL.md (the agents' reference).
 *
 * Shared by the Voice Lines section, the pipeline (src/main/voices.ts) and agents' tools.
 */
import { compact } from "./scene";

export interface Voice {
	/** Who is speaking, as the model needs it: age, gender, accent, the sound of the voice, the character. */
	voice: string;
	/** The language spoken (default "English"). */
	language?: string;
	/** Who the character is and where the lines play. */
	notes?: string;
	lines: VoiceLine[];
}

export interface VoiceLine {
	/** Names the line's files (`<id>.ogg`): lower-kebab-case. */
	id: string;
	/** The words spoken. */
	text: string;
	/** How this line is said ("Shouting in alarm, urgent"). */
	direction?: string;
	/** The chosen take's id (`takes/<id>.wav`); none until takes exist. */
	take?: string;
}

/** How a take was made (takes/takes.json, keyed by file name). */
export interface VoiceTakeRecord {
	line: string;
	text: string;
	direction?: string;
	voice: string;
	language: string;
	seed: number;
	model: string;
	at: string;
}

export interface VoiceProblem {
	at?: string;
	message: string;
}

export const LINE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_LINE_CHARS = 600;
/**
 * Below this match, against at least two other lines, a take's voice is probably not the character's. The measure is
 * weak (measured on 36 real takes of 3 voices, each against its voice's other lines: a voice's own takes 0.94-0.99,
 * mean 0.97; other characters' takes 0.90-0.99, mean 0.95; and a shout scores lower than a calm line), so this only
 * catches a voice that is plainly someone else, and ears decide the rest.
 */
export const DRIFTED = 0.93;
/** Flagging needs this many other lines with a chosen take: one line is too little to call a voice. */
export const DRIFT_REFERENCES = 2;

/** How many other lines' chosen takes a line's takes are matched against. */
export const matchReferences = (v: Voice, line: string, prints: Record<string, number[]>) => v.lines.filter((l) => l.id !== line && l.take && prints[l.take]).length;
export const isDrifted = (match: number | undefined, references: number) => match !== undefined && references >= DRIFT_REFERENCES && match < DRIFTED;

export const voiceTakeId = (line: string, seed: number) => `${line}-${seed}`;
export const lineFile = (line: string) => `${line}.ogg`;
export const languageOf = (v: Pick<Voice, "language">) => v.language?.trim() || "English";

export function validateVoice(v: unknown): VoiceProblem[] {
	const problems: VoiceProblem[] = [];
	if (typeof v !== "object" || v === null || Array.isArray(v)) return [{ message: "voice.json must be an object" }];
	const voice = v as Partial<Voice>;
	if (typeof voice.voice !== "string" || !voice.voice.trim()) problems.push({ at: "voice", message: "Describe the voice (who is speaking and what they sound like)" });
	if (voice.language !== undefined && typeof voice.language !== "string") problems.push({ at: "language", message: "language is a name, e.g. \"English\"" });
	if (!Array.isArray(voice.lines)) return [...problems, { at: "lines", message: "lines must be a list" }];
	const seen = new Set<string>();
	voice.lines.forEach((l, i) => {
		const at = `lines[${i}]`;
		if (typeof l !== "object" || l === null) return problems.push({ at, message: "A line is an object: {id, text, direction?, take?}" });
		if (typeof l.id !== "string" || !LINE_ID.test(l.id)) problems.push({ at, message: `A line's id is lower-kebab-case (it names its file), not ${JSON.stringify(l.id)}` });
		else if (seen.has(l.id)) problems.push({ at, message: `Two lines are called "${l.id}"` });
		else seen.add(l.id);
		if (typeof l.text !== "string" || !l.text.trim()) problems.push({ at, message: "A line needs its text" });
		else if (l.text.length > MAX_LINE_CHARS) problems.push({ at, message: `A line is at most ${MAX_LINE_CHARS} characters: split it into two lines` });
		if (l.direction !== undefined && typeof l.direction !== "string") problems.push({ at, message: "direction is text: how the line is said" });
		if (l.take !== undefined && (typeof l.take !== "string" || !l.take.startsWith(`${l.id}-`))) problems.push({ at, message: `take is one of this line's takes ("${l.id}-<seed>")` });
	});
	return problems;
}

export function parseVoice(text: string): { voice: Voice | null; problems: VoiceProblem[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { voice: null, problems: [{ message: `voice.json isn't valid JSON: ${(err as Error).message}` }] };
	}
	const problems = validateVoice(raw);
	return { voice: problems.length ? null : (raw as Voice), problems };
}

/** voice.json as the studio writes it: one line per voice line, so a diff shows which lines changed. */
export function formatVoice(v: Voice): string {
	const head = Object.entries({ voice: v.voice, language: v.language, notes: v.notes })
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([k, value]) => `\t${JSON.stringify(k)}: ${JSON.stringify(value)},\n`)
		.join("");
	const lines = v.lines.map((l) => `\t\t${compact({ id: l.id, text: l.text, ...(l.direction ? { direction: l.direction } : {}), ...(l.take ? { take: l.take } : {}) })}`);
	return `{\n${head}\t"lines": [${lines.length ? `\n${lines.join(",\n")}\n\t` : ""}]\n}\n`;
}

/** What the model is told for a line: the voice, then how this line is said. */
export const instructOf = (voice: string, direction?: string) => [voice.trim(), direction?.trim()].filter(Boolean).join(" ");

/** True when a take was made from what the line and the voice say now (else it's of an earlier text, direction or voice). */
export function takeIsCurrent(v: Voice, line: VoiceLine, r: VoiceTakeRecord | undefined): boolean {
	return !!r && r.text === line.text && (r.direction ?? "") === (line.direction ?? "") && r.voice === v.voice && r.language === languageOf(v);
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * How close each take's voice is to the character's voice so far: the cosine of its voiceprint with the mean
 * voiceprint of the chosen takes of the *other* lines (1 = the same voice; see DRIFTED for what the numbers mean).
 * No number while no other line has a chosen take: the first line sets the voice.
 */
export function voiceMatches(v: Voice, prints: Record<string, number[]>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of v.lines) {
		const others = v.lines.filter((l) => l.id !== line.id && l.take && prints[l.take]).map((l) => prints[l.take!]);
		if (!others.length) continue;
		const mean = others[0].map((_, i) => others.reduce((s, p) => s + p[i], 0) / others.length);
		for (const [id, print] of Object.entries(prints)) {
			if (id.startsWith(`${line.id}-`) && /^\d+$/.test(id.slice(line.id.length + 1))) out[id] = Math.round(cosine(print, mean) * 1000) / 1000;
		}
	}
	return out;
}
