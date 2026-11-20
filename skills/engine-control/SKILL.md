---
name: engine-control
description: Inspecting and driving a running headless-game-engine game through its JSON control protocol (entities, components, input, screenshots, assertions). Use to verify gameplay, debug state, or test interactively.
---
# Driving a running game

The engine's full reference is `docs/control-protocol.md` in the engine (`engine/docs/` in a game project).

## Live session

```sh
./build.sh run -- --mode=hidden --control=7878 &       # in a game project
CTL=engine/tools/enginectl.py                          # tools/enginectl.py in the engine repo
$CTL info
$CTL entities component=Rigid_Body
$CTL entity entity=Player
$CTL set entity=Player component=Transform 'value={"position": [0, 5, 0]}'
$CTL action name=jump state=tap
$CTL step frames=60
$CTL screenshot path=build/now.png                     # then look at the image
$CTL quit
```

Pick a free port if 7878 is taken, and always `quit` (or kill) the game when you're done.

## Scripted tests

One JSON request per line in `tests/*.jsonl`, run with `./build.sh test tests/x.jsonl`. The exit code is 1 if any
command fails, including `assert`:

```json
{"cmd": "wait", "frames": 30}
{"cmd": "assert", "entity": "Player", "component": "Transform", "field": "position.y", "op": ">", "value": 0}
{"cmd": "screenshot", "path": "build/x.png"}
```

Use `--fixed-dt` (which `build.sh test` passes) so physics assertions are deterministic.

Sounds are logged even though tests run with audio off: `{"cmd": "assert", "sound": "chest-open", "frames": 5}` checks that
a sound whose path contains "chest-open" started in the last 5 frames (`"played": false` checks that none did), and
`sounds` lists every start (path, volume, position, and `missing` when the file doesn't exist).
