import type { ModuleInfo } from "../../shared/modules";
import { useStudio } from "../../renderer/store";
import { AssetBrowser } from "../../renderer/views/AssetBrowser";
import { CodeView } from "../../renderer/views/CodeView";

const mainFirst = <T extends { path: string }>(files: T[]) => files.find((f) => f.path === "game/main.odin") ?? files[0];

export function GameCodeView({ module }: { module: ModuleInfo }) {
	const { openPlay, startRun, runTests } = useStudio();
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New feature"
			newPreset={{ agentType: module.agentType, target: "project", placeholder: "What should the game do? Describe the feature or mechanic." }}
			modifyLabel="Modify"
			modifyPlaceholder="What should change in this file?"
			emptyText="No game code yet."
			pickDefault={mainFirst}
			actions={(asset, sessionId) => {
				const checkout = sessionId ?? null;
				return asset.path.endsWith(".jsonl") ? (
					<button
						onClick={() => {
							openPlay({ checkout, tab: "tests" });
							void runTests([asset.path]);
						}}
					>
						▶ Run test
					</button>
				) : (
					<button
						title={sessionId ? "Build and run this session's worktree" : "Build and run the main checkout"}
						onClick={() => {
							openPlay({ checkout, tab: "run" });
							void startRun("hidden");
						}}
					>
						▶ Run
					</button>
				);
			}}
			content={({ text, line }) => <CodeView text={text} line={line} />}
		/>
	);
}
