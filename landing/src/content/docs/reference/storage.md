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

Agent V keeps local state in Electron's per-user application data directory, named `vyotiq` (this is Vyotiq's app data folder) — on Windows that is `%APPDATA%/vyotiq`. If you need an absolute path on a support call, open the log folder from Settings → General, or copy the build info from Settings → About.

| Data | Location or root | Notes |
| --- | --- | --- |
| Settings | {userData}/settings.json | Provider IDs, UI and agent preferences. Written with a restricted file mode (0600) |
| Secrets | {userData}/secrets.json | Provider, GitHub, and MCP credentials, encrypted with Electron safeStorage. Authorization material is never written to settings.json |
| Notifications | {userData}/notifications.json | Bounded inbox items |
| Workspace records | {userData}/workspaces/{workspaceId}/ | The ID is a stable UUID derived from the workspace's canonical path |
| Run sessions | workspaces/{workspaceId}/sessions/{runId}/ | Per-run transcript (`messages.jsonl`), ops telemetry (`events.jsonl`), artifacts (`todos.json`, `goal.json`, `loop.json`, run receipt), and `checkpoints/` |
| Attachments | workspaces/{workspaceId}/attachments/ | Sidecar files for composer attachments |
| Browser artifacts | workspaces/{workspaceId}/browser/ | Screenshots and captures from browser tools |
| Code index | workspaces/{workspaceId}/codeindex/ | Derived SQLite (FTS5) cache, rebuildable |
| Logs | {userData}/logs/ | Local rotating logs (`vyotiq.log`) |
| Dictation models | cache under user data | Downloaded Whisper model files |
| Marketplace packages | {userData}/marketplace/ | `packages/{id}/{version}`, plus `index.json` and a cached catalog. Remove packages through Marketplace, not the file system |
| Personal skills | ~/.vyotiq/skills/ | One directory per skill, each with a SKILL.md |
| Workspace skills | {workspace}/.vyotiq/skills/ and .cursor/skills/ | Project files |
| Workspace rules | AGENTS.md, CLAUDE.md, or .cursorrules at the root, plus .vyotiq/rules/ and .cursor/rules/ | Project files; see [Rules](/docs/customize/rules) |
| Memory | {workspace}/.vyotiq/memory/ | Plain markdown (index.md, state.md, notes/) |

## Safe cleanup

Stop or finish affected runs before deleting derived state. The code index can be rebuilt. Downloaded dictation models can be removed through their Settings controls. Packages should be removed through Marketplace.

Settings → Storage shows disk usage by category and offers a confirm-gated Free up space sweep: checkpoint garbage collection (keep the last 20 sessions with a 30-day age backstop), a reaper for orphaned workspace storage (30-day grace), optional session retention (off by default), and a 5 GB managed-size cap. Automatic cleanup never deletes anything written in the last 24 hours.

Do not manually edit the encrypted secret file. Deleting settings.json resets persisted settings; it does not touch the other stores listed above.

## Workspace identity

The workspace ID comes from the canonical workspace path, so moving or renaming a project changes its ID and produces a new record. The record itself keeps the canonical path and display name it was created with.

## Support collection

For a failure, collect the app version, platform, workspace display name, run ID if visible, exact error, and relevant local logs. Do not attach API keys, secret files, or unrelated workspace content.
