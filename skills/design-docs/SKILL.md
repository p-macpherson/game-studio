---
name: design-docs
description: The game's standard design docs, their statuses (not-established, draft, established), the format of a doc, and how to work through one with the user. Use before discussing, writing or changing anything in docs/design/.
---
# Design docs

The docs in `docs/design/` are where the user's decisions about the game are recorded. Game Studio gives every other
agent a brief made from them when its session opens: the docs its work follows in full, with their status. So what you
write here is read literally by the agents that make the art, audio, levels and code. Write direction they can act on.

## The standard set

Every project has these, in `docs/design/`:

| Doc | Decides | Mostly read by |
|---|---|---|
| `Game Brief.md` | What the game is, who it's for, scope, the current stage of development | everyone |
| `Design Pillars.md` | The design philosophy: intended experience, the few principles decisions are checked against, anti-goals | directors, gameplay engineer |
| `Gameplay Loop.md` | Core loop, mechanics, controls, camera, challenge | gameplay engineer, level designer, UI designer |
| `Progression.md` | Goals, growth, difficulty curve, economy, structure and saving | gameplay engineer, level designer |
| `World and Lore.md` | Setting, tone, characters, places, story, naming | art, audio, level designer |
| `Art Style.md` | Style, palette, shapes, detail, lighting, UI look, scale, prompt phrases | every art agent |
| `Audio Style.md` | Mood, music, sound effects, voice, mix | composer, sound designer |
| `Technical Direction.md` | Performance targets, code structure, quality bar, budgets | gameplay engineer |

Don't rename or delete them, and don't fold one into another. Anything else (a mechanic in depth, a level plan, a
character sheet, a content list) gets its own doc beside them, linked from the standard doc it belongs to.

## Status

Each doc starts with frontmatter:

```markdown
---
status: not-established
---
# Art Style
```

| Status | Meaning | What agents do |
|---|---|---|
| `not-established` | Not decided yet | Follow the doc's `## For now` guidance; keep that side of the work simple and cheap to replace |
| `draft` | The current thinking; may change | Follow it, without building costly things around its details |
| `established` | Decided | Follow it; report conflicts instead of deviating |

- **Only the user moves a doc to `established`.** Ask ("Is this settled enough to mark established?") with `ask_user`;
  don't infer it. The user can also set the status themselves in the Design Docs section.
- `draft` is right while you and the user are still working a doc out, or when they want to try a direction first.
- A doc can go back: if the user reopens a decision, set it to `draft` and say what's in question.
- Changing an established doc is a real decision: confirm it with the user and record it under `## Decisions`.

## A not-established doc

New projects start with every doc like this:

```markdown
---
status: not-established
---
# Art Style

> How the game looks: …

## For now
The art style has not been established. All art should be simple and minimal: …

## To decide
- **Style.** The overall look in a sentence, with references.
- **Palette.** …
```

`## For now` is live direction: agents follow it today. If the user tells you how they want an area handled until it's
decided ("prototype the gameplay first; placeholder art only"), write that there in their terms, and keep the status.
`## To decide` lists what establishing the doc means answering: it is your interview plan.

## An established (or draft) doc

```markdown
---
status: established
---
# Art Style

> One paragraph: the direction in brief. (Game Studio shows it in lists, and agents that don't get the full doc see only this.)

## Style
…one section per topic that was under "To decide", stating the decision as direction…

## Decisions
| Date | Decision | Why |
|---|---|---|
| 2026-11-21 | Low-poly, flat-shaded, no textures on characters | Fast to generate consistently; reads well at the camera distance |

## Open questions
- Whether night scenes get a separate palette.
```

- Drop `## For now` and `## To decide` once the doc is established. In a draft, keep under `## To decide` only what is
  still open, and keep `## For now` only if agents need interim guidance for the open parts.
- State decisions as instructions ("Characters are 1.1 m tall", "Never use pure black"), not as a discussion.
- Leave out a topic that doesn't apply to this game, with a line saying so ("No voice: the game has no speech").
- Date decisions (ISO). Keep the reasons: they're what lets a later session judge whether a decision still holds.

## Working through a doc with the user

1. Read the doc and the others it leans on (the Game Brief first, always). Don't ask what's already decided.
2. Say briefly what the doc is for and what there is to decide, then go one topic at a time. Ask one question at a
   time; offer two to four concrete options with what each implies (`ask_user`), and always leave room for their own answer.
3. Bring material: references, examples from games they've named, the consequences for the pipeline (what a style costs
   to generate consistently, what a mechanic needs from the engine). Push back on contradictions with other docs.
4. Write as you go: after each topic is agreed, put it in the doc (status `draft`), commit, and move on. The user sees
   the doc update in Game Studio. Don't save everything for one big write at the end.
5. Stop when they want to stop. Leave the rest under `## To decide` or `## Open questions`; a half-decided doc that says
   so is fine.
6. At the end, ask whether to mark it established, then `request_review` with what was decided and what's open.

When the user starts a new project, begin with the Game Brief, then Design Pillars, then whichever of the rest they
want to settle now. Many will rightly stay not-established for a while: make sure each one's `## For now` says what they
want in the meantime.

## When a decision changes
An established doc that changes can leave existing assets or code behind it. Say what is affected (e.g. "the six models
made under the placeholder style") in your report, so the user can commission the pass that brings them in line.
