// Shaders (M11): material shaders (assets/shaders/<name>.glsl, src/shared/shader.ts), checked and previewed in the
// game's own engine (RunService.checkShader / previewShader), and written by the Shaders section's editor. Agents write
// shader files directly; post-processing is the scene environment's `post`, edited with edit_scene. See the vault
// note "M11 Shaders".
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ASSET_NAME } from "../shared/asset-names";
import { SHADER_DIR } from "../shared/shader";
import { safeJoin } from "./assets";
import type { ShaderPreview } from "./runner";
import { handler, type StudioRequestHandlers } from "./studio-requests";

export interface ShaderEngine {
	check(sessionId: string, name: string): Promise<unknown>;
	preview(sessionId: string, p: ShaderPreview): Promise<unknown>;
}

/** A shader's file in a checkout. */
export function shaderFile(cwd: string, name: string): string {
	if (!ASSET_NAME.test(name)) throw new Error(`Shader names are lower-kebab-case, with "/" for folders (e.g. "water", "nature/wind"), not "${name}"`);
	return safeJoin(cwd, `${SHADER_DIR}/${name}.glsl`);
}

/** Writes a shader's source (the section's editor). `create`: it must not exist yet. */
export function writeShader(cwd: string, p: { shader: string; source: string; create?: boolean }): { path: string } {
	const file = shaderFile(cwd, p.shader);
	if (p.create && existsSync(file)) throw new Error(`${SHADER_DIR}/${p.shader}.glsl already exists`);
	if (!p.create && !existsSync(file)) throw new Error(`No ${SHADER_DIR}/${p.shader}.glsl`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, p.source.endsWith("\n") ? p.source : `${p.source}\n`);
	return { path: `${SHADER_DIR}/${p.shader}.glsl` };
}

/** The Shaders section's step and the agents' shader tools (see studio-requests.ts); only writing is an undo step. */
export function shaderRequests(engine?: ShaderEngine): StudioRequestHandlers {
	const need = () => {
		if (!engine) throw new Error("Shader checks need the game's engine, which isn't available here");
		return engine;
	};
	return {
		write_shader: handler(
			(ctx, p: { shader: string; source: string; create?: boolean }) => writeShader(ctx.cwd, p),
			(p) => ({ label: `Shader ${p.shader}: ${p.create ? "created" : "edited"}`, scopes: [{ path: `${SHADER_DIR}/${p.shader}.glsl` }] }),
		),
		check_shader: handler((ctx, p: { shader: string }) => need().check(ctx.sessionId, p.shader)),
		preview_shader: handler((ctx, p: ShaderPreview) => need().preview(ctx.sessionId, p)),
	};
}
