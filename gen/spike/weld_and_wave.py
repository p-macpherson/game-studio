"""Blender (headless): blender -b --python weld_and_wave.py -- RIGGED.glb OUT.glb ARM_BONE

Welds the rigged mesh's split vertices (UniRig's merge writes one vertex per triangle corner, which overflows
raylib's 16-bit indices), adds a one-second "Wave" clip swinging ARM_BONE, and exports engine-ready glTF.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
src, out, arm_bone = argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
for o in list(bpy.context.scene.objects):
    print(f"NODE: {o.name} {o.type} parent={o.parent.name if o.parent else None} loc={tuple(round(v, 3) for v in o.location)} rot={tuple(round(v, 3) for v in o.rotation_euler)} scale={tuple(round(v, 3) for v in o.scale)}")
    if o.type == "MESH" and not any(m.type == "ARMATURE" for m in o.modifiers):
        bpy.data.objects.remove(o)  # stray helper meshes (UniRig leaves an unskinned icosphere)
# raylib's glTF loader expects skinned meshes with identity node transforms: bake them into the data.
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for ob in (o for o in bpy.context.scene.objects if o.type == "MESH"):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    print(f"WELD: {ob.name} {before} -> {len(bm.verts)} vertices")
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(ob.data)
    bm.free()
    # Imported per-corner normals make the glTF exporter split every vertex again (one per triangle corner).
    if ob.data.has_custom_normals:
        bpy.context.view_layer.objects.active = ob
        bpy.ops.mesh.customdata_custom_splitnormals_clear()

# A wave: the upper arm swings up and back down around the world forward axis.
pb = arm.pose.bones[arm_bone]
axis = (arm.matrix_world @ pb.bone.matrix_local).inverted().to_3x3() @ Vector((0, 1, 0))
pb.rotation_mode = "AXIS_ANGLE"
arm.animation_data_create()
arm.animation_data.action = bpy.data.actions.new("Wave")
for frame, angle in ((1, 0), (13, -70), (25, 0)):
    pb.rotation_axis_angle = (math.radians(angle), *axis.normalized())
    pb.keyframe_insert("rotation_axis_angle", frame=frame)
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 25
bpy.context.scene.render.fps = 24

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True, export_skins=True)
print(f"WROTE: {out}")
