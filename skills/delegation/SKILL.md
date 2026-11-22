---
name: delegation
description: Handing work to sub-agents with the delegate tool. Writing briefs, running sub-agents side by side, checking their work, and keeping the user as involved as they want. Use whenever you delegate.
---
# Delegating

`delegate` starts a sub-agent: a new session of another agent type, working in your worktree. It waits until the
sub-agent finishes and returns its last message, its report; the sub-agent is then marked done (the user sees it under your session and can resume it). To follow up, delegate again with what's left.

## Briefs
The sub-agent starts with nothing but your brief. Include:
- the goal and what done looks like (files, names, sizes, behaviour);
- the context it needs: the design doc to read, the style, related assets and code, paths;
- constraints: what not to touch, conventions to follow;
- how involved the user wants to be: "ask the user before choosing a concept" or "choose yourself";
- what to report back: paths, decisions, open questions.

Give it a short `title`, which names its session.

## Model
Each sub-agent starts on its type's usual model, which suits its usual work: leave `model` out. Where `delegate`
lists other models for a type, you may name one, and a more capable model costs the user more. Ask for one only
when the task is unusually hard for that type: subtle or wide-reaching, or a second attempt at something the usual
model got wrong. Say in your reply to the user when you did, and why.

## Side by side
Independent tasks can run at once: several `delegate` calls in one codemode script.

```js
const [model, sound] = await Promise.all([
  tools.delegate({ agentType: "art-director", title: "Treasure map model", task: "…" }),
  tools.delegate({ agentType: "audio-director", title: "Map pickup sound", task: "…" }),
]);
return [model, sound].join("\n\n---\n\n");
```

Dependent tasks go one after another (the model before the code that spawns it). GPU generation runs one job at a
time, so several art tasks queue rather than finishing sooner.

## Checking
Read the report, then check the work itself: the files, previews, `./build.sh test`. If it falls short, delegate
again with exactly what to fix. The new sub-agent doesn't see the old one's conversation: say what exists and
what's wrong.

## The user
The user decides how involved they are. Pass their preference on in every brief. When a choice is theirs (a
concept, a theme, a layout), the sub-agent asks with `ask_user`: the question shows in its session, and you wait.
