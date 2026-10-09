---
title: Headless runs
description: Run one task with no window, from a script or CI, with Vyotiq --headless — options, approvals, output and exit codes.
group: Reference
order: 5
---

`Vyotiq --headless` runs one task with no window and exits. It is the same agent with your saved settings, keys, rules, skills and MCP servers; only the window is missing, so a policy you pass on the command line answers what a person would have clicked.

```sh
"C:\Program Files\Vyotiq\Vyotiq.exe" --headless --cwd . --prompt "What does src/auth do?" --mode ask
/Applications/Vyotiq.app/Contents/MacOS/Vyotiq --headless --cwd ~/code/app --prompt-file task.md --approval allow-safe --output json
```

On Windows, Settings › General › Command line can put a `vyotiq` command on your PATH. Given an option first, it runs headless with the same options, so `vyotiq --prompt "What does src/auth do?" --mode ask` is the first line above. In cmd, a prompt with `^ & | < >` in it goes through `--prompt-file` or stdin.

## Options

| Option | Meaning |
| --- | --- |
| `-p, --prompt <text>` | The instruction. `-` reads stdin. |
| `--prompt-file <path>` | Read the instruction from a file. |
| *(neither)* | Read stdin when it is piped. |
| `--cwd <dir>` | The workspace folder. Default: the current folder. |
| `--mode agent\|ask` | `agent` may edit; `ask` only reads. Default `agent`. |
| `--model [provider/]id` | The model for this run. |
| `--done-when <text>` | A condition the task is judged against, like the New task page's "Done when". Repeat it for more. |
| `--worktree` | Run in a new git worktree branched from `HEAD`. It is left in place; the result names its path and branch. |
| `--approval deny\|allow-safe\|allow-all` | Who answers approval prompts. Default `deny`. |
| `--on-question answer\|fail` | When the model asks a question: answer it, or stop. Default `answer`. |
| `--max-steps <n>` | Stop after this many model steps. |
| `--max-cost <usd>` | Stop once the run has spent this much. |
| `--timeout <seconds>` | Stop after this long. |
| `--output text\|json\|stream-json` | How the result is written. Default `text`. |
| `--output-file <path>` | Also write the JSON result to this file. |
| `-q, --quiet` | No progress lines on stderr. |

## Approvals

Nobody is there to click, so `--approval` answers what the run would have asked under your approval settings:

- `deny`: every prompt is refused. The agent reads the refusal and carries on without that tool.
- `allow-safe`: reads, browsing and file edits are allowed (the run's checkpoints can undo edits). Shell commands other than the project's own checks, deletes, git, GitHub, MCP tools, tools the agent wrote and screen capture are refused.
- `allow-all`: every prompt is allowed.

Whatever the policy, a risky command (see [Approvals](/docs/approvals#what-always-asks)) is refused: only a person can allow one. An allow is always "Allow once"; a headless run never saves an "Always allow". A workspace's hooks file is not run unless you already allowed it in the app, and the spend limit stops the run instead of asking.

## Output and exit codes

- `text`: the answer alone on stdout, with progress and a closing summary on stderr.
- `json`: one object on stdout when the run ends, with its status, answer, files changed, Done when verdicts, usage and cost, and approvals.
- `stream-json`: one JSON object per line as the run happens, ending with the same result object.

| Exit | Status |
| --- | --- |
| 0 | `done`: finished, every Done when met |
| 1 | `not_met`, `incomplete`, `failed`, `cancelled`, `max_steps` or `max_cost` |
| 2 | A usage error |
| 3 | `blocked` (refused approvals stopped it) or `needs_input` (`--on-question fail` and the model asked) |
| 124 | `timeout` |
| 130 | Interrupted with Ctrl+C |

## Beside the app

A headless run works while the app is open, with the same settings and keys (it changes neither). Its task is saved like any other and appears in the navigator under its workspace, and the app shows it as running until it ends.

On Windows, `Vyotiq.exe` is a windowed program, so a command prompt does not wait for it. Run it with `start "" /wait /b`, or from PowerShell with `Start-Process -Wait -NoNewWindow`, and use `--output-file` when stdout does not arrive.

## Related

- [Scheduled tasks](/docs/scheduled-tasks) to run tasks on a timer inside the app
- [Approvals](/docs/approvals)
