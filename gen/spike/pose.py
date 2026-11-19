"""Blender (headless) rig check: blender -b --python pose.py -- RIGGED.glb OUT_PREFIX

Prints the skeleton, then renders the rest pose with bones visible, and a test pose (outermost bones
on each side swung down, the topmost bone turned) to show whether the skin weights deform sensibly.
"""
import math
import sys

import bpy
from mathutils import Euler, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
src, prefix = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
bones = arm.data.bones
print(f"RIG: {len(bones)} bones, {sum(len(m.vertex_groups) for m in meshes)} vertex groups")
for b in bones:
    depth = 0
    p = b.parent
    while p:
        depth, p = depth + 1, p.parent
    print("RIG:", "  " * depth + b.name, tuple(round(v, 2) for v in (arm.matrix_world @ b.head_local)))

# Frame the model.
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
centre, size = (lo + hi) / 2, max(hi - lo)

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "SINGLE"
scene.render.resolution_x = scene.render.resolution_y = 512
scene.world = bpy.data.worlds.new("w")
scene.world.color = (0.12, 0.13, 0.15)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = "ORTHO"
cam.data.ortho_scale = size * 1.3
cam.location = centre + Vector((0, -size * 3, 0))
cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()

arm.show_in_front = True
arm.data.display_type = "STICK"
scene.render.filepath = f"{prefix}_rest.png"
bpy.ops.render.render(write_still=True)

# Test pose: the bone furthest out on each side (an arm's end) has its chain's upper bone swung down,
# and the topmost bone (a head) turned.
heads = {b.name: arm.matrix_world @ b.head_local for b in bones}
pose = arm.pose.bones


def chain_root(name: str, levels: int) -> str:
    b = bones[name]
    for _ in range(levels):
        if b.parent and b.parent.parent:
            b = b.parent
    return b.name


left = max(heads, key=lambda n: heads[n].x)
right = min(heads, key=lambda n: heads[n].x)
top = max(heads, key=lambda n: heads[n].z)
for name, angle in ((chain_root(left, 5), -50), (chain_root(right, 5), 50)):
    pb = pose[name]
    pb.rotation_mode = "XYZ"
    # Rotate around the world forward axis, expressed in the bone's local space.
    axis = (arm.matrix_world @ pb.bone.matrix_local).inverted().to_3x3() @ Vector((0, 1, 0))
    pb.rotation_mode = "AXIS_ANGLE"
    pb.rotation_axis_angle = (math.radians(angle), *axis.normalized())
    print("POSE: swung", name)
pt = pose[top]
pt.rotation_mode = "XYZ"
pt.rotation_euler = Euler((0, math.radians(35), 0))
print("POSE: turned", top)
arm.show_in_front = False
scene.render.filepath = f"{prefix}_posed.png"
bpy.ops.render.render(write_still=True)
