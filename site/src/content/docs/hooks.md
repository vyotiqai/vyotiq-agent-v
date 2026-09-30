---
title: Hooks
description: Run your own commands before and after the agent's tool calls, when it is about to finish, and when a task needs you.
group: Extend
order: 4
---

Hooks are commands you set up to run around the agent's work: a check before it runs a shell command, a linter after it edits a file, a test run before it says it is done. The file format is the one Claude Code uses, so a hooks file you already have carries over.

## Where hooks come from

| File | Runs |
| --- | --- |
| `hooks.json` in the app data folder | Always. These are yours. |
| `.vyotiq/hooks.json` in the workspace | Only after you allow them |

A workspace's hooks came with the folder, so the first time a task starts there, Agent V asks: "This workspace's .vyotiq/hooks.json runs commands around the agent's work", listing each one, with "Run them" and "Don't run them". Your answer is kept for that exact file. If the file changes, you are asked again. [Instances](/docs/instances) never ask; they run a workspace's hooks only once you have allowed them.

## The file

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "terminal", "hooks": [{ "type": "command", "command": "node scripts/check-command.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "edit|write", "hooks": [{ "type": "command", "command": "npx eslint --quiet .", "timeout": 120 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npm test --silent" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node scripts/ping-phone.js" }] }]
  }
}
```

`matcher` is a regular expression over the whole tool name. Leave it out, or use `*`, to match every tool. `timeout` is in seconds; the default is 60.

## What each event does

| Event | When | Exit code 2 |
| --- | --- | --- |
| `PreToolUse` | Before a tool runs, after any approval | The call is blocked. What the hook printed to stderr is what the agent is told. |
| `PostToolUse` | After a tool ran | stderr is added to the result the agent reads |
| `Stop` | When the agent is about to finish | The agent keeps going, with stderr as the reason. At most three times per turn. |
| `Notification` | When a task asks for approval or asks you a question | Ignored |

Exit code 0 means go ahead. Any other exit code is logged and changes nothing.

## What a hook receives

Each hook gets one JSON object on stdin:

| Field | Always | Notes |
| --- | --- | --- |
| `session_id` | Yes | The task's run id |
| `cwd` | Yes | The workspace folder, also the hook's working directory |
| `hook_event_name` | Yes | `PreToolUse`, `PostToolUse`, `Stop` or `Notification` |
| `tool_name`, `tool_input` | Tool events | |
| `tool_response` | `PostToolUse` | `ok` and `content` |
| `stop_hook_active` | `Stop` | `true` when a Stop hook already kept this turn going |
| `message` | `Notification` | What the task needs |

Hooks run through `cmd.exe` on Windows and `/bin/sh` elsewhere, with the same cleaned environment as the agent's terminal plus `VYOTIQ_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`, for Claude Code scripts).

## Related

- [Approvals](/docs/approvals), which run before `PreToolUse`
- [Data and storage](/docs/data-and-storage) for the app data folder
