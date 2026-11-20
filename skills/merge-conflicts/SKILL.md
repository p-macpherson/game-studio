---
name: merge-conflicts
description: Resolving merge conflicts in a Game Studio project when a worktree is updated from main - text and code, the studio's JSON asset formats (scenes and prefabs, sounds, songs, textures, models), binary assets, and checking the result. Use whenever a merge or update has conflicts.
---
# Merge conflicts in a Game Studio project

The worktree's branch is mid-merge: `MERGE_HEAD` is main, `HEAD` is the worktree. `git status` lists the
conflicted files ("both modified", "deleted by them"…). Finish with `git add <files>` and `git commit --no-edit`;
`git merge --abort` gives the whole update up (only if the user wants that).

## Finding what each side meant
- `git log --oneline HEAD..MERGE_HEAD -- <file>` and `git log -p`: main's changes; `MERGE_HEAD..HEAD`: the worktree's.
- Studio sessions record their work: `.studio/sessions/<id>/session.json` (title, agent type) and the transcript
  (`*.jsonl`) beside it, in the project's main checkout (paths are in your brief). A session's last report usually
  says what it changed and why.

## By kind of file
| File | How to combine |
|---|---|
| Game code (`game/**/*.odin`), tests (`tests/*.jsonl`), docs (`docs/**/*.md`) | Edit by hand so both changes are in; re-read the result as a whole (duplicate procs, imports, test steps that now contradict) |
| Scenes and prefabs (`assets/scenes/*.json`, `assets/prefabs/*.json`, one entity per line) | Keep both sides' entities. **Entity ids must stay unique**: if both added an entity with the same id, give the worktree's a new one (the next unused) and update every `parent` that points at it. Both edited the same entity: merge its components field by field |
| `sound.json`, `song.json`, `texture.json`, `model.json` | Merge field by field, keeping valid JSON. Then **regenerate the outputs** from the merged source, never hand-merge them: `render_sound`, `render_song`, `make_texture` (models: keep the side whose `.glb` matches the manifest) |
| Binary assets (`.png`, `.glb`, `.ogg`, `.wav`: Git LFS) | Can't be combined: choose a side on purpose (`git checkout --theirs` = main, `--ours` = the worktree), usually the one whose source JSON you kept, and say which in your report |
| `.studio/` records | Keep both (they're per session or worktree, so real conflicts are rare); never delete another session's records |
| One side deleted a file the other changed | Usually the deletion was a move or a cleanup: check main's log. If the worktree's changes still matter, keep the file and say why |

## Check before committing
- `git diff --check` and a search for `<<<<<<<`: no markers left; JSON files parse.
- `./build.sh test`: the game builds and its tests pass. A scene changed: `preview_scene` it.
