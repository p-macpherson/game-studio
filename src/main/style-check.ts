// The style check of a worktree's new art: a Style Reviewer session looks at each changed picture beside the Art
// Style doc and says whether it fits. Started from the Review page; the opinion is a hint shown on the cards.
import { type StyleCheck, parseStyleReply, styleBrief, styleSubjects } from "../shared/review";
import type { ReviewItem } from "../shared/review";

export interface StyleCheckDeps {
	head(worktreeId: string): Promise<string>;
	items(worktreeId: string): Promise<ReviewItem[]>;
	/** Runs a Style Reviewer session in the worktree with this brief and returns its last words. */
	ask(worktreeId: string, brief: string, started: (sessionId: string) => void): Promise<string>;
	changed(worktreeId: string): void;
}

export class StyleCheckService {
	private readonly results = new Map<string, StyleCheck>();

	constructor(private readonly deps: StyleCheckDeps) {}

	get(worktreeId: string): StyleCheck | null {
		return this.results.get(worktreeId) ?? null;
	}

	/** Starts a check and returns at once (the result arrives through `changed`); one at a time per worktree. */
	async start(worktreeId: string): Promise<void> {
		if (this.results.get(worktreeId)?.state === "running") return;
		const subjects = styleSubjects(await this.deps.items(worktreeId));
		if (!subjects.length) throw new Error("This worktree changed no art with a picture to judge");
		const result: StyleCheck = { worktreeId, state: "running", commit: await this.deps.head(worktreeId), startedAt: new Date().toISOString(), notes: {} };
		const publish = () => {
			this.results.set(worktreeId, { ...result });
			this.deps.changed(worktreeId);
		};
		publish();
		void this.deps
			.ask(worktreeId, styleBrief(subjects), (sessionId) => {
				result.sessionId = sessionId;
				publish();
			})
			.then(
				(reply) => {
					result.notes = parseStyleReply(reply, subjects.map((s) => s.path));
					result.state = Object.keys(result.notes).length ? "done" : "failed";
					if (result.state === "failed") result.error = "The Style Reviewer's reply had no verdicts in it: open its session to read what it said";
				},
				(err: Error) => {
					result.state = "failed";
					result.error = err.message;
				},
			)
			.then(publish);
	}
}
