// Tools every session gets, through which the agent talks back to Game Studio.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostEvent, StudioRequestMethod } from "../shared/host";

export interface StudioToolContext {
	sessionId: string;
	post(event: HostEvent): void;
	/** Waits for the user's answer to an `ask_user` question. */
	ask(questionId: string, signal: AbortSignal | undefined): Promise<string>;
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

	return [
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
			execute: generation("generate_concepts"),
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
}
