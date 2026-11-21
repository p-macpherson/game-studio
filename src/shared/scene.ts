/**
 * Scene and prefab files (`assets/scenes/*.json`, `assets/prefabs/*.json`): the engine's format, edited by the studio
 * structurally. The file is the truth; the running game is only a live view, because the engine's `scene_save`
 * expands prefabs and saves runtime state. See the vault note "M6 Scenes" and the engine's docs/making-a-game.md.
 *
 * Shared by the Scenes section, the main process and agents' tools, so everyone gets the same validation.
 */

export interface SceneFile {
	notes?: string;
	environment?: Record<string, unknown>;
	entities: SceneEntity[];
	[key: string]: unknown;
}

/** Every key other than `id`, `prefab` and `notes` is a component name, e.g. `"Transform": {"position": [0, 1, 0]}`. */
export interface SceneEntity {
	id: number;
	prefab?: string;
	notes?: string;
	[key: string]: unknown;
}

/** One entry of the engine's `components` command. */
export interface ComponentSchema {
	name: string;
	flags: string[];
	fields: { name: string; type: string; values?: string[] }[];
}

export const ENTITY_KEYS = ["id", "prefab", "notes"];

/** Component names on an entity, in file order. */
export function componentsOf(entity: SceneEntity): string[] {
	return Object.keys(entity).filter((k) => !ENTITY_KEYS.includes(k));
}

/** The entity's display name: its `Name`, else the prefab's file name, else `#id`. */
export function entityLabel(entity: SceneEntity, prefabRoot?: SceneEntity): string {
	if (typeof entity.Name === "string") return entity.Name;
	if (prefabRoot && typeof prefabRoot.Name === "string") return prefabRoot.Name;
	if (entity.prefab) return entity.prefab.replace(/^.*\//, "").replace(/\.json$/, "");
	return `#${entity.id}`;
}

/** Comments and trailing commas (JSON5 the engine accepts) removed, so JSON.parse can read older files. */
export function stripJson5(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return dropTrailingCommas(out);
}

/** Commas before a closing bracket removed, outside strings only (a note that says "a, b,]" keeps its text). */
function dropTrailingCommas(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") {
				i++;
				continue;
			}
		}
		out += c;
		i++;
	}
	return out;
}

export interface ParseResult {
	scene?: SceneFile;
	errors: string[];
}

/** Parses a scene or prefab file. Comments are tolerated (older files) but not kept: format writes plain JSON. */
export function parseScene(text: string): ParseResult {
	let value: unknown;
	try {
		value = JSON.parse(stripJson5(text));
	} catch (err) {
		return { errors: [`not valid JSON: ${(err as Error).message}`] };
	}
	if (Array.isArray(value)) value = { entities: value };
	if (!isObject(value)) return { errors: ['expected an object with "entities"'] };
	const scene = value as SceneFile;
	if (scene.entities === undefined) scene.entities = [];
	if (!Array.isArray(scene.entities)) return { errors: ['"entities" must be an array'] };
	const errors: string[] = [];
	scene.entities.forEach((e, i) => {
		if (!isObject(e)) errors.push(`entities[${i}] is not an object`);
		else if (!Number.isInteger(e.id) || (e.id as number) <= 0) errors.push(`entities[${i}]: "id" must be a positive whole number`);
	});
	return { scene, errors };
}

export interface ValidateContext {
	/** The engine's component schemas (from `components`); without them component names and fields aren't checked. */
	schemas?: ComponentSchema[];
	/** Prefab paths that exist (relative to assets/); without them prefab references aren't checked. */
	prefabs?: string[];
}

/** Problems the engine would warn about, or that would break the file: one line each, naming the entity. */
export function validateScene(scene: SceneFile, ctx: ValidateContext = {}): string[] {
	const problems: string[] = [];
	const ids = new Set<number>();
	const schemas = new Map((ctx.schemas ?? []).map((s) => [s.name, s]));
	for (const e of scene.entities) {
		if (ids.has(e.id)) problems.push(`id ${e.id} is used more than once`);
		ids.add(e.id);
	}
	for (const e of scene.entities) {
		const where = `entity ${e.id} (${entityLabel(e)})`;
		if (e.prefab !== undefined && typeof e.prefab !== "string") problems.push(`${where}: "prefab" must be a path`);
		else if (e.prefab && ctx.prefabs && !ctx.prefabs.includes(e.prefab)) problems.push(`${where}: prefab ${e.prefab} not found`);
		for (const name of componentsOf(e)) {
			const value = e[name];
			const schema = schemas.get(name);
			if (ctx.schemas && !schema) {
				problems.push(`${where}: unknown component ${name}${suggest(name, [...schemas.keys()])}`);
				continue;
			}
			if (name === "Name") {
				if (typeof value !== "string") problems.push(`${where}: Name must be a string`);
				continue;
			}
			if (!isObject(value)) {
				problems.push(`${where}: ${name} must be an object of fields`);
				continue;
			}
			if (!schema) continue;
			for (const [field, v] of Object.entries(value)) {
				const f = schema.fields.find((x) => x.name === field);
				if (!f) {
					problems.push(`${where}: ${name} has no field ${field}${suggest(field, schema.fields.map((x) => x.name))}`);
					continue;
				}
				const bad = checkField(f, v);
				if (bad) problems.push(`${where}: ${name}.${field} ${bad}`);
				// One reference, or an array of them ([4]Entity, []Entity): the engine maps file ids wherever they sit.
				const refs = f.type === "Entity" ? [v] : /^\[[^\]]*\]Entity$/.test(f.type) && Array.isArray(v) ? v : [];
				for (const ref of refs) if (typeof ref === "number" && ref !== 0 && !ids.has(ref)) problems.push(`${where}: ${name}.${field} refers to unknown id ${ref}`);
			}
		}
	}
	return problems;
}

function checkField(f: { type: string; values?: string[] }, v: unknown): string | undefined {
	if (f.values) return typeof v === "string" && f.values.includes(v) ? undefined : `must be one of ${f.values.join(", ")}`;
	const vec = /^\[(\d+)\]f32$/.exec(f.type);
	if (vec) return isNumbers(v, Number(vec[1])) ? undefined : `must be ${vec[1]} numbers`;
	switch (f.type) {
		case "quaternion128":
			return isNumbers(v, 3) || isNumbers(v, 4) ? undefined : "must be [pitch, yaw, roll] degrees or a quaternion [x, y, z, w]";
		case "f32":
		case "f64":
			return typeof v === "number" ? undefined : "must be a number";
		case "int":
		case "i32":
		case "i64":
		case "u32":
		case "Entity":
			return Number.isInteger(v) ? undefined : "must be a whole number";
		case "bool":
			return typeof v === "boolean" ? undefined : "must be true or false";
		case "string":
			return typeof v === "string" ? undefined : "must be a string";
	}
	return undefined;
}

function isNumbers(v: unknown, n: number): boolean {
	return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number");
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function suggest(name: string, options: string[]): string {
	const lower = name.toLowerCase();
	const hit = options.find((o) => o.toLowerCase() === lower || o.toLowerCase().replace(/_/g, "") === lower.replace(/_/g, ""));
	return hit ? ` (did you mean ${hit}?)` : "";
}

// ---------------------------------------------------------------------------------------------
// Formatting: plain JSON, one entity per line, so diffs show one line per changed entity.

export function formatScene(scene: SceneFile): string {
	const lines = ["{"];
	const keys = Object.keys(scene).filter((k) => k !== "entities");
	for (const k of keys) lines.push(`  ${JSON.stringify(k)}: ${compact(scene[k])},`);
	const entities = scene.entities.map((e, i) => `    ${compact(e)}${i < scene.entities.length - 1 ? "," : ""}`);
	if (entities.length === 0) lines.push(`  "entities": []`);
	else lines.push(`  "entities": [`, ...entities, "  ]");
	lines.push("}");
	return lines.join("\n") + "\n";
}

/** JSON on one line with a space after each `:` and `,`, as the hand-written files are. */
export function compact(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(compact).join(", ")}]`;
	if (isObject(v)) return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(", ")}}`;
	if (typeof v === "number") return JSON.stringify(round(v));
	return JSON.stringify(v);
}

/** Removes float noise (0.30000000000000004) without changing values a person wrote. */
export function round(n: number): number {
	return Number.isInteger(n) ? n : Number(n.toPrecision(7));
}

// ---------------------------------------------------------------------------------------------
// Edits. Each returns a new SceneFile and leaves the input alone; key order is kept, so a formatted file only
// changes where the edit did.

export function findEntity(scene: SceneFile, id: number): SceneEntity | undefined {
	return scene.entities.find((e) => e.id === id);
}

function requireEntity(scene: SceneFile, id: number): SceneEntity {
	const e = findEntity(scene, id);
	if (!e) throw new Error(`no entity with id ${id}`);
	return e;
}

function replaceEntity(scene: SceneFile, id: number, next: SceneEntity): SceneFile {
	return { ...scene, entities: scene.entities.map((e) => (e.id === id ? next : e)) };
}

export function nextId(scene: SceneFile): number {
	return scene.entities.reduce((m, e) => Math.max(m, e.id), 0) + 1;
}

/**
 * Patches one component's fields (adding the component if missing). A field set to `null` is removed, which
 * returns it to its default (or, on a prefab instance, to the prefab's value).
 */
export function setComponent(scene: SceneFile, id: number, component: string, patch: Record<string, unknown> | string): SceneFile {
	const e = requireEntity(scene, id);
	if (typeof patch === "string" || component === "Name") return replaceEntity(scene, id, { ...e, [component]: patch });
	const merged: Record<string, unknown> = { ...(isObject(e[component]) ? (e[component] as Record<string, unknown>) : {}) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete merged[k];
		else merged[k] = v;
	}
	return replaceEntity(scene, id, { ...e, [component]: merged });
}

export function removeComponent(scene: SceneFile, id: number, component: string): SceneFile {
	const { [component]: _, ...rest } = requireEntity(scene, id);
	return replaceEntity(scene, id, rest as SceneEntity);
}

export function setEntityNotes(scene: SceneFile, id: number, notes: string): SceneFile {
	const e = requireEntity(scene, id);
	const next = { ...e, notes: notes || undefined };
	if (!notes) delete next.notes;
	return replaceEntity(scene, id, next);
}

export function setEnvironment(scene: SceneFile, patch: Record<string, unknown>): SceneFile {
	const env: Record<string, unknown> = { ...(scene.environment ?? {}) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete env[k];
		else env[k] = v;
	}
	return { ...scene, environment: env };
}

/** Adds an entity (its id assigned unless given) after the last entity; returns the new scene and the id. */
export function addEntity(scene: SceneFile, entity: Omit<SceneEntity, "id"> & { id?: number }): { scene: SceneFile; id: number } {
	const id = entity.id ?? nextId(scene);
	if (findEntity(scene, id)) throw new Error(`id ${id} is already used`);
	const { id: _, ...rest } = entity;
	return { scene: { ...scene, entities: [...scene.entities, { id, ...rest } as SceneEntity] }, id };
}

/** Ids of `id` and every entity parented under it in the file, parents first. */
export function subtree(scene: SceneFile, id: number): number[] {
	const out = [id];
	for (let i = 0; i < out.length; i++) {
		for (const e of scene.entities) if (parentOf(e) === out[i] && !out.includes(e.id)) out.push(e.id);
	}
	return out;
}

export function parentOf(e: SceneEntity): number {
	const t = e.Transform;
	return isObject(t) && typeof t.parent === "number" ? t.parent : 0;
}

/** Deletes an entity and its children; returns the new scene and the deleted ids. */
export function deleteEntity(scene: SceneFile, id: number): { scene: SceneFile; deleted: number[] } {
	requireEntity(scene, id);
	const deleted = subtree(scene, id);
	return { scene: { ...scene, entities: scene.entities.filter((e) => !deleted.includes(e.id)) }, deleted };
}

/**
 * Copies an entity and its children with new ids (parent references inside the copy follow it; references in other
 * components keep pointing at what the original pointed at), optionally moved to `position`. Returns the new scene, the copy's id, and old → new ids.
 */
export function duplicateEntity(scene: SceneFile, id: number, position?: number[]): { scene: SceneFile; id: number; ids: Map<number, number> } {
	const ids = new Map<number, number>();
	let next = nextId(scene);
	for (const old of subtree(scene, id)) ids.set(old, next++);
	const copies = [...ids.keys()].map((old) => {
		const copy = structuredClone(requireEntity(scene, old));
		copy.id = ids.get(old)!;
		if (isObject(copy.Transform) && typeof copy.Transform.parent === "number" && ids.has(copy.Transform.parent)) {
			copy.Transform.parent = ids.get(copy.Transform.parent);
		}
		return copy;
	});
	if (position) {
		const root = copies[0];
		root.Transform = { ...(isObject(root.Transform) ? root.Transform : {}), position };
	}
	return { scene: { ...scene, entities: [...scene.entities, ...copies] }, id: ids.get(id)!, ids };
}

/**
 * The components an entity ends up with: a prefab root's, overridden per component by the entity's own (the
 * engine patches field by field, so the effective value of each field is the entity's if set, else the prefab's).
 */
export function effectiveComponents(entity: SceneEntity, prefabRoot?: SceneEntity): Record<string, { value: unknown; fromPrefab: Record<string, unknown> | undefined }> {
	const out: Record<string, { value: unknown; fromPrefab: Record<string, unknown> | undefined }> = {};
	const names = [...new Set([...(prefabRoot ? componentsOf(prefabRoot) : []), ...componentsOf(entity)])];
	for (const name of names) {
		const own = entity[name];
		const base = prefabRoot?.[name];
		if (isObject(own) && isObject(base)) out[name] = { value: { ...base, ...own }, fromPrefab: base };
		else out[name] = { value: own ?? base, fromPrefab: isObject(base) ? base : undefined };
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Rotations: files may hold Euler degrees [pitch, yaw, roll] or quaternions [x, y, z, w]; the studio edits Euler.
// The same convention as the engine's ecs.euler_to_quat.

const DEG = Math.PI / 180;

/** [pitch, yaw, roll] degrees → [x, y, z, w]: yaw about Y, then pitch about X, then roll about Z (q = qy * qx * qz). */
export function eulerToQuat([pitch, yaw, roll]: number[]): number[] {
	const [sx, cx] = [Math.sin((pitch * DEG) / 2), Math.cos((pitch * DEG) / 2)];
	const [sy, cy] = [Math.sin((yaw * DEG) / 2), Math.cos((yaw * DEG) / 2)];
	const [sz, cz] = [Math.sin((roll * DEG) / 2), Math.cos((roll * DEG) / 2)];
	return [cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz, cy * cx * sz - sy * sx * cz, cy * cx * cz + sy * sx * sz];
}

/** [x, y, z, w] → [pitch, yaw, roll] degrees, rounded to 0.01°. */
export function quatToEuler([x, y, z, w]: number[]): number[] {
	const pitch = Math.asin(Math.max(-1, Math.min(1, -2 * (y * z - w * x))));
	const yaw = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
	const roll = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z));
	return [pitch, yaw, roll].map((r) => Math.round((r / DEG) * 100) / 100 + 0);
}

/** A file rotation (Euler or quaternion, absent = none) as Euler degrees. */
export function rotationDegrees(v: unknown): number[] {
	if (isNumbers(v, 3)) return v as number[];
	if (isNumbers(v, 4)) return quatToEuler(v as number[]);
	return [0, 0, 0];
}

// ---------------------------------------------------------------------------------------------
// A batch of edits, as the Scenes section sends them to a session's worktree (`edit_scene`).

export type SceneEdit =
	/** Patch a component's fields (adding it if missing); a field set to null is removed. */
	| { op: "set"; id: number; component: string; value: Record<string, unknown> | string }
	| { op: "remove_component"; id: number; component: string }
	| { op: "add"; entity: Omit<SceneEntity, "id"> & { id?: number } }
	| { op: "delete"; id: number }
	| { op: "duplicate"; id: number; position?: number[] }
	| { op: "notes"; id: number; notes: string }
	| { op: "environment"; value: Record<string, unknown> };

export interface EditResult {
	/** The entity each edit created (add, duplicate), in order. */
	created: number[];
	deleted: number[];
}

export function applyEdits(scene: SceneFile, edits: SceneEdit[]): { scene: SceneFile } & EditResult {
	const created: number[] = [];
	const deleted: number[] = [];
	for (const e of edits) {
		switch (e.op) {
			case "set":
				scene = setComponent(scene, e.id, e.component, e.value);
				break;
			case "remove_component":
				scene = removeComponent(scene, e.id, e.component);
				break;
			case "add": {
				const r = addEntity(scene, e.entity);
				scene = r.scene;
				created.push(r.id);
				break;
			}
			case "delete": {
				const r = deleteEntity(scene, e.id);
				scene = r.scene;
				deleted.push(...r.deleted);
				break;
			}
			case "duplicate": {
				const r = duplicateEntity(scene, e.id, e.position);
				scene = r.scene;
				created.push(r.id);
				break;
			}
			case "notes":
				scene = setEntityNotes(scene, e.id, e.notes);
				break;
			case "environment":
				scene = setEnvironment(scene, e.value);
				break;
			default:
				throw new Error(`unknown scene edit ${JSON.stringify(e)}`);
		}
	}
	return { scene, created, deleted };
}
