import { execFileSync, spawn } from "node:child_process";

/** Terminal emulators we know how to launch, with the flag that precedes the command to run. */
const TERMINALS: [string, string[]][] = [
	["konsole", ["-e"]],
	["alacritty", ["-e"]],
	["kitty", []],
	["wezterm", ["start", "--"]],
	["ghostty", ["-e"]],
	["foot", []],
	["gnome-terminal", ["--"]],
	["xterm", ["-e"]],
];

function available(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Opens the user's terminal running `command` in `cwd`. Honours $TERMINAL when it's one we know. */
export function openTerminal(cwd: string, command: string[], env: Record<string, string>): void {
	const preferred = process.env.TERMINAL;
	const match = TERMINALS.find(([name]) => name === preferred && available(name)) ?? TERMINALS.find(([name]) => available(name));
	if (!match) throw new Error("No supported terminal emulator found (set $TERMINAL)");
	const [bin, prefix] = match;
	spawn(bin, [...prefix, ...command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" }).unref();
}
