// Tools every session gets, through which the agent talks back to Game Studio.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ANIMATION_CLIPS } from "../shared/gen";
import type { HostEvent, StudioRequestMethod } from "../shared/host";

export interface StudioToolContext {
	sessionId: string;
	post(event: HostEvent): void;
	/** Waits for the user's answer to an `ask_user` question. */
	ask(questionId: string, signal: AbortSignal | undefined): Promise<string>;
	/** The studio tools it may use beyond the always-on ones; absent means all. */
	studioTools?: string[];
	/** The agent types this session may delegate to; none means no `delegate` tool. */
	delegatesTo?: { id: string; name: string; description: string }[];
	/** Calls a main-process service (asset generation) and waits for its reply. */
	request(method: StudioRequestMethod, params: Record<string, unknown>, signal: AbortSignal | undefined, progress: (text: string) => void): Promise<unknown>;
}

const MODEL_NAME = Type.String({ description: "The model's folder under assets/models/, lower-kebab-case, with '/' for folders: e.g. 'treasure-chest', 'props/barrel'" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

type Update = (partial: { content: { type: "text"; text: string }[]; details: Record<string, never> }) => void;
/** A request's progress lines, shown as the tool call's updates in the chat. */
const progressTo = (onUpdate: Update | undefined) => (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });

const image = (dataUrl: string | undefined) => {
	const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl ?? "") ?? [];
	return data ? [{ type: "image" as const, mimeType, data }] : [];
};
/** A result whose `key` is a picture (a data URL) for the agent to look at: the rest as JSON, `caption`, then the picture. */
function pictured(result: unknown, key: string, caption: string) {
	const { [key]: dataUrl, ...rest } = result as Record<string, unknown>;
	const images = image(dataUrl as string | undefined);
	return { content: [{ type: "text" as const, text: `${JSON.stringify(rest, null, 2)}${images.length ? `\n${caption}` : ""}` }, ...images], details: {} };
}

export function studioTools(ctx: StudioToolContext) {
	const tool = (tool: "set_session_title" | "request_review" | "open_in_studio", params: Record<string, string>) =>
		ctx.post({ type: "studio_tool", id: ctx.sessionId, tool, params });
	let questions = 0;

	// Generation tools run on the local GPU through the studio's job queue and can take a minute or more.
	const generation = (method: StudioRequestMethod) =>
		async (
			_id: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: Update,
		) => {
			const result = await ctx.request(method, params, signal, progressTo(onUpdate));
			return ok(typeof result === "string" ? result : JSON.stringify(result, null, 2));
		};

	const delegation = ctx.delegatesTo?.length
		? [
				defineTool({
					name: "delegate",
					label: "Delegate to a sub-agent",
					description:
						"Hand a task to a sub-agent: a new session of another agent type that works in your worktree (its commits land beside yours) and that the " +
						"user can watch and talk to. This waits until it finishes and returns its final report. Several delegate calls at once (e.g. Promise.all in " +
						"a codemode script) run side by side. The sub-agent doesn't see your conversation: give it the whole task, the context it needs, what " +
						"done looks like, and paths to the files involved. You can delegate to: " +
						ctx.delegatesTo.map((t) => `${t.id} (${t.name}: ${t.description})`).join("; "),
					parameters: Type.Object({
						agentType: Type.Union(ctx.delegatesTo.map((t) => Type.Literal(t.id))),
						task: Type.String({ description: "The task, with everything the sub-agent needs to know" }),
						title: Type.Optional(Type.String({ description: "A short title for its session" })),
					}),
					async execute(_id, params, signal, onUpdate) {
						const report = await ctx.request("delegate", params, signal, progressTo(onUpdate));
						return ok(String(report));
					},
				}),
			]
		: [];

	const tools = [
		...delegation,
		defineTool({
			name: "generate_concept_images",
			label: "Generate concept images",
			description:
				"Generate concept images for a 3D model with a local image model (FLUX.2 Klein). Images are written to assets/models/<model>/concepts/. " +
				"Describe one object and its style; the studio adds 'single object, full view, plain white background' so the images work for image-to-3D. " +
				"Pass reference images to make variations or other views (e.g. 'the same object seen from behind'). Show the results to the user with open_in_studio and let them choose.",
			parameters: Type.Object({
				model: MODEL_NAME,
				prompt: Type.String(),
				count: Type.Optional(Type.Number({ description: "How many variations (1-8, default 4)" })),
				references: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative reference images" })),
				seed: Type.Optional(Type.Number()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("generate_concepts", params, signal, progressTo(onUpdate)), "sheet", "All of them, numbered in the order above:");
			},
		}),
		defineTool({
			name: "generate_model",
			label: "Generate 3D model",
			description:
				"Turn a concept image into an engine-ready 3D model: shape (Hunyuan3D), optional texture (Hunyuan3D-Paint) and rig (UniRig), then a Blender pass that welds, " +
				"scales to `height` metres with the base at the origin, keeps every mesh under the engine's 65,535-vertex limit, exports assets/models/<model>/<model>.glb " +
				"and renders a thumbnail. Intermediates go in source/, and model.json records how it was made. Takes about 1-2 minutes. " +
				"Add `back` (a back view of the same object) only when the back can't be inferred from the front. Rig characters and creatures; rig props yourself in Blender.",
			parameters: Type.Object({
				model: MODEL_NAME,
				image: Type.String({ description: "Repo-relative concept image (front or three-quarter view)" }),
				height: Type.Number({ description: "Height in metres in the game world" }),
				back: Type.Optional(Type.String({ description: "Repo-relative back view of the same object" })),
				texture: Type.Optional(Type.Boolean({ description: "Paint a texture from the image (default true)" })),
				rig: Type.Optional(Type.Boolean({ description: "Add a skeleton and skin weights (default false)" })),
				description: Type.Optional(Type.String()),
			}),
			execute: generation("generate_model"),
		}),
		defineTool({
			name: "retexture_model",
			label: "Re-texture 3D model",
			description: "Paint a new texture onto an existing model's shape from a (new or edited) concept image, then re-rig if it was rigged and finalize.",
			parameters: Type.Object({ model: MODEL_NAME, image: Type.String({ description: "Repo-relative concept image" }) }),
			execute: generation("retexture_model"),
		}),
		defineTool({
			name: "rig_model",
			label: "Rig 3D model",
			description: "Add a skeleton and skin weights to an existing model with UniRig (characters and creatures), then finalize.",
			parameters: Type.Object({ model: MODEL_NAME }),
			execute: generation("rig_model"),
		}),
		defineTool({
			name: "rig_prop",
			label: "Rig a prop",
			description:
				"Give a prop a hinge (a chest lid, a door, a hatch): the mesh is cut at `split` of its height (the part above moves), both sides are capped, " +
				"a `lid` bone is hinged on the `hinge` side, and clips `open` and `close` are added. Replaces any rig the model had. Check it with preview_model.",
			parameters: Type.Object({
				model: MODEL_NAME,
				split: Type.Optional(Type.Number({ description: "Where the moving part starts, as a fraction of the height (default 0.6)" })),
				hinge: Type.Optional(Type.Union([Type.Literal("back"), Type.Literal("front"), Type.Literal("left"), Type.Literal("right")])),
				angle: Type.Optional(Type.Number({ description: "How far it opens, in degrees (default 100)" })),
			}),
			execute: generation("rig_prop"),
		}),
		defineTool({
			name: "animate_model",
			label: "Animate 3D model",
			description:
				"For a character rigged with rig_model or generate_model(rig: true): names its bones by role (hips, spine, chest, neck, head, shoulder/upper_arm/forearm/hand.L/R, " +
				"thigh/shin/foot/toe.L/R) and gives it exactly the clips you list (default: idle, walk, wave; asking again replaces the set, so list every clip the " +
				"character needs). Loops: idle, idle_talk, idle_torch, walk, walk_formal, run, sprint, crouch_idle, crouch_walk, jump_loop, push, swim, swim_idle, sit_idle, " +
				"sit_talk, dance, drive, sword_idle, pistol_idle, spell_idle, wave. One-shots: jump_start, jump_land, roll, attack (a sword swing), punch_enter, punch_jab, " +
				"punch_cross, hit, hit_head, death, pick_up, interact, fix_kneeling, sit_down, stand_up, spell_enter, spell_shoot, spell_exit, pistol_shoot, pistol_reload. " +
				"Held poses: pistol_aim, pistol_aim_up, pistol_aim_down. All but wave are retargeted from a library of hand-made clips, in place (the game moves the " +
				"character). Only works for bipeds (two legs, two arms); other skeletons are reported. In the game, play a clip with an Animator component: " +
				"{\"clip\": \"run\"}, or {\"clip\": \"attack\", \"once\": true}. Check clips with preview_model.",
			parameters: Type.Object({
				model: MODEL_NAME,
				clips: Type.Optional(Type.Array(Type.Union(ANIMATION_CLIPS.map((c) => Type.Literal(c))))),
			}),
			execute: generation("animate_model"),
		}),
		defineTool({
			name: "preview_model",
			label: "Preview model in engine",
			description:
				"Render a model with the game's own engine (front, three-quarter and back) and see the images, plus any engine errors about it. " +
				"Use it after every change: a model can look right in Blender and wrong in the game.",
			parameters: Type.Object({ model: MODEL_NAME }),
			async execute(_id, params, signal, onUpdate) {
				const r = (await ctx.request("preview_model", params, signal, progressTo(onUpdate))) as {
					images: string[];
					errors: string[];
				};
				const images = r.images.flatMap(image);
				const text = `${params.model} in the game's engine: front, three-quarter, back.${r.errors.length ? `\nEngine errors:\n${r.errors.join("\n")}` : " No engine errors."}`;
				return { content: [{ type: "text" as const, text }, ...images], details: {} };
			},
		}),
		defineTool({
			name: "preview_scene",
			label: "Preview scene in engine",
			description:
				"Show a scene or prefab in the game's own engine, paused, and see it: 'top' (from above: +Z is up the image, +X to the left), " +
				"'overview' (three-quarter from the -Z side), 'game' (the scene's own Camera), or your own {position, target} views. Views are framed on the " +
				"file's entities. Also lists problems in the file and the engine's warnings (unknown components or fields, missing prefabs or models). " +
				"Use it before and after every change to a scene, after the edit has finished.",
			parameters: Type.Object({
				scene: Type.String({ description: "Repo-relative path, e.g. 'assets/scenes/clearing.json' or 'assets/prefabs/chest.json'" }),
				views: Type.Optional(
					Type.Array(
						Type.Union([
							Type.Literal("top"),
							Type.Literal("overview"),
							Type.Literal("game"),
							Type.Object({ position: Type.Array(Type.Number()), target: Type.Array(Type.Number()) }),
						]),
						{ description: "Default: top, overview, game" },
					),
				),
			}),
			async execute(_id, params, signal, onUpdate) {
				const r = (await ctx.request("preview_scene", params, signal, progressTo(onUpdate))) as {
					images: { view: string; image: string }[];
					warnings: string[];
				};
				const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
					{
						type: "text",
						text: `${params.scene} in the game's engine, views in order: ${r.images.map((i) => i.view).join(", ")}.${r.warnings.length ? `\nProblems and engine warnings:\n${r.warnings.join("\n")}` : " No problems or engine warnings."}`,
					},
				];
				return { content: [...content, ...r.images.flatMap((i) => image(i.image))], details: {} };
			},
		}),
		defineTool({
			name: "generate_sound_takes",
			label: "Generate sound takes",
			description:
				"Generate takes of a sound effect with a local model (Stable Audio Open Small, about a second for several), each from its own seed, into " +
				"assets/sounds/<name>/takes/<group>-<seed>.wav: the raw material for the sound's variants. You can't listen, so each take comes back with its " +
				"id and measurements (length, peak and loudness, attack, tail, brightness, number of separate hits, clipping), a CLAP score against the prompt " +
				"(off_prompt marks takes far below the rest), and an image of every take, top to bottom: waveform over a log-frequency spectrogram. The first " +
				"takes of a new sound also write its sound.json (one variant: the first good take). Then compose the variants in sound.json from take ids " +
				"(usually one take each) and render_sound. Describe one sound, how it's recorded and how long (see the sound-design skill).",
			parameters: Type.Object({
				name: Type.String({ description: "The sound's folder under assets/sounds/, lower-kebab-case, with '/' for folders: e.g. 'chest-open', 'ui/click'" }),
				prompt: Type.String({ description: "e.g. 'an old wooden chest lid creaking open slowly, rusty hinges, close-up foley, dry'" }),
				seconds: Type.Number({ description: "Length to generate, 0.1-11 (trimming cuts the silence after)" }),
				count: Type.Optional(Type.Number({ description: "How many takes (1-12, default 6)" })),
				group: Type.Optional(Type.String({ description: "Names the takes' files (default 'main'), e.g. 'thud' for a second ingredient" })),
				seed: Type.Optional(Type.Number({ description: "First seed (default random); takes use seed, seed+1, …" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("generate_sound", params, signal, progressTo(onUpdate)), "sheet", "Every take, top to bottom in the order above (waveform over spectrogram, each stretched to the same width):");
			},
		}),
		defineTool({
			name: "generate_voice_takes",
			label: "Generate voice takes",
			description:
				"Have a local model (Qwen3-TTS VoiceDesign, a few seconds a take) perform one line of a character's voice several times, into " +
				"assets/voices/<name>/takes/<line>-<seed>.wav. The voice is the character's description in voice.json plus this line's direction, and every take " +
				"is a fresh performance by a slightly different voice. You can't listen, so each take comes back with its measurements and its match: how close " +
				"its voice measures to the character's other chosen lines (1 = identical; a rough guide for comparing a line's takes, since a character's own " +
				"takes score 0.94-0.99 but another character's can too; drifted marks a take plainly not the character's; a voice's first line has no match). When the line has no take of what it now says, the best-matching take is chosen and rendered to " +
				"<line>.ogg. A new voice needs 'voice'; a new line needs 'text'. If the chosen take is drifted, generate again (other seeds) before changing the " +
				"description. See the voice-lines skill.",
			parameters: Type.Object({
				name: Type.String({ description: "The voice's folder under assets/voices/, lower-kebab-case, with '/' for folders: e.g. 'narrator', 'villagers/merchant'" }),
				line: Type.String({ description: "The line's id, lower-kebab-case: it names the file the game plays, e.g. 'greeting' -> greeting.ogg" }),
				text: Type.Optional(Type.String({ description: "The words spoken (needed for a new line; changes an existing one)" })),
				direction: Type.Optional(Type.String({ description: "How this line is said, e.g. 'Shouting in alarm, urgent, at the top of his voice.'" })),
				voice: Type.Optional(Type.String({ description: "The voice's description (needed for a new voice; changes an existing one, which outdates its lines), e.g. 'An older British man with a deep, warm, slightly gravelly voice; an unhurried storyteller.'" })),
				language: Type.Optional(Type.String({ description: "Default English" })),
				count: Type.Optional(Type.Number({ description: "How many takes (1-8, default 4)" })),
				seed: Type.Optional(Type.Number({ description: "First seed (default random); takes use seed, seed+1, …" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				return ok(JSON.stringify(await ctx.request("generate_voice", params, signal, progressTo(onUpdate)), null, 2));
			},
		}),
		defineTool({
			name: "render_voice",
			label: "Render voice",
			description:
				"Validate assets/voices/<name>/voice.json (see the voice-lines skill) and render each line's chosen take, trimmed and levelled, into <line>.ogg. " +
				"The game plays one with engine.play_sound(\"voices/<name>/<line>.ogg\"). Returns every line with its measurements, its voice match against the " +
				"character's other lines (drifted: plainly not the same voice) and outdated (its take is of an earlier text, direction or voice: generate takes " +
				"again). Run it after editing voice.json by hand, e.g. after choosing another take.",
			parameters: Type.Object({ name: Type.String({ description: "The voice's folder name under assets/voices/" }) }),
			async execute(_id, params, signal, onUpdate) {
				return ok(JSON.stringify(await ctx.request("render_voice", params, signal, progressTo(onUpdate)), null, 2));
			},
		}),
		defineTool({
			name: "render_sound",
			label: "Render sound",
			description:
				"Validate assets/sounds/<name>/sound.json (see the sound-design skill) and render each variant: its layers (each levelled first) mixed, then " +
				"trimmed, cut, pitched, filtered, reverbed, levelled and faded (or crossfaded into a seamless loop) into <name>.ogg, <name>-2.ogg…. The game plays them with " +
				"engine.play_sound(\"sounds/<name>/<name>.ogg\"). On a problem it lists every one with where it is. On success it measures each variant and " +
				"shows them (waveform over spectrogram): check them against what you meant, since you can't listen. Render after every edit.",
			parameters: Type.Object({ name: Type.String({ description: "The sound's folder name under assets/sounds/" }) }),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("render_sound", params, signal, progressTo(onUpdate)), "sheet", "Each variant, top to bottom (waveform over spectrogram):");
			},
		}),
		defineTool({
			name: "render_song",
			label: "Render song",
			description:
				"Validate assets/music/<name>/song.json (the studio's score format: see the music-composition skill) and render it to assets/music/<name>/<name>.ogg, " +
				"the file the game plays with engine.play_music. Loops render seamlessly unless the song sets loop: false. Takes about a second. " +
				"On a problem it lists every one with where it is (e.g. 'sections.A.tracks.bass: bar 3 has 4.5 beats, but a bar is 4'). " +
				"On success it describes what was rendered (sections, tracks, note counts and ranges): check that against what you meant, since you can't listen. Render after every edit.",
			parameters: Type.Object({ name: Type.String({ description: "The piece's folder under assets/music/, lower-kebab-case, with '/' for folders: e.g. 'goblin-theme', 'themes/goblin'" }) }),
			execute: generation("render_song"),
		}),
		defineTool({
			name: "finalize_model",
			label: "Finalize 3D model",
			description:
				"Re-run the engine-ready export for a model, e.g. after you edited it in Blender: pass `from` (a repo-relative .glb you exported, ideally in the model's source/ folder). " +
				"Welds, scales to `height` (default: the model's current height), enforces the vertex limit, exports <model>.glb and renders the thumbnail.",
			parameters: Type.Object({
				model: MODEL_NAME,
				from: Type.Optional(Type.String()),
				height: Type.Optional(Type.Number()),
			}),
			execute: generation("finalize_model"),
		}),
		defineTool({
			name: "generate_texture",
			label: "Generate texture candidates",
			description:
				"Generate seamless candidates for a tileable surface texture (ground, path, wall, floor, wood, fabric…) in assets/textures/<name>/candidates/: " +
				"two per seed, made seamless two ways (\"roll\" during generation, \"quilt\" by cutting afterwards; either can win, see the texture-art skill). " +
				"The prompt is the surface itself, e.g. 'mossy cobblestone path, rounded grey stones'; the studio adds top-down, flat-lit and seamless. " +
				"Returns each candidate's source path and a sheet showing each tiled 2x2: look for visible seams, repeating blotches and lighting before choosing.",
			parameters: Type.Object({
				name: Type.String({ description: "The texture's folder under assets/textures/, lower-kebab-case, '/' for folders: e.g. 'grass', 'ground/cobblestone'" }),
				prompt: Type.String(),
				count: Type.Optional(Type.Number({ description: "Seeds (1-4, default 2), each giving two candidates" })),
				seed: Type.Optional(Type.Number()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("generate_texture", params, signal, progressTo(onUpdate)), "sheet", "Each candidate tiled 2x2, in the order above:");
			},
		}),
		defineTool({
			name: "make_texture",
			label: "Make texture",
			description:
				"Make (or remake) a texture from a chosen candidate: writes <name>.png, <name>_normal.png and <name>_roughness.png, which a Mesh_Renderer's material " +
				"uses as texture, normal_map and roughness_map. Also sets texture.json's tile (metres per repeat, how scenes size its tiling), normal_strength " +
				"(relief, 0-20, default 4) and roughness ([min, max], default [0.55, 0.95]). Returns a preview: the colour tiled 2x2, the normal and roughness maps.",
			parameters: Type.Object({
				name: Type.String(),
				source: Type.Optional(Type.String({ description: "The chosen candidate, e.g. 'candidates/grass-1001-quilt.png' (default: the current one)" })),
				tile: Type.Optional(Type.Number({ description: "Metres per repeat in the world, e.g. 2 for grass, 1 for planks, 3 for a stone wall" })),
				normal_strength: Type.Optional(Type.Number()),
				roughness: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { minItems: 2, maxItems: 2, description: "[min, max], e.g. [0.55, 0.95]" })),
				notes: Type.Optional(Type.String({ description: "What it's for" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("make_texture", params, signal, progressTo(onUpdate)), "preview", "The colour tiled 2x2, the normal map, the roughness map:");
			},
		}),
		defineTool({
			name: "generate_ui_art",
			label: "Generate UI art candidates",
			description:
				"Generate candidates for a piece of game UI art in assets/ui/art/<name>/candidates/: a 'frame' (a panel's stretchable border), a 'button' or an " +
				"'icon'. The prompt is the subject and its look, e.g. 'a carved dark wooden border with small gold rivets, a plain parchment inside' or 'a gold " +
				"coin with a goblin face'; pass the game's art direction as style. The studio adds the kind's framing and a plain background, then cuts each out " +
				"and (frames, buttons) mirrors it exactly symmetric and finds its slice insets (the corners that don't stretch). Returns each candidate's source, " +
				"seed and slice, and a sheet showing each the way screens use it (frames and buttons stretched to several shapes, icons at 48 and 96 px): look for " +
				"stretched ornaments, squashed round ends, ragged cut-out edges, and icons that don't read small.",
			parameters: Type.Object({
				name: Type.String({ description: "The art's folder under assets/ui/art/, lower-kebab-case, '/' for folders: e.g. 'panel', 'buttons/wood', 'icons/coin'" }),
				kind: Type.Union([Type.Literal("frame"), Type.Literal("button"), Type.Literal("icon")]),
				prompt: Type.String(),
				style: Type.Optional(Type.String({ description: "The game's art direction, e.g. 'whimsical hand-painted fantasy, warm colours'" })),
				count: Type.Optional(Type.Number({ description: "Candidates (1-4, default 3)" })),
				seed: Type.Optional(Type.Number()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("generate_ui_art", params, signal, progressTo(onUpdate)), "sheet", "Each candidate as screens will use it, in the order above:");
			},
		}),
		defineTool({
			name: "make_ui_art",
			label: "Make UI art",
			description:
				"Make (or remake) a piece of UI art from a chosen candidate: writes <leaf>.png beside <leaf>.json, whose slice the engine uses to stretch frames and " +
				"buttons. Returns the path screens use (frame or image, e.g. 'ui/art/panel/panel.png'), the slice and a preview. Pass slice to correct the " +
				"detected insets ([left, top, right, bottom] in pixels: everything that mustn't stretch, such as corner ornaments and round ends, must be inside).",
			parameters: Type.Object({
				name: Type.String(),
				source: Type.Optional(Type.String({ description: "The chosen candidate, e.g. 'candidates/panel-1001.png' (default: the current one)" })),
				slice: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { minItems: 4, maxItems: 4 })),
				notes: Type.Optional(Type.String()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("make_ui_art", params, signal, progressTo(onUpdate)), "preview", "As screens will use it:");
			},
		}),
		defineTool({
			name: "preview_ui",
			label: "Preview a UI screen in engine",
			description:
				"Show a UI screen (assets/ui/<screen>.json) in the game's own engine, over its scene and paused, with sample values for its bindings, and see it. " +
				"Returns a screenshot, every element as laid out (id, type, rect [x, y, w, h] in UI units on a 720-tall screen, text with the values filled in), " +
				"the bindings it reads, the actions it reports, bindings you gave no value, and problems in the file. Use it after every change to a screen, with " +
				"realistic values (e.g. {\"gold\": 250, \"chests_left\": 3}), and look at the image: overlaps, text spilling out of frames, unreadable colours.",
			parameters: Type.Object({
				screen: Type.String({ description: "The screen's name: 'pause' for assets/ui/pause.json" }),
				values: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("preview_ui", params, signal, progressTo(onUpdate)), "image", "The screen in the engine:");
			},
		}),
		defineTool({
			name: "build_release",
			label: "Build a release",
			description:
				"Build the game for players as the Release section does: an optimised release build for 'linux' (default; runs on glibc 2.29+), " +
				"'windows' (cross-compiled) or 'web' (WebAssembly and WebGL 2: a folder with index.html, zipped for itch.io), packaged with only the asset files the game uses into builds/<version>/<target>/ (never committed), then " +
				"checked: the package started from another folder (release build, release.json's version, no warnings in its log), every tests/*.jsonl " +
				"run against the packaged binary, and for Linux an AppImage that starts. Windows checks run under Wine, web checks in a hidden browser window. A web build has no multiplayer, gamepads or saved files yet. Takes a minute or two. Returns " +
				"each check with its detail, the archives, and how many files ship. Use it to confirm a change survives packaging (a file loaded by a " +
				"computed path needs release.json's include). Publishing to itch.io is the user's, from the Release section. The settings are release.json at " +
				"the project root: {\"name\": \"Game Name\", \"version\": \"1.0.0\", \"icon\": \"ui/art/icons/app/app.png\" (a PNG under assets/: the window and .exe " +
				"icon), \"targets\": [\"linux\", \"windows\"] (add \"web\" for a browser build), \"include\"/\"exclude\": [asset globs like \"sounds/extra/*\"], \"itch\": {\"target\": \"user/game\"}}; " +
				"without it the name is the project's and the version 0.1.0.",
			parameters: Type.Object({
				target: Type.Optional(Type.Union([Type.Literal("linux"), Type.Literal("windows"), Type.Literal("web")])),
			}),
			async execute(_id, params, signal, onUpdate) {
				return ok(JSON.stringify(await ctx.request("build_release", params, signal, progressTo(onUpdate)), null, 2));
			},
		}),
		defineTool({
			name: "check_shader",
			label: "Check a material shader",
			description:
				"Compile a material shader (assets/shaders/<name>.glsl) in the game's own engine without using it. Returns ok, compile errors with the line in " +
				"your file, the @params as the studio reads them (name, kind, default, range, line) and which hooks it defines (vertex, surface, depth_fade, " +
				"bounds). Run it after every edit to a shader file; fix errors before previewing.",
			parameters: Type.Object({ shader: Type.String({ description: "The shader's name: 'water' for assets/shaders/water.glsl, 'nature/wind' for a folder" }) }),
			async execute(_id, params, signal, onUpdate) {
				return ok(JSON.stringify(await ctx.request("check_shader", params, signal, progressTo(onUpdate)), null, 2));
			},
		}),
		defineTool({
			name: "preview_shader",
			label: "Preview a material shader",
			description:
				"See a material shader in the game's own engine at several moments (its time pinned), so motion shows as a sequence of frames: on a mesh under " +
				"a sun beside a stone (default: a 3 m grid if it moves vertices, else a sphere), or with scene: in one of the game's scenes as that scene uses it " +
				"(its own camera, or view). Pass params to try values before writing them into a material, and post to try post-processing. Returns the frames " +
				"(640x360, in time order), compile errors (line in your file), problems with the params, and engine warnings. Compare frames to judge motion: " +
				"too fast, too uniform, popping.",
			parameters: Type.Object({
				shader: Type.String({ description: "The shader's name: 'water' for assets/shaders/water.glsl" }),
				params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Values for its @params, e.g. {\"wave_height\": 0.05, \"deep\": \"#1d4a5a\"}" })),
				mesh: Type.Optional(Type.String({ description: "A built-in mesh (sphere, cube, cylinder, cone, plane, grid) or a model path ('models/fern/fern.glb')" })),
				transparent: Type.Optional(Type.Boolean({ description: "Alpha-blend the material (needed for depth_fade; on automatically when the shader uses it)" })),
				times: Type.Optional(Type.Array(Type.Number(), { description: "Shader times in seconds (default [0, 0.5, 1, 1.5]; at most 8)" })),
				scene: Type.Optional(Type.String({ description: "Show it in this scene as the scene uses it, e.g. 'assets/scenes/clearing.json'" })),
				view: Type.Optional(Type.Object({ position: Type.Array(Type.Number()), target: Type.Array(Type.Number()) })),
				post: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Post-processing to try, as the environment's post block: {\"bloom\": 0.6, \"vignette\": 0.3}" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				const { frames, ...rest } = (await ctx.request("preview_shader", params, signal, progressTo(onUpdate))) as { frames: { time: number; image: string }[] };
				const text = `${JSON.stringify(rest, null, 2)}\nFrames at t = ${frames.map((f) => f.time).join(", ")} s, in order:`;
				return { content: [{ type: "text" as const, text }, ...frames.flatMap((f) => image(f.image))], details: {} };
			},
		}),
		defineTool({
			name: "preview_effect",
			label: "Preview an effect",
			description:
				"See an effect file (assets/effects/<name>.json) in the game's own engine at chosen moments: each frame plays it afresh and simulates it ahead " +
				"to that time with a fixed seed, so a burst unfolds as a sequence (default 0.1, 0.3, 0.6, 1, 1.6 s; give your own times: close together to " +
				"judge speed, spread out to see it build and fade). On a dark ground (default; glows read best) or a light one, with a little bloom, or in " +
				"one of the game's scenes at a position. The camera frames the particles unless you give a view. Returns the frames (640x360) with their " +
				"particle counts, the effect's bounds in metres, and problems in the file (each saying where it is).",
			parameters: Type.Object({
				effect: Type.String({ description: "The effect's name: 'sparks' for assets/effects/sparks.json" }),
				times: Type.Optional(Type.Array(Type.Number(), { description: "Seconds into the effect, at most 8" })),
				background: Type.Optional(Type.Union([Type.Literal("dark"), Type.Literal("light")])),
				scene: Type.Optional(Type.String({ description: "Play it in this scene instead, e.g. 'assets/scenes/clearing.json'" })),
				position: Type.Optional(Type.Array(Type.Number(), { description: "Where to play it [x, y, z] (default the origin)" })),
				view: Type.Optional(Type.Object({ position: Type.Array(Type.Number()), target: Type.Array(Type.Number()) })),
				post: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Post-processing for the plain ground (default {\"bloom\": 0.6})" })),
				seed: Type.Optional(Type.Number()),
			}),
			async execute(_id, params, signal, onUpdate) {
				const { frames, ...rest } = (await ctx.request("preview_effect", params, signal, progressTo(onUpdate))) as { frames: { time: number; particles: number; image: string }[] };
				const text = `${JSON.stringify(rest, null, 2)}\nFrames, in order: ${frames.map((f) => `t = ${f.time} s (${f.particles} particles)`).join("; ")}`;
				return { content: [{ type: "text" as const, text }, ...frames.flatMap((f) => image(f.image))], details: {} };
			},
		}),
		defineTool({
			name: "generate_particle_texture",
			label: "Generate particle texture candidates",
			description:
				"Generate candidates for a particle sprite with a local image model (about 4 s each), cut out ready for effects, into " +
				"assets/effects/textures/<name>/candidates/. mode 'glow' for light (sparks, embers, flames, magic: generated on black, so the brightness " +
				"becomes the shape) or 'solid' for things (leaves, coins, petals, debris: on white, keyed out). Prompt one element and the game's style. " +
				"Returns a sheet of the candidates over dark and light: pick one with make_particle_texture. For soft basics (dots, smoke and dust puffs, " +
				"sparks, rings) and any flipbook, skip this: make_particle_texture makes them procedurally.",
			parameters: Type.Object({
				name: Type.String({ description: "Under assets/effects/textures/, lower-kebab-case: e.g. 'spark', 'leaves/maple'" }),
				mode: Type.Union([Type.Literal("glow"), Type.Literal("solid")]),
				prompt: Type.String({ description: "One element: 'a bright four-pointed star sparkle', 'a single small autumn leaf'" }),
				style: Type.Optional(Type.String({ description: "The game's art style, e.g. 'stylised hand-painted'" })),
				count: Type.Optional(Type.Number({ description: "Candidates (1-4, default 3)" })),
				seed: Type.Optional(Type.Number()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("generate_particle_texture", params, signal, progressTo(onUpdate)), "sheet", "The candidates over dark and light, in the order above:");
			},
		}),
		defineTool({
			name: "make_particle_texture",
			label: "Make a particle texture",
			description:
				"Make a particle texture: from a generated candidate (source), or procedurally from a recipe (no GPU, instant, white so the effect colours it): " +
				"shape dot, soft, smoke, dust, spark, star, ember, streak or ring; smoke, dust and ring can be a flipbook [columns, rows] (smoke and dust grow " +
				"and thin, a ring spreads: ripples, shockwaves). Returns the path effects use as texture (e.g. 'effects/textures/smoke/smoke.png'), its " +
				"flipbook (set the same flipbook in the effect) and a preview.",
			parameters: Type.Object({
				name: Type.String(),
				source: Type.Optional(Type.String({ description: "A generated candidate, e.g. 'candidates/spark-1002.png'" })),
				recipe: Type.Optional(
					Type.Object({
						shape: Type.String({ description: "dot, soft, smoke, dust, spark, star, ember, streak, ring" }),
						flipbook: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 8 }), { minItems: 2, maxItems: 2 })),
						seed: Type.Optional(Type.Number()),
					}),
				),
				notes: Type.Optional(Type.String()),
			}),
			async execute(_id, params, signal, onUpdate) {
				return pictured(await ctx.request("make_particle_texture", params, signal, progressTo(onUpdate)), "preview", "As effects will use it, over dark and light:");
			},
		}),
		defineTool({
			name: "move_asset",
			label: "Move asset",
			description:
				"Move or rename a studio asset, or a folder of them, in your worktree, and rewrite every reference to it: paths in scenes, prefabs, manifests, game " +
				"code and tests, and links between design docs. A renamed model, sound or piece renames its own files too (barrel.glb → cask.glb). Use it " +
				"instead of mv/git mv for anything under assets/, docs/design/, game/ or tests/. Paths are repo-relative: an asset by its file (a model, " +
				"sound or piece by its model.json, sound.json or song.json), a folder by its path. Returns the files it updated; build and run the tests if " +
				"game code changed.",
			parameters: Type.Object({
				from: Type.String({ description: "e.g. 'assets/models/barrel/model.json', 'assets/prefabs/rock.json', 'assets/models/props'" }),
				to: Type.String({ description: "e.g. 'assets/models/props/barrel/model.json', 'assets/prefabs/scenery/rock.json', 'assets/models/scenery'" }),
			}),
			async execute(_id, params, signal) {
				return ok(JSON.stringify(await ctx.request("move_asset", params, signal, () => {}), null, 2));
			},
		}),
		defineTool({
			name: "set_session_title",
			label: "Set session title",
			description: "Set a short title (under 60 characters) describing this session's task, shown in Game Studio's session list. Call it once you understand the task.",
			parameters: Type.Object({ title: Type.String() }),
			async execute(_id, { title }) {
				tool("set_session_title", { title: title.slice(0, 80) });
				return ok("Title set.");
			},
		}),
		defineTool({
			name: "request_review",
			label: "Request review",
			description: "Tell the user your work is committed on this session's branch and ready for them to review and merge. Include a short summary of what changed.",
			parameters: Type.Object({ summary: Type.String() }),
			async execute(_id, { summary }) {
				tool("request_review", { summary });
				return ok("The user has been asked to review the branch.");
			},
		}),
		defineTool({
			name: "open_in_studio",
			label: "Open in studio",
			description: "Show a file (an asset or design doc, as a path relative to the repo root) to the user in Game Studio.",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_id, { path }) {
				tool("open_in_studio", { path });
				return ok(`Opened ${path}.`);
			},
		}),
		defineTool({
			name: "ask_user",
			label: "Ask user",
			description: "Ask the user a question and wait for the answer. Offer options when the answer is a choice; the user can still answer freely.",
			parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
			async execute(_id, { question, options }, signal) {
				const questionId = `${ctx.sessionId}-q${++questions}`;
				ctx.post({ type: "ask_user", id: ctx.sessionId, questionId, question, options });
				return ok(`User answered: ${await ctx.ask(questionId, signal)}`);
			},
		}),
	];
	// Every session talks to the studio; the rest (generation, renders, previews) only where its type allows.
	const always = new Set(["set_session_title", "request_review", "open_in_studio", "ask_user", "delegate"]);
	const allowed = ctx.studioTools ? tools.filter((t) => always.has(t.name) || ctx.studioTools!.includes(t.name)) : tools;
	// Studio tools read what the agent's other tools write (render_sound reads sound.json): a turn that writes a file
	// and renders it must not run the two at once, so any of these makes Pi run that turn's calls one by one.
	// Delegations may run side by side.
	return allowed.map((t) => (t.name === "delegate" ? t : { ...t, executionMode: "sequential" as const }));
}
