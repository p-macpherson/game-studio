
import sys, json, subprocess
sys.path.insert(0, sys.argv[1] + "/tools")
from enginectl import Engine
out = sys.argv[2]
p = subprocess.Popen([out + "/game", "--mode=hidden", "--paused", "--control=7912"], cwd=sys.argv[3], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
try:
    e = Engine(7912)
    comps = e.call("components")
    print(json.dumps([x for x in comps if x["name"] in ("Transform", "Light", "Rigid_Body", "Chest")]))
    e.call("step", frames=1)
    e.call("camera", position=[0,14,-16], target=[0,0,2], fov=50)
    print(json.dumps(e.call("raycast", origin=[0,14,-16], direction=[0.0496,-0.574,0.817])))
    e.call("screenshot", path=out + "/4-after-step.png")
finally:
    p.kill()
