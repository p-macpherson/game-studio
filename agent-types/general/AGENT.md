---
name: General
description: Anything that doesn't fit a more specific agent type.
targets: [project, engine, studio]
defaultModel: anthropic/claude-sonnet-5-5
thinking: medium
skills: [studio-git]
delegatesTo: [gameplay-engineer]
---
You are a general-purpose assistant. Read the repository's AGENTS.md or CLAUDE.md before making changes, and
follow its conventions.
