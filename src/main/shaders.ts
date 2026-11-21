// Shaders (M11): material shaders (assets/shaders/<name>.glsl, src/shared/shader.ts), checked and previewed in the
// game's own engine (RunService.checkShader / previewShader). Agents write shader files directly; post-processing is
// the scene environment's `post`, edited with edit_scene. See the vault note "M11 Shaders".
import type { ShaderPreview } from "./runner";
import { handler, type StudioRequestHandlers } from "./studio-requests";

export interface ShaderEngine {
	check(sessionId: string, name: string): Promise<unknown>;
	preview(sessionId: string, p: ShaderPreview): Promise<unknown>;
}

/** The agents' shader tools (see studio-requests.ts). Neither changes files, so neither is an undo step. */
export function shaderRequests(engine?: ShaderEngine): StudioRequestHandlers {
	const need = () => {
		if (!engine) throw new Error("Shader checks need the game's engine, which isn't available here");
		return engine;
	};
	return {
		check_shader: handler((ctx, p: { shader: string }) => need().check(ctx.sessionId, p.shader)),
		preview_shader: handler((ctx, p: ShaderPreview) => need().preview(ctx.sessionId, p)),
	};
}
