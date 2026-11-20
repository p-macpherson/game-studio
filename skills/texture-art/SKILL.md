---
name: texture-art
description: Game Studio's tileable surface textures (assets/textures/<name>/): prompting in the game's style, judging seamless candidates from their tiled previews, tile sizes in metres, normal and roughness maps, and how scenes use them. Use whenever making or changing a texture.
---
# Tileable surface textures

A texture is a folder `assets/textures/<name>/` (lower-kebab-case; "/" for folders, e.g. `ground/grass`):

| File | What |
|---|---|
| `texture.json` | The asset: `notes`, `prompt`, `tile` (metres per repeat), `source` (the chosen candidate), `normal_strength` (0-20, default 4), `roughness` ([min, max], default [0.55, 0.95]) |
| `candidates/<name>-<seed>-roll.png`, `-quilt.png` | Generated seamless candidates, two per seed; `candidates.json` records how each was made |
| `<name>.png`, `<name>_normal.png`, `<name>_roughness.png` | What scenes use: colour, normal (tangent space, +Y up), roughness. Written by `make_texture`: never edit them |

## Making one
1. **Prompt the surface and the game's style.** The studio adds "seamless, top-down, flat lighting"; you add what the
   surface is and the art direction from `docs/design/`. Without the style, surfaces come out photoreal: "short grass
   with small clover leaves, **stylised hand-painted game texture, calm palette**". Describe the material, not a scene
   (no horizon, objects or lighting).
2. `generate_texture` (2 seeds = 4 candidates, ~25 s a seed on the GPU). The sheet shows each candidate **tiled 2x2**:
   the middle cross is where the edges meet.
3. **Judge the tilings, not the single images:**
   - a visible line or step down the middle cross: a seam. Reject
   - the same blotch, spot or swirl repeating in a grid: it will look like wallpaper at a distance. Reject or regenerate
   - shading, a light direction, perspective or a vignette: it won't tile believably. Regenerate with a plainer prompt
   - Either method can win: `roll` (seamless while generating) is usually better on stones and bricks, `quilt` (cut
     afterwards) on wood and organic surfaces. Regular rows (bricks, cobbles) are the hardest: generate more seeds.
4. `make_texture` with the chosen `source` and its `tile`, then check the preview (colour tiled, normal, roughness).
   Raise `normal_strength` for deep relief (cobbles 5-7), lower it for flat surfaces (painted plaster 1-2).

## Tile sizes
How wide one repeat is in the world. The texture must look right at that size next to a 1.1 m goblin: count the
features (stones, planks, clover leaves) across one image and size them realistically for the style.

| Surface | Typical `tile` |
|---|---|
| Grass, moss, dirt | 2-3 m |
| Cobblestone path | 1.5-2 m |
| Wooden planks | 1-2 m |
| Stone or brick wall | 2-3 m |

## In scenes
A Mesh_Renderer's material names the three files (paths as the engine loads them, from `assets/`) and how often it
repeats: `uv_scale` = the surface's size / `tile`. Built-in meshes have 0..1 UVs per face; a plane's one face spans
its x and z scale, so a 20 × 20 m ground with a 2 m texture is `[10, 10]`:

```json
{"Mesh_Renderer": {"mesh": "plane", "material": {"texture": "textures/grass/grass.png", "normal_map": "textures/grass/grass_normal.png",
  "roughness_map": "textures/grass/grass_roughness.png", "uv_scale": [10, 10]}}}
```

Drop the material's `color` when texturing (it tints the texture). People do the same with the Scenes inspector's
**Surface texture** picker, which computes `uv_scale` from the entity's size.
