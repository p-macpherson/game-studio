# game-studio

Game Studio: an agent-driven game development IDE. Electron + TypeScript + React. Agent sessions are hosted by the
Pi Coding Agent SDK (`@earendil-works/pi-coding-agent`). Games are built on `../headless-game-engine` (Odin).

Planning and design live in Pat's Obsidian vault: `~/obsidian_vault/Pat/Projects/Game Studio/`. Read
`Project Summary.md` and the `System Components/` notes before changing architecture. Update them when a decision
changes, and tick off `Initiatives/` checkboxes as work lands.

## Commands

```sh
npm run dev          # run with hot reload
npm run build        # build into out/
npm run typecheck    # tsc
npm test             # vitest: git/worktree/session lifecycle and project creation, against temp repos
npm run e2e          # build, then drive the app with Playwright through project creation and a full session
                     # lifecycle on the faux model; screenshots in out/e2e/ (look at them after UI changes)
npm run test:gpu     # the real generation models end to end on the GPU (a few minutes; needs gen/setup.sh done)
bash gen/setup.sh    # install/repair local generation: model repos, ~45 GB of weights, Python envs (idempotent)
node spike/pi-spike.ts <scratch-dir>   # the M0 Pi SDK spike (faux provider, no credentials needed)
```

`GAME_STUDIO_FAUX=1` registers the scripted `faux/echo` model. It appends each message to `faux-notes.md` and
commits, so you can exercise sessions with no credentials. A message `tool <name> <json args>` makes it call
that tool and reply with the result. `GAME_STUDIO_GEN_FAKE=1` swaps every generation worker for
`gen/workers/fake_worker.py` (fixture outputs, no GPU); `GAME_STUDIO_GEN` moves the generation root.

Install dependencies with `npm install --ignore-scripts` (Pi's recommendation). After adding or upgrading
`electron`, fetch its binary with `node node_modules/electron/install.js`. Pin exact versions.

## Architecture

- `src/main/`: main process services. `src/session-host/`: an Electron `utilityProcess` that owns every live
  Pi session (Electron 45 bundles Node 24, which meets Pi's ≥ 22.19). `src/preload/`: the `window.studio` bridge.
  `src/renderer/`: React UI. `src/shared/`: IPC contract and domain types shared by all of them.
- Pi credentials and model config live in `<userData>/pi/` (`auth.json`, `models.json`) and never touch a global
  Pi install. `GAME_STUDIO_USER_DATA` overrides userData, so a second instance (tests, studio-engineer
  sessions) can run alongside.
- Every session works in its own git worktree, and its record and Pi transcript are committed in the target
  repo's `.studio/sessions/<id>/`. See the vault note `Sessions & Worktrees.md`.
- Every Pi session has the `codemode` tool (scripts that call the other tools, studio tools included). The SDK
  doesn't load the CLI's built-in extensions, so `host-core.ts` adds `createCodemodeExtension()` and activates
  it with `defaultTools: ["+codemode"]`. "Open in terminal" passes `--tools +codemode` to the CLI.

## Where things are

| Path | What |
|---|---|
| `src/shared/{types,ipc,host}.ts` | Domain types, the renderer↔main API (`StudioApi`, `StudioEvent`), and the main↔session host protocol |
| `src/main/sessions.ts` | Session orchestrator: records, worktrees, lifecycle (merge/discard/mark done/resume), host events |
| `src/session-host/host-core.ts` | Pi sessions, accounts and models; `studio-tools.ts` holds the agent's tools for talking to the studio |
| `src/main/project.ts` + `templates/game/` | New-project scaffold (engine added as the `engine/` submodule) |
| `agent-types/<id>/AGENT.md`, `skills/<name>/SKILL.md` | Built-in agent types (frontmatter + prompt) and Pi skills |
| `src/modules/<id>/` | Studio modules (one section per part of the game): `info.ts` (the `ModuleInfo` contract from `src/shared/modules.ts`, plus summaries) and `view.tsx`. Register a new module in `MODULES` (`src/main/assets.ts`) and `MODULE_VIEWS` (`src/renderer/modules.tsx`) |
| `src/main/assets.ts` | Asset discovery for modules: main checkout + **drafts** (files changed in active sessions' worktrees), reads, search |
| `src/renderer/views/AssetBrowser.tsx` | The shared module section (searchable list, drafts version bar, actions, linked sessions); a module supplies its content view |
| `src/main/runner.ts` + `engine-client.ts` | Play & Test: build/run/test through the project's `build.sh` from main or a session worktree; the engine control-protocol client; frame streaming. Pure parsers (Odin diagnostics, script replies) in `src/shared/run.ts` |
| `src/renderer/views/Play.tsx` | Play & Test view: live view with input injection, inspector, console, tests |
| `src/main/gen.ts` | Generation service: job queue over Python model workers, one GPU worker at a time (warm per family, stopped when idle), Blender finalize jobs, setup/status |
| `gen/workers/` | Model workers speaking JSON lines (`protocol.py`): `image_worker.py` (FLUX.2 Klein), `hunyuan_worker.py` (shape, texture), `unirig_worker.py` (rig), `fake_worker.py` (tests) |
| `gen/blender/finalize.py` | Makes a model engine-ready: weld (only same-weight copies), non-metal by default, ≤65,535 vertices per primitive, scale/origin (measured in the rest pose), light skin-weight smoothing right after auto-rigging, export, thumbnail, stats |
| `gen/blender/animate.py`, `gen/blender/rig_prop.py` | Biped analysis (bone roles, `idle`/`walk`/`wave` clips) and hinge rigs for props (cut, cap, `open`/`close`); Blender job kinds `animate` and `rig_prop` |
| `gen/workers/fixtures/` | Fake worker outputs; `biped.glb` (from `make_biped.py`) is a UniRig-shaped stick figure so animation can be tested without a GPU |
| `gen/setup.sh`, `gen/patches/` | Idempotent install into `~/.local/share/game-studio/gen/` (`src/` pinned repos + patches, `models/`, `envs/`, `hf/`, `logs/`) |
| `src/main/models.ts` | Model pipeline (`assets/models/<name>/`: `<name>.glb`, `thumbnail.png`, `model.json`, `concepts/`, `source/`) and the handler for agents' generation tools (`studio_request` from the session host) |
| `gen/spike/` | The M4a spike scripts; findings are in the vault note `M4 3D Models.md` |
| `src/modules/3d-models/` | 3D Models section: the asset is a model's `model.json`; concept board, three.js `ModelViewer`, in-engine render (`RunService.preview`). Its buttons run generation in a 3D Modeller session created without a prompt (a workspace) via `models3d.*` |
| `src/main/studio-files.ts` | `studio-file://<main or session id>/<path>`: serves models and images from a checkout to the renderer (use `studioFile()` in `src/renderer/api.ts`) |

## Testing

- Use Pi's `fauxProvider` (`@earendil-works/pi-ai`) for session tests, so they run without credentials or network.
- UI changes: build, run `e2e/smoke.ts` (or a dedicated e2e script), and look at the screenshot.
- `runner.test.ts` and the e2e build and run a real game from the template, so they need `../headless-game-engine`
  (with its `third_party/lib` built), `odin` and a display. Those runner tests skip themselves without the engine.
  `GAME_STUDIO_TEST_ENGINE=<path>` runs them against another engine checkout (e.g. to confirm a test catches
  an old engine's behaviour).
