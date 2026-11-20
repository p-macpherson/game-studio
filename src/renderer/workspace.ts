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

/** What a worktree's unsaved changes are, for a dialog: its manual edits by name, else the files. */
async function unsavedOf(worktreeId: string): Promise<{ count: number; text: string; message: string }> {
	const h = await call("history.get", worktreeId);
	const steps = h.steps.filter((s) => s.done).map((s) => s.label);
	const lines = steps.length ? steps : h.unsaved;
	const text = lines.slice(0, 12).map((l) => `- ${l}`).join("\n") + (lines.length > 12 ? `\n…and ${lines.length - 12} more` : "");
	return { count: h.unsaved.length, text, message: saveMessage(steps, h.unsaved) };
}

/** A Save's commit message from the manual edits it holds (or, without history, the files). */
export function saveMessage(steps: string[], files: string[]): string {
	if (steps.length === 1) return steps[0];
	if (steps.length) return `${steps.length} manual edits\n\n${steps.map((s) => `- ${s}`).join("\n")}`;
	return `Manual edits\n\n${files.map((f) => `- ${f}`).join("\n")}`;
}

/** Asks before discarding a worktree, listing the unsaved changes that would be lost. */
export async function confirmDiscard(worktreeId: string, label: string, details = ""): Promise<boolean> {
	const u = await unsavedOf(worktreeId);
	const lost = u.count ? `\n\nIts unsaved changes are lost:\n${u.text}` : "";
	return window.confirm(`Discard worktree “${label}”?${details} The checkout is removed; the branch (with what was saved) is kept, so it can be resumed.${lost}`);
}
