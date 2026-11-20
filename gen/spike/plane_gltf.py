"""M9a spike: a 6 m textured plane (.gltf) using <name>.png and <name>_normal.png beside it, tiled every 2 m, so the
engine can light the derived normal map (Material can't take one until M9b). Usage: plane_gltf.py <dir> <name>..."""
import base64
import json
import struct
import sys

SIZE, TILE = 6.0, 2.0


def plane(d: str, name: str) -> None:
    h, r = SIZE / 2, SIZE / TILE
    pos = [(-h, 0, -h), (h, 0, -h), (h, 0, h), (-h, 0, h)]
    uv = [(0, 0), (r, 0), (r, r), (0, r)]
    blob = b"".join(struct.pack("<3f", *p) for p in pos)
    blob += b"".join(struct.pack("<3f", 0, 1, 0) for _ in pos)
    blob += b"".join(struct.pack("<4f", 1, 0, 0, 1) for _ in pos)
    blob += b"".join(struct.pack("<2f", *t) for t in uv)
    blob += struct.pack("<6H", 0, 2, 1, 0, 3, 2)
    views = [(0, 48), (48, 48), (96, 64), (160, 32), (192, 12)]
    g = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TANGENT": 2, "TEXCOORD_0": 3}, "indices": 4, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.9}, "normalTexture": {"index": 1}}],
        "textures": [{"source": 0, "sampler": 0}, {"source": 1, "sampler": 0}],
        "samplers": [{"wrapS": 10497, "wrapT": 10497}],
        "images": [{"uri": f"{name}.png"}, {"uri": f"{name}_normal.png"}],
        "buffers": [{"byteLength": len(blob), "uri": "data:application/octet-stream;base64," + base64.b64encode(blob).decode()}],
        "bufferViews": [{"buffer": 0, "byteOffset": o, "byteLength": n} for o, n in views],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-h, 0, -h], "max": [h, 0, h]},
            {"bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC4"},
            {"bufferView": 3, "componentType": 5126, "count": 4, "type": "VEC2"},
            {"bufferView": 4, "componentType": 5123, "count": 6, "type": "SCALAR"},
        ],
    }
    json.dump(g, open(f"{d}/{name}-plane.gltf", "w"))


if __name__ == "__main__":
    for n in sys.argv[2:]:
        plane(sys.argv[1], n)
