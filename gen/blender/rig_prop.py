"""Hinge rig for a prop (chest lid, door, hatch). Run headless:  blender -b --python rig_prop.py -- '<json params>'

params: {in, out, split?: 0..1 (default 0.6), hinge?: "back"|"front"|"left"|"right" (default "back"), angle?: degrees (default 100)}
- Cuts the mesh with a horizontal plane at `split` of its height and splits it along the cut, so the part above
  (the lid) is a separate piece that turns without stretching anything.
- Adds bones `root` (the base) and `lid`, hinged along the top edge of the base on the `hinge` side, and binds
  each piece rigidly to its bone.
- Adds clips `open` (closed -> open over 1 s) and `close` (the reverse); the lid always swings upwards.
Generated meshes are one closed piece, so both sides of the cut are capped with flat faces (untextured: they
take the texture's corner colour).
Prints "RESULT: {json}".
"""
import json
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

p = json.loads(sys.argv[sys.argv.index("--") + 1])
split = float(p.get("split", 0.6))
hinge_side = p.get("hinge", "back")
angle = float(p.get("angle", 100))
FPS = 24

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=p["in"])
scene = bpy.context.scene
scene.render.fps = FPS
if any(o.type == "ARMATURE" for o in scene.objects):
    raise SystemExit("the model already has a skeleton; regenerate it unrigged (or remove the rig) first")
meshes = [o for o in scene.objects if o.type == "MESH"]
if len(meshes) != 1:
    raise SystemExit(f"expected one mesh, found {len(meshes)}")
ob = meshes[0]
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

corners = [Vector(c) for c in ob.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
cut_z = lo.z + split * (hi.z - lo.z)

# Cut at the plane and separate the two sides along the cut.
bm = bmesh.new()
bm.from_mesh(ob.data)
# The glTF importer splits vertices along texture seams; weld them (UVs are kept per corner) so the cut is a
# closed loop that can be capped.
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
result = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, cut_z), plane_no=(0, 0, 1))
cut_edges = [g for g in result["geom_cut"] if isinstance(g, bmesh.types.BMEdge)]
bmesh.ops.split_edges(bm, edges=cut_edges)
lid_side = {v for f in bm.faces if f.calc_center_median().z > cut_z for v in f.verts}
# Cap both sides of the cut, so the open lid and the base aren't see-through shells.
open_edges = [e for e in bm.edges if e.is_boundary and abs(e.verts[0].co.z - cut_z) < 1e-4 and abs(e.verts[1].co.z - cut_z) < 1e-4]
rim_uvs = []
uv_layer = bm.loops.layers.uv.active
if uv_layer:
    rim = {v for e in open_edges for v in e.verts}
    rim_uvs = [loop[uv_layer].uv.copy() for v in rim for loop in v.link_loops]
caps = bmesh.ops.holes_fill(bm, edges=open_edges, sides=0)["faces"]
caps = bmesh.ops.triangulate(bm, faces=caps)["faces"]
# Face each cap outwards so it isn't culled: the base's cap up, the lid's cap down. (Recalculating normals for
# the whole mesh flips parts of generated meshes, which aren't clean closed surfaces.)
for f in caps:
    f.normal_update()
    on_lid = all(v in lid_side for v in f.verts)
    if (f.normal.z > 0) == on_lid:
        f.normal_flip()
bm.verts.index_update()

# Caps get a plain material in the average colour of the texture around the cut.
cap_colour = (0.25, 0.2, 0.15, 1.0)
material = ob.data.materials[0] if ob.data.materials else None
image = None
if material and material.use_nodes:
    image = next((n.image for n in material.node_tree.nodes if n.type == "TEX_IMAGE" and n.image), None)
if image and rim_uvs:
    w, h = image.size
    pixels = image.pixels[:]
    samples = []
    for uv in rim_uvs[:: max(1, len(rim_uvs) // 400)]:
        x, y = min(int(uv.x % 1 * w), w - 1), min(int(uv.y % 1 * h), h - 1)
        i = (y * w + x) * 4
        samples.append(pixels[i : i + 3])
    cap_colour = (*[sum(c[k] for c in samples) / len(samples) * 0.7 for k in range(3)], 1.0)  # a little darker: the inside
cap_material = bpy.data.materials.new("cap")
cap_material.use_nodes = True
next(n for n in cap_material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = cap_colour
ob.data.materials.append(cap_material)
for f in caps:
    f.material_index = len(ob.data.materials) - 1
lid_verts, base_verts = set(), set()
for f in bm.faces:
    is_lid = all(v in lid_side for v in f.verts) if abs(f.calc_center_median().z - cut_z) < 1e-4 else f.calc_center_median().z > cut_z
    (lid_verts if is_lid else base_verts).update(v.index for v in f.verts)
bm.to_mesh(ob.data)
bm.free()
if not lid_verts or not base_verts:
    raise SystemExit(f"nothing above or below split={split}; choose a height fraction inside the model")

# Hinge line: the top edge of the base on the hinge side. Blender: front is -Y, the model's left is +X.
cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
hinge_point, axis = {
    "back": (Vector((cx, hi.y, cut_z)), Vector((1, 0, 0))),
    "front": (Vector((cx, lo.y, cut_z)), Vector((1, 0, 0))),
    "left": (Vector((hi.x, cy, cut_z)), Vector((0, 1, 0))),
    "right": (Vector((lo.x, cy, cut_z)), Vector((0, 1, 0))),
}[hinge_side]
lid_centre = Vector((cx, cy, (cut_z + hi.z) / 2))
# Turn the way that lifts the lid's centre.
lifted = (Matrix.Rotation(math.radians(angle), 3, axis) @ (lid_centre - hinge_point)).z
signed_angle = angle if lifted > (lid_centre - hinge_point).z else -angle

arm_data = bpy.data.armatures.new("Rig")
arm = bpy.data.objects.new("Rig", arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
root = arm_data.edit_bones.new("root")
root.head = Vector((cx, cy, lo.z))
root.tail = Vector((cx, cy, cut_z))
lid = arm_data.edit_bones.new("lid")
lid.parent = root
lid.head = hinge_point
lid.tail = hinge_point + (lid_centre - hinge_point).normalized() * max((lid_centre - hinge_point).length, 0.05)
bpy.ops.object.mode_set(mode="OBJECT")

for name, verts in (("root", base_verts), ("lid", lid_verts)):
    ob.vertex_groups.new(name=name).add(sorted(verts), 1.0, "REPLACE")
ob.parent = arm
ob.modifiers.new("Armature", "ARMATURE").object = arm

# Clips: a rotation about the hinge axis, expressed in the lid bone's local space.
local_axis = (arm.data.bones["lid"].matrix_local.inverted().to_3x3() @ axis).normalized()
pb = arm.pose.bones["lid"]
pb.rotation_mode = "QUATERNION"
for clip, (start, end) in {"open": (0.0, 1.0), "close": (1.0, 0.0)}.items():
    action = bpy.data.actions.new(clip)
    action.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = action
    for k in range(9):
        t = k / 8
        eased = start + (end - start) * (0.5 - 0.5 * math.cos(math.pi * t))
        pb.rotation_quaternion = Quaternion(local_axis, math.radians(signed_angle * eased))
        pb.keyframe_insert("rotation_quaternion", frame=1 + round(t * FPS))
    arm.animation_data.action = None

bpy.ops.export_scene.gltf(filepath=p["out"], export_format="GLB", export_skins=True, export_animations=True, export_animation_mode="ACTIONS")
print("RESULT: " + json.dumps({"bones": ["root", "lid"], "clips": ["open", "close"], "hinge": hinge_side, "split": split, "lid_vertices": len(lid_verts)}))
