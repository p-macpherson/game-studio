---
name: scenarios
description: Play scenarios, the studio's named ways to start the game for playing or testing something (a sandbox for one mechanic, a level in a chosen environment, a late-game state), with parameters the user sets. Read it when the user asks for a way to try or test something, when you finish a feature that's slow to reach from the game's start, or when you change what a scenario depends on.
---
# Play scenarios

A scenario is a file, `scenarios/<name>.json`, that says how to start the game other than from its start. The user
picks it in **Play & Test** ("Start as") or the **Scenarios** section, sets its parameters, and plays. Scenarios are
yours to create and keep working: the user doesn't write them.

## When to make one
- The user asks for a sandbox, a test level, or a quick way to try something.
- You built or changed something a player takes more than a few seconds to reach: make (or update) a scenario that
  starts there, and say so in your report. Give it as `start_here` in `request_review`, so the user's review has a
  **Play from here** button.
- Something worth trying in several conditions (an environment, a difficulty, a seed): one scenario with parameters,
  not a file per combination.

Prefer extending a scenario that already covers the area to adding a near-copy. List `scenarios/` first.

## The file
```json
{
  "title": "Rope sandbox",
  "description": "A tall shaft with ledges at three heights, for trying the rope.",
  "notes": "Throw from the middle ledge. The rope should hold on the anchor and swing freely.",
  "scene": "scenes/sandbox_{environment}.json",
  "flags": { "biome": "{environment}", "seed": "{seed}", "no-enemies": true },
  "setup": [
    { "cmd": "console", "line": "play" },
    { "cmd": "console", "line": "goto {start}" },
    { "cmd": "wait", "frames": 10 }
  ],
  "params": [
    { "id": "environment", "label": "Environment", "type": "choice", "options": ["forest", "desert"], "default": "forest" },
    { "id": "seed", "label": "Terrain seed", "type": "number", "default": 1, "min": 0, "max": 99999, "random": true },
    { "id": "start", "label": "Start at", "type": "choice", "options": ["Bottom", "Middle_Ledge", "Top"] },
    { "id": "ropes", "label": "Unlimited ropes", "type": "toggle", "default": true }
  ]
}
```

All of `scene`, `flags` and `setup` are optional; use the lightest that does the job.

- **`scene`**: a scene to open instead of the game's own, as the engine's `--scene` takes it (relative to `assets/`).
  Good for a sandbox level built for the purpose (keep such scenes under `assets/scenes/sandbox/`; a release ships
  only what the game reaches, so they stay out of builds).
- **`flags`**: launch flags, `--name=value`. A flag set to `true` is passed bare (`--no-enemies`); `false` or empty
  text leaves it out. **The game must read them**: `engine.arg("biome")` returns `(value, ok)`. A flag nothing reads
  does nothing, so add the reading code in the same change. `--seed` is the engine's own (it seeds `rand`). Don't set
  the studio's flags (`mode`, `control`, `script`, `fps`, `host`, `join`...).
- **`setup`**: control commands sent in order once the game is running, exactly as in a test script: `console` lines
  for the game's own commands, `wait`, the engine's commands. No `quit`: the user plays on from there. When the game
  lacks a command you need (start a wave, grant an item, jump to a marker), add it with `engine.register_command`;
  such commands help tests too.
- **`params`**: what the user can set. `{id}` anywhere in `scene`, `flags` or `setup` is replaced by the value; a
  value that is only `"{id}"` keeps its type (a number stays a number). Types: `choice` (`options`), `number`
  (`min`, `max`, `step`; `random: true` adds a roll button, for seeds), `toggle`, `text`. Give each a `label` and
  a sensible `default`; add `help` when the label can't say it.
- **`title`**, **`description`** (what it is, one or two sentences), **`notes`** (what to try and what should
  happen): the user reads these, so write them for someone who hasn't seen the code.

Names: `scenarios/<name>.json`, folders allowed (`scenarios/sandbox/rope.json`).

## Check it
Call `check_scenario` with the path (and `values` to try a combination). It reports problems with the file and, when
there are none, exactly what the launch comes to: the game's arguments and the commands sent. Then prove it works:
run the same launch yourself (the arguments from the check plus a control script with the setup commands and an
assert or a screenshot) or film it with `capture_clip`. A scenario that fails on start is worse than none.

Keep scenarios working: when you rename a marker, a command, a scene or a flag that a scenario uses, update the
scenario in the same change (search `scenarios/`).
