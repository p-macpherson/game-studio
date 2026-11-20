# P3-SAM spike: segment a mesh into parts; save the (cleaned) mesh, per-face part ids, time and peak VRAM.
#   SONATA_CKPT=... env/bin/python run.py in.glb out_dir [post_process]
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src/P3-SAM/demo"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src/P3-SAM"))
import numpy as np, torch, trimesh
from auto_mask import AutoMask, set_seed

src, out = sys.argv[1], sys.argv[2]
post = int(sys.argv[3]) if len(sys.argv) > 3 else 1
os.makedirs(out, exist_ok=True)
t0 = time.time()
am = AutoMask(os.path.expanduser("~/.local/share/game-studio/gen/models/tencent/Hunyuan3D-Part/p3sam/p3sam.safetensors"))
t_load = time.time() - t0
mesh = trimesh.load(src, force="mesh")
set_seed(42)
t1 = time.time()
aabb, face_ids, mesh = am.predict_aabb(mesh, save_path=out, point_num=100000, prompt_num=400, threshold=0.95, post_process=post, prompt_bs=int(os.environ.get("PROMPT_BS", "4")),
                                       save_mid_res=0, show_info=0, seed=42, is_parallel=0, clean_mesh_flag=1)
t_seg = time.time() - t1
mesh.export(os.path.join(out, "mesh.glb"))
np.save(os.path.join(out, "face_ids.npy"), np.asarray(face_ids))
ids, counts = np.unique(np.asarray(face_ids), return_counts=True)
info = {"load_s": round(t_load, 1), "segment_s": round(t_seg, 1), "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2),
        "faces": len(mesh.faces), "parts": int((ids >= 0).sum()), "unlabelled_faces": int(counts[ids < 0].sum()) if (ids < 0).any() else 0}
json.dump(info, open(os.path.join(out, "info.json"), "w"))
print("INFO", json.dumps(info))
