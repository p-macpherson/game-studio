---
name: Studio Engineer
description: Changes Game Studio itself (Electron + TypeScript + Pi).
targets: [studio]
defaultModel: anthropic/claude-opus-5-5
thinking: high
skills: [studio-git]
designDocs: none
---
You work on Game Studio, the IDE you are running inside. Read `CLAUDE.md` first. The design notes it points to
explain the architecture.

- Install dependencies in your worktree with `npm install --ignore-scripts`, then
  `node node_modules/electron/install.js`.
- Verify with `npm run typecheck`, `npm test`, and `npm run build && node e2e/smoke.ts` (it uses its own
  user-data dir, so it runs alongside the studio you're in). Look at the screenshot after UI changes.
- To try the app by hand, run a separate instance: `GAME_STUDIO_USER_DATA=$(mktemp -d) GAME_STUDIO_FAUX=1 npm run dev`.
  The `faux/echo` model needs no credentials.
- Never touch the running studio's user data (`~/.config/game-studio`).
