
import sys, json, time, math, base64, subprocess, os
sys.path.insert(0, sys.argv[1] + "/tools")
from enginectl import Engine, EngineError
out = sys.argv[2]
port = 7911
proc = subprocess.Popen([out + "/game", "--mode=hidden", "--paused", "--control=%d" % port], cwd=sys.argv[3], stdout=open(out + "/game.log", "w"), stderr=subprocess.STDOUT)
R = {}
try:
    e = Engine(port)
    c = e.call
    R["info"] = c("info")
    comps = c("components")
    R["components_bytes"] = len(json.dumps(comps))
    R["components_names"] = [x.get("name") for x in comps] if isinstance(comps, list) else list(comps)[:40]
    R["components_sample"] = json.dumps(comps[0] if isinstance(comps, list) else comps.get("Transform"))[:1500]
    R["entities"] = c("entities")
    W, H = R["info"]["width"], R["info"]["height"]
    cam_pos, cam_tgt, fov = [0, 14, -16], [0, 0, 2], 50
    t0 = time.time(); c("camera", position=cam_pos, target=cam_tgt, fov=fov)
    c("screenshot", path=out + "/1-overview.png")
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def norm(v): l = math.sqrt(sum(x*x for x in v)); return [x/l for x in v]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    fwd = norm(sub(cam_tgt, cam_pos)); right = norm(cross(fwd, [0,1,0])); up = cross(right, fwd)
    th = math.tan(math.radians(fov)/2); asp = W/H
    def project(p):
        d = sub(p, cam_pos); z = dot(d, fwd)
        x = dot(d, right)/(z*th*asp); y = dot(d, up)/(z*th)
        return ((x+1)/2*W, (1-y)/2*H)
    def ray(px, py):
        x = (2*px/W - 1)*th*asp; y = (1 - 2*py/H)*th
        return norm([fwd[i] + right[i]*x + up[i]*y for i in range(3)])
    picks = {}
    for name, p in [("Chest 1", [4,0.4,6]), ("Goblin", [0,0.6,0]), ("Barrel@-6,-5", [-6,0.5,-5]), ("Rock@7,-9", [7,0.4,-9]), ("ground", [2,0,2])]:
        px, py_ = project(p)
        h = c("raycast", origin=cam_pos, direction=ray(px, py_))
        picks[name] = {"pixel": [round(px), round(py_)], "hit": h}
    R["picks"] = picks
    # move Chest 1 while paused, then raycast its new spot
    chest = [x for x in R["entities"] if x["name"] == "Chest 1"][0]["id"]
    t = time.time(); c("set", entity=chest, component="Transform", value={"position": [0, 0, 5]})
    f = c("screenshot", inline=True, format="jpeg", quality=80); R["set_to_frame_ms"] = round((time.time()-t)*1000, 1)
    open(out + "/2-moved.jpg", "wb").write(base64.b64decode(f["jpeg_base64"]))
    px, py_ = project([0, 0.4, 5]); R["pick_after_move"] = c("raycast", origin=cam_pos, direction=ray(px, py_))
    px, py_ = project([4, 0.4, 6]); R["pick_old_spot"] = c("raycast", origin=cam_pos, direction=ray(px, py_))
    # spawn a barrel prefab
    sp = c("spawn", prefab="prefabs/barrel.json", position=[-2, 0, 4]); R["spawn"] = sp
    px, py_ = project([-2, 0.5, 4]); R["pick_spawned"] = c("raycast", origin=cam_pos, direction=ray(px, py_))
    R["spawned_entity"] = c("entity", entity=sp["id"])
    R["goblin_entity"] = c("entity", entity="Goblin")
    R["goblin_model"] = c("entity", entity="Goblin Model")
    c("screenshot", path=out + "/3-spawned.png")
    # stream timing: 30 inline frames, 4 in flight is the runner's way; here sequential
    t = time.time()
    for i in range(10): c("screenshot", inline=True, format="jpeg", quality=80)
    R["seq_frame_ms"] = round((time.time()-t)*100, 1)
    R["info_after"] = c("info")
    R["logs"] = [l["text"] for l in c("logs", limit=50)]
finally:
    proc.kill()
print(json.dumps(R, indent=1))
