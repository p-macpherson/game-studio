# P3-SAM spike: render P3-SAM's parts in distinct colours (front and back).  blender -b -P viz.py -- seg_dir out.png
import colorsys, math, os, sys
import bpy, numpy as np
from mathutils import Vector

seg_dir, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(seg_dir, "mesh.glb"))
ob = next(o for o in bpy.context.scene.objects if o.type == "MESH")
ids = np.load(os.path.join(seg_dir, "face_ids.npy"))
parts = sorted(set(int(i) for i in ids))
colour = {p: (*colorsys.hsv_to_rgb((k * 0.618) % 1, 0.75, 0.95), 1.0) for k, p in enumerate(parts)}
colour[-1] = (0.2, 0.2, 0.2, 1)
attr = ob.data.color_attributes.new("part", "FLOAT_COLOR", "CORNER")
for poly in ob.data.polygons:
    for li in poly.loop_indices:
        attr.data[li].color = colour[int(ids[poly.index])]
mat = bpy.data.materials.new("parts")
mat.use_nodes = True
nodes = mat.node_tree.nodes
a = nodes.new("ShaderNodeVertexColor")
a.layer_name = "part"
mat.node_tree.links.new(a.outputs["Color"], next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"])
ob.data.materials.clear()
ob.data.materials.append(mat)

pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
lo = Vector([min(p[i] for p in pts) for i in range(3)])
hi = Vector([max(p[i] for p in pts) for i in range(3)])
c, r = (lo + hi) / 2, (hi - lo).length
scene = bpy.context.scene
w = bpy.data.worlds.new("w"); w.color = (0.6, 0.6, 0.6); scene.world = w
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 2; sun.rotation_euler = (0.7, 0.2, 0.4)
scene.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam); scene.camera = cam
scene.render.resolution_x, scene.render.resolution_y = 500, 600
frames = []
for i, azim in enumerate((20, 200)):
    z, e = math.radians(azim), math.radians(15)
    cam.location = c + Vector((math.sin(z) * math.cos(e), -math.cos(z) * math.cos(e), math.sin(e))) * r * 1.3
    cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = f"{out}.{i}.png"
    bpy.ops.render.render(write_still=True)
    frames.append(scene.render.filepath)
print("PARTS", len(parts), "frames", frames)
