import type { AgentTypeInfo } from "./types";

/** An agent type by id, or by an old id it answers to (`aliases`). */
export const findAgentType = (types: AgentTypeInfo[], id: string): AgentTypeInfo | undefined => types.find((t) => t.id === id) ?? types.find((t) => t.aliases?.includes(id));
