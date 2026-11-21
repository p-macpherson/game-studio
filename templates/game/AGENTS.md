# {{name}}

A game made in Game Studio, built on `headless-game-engine` (Odin + raylib). The engine is the `engine/` git
submodule. Read `engine/README.md`, `engine/docs/making-a-game.md` (game API) and
`engine/docs/control-protocol.md` (driving a running game) before writing game code.

## Layout

| Path | Contents |
|---|---|
| `docs/design/` | The design docs (markdown): the user's decisions about the game, each with a `status` (`not-established`, `draft`, `established`). The source of truth for what the game should be; changed only with the user, in a Game Designer session |
| `game/` | The game's Odin package |
| `assets/` | `models/` (glTF), `textures/`, `music/`, `sounds/`, `voices/` (characters' voice lines), `scenes/` and `prefabs/` (engine JSON) |
| `tests/` | Control-protocol scripts (`.jsonl`) run by `./build.sh test` |
| `engine/` | Engine submodule: **don't edit it here**. Engine changes are made in an engine session |
| `.studio/` | Game Studio metadata and session records: **don't edit** |

## Commands

```sh
./build.sh                    # build (debug)
./build.sh check              # type-check
./build.sh test               # headless scripted tests; their `screenshot` steps write the images to look at (see each tests/*.jsonl)
./build.sh run -- --mode=hidden --control=7878 &   # run a live game to inspect with engine/tools/enginectl.py
```

## Working in a session

You're working in a git worktree on your own branch. Commit your work there with clear messages. Game Studio
merges the branch when the user approves it, so never switch branches or touch `main`.
