// Launches the built app, waits for the session host to report in, and saves a screenshot.
// Run: npm run build && node e2e/smoke.ts [screenshot-path]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";

const shot = process.argv[2] ?? "out/smoke.png";
const userData = mkdtempSync(join(tmpdir(), "game-studio-e2e-"));
const app = await electron.launch({ args: ["."], env: { ...process.env, GAME_STUDIO_USER_DATA: userData } });
try {
	const win = await app.firstWindow();
	const info = win.getByTestId("host-info");
	await info.filter({ hasText: "Session host ready" }).waitFor({ timeout: 20_000 });
	console.log(await info.textContent());
	await win.screenshot({ path: shot });
	console.log("screenshot:", shot);
} finally {
	await app.close();
}
