---
title: Settings reference
description: Exact controls, options, and defaults across the ten Settings sections.
section: reference
order: 1
type: reference
audience: Administrators and support
related:
  - customize/providers
  - tools/indexing
  - tools/voice-dictation
---

Open Settings from the sidebar, or press Ctrl+, (⌘, on macOS). The search box at the top jumps to the matching field. This page lists every section title and the labeled controls in it.

## General

| Control | Options and notes |
| --- | --- |
| Active model | shows the composer model picker, with a shortcut to Providers |
| Navigation | Home page or Sidebar |
| Workspaces | open sessions in workspace tabs. Enable Override to pin a per-workspace provider, model, and agent settings |
| Share crash & error reports | optional opt-in. Local rotating logs are always written. Builds without a Sentry DSN show a disabled row instead. Reports never include chat contents, API keys, or file bodies |
| Enable notifications | master switch for the inbox and desktop toasts |
| Desktop notifications | Off, When unfocused, Always |
| Logs | opens the local rotating log folder |
| Recent crashes | the last renderer, GPU, and utility process exits |
| Trace capture | capture a diagnostic trace of an agent run |
| Diagnostics command | optional override for the diagnostics tool's typecheck. Blank means auto-detect (package scripts or tsc) |

## Appearance

| Control | Options and notes |
| --- | --- |
| Color mode | System, Dark, Light |
| Text size | Small, Default, Large |
| UI density | Compact, Default, Comfortable |
| Interface skin | Default, Proof, Bench, Native, Gild |
| Custom CSS overlay | local stylesheet applied over the selected skin. It overrides the `--vy-*` design tokens after the skin is applied. Remote `@import` URLs are stripped. Max 256 KB |

## Providers

See [Providers](/docs/customize/providers). The section has the active provider, the API key list, and a model catalog you can refresh.

## Agent

| Control | Options and notes |
| --- | --- |
| Show thinking in chat | collapsed thinking blocks above assistant replies |
| Persona | the assistant identity the agent claims in replies |
| Tone | how replies sound, as a free-form description |
| Response language | preferred language for replies |
| Answer length | Concise (default), Balanced, Detailed |
| Keep recent turns | turns preserved during compaction, 4–50 |
| Auto-compact threshold | percent of the model content window that triggers auto-compact, 5–95% |
| Autonomous mode | unattended runs auto-approve gated tools; high-risk tools stay gated |
| Questions in autonomous mode | what the agent does when it would ask a question mid-run |
| Offline wait budget | how long unattended runs wait out a lost connection |
| Workspace rules | loaded from AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules/, and .vyotiq/rules/. See [Rules](/docs/customize/rules) |
| Memory files | long-term memory under {workspace}/.vyotiq/memory/ as plain markdown |

## Indexing

See [Codebase search and indexing](/docs/tools/indexing). Toggle the codebase index, watch index status and live processes, reindex a workspace.

## Voice

See [Voice dictation](/docs/tools/voice-dictation). Pick the dictation engine, show the composer waveform, and manage locally installed Whisper models.

## Storage

Disk usage is broken down by category: checkpoints, session transcripts, workspace indexes, instance worktrees, traces, logs, and models. Free up space previews what each cleanup would reclaim and asks for confirmation before deleting. Retention controls cover checkpoint garbage collection (keep the last 20 sessions, plus a 30-day age backstop), a reaper for orphaned workspace storage with a 30-day grace period, deleting storage when a workspace is removed, optional session retention (off by default), and a 5 GB managed-size cap. Automatic cleanups never delete anything written in the last 24 hours.

## Tools

See Security and approval, Browser, and Terminal. The section has Tool approval, MCP tools protection, the terminal shell and screen reader handling, the browser domain allowlist, the browser_search engine, auto-resume of interrupted runs, and automatic mode switching.

## Shortcuts

A read-only list of keyboard chords. There are no rebind controls. The full list: [Shortcuts](/docs/reference/shortcuts).

## About

App version, the Electron, Chromium, and Node.js versions behind it, the platform, a copyable build info block, update checks on startup, and links to the Website and these Docs.
