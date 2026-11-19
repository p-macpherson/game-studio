"""Prints the skinning-relevant structure of glTF files: nodes, skins, joint attributes and their formats."""
import sys

import numpy as np
import pygltflib

COMPONENT = {5120: "i8", 5121: "u8", 5122: "i16", 5123: "u16", 5125: "u32", 5126: "f32"}


def accessor_array(g: pygltflib.GLTF2, index: int) -> np.ndarray:
    acc = g.accessors[index]
    view = g.bufferViews[acc.bufferView]
    data = g.binary_blob()
    dtype = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[acc.componentType]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc.type]
    start = (view.byteOffset or 0) + (acc.byteOffset or 0)
    stride = view.byteStride or n * np.dtype(dtype).itemsize
    raw = np.frombuffer(data, dtype=np.uint8, count=stride * acc.count, offset=start).reshape(acc.count, stride)
    return raw[:, : n * np.dtype(dtype).itemsize].copy().view(dtype).reshape(acc.count, n)


for path in sys.argv[1:]:
    g = pygltflib.GLTF2().load(path)
    print(f"== {path}")
    print(f"  scenes[0].nodes = {g.scenes[g.scene or 0].nodes}")
    for i, n in enumerate(g.nodes):
        extra = []
        if n.mesh is not None:
            extra.append(f"mesh={n.mesh}")
        if n.skin is not None:
            extra.append(f"skin={n.skin}")
        if n.translation and any(abs(v) > 1e-6 for v in n.translation):
            extra.append(f"t={[round(v, 3) for v in n.translation]}")
        if n.rotation and any(abs(v - d) > 1e-6 for v, d in zip(n.rotation, (0, 0, 0, 1))):
            extra.append(f"r={[round(v, 3) for v in n.rotation]}")
        if n.scale and any(abs(v - 1) > 1e-6 for v in n.scale):
            extra.append(f"s={[round(v, 3) for v in n.scale]}")
        if n.matrix:
            extra.append("matrix")
        if i < 8 or n.mesh is not None or n.skin is not None:
            print(f"  node {i} {n.name!r} children={n.children[:6]}{'…' if len(n.children) > 6 else ''} {' '.join(extra)}")
    for s in g.skins:
        print(f"  skin: joints={len(s.joints)} first={s.joints[:5]} skeleton={s.skeleton} inverseBindMatrices={s.inverseBindMatrices}")
    for m in g.meshes:
        for p in m.primitives:
            a = p.attributes
            j = g.accessors[a.JOINTS_0] if a.JOINTS_0 is not None else None
            w = g.accessors[a.WEIGHTS_0] if a.WEIGHTS_0 is not None else None
            print(f"  primitive: vertices={g.accessors[a.POSITION].count} indices={COMPONENT[g.accessors[p.indices].componentType]}"
                  f" JOINTS_0={COMPONENT[j.componentType] if j else None} WEIGHTS_0={COMPONENT[w.componentType] if w else None}"
                  f" normalized={w.normalized if w else None}")
            if w is not None:
                weights = accessor_array(g, a.WEIGHTS_0).astype(np.float64)
                if w.componentType != 5126:
                    weights /= np.iinfo(weights.dtype if weights.dtype != np.float64 else np.uint8).max
                sums = weights.sum(axis=1)
                print(f"    weight sums: min {sums.min():.3f} max {sums.max():.3f}; joints max index {accessor_array(g, a.JOINTS_0).max()}")
