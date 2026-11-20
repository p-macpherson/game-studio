# P3-SAM spike: rigid per-part skinning. Each P3-SAM part is bound 100% to the bone that already carries most of
# its UniRig skin weight, so hard-surface parts move as solid pieces instead of bending.
#   blender -b -P rigidify.py -- rigged.glb seg_dir out.glb
# seg_dir holds P3-SAM's mesh.glb and face_ids.npy (its mesh is cleaned, so faces are matched by nearest centre).
import os, sys
import bpy, numpy as np
from mathutils.kdtree import KDTree

rigged, seg_dir, out = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)

# The segmented mesh: face centres and their part ids (glTF import: same axis conversion as the rigged one).
bpy.ops.import_scene.gltf(filepath=os.path.join(seg_dir, "mesh.glb"))
seg = next(o for o in bpy.context.scene.objects if o.type == "MESH")
ids = np.load(os.path.join(seg_dir, "face_ids.npy"))
tree = KDTree(len(seg.data.polygons))
for p in seg.data.polygons:
    tree.insert(seg.matrix_world @ p.center, p.index)
tree.balance()
seg_bbox = [seg.matrix_world @ v.co for v in seg.data.vertices]
bpy.data.objects.remove(seg)

bpy.ops.import_scene.gltf(filepath=rigged)
ob = next(o for o in bpy.context.scene.objects if o.type == "MESH")
me = ob.data
# P3-SAM normalises nothing we rely on, but the two meshes may differ in scale/offset: fit by bounding boxes.
rig_pts = np.array([ob.matrix_world @ v.co for v in me.vertices])
seg_pts = np.array([tuple(v) for v in seg_bbox])
s_lo, s_hi, r_lo, r_hi = seg_pts.min(0), seg_pts.max(0), rig_pts.min(0), rig_pts.max(0)
scale = (s_hi - s_lo) / np.maximum(r_hi - r_lo, 1e-9)

face_part = np.empty(len(me.polygons), dtype=np.int64)
for p in me.polygons:
    c = (np.array(ob.matrix_world @ p.center) - r_lo) * scale + s_lo
    face_part[p.index] = ids[tree.find(c)[1]]

groups = list(ob.vertex_groups)
W = np.zeros((len(me.vertices), len(groups)), np.float32)
for v in me.vertices:
    for g in v.groups:
        W[v.index, g.group] = g.weight

# Each part's bone: the most total weight over its vertices. Unlabelled faces (-1) keep their smooth weights.
part_bone = {}
for part in np.unique(face_part):
    if part < 0:
        continue
    verts = {i for f in np.nonzero(face_part == part)[0] for i in me.polygons[f].vertices}
    part_bone[int(part)] = int(W[list(verts)].sum(0).argmax())

# A vertex shared by faces of different parts (welded mesh) goes with the part of most of its faces.
vote = {}
for p in me.polygons:
    if face_part[p.index] >= 0:
        for i in p.vertices:
            vote.setdefault(i, []).append(int(face_part[p.index]))
changed = 0
for i, parts in vote.items():
    bone = part_bone[max(set(parts), key=parts.count)]
    for g in groups:
        g.remove([i])
    groups[bone].add([i], 1.0, "REPLACE")
    changed += 1
print(f"RIGID parts={len(part_bone)} bones_used={len(set(part_bone.values()))} vertices={changed}/{len(me.vertices)}")
for part, bone in sorted(part_bone.items()):
    print(f"  part {part:3d} -> {groups[bone].name}")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=True)
