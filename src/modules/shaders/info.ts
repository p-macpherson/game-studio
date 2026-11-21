import type { ModuleInfo } from "../../shared/modules";
import { parseShader, SHADER_DIR } from "../../shared/shader";

/**
 * Material shaders (M11): GLSL snippets in `assets/shaders/<name>.glsl` that plug into the engine's lit shader (water,
 * wind, glow). Post-processing lives on each scene's environment (the Scenes section). See the vault note "M11 Shaders".
 */
export const shaders: ModuleInfo = {
	id: "shaders",
	name: "Shaders",
	icon: "✨",
	roots: [SHADER_DIR],
	extensions: [".glsl"],
	agentType: "shader-author",
	noun: "shader",
};

/** A shader's name from its path: `assets/shaders/nature/wind.glsl` is "nature/wind". */
export const shaderNameOf = (path: string) => path.slice(SHADER_DIR.length + 1).replace(/\.glsl$/, "");

export function summarizeShader(text: string, path: string): { title: string; excerpt: string } {
	const info = parseShader(text);
	const about = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith("//") && !l.startsWith("// @"))
		?.replace(/^\/\/\s*/, "");
	const hooks = [info.hasVertex ? "moves vertices" : "", info.hasSurface ? "surface" : "", info.usesDepth ? "soft edges" : ""].filter(Boolean).join(", ");
	const facts = [hooks, info.params.length ? `${info.params.length} param${info.params.length > 1 ? "s" : ""}` : "", info.problems.length ? `${info.problems.length} header problem${info.problems.length > 1 ? "s" : ""}` : ""];
	return { title: shaderNameOf(path), excerpt: [about, facts.filter(Boolean).join(" · ")].filter(Boolean).join(" · ") };
}
