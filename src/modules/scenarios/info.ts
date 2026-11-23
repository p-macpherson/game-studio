import type { ModuleInfo } from "../../shared/modules";
import { SCENARIO_DIR, parseScenario, scenarioNameOf } from "../../shared/scenario";

/**
 * Play scenarios: named ways to start the game in Play & Test (a sandbox for one mechanic, a level in a chosen
 * environment), with parameters the person sets. Files in `scenarios/`, written and kept up by agents. See the vault
 * note "Play Scenarios".
 */
export const scenarios: ModuleInfo = {
	id: "scenarios",
	name: "Scenarios",
	icon: "🧪",
	roots: [SCENARIO_DIR],
	extensions: [".json"],
	agentType: "gameplay-engineer",
	noun: "scenario",
};

export function summarizeScenario(text: string, path: string): { title: string; excerpt: string } {
	const { scenario, problems } = parseScenario(text);
	const params = scenario?.params?.length ?? 0;
	const facts = [scenario?.description?.split("\n")[0], params ? `${params} parameter${params > 1 ? "s" : ""}` : "", problems.length ? `${problems.length} problem${problems.length > 1 ? "s" : ""}` : ""];
	return { title: scenario?.title || scenarioNameOf(path), excerpt: facts.filter(Boolean).join(" · ") };
}
