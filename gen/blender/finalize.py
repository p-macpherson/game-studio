"""Makes a generated model engine-ready. Run headless:  blender -b --python finalize.py -- '<json params>'

params: {in, out, height?: metres (default 1), thumbnail?: png path, smooth_weights?: passes (right after auto-rigging)}
- Removes stray helper meshes (UniRig leaves an unskinned icosphere).
- Welds split vertices, shades smooth and clears custom split normals (otherwise the glTF exporter writes one
  vertex per triangle corner).
- Scales to `height` (metres), centres on X/Z and puts the base at Y=0, so the model stands on the ground at
  its entity's position. Applies transforms. Keeps the model facing glTF +Z (the engine's forward).
- Exports .glb (with skins and animations), then checks every primitive is within the engine's 65,535-vertex
  limit (raylib uses 16-bit indices), decimating and re-exporting if not.
- Renders a 3/4 thumbnail.
Prints "RESULT: {json}" with stats.
"""
import json
import math
import struct
import sys

import bmesh
import bpy
from mathutils import Vector

MAX_VERTICES = 65535
p = json.loads(sys.argv[sys.argv.index("--") + 1])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=p["in"])
scene = bpy.context.scene
armatures = [o for o in scene.objects if o.type == "ARMATURE"]
if armatures:
    for o in [o for o in scene.objects if o.type == "MESH" and not any(m.type == "ARMATURE" for m in o.modifiers)]:
        bpy.data.objects.remove(o)
meshes = [o for o in scene.objects if o.type == "MESH"]
# The importer leaves the first clip playing: measure, scale and render the rest pose, not a frame of a clip.
for a in armatures:
    a.data.pose_position = "REST"
if not meshes:
    raise SystemExit("no meshes in the model")


def weld_and_smooth(ob) -> None:
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(ob.data)
    bm.free()
    if ob.data.has_custom_normals:
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()


def smooth_skin_weights(ob, passes: int, factor: float = 0.5) -> None:
    """Laplacian smoothing of skin weights over the mesh, keeping each vertex's 4 strongest bones (the engine's
    limit). A few passes soften UniRig's crumpled necks and dented shoulders; many passes turn joints lumpy."""
    import numpy as np

    me = ob.data
    groups = list(ob.vertex_groups)
    n = len(me.vertices)
    weights = np.zeros((n, len(groups)), np.float32)
    for v in me.vertices:
        for e in v.groups:
            weights[v.index, e.group] = e.weight
    edges = np.array([e.vertices[:] for e in me.edges])
    degree = np.maximum(np.bincount(edges.ravel(), minlength=n), 1).astype(np.float32)[:, None]
    for _ in range(passes):
        acc = np.zeros_like(weights)
        np.add.at(acc, edges[:, 0], weights[edges[:, 1]])
        np.add.at(acc, edges[:, 1], weights[edges[:, 0]])
        weights = (1 - factor) * weights + factor * acc / degree
    top = np.argsort(-weights, axis=1)[:, :4]
    keep = np.zeros(weights.shape, dtype=bool)
    np.put_along_axis(keep, top, True, axis=1)
    weights = np.where(keep, weights, 0)
    weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-8)
    everything = list(range(n))
    for gi, group in enumerate(groups):
        group.remove(everything)
        for i in np.nonzero(weights[:, gi] > 1e-4)[0]:
            group.add([int(i)], float(weights[i, gi]), "REPLACE")


for ob in meshes:
    weld_and_smooth(ob)
    # Only right after automatic rigging; re-finalizing (e.g. after an agent's edits) must not smooth again.
    if p.get("smooth_weights") and any(m.type == "ARMATURE" for m in ob.modifiers):
        smooth_skin_weights(ob, int(p["smooth_weights"]))

# Scale and place: Blender is Z-up here; glTF export converts to Y-up.
bpy.context.view_layer.update()
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
scale = float(p.get("height", 1.0)) / max(hi.z - lo.z, 1e-6)
offset = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
for o in scene.objects:
    if o.parent is None:
        o.location = (o.location - offset) * scale
        o.scale = o.scale * scale
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = armatures[0] if armatures else meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def export() -> None:
    for a in armatures:
        a.data.pose_position = "POSE"
    bpy.ops.export_scene.gltf(filepath=p["out"], export_format="GLB", export_skins=True, export_animations=True, export_yup=True)


def primitive_vertex_counts(path: str) -> list[int]:
    """Vertex counts of every primitive in a .glb (read from its JSON chunk)."""
    with open(path, "rb") as f:
        f.read(12)
        length, _kind = struct.unpack("<II", f.read(8))
        doc = json.loads(f.read(length))
    return [doc["accessors"][prim["attributes"]["POSITION"]]["count"] for mesh in doc.get("meshes", []) for prim in mesh["primitives"]]


export()
counts = primitive_vertex_counts(p["out"])
decimated = []
for _ in range(4):
    if max(counts) <= MAX_VERTICES:
        break
    ratio = 0.9 * MAX_VERTICES / max(counts)
    for ob in meshes:
        mod = ob.modifiers.new("fit_vertex_limit", "DECIMATE")
        mod.ratio = ratio
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    decimated.append(round(ratio, 3))
    export()
    counts = primitive_vertex_counts(p["out"])
if max(counts) > MAX_VERTICES:
    raise SystemExit(f"could not get under {MAX_VERTICES} vertices per primitive: {counts}")

bones = sum(len(a.data.bones) for a in armatures)
animations = sorted(a.name for a in bpy.data.actions)
triangles = sum(sum(len(poly.vertices) - 2 for poly in o.data.polygons) for o in meshes)
size = hi - lo
result = {
    "mesh": p["out"],
    "primitives": len(counts),
    "vertices": sum(counts),
    "max_primitive_vertices": max(counts),
    "triangles": triangles,
    "bones": bones,
    "animations": animations,
    # glTF axes (Y up), in metres after scaling.
    "size": [round(size.x * scale, 3), round(size.z * scale, 3), round(size.y * scale, 3)],
    "decimated": decimated,
}

if p.get("thumbnail"):
    for a in armatures:
        a.data.pose_position = "REST"
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = True
    cam = bpy.data.objects.new("thumbnail_camera", bpy.data.cameras.new("thumbnail_camera"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    height = float(p.get("height", 1.0))
    extent = max(size.x, size.y, size.z) * scale
    cam.data.ortho_scale = extent * 1.35
    target = Vector((0, 0, height / 2))
    # Three-quarter view from the front (glTF +Z is Blender -Y), slightly above.
    a = math.radians(35)
    cam.location = target + Vector((math.sin(a), -math.cos(a), 0.45)).normalized() * extent * 4
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = p["thumbnail"]
    bpy.ops.render.render(write_still=True)
    result["thumbnail"] = p["thumbnail"]

print("RESULT: " + json.dumps(result))
