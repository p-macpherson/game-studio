// A session's assets in its chat: the strip of cards under a turn (what that turn made, changed, removed or
// showed), and the chips its asset paths become in the agent's words. A click opens the asset in its section with
// the session's worktree selected; nothing here moves the user on its own.
import { useEffect, useMemo, useState } from "react";
import type { AssetCard, SessionAssets } from "../../shared/session-assets";
import { studioFile } from "../api";
import { useStudio } from "../store";
import type { Chip } from "./Markdown";

const CHANGE = { added: "New", modified: "Modified", deleted: "Removed" } as const;
const SHOWN = 6;

const fileOf = (c: AssetCard, path: string) => studioFile(c.checkout ?? "main", path);

/** Opens what a card or chip stands for: a plain picture in the image viewer, an asset in its section. */
export function openCard(c: AssetCard): void {
	const s = useStudio.getState();
	if (!c.module) return s.showImages([{ src: fileOf(c, c.path), label: c.path }]);
	s.showAsset({ path: c.path, checkout: c.checkout });
}

/** The chips for a session's mentions (see Markdown's `chips`). */
export function useChips(assets: SessionAssets | undefined): Record<string, Chip> | undefined {
	return useMemo(() => {
		const mentions = assets?.mentions;
		if (!mentions || !Object.keys(mentions).length) return undefined;
		return Object.fromEntries(
			Object.entries(mentions).map(([written, c]) => [
				written,
				{
					// A file inside the asset (one of a sound's takes) keeps its own name beside the asset's.
					label: written === c.path || c.path.startsWith(`${written}/`) ? c.name : `${c.name} › ${written.slice(written.lastIndexOf("/") + 1)}`,
					icon: c.module?.icon ?? "🖼",
					title: `${c.module?.name ?? "Image"}: ${c.path}${c.change ? ` (${CHANGE[c.change].toLowerCase()} in this worktree)` : ""}. Click to open.`,
					...(c.preview?.kind === "image" ? { preview: fileOf(c, c.preview.path) } : {}),
				},
			]),
		);
	}, [assets]);
}

// One sound at a time, across every card.
let player: HTMLAudioElement | null = null;
let playing: string | null = null;
const listeners = new Set<() => void>();
function toggleSound(src: string): void {
	const was = playing;
	player?.pause();
	player = null;
	playing = null;
	if (was !== src) {
		player = new Audio(src);
		playing = src;
		const done = () => {
			if (playing === src) playing = null;
			for (const l of listeners) l();
		};
		player.addEventListener("ended", done);
		player.addEventListener("error", done);
		void player.play().catch(done);
	}
	for (const l of listeners) l();
}

function Card({ c }: { c: AssetCard }) {
	const [, redraw] = useState(0);
	useEffect(() => {
		const l = () => redraw((n) => n + 1);
		listeners.add(l);
		return () => void listeners.delete(l);
	}, []);
	const sound = c.preview?.kind === "audio" ? fileOf(c, c.preview.path) : null;
	const what = c.module ? `${c.module.name}: ${c.path}` : c.path;
	return (
		<div className={`asset-card ${c.change === "deleted" ? "gone" : ""}`} data-testid="asset-card" data-path={c.path}>
			<button className="asset-card-open" onClick={() => openCard(c)} title={`${what}\nClick to open${c.module ? ` in ${c.module.name}` : ""}`}>
				{c.preview?.kind === "image" ? <img className="asset-card-thumb" src={fileOf(c, c.preview.path)} alt="" loading="lazy" /> : <span className="asset-card-thumb asset-card-icon">{c.module?.icon ?? "🖼"}</span>}
				<span className="asset-card-text">
					<span className="asset-card-name ellipsis">{c.name}</span>
					<span className="asset-card-kind ellipsis">
						{c.change && <span className={`change-${c.change}`}>{CHANGE[c.change]}</span>}
						{c.change && " · "}
						{c.module?.name ?? "Image"}
						{c.shown && !c.change && " · shown"}
					</span>
				</span>
			</button>
			{sound && (
				<button className="asset-card-play" onClick={() => toggleSound(sound)} title={playing === sound ? "Stop" : "Listen"} aria-label={playing === sound ? "Stop" : "Listen"} data-testid="asset-card-play">
					{playing === sound ? "■" : "▶"}
				</button>
			)}
		</div>
	);
}

/** The cards for one turn; past the first few they fold behind "+N more". */
export function AssetStrip({ cards }: { cards: AssetCard[] | undefined }) {
	const [all, setAll] = useState(false);
	if (!cards?.length) return null;
	const shown = all ? cards : cards.slice(0, SHOWN);
	return (
		<div className="asset-strip" data-testid="asset-strip">
			{shown.map((c) => (
				<Card key={c.path} c={c} />
			))}
			{cards.length > SHOWN && (
				<button className="chip" onClick={() => setAll(!all)} data-testid="asset-strip-more">
					{all ? "Show fewer" : `+${cards.length - SHOWN} more`}
				</button>
			)}
		</div>
	);
}

/** The picture of the chip under the pointer, floating beside it (handlers for the chat's container). */
export function useChipPreview() {
	const [at, setAt] = useState<{ src: string; x: number; y: number } | null>(null);
	const onMouseOver = (e: React.MouseEvent) => {
		const chip = (e.target as HTMLElement).closest?.(".asset-chip[data-preview]") as HTMLElement | null;
		if (!chip) return setAt(null);
		const r = chip.getBoundingClientRect();
		setAt({ src: chip.dataset.preview!, x: Math.min(r.left, window.innerWidth - 220), y: r.top > 220 ? r.top - 208 : r.bottom + 8 });
	};
	const preview = at && <img className="chip-preview" src={at.src} alt="" style={{ left: at.x, top: at.y }} data-testid="chip-preview" />;
	return { onMouseOver, onMouseLeave: () => setAt(null), preview };
}
