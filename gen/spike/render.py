"""Blender (headless) turntable stills of a model: blender -b --python render.py -- IN.glb OUT_PREFIX [--clay]

Normalises the model to fit a unit box at the origin, then renders front, 3/4, side and back views
(the Workbench engine: fast, no GPU memory to speak of). --clay ignores the model's materials.
"""
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
src, prefix, clay = argv[0], argv[1], "--clay" in argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]

# Fit into a unit box centred at the origin.
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
scale = 1 / max(hi - lo)
centre = (lo + hi) / 2
for o in meshes:
    if o.parent is None:
        o.location = (o.location - centre) * scale
        o.scale = o.scale * scale

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "SINGLE" if clay else "TEXTURE"
scene.display.shading.single_color = (0.75, 0.75, 0.78)
scene.display.shading.show_cavity = True
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("w")
scene.world.color = (0.12, 0.13, 0.15)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.type = "ORTHO"
cam.data.ortho_scale = 1.25

# glTF imports with +Y forward becoming -Y in Blender; "front" looks at the model's front.
for name, yaw in (("front", 0), ("three_quarter", 35), ("side", 90), ("back", 180)):
    a = math.radians(yaw)
    cam.location = (3 * math.sin(a), -3 * math.cos(a), 0.4)
    direction = Vector((0, 0, 0)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = f"{prefix}_{name}.png"
    bpy.ops.render.render(write_still=True)
