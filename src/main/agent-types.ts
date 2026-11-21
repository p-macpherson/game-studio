// Agent types: `<dir>/<id>/AGENT.md` files, YAML frontmatter plus a system-prompt body.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { TARGETS, type AgentTypeInfo, type Target, type ThinkingLevel } from "../shared/types";

export function parseAgentType(text: string, fallbackId: string, source: AgentTypeInfo["source"]): AgentTypeInfo {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	const meta = (match ? parse(match[1]) : {}) as Record<string, unknown>;
	const body = (match ? match[2] : text).trim();
	const targets = (Array.isArray(meta.targets) ? meta.targets : ["project"]).filter((t): t is Target => TARGETS.includes(t as Target));
	return {
		id: String(meta.id ?? fallbackId),
		name: String(meta.name ?? fallbackId),
		description: String(meta.description ?? ""),
		targets,
		defaultModel: meta.defaultModel ? String(meta.defaultModel) : undefined,
		thinking: meta.thinking ? (String(meta.thinking) as ThinkingLevel) : undefined,
		skills: Array.isArray(meta.skills) ? meta.skills.map(String) : [],
		prompt: body,
		source,
		delegatesTo: Array.isArray(meta.delegatesTo) ? meta.delegatesTo.map(String) : [],
		...(Array.isArray(meta.aliases) ? { aliases: meta.aliases.map(String) } : {}),
		...(Array.isArray(meta.studioTools) ? { studioTools: meta.studioTools.map(String) } : {}),
	};
}

/**
 * Keeps the delegation graph acyclic and its edges pointing at real types: an edge to an unknown type, or one that
 * would close a cycle (found depth-first, in name order), is dropped and noted in the type's `problems`.
 */
export function checkDelegation(types: AgentTypeInfo[]): AgentTypeInfo[] {
	const byId = new Map(types.map((t) => [t.id, { ...t, delegatesTo: [...(t.delegatesTo ?? [])], problems: [...(t.problems ?? [])] }]));
	for (const t of byId.values()) {
		for (const to of t.delegatesTo.filter((x) => !byId.has(x))) t.problems.push(`Can't delegate to "${to}": no such agent type`);
		t.delegatesTo = t.delegatesTo.filter((x) => byId.has(x) && x !== t.id);
	}
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string) => {
		state.set(id, "visiting");
		const t = byId.get(id)!;
		for (const to of [...t.delegatesTo]) {
			if (state.get(to) === "visiting") {
				t.delegatesTo = t.delegatesTo.filter((x) => x !== to);
				t.problems.push(`Delegating to "${to}" would make a cycle (${byId.get(to)!.name} already leads back here), so it's ignored`);
			} else if (!state.has(to)) visit(to);
		}
		state.set(id, "done");
	};
	for (const id of [...byId.keys()].sort()) if (!state.has(id)) visit(id);
	return types.map((t) => {
		const c = byId.get(t.id)!;
		return { ...t, delegatesTo: c.delegatesTo, ...(c.problems.length ? { problems: c.problems } : {}) };
	});
}

function loadDir(dir: string, source: AgentTypeInfo["source"]): AgentTypeInfo[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "AGENT.md")))
		.map((e) => {
			try {
				return parseAgentType(readFileSync(join(dir, e.name, "AGENT.md"), "utf8"), e.name, source);
			} catch (err) {
				// One broken AGENT.md mustn't take every type down: it shows in Settings → Agents with the error.
				const message = (err as Error).message.split("\n")[0];
				return { id: e.name, name: e.name, description: "", targets: [], skills: [], prompt: "", source, problems: [`AGENT.md can't be read: ${message}`] };
			}
		});
}

/** Built-in types, overridden by id with the project's `.studio/agent-types/`. */
export function loadAgentTypes(builtinDir: string, projectPath?: string): AgentTypeInfo[] {
	const byId = new Map<string, AgentTypeInfo>();
	for (const t of loadDir(builtinDir, "builtin")) byId.set(t.id, t);
	if (projectPath) for (const t of loadDir(join(projectPath, ".studio/agent-types"), "project")) byId.set(t.id, t);
	return checkDelegation([...byId.values()]).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `loadAgentTypes`, read again only when an AGENT.md was added, removed or changed: the types are asked for several
 * times whenever a session starts, opens or delegates, and parsing them all each time is wasted work.
 */
export function agentTypeCache(builtinDir: string): (projectPath?: string) => AgentTypeInfo[] {
	let seen = "";
	let types: AgentTypeInfo[] = [];
	return (projectPath) => {
		const dirs = [builtinDir, ...(projectPath ? [join(projectPath, ".studio/agent-types")] : [])];
		const now = dirs.map(signature).join("|");
		if (now !== seen) {
			types = loadAgentTypes(builtinDir, projectPath);
			seen = now;
		}
		return types;
	};
}

/** Which AGENT.md files a folder has, with their sizes and times. */
function signature(dir: string): string {
	if (!existsSync(dir)) return `${dir}:-`;
	const files = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.flatMap((e) => {
			const file = join(dir, e.name, "AGENT.md");
			if (!existsSync(file)) return [];
			const st = statSync(file);
			return [`${e.name}:${st.size}:${st.mtimeMs}`];
		});
	return `${dir}:${files.join(",")}`;
}
