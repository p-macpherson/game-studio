// Play scenarios: named ways to start the game in Play & Test other than from its start (a sandbox for one mechanic, a
// level in a chosen environment). A scenario is a file, `scenarios/<name>.json`; agents write and maintain them. It may
// open a scene, pass launch flags the game reads with `engine.arg`, and send control commands once the game runs; its
// parameters (`{id}` in any of those) are set by the person before playing.

export const SCENARIO_DIR = "scenarios";

export type ScenarioValue = string | number | boolean;
export type ScenarioValues = Record<string, ScenarioValue>;

export interface ScenarioParam {
	/** How it is written in the file: `{id}`. Lowercase letters, digits and underscores. */
	id: string;
	label?: string;
	type: "choice" | "number" | "toggle" | "text";
	/** For a choice: what can be picked. */
	options?: string[];
	default?: ScenarioValue;
	/** For a number. */
	min?: number;
	max?: number;
	step?: number;
	/** For a number: offer a button that rolls a new one (a seed). */
	random?: boolean;
	help?: string;
}

export interface Scenario {
	title: string;
	description?: string;
	/** What to try once it's running. */
	notes?: string;
	/** A scene to open instead of the game's own (assets-relative, as the engine's --scene takes it). */
	scene?: string;
	/** Launch flags: `--name=value` (true: `--name`; false: left out). The game reads them with engine.arg. */
	flags?: Record<string, ScenarioValue>;
	/** Control commands sent in order once the game runs, each `{"cmd": ..., ...}` as in a test script. */
	setup?: Record<string, unknown>[];
	params?: ScenarioParam[];
}

/** Flags the studio sets itself for every run. */
const RESERVED = new Set(["mode", "control", "script", "keep-open", "host", "join", "name", "fps", "read-pads"]);
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

const isValue = (v: unknown): v is ScenarioValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function placeholders(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string") for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1]);
	else if (Array.isArray(value)) for (const v of value) placeholders(v, out);
	else if (value && typeof value === "object") for (const v of Object.values(value)) placeholders(v, out);
	return out;
}

/** Reads a scenario file. `problems` says what is wrong with it in words an agent can act on; with any, don't run it. */
export function parseScenario(text: string): { scenario: Scenario | null; problems: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { scenario: null, problems: [`Not valid JSON: ${(err as Error).message}`] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { scenario: null, problems: ["A scenario is a JSON object"] };
	const o = raw as Record<string, unknown>;
	const problems: string[] = [];
	const text_ = (key: string) => {
		if (o[key] === undefined) return undefined;
		if (typeof o[key] !== "string") problems.push(`"${key}" must be text`);
		return typeof o[key] === "string" ? (o[key] as string) : undefined;
	};
	const known = new Set(["title", "description", "notes", "scene", "flags", "setup", "params"]);
	for (const key of Object.keys(o)) if (!known.has(key)) problems.push(`Unknown field "${key}" (a scenario has: ${[...known].join(", ")})`);
	const title = text_("title");
	if (!title?.trim()) problems.push('Give it a "title"');
	const params: ScenarioParam[] = [];
	if (o.params !== undefined && !Array.isArray(o.params)) problems.push('"params" must be a list');
	for (const [i, p] of (Array.isArray(o.params) ? o.params : []).entries()) {
		const where = `params[${i}]`;
		if (!p || typeof p !== "object") {
			problems.push(`${where} must be an object`);
			continue;
		}
		const q = p as Record<string, unknown>;
		if (typeof q.id !== "string" || !/^[a-z][a-z0-9_]*$/.test(q.id)) {
			problems.push(`${where}: "id" must be lowercase letters, digits and underscores, starting with a letter`);
			continue;
		}
		if (params.some((x) => x.id === q.id)) problems.push(`Two parameters are called "${q.id}"`);
		const type = q.type as ScenarioParam["type"];
		if (!["choice", "number", "toggle", "text"].includes(type)) {
			problems.push(`${q.id}: "type" must be choice, number, toggle or text`);
			continue;
		}
		const param: ScenarioParam = { id: q.id, type };
		if (typeof q.label === "string") param.label = q.label;
		if (typeof q.help === "string") param.help = q.help;
		if (type === "choice") {
			const options = Array.isArray(q.options) ? q.options.filter((x): x is string => typeof x === "string") : [];
			if (!options.length) problems.push(`${q.id}: a choice needs "options" (a list of text)`);
			param.options = options;
			if (q.default !== undefined && !options.includes(q.default as string)) problems.push(`${q.id}: its default "${String(q.default)}" isn't one of its options`);
		}
		if (type === "number") {
			for (const k of ["min", "max", "step"] as const) if (typeof q[k] === "number") param[k] = q[k] as number;
			if (q.random === true) param.random = true;
			if (q.default !== undefined && typeof q.default !== "number") problems.push(`${q.id}: its default must be a number`);
		}
		if (type === "toggle" && q.default !== undefined && typeof q.default !== "boolean") problems.push(`${q.id}: its default must be true or false`);
		if (type === "text" && q.default !== undefined && typeof q.default !== "string") problems.push(`${q.id}: its default must be text`);
		if (isValue(q.default)) param.default = q.default;
		params.push(param);
	}
	const flags: Record<string, ScenarioValue> = {};
	if (o.flags !== undefined && (!o.flags || typeof o.flags !== "object" || Array.isArray(o.flags))) problems.push('"flags" must be an object of name: value');
	else
		for (const [name, v] of Object.entries((o.flags as Record<string, unknown>) ?? {})) {
			if (RESERVED.has(name)) problems.push(`The flag "${name}" is set by the studio for every run: leave it out`);
			else if (name === "scene") problems.push('Give the scene as "scene", not as a flag');
			else if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`The flag name "${name}" must be lowercase letters, digits and dashes`);
			else if (!isValue(v)) problems.push(`The flag "${name}" must be text, a number, or true/false`);
			else flags[name] = v;
		}
	const setup: Record<string, unknown>[] = [];
	if (o.setup !== undefined && !Array.isArray(o.setup)) problems.push('"setup" must be a list of control commands');
	for (const [i, c] of (Array.isArray(o.setup) ? o.setup : []).entries()) {
		if (!c || typeof c !== "object" || Array.isArray(c) || typeof (c as { cmd?: unknown }).cmd !== "string") problems.push(`setup[${i}] must be a control command: {"cmd": "...", ...}`);
		else if (["quit", "exit"].includes((c as { cmd: string }).cmd)) problems.push(`setup[${i}]: a scenario leaves the game running for the person: no "${(c as { cmd: string }).cmd}"`);
		else setup.push(c as Record<string, unknown>);
	}
	const scene = text_("scene");
	const ids = new Set(params.map((p) => p.id));
	for (const used of placeholders([scene, flags, setup])) if (!ids.has(used)) problems.push(`{${used}} is used but there's no parameter with that id`);
	const scenario: Scenario = { title: title?.trim() ?? "", ...(text_("description") ? { description: o.description as string } : {}), ...(text_("notes") ? { notes: o.notes as string } : {}), ...(scene ? { scene } : {}), flags, setup, params };
	return { scenario, problems };
}

/** A parameter's value when none was picked: its default, else the first option, 0, false or nothing. */
export function defaultValue(p: ScenarioParam): ScenarioValue {
	if (p.default !== undefined) return p.default;
	return p.type === "choice" ? (p.options?.[0] ?? "") : p.type === "number" ? (p.min ?? 0) : p.type === "toggle" ? false : "";
}

/** Every parameter's value: the ones given where they suit the parameter (a saved choice that still exists), else its default. */
export function scenarioValues(s: Scenario, given: Record<string, unknown> = {}): ScenarioValues {
	const out: ScenarioValues = {};
	for (const p of s.params ?? []) {
		const v = given[p.id];
		const fits =
			p.type === "choice" ? typeof v === "string" && !!p.options?.includes(v) : p.type === "number" ? typeof v === "number" && Number.isFinite(v) : p.type === "toggle" ? typeof v === "boolean" : typeof v === "string";
		out[p.id] = fits ? (v as ScenarioValue) : defaultValue(p);
		if (p.type === "number") out[p.id] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, out[p.id] as number));
	}
	return out;
}

function fill(value: unknown, values: ScenarioValues): unknown {
	if (typeof value === "string") {
		// A string that is only a placeholder keeps the value's type (a number stays a number in a command).
		const whole = /^\{([a-z][a-z0-9_]*)\}$/.exec(value);
		if (whole && whole[1] in values) return values[whole[1]];
		return value.replace(PLACEHOLDER, (m, id: string) => (id in values ? String(values[id]) : m));
	}
	if (Array.isArray(value)) return value.map((v) => fill(v, values));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)]));
	return value;
}

export interface ScenarioLaunch {
	/** The values used, one per parameter. */
	values: ScenarioValues;
	/** Extra command-line arguments for the game: its flags and its scene. */
	args: string[];
	/** Control commands to send once the game runs. */
	setup: { cmd: string; args: Record<string, unknown> }[];
}

/** What starting a scenario with these values comes to. */
export function resolveScenario(s: Scenario, given: Record<string, unknown> = {}): ScenarioLaunch {
	const values = scenarioValues(s, given);
	const args: string[] = [];
	for (const [name, raw] of Object.entries(s.flags ?? {})) {
		const v = fill(raw, values) as ScenarioValue;
		if (v === false || v === "") continue;
		args.push(v === true ? `--${name}` : `--${name}=${String(v)}`);
	}
	if (s.scene) args.push(`--scene=${String(fill(s.scene, values))}`);
	const setup = (s.setup ?? []).map((c) => {
		const { cmd, ...rest } = fill(c, values) as { cmd: string; [k: string]: unknown };
		return { cmd, args: rest };
	});
	return { values, args, setup };
}

/** A scenario's name from its path: `scenarios/sandbox/rope.json` is "sandbox/rope". */
export const scenarioNameOf = (path: string) => path.slice(SCENARIO_DIR.length + 1).replace(/\.json$/, "");
