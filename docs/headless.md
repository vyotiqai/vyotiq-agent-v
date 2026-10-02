# Headless runs

`Vyotiq --headless` runs one task with no window and exits — for scripts and
CI, in the spirit of `claude -p` and `codex exec`. It is the real agent loop
with your saved settings, keys, rules, skills and MCP servers; only the window
is missing, so a policy you choose on the command line answers what a person
would have clicked.

```sh
# from a checkout (build it first: pnpm build:vite)
bin/vyotiq --cwd ~/code/app --mode ask --prompt "What does src/auth do?"
bin\vyotiq.cmd --cwd C:\code\app --prompt-file task.md --approval allow-safe --output json

# an installed app
"C:\Program Files\Vyotiq\Vyotiq.exe" --headless --cwd . --prompt "…" --output-file result.json
/Applications/Vyotiq.app/Contents/MacOS/Vyotiq --headless --cwd . --prompt "…"

# the launchers run an installed app instead of the checkout when told to
VYOTIQ_APP=/Applications/Vyotiq.app/Contents/MacOS/Vyotiq bin/vyotiq -p "…"
```

`package.json` has no `bin`: the package is never published, and a packaged
app is invoked by its own executable. `bin/vyotiq` (sh) and `bin/vyotiq.cmd`
are for a checkout. Everything before `--headless` belongs to the launcher
(the dev app path, Electron/Chromium switches); everything after it is parsed
below, and an unknown option is a usage error.

## Options

| Option | Meaning |
| --- | --- |
| `-p, --prompt <text>` | The instruction. `-` reads stdin. |
| `--prompt-file <path>` | Read the instruction from a file. |
| *(neither)* | Read stdin when it is piped; otherwise a usage error. |
| `--cwd <dir>` | Workspace folder. Default: the current directory. |
| `--mode agent\|ask` | `agent` may edit; `ask` is read-only. Default `agent`. |
| `--model [provider/]id` | Model for this run. `anthropic/claude-…` names the provider when the part before the first `/` is one the app knows; anything else (`meta-llama/llama-3`) is a model on your configured provider. |
| `--done-when <text>` | A condition the task is judged against (repeatable) — the New task form's *Done when*. |
| `--worktree` | Branch a git worktree from `HEAD` (as the app's *New task in a worktree* does) and run there. It is left in place; the result names its path and branch, and the app's worktree list can merge or discard it. |
| `--approval deny\|allow-safe\|allow-all` | Who answers approval prompts. Default `deny`. |
| `--on-question answer\|fail` | `ask_question` from the model: answer it, or stop. Default `answer`. |
| `--max-steps <n>` | Stop after n model steps (the step in progress finishes its tools). |
| `--max-cost <usd>` | Stop once the run (helpers included) has spent this much. |
| `--timeout <seconds>` | Stop after this long. |
| `--output text\|json\|stream-json` | See below. Default `text`. |
| `--output-file <path>` | Also write the JSON result to this file, whatever `--output` is. |
| `-q, --quiet` | Text output: no progress on stderr. |
| `-h, --help` | Usage. |

A prompt that itself begins with `--` goes as `--prompt=--…`, from a file, or
on stdin. In `bin\vyotiq.cmd`, cmd re-reads `^ & | < >` inside arguments, so
pass a prompt with those through `--prompt-file` or stdin.

## Approvals

Nobody is there to click, so `--approval` answers the prompts the run's
approval gate would have shown. It answers only what the gate *asks* under
your settings (Settings → Agent: approval mode, allowlists, autonomy): with
approvals off, ordinary tools are never asked about and run whatever the
policy says. For a read-only run use `--mode ask`.

- `deny` — every prompt is refused. The model reads the refusal as a tool
  error and carries on without it.
- `allow-safe` — reads, browsing and file edits (`edit`, `str_replace`,
  `edit_notebook`, which the run's checkpoint can undo) are allowed; shell
  commands other than the project's own check commands, delete, git, GitHub,
  MCP tools, tools the run wrote, and screen capture are refused.
- `allow-all` — every prompt is allowed.

Under every policy:

- **Permission-rule denies and protected paths** (`permissions.ts`) refuse a
  call before any prompt exists; no policy sees them.
- **A call held for a person** — the dangerous-command guard
  (`dangerousCommand.ts`: a force push, a delete outside the workspace, a
  download piped into a shell…) or a permission rule that says *ask* — is
  refused. Only a person may OK those.
- An allow is always *Allow once*: a headless run never writes an "Always
  allow" or "Allow for this task".

The loop's own questions are declined, not answered: a workspace's hooks file
is not run this time (and is asked about again in the app — a refusal is not
remembered), and the spend limit stops the run rather than spending more.

A model's `ask_question` with `--on-question answer` gets *"No human is
available (headless run). Proceed with your best judgment…"* for free-text
questions; choices are left unpicked, which the model reads as "skipped,
continue with a reasonable default". With `fail` the run stops (`needs_input`,
exit 3).

## Output

- **text** — the final answer alone on stdout (`answer=$(bin/vyotiq -p …)`);
  progress lines and a closing summary (status, steps, cost, files, done-when
  checks, run id) on stderr.
- **json** — one object on stdout when the run ends:

  ```json
  {
    "type": "result",
    "status": "done",
    "exitCode": 0,
    "runId": "2cf87371-…",
    "workspacePath": "C:\\code\\app",
    "worktree": { "path": "…", "branch": "vyotiq/fix-…", "baseBranch": "main" },
    "mode": "agent",
    "provider": "anthropic",
    "model": "claude-…",
    "answer": "…",
    "error": "…",
    "incomplete": { "reason": "spend_limit", "message": "…" },
    "filesChanged": [{ "path": "src/a.ts", "action": "modified" }],
    "doneWhen": [{ "id": "c1", "text": "tests pass", "source": "brief", "verdict": "met", "evidence": "…" }],
    "usage": { "steps": 7, "inputTokens": 81234, "outputTokens": 2210, "cachedInputTokens": 60110,
               "reasoningTokens": 0, "costUsd": 0.0412, "costSource": "billed" },
    "approvals": { "allowed": 3, "denied": 1, "deniedCalls": [{ "tool": "terminal", "summary": "…", "reason": "…" }] },
    "questions": 0,
    "durationMs": 48211
  }
  ```

  `worktree`, `provider`, `model`, `error` and `incomplete` appear only when
  they apply. `costSource` is `billed` (the provider reported it),
  `estimated` (list prices), `mixed`, `partial` (some calls had no price) or
  `none`.
- **stream-json** — one JSON object per line as things happen: a
  `run_started` line, the run's events exactly as the app records them
  (`text_delta`, `tool_start`, `tool_result`, `step_usage`, `status`, …; see
  `AgentEventSchema` in `src/shared/ipc/schemas/agent.ts`),
  `approval_decision` and `question_answered` lines, and a closing `result`
  line (the json object above).

Logs never reach stdout; they go to the app's log file
(`<userData>/logs/vyotiq.log`), and stray console output is moved to stderr.

## Status and exit codes

| Exit | Status | When |
| --- | --- | --- |
| 0 | `done` | Finished; every `--done-when` check marked met. |
| 1 | `not_met` | Finished, but a check is `not_met`, or a `--done-when` check was never marked. |
| 1 | `incomplete` | Stopped on an unanswered notice (cut off, spend limit, repetition…). |
| 1 | `failed` | The run errored (no key, provider down…) or never started. |
| 1 | `cancelled`, `max_steps`, `max_cost` | Stopped short. |
| 2 | — | Usage error: bad option, missing prompt, `--cwd` not a folder. |
| 3 | `blocked` | Failed or not met while approvals were refused — the refusal is the likely cause. |
| 3 | `needs_input` | `--on-question fail` and the model asked. |
| 124 | `timeout` | `--timeout` ran out. |
| 130 | `interrupted` | Ctrl+C (a second Ctrl+C quits at once without the result). |

## Beside the app

A headless run works while the app is open. It does not take the app's
single-instance lock (so it is never handed to the open window and never
quits on it), and it never performs a pending "Delete all my data". It reads
the same settings and keys (read-only — it writes no settings) and writes
ordinary run records under the same data folder, marked `headless: true` in
`status.json`; the app's navigator lists the run under its workspace once that
workspace is open. Chromium's own profile (cache, cookies, network state)
goes to `<userData>/headless/session-<pid>/`, so the two processes never
contend for its locks; folders of headless processes that have exited are
removed by the next headless run.

Caveats:

- Starting the app *while* a headless run is going, with that run's
  workspace open in it, marks the run interrupted: the app's boot sweep sees
  a `running` record it does not own.
- Each headless run starts its own MCP servers, as the loop does in the app
  (on its first step); their own stderr output shares the run's stderr.
- Hardware acceleration is off in a headless process; nothing is drawn.

## Windows notes

`Vyotiq.exe` (and Electron's `electron.exe`) are windowed programs. Electron
attaches to the console it was started from, so its stdout reaches a console
or a pipe — unless `ELECTRON_NO_ATTACH_CONSOLE` is set — but an interactive
`cmd`/PowerShell prompt does not wait for a windowed program and does not see
its exit code. So:

- From a checkout, use `bin\vyotiq.cmd`: it runs Electron through
  `node_modules\electron\cli.js` (a console program that passes its own stdio
  and exit code through).
- For an installed app, `set VYOTIQ_APP=C:\…\Vyotiq.exe` and use the same
  launcher (it runs `start "" /wait /b`), or from PowerShell
  `Start-Process -Wait -NoNewWindow`. Where stdout still does not arrive,
  `--output-file result.json` always does.
- Electron on Windows writes a CRLF to stdout as it starts, before any
  output of ours (a bare Electron app does the same). JSON parsers skip it;
  a stream-json reader should skip blank lines.
- Ctrl+C through `electron\cli.js` ends Electron without the graceful stop on
  Windows; the record is then marked interrupted, as after a crash.

## For other tools in this repo

`runHeadlessTask` (`src/main/headless/runTask.ts`) is the adapter: it starts a
run the way a window's send does (`startAgentRunInBackground`, e2e fixture
replay included), answers approvals and questions through the policies above,
enforces the limits and returns the result object. Anything in the main
process that needs to drive the loop without a window (an eval runner) should
call it rather than copy it. `VYOTIQ_E2E_FIXTURE=1` with
`VYOTIQ_E2E_FIXTURE_FILE=<fixture.json>` replays a recorded event stream
instead of calling a model, which proves the plumbing deterministically.
