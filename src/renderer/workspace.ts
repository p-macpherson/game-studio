// Sections' buttons (3D Models, Music, Sound Effects, Scenes) run studio steps in a worktree, never in main.
import type { StudioRequestMethod } from "../shared/host";
import { call } from "./api";
import { useStudio } from "./store";

/**
 * The worktree a section's edit goes into: the selected one; with main selected, a new worktree labelled `label`
 * (renamable), which becomes the selection.
 */
export async function editCheckout(label: string): Promise<string> {
	const { worktree } = useStudio.getState();
	if (worktree) return worktree;
	const w = await call("worktrees.create", label);
	await useStudio.getState().refreshWorktrees();
	useStudio.getState().selectWorktree(w.id);
	return w.id;
}

/** Runs a studio step in the worktree a section edits (see `editCheckout`); returns the step's result and where it ran. */
export async function runInWorktree(label: string, method: StudioRequestMethod, params: Record<string, unknown>): Promise<{ result: unknown; checkout: string }> {
	const checkout = await editCheckout(label);
	return { result: await call("worktrees.run", checkout, method, params), checkout };
}
