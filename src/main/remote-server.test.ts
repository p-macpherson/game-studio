import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type RemoteServer, startRemoteServer } from "./remote-server";
import { safeJoin } from "./assets";
import { tempDir } from "./test-helpers";

let server: RemoteServer;
let calls: { method: string; args: unknown[] }[];
let logins: string[];
let root: string;

beforeEach(async () => {
	root = tempDir();
	mkdirSync(join(root, "page"));
	writeFileSync(join(root, "page/remote.html"), "<p>remote</p>");
	writeFileSync(join(root, "secret.txt"), "nope");
	mkdirSync(join(root, "main/assets"), { recursive: true });
	writeFileSync(join(root, "main/assets/a.png"), "png");
	writeFileSync(join(root, "main/notes.txt"), "text");
	calls = [];
	logins = ["pat@example.com"];
	server = await startRemoteServer({
		port: 0,
		dispatch: async (method, args) => {
			calls.push({ method, args });
			if (method === "sessions.unqueue") return null;
			if (method === "sessions.abort") throw new Error("Not running");
			return { ok: method };
		},
		pageDir: join(root, "page"),
		fileOf: (checkout, path) => safeJoin(join(root, checkout), path),
		logins: () => logins,
	});
});
afterEach(() => server.close());

const as = (login: string | null, extra: Record<string, string> = {}) => ({ ...(login ? { "tailscale-user-login": login } : {}), ...extra });
const call = (method: string, args: unknown[] = [], headers = as("pat@example.com")) =>
	fetch(`${server.url}api/call`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ method, args }) });

it("runs allowed calls for Pat's Tailscale login and refuses everything else", async () => {
	expect(await (await call("sessions.send", ["s1", "hi"])).json()).toEqual({ result: { ok: "sessions.send" } });
	expect(calls).toEqual([{ method: "sessions.send", args: ["s1", "hi"] }]);
	// null comes back as null (unqueue: already delivered); an error as its message.
	expect(await (await call("sessions.unqueue", ["s1", "followUp", 0])).json()).toEqual({ result: null });
	expect(await (await call("sessions.abort", ["s1"])).json()).toEqual({ error: "Not running" });

	// Not on the allow-list: refused before it reaches the studio.
	const terminal = await call("sessions.openTerminal", ["s1"]);
	expect(terminal.status).toBe(403);
	expect(calls.map((c) => c.method)).not.toContain("sessions.openTerminal");

	// Not through `tailscale serve` (no identity), or someone else's login: refused.
	expect((await call("sessions.list", [], as(null))).status).toBe(403);
	expect((await call("sessions.list", [], as("someone@else.com"))).status).toBe(403);
	expect((await fetch(server.url, { headers: as(null) })).status).toBe(403);

	// Another site's page in Pat's browser: a form post isn't JSON, and a fetch carries its own origin.
	const form = await fetch(`${server.url}api/call`, { method: "POST", headers: { "content-type": "text/plain", ...as("pat@example.com") }, body: JSON.stringify({ method: "sessions.list" }) });
	expect(form.status).toBe(415);
	expect((await call("sessions.list", [], as("pat@example.com", { origin: "https://evil.example" }))).status).toBe(403);
	expect(calls.map((c) => c.method).filter((m) => m === "sessions.list")).toEqual([]);

	// An empty list lets anyone `tailscale serve` vouches for in.
	logins = [];
	expect((await call("sessions.list", [], as("someone@else.com"))).status).toBe(200);
});

it("serves the page and a checkout's media, nothing outside them", async () => {
	expect(await (await fetch(server.url, { headers: as("pat@example.com") })).text()).toBe("<p>remote</p>");
	expect(await (await fetch(`${server.url}file/main/assets/a.png`, { headers: as("pat@example.com") })).text()).toBe("png");
	expect((await fetch(`${server.url}file/main/notes.txt`, { headers: as("pat@example.com") })).status).toBe(403); // not media
	expect((await fetch(`${server.url}file/main/..%2Fsecret.png`, { headers: as("pat@example.com") })).status).toBe(400); // outside the checkout
	expect((await fetch(`${server.url}..%2Fsecret.txt`, { headers: as("pat@example.com") })).status).toBe(404); // outside the page
});

it("streams the studio's events to the page", async () => {
	const res = await fetch(`${server.url}api/events`, { headers: as("pat@example.com") });
	const reader = res.body!.getReader();
	await reader.read(); // the greeting: subscribed
	server.broadcast({ type: "sessions_changed" });
	const { value } = await reader.read();
	expect(new TextDecoder().decode(value)).toBe(`data: ${JSON.stringify({ type: "sessions_changed" })}\n\n`);
	await reader.cancel();
});
