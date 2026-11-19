---
name: blender-modelling
description: Editing, rigging and animating generated 3D models with headless Blender scripts (bpy), and exporting them for the engine. Use for precise model edits, fixing rigs, hand-made rigs and clips for props.
---
# Headless Blender for game models

Run scripts with `blender -b --factory-startup --python script.py -- args`. Pass paths as arguments and read
them from `sys.argv[sys.argv.index("--") + 1:]`. Look at your result: render a still (Workbench is fast), or
spawn the model in the engine and take a screenshot.

## Conventions
- glTF is Y-up and Blender is Z-up; the importer and exporter convert. In Blender, the model's front faces
  **-Y** (glTF +Z, the engine's forward). Metres throughout.
- Work from a model's latest `source/` mesh (`rigged.glb`, `textured.glb` or `shape.glb`), write your result to
  `source/edited.glb`, then call the `finalize_model` tool with `from: source/edited.glb`. Finalize welds,
  scales, enforces the engine's vertex limit and renders the thumbnail.
- Never write meshes with more than 65,535 vertices per primitive (the engine uses 16-bit indices). Before
  exporting, clear custom split normals, or the exporter splits every vertex per triangle corner.

## Skeleton

```python
import sys, bpy
src, out = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
# ... edit ...
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=True)
```

## Rigging generated characters
Keep UniRig's smooth weights. Generated meshes are one connected piece, so making parts rigid needs real part
segmentation first. Nearest-bone rigid weights (per vertex, or per face with the seams split) were tried and
make things worse: spikes, holes and torn flaps. If one joint deforms badly, smooth the weights locally
around it (Weight Paint → Smooth on the vertices near that joint) rather than re-weighting the whole mesh.

## Prop rigs
Use the `rig_prop` tool for hinges (lids, doors, hatches): it cuts, caps, rigs and adds `open`/`close` clips
(see `gen/blender/rig_prop.py` in the studio for how). Hand-rig in Blender only for mechanisms it can't express
(two hinges, sliding parts), following the same pattern: split the moving part off along its seam, cap the
cut, give each piece one bone with weight 1, and key rotations about the hinge axis.

## Clips
One action per clip; the action name becomes the engine's clip name (`Animator.clip`).

```python
import math
arm.animation_data_create()
action = bpy.data.actions.new("open"); arm.animation_data.action = action
pb = arm.pose.bones["lid"]; pb.rotation_mode = "XYZ"
for frame, deg in ((1, 0), (24, -100)):
    pb.rotation_euler = (math.radians(deg), 0, 0); pb.keyframe_insert("rotation_euler", frame=frame)
# For several clips: set action.use_fake_user = True on each, and export with export_animation_mode="ACTIONS".
```
Check clips in the engine: the `assets` command lists each model's `animations`, and an entity with
`{"Animator": {"clip": "open"}}` plays one.
