import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostInfo, StudioApi } from "../shared/ipc";

declare global {
	interface Window {
		studio: StudioApi;
	}
}

function App() {
	const [info, setInfo] = useState<HostInfo | string>("starting session host…");
	useEffect(() => {
		window.studio.hostInfo().then(setInfo, (err: Error) => setInfo(`session host error: ${err.message}`));
	}, []);
	return (
		<main style={{ fontFamily: "system-ui", padding: 24 }}>
			<h1>Game Studio</h1>
			<p data-testid="host-info">
				{typeof info === "string" ? info : `Session host ready: Pi ${info.piVersion}, Node ${info.node}, ${info.providers} providers`}
			</p>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
