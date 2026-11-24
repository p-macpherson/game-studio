---
name: odin-build
description: Building, type-checking and testing Odin code on headless-game-engine, in a game project or the engine repo. Use whenever you compile or test.
---
# Building with Odin

## In a game project

```sh
./build.sh check              # fast type-check
./build.sh                    # debug build into build/game
./build.sh test [script]      # headless scripted run (default tests/smoke.jsonl); exit code is the verdict
./build.sh run -- ARGS        # build and run, e.g. -- --mode=hidden --control=7878
```

The whole suite is every `tests/**/*.jsonl`. Use the project's own runner when it has one (its `AGENTS.md` or
`tools/` says so), else one script at a time:
`for t in tests/*.jsonl tests/*/*.jsonl; do ./build.sh test "$t" >/dev/null 2>&1 && echo "PASS $t" || echo "FAIL $t"; done`.

`ENGINE_DIR=/path/to/engine/checkout ./build.sh ...` builds against another engine checkout, such as an engine
session's worktree. The engine's native libraries (raylib, ENet, box3d) are built once by
`engine/third_party/deps.sh`. `build.sh` does this automatically if they're missing (about 15 s).

## In the engine repo

`./build.sh check | test | smoke | all`. See the engine's `CLAUDE.md`.

## Notes

- The engine is imported as `import "engine:engine"` (plus `engine:input` and `engine:ui`), with
  `-collection:engine=<engine>/engine`.
- Debug builds take about half a second, so build often.
- If there's no usable display, `--mode=hidden` needs `xvfb-run -a`. `--mode=none` runs logic without graphics.
