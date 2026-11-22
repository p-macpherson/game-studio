// Which model an agent type's sessions run on: its AGENT.md, overridden per type in Settings → Agents, and the one
// model a parent may ask for instead when it delegates.
import type { AgentModelSettings, AgentTypeInfo } from "./types";

/** The types with Settings → Agents' choices applied; a changed type remembers what its file said. */
export function withModelSettings(types: AgentTypeInfo[], settings: Record<string, AgentModelSettings> | undefined): AgentTypeInfo[] {
	if (!settings || !Object.keys(settings).length) return types;
	return types.map((t) => {
		const own = settings[t.id];
		if (!own) return t;
		const defaultModel = own.defaultModel ?? t.defaultModel;
		const models = (own.models ?? t.models ?? []).filter((m) => m !== defaultModel);
		return { ...t, defaultModel, models, fileModels: { defaultModel: t.defaultModel, models: t.models ?? [] } };
	});
}

/**
 * The model a sub-agent starts on. Without `asked`: its type's default when available, else its parent's. `asked`
 * (the parent's choice) must be that default or one of the type's other allowed models, and available; else throws.
 */
export function delegateModel(type: Pick<AgentTypeInfo, "name" | "defaultModel" | "models">, parentModel: string, available: ReadonlySet<string>, asked?: string): string {
	const usual = type.defaultModel && available.has(type.defaultModel) ? type.defaultModel : parentModel;
	if (!asked || asked === usual) return usual;
	const options = delegateOptions(type, available).filter((m) => m !== usual);
	if (options.includes(asked)) return asked;
	throw new Error(
		options.length
			? `${type.name} can't be started on "${asked}": choose ${options.join(" or ")}, or leave \`model\` out for its usual model (${usual})`
			: `${type.name} only runs on its usual model (${usual}): leave \`model\` out`,
	);
}

/** The other models a parent may choose for a type, of those that can be used now. */
export function delegateOptions(type: Pick<AgentTypeInfo, "defaultModel" | "models">, available: ReadonlySet<string>): string[] {
	return (type.models ?? []).filter((m) => m !== type.defaultModel && available.has(m));
}
