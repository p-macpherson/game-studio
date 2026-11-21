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
bash gen/setup.sh    # install/repair local generation: model repos, ~45 GB of weights, Python envs, the music SoundFont (idempotent)
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
- Sessions work in labelled git worktrees (several sessions can share one; sub-agents use their parent's), merged
  or discarded as a whole. Session records and Pi transcripts are committed in the target repo's
  `.studio/sessions/<id>/`, worktree records in `.studio/worktrees/`. See the vault notes `Sessions & Worktrees.md`
  and `M8 Workflow & Sessions.md`.
- Every Pi session has the `codemode` tool (scripts that call the other tools, studio tools included). The SDK
  doesn't load the CLI's built-in extensions, so `host-core.ts` adds `createCodemodeExtension()` and activates
  it with `defaultTools: ["+codemode"]`. "Open in terminal" passes `--tools +codemode` to the CLI.

## Where things are

| Path | What |
|---|---|
| `src/shared/{types,ipc,host}.ts` | Domain types, the renderer↔main API (`StudioApi`, `StudioEvent`), and the main↔session host protocol |
| `src/main/sessions.ts`, `src/main/worktrees.ts` | Session orchestrator: records, lifecycle (mark done/resume), host events; sessions work in **worktrees** (`WorktreeStore`: labelled records in `.studio/worktrees/<id>.json`, checkouts, diff, merge/discard as a whole), shared by a session's children. Old per-session records migrate on load. **Update from main** (`updateWorktree`: merge main into the branch; conflicts stay in progress until resolved or aborted; `conflictBrief` + `resolveWorktreeConflicts` start the `conflict-resolver` agent type). Changes are measured from the merge-base. Merged worktrees' branches are deleted (`git branch -d`); an open worktree's checkout can be unloaded to free space (`unloadBlocker`: nothing may exist only in the folder) and is rebuilt when selected |
| `src/session-host/host-core.ts` | Pi sessions, accounts and models; `studio-tools.ts` holds the agent's tools for talking to the studio, including `delegate` (only for types with delegation edges; the studio side is `SessionService.delegate`: a child session in the parent's worktree, awaited, its last message returned) |
| `src/main/agent-types.ts` | Agent types (`AGENT.md`: `delegatesTo` edges, `studioTools` allow-list, `aliases`), and `checkDelegation`: the graph stays acyclic (closing edges and unknown types are dropped into `problems`; a broken AGENT.md is listed with its error) |
| `src/main/project.ts` + `templates/game/` | New-project scaffold (engine added as the `engine/` submodule; no remote needed). `publishProject`: Source Control's **Publish to remote…** for a local-only project (refuses while the pinned engine commit isn't on the engine's remote; a failed push leaves no remote) |
| `agent-types/<id>/AGENT.md`, `skills/<name>/SKILL.md` | Built-in agent types (frontmatter + prompt) and Pi skills |
| `src/modules/<id>/` | Studio modules (one section per part of the game): `info.ts` (the `ModuleInfo` contract from `src/shared/modules.ts`, plus summaries) and `view.tsx`. Register a new module in `MODULES` (`src/main/assets.ts`) and `MODULE_VIEWS` (`src/renderer/modules.tsx`) |
| `src/main/asset-move.ts`, `src/shared/asset-names.ts` | Moving/renaming assets and folders in a worktree (`assets.move` from the tree's menu or drag-and-drop; agents' `move_asset`): files move, a renamed asset's own files follow (`barrel.glb` → `cask.glb`), and references are rewritten (quoted paths in assets/game/tests/docs, the asset's own JSON, markdown links). Folder-shaped asset names may contain folders (`props/barrel`); files inside use the last part (`leafName`) |
| `src/main/asset-links.ts`, `src/shared/asset-links.ts` | Which assets use which (`assets.links`): quoted paths in scenes, prefabs, manifests, game code and tests, resolved to the owning asset; `usersOf` follows chains (model ← prefab ← scene ← code). The sections' "Used in" filter (and "unused") and the tooltips' "Used in" |
| `src/main/assets.ts` | Asset discovery for modules: main checkout + **drafts** (files changed in active sessions' worktrees), reads, search |
| `src/renderer/views/AssetBrowser.tsx`, `src/shared/asset-tree.ts` | The shared module section: a file-explorer **tree** of the section's assets (`assetTree`: folders; a folder-shaped asset is one leaf; several roots are top-level folders; folded folders remembered), search and content of the checkout selected in the sidebar (`worktree` in the store; content views get `checkout`), ⎇ New/Modified/Removed labels (removed assets listed from main), "only changes" and "include removed" filters, no merge/discard there (only the sidebar's selector), actions, linked sessions; a module supplies its content view |
| `src/renderer/views/Worktrees.tsx`, `src/renderer/workspace.ts` | The sidebar's worktree selector (main or an open worktree; new, rename, merge, discard; remembered per project, Play & Test follows it; publishes the worktree's changed files as `worktreeChanges` for the sidebar's per-section counts); `editCheckout`/`runInWorktree`: a section's step runs in the selected worktree, or a new one (selected) when main is shown |
| `src/main/runner.ts` + `engine-client.ts` | Play & Test: build/run/test through the project's `build.sh` from main or a session worktree; the engine control-protocol client; frame streaming. Pure parsers (Odin diagnostics, script replies) in `src/shared/run.ts` |
| `src/renderer/views/Play.tsx` | Play & Test view: live view with input injection, inspector, console, tests |
| `src/main/gen.ts` | Generation service: job queue over Python model workers, one GPU worker at a time (warm per family, stopped when idle), Blender finalize jobs, setup/status |
| `gen/workers/` | Model workers speaking JSON lines (`protocol.py`): `image_worker.py` (FLUX.2 Klein), `hunyuan_worker.py` (shape, texture), `unirig_worker.py` (rig), `audio_worker.py` (sound takes + CLAP), `fake_worker.py` (tests) |
| `gen/blender/finalize.py` | Makes a model engine-ready: weld (only same-weight copies), non-metal by default, ≤65,535 vertices per primitive, scale/origin (measured in the rest pose), light skin-weight smoothing right after auto-rigging, export, thumbnail, stats |
| `gen/blender/animate.py`, `gen/blender/rig_prop.py` | Biped analysis (bone roles, `idle`/`walk`/`wave` clips) and hinge rigs for props (cut, cap, `open`/`close`); Blender job kinds `animate` and `rig_prop` |
| `gen/workers/fixtures/` | Fake worker outputs; `biped.glb` (from `make_biped.py`) is a UniRig-shaped stick figure so animation can be tested without a GPU |
| `gen/setup.sh`, `gen/patches/` | Idempotent install into `~/.local/share/game-studio/gen/` (`src/` pinned repos + patches, `models/`, `envs/`, `hf/`, `logs/`) |
| `src/main/models.ts` | Model pipeline (`assets/models/<name>/`: `<name>.glb`, `thumbnail.png`, `model.json`, `concepts/`, `source/`) and the handler for agents' generation tools (`studio_request` from the session host) |
| `gen/spike/` | The M4a spike scripts; findings are in the vault note `M4 3D Models.md` |
| `src/modules/3d-models/` | 3D Models section: the asset is a model's `model.json`; concept board, three.js `ModelViewer`, in-engine render (`RunService.preview`). Its buttons run generation in a 3D Modeller session created without a prompt (a workspace) via `models3d.*` |
| `src/shared/song.ts`, `src/main/music.ts` | Music: the song score format (`assets/music/<name>/song.json`: parser, validator, timeline) shared by the UI, the renderer and agents' `render_song`; MIDI writer (humanized by the song's `humanize`: per-note, the same every pass) and the render to a seamless-loop `<name>.ogg` (three passes, middle one kept, seam crossfaded): one FluidSynth stem per track, mixed in `music-mix.ts` (low cuts, `reverb` sends into a convolution room for the song's `space`, an impulse response made in code; ffmpeg `afir`), mastered and levelled to -18 LUFS. Agent type `music-composer`, skill `music-composition` (the format reference) |
| `src/shared/sound.ts`, `src/main/sounds.ts`, `src/main/audio-dsp.ts` | Sound effects: the sound format (`assets/sounds/<name>/sound.json`: **variants**, the files the game plays, each mixing its own layers (takes by id, or synth), every layer levelled before its gain; processing shared, overridable per variant; one variant per line); the pipeline (takes from the `sound` job, Stable Audio Open Small + CLAP in `gen/workers/audio_worker.py`, into `takes/<group>-<seed>.wav`; render: mix and process in TS, ffmpeg to `<name>.ogg` + `-2`… variants, waveform/spectrogram sheets); the DSP and measurements agents read instead of listening. Tools `generate_sound_takes`, `render_sound`; agent type `sound-designer`, skill `sound-design` |
| `src/shared/scene.ts`, `src/main/scenes.ts`, `src/modules/scenes/` | Scenes: scene/prefab files (parse, validate, structured edits that keep prefab references, one-entity-per-line format; `prefabIndex`: each prefab's model and where it's placed, for the tree's thumbnails and hints); `edit_scene` in a session's worktree; the section (live paused view through `RunService.start(..., {scene})`, mesh `pick`, orbit camera in `orbit.ts`, inspector, placement), mirrored live by respawning edited entities. `RunService.previewScene` serves agents' `preview_scene`. Agent type `level-designer`, skill `level-design` |
| `src/shared/themes.ts`, `src/renderer/appearance.ts`, `src/renderer/views/Appearance.tsx` | Settings → Appearance: colour themes (Simple Dark/Light, Catppuccin ×4, Everforest, Dracula, Nord, Gruvbox, Tokyo Night, Solarized, Rosé Pine, One Dark) fill the CSS variables in `styles.css` (use `var(--…)`, never literal colours; tints via `color-mix`; `themes.test.ts` checks contrast), and bundled Fontsource fonts set `--font`/`--mono`. Kept in localStorage, applied before the first paint; canvases and three.js read `themeColor()` and listen for `studio-appearance` |
| `src/main/edit-history.ts`, `src/main/edit-steps.ts` | Undo/redo of a person's manual edits per worktree (`worktrees.run` and `assets.move` are recorded as named steps with whole-file snapshots; undo refuses over a later change). Manual edits stay unsaved until `worktrees.save` commits them; `mergeWorktree` refuses unsaved changes (the Merge dialog, `src/renderer/views/MergeDialog.tsx`, shows the changes by section, commits, unsaved edits and sessions; working sessions block it, idle ones warn; it saves first when needed). The app menu's Undo/Redo send `edit_command` to the page |
| `src/shared/texture.ts`, `src/main/textures.ts`, `gen/workers/surfaces.py` | Tileable surface textures (M9): `assets/textures/<name>/texture.json` (tile in metres, chosen candidate, normal strength, roughness range); the image worker's `surface` job makes candidates seamless two ways (latents rolled every step over 8 steps; a plain image quilted), `surface_make` writes `<name>.png`, `_normal`, `_roughness` (CPU). Tools `generate_texture`, `make_texture`. The section: `src/modules/textures/` (candidate board, 3×3 tiling, `TexturePreview3D`, `RunService.previewTexture` renders a temp scene outside the project); the Scenes inspector's `SurfacePicker` sets a Mesh_Renderer's maps and `uv_scale` from the entity's size and the texture's tile |
| `src/main/studio-files.ts` | `studio-file://<main or session id>/<path>`: serves models and images from a checkout to the renderer (use `studioFile()` in `src/renderer/api.ts`) |

## Testing

- Use Pi's `fauxProvider` (`@earendil-works/pi-ai`) for session tests, so they run without credentials or network.
- UI changes: build, run `e2e/smoke.ts` (or a dedicated e2e script), and look at the screenshot.
- `runner.test.ts` and the e2e build and run a real game from the template, so they need `../headless-game-engine`
  (with its `third_party/lib` built), `odin` and a display. Those runner tests skip themselves without the engine.
  `GAME_STUDIO_TEST_ENGINE=<path>` runs them against another engine checkout (e.g. to confirm a test catches
  an old engine's behaviour).
