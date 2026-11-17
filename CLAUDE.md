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
npm test             # vitest
node e2e/smoke.ts    # after build: launch the app with Playwright, screenshot to out/smoke.png
node spike/pi-spike.ts <scratch-dir>   # Pi SDK spike (faux provider, no credentials needed)
```

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

## Testing

- Use Pi's `fauxProvider` (`@earendil-works/pi-ai`) for session tests, so they run without credentials or network.
- UI changes: build, run `e2e/smoke.ts` (or a dedicated e2e script), and look at the screenshot.
