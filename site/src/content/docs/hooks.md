---
title: Hooks
description: Run your own commands when a task starts, when you send an instruction, before and after the agent's tool calls, when it is about to finish, and when a task needs you.
group: Extend
order: 4
---

Hooks are commands you set up to run around the agent's work: a check before it runs a shell command, a linter after it edits a file, a test run before it says it is done. The file follows Claude Code's format for the six events below, so a Claude Code `settings.json` can be used as it is: its other keys are ignored, and so are events Agent V doesn't run and hooks that are not commands (such as a `prompt` hook). The rest of the file still runs, and what was skipped is logged once. Matchers name Agent V's tools, such as `terminal` and `edit`, not Claude Code's `Bash` or `Edit`.

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

`matcher` is a regular expression over the whole tool name, case-sensitive. Leave it out, or use `*`, to match every tool. For `SessionStart` it matches the source, `startup` or `resume`. Stop, Notification and UserPromptSubmit hooks ignore it. `timeout` is in seconds; the default is 60, and anything over 600 runs with 600.

## What each event does

| Event | When | Exit code 2 |
| --- | --- | --- |
| `SessionStart` | When a task starts, or resumes for a follow-up or Continue | Ignored |
| `UserPromptSubmit` | When an instruction you send starts or continues a task, before the agent's first step on it. A follow-up queued while the agent is still working is taken in between steps without it. | The instruction is blocked: it is taken out of the task, the task stops, and stderr is the error shown. Later hooks are skipped. |
| `PreToolUse` | Before a tool runs, after any approval | The call is blocked and later hooks are skipped. The agent is told it was blocked, with what the hook printed to stderr. |
| `PostToolUse` | After a tool ran | stderr is added to the result the agent reads |
| `Stop` | When the agent is about to finish | The agent keeps going, with stderr as the reason. At most three times per turn. Stop hooks do not run in instances or when a follow-up is waiting. |
| `Notification` | When a task asks for approval or asks you a question | Ignored |

Exit code 0 means go ahead. Any other exit code is logged and changes nothing. [Instances](/docs/instances) run neither `SessionStart` nor `UserPromptSubmit`.

What a `SessionStart` or `UserPromptSubmit` hook prints to stdout on exit code 0 goes to the agent with that instruction. Other events ignore stdout, except for Claude Code's JSON output:

| JSON on stdout (exit code 0) | Events | Effect |
| --- | --- | --- |
| `{"decision": "block", "reason": "…"}` | `PreToolUse`, `UserPromptSubmit`, `PostToolUse`, `Stop` | The same as exit code 2, with `reason` in place of stderr |
| `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}` | `PreToolUse` | The call is blocked |
| `{"hookSpecificOutput": {"additionalContext": "…"}}` | `SessionStart`, `UserPromptSubmit` | `additionalContext` goes to the agent |

`PreToolUse` runs after approval, so a `permissionDecision` of `allow` or `ask` changes nothing: the call goes ahead as approved.

## What a hook receives

Each hook gets one JSON object on stdin:

| Field | Always | Notes |
| --- | --- | --- |
| `session_id` | Yes | The task's run id |
| `cwd` | Yes | The workspace folder, also the hook's working directory |
| `hook_event_name` | Yes | The event's name |
| `tool_name`, `tool_input` | Tool events | |
| `tool_response` | `PostToolUse` | `ok` and `content` |
| `stop_hook_active` | `Stop` | `true` when a Stop hook already kept this turn going |
| `message` | `Notification` | What the task needs |
| `prompt` | `UserPromptSubmit` | The instruction as you typed it |
| `source` | `SessionStart` | `startup` or `resume` |

Hooks run through `cmd.exe` on Windows and `/bin/sh` elsewhere, with the same cleaned environment as the agent's terminal plus `VYOTIQ_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`, for Claude Code scripts), both set to the workspace folder.

## Related

- [Approvals](/docs/approvals), which run before `PreToolUse`
- [Data and storage](/docs/data-and-storage) for the app data folder
