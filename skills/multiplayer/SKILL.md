---
name: multiplayer
description: Making and testing multiplayer in a headless-game-engine game. The engine's client-hosted model (one player hosts, the others join), who owns and simulates what, and how to test it with several copies of the game on one machine. Use whenever a task involves more than one player over the network.
---
# Multiplayer

The engine's multiplayer is **client-hosted**: one player's game hosts, the others join it, and every copy runs the
whole game. The API and its rules are in "Multiplayer (client-hosted)" in `engine/docs/making-a-game.md`: read it
before writing netcode. The short version:

- `engine.net_host` / `engine.net_join`, or the flags `--host[=PORT]` and `--join=ADDR[:PORT]` (`--name=Alice`).
  Over the internet players join with an invite code instead: see below.
- React to `engine.net_events()`: `.Hosting` (spawn the host's avatar), `.Player_Joined` (the host spawns that
  player's avatar with `engine.net_spawn(prefab, pos, owner = ev.player)`), `.Player_Left`, `.Message`.
- **Ownership.** An entity with `Net_Entity` is simulated by its owner and copied to everyone else. Run a player's
  input and movement only when `engine.net_is_mine(e)`; mark the components that must travel `.Replicate`.
- **Authority.** What nobody owns (pickups, enemies, the score, win and lose) is the host's: run it only when
  `!engine.net_is_client()`, then tell everyone with `engine.net_send(msg)` (plain-data structs).
- Spawning is the host's (`net_spawn`); late joiners get what exists. A scene's own networked entities are on
  every copy already.

A single-player game keeps working unchanged: offline, everything is "mine" and nobody is a client.

## Decide who is right
For each piece of state, write down who decides it (its owner, or the host) before coding. The usual bugs are a
client deciding something only the host should (two players both "win"), or logic running on every copy (a coin
scored once per player).

## Playing over the internet
Read "Playing over the internet" in `engine/docs/making-a-game.md` (if it isn't there, this project's engine is
too old: tell the user to press Update engine). The short version:

- Host with `engine.net_host(0, name, online = true)`: the engine asks the host's router to open the port, in the
  background. Without `online`, only players on the host's own network can join.
- Show the host `engine.net_invite()` every frame: `.Opening` (a few seconds), `.Online` (show `code`: it works
  from anywhere), `.Failed` (show `reason`; the code still works on the host's network). The code changes when it
  goes online, so don't cache it.
- Players join by typing the code: `engine.net_join_code(code, name)`. One text field can take a code or an
  address: `engine.net_is_code(text)` tells them apart.
- Design the menu for failure: some routers refuse and some internet connections can't be opened at all. Say
  what `reason` says and suggest the other player hosts.
- You can't open a real router from a test. `--host --online --router=127.0.0.1:PORT` points the game at a
  stand-in (the engine's `tests/multiplayer_test.py` has one, `fake_router`); the `net` command then shows
  `invite` with its state and code. Whether it works through the user's real router is theirs to try, with a
  friend on another network.

## Limits to design within
No list of games to pick from (players pass the invite code around themselves), no relay server (a host whose
router or internet provider won't open a port can't host online), no host migration (the game ends when the host
leaves), no client-side prediction (a player's own avatar is instant because they own it; things the host owns
arrive about a tenth of a second late), and web builds can't join or host. Say so when a design needs one of these.

## Testing it
Always test with at least two copies; a multiplayer feature that only ran offline hasn't been tested.

**Scripted** (what you run): `tests/<name>.mp.jsonl`, with `./build.sh test tests/<name>.mp.jsonl` (it calls
`engine/tools/mptest.py build/game <script>`; if this project's build.sh doesn't know `*.mp.jsonl`, call the tool
yourself or teach build.sh). The tool starts the host and the other players, waits until all see each other, and
sends each line to the player it names. The format is the control protocol plus `"player"`:

```
// players: 2
{"player": "all", "cmd": "wait_until", "entity": {"player": 2, "name": "Player"}, "exists": true}
{"player": 2, "cmd": "action", "name": "move_y", "state": "hold"}
{"player": 2, "cmd": "wait", "frames": 60}
{"player": 2, "cmd": "action", "name": "move_y", "state": "release"}
{"player": 1, "cmd": "wait_until", "entity": {"player": 2, "name": "Player"}, "component": "Transform", "field": "position.z", "op": ">", "value": 2}
{"player": 2, "cmd": "quit"}
{"player": 1, "cmd": "wait_until", "entity": {"player": 2, "name": "Player"}, "exists": false}
```

- Player 1 is the host (the default), 2 the first to join; `"all"` is every copy still running.
- `{"player": N, "name": "..."}` as an entity is the networked entity that player owns: avatars share a name, so a
  bare name finds the wrong one.
- What one copy does reaches the others a moment later. Check it on the other copy with `wait_until`; an `assert`
  there races the network. Use `assert` only for what must already be true on that same copy.
- Test both directions (host to client and client to host), a host-decided outcome seen by everyone, and a player
  leaving. The copies run without a picture; add `--mode=hidden` to the tool for `screenshot` lines.
- An example that passes: `engine/examples/demo/tests/multiplayer.mp.jsonl`.

**By hand** (what the user does): Play & Test has a **Players** selector. With 2 to 4, Run starts that many copies
side by side, the first hosting; the user clicks a view to play that player. Tell them to try it there when a
change needs a person's eyes.

**Live, yourself**: two games with their own control ports, each driven with `engine/tools/enginectl.py --port`:
`timeout 30m build/game --mode=hidden --fps=60 --host=7790 --control=7891 &` and `timeout 30m build/game --mode=hidden --fps=60 --join=127.0.0.1:7790 --control=7892 &`.
The `net` command shows the role, the local peer id and the players. Quit both when done.
