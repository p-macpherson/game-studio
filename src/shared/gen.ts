/** Local asset generation: a GPU job queue over model workers. See the vault note "M4 3D Models". */

/** A Python environment with its worker; only one runs at a time, since only one model family fits in VRAM. */
export type GenFamily = "image" | "hunyuan3d" | "unirig" | "stable-audio";

export type GenJobKind = "image" | "surface" | "surface_make" | "shape" | "texture" | "rig" | "sound" | BlenderJobKind;

/** Jobs that run a script in gen/blender/ (on the CPU, beside the GPU queue's model workers). */
export type BlenderJobKind = "finalize" | "animate" | "rig_prop";
export const BLENDER_JOBS: readonly BlenderJobKind[] = ["finalize", "animate", "rig_prop"];

export type GenJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface GenJob {
	id: string;
	kind: GenJobKind;
	/** Short description for lists, e.g. "Shape for chest". */
	label: string;
	params: Record<string, unknown>;
	status: GenJobStatus;
	progress?: { message: string; fraction?: number | null };
	result?: Record<string, unknown>;
	error?: string;
	/** The session that asked for it, if any. */
	sessionId?: string;
	/** It ran out of GPU memory once and was retried in a fresh worker. */
	retried?: boolean;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
}

export interface GenComponent {
	id: string;
	name: string;
	ok: boolean;
	detail: string;
}

export interface GenStatus {
	/** Where environments, weights and model repos live. */
	root: string;
	ready: boolean;
	components: GenComponent[];
	/** The worker currently holding the GPU. */
	worker: { family: GenFamily; state: "starting" | "idle" | "busy" } | null;
	/** `GAME_STUDIO_GEN_FAKE=1`: placeholder outputs from a fake worker, for tests. */
	fake: boolean;
	installing: boolean;
}

/** Which worker runs each GPU job kind (Blender jobs run on the CPU). */
export const FAMILY_OF: Record<Exclude<GenJobKind, BlenderJobKind>, { family: GenFamily; op: string }> = {
	image: { family: "image", op: "image" },
	// Tileable surface textures (M9): candidates on the GPU, then the maps (CPU, in the same worker).
	surface: { family: "image", op: "surface" },
	surface_make: { family: "image", op: "surface_make" },
	shape: { family: "hunyuan3d", op: "shape" },
	texture: { family: "hunyuan3d", op: "texture" },
	rig: { family: "unirig", op: "rig" },
	sound: { family: "stable-audio", op: "sound" },
};

/** A concept image in a model's `concepts/` folder, with how it was made when the studio made it. */
export interface ConceptImage {
	/** Repo-relative. */
	path: string;
	record?: ConceptRecord;
}

/** One generated concept image, recorded in `concepts/concepts.json` (keyed by file name). */
export interface ConceptRecord {
	prompt: string;
	seed: number;
	model: string;
	/** File names of reference images it was generated from. */
	references?: string[];
	at: string;
}

/**
 * `assets/models/<name>/model.json`: how a model was made, so it can be reproduced and modified. It's written
 * as soon as a model has concepts, so the 3D Models section lists it from then on (`height` and `stats` appear
 * once there's a 3D model).
 */
export interface ModelManifest {
	name: string;
	description?: string;
	/** Repo-relative to the model folder. */
	concept?: string;
	/** How the concept was generated, when the studio made it (from concepts/concepts.json). */
	conceptSource?: ConceptRecord;
	/** The file in source/ the model was last finalized from (relative to the model folder). */
	source?: string;
	back?: string;
	/** Metres; set when a 3D model is generated. */
	height?: number;
	textured: boolean;
	rigged: boolean;
	/** `auto`: UniRig (characters, creatures); `prop`: a hinge rig made by gen/blender/rig_prop.py. */
	rig?: "auto" | "prop";
	/** The hinge settings of a prop rig, so it can be remade after re-texturing. */
	propRig?: { split: number; hinge: string; angle: number };
	/** Bone roles of an animated biped: role (e.g. "upper_arm.L") -> UniRig's original name. */
	bones?: Record<string, string>;
	/** Clips added by the animate step (remade after re-texturing or re-rigging). */
	clips?: string[];
	steps: { kind: GenJobKind; model?: string; seed?: number; seconds?: number; at: string }[];
	stats?: Record<string, unknown>;
}
