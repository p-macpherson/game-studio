"""Builds textured.glb: the fake worker's texture output. A cube with a material like Hunyuan3D-Paint's export,
which has no metallicFactor (so glTF's default, metallic 1, applies).

    blender -b --python gen/workers/fixtures/make_textured.py
"""
import os

import bpy

here = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(here, "cube.glb"))
ob = next(o for o in bpy.context.scene.objects if o.type == "MESH")
material = bpy.data.materials.new("Material_0")
material.use_nodes = True
bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (0.3, 0.3, 0.3, 1)
bsdf.inputs["Metallic"].default_value = 1.0  # the exporter leaves the default out
bsdf.inputs["Roughness"].default_value = 0.9
ob.data.materials.clear()
ob.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=os.path.join(here, "textured.glb"), export_format="GLB")
