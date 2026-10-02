---
title: Hooks
description: Run your own commands before and after the agent's tool calls, when it is about to finish, and when a task needs you.
group: Extend
order: 4
---

Hooks are commands you set up to run around the agent's work: a check before it runs a shell command, a linter after it edits a file, a test run before it says it is done. The file follows Claude Code's format for the four events below. A file with any other event, a hook that is not a command, or a timeout over 600 is ignored as a whole. Matchers name Agent V's tools, such as `terminal` and `edit`, not Claude Code's `Bash` or `Edit`.

## Where hooks come from

| File | Runs |
| --- | --- |
| `hooks.json` in the app data folder | Always. These are yours. |
| `.vyotiq/hooks.json` in the workspace | Only after you allow them |

Both files run, yours first, one hook at a time.

A workspace's hooks came with the folder, so the first time a task starts there, Agent V asks: "This workspace's .vyotiq/hooks.json runs commands around the agent's work", listing up to eight of its commands, with "Run them" and "Don't run them". Your answer is kept for that exact file. If the file changes, you are asked again. [Instances](/docs/instances) never ask; they run a workspace's hooks only once you have allowed them. Answers are stored in `hook-trust.json` in the app data folder; there is no setting for them in the app.

## The file

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "terminal", "hooks": [{ "type": "command", "command": "node scripts/check-command.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "edit|str_replace|edit_notebook|delete", "hooks": [{ "type": "command", "command": "npx eslint --quiet .", "timeout": 120 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npm test --silent" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node scripts/ping-phone.js" }] }]
  }
}
```

`matcher` is a regular expression over the whole tool name, case-sensitive. Leave it out, or use `*`, to match every tool. Stop and Notification hooks ignore it. `timeout` is in seconds; the default is 60 and the most is 600.

## What each event does

| Event | When | Exit code 2 |
| --- | --- | --- |
| `PreToolUse` | Before a tool runs, after any approval | The call is blocked and later hooks are skipped. The agent is told it was blocked, with what the hook printed to stderr. |
| `PostToolUse` | After a tool ran | stderr is added to the result the agent reads |
| `Stop` | When the agent is about to finish | The agent keeps going, with stderr as the reason. At most three times per turn. Stop hooks do not run in instances or when a follow-up is waiting. |
| `Notification` | When a task asks for approval or asks you a question | Ignored |

Exit code 0 means go ahead. Any other exit code is logged and changes nothing. What a hook prints to stdout is ignored.

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

Hooks run through `cmd.exe` on Windows and `/bin/sh` elsewhere, with the same cleaned environment as the agent's terminal plus `VYOTIQ_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`, for Claude Code scripts), both set to the workspace folder.

## Related

- [Approvals](/docs/approvals), which run before `PreToolUse`
- [Data and storage](/docs/data-and-storage) for the app data folder
