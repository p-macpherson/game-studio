---
name: studio-git
description: Git rules for Game Studio sessions, which run in a worktree on their own branch. Use before committing, or when unsure what you may do with git.
---
# Git in a Game Studio session

You are in a git worktree on the branch `studio/<session-id>`. Game Studio merges that branch into the base
branch when the user approves it.

- Commit as you go, with small logical commits and messages in the imperative ("Add jump buffering").
- Do **not**: switch branches, rebase, reset the base branch, push, delete branches, or edit `.studio/`.
- Untracked build output belongs in `.gitignore`, not in commits.
- Check `git status` before calling `request_review`. Anything left uncommitted is committed for you as
  "Uncommitted changes" when the user merges.
- In a game project, `engine/` is a submodule. Don't change it or commit a new engine pointer, since engine
  changes go through engine sessions.
