/** Local asset generation: a GPU job queue over model workers. See the vault note "M4 3D Models". */

/** A Python environment with its worker; only one runs at a time, since only one model family fits in VRAM. */
export type GenFamily = "image" | "hunyuan3d" | "unirig" | "stable-audio" | "surface";

/** Families that never touch the GPU: their worker runs beside whichever one holds it, and is gone when its job is. */
export const CPU_FAMILIES: readonly GenFamily[] = ["surface"];

export type GenJobKind = "image" | "surface" | "surface_make" | "ui_cut" | "ui_make" | "particle_cut" | "particle_make" | "shape" | "texture" | "rig" | "sound" | BlenderJobKind;

/** Jobs that run a script in gen/blender/ (on the CPU, beside the GPU queue's model workers). */
export type BlenderJobKind = "finalize" | "animate" | "rig_prop" | "retarget";
export const BLENDER_JOBS: readonly BlenderJobKind[] = ["finalize", "animate", "rig_prop", "retarget"];

/**
 * Clips a rigged biped can be given (`animate_model`), by the name the game plays them under. Most are retargeted
 * from the animation library (Quaternius's Universal Animation Library, CC0: gen/blender/retarget.py), named here
 * with the library's clip; `wave` is keyed procedurally (gen/blender/animate.py), as `idle` and `walk` are when the
 * library isn't installed.
 */
export const LIBRARY_CLIPS = {
	// Loops
	idle: "Idle_Loop",
	idle_talk: "Idle_Talking_Loop",
	idle_torch: "Idle_Torch_Loop",
	walk: "Walk_Loop",
	walk_formal: "Walk_Formal_Loop",
	run: "Jog_Fwd_Loop",
	sprint: "Sprint_Loop",
	crouch_idle: "Crouch_Idle_Loop",
	crouch_walk: "Crouch_Fwd_Loop",
	jump_loop: "Jump_Loop",
	push: "Push_Loop",
	swim: "Swim_Fwd_Loop",
	swim_idle: "Swim_Idle_Loop",
	sit_idle: "Sitting_Idle_Loop",
	sit_talk: "Sitting_Talking_Loop",
	dance: "Dance_Loop",
	drive: "Driving_Loop",
	sword_idle: "Sword_Idle",
	pistol_idle: "Pistol_Idle_Loop",
	spell_idle: "Spell_Simple_Idle_Loop",
	// One-shots (play with "once")
	jump_start: "Jump_Start",
	jump_land: "Jump_Land",
	roll: "Roll",
	attack: "Sword_Attack",
	punch_enter: "Punch_Enter",
	punch_jab: "Punch_Jab",
	punch_cross: "Punch_Cross",
	hit: "Hit_Chest",
	hit_head: "Hit_Head",
	death: "Death01",
	pick_up: "PickUp_Table",
	interact: "Interact",
	fix_kneeling: "Fixing_Kneeling",
	sit_down: "Sitting_Enter",
	stand_up: "Sitting_Exit",
	spell_enter: "Spell_Simple_Enter",
	spell_shoot: "Spell_Simple_Shoot",
	spell_exit: "Spell_Simple_Exit",
	pistol_shoot: "Pistol_Shoot",
	pistol_reload: "Pistol_Reload",
	// Held poses (a few frames: blend between them to aim)
	pistol_aim: "Pistol_Aim_Neutral",
	pistol_aim_up: "Pistol_Aim_Up",
	pistol_aim_down: "Pistol_Aim_Down",
} as const;
export const PROCEDURAL_CLIPS = ["idle", "walk", "wave"] as const;
export const ANIMATION_CLIPS = [...new Set([...Object.keys(LIBRARY_CLIPS), ...PROCEDURAL_CLIPS])] as (keyof typeof LIBRARY_CLIPS | "wave")[];
/** What `animate_model` makes when it isn't told which. */
export const DEFAULT_CLIPS = ["idle", "walk", "wave"] as const;

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
	// Tileable surface textures (M9): candidates on the GPU; the maps on the CPU, in a small worker of their own, so
	// making a texture doesn't stop a warm model of another family.
	surface: { family: "image", op: "surface" },
	surface_make: { family: "surface", op: "surface_make" },
	// UI art (M10): generated with "image", then cut out, mirrored and sliced on the CPU.
	ui_cut: { family: "surface", op: "ui_cut" },
	ui_make: { family: "surface", op: "ui_make" },
	// Particle textures (M12): sprites generated with "image" and cut out, or made procedurally, on the CPU.
	particle_cut: { family: "surface", op: "particle_cut" },
	particle_make: { family: "surface", op: "particle_make" },
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
