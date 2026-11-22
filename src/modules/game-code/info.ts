import type { ModuleInfo } from "../../shared/modules";

export const gameCode: ModuleInfo = {
	id: "game-code",
	name: "Code",
	icon: "⌨",
	roots: ["game", "tests"],
	extensions: [".odin", ".jsonl"],
	agentType: "gameplay-engineer",
	noun: "file",
};

/** Title is the file name; the excerpt is the file's leading comment, if any. */
export function summarizeCode(text: string, path: string): { title: string; excerpt: string } {
	const comment: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("//")) comment.push(line.replace(/^\/\/+\s?/, ""));
		else if (line && !line.startsWith("#") && !/^package\s/.test(line)) break;
		else if (comment.length && !line) break;
	}
	const excerpt = comment.join(" ").trim();
	return { title: path.split("/").pop() ?? path, excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
