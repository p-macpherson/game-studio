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
node spike/pi-spike.ts <scratch-dir>   # the M0 Pi SDK spike (faux provider, no credentials needed)
```

`GAME_STUDIO_FAUX=1` registers the scripted `faux/echo` model. It appends each message to `faux-notes.md` and
commits, so you can exercise sessions with no credentials.

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

## Testing

- Use Pi's `fauxProvider` (`@earendil-works/pi-ai`) for session tests, so they run without credentials or network.
- UI changes: build, run `e2e/smoke.ts` (or a dedicated e2e script), and look at the screenshot.
