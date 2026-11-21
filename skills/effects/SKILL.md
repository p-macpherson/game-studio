---
name: effects
description: Game Studio's visual effects (assets/effects/<name>.json, emitters of particles the engine plays) and particle textures (assets/effects/textures/): the effect format, emitter shapes, curves and HDR colour, GPU fields, textures procedural and generated, placing and playing effects, budgets, and checking with preview_effect frame by frame. Use whenever making or changing an effect.
---
# Effects

An effect is `assets/effects/<name>.json`: one or more **emitters** of particles. The engine draws them in the HDR
pass, so colour with an intensity above 1 glows and blooms. Reference: "Effects" in `engine/docs/making-a-game.md`.

```json
{
	"notes": "Gold bursting out of an opened chest",
	"emitters": [
		{
			"name": "sparkles",
			"max": 120,
			"burst": [{"at": 0, "count": [60, 80]}],
			"shape": {"kind": "cone", "angle": 35, "radius": 0.25},
			"life": [0.5, 1.1],
			"speed": [2, 4],
			"gravity": 4,
			"drag": 1,
			"align": "velocity",
			"stretch": 0.08,
			"size": [[0, 0.06], [1, 0.02]],
			"color": [[0, "#fff0b0", 1, 6], [0.5, "#ffc040", 1, 3], [1, "#ff8000", 0]],
			"texture": "effects/textures/spark/spark.png",
			"blend": "additive"
		}
	]
}
```

| | |
|---|---|
| `duration`, `loop` (effect) | How long its emitters emit (0 = forever: ambient); `loop` starts it over after `duration` |
| `rate`, `burst`, `delay`, `duration` | Emission: per second; a count or `[{"at": s, "count": n or [min, max]}]`; when it starts; for how long |
| `max` | Alive at once (CPU 256 by default; GPU 16384) |
| `shape` | `{"kind", "radius", "size", "angle", "length", "surface"}`: `point` (every way), `sphere`/`hemisphere` (outwards), `box` (up), `cone` (within `angle` of up, from a disc), `ring` (a circle on the ground, outwards), `line` (along X). `offset` moves it |
| `life`, `speed`, `velocity` | Seconds; m/s along the shape's direction; a constant start velocity added |
| `gravity`, `drag`, `force`, `noise` | m/s² down (negative rises: smoke, embers); slowing per second; wind; turbulence (with `noise_scale` metres) |
| `rotation`, `rotation_speed` | Degrees at birth, degrees per second |
| `size` | Metres, a number or keys `[[t, size], ...]` over its life (t 0 birth, 1 death) |
| `size_random` | `[min, max]` multiplier per particle |
| `color` | `"#rrggbb"` or keys `[[t, "#rrggbb", alpha, intensity], ...]`; `intensity` above 1 glows (bloom), times the emitter's `intensity` |
| `texture`, `flipbook`, `fps`, `random_frame` | An image (a soft dot by default); `[columns, rows]` frames played once over the life (or at `fps`) |
| `blend` | `alpha` (smoke, dust, leaves: sorted back to front) or `additive` (light: sparks, fire, magic) |
| `soft` | Metres over which it fades where it meets the ground or a wall: smoke and dust need it (0.2-0.5) |
| `align` | `camera` (default), `velocity` (streaks: sparks, rain; `stretch` = extra length per m/s, as a multiple of size: rain wants about 3) or `ground` (flat: ripples, scorch rings) |
| `space` | `world` (default: particles stay where born) or `local` (they follow the entity: a torch carried) |
| `"sim": "gpu"` | A continuous field of `max` particles on the GPU, each reborn when it dies: rain, snow, fireflies, motes over an area. No bursts, world space, at most 4 keys per curve |

Values like `life` and `speed` are a number or `[min, max]`, picked per particle. Values are seconds and metres.

## Making it read
- **Shape over count**: a burst reads from its first frames. Give it a strong, fast start (speed, a bright first
  key) and a soft end (size and alpha falling to 0 at t = 1). Nothing should pop out of existence at full size.
- **Vary everything a little**: ranges on life, speed, size and rotation make the difference between a cloud and a
  stamp.
- **Glows**: additive with intensity 2-8 in the first keys, cooling to a darker colour and 0 alpha. Sparks: velocity
  aligned, gravity, a little drag.
- **Smoke and dust**: alpha blend, `soft`, a flipbook texture (smoke or dust recipe 4×4), rotation and spin, size
  growing over life, drag so it slows, `gravity` slightly negative for smoke.
- **Scale to the camera**: Goblin Gold's camera is a few metres back: a 3 cm spark is a dot; footstep dust is about
  0.3-0.6 m.

## Textures
- `make_particle_texture` with a recipe (no GPU, instant, white so the effect colours it): `dot`, `soft`, `smoke`,
  `dust`, `spark`, `star`, `ember`, `streak`, `ring`; `smoke`, `dust` and `ring` can be a `flipbook` [4, 4] (puffs grow
  and thin, a ring spreads). Set the same `flipbook` on the emitter (the tool returns it).
- `generate_particle_texture` for drawn shapes in the game's style: `mode` `glow` (generated on black: sparkles,
  flames, magic symbols) or `solid` (on white: leaves, coins, petals). Prompt one element. Judge the sheet, then
  `make_particle_texture` with the chosen `source`. Never generate a flipbook: frames won't match.

## Placing and playing
- **Ambient** (fireflies by a pond, smoke from a chimney): an entity in the scene with
  `{"Effect": {"path": "effects/<name>.json"}}` at the spot. Its emitters turn with the entity.
- **At a moment** (a chest opening, a footstep, a victory): game code calls
  `engine.play_effect("effects/<name>.json", position)` (it frees itself when done). Say exactly where in your report.

## Budget
CPU particles cost about 0.015 ms per thousand a frame; a burst of 100 is nothing, 20 000 alive is a lot. Above
a few thousand alive, or for anything filling an area, use `"sim": "gpu"` (about 0.001 ms per thousand). Keep
`max` near what's actually alive.

## Checking
`preview_effect` plays the effect afresh at each `time` (simulated ahead, fixed seed) and returns frames with
particle counts, the effect's bounds and problems. Use close times (0.05, 0.1, 0.2) to judge speed and the start,
spread ones (0.2, 0.6, 1.2, 2) to see it grow and fade, `background` dark or light like where it plays, and
`scene` + `position` to see it where it really is. Look at every frame before calling it done.
