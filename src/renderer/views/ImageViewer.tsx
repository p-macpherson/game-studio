// Images full size over the studio: screenshots and renders an agent shows (open_in_studio) or asks about. ← and →
// step through several; Esc or a click outside closes.
import { useEffect } from "react";
import { useStudio } from "../store";

export function ImageViewer() {
	const viewer = useStudio((s) => s.viewer);
	const close = () => useStudio.setState({ viewer: null });
	const step = (d: number) =>
		useStudio.setState((s) => (s.viewer ? { viewer: { ...s.viewer, index: (s.viewer.index + d + s.viewer.images.length) % s.viewer.images.length } } : {}));
	useEffect(() => {
		if (!viewer) return;
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			else if (e.key === "ArrowRight") step(1);
			else if (e.key === "ArrowLeft") step(-1);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [viewer]);
	if (!viewer) return null;
	const image = viewer.images[viewer.index];
	const many = viewer.images.length > 1;
	return (
		<div className="image-viewer" onClick={close} data-testid="image-viewer">
			<img src={image.src} alt={image.label} onClick={(e) => e.stopPropagation()} />
			<div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
				{many && <button onClick={() => step(-1)}>←</button>}
				<span className="grow ellipsis">
					{image.label}
					{many && <span className="muted"> · {viewer.index + 1} of {viewer.images.length}</span>}
				</span>
				{many && <button onClick={() => step(1)}>→</button>}
				<button onClick={close} title="Close (Esc)">
					✕
				</button>
			</div>
		</div>
	);
}
