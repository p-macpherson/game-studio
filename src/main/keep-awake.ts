// Keeps the computer from going to sleep while agents are working, and lets it sleep again (after however long the
// system is set to wait) once none are. Only sleep is held off: the screen may still dim, blank and lock.

import type { SessionSummary } from "../shared/types";

/** A session that is doing something: started or in progress, and not stopped waiting for the person's answer. */
export const isWorking = (s: Pick<SessionSummary, "status" | "pendingQuestion">) => (s.status === "in_progress" || s.status === "starting") && !s.pendingQuestion;

export interface SleepBlocker {
	/** Asks the system not to sleep; returns a handle for `stop`. */
	start(): number;
	stop(id: number): void;
}

export class KeepAwake {
	private held: number | null = null;

	constructor(private readonly blocker: SleepBlocker) {}

	get active(): boolean {
		return this.held !== null;
	}

	/** Holds sleep off while `working` is true and lets go when it turns false. */
	update(working: boolean): void {
		if (working && this.held === null) this.held = this.blocker.start();
		else if (!working && this.held !== null) {
			this.blocker.stop(this.held);
			this.held = null;
		}
	}
}
