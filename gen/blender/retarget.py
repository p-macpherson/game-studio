"""Plays clips of the animation library on a model whose bones animate.py named by role. Run headless:
    blender -b --python retarget.py -- '<json params>'

params: {in, out, library: the library's .glb, clips: {name: the library's clip}}
The library (Quaternius's Universal Animation Library, CC0) has one humanoid rig with Rigify-style bones (DEF-hips,
DEF-upper_arm.L, ...): the same roles animate.py gives a generated biped's bones, so they pair by name. For every
frame, each of the model's bones is pointed where the library's bone points:
- its rest direction is first laid along the library's rest direction, so different rest poses (a generated model's
  A-pose against the library's) and proportions (a goblin's short legs) don't twist anything;
- the hips' travel is scaled by how high the model's hips are; a looping clip stays in place (the game moves the
  character), other clips keep their travel.
Bones the library has no partner for (fingers, tails) stay in their rest pose. A clip of the same name is replaced.
Prints "RESULT: {json}".
"""
import json
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

p = json.loads(sys.argv[sys.argv.index("--") + 1])
FPS = 24


def load(path: str):
    objects, actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in objects]
    armature = next((o for o in new if o.type == "ARMATURE"), None)
    return armature, new, [a for a in bpy.data.actions if a not in actions]


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
tgt, _, tgt_actions = load(p["in"])
if tgt is None:
    raise SystemExit("the model has no skeleton (rig it first)")
if "hips" not in tgt.data.bones:
    raise SystemExit("the model's bones aren't named by role yet (animate it first)")
for a in tgt_actions:
    if a.name in p["clips"]:
        bpy.data.actions.remove(a)
    else:
        a.use_fake_user = True  # the clips it already has are kept
src, src_objects, src_actions = load(p["library"])
if src is None or "DEF-hips" not in src.data.bones:
    raise SystemExit("the animation library's rig wasn't found in " + p["library"])

# The model's bone (its role) -> the library's.
PAIRS = {"hips": "DEF-hips", "spine": "DEF-spine.001", "spine.001": "DEF-spine.002", "chest": "DEF-spine.003", "neck": "DEF-neck", "head": "DEF-head"}
for side in ("L", "R"):
    for part in ("shoulder", "upper_arm", "forearm", "hand", "thigh", "shin", "foot", "toe"):
        PAIRS[f"{part}.{side}"] = f"DEF-{part}.{side}"
pairs = {t: s for t, s in PAIRS.items() if t in tgt.data.bones and s in src.data.bones}


def depth(bone) -> int:
    return 0 if bone.parent is None else 1 + depth(bone.parent)


order = sorted(pairs, key=lambda name: depth(tgt.data.bones[name]))  # parents before their children


def rest_rotation(arm, name: str) -> Quaternion:
    return (arm.matrix_world @ arm.data.bones[name].matrix_local).to_quaternion()


def rest_direction(arm, name: str) -> Vector:
    bone = arm.data.bones[name]
    return ((arm.matrix_world @ bone.tail_local) - (arm.matrix_world @ bone.head_local)).normalized()


# Per bone: the turn that lays the model's rest bone along the library's rest bone.
align = {t: rest_direction(tgt, t).rotation_difference(rest_direction(src, s)) for t, s in pairs.items()}
src_hips_rest = src.matrix_world @ src.data.bones["DEF-hips"].head_local
tgt_hips_rest = (tgt.matrix_world @ tgt.data.bones["hips"].matrix_local).translation
hips_scale = tgt_hips_rest.z / max(src_hips_rest.z, 1e-6)
to_armature = tgt.matrix_world.inverted()
src.animation_data_create()
tgt.animation_data_create()
for pb in tgt.pose.bones:
    pb.rotation_mode = "QUATERNION"

made = []
for name, source_name in p["clips"].items():
    source = next((a for a in src_actions if a.name == source_name), None)
    if source is None:
        raise SystemExit(f"the animation library has no clip {source_name!r}")
    src.animation_data.action = source
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    tgt.animation_data.action = action
    last = max(1, round(source.frame_range[1]))
    loop = source_name.endswith("_Loop")
    for f in range(last + 1):
        scene.frame_set(0 if (loop and f == last) else f)  # a loop ends on the pose it starts with
        for pb in tgt.pose.bones:
            pb.rotation_quaternion = Quaternion()
            pb.location = Vector()
        bpy.context.view_layer.update()
        for t in order:
            sp = src.pose.bones[pairs[t]]
            # How far the library's bone has turned from its rest, in world space, applied to the model's bone once
            # that lies along the library's rest bone.
            turned = (src.matrix_world @ sp.matrix).to_quaternion() @ rest_rotation(src, pairs[t]).inverted()
            world = turned @ align[t] @ rest_rotation(tgt, t)
            pb = tgt.pose.bones[t]
            head = (tgt.matrix_world @ pb.matrix).translation
            if t == "hips":
                travel = (src.matrix_world @ sp.matrix).translation - src_hips_rest
                if loop:
                    travel.y = 0.0  # in place
                head = tgt_hips_rest + travel * hips_scale
            pb.matrix = to_armature @ (Matrix.Translation(head) @ world.to_matrix().to_4x4())
            bpy.context.view_layer.update()  # so its children start from where it now is
            pb.keyframe_insert("rotation_quaternion", frame=1 + f)
            if t == "hips":
                pb.keyframe_insert("location", frame=1 + f)
    tgt.animation_data.action = None
    made.append(name)

for o in src_objects:
    bpy.data.objects.remove(o)
for a in src_actions:
    bpy.data.actions.remove(a)
bpy.ops.export_scene.gltf(filepath=p["out"], export_format="GLB", export_skins=True, export_animations=True, export_animation_mode="ACTIONS")
print("RESULT: " + json.dumps({"clips": made, "bones_driven": len(pairs), "hips_scale": round(hips_scale, 3)}))
