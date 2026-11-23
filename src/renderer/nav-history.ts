// Back and forward through the places a person has been in the studio, like a browser's. A place is the page and
// what is open on it (a session, an asset, a worktree's review or changes, a settings tab) together with the selected
// worktree, since the sections show that worktree's files. Tabs inside a page, scroll positions and text being typed
// aren't part of a place. The history lasts while the studio runs and starts again with each project.

export interface Place {
	view: string;
	/** The open session (Sessions page). */
	session: string | null;
	/** The open asset's path (a section). */
	asset: string | null;
	/** The selected worktree (null: main). */
	worktree: string | null;
	/** Worktrees page: the worktree being reviewed, the one whose changes are read, and the file shown first there. */
	review: string | null;
	changes: string | null;
	changesFile: string | null;
	/** Settings page. */
	settingsTab: string | null;
}

/** Where the studio is, from the parts of its state that say so (what doesn't apply to the page is left out). */
export function placeOf(s: { view: string; selectedSession: string | null; focus: { path: string } | null; selected: string | null; reviewOf: string | null; changesOf: string | null; changesFile: string | null; settingsTab: string }, ownsAsset: (view: string, path: string) => boolean): Place {
	const worktrees = s.view === "worktrees";
	return {
		view: s.view,
		session: s.view === "sessions" ? s.selectedSession : null,
		asset: s.focus && ownsAsset(s.view, s.focus.path) ? s.focus.path : null,
		worktree: s.selected,
		review: worktrees ? s.reviewOf : null,
		changes: worktrees ? s.changesOf : null,
		changesFile: worktrees && s.changesOf ? s.changesFile : null,
		settingsTab: s.view === "settings" ? s.settingsTab : null,
	};
}

export const placeKey = (p: Place) => JSON.stringify([p.view, p.session, p.asset, p.worktree, p.review, p.changes, p.changesFile, p.settingsTab]);

const MAX = 100;

export class NavHistory {
	private entries: Place[] = [];
	private index = -1;

	get current(): Place | null {
		return this.entries[this.index] ?? null;
	}

	/** Notes where the person is now: a new place is added after the current one, and what was ahead of it is dropped. */
	visit(place: Place): void {
		const here = this.current;
		if (here && placeKey(here) === placeKey(place)) return;
		// A section opening its first asset by itself (nothing was open yet) is the same visit, not a second one.
		if (here && here.asset === null && place.asset !== null && placeKey({ ...here, asset: place.asset }) === placeKey(place)) {
			this.entries[this.index] = place;
			return;
		}
		this.entries = [...this.entries.slice(0, this.index + 1), place].slice(-MAX);
		this.index = this.entries.length - 1;
	}

	/** The nearest place behind (step -1) or ahead (+1) that still exists, without moving there. */
	peek(step: -1 | 1, exists: (p: Place) => boolean): number | null {
		for (let i = this.index + step; i >= 0 && i < this.entries.length; i += step) if (exists(this.entries[i])) return i;
		return null;
	}

	/** Moves to the nearest place behind or ahead that still exists and returns it (null: there is none). */
	go(step: -1 | 1, exists: (p: Place) => boolean): Place | null {
		const to = this.peek(step, exists);
		if (to === null) return null;
		this.index = to;
		return this.entries[to];
	}

	reset(): void {
		this.entries = [];
		this.index = -1;
	}
}
