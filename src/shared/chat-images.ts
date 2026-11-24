// Pictures the agent embeds in its chat messages (`![caption](path)`): which file of the session's checkout one means.

/**
 * The checkout-relative path an image in the agent's markdown points at, or null when it isn't a file of the checkout.
 * Agents write repo paths (`assets/x.png`, `./assets/x.png`) or absolute ones inside their worktree; `root` is that
 * worktree's folder. A path outside it, or one leaving it with `..`, can't be served.
 */
export function chatImagePath(src: string, root: string): string | null {
	let p = src.trim().replace(/^file:\/\//, "");
	if (p.startsWith("/")) {
		const base = root.replace(/\/+$/, "") + "/";
		if (!p.startsWith(base)) return null;
		p = p.slice(base.length);
	}
	p = p.replace(/^(\.\/)+/, "");
	if (!p || p.split("/").includes("..")) return null;
	return p;
}
