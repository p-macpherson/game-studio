---
name: shader-authoring
description: Game Studio's material shaders (assets/shaders/<name>.glsl, GLSL snippets the engine plugs into its lit shader) and scene post-processing (environment.post): the snippet API (vertex, surface, helpers, @params, @bounds), putting a shader on a material, effects and their ranges, performance limits, and checking with check_shader and preview_shader, judging motion from frames. Use whenever writing or changing a shader, or a scene's post-processing.
---
# Material shaders

A shader is `assets/shaders/<name>.glsl`: a GLSL 330 snippet the engine wraps with its own lighting, shadows, fog,
instancing and skinning. You write one or both hooks; everything else is the engine's. Reference: "Material shaders"
and "Post-processing" in `engine/docs/making-a-game.md`.

```glsl
// Water: rolling waves, deep colour looking down, sky colour at grazing angles, foam where it meets things.
// @param float wave_height = 0.06 [0, 0.3]
// @param float wave_speed = 1.2 [0, 5]
// @param color deep = #1d4a5a
// @param color shallow = #6fb3b8
// @bounds 0.3

float wave(vec2 p) { return sin(p.x * 1.7 + u_time * wave_speed) * 0.6 + (noise(p * 1.5 + u_time * 0.3) - 0.5) * 0.6; }

void vertex(inout Vertex v) {
    float e = 0.05;
    v.position.y += wave(v.position.xz) * wave_height;
    float dx = (wave(v.position.xz + vec2(e, 0.0)) - wave(v.position.xz - vec2(e, 0.0))) / (2.0 * e) * wave_height;
    float dz = (wave(v.position.xz + vec2(0.0, e)) - wave(v.position.xz - vec2(0.0, e))) / (2.0 * e) * wave_height;
    v.normal = normalize(vec3(-dx, 1.0, -dz));
}

void surface(inout Surface s) {
    float shore = depth_fade(s, 0.4);
    s.albedo = mix(mix(deep, shallow, fresnel(s, 4.0)), vec3(0.85, 0.92, 0.9), (1.0 - shore) * 0.6);
    s.roughness = 0.06;
    s.alpha = mix(0.5, 1.0, fresnel(s, 4.0)) * shore + (1.0 - shore) * 0.5;
}
```

| | |
|---|---|
| `void vertex(inout Vertex v)` | Before projection, in **world space**: `position`, `normal` (recompute it when you bend a surface, or lighting stays flat), `uv`, `color`; `local` is the vertex in the mesh's own space (read-only; built-in meshes span -0.5..0.5, so `v.local.y + 0.5` is 0 at the bottom, 1 at the top). Runs in the shadow pass too: moved vertices cast matching shadows |
| `void surface(inout Surface s)` | Per pixel, before lighting: `albedo` (linear), `alpha`, `normal`, `metallic`, `roughness`, `emission` (linear; above 1 glows and blooms), `ao`; read `position` (world), `view` (towards the camera), `uv`. Starts from the material's own values (its colour, texture, maps) |
| `u_time` | Seconds. Follows the simulation: it stops while the game is paused |
| `noise(vec2)`, `fbm(vec2)` | Smooth value noise, 0..1 (`fbm`: four octaves) |
| `fresnel(s, power)` | 0 facing the camera, 1 at grazing angles |
| `depth_fade(s, metres)` | 0 where the surface meets what's behind it, 1 at that distance or more: soft shores, foam rings, fog that doesn't cut. **Transparent materials only** |
| `// @param <kind> <name> = <default> [min, max]` | A uniform the studio builds a control for. Kinds `float`, `vec2`, `vec3`, `vec4`, `color` (`#rrggbb`, sRGB; the shader gets linear), `texture` (an asset path; `sampler2D`). Up to 8, at most 4 textures. Names are GLSL identifiers, not starting `u_` or `gl_` |
| `// @bounds <metres>` | How far `vertex()` can move a vertex: widens culling so a swaying tree doesn't vanish at the screen's edge |

Fragment-only GLSL (`gl_FragCoord`, `dFdx`) works inside `surface()` only.

## Using it in a scene
A material names the shader and sets its params; anything unset uses the defaults:
```json
{"id": 30, "Name": "Pond", "Transform": {"position": [0, 0.12, 4], "scale": [6, 1, 4]},
 "Mesh_Renderer": {"mesh": "grid", "no_shadow": true, "material": {"shader": "shaders/water.glsl", "transparent": true, "params": {"wave_height": 0.04, "deep": "#173f4f"}}}}
```
- Shapes that bend need vertices: `"mesh": "grid"` is a plane split 64×64 (a `plane` has four corners). Generated
  models have plenty.
- One wind shader on many plants: they all share it, and copies of a model with the same material draw instanced
  (one draw call), so a hundred tufts cost little. Give neighbours different `params` only when they must differ:
  differing params split the batch.
- Water and glass: `"transparent": true`, and usually `"no_shadow": true`.
- `preview_scene` lists a material's problems: a missing shader, params it doesn't declare, `depth_fade` on an opaque
  material.

## Post-processing
Per scene, in `environment.post`; every field at zero is off. Bloom is the only one that reads light above 1.
| Field | Range | |
|---|---|---|
| `bloom`, `bloom_threshold` | 0..2 (~0.4-0.8), threshold 1 | Glow around bright light: emissive > 1, glints. Raise the threshold if the whole sky blooms |
| `outline`, `outline_width`, `outline_color`, `outline_threshold` | 0..1, px, sRGB, 0.05 | Toon lines where depth jumps (silhouettes only) |
| `contrast`, `saturation` | -1..1 | Keep within ±0.2 for a natural look |
| `temperature`, `tint` | -1..1 | Warm (+) / cool (-); magenta (+) / green (-). ~0.1-0.2 is already clearly warm |
| `lift`, `gamma`, `gain` | per channel [r, g, b], ~±0.1 | Shadows, midtones, highlights |
| `vignette`, `chromatic_aberration` | 0..1 | ~0.3 and ~0.2 are subtle |

Grade gently and check the game's own camera: a grade that looks good on one object can turn the whole scene muddy.

## Performance
- Every `surface()` runs for every pixel the material covers: on a ground or a pond, keep it to a few noise calls and
  no loops longer than about 8. `vertex()` runs per vertex (cheap unless the mesh is huge).
- Texture params cost a sample each; four is the limit.
- Each shader compiles the first time it's drawn (about 25 ms per kind of draw). Prefer one shader with params over
  near-copies.

## Checking
1. **`check_shader`** after every edit: compile errors with the line in your file, and the params as the studio
   reads them. Fix errors before anything else.
2. **`preview_shader`**: the material on a mesh (`mesh`: a built-in or a model path) beside a stone, at the
   `times` you choose, or in a scene (`scene`), as frames. Try values with `params` and post-processing with `post`
   before writing them anywhere.
3. **Judge motion from the frames.** Compare consecutive frames: something should change, but not everything at once
   (a whole field swaying in step looks mechanical: vary the phase by position). Wind on a 1 m plant moves its top a
   few centimetres to a decimetre; water ripples are centimetres. Too much change between frames 0.5 s apart reads as
   frantic. Take frames close together (0, 0.1, 0.2) to see speed, far apart (0, 2, 4) to see variety.
4. **In the game**: `preview_scene` with the `game` view, where the player will see it, with the scene's post on.
