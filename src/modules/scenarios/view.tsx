// The Scenarios section: each scenario with what it's for, its parameters, what starting it comes to, and Play.
import { useShallow } from "zustand/react/shallow";
import type { ModuleInfo } from "../../shared/modules";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { ScenarioForm, ScenarioLaunchPreview, useScenarioValues } from "../../renderer/views/Scenarios";
import { parseScenario } from "../../shared/scenario";

function ScenarioDetail({ asset, text, checkout }: AssetContentProps) {
	const { openPlay, startRun, setPlayScenario } = useStudio(useShallow((s) => ({ openPlay: s.openPlay, startRun: s.startRun, setPlayScenario: s.setPlayScenario })));
	const { scenario, problems } = parseScenario(text);
	const [values, setValue, reset] = useScenarioValues(scenario, asset.path);
	const play = (mode: "hidden" | "window") => {
		setPlayScenario(asset.path);
		openPlay({ checkout: checkout ?? null, tab: "run" });
		void startRun(mode);
	};
	return (
		<div className="col scenario-detail" data-testid="scenario-detail">
			{scenario?.description && <p className="scenario-description">{scenario.description}</p>}
			{problems.length > 0 && (
				<div className="msg error" data-testid="scenario-problems">
					This scenario can't be played until its file is fixed:
					<ul>
						{problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</div>
			)}
			{scenario && !problems.length && (
				<>
					{(scenario.params?.length ?? 0) > 0 && (
						<div className="col" style={{ gap: 6 }}>
							<h3>Parameters</h3>
							<ScenarioForm scenario={scenario} values={values} onChange={setValue} />
							<button className="link small" style={{ alignSelf: "flex-start" }} onClick={reset}>
								Back to its defaults
							</button>
						</div>
					)}
					<div className="row">
						<button className="primary" onClick={() => play("hidden")} title="Build, start the game as this scenario says, and show it in Play & Test" data-testid="scenario-play">
							▶ Play this scenario
						</button>
						<button onClick={() => play("window")} title="The same, in the game's own window">
							⧉ In a window
						</button>
					</div>
					{scenario.notes && (
						<div className="col" style={{ gap: 4 }}>
							<h3>What to try</h3>
							<p className="scenario-notes">{scenario.notes}</p>
						</div>
					)}
					<div className="col" style={{ gap: 4 }}>
						<h3>What starting it does</h3>
						<ScenarioLaunchPreview scenario={scenario} values={values} />
					</div>
				</>
			)}
		</div>
	);
}

export function ScenariosView({ module }: { module: ModuleInfo }) {
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New scenario"
			newPreset={{
				agentType: module.agentType,
				target: "project",
				placeholder: "What do you want to be able to play or test? e.g. a sandbox for the rope, with the cave's size and a seed as parameters.",
			}}
			modifyLabel="Change"
			modifyPlaceholder="What should change about this scenario?"
			emptyText="No scenarios yet. A scenario starts the game somewhere useful (a sandbox for one mechanic, a level in a chosen environment) with parameters you set. Ask for one with + New scenario, or agents add them when one is a good way to test what they made."
			content={(props) => <ScenarioDetail {...props} />}
		/>
	);
}
