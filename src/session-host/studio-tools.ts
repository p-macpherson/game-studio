// Tools every session gets, through which the agent talks back to Game Studio.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

const MODEL_NAME = Type.String({ description: "The model's folder name under assets/models/, lower-kebab-case, e.g. 'treasure-chest'" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

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
			onUpdate?: (partial: { content: { type: "text"; text: string }[]; details: Record<string, never> }) => void,
		) => {
			const result = await ctx.request(method, params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
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
						const report = await ctx.request("delegate", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
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
				const { sheet, ...r } = (await ctx.request("generate_concepts", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }))) as {
					sheet?: string;
				};
				const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(sheet ?? "") ?? [];
				const text = `${JSON.stringify(r, null, 2)}${data ? "\nAll of them, numbered in the order above:" : ""}`;
				return { content: [{ type: "text" as const, text }, ...(data ? [{ type: "image" as const, mimeType, data }] : [])], details: {} };
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
				"thigh/shin/foot/toe.L/R) and adds looping clips: idle, walk, wave (all by default). Only works for bipeds (two legs, two arms); other skeletons are reported. " +
				"In the game, play a clip with an Animator component: {\"clip\": \"walk\"}.",
			parameters: Type.Object({
				model: MODEL_NAME,
				clips: Type.Optional(Type.Array(Type.Union([Type.Literal("idle"), Type.Literal("walk"), Type.Literal("wave")]))),
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
				const r = (await ctx.request("preview_model", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }))) as {
					images: string[];
					errors: string[];
				};
				const images = r.images.map((url) => {
					const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(url) ?? [];
					return { type: "image" as const, mimeType, data };
				});
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
				const r = (await ctx.request("preview_scene", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }))) as {
					images: { view: string; image: string }[];
					warnings: string[];
				};
				const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
					{
						type: "text",
						text: `${params.scene} in the game's engine, views in order: ${r.images.map((i) => i.view).join(", ")}.${r.warnings.length ? `\nProblems and engine warnings:\n${r.warnings.join("\n")}` : " No problems or engine warnings."}`,
					},
				];
				for (const { image } of r.images) {
					const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(image) ?? [];
					content.push({ type: "image", mimeType, data });
				}
				return { content, details: {} };
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
				name: Type.String({ description: "The sound's folder name under assets/sounds/, lower-kebab-case, e.g. 'chest-open'" }),
				prompt: Type.String({ description: "e.g. 'an old wooden chest lid creaking open slowly, rusty hinges, close-up foley, dry'" }),
				seconds: Type.Number({ description: "Length to generate, 0.1-11 (trimming cuts the silence after)" }),
				count: Type.Optional(Type.Number({ description: "How many takes (1-12, default 6)" })),
				group: Type.Optional(Type.String({ description: "Names the takes' files (default 'main'), e.g. 'thud' for a second ingredient" })),
				seed: Type.Optional(Type.Number({ description: "First seed (default random); takes use seed, seed+1, …" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				const { sheet, ...r } = (await ctx.request("generate_sound", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }))) as {
					sheet?: string;
				};
				const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(sheet ?? "") ?? [];
				const text = `${JSON.stringify(r, null, 2)}${data ? "\nEvery take, top to bottom in the order above (waveform over spectrogram, each stretched to the same width):" : ""}`;
				return { content: [{ type: "text" as const, text }, ...(data ? [{ type: "image" as const, mimeType, data }] : [])], details: {} };
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
				const { sheet, ...r } = (await ctx.request("render_sound", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }))) as {
					sheet?: string;
				};
				const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(sheet ?? "") ?? [];
				const text = `${JSON.stringify(r, null, 2)}${data ? "\nEach variant, top to bottom (waveform over spectrogram):" : ""}`;
				return { content: [{ type: "text" as const, text }, ...(data ? [{ type: "image" as const, mimeType, data }] : [])], details: {} };
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
			parameters: Type.Object({ name: Type.String({ description: "The piece's folder name under assets/music/, lower-kebab-case, e.g. 'goblin-theme'" }) }),
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
	return ctx.studioTools ? tools.filter((t) => always.has(t.name) || ctx.studioTools!.includes(t.name)) : tools;
}
