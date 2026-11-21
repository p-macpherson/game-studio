"""Names a rigged biped's bones by role and adds procedural clips. Run headless:
    blender -b --python animate.py -- '<json params>'

params: {in, out, clips?: ["idle", "walk", "wave"]} (clips: [] names the bones and makes none: retarget.py adds the
animation library's). Clips the model already had are dropped: the result has exactly the ones asked for.
Reads the skeleton's shape (UniRig names bones bone_0..N):
- the root is the hips; chains from it going down are legs, the chain going up is the spine;
- where the spine branches, the two side branches are arms (left = glTF +X: characters face +Z) and the
  middle one leads to the neck and head.
Bones are renamed (hips, spine, spine.001, chest, neck, head, shoulder.L, upper_arm.L, forearm.L, hand.L,
finger.L, thigh.L, shin.L, foot.L, toe.L, ...; Blender renames the skin's vertex groups with them), then
looping clips are keyframed. A skeleton that isn't a biped (not two legs and two arms) is reported, not guessed.
Prints "RESULT: {json}" with the role of every bone and the clips made.
"""
import json
import math
import sys

import bpy
from mathutils import Quaternion, Vector

p = json.loads(sys.argv[sys.argv.index("--") + 1])
FPS = 24

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=p["in"])
scene = bpy.context.scene
scene.render.fps = FPS
for old in list(bpy.data.actions):
    bpy.data.actions.remove(old)  # animating again must not leave "idle" beside "idle.001"
arm = next((o for o in scene.objects if o.type == "ARMATURE"), None)
if arm is None:
    raise SystemExit("the model has no skeleton (rig it first)")
bones = arm.data.bones
head = {b.name: arm.matrix_world @ b.head_local for b in bones}
tail = {b.name: arm.matrix_world @ b.tail_local for b in bones}
lowest = min(v.z for v in head.values())
highest = max(v.z for v in tail.values())
height = max(highest - lowest, 1e-3)


def chain(start: str) -> list[str]:
    """Follows single children from `start` until a branch or a leaf."""
    out = [start]
    b = bones[start]
    while len(b.children) == 1:
        b = b.children[0]
        out.append(b.name)
    return out


def leaf_end(name: str) -> Vector:
    """Where a subtree ends: the tail of its furthest-down-the-chain bone."""
    return tail[chain(name)[-1]]


roots = [b.name for b in bones if b.parent is None]
root = max(roots, key=lambda n: len(bones[n].children_recursive))
# The hips are where the legs and spine branch; bones above that (a lone root bone) are "root".
above_hips = chain(root)
hips = above_hips[-1]
roles: dict[str, str] = {n: ("root" if i == 0 else f"root.{i:03d}") for i, n in enumerate(above_hips[:-1])}
roles[hips] = "hips"
legs, spine_starts = [], []
for child in bones[hips].children:
    (legs if leaf_end(child.name).z < head[hips].z - 0.1 * height else spine_starts).append(child.name)

problems = []
if len(legs) != 2:
    problems.append(f"{len(legs)} legs from the hips (expected 2)")
if len(spine_starts) != 1:
    problems.append(f"{len(spine_starts)} spine chains from the hips (expected 1)")

arms: list[str] = []
neck_start = None
if not problems:
    spine = chain(spine_starts[0])
    branch = bones[spine[-1]]
    kids = sorted(branch.children, key=lambda c: head[c.name].x)
    if len(kids) < 3:
        problems.append(f"the spine branches into {len(kids)} (expected arms and a neck)")
    else:
        # Outermost on each side are the arms; the most central of the rest is the neck/head.
        arms = [kids[0].name, kids[-1].name]
        neck_start = min(kids[1:-1], key=lambda c: abs(head[c.name].x)).name
        for i, n in enumerate(spine[:-1]):
            roles[n] = "spine" if i == 0 else f"spine.{i:03d}"
        roles[spine[-1]] = "chest"
        neck = chain(neck_start)
        if len(neck) == 1:
            roles[neck[0]] = "head"
        else:
            for i, n in enumerate(neck[:-1]):
                roles[n] = "neck" if i == 0 else f"neck.{i:03d}"
            roles[neck[-1]] = "head"

ARM = ["shoulder", "upper_arm", "forearm", "hand"]
LEG = ["thigh", "shin", "foot", "toe"]


def name_limb(start: str, parts: list[str]) -> list[str]:
    side = "L" if head[start].x > head[hips].x else "R"
    names = chain(start)
    for i, n in enumerate(names):
        role = parts[i] if i < len(parts) else f"{'finger' if parts is ARM else 'toe'}.{i - len(parts) + 1:03d}"
        roles[n] = f"{role}.{side}"
    return names


limbs = {}
if not problems:
    # Short arm chains (3 bones) have no shoulder.
    for a in arms:
        names = name_limb(a, ARM if len(chain(a)) >= 4 else ARM[1:])
        limbs[roles[names[0]].split(".")[-1] + "_arm"] = names
    for leg in legs:
        name_limb(leg, LEG)

if problems:
    print("RESULT: " + json.dumps({"biped": False, "problems": problems, "bones": len(bones), "clips": []}))
    raise SystemExit(0)

for old, new in roles.items():
    bones[old].name = new  # also renames the mesh's vertex group of the same name
pose = arm.pose.bones
world_axes = arm.matrix_world.inverted().to_3x3()

# World axes in Blender (Z up; the character faces -Y, its left is +X).
LATERAL, FORWARD, UP = Vector((1, 0, 0)), Vector((0, -1, 0)), Vector((0, 0, 1))


def rotation(bone: str, world_axis: Vector, degrees: float) -> Quaternion:
    """A rotation of `bone` about a world axis, expressed in the bone's local space."""
    local = (bones[bone].matrix_local.inverted().to_3x3() @ world_axes @ world_axis).normalized()
    return Quaternion(local, math.radians(degrees))


def side(part: str, s: str) -> str | None:
    n = f"{part}.{s}"
    return n if n in pose else None


def keyframes(action_name: str, frames: int, at) -> None:
    """Keys one looping clip: at(t in [0,1)) -> {bone: Quaternion} (and "hips_offset": Vector)."""
    action = bpy.data.actions.new(action_name)
    action.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = action
    for pb in pose:
        pb.rotation_mode = "QUATERNION"
    steps = 8
    for k in range(steps + 1):
        frame = 1 + round(k * frames / steps)
        values = at(k / steps)
        for pb in pose:
            pb.rotation_quaternion = values.get(pb.name, Quaternion())
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        pose["hips"].location = values.get("hips_offset", Vector())
        pose["hips"].keyframe_insert("location", frame=frame)
    arm.animation_data.action = None


def idle(t: float):
    breath = math.sin(2 * math.pi * t)
    out = {"chest": rotation("chest", LATERAL, 2.0 * breath)}
    if "head" in pose:
        out["head"] = rotation("head", LATERAL, -1.5 * breath)
    for s, sign in (("L", 1), ("R", -1)):
        if (b := side("upper_arm", s)):
            out[b] = rotation(b, FORWARD, sign * 2.0 * breath)
    out["hips_offset"] = world_axes @ UP * (0.004 * height * breath)
    return out


def walk(t: float):
    swing = math.sin(2 * math.pi * t)
    out = {}
    for s, sign in (("L", 1), ("R", -1)):
        if (b := side("thigh", s)):
            out[b] = rotation(b, LATERAL, sign * 25 * swing)
        if (b := side("shin", s)):
            # Knees bend while the leg swings back and passes under the body.
            out[b] = rotation(b, LATERAL, -20 * max(0.0, -sign * swing) - 8)
        if (b := side("upper_arm", s)):
            out[b] = rotation(b, LATERAL, -sign * 20 * swing)
    out["chest"] = rotation("chest", UP, 4 * swing)
    out["hips_offset"] = world_axes @ UP * (0.015 * height * abs(math.cos(2 * math.pi * t)))
    return out


def wave(t: float):
    out = {}
    # The right arm out to the side, forearm up and swinging. Raising the whole arm overhead stretches
    # generated skins badly (tried 120 degrees on the goblin: its satchel strap smeared into a sheet).
    if (b := side("upper_arm", "R")):
        out[b] = rotation(b, FORWARD, -70)
    if (b := side("forearm", "R")):
        out[b] = rotation(b, FORWARD, -50 + 25 * math.sin(4 * math.pi * t))
    return out


CLIPS = {"idle": (2 * FPS, idle), "walk": (FPS, walk), "wave": (2 * FPS, wave)}
made = []
for clip in list(CLIPS) if p.get("clips") is None else p["clips"]:
    if clip not in CLIPS:
        raise SystemExit(f"unknown clip {clip!r} (available: {', '.join(CLIPS)})")
    frames, fn = CLIPS[clip]
    keyframes(clip, frames, fn)
    made.append(clip)

bpy.ops.export_scene.gltf(filepath=p["out"], export_format="GLB", export_skins=True, export_animations=True, export_animation_mode="ACTIONS")
print("RESULT: " + json.dumps({"biped": True, "bones": len(bones), "roles": {v: k for k, v in roles.items()}, "clips": made}))
