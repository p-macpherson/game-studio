/** A manual edit in a worktree's undo history (see src/main/edit-history.ts). */
export interface HistoryStep {
	label: string;
	at: string;
	/** Done (undoable); false for a step that was undone (redoable). */
	done: boolean;
	files: string[];
}
