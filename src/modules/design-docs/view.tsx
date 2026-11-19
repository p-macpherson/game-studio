import type { AssetSummary, ModuleInfo } from "../../shared/modules";
import { useStudio } from "../../renderer/store";
import { AssetBrowser } from "../../renderer/views/AssetBrowser";
import { Markdown } from "../../renderer/views/Markdown";

/** Resolves a relative link from one repo-relative file to another (`../Lore.md` from `docs/design/x/A.md`). */
export function resolveLink(from: string, href: string): string {
	const parts = from.split("/").slice(0, -1);
	for (const seg of href.split("#")[0].split("/")) {
		if (seg === "..") parts.pop();
		else if (seg && seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

const overviewFirst = (docs: AssetSummary[]) => docs.find((d) => /overview\.md$/i.test(d.path)) ?? docs[0];

export function DesignDocsView({ module }: { module: ModuleInfo }) {
	const showAsset = useStudio((s) => s.showAsset);
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New doc"
			newPreset={{
				agentType: module.agentType,
				target: "project",
				context: `New ${module.noun} in ${module.roots[0]}/`,
				placeholder: "What should the new design doc cover?",
			}}
			modifyLabel="Discuss / modify"
			modifyPlaceholder="What do you want to discuss or change?"
			emptyText="No design docs yet. Start one with “New doc”."
			pickDefault={overviewFirst}
			content={({ asset, text, assets }) => (
				<div className="doc-view">
					<Markdown
						text={text}
						onLink={(href) => {
							const target = resolveLink(asset.path, href);
							if (assets.some((d) => d.path === target)) showAsset({ path: target });
						}}
					/>
				</div>
			)}
		/>
	);
}
