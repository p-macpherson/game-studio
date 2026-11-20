// Sections' buttons (3D Models, Music) run studio steps in a session's worktree, never in the main checkout.
import type { AssetSummary } from "../shared/modules";
import { call } from "./api";

/**
 * The session a section's action runs in: the draft being shown; else a session that already has a draft of
 * this asset (so acting on the merged version again doesn't start another workspace); else a new workspace
 * session of `agentType`, created without running the agent.
 */
export async function workspaceFor(asset: AssetSummary, shownSession: string | undefined, agentType: string, title: string): Promise<{ id: string; created: boolean }> {
	if (shownSession) return { id: shownSession, created: false };
	const open = asset.drafts.find((d) => d.status !== "done");
	if (open) return { id: open.sessionId, created: false };
	return { id: (await call("workspace.create", agentType, title, asset.path)).id, created: true };
}
