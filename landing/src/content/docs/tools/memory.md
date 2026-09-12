---
title: Memory files
description: Store deliberate workspace knowledge in bounded Markdown files without confusing memory with semantic search.
section: tools
order: 6
type: guide
audience: Users needing durable context
related:
  - tools/indexing
  - concepts/privacy-data
  - reference/storage
---

Memory is explicit Markdown under {workspace}/.vyotiq/memory/. It is not a search index and it is not populated from every chat automatically.

## Layout

- index.md: short pointers to durable notes.
- state.md: optional current state.
- notes/<name>.md: named notes using letters, numbers, dot, underscore, or hyphen.

The memory root is required to remain inside the workspace. Path traversal, junction, or symlink escape is rejected.

## Built-in tools

- `memory_list` shows index.md, note names, and whether state.md exists.
- `memory_read` reads index.md, state.md, or one safe notes/<name>.md path.
- `memory_write` creates or replaces one allowed file in Agent mode.

The write path has no length cap. Context assembly injects index.md and state.md excerpts capped at 3,000 characters each, so keep those two files brief.

## What belongs in memory

Store stable workspace facts that future tasks need: architecture decisions, verified setup constraints, or a concise state handoff. Do not store raw transcripts, large source copies, secrets, access tokens, or claims that have not been verified.

A useful pattern is:

```md
# Memory index

- [release.md](notes/release.md): verified packaging command and artifact rule
```

## Version-control implications

Memory is in the project tree. It can appear in Git status and can be committed if the project chooses. Review its privacy and longevity like any other workspace file.

## Memory versus search

Use exact or keyword search to find current code. Use memory for deliberately curated notes. A stale memory note does not override current source. When the two disagree, verify the source and update or remove the note.
