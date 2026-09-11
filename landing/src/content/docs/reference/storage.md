---
title: Storage locations
description: Locate settings, workspaces, runs, indexes, logs, notifications, models, packages, skills, rules, and memory.
section: reference
order: 5
type: reference
audience: Support and administrators
related:
  - concepts/privacy-data
  - concepts/runs-sessions-state
  - tools/memory
---

[Privacy and data storage](/docs/concepts/privacy-data) states the policy. This page lists locations.

Agent V stores local state in Electron's platform-specific userData directory. That directory is named for the packaged app Vyotiq. Use [Settings → General](/docs/reference/settings) → Open logs folder and Settings → About → Copy before guessing an absolute support path.

| Data | Location or root | Notes |
| --- | --- | --- |
| Settings | {userData}/settings.json | Mode, provider IDs, UI and agent preferences; file mode is restricted |
| Secrets | Secure-storage-backed secret record under app data | Provider, GitHub, and MCP secret material; Authorization is refused as plaintext settings fallback |
| Notifications | {userData}/notifications.json | Bounded inbox items |
| Workspace records | {userData}/workspaces/{workspaceId}/ | Stable ID derived from canonical workspace path |
| Run sessions | workspaces/{workspaceId}/sessions/{runId}/ | Transcript, state, artifacts (`goal.json`, `loop.json`, todos, plan, receipt), and checkpoints |
| Semantic index | workspaces/{workspaceId}/codeindex/ | Derived cache |
| Exact sparse index | workspaces/{workspaceId}/sparsegrep/ | Derived cache |
| Logs | Directory returned by Open logs folder | Local rotating logs |
| Code-index models | Codeindex model directory under user data | Downloaded ONNX weights |
| Dictation models | Dictation cache under user data | Whisper model files |
| Marketplace packages | Marketplace-managed package root under user data | Use Marketplace lifecycle actions |
| Personal skills | ~/.vyotiq/skills/ | One directory per SKILL.md skill |
| Workspace skills | {workspace}/.vyotiq/skills/ and .cursor/skills/ | Project files |
| Workspace rules | Root instruction files, .vyotiq/rules/, .cursor/rules/ | Project files |
| Memory | {workspace}/.vyotiq/memory/ | Project Markdown |

## Safe cleanup

Stop or finish affected runs before deleting derived state. Semantic and sparse indexes can be rebuilt. Downloaded models can be removed through their Settings controls. **Packages** should be removed through Marketplace.

Settings → Storage shows disk usage by category and offers a confirm-gated **Free up space** sweep: checkpoint garbage collection (keep-last-20 sessions, 30-day backstop), untracked workspace storage cleanup (30-day grace), and a 5 GB managed-size cap. Automatic cleanup never deletes anything written in the last 24 hours.

Do not manually edit encrypted secret data. Removing settings.json resets persisted settings but does not document deletion of every separate store.

## Workspace identity

Moving or renaming a project changes its canonical path and therefore can produce a different workspace ID. The workspace metadata retains the canonical path and display name used for that record.

## Support collection

For a failure, collect the app version, platform, workspace display name, run ID if visible, exact error, and relevant local logs. Do not attach API keys, full secret files, or unrelated workspace content.
