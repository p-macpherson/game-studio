"""Builds fixtures/biped.glb: a tiny rigged stick figure shaped like UniRig's output (bones named bone_N, a root
bone above the hips, spine/neck/head, 3-bone arms and legs), so the fake worker's `rig` can return something
animate.py can work on.  Run: blender -b --factory-startup --python make_biped.py"""
import os

import bpy
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)
here = os.path.dirname(os.path.abspath(__file__))

# Body parts (Blender Z-up, facing -Y; the figure's left is +X): (centre, size).
parts = {
    "torso": ((0, 0, 1.15), (0.36, 0.2, 0.6)),
    "head": ((0, 0, 1.62), (0.26, 0.26, 0.28)),
    "arm.L": ((0.42, 0, 1.3), (0.5, 0.1, 0.1)),
    "arm.R": ((-0.42, 0, 1.3), (0.5, 0.1, 0.1)),
    "leg.L": ((0.1, 0, 0.42), (0.12, 0.12, 0.84)),
    "leg.R": ((-0.1, 0, 0.42), (0.12, 0.12, 0.84)),
}
for name, (centre, size) in parts.items():
    bpy.ops.mesh.primitive_cube_add(location=centre)
    o = bpy.context.object
    o.scale = Vector(size) / 2
    o.name = name
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(scale=True)
bpy.context.view_layer.objects.active = bpy.data.objects["torso"]
bpy.ops.object.join()
body = bpy.context.object
# Subdivide so weights have vertices to work with.
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.subdivide(number_cuts=3)
bpy.ops.object.mode_set(mode="OBJECT")

arm_data = bpy.data.armatures.new("Armature")
arm = bpy.data.objects.new("Armature", arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
bones = {}


def bone(name, head, tail, parent=None):
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = Vector(head), Vector(tail)
    if parent:
        b.parent = bones[parent]
    bones[name] = b


bone("bone_0", (0, 0, 0.86), (0, 0, 0.9))  # root
bone("bone_1", (0, 0, 0.9), (0, 0, 1.0), "bone_0")  # hips
bone("bone_2", (0, 0, 1.0), (0, 0, 1.2), "bone_1")  # spine
bone("bone_3", (0, 0, 1.2), (0, 0, 1.4), "bone_2")  # chest
bone("bone_4", (0, 0, 1.45), (0, 0, 1.75), "bone_3")  # head
for i, (side, x) in enumerate((("L", 1), ("R", -1))):
    base = 5 + i * 3
    bone(f"bone_{base}", (x * 0.18, 0, 1.3), (x * 0.25, 0, 1.3), "bone_3")
    bone(f"bone_{base + 1}", (x * 0.25, 0, 1.3), (x * 0.45, 0, 1.3), f"bone_{base}")
    bone(f"bone_{base + 2}", (x * 0.45, 0, 1.3), (x * 0.67, 0, 1.3), f"bone_{base + 1}")
for i, (side, x) in enumerate((("L", 1), ("R", -1))):
    base = 11 + i * 3
    bone(f"bone_{base}", (x * 0.1, 0, 0.86), (x * 0.1, 0, 0.45), "bone_1")
    bone(f"bone_{base + 1}", (x * 0.1, 0, 0.45), (x * 0.1, 0, 0.05), f"bone_{base}")
    bone(f"bone_{base + 2}", (x * 0.1, 0, 0.05), (x * 0.1, -0.12, 0.0), f"bone_{base + 1}")
bpy.ops.object.mode_set(mode="OBJECT")

body.parent = arm
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = arm
# Rigid weights to the nearest bone segment: good enough for a fixture.
from mathutils.geometry import intersect_point_line  # noqa: E402

segments = [(b.name, b.head_local, b.tail_local) for b in arm.data.bones]
groups = {name: body.vertex_groups.new(name=name) for name, _, _ in segments}
for v in body.data.vertices:
    def dist(seg):
        t = max(0.0, min(1.0, intersect_point_line(v.co, seg[1], seg[2])[1]))
        return (v.co - (seg[1] + (seg[2] - seg[1]) * t)).length
    groups[min(segments, key=dist)[0]].add([v.index], 1.0, "REPLACE")

bpy.ops.export_scene.gltf(filepath=os.path.join(here, "biped.glb"), export_format="GLB", export_skins=True)
print("wrote", os.path.join(here, "biped.glb"))
