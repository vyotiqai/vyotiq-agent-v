---
title: Prompt and attach context
description: Use precise prompts, @ mentions, files, images, audio, paste, and drop without exceeding composer limits.
section: agent
order: 2
type: guide
audience: All agent users
related:
  - reference/attachments
  - agent/context-compaction
  - customize/models
---

Good prompts state the outcome, the relevant boundary, and the evidence that will prove completion. Attach only context the model cannot reliably discover from the workspace.

## Write a task-shaped prompt

Include:

1. The user-visible outcome.
1. The file, surface, or subsystem when known.
1. Constraints such as “do not commit” or “preserve this API.”
1. A verification command or observable result.

For example: "Fix the overflow in the Settings navigation at 390px. Preserve keyboard navigation, run the renderer typecheck, and report the changed file. Do not edit unrelated views."

Use Ask for explanation, Plan for an approval-ready approach, and Agent for implementation.

## Use @ mentions

Type @ to open context sources. With a workspace selected, the root menu can expose Branch, Browser, Typecheck, Lint, recent files, Files & Folders, Docs, **Rules**, and Past Chats.

Docs in this menu means documentation files found in the workspace, such as README files. It does not mean this website.

## Attach files, images, and audio

Use Add (+), paste, or drag and drop. Current independent caps are:

- 5 files.
- 4 images.
- 2 audio files.

Files are extracted to text unless a selected model supports a native PDF/file path. Extracted text is capped before it reaches the model. Images and audio remain separate content parts.

The composer rejects an unsupported type or oversized item and shows the reason. When too many items are selected, only the available slots are accepted.

## Capability changes

Model metadata controls image, native file, audio, tools, structured output, and thinking capabilities. If attachments require capabilities the current model lacks, follow the composer state rather than assuming every provider accepts every modality.

## Keep context focused

Do not attach a whole repository when the agent can search it. Prefer a small set of decisive files, an error message, and the expected behavior. Use Context and compaction when a long chat approaches its model window.
