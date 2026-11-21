"""Makes a generated model engine-ready. Run headless:  blender -b --python finalize.py -- '<json params>'

params: {in, out, height?: metres (default 1), thumbnail?: png path, smooth_weights?: passes (right after auto-rigging),
  clean?: bool (the input came straight from a generation model)}
- Removes stray helper meshes (UniRig leaves an unskinned icosphere).
- With `clean` (a model straight from generation): removes small pieces floating clear of the body (debris the shape
  model leaves in the air) and, right after auto-rigging, binds small pieces that touch it (a belt pouch) to the body
  where they sit. Right after auto-rigging it also smooths the skin weights a little.
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
    """Welds the copies of a vertex the glTF importer made along texture seams. Only copies with the same skin
    weights are welded: a prop rig's cut leaves the lid's and the base's rims at the same positions on purpose,
    and welding them would pin the lid's edge to the base."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    deform = bm.verts.layers.deform.active
    first: dict[tuple, bmesh.types.BMVert] = {}
    doubles = {}
    for v in bm.verts:
        weights = tuple(sorted((g, round(w, 3)) for g, w in v[deform].items() if w > 1e-4)) if deform else ()
        key = (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5), weights)
        if key in first:
            doubles[v] = first[key]
        else:
            first[key] = v
    bmesh.ops.weld_verts(bm, targetmap=doubles)
    # Smooth shading, except a prop rig's flat caps over its cut (material "cap", see rig_prop.py).
    caps = {i for i, m in enumerate(ob.data.materials) if m and m.name.startswith("cap")}
    for f in bm.faces:
        f.smooth = f.material_index not in caps
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


def clean_loose_pieces(ob, bind: bool) -> tuple[int, int]:
    """Generated meshes come with small pieces that aren't joined to the body. Some float clear of it: debris the
    shape model left in the air (a scrap in front of the belt, a blob behind a heel). Those are removed. Others touch
    it (a pouch on the belt, a buckle): with `bind` (a freshly rigged model) each is bound, rigidly, with the weights
    of the body's surface where it touches, because the auto-rigger weights every vertex to the bones nearest it and a
    pouch beside a resting hand would follow the hand. Returns (pieces removed, pieces bound)."""
    import numpy as np
    from mathutils import kdtree

    me = ob.data
    n = len(me.vertices)
    if n == 0:
        return 0, 0
    piece = list(range(n))  # union-find over the edges: which connected piece each vertex belongs to

    def find(i: int) -> int:
        while piece[i] != i:
            piece[i] = piece[piece[i]]
            i = piece[i]
        return i

    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            piece[a] = b
    pieces: dict[int, list[int]] = {}
    for i in range(n):
        pieces.setdefault(find(i), []).append(i)
    if len(pieces) < 2:
        return 0, 0
    co = np.array([v.co[:] for v in me.vertices], np.float32)
    size = float(np.ptp(co, axis=0).max())
    # Small: a few percent of the mesh and a fraction of its size. Clothes and boots made as their own shells are
    # big: they stay, with their own weights.
    small = [idx for idx in pieces.values() if len(idx) < 0.05 * n and float(np.linalg.norm(np.ptp(co[idx], axis=0))) < 0.25 * size]
    in_body = np.ones(n, dtype=bool)
    for idx in small:
        in_body[idx] = False
    body = np.nonzero(in_body)[0]
    if not small or len(body) == 0:
        return 0, 0
    tree = kdtree.KDTree(len(body))
    for k, i in enumerate(body):
        tree.insert(co[i], k)
    tree.balance()
    groups = list(ob.vertex_groups)
    weights = np.zeros((n, len(groups)), np.float32)
    if bind and groups:
        for v in me.vertices:
            for g in v.groups:
                weights[v.index, g.group] = g.weight
    floating: list[int] = []
    removed = bound = 0
    for idx in small:
        nearest = [tree.find(co[i]) for i in idx]  # (position, index into body, distance)
        gap = min(d for _, _, d in nearest)
        if gap > 0.015 * size:
            floating.extend(idx)
            removed += 1
            continue
        if not (bind and groups):
            continue
        anchors = [body[k] for _, k, d in nearest if d <= gap * 1.5 + 1e-4]
        w = weights[anchors].mean(axis=0)
        w[np.argsort(-w)[4:]] = 0  # the engine's four bones per vertex
        if w.sum() <= 1e-8:
            continue
        w /= w.sum()
        for gi, group in enumerate(groups):
            group.remove(idx)
            if w[gi] > 1e-4:
                group.add(idx, float(w[gi]), "REPLACE")
        bound += 1
    if floating:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in floating], context="VERTS")
        bm.to_mesh(me)
        bm.free()
    return removed, bound


def unset_default_metallic(ob) -> None:
    """Hunyuan3D-Paint's export doesn't write metallicFactor, and glTF's default is 1: every generated model
    imports as rough bare metal (grey stone renders silver-white; the engine draws everything as dark metal).
    Metallic 1 with no metalness map is that default, not a choice: make it non-metal."""
    for m in ob.data.materials:
        bsdf = m and m.use_nodes and next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf and not bsdf.inputs["Metallic"].is_linked and bsdf.inputs["Metallic"].default_value >= 0.999:
            bsdf.inputs["Metallic"].default_value = 0.0


floaters_removed = loose_pieces_bound = 0
for ob in meshes:
    weld_and_smooth(ob)
    unset_default_metallic(ob)
    # Only right after automatic rigging; re-finalizing (e.g. after an agent's edits) must not smooth again.
    if p.get("smooth_weights") and any(m.type == "ARMATURE" for m in ob.modifiers):
        smooth_skin_weights(ob, int(p["smooth_weights"]))
    # Only for what a model made: an agent's own edit may have loose parts on purpose.
    if p.get("clean"):
        removed, bound = clean_loose_pieces(ob, bind=bool(p.get("smooth_weights")))
        floaters_removed += removed
        loose_pieces_bound += bound

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
    "floaters_removed": floaters_removed,
    "loose_pieces_bound": loose_pieces_bound,
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
