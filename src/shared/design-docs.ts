// The game's design docs: a standard set every project has (docs/design/<Title>.md), each with a status the user
// sets, and the brief agents are given from them. See the vault note "Design Docs: Standard Set".

export const DOC_ROOT = "docs/design";

export const DOC_STATUSES = ["not-established", "draft", "established"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const STATUS_LABEL: Record<DocStatus, string> = { "not-established": "Not established", draft: "Draft", established: "Established" };

/** What a status asks of an agent whose work the doc covers. */
export const STATUS_MEANING: Record<DocStatus, string> = {
	established: "decided. Follow it; if your task conflicts with it, say so instead of deviating.",
	draft: "the current thinking, and likely to change. Follow it, but don't build things that are costly to redo around its details.",
	"not-established":
		"not decided yet. Don't invent a direction there, and don't hold your task up to get it decided: follow the doc's \"For now\" guidance, and where it gives none keep that side of the work simple, minimal and cheap to replace.",
};

export interface DesignDocDef {
	id: string;
	/** File name in docs/design/. */
	file: string;
	title: string;
	/** One line: what the doc decides. */
	purpose: string;
	/** The guidance a new project starts with, in force until the doc is established. */
	forNow: string;
	/** What establishing it means deciding: [heading, question]. They become the doc's sections. */
	decide: [string, string][];
}

/** The standard set, in reading order. */
export const DESIGN_DOCS: DesignDocDef[] = [
	{
		id: "game-brief",
		file: "Game Brief.md",
		title: "Game Brief",
		purpose: "What the game is, who it's for and how big it is: the page everything else answers to.",
		forNow: "The game hasn't been scoped yet. Treat anything built now as a prototype: small, self-contained and easy to throw away.",
		decide: [
			["Pitch", "One or two sentences: what the player does and why it's worth their time."],
			["Genre and references", "The genre, and the games (or films, books) it's closest to: what it takes from each and where it departs."],
			["Player and platform", "Who it's for; platform, input devices, single or multiplayer."],
			["Scope", "Length of a playthrough, how much content, and what is deliberately left out."],
			["Stage", "Where development is now (prototype, vertical slice, production, polish) and what this stage is trying to prove."],
		],
	},
	{
		id: "design-pillars",
		file: "Design Pillars.md",
		title: "Design Pillars",
		purpose: "The game's design philosophy: the few principles every decision is checked against, and the experience the player should have.",
		forNow: "No pillars have been set. When a design choice comes up that the docs don't settle, take the simplest option and note the choice in your report.",
		decide: [
			["Player experience", "What the player should feel, moment to moment and looking back on the game."],
			["Pillars", "Three to five principles, each with what it rules in and what it rules out."],
			["Anti-goals", "Things this game refuses to be or do, however tempting."],
		],
	},
	{
		id: "gameplay-loop",
		file: "Gameplay Loop.md",
		title: "Gameplay Loop",
		purpose: "What the player does minute to minute: the core loop, its mechanics, controls, camera and feel.",
		forNow: "The core loop is still being found. Build mechanics as quick experiments: easy to tune, easy to remove, with no content built on top of them yet.",
		decide: [
			["Core loop", "The repeating cycle of action, feedback and reward, step by step."],
			["Mechanics", "Each mechanic: its rules, and how it meets the others."],
			["Controls and camera", "Inputs, camera behaviour, and how the game should feel in the hands."],
			["Challenge", "What makes it hard, how failure works, what a win or a loss is."],
		],
	},
	{
		id: "progression",
		file: "Progression.md",
		title: "Progression",
		purpose: "What changes over a session and over the whole game: goals, unlocks, difficulty, economy, saving.",
		forNow: "Progression hasn't been designed. Don't add unlocks, currencies, upgrade trees or save data unless the task asks for them.",
		decide: [
			["Goals", "Short, medium and long-term goals: what the player is working towards at each scale."],
			["Growth", "What the player gains (abilities, items, knowledge, access) and in what order."],
			["Difficulty curve", "How challenge rises, and how the game teaches what it then demands."],
			["Economy", "Resources and currencies: where they come from, where they go."],
			["Structure and saving", "Levels, chapters or runs; what persists between sessions; how the game ends."],
		],
	},
	{
		id: "world-and-lore",
		file: "World and Lore.md",
		title: "World and Lore",
		purpose: "The setting, its tone and history, the characters and places in it, and how things are named.",
		forNow: "The world hasn't been written. Use plain, descriptive names and avoid inventing lore, characters or history: neutral placeholders that are easy to rename.",
		decide: [
			["Setting", "Where and when; the premise in a paragraph."],
			["Tone", "The mood, and how serious or playful the writing is."],
			["Characters and factions", "Who lives here, what they want, how they relate to the player."],
			["Places", "The locations the game visits and what makes each distinct."],
			["Story", "What happens, and how the game tells it (or that it doesn't)."],
			["Naming and voice", "Naming rules, vocabulary, and how in-game text sounds."],
		],
	},
	{
		id: "art-style",
		file: "Art Style.md",
		title: "Art Style",
		purpose: "How the game looks: the style, palette, shapes, level of detail, materials, lighting and UI look that every visual asset follows.",
		forNow:
			"The art style has not been established. All art should be simple and minimal: plain shapes, flat colours, no fine detail and little time spent. " +
			"Assets made now are placeholders that an art pass will replace once the direction is set, so make them readable and the right size, not good-looking.",
		decide: [
			["Style", "The overall look in a sentence (e.g. chunky low-poly, hand-painted), with references."],
			["Palette", "The colours and their roles; saturation and contrast."],
			["Shape and proportion", "Shape language, proportions, silhouettes; how characters differ from scenery."],
			["Detail and materials", "Level of detail, texture style, how surfaces are treated."],
			["Lighting and effects", "Lighting mood, time of day, post-processing, shader effects."],
			["UI", "The look of screens and HUD: frames, fonts, icons."],
			["Scale", "Real-world sizes: the player's height, a door, a tile."],
			["Prompt phrases", "Wording to put in every generation prompt so assets match."],
		],
	},
	{
		id: "audio-style",
		file: "Audio Style.md",
		title: "Audio Style",
		purpose: "How the game sounds: the music's mood and instruments, the character of sound effects, and the mix.",
		forNow:
			"The audio direction has not been established. Keep audio minimal: only the sounds a mechanic needs to be understood, simple and short, and no music unless the task asks for it.",
		decide: [
			["Mood", "What the game should sound like overall, with references."],
			["Music", "Genre, instruments, tempo and key tendencies; where music plays and how it changes."],
			["Sound effects", "Their character (realistic, cartoon, synthetic), and what must always be heard."],
			["Voice", "Whether there's speech or vocal sound, and its style."],
			["Mix", "Relative loudness of music, effects and ambience; how busy it may get."],
		],
	},
	{
		id: "technical-direction",
		file: "Technical Direction.md",
		title: "Technical Direction",
		purpose: "The technical targets and rules the game's code follows: performance, resolution, structure, testing, and how polished code should be at this stage.",
		forNow: "No technical targets have been set. Write the simplest code that works and keep it easy to change; cover behaviour the game depends on with a scripted test.",
		decide: [
			["Targets", "Frame rate, resolution, minimum hardware, load times."],
			["Code structure", "How the game package is organised and the patterns to keep to."],
			["Quality bar", "How robust code must be at this stage (throwaway prototype or production), and what must have tests."],
			["Budgets", "Limits on triangles, texture sizes, draw calls, audio channels, memory."],
		],
	},
];

export const docPath = (def: DesignDocDef) => `${DOC_ROOT}/${def.file}`;
export const standardDoc = (path: string) => DESIGN_DOCS.find((d) => docPath(d) === path);

export interface ParsedDoc {
	/** Absent for a doc that doesn't say (a project's own doc): read as current. */
	status?: DocStatus;
	/** The markdown after the frontmatter. */
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A doc's status (from its frontmatter's `status:`) and the markdown after the frontmatter. */
export function parseDoc(text: string): ParsedDoc {
	const m = FRONTMATTER.exec(text);
	if (!m) return { body: text };
	const value = /^status:[ \t]*["']?([\w -]+?)["']?[ \t]*$/m.exec(m[1])?.[1].trim().toLowerCase().replace(/[ _]+/g, "-");
	const status = DOC_STATUSES.find((s) => s === value);
	return { ...(status ? { status } : {}), body: text.slice(m[0].length) };
}

/** The doc with its status set, keeping anything else in its frontmatter. */
export function setDocStatus(text: string, status: DocStatus): string {
	const m = FRONTMATTER.exec(text);
	if (!m) return `---\nstatus: ${status}\n---\n${text}`;
	const lines = m[1].split(/\r?\n/).filter((l) => !/^status:/.test(l));
	return `---\n${[`status: ${status}`, ...lines].join("\n")}\n---\n${text.slice(m[0].length)}`;
}

/** The doc with its markdown replaced, keeping its frontmatter. */
export function setDocBody(text: string, body: string): string {
	return (FRONTMATTER.exec(text)?.[0] ?? "") + body;
}

/** A standard doc as a new project has it: not established, with its starting guidance and what there is to decide. */
export function docTemplate(def: DesignDocDef): string {
	return [
		"---",
		"status: not-established",
		"---",
		`# ${def.title}`,
		"",
		`> ${def.purpose}`,
		"",
		"## For now",
		def.forNow,
		"",
		"## To decide",
		...def.decide.map(([heading, question]) => `- **${heading}.** ${question}`),
		"",
	].join("\n");
}

/** The standard docs a project doesn't have, given its doc paths. */
export function missingDocs(paths: string[]): DesignDocDef[] {
	const have = new Set(paths);
	return DESIGN_DOCS.filter((d) => !have.has(docPath(d)));
}

/** Title from the first `# heading` (else the file name); excerpt from the first paragraph after it; the doc's status. */
export function summarizeMarkdown(text: string, path: string): { title: string; excerpt: string; status?: DocStatus } {
	const { status, body } = parseDoc(text);
	const lines = body.split("\n");
	const headingIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
	const title = headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, "").trim() : (path.split("/").pop() ?? path).replace(/\.md$/i, "");
	const paragraph: string[] = [];
	for (const raw of lines.slice(headingIndex + 1)) {
		const line = raw.replace(/^>\s?/, "").trim();
		if (!line) {
			if (paragraph.length) break;
			continue;
		}
		if (/^(#|\||```|---|- |\* |\d+\. )/.test(line)) {
			if (paragraph.length) break;
			continue;
		}
		paragraph.push(line);
	}
	const excerpt = paragraph
		.join(" ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "");
	return { title, excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt, ...(status ? { status } : {}) };
}

/** Longer docs are cut in the brief, with a pointer to the file. */
const INLINE_LIMIT = 8000;

/**
 * The design direction an agent starts a session with: what the statuses ask of it, the docs its type works to in
 * full (`follows`: standard doc ids), and the rest listed with their status and summary. Empty when there are no docs.
 */
export function designBrief(docs: { path: string; text: string }[], follows: string[]): string {
	if (!docs.length) return "";
	const order = (path: string) => {
		const i = DESIGN_DOCS.findIndex((d) => docPath(d) === path);
		return i < 0 ? DESIGN_DOCS.length : i;
	};
	const sorted = [...docs].sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
	const label = (s?: DocStatus) => (s ? STATUS_LABEL[s].toUpperCase() : "CURRENT");
	const mine = sorted.filter((d) => follows.includes(standardDoc(d.path)?.id ?? ""));
	const rest = sorted.filter((d) => !mine.includes(d));
	const out = [
		"# The game's design direction",
		`The design docs in \`${DOC_ROOT}/\` hold the user's decisions about this game. Each says how settled it is:`,
		...(["established", "draft", "not-established"] as const).map((s) => `- **${STATUS_LABEL[s]}**: ${STATUS_MEANING[s]}`),
		"",
		"A doc changes only with the user's agreement, in a Game Designer session. If your work shows that one is wrong, silent or out of date, say so in your report; don't edit it.",
	];
	if (mine.length) {
		out.push("", "## The docs your work follows", "As they were when this session opened; read the file again if it may have changed since.");
		for (const d of mine) {
			const { status, body } = parseDoc(d.text);
			const text = body.trim();
			out.push("", `### ${summarizeMarkdown(d.text, d.path).title}: ${label(status)} (\`${d.path}\`)`);
			out.push(text.length > INLINE_LIMIT ? `${text.slice(0, INLINE_LIMIT)}\n…(cut: read the rest in \`${d.path}\`)` : text.replace(/^#\s+.*\n+/, ""));
		}
	}
	if (rest.length) {
		out.push("", mine.length ? "## The other design docs" : "## The design docs", "Read one before work that touches its subject.");
		for (const d of rest) {
			const s = summarizeMarkdown(d.text, d.path);
			out.push(`- **${s.title}**, ${label(s.status).toLowerCase()} (\`${d.path}\`)${s.excerpt ? `: ${s.excerpt}` : ""}`);
		}
	}
	return out.join("\n");
}
