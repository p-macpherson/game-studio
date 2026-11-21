---
name: level-design
description: Editing headless-game-engine scenes and prefabs (assets/scenes/*.json, assets/prefabs/*.json) as Game Studio keeps them: the format, ids and prefab references, units and axes, placing models, and checking the result with preview_scene. Use whenever creating or changing a scene or prefab.
---
# Scenes and prefabs

A scene is `assets/scenes/<name>.json`; the game loads it by its path under `assets/` (`scenes/<name>.json`). A prefab
(`assets/prefabs/<name>.json`) has the same shape and its **first entity is the root**. The engine's reference is
"Scenes and prefabs" in `engine/docs/making-a-game.md`.

```json
{
  "notes": "Goblin Gold's clearing: the goblin starts in the middle, four chests to find.",
  "environment": {"sky_zenith": [0.25, 0.45, 0.75], "fog_density": 0.02},
  "entities": [
    {"id": 1, "Name": "Sun", "Transform": {"rotation": [50, 30, 0]}, "Light": {"kind": "Directional", "intensity": 1.3, "shadows": true}},
    {"id": 3, "Name": "Ground", "Transform": {"position": [0, -0.5, 0], "scale": [40, 1, 40]}, "Mesh_Renderer": {"mesh": "cube"}, "Rigid_Body": {}},
    {"id": 20, "prefab": "prefabs/chest.json", "Name": "Chest 1", "Transform": {"position": [4, 0, 6], "rotation": [0, 210, 0]}, "Chest": {"gold": 25}},
    {"id": 50, "Name": "Lantern", "notes": "Lights the path to chest 1", "Transform": {"position": [3, 0, 4.5]}, "Mesh_Renderer": {"mesh": "models/lantern/lantern.glb"}}
  ]
}
```

## Rules Game Studio relies on
- **Plain JSON**, one entity per line, as above. No comments: put them in `"notes"` (on the file or on an entity).
  The Scenes section rewrites files in this layout, so keep it to keep diffs small.
- **ids** are positive whole numbers, unique in the file, and **stable**: never renumber. New entities take an
  unused id (grouping by tens, as above, is fine). `Transform.parent` refers to a parent by its id.
- **Keep prefab instances as references**: `{"id": 21, "prefab": "prefabs/chest.json", "Transform": {...}}`. Any
  component written on the instance overrides the prefab root's, field by field. Don't copy a prefab's contents in.
- Every other key is a component name (`Name`, `Transform`, `Mesh_Renderer`, `Light`, `Rigid_Body`, the game's own,
  e.g. `Chest`). An unknown name or field is a warning in the engine's log; `preview_scene` reports them.
- Leave out fields at their default: zero means default for every engine field (`scale` omitted is 1).

## Units and axes
- Metres, degrees. **+Y up, +Z forward, -X right** (so +X is to the left when you look along +Z).
- `rotation` is `[pitch, yaw, roll]` in degrees; yaw turns around +Y. Models face +Z at yaw 0.
- Generated models (`assets/models/<name>/<name>.glb`) have their origin at the bottom centre, so `position.y = 0`
  stands them on flat ground at height 0. `model.json` next to each records its size.
- A model is placed with `Mesh_Renderer.mesh = "models/<name>/<name>.glb"`. Add `"Rigid_Body": {}` (static box
  around the mesh) when the player should bump into it; small decoration can do without.
- **A prefab instance gets all of the prefab's components, its `Rigid_Body` included**, at any scale: read the
  prefab before saying what an instance does. An instance can't drop a component, so anything the player should walk
  over (stepping stones, pebbles) places the model directly, with `Mesh_Renderer` and no `Rigid_Body`.

## Placement that reads well
- Leave walking room: about 1.5 m between things the player walks between; nothing inside anything else.
- Vary rotations and scales a little (yaw and 0.8-1.3) so repeated props don't look stamped.
- Group by purpose (props around a landmark), and keep the play area readable from the game's camera.

## Surfaces (textures)
Grounds, paths and floors are usually built-in planes with a texture from `assets/textures/` (made ones have
`<name>.png`, `_normal.png` and `_roughness.png`; `texture.json` says its `tile` in metres). Set the Mesh_Renderer's
material to the three files with `uv_scale` = the plane's x and z scale / `tile`, and drop its `color` (see the
**texture-art** skill for the format). A patch on the ground is a thinner plane 0.01-0.02 m above it, so the two
don't flicker. No texture for what you need? Ask the Art Director for one (`delegate`), with the surface and size.

**Paths, roads, rivers and trails are a `Path`**, never a row of planes (their corners make jagged edges and break
the pattern at every bend): one entity with a smooth curve through `points` and a Mesh_Renderer with no `mesh`.
```json
{"id": 70, "Name": "Path to Chest 1", "Transform": {"position": [0, 0.01, 0]},
 "Path": {"points": [[0, 0, 0], [0.8, 0, 1.6], [2.2, 0, 3.0], [2.6, 0, 5.2]], "width": 1.3},
 "Mesh_Renderer": {"material": {"texture": "textures/cobblestone/cobblestone.png", "normal_map": "textures/cobblestone/cobblestone_normal.png",
   "roughness_map": "textures/cobblestone/cobblestone_roughness.png", "uv_scale": [0.667, 0.667]}}}
```
- `points` are metres in the entity's local space (`y` is height, for slopes); the curve passes through each one.
  A point every 1.5-3 m along the route is plenty; add more only where it bends.
- UVs are metres along and across, so `uv_scale` = 1 / `tile` on both axes (times the entity's scale).
- Keep bends wider than half the width, or the inside edge folds. Branches are separate Paths meeting at a junction
  (a round plane, say); give overlapping ones heights 2 mm apart (0.010, 0.012…) so they don't flicker.
- A Path has no collision: the player walks over it on the ground beneath.

## Check your work
`preview_scene` builds the game, opens the scene paused and returns screenshots: `top` (from above: +Z is up the
image, +X is to the left), `overview` (three-quarter, from the -Z side) and `game` (the scene's own Camera), or your own
`{position, target}` views. It also lists problems in the file and engine warnings. Call it **after the edit has
finished** (tools in one batch can run at the same time), and look at every image before saying it's done.
Include `game` in the last check: it's what the player sees.

Paused previews don't show what's solid. When the player should walk along or through something you placed, walk them
there: a scripted run (**engine-control** skill) that sets the player's Transform next to it, holds the move action
and asserts on the position. Keep the script in `build/` (`./build.sh test build/walk.jsonl`) so it isn't committed.
