// Agent types: `<dir>/<id>/AGENT.md` files, YAML frontmatter plus a system-prompt body.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
	};
}

function loadDir(dir: string, source: AgentTypeInfo["source"]): AgentTypeInfo[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "AGENT.md")))
		.map((e) => parseAgentType(readFileSync(join(dir, e.name, "AGENT.md"), "utf8"), e.name, source));
}

/** Built-in types, overridden by id with the project's `.studio/agent-types/`. */
export function loadAgentTypes(builtinDir: string, projectPath?: string): AgentTypeInfo[] {
	const byId = new Map<string, AgentTypeInfo>();
	for (const t of loadDir(builtinDir, "builtin")) byId.set(t.id, t);
	if (projectPath) for (const t of loadDir(join(projectPath, ".studio/agent-types"), "project")) byId.set(t.id, t);
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
