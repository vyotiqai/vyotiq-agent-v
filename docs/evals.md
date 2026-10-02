# Coding evals

A regression suite of small coding tasks for the agent harness. Each task runs
through the real agent loop (`runAgent` in `src/main/agent/loop.ts`) with real
tools in a throwaway copy of a tiny repo. The task's checker then scores the
workspace that is left. Use it to check a harness, prompt or tool change
instead of hand-replaying `events.jsonl`.

| What | Where |
| --- | --- |
| Task fixtures | `scripts/evals/coding/<id>/` |
| Checker helpers | `scripts/evals/coding/_lib/check-lib.mjs` |
| Runner, solver, report (TS) | `src/main/agent/codingEval/` |
| CLI | `scripts/eval-coding.mjs` (`pnpm eval:coding`) |
| Tests with no model | `tests/main/unit/codingEval/` |
| Reports | `test-results/eval-coding/<timestamp>/` (gitignored) |

## Running

```sh
pnpm eval:coding --self-check                  # no model, no cost: prove every checker
pnpm eval:coding                               # every task, the provider/model set in the app
pnpm eval:coding --filter fix-,rename --repeat 3
pnpm eval:coding --provider anthropic --model <id> --label after-prompt-change \
  --compare test-results/eval-coding/<earlier-run>/report.json
```

A real run spends money. Each attempt is capped by the task's `maxSteps` and
`timeoutSec`. You can override the caps with `--max-steps`, `--timeout-sec` and
`--max-cost <usd>`. When a cap trips, the runner cancels the run the same way
the Stop button does.

The fixtures' `timeoutSec` assumes a model that takes about 20 seconds a step.
A slower model, such as a free tier that takes about a minute a step, fixes
the bug and then runs out of time before it says it is done. The report then
shows `cap hit: timeout` with a passing check. Raise the cap with
`--timeout-sec 1500` rather than editing the fixtures, so results stay
comparable across models.

- **Runtime.** By default the CLI relaunches itself inside Electron, because
  saved API keys live in `safeStorage`. Before it does, it copies
  `settings.json`, `secrets.json`, `Local State` and the model catalog cache
  from the app's data directory (`--user-data` to pick another) into a temp
  userData. Eval sessions therefore never show up in the app's history. MCP
  servers are removed from the copy unless you pass `--keep-mcp`.
  `--runtime node` skips Electron and works only for providers that need no
  key, such as a local Ollama.
- **Approvals and questions.** Nobody is watching an eval run.
  `--approve safe` (the default) answers every approval card "Allow once",
  except that it denies commands the command guard held as dangerous.
  `--approve all` lets those run too. `ask_question` always gets an empty
  answer. The report counts both.
- **Done-when.** The instruction is the only thing the model sees.
  `--done-when` also passes `done_when` as the run's brief checks.
- **Output.** For each attempt, `report.json` and `report.md` record pass/fail,
  steps, tokens, cost, wall time and a one-line failure reason.
  `attempts/<task>-<n>/` holds `answer.md`, `check.json` and `run/` (a copy of
  `events.jsonl`, `messages.jsonl`, `status.json` and `receipt.json` for
  replay). Workspaces of failed attempts are kept under the OS temp dir
  (`--keep never|failed|always`), and their path is in the report.
- **Compare.** `--compare <report.json|dir>` lists per-task pass-rate
  regressions and improvements in both reports. It exits 2 when anything
  regressed. With `--repeat N`, a task that passes some attempts and fails
  others is marked flaky.

## Adding a task

1. Make `scripts/evals/coding/<id>/` with:
   - `task.json`: `{ "id", "category", "instruction", "done_when": [], "timeoutSec", "maxSteps" }`.
     Optional fields are `"mode": "ask"` (the answer is scored) and
     `"maxCostUsd"`. The `id` must equal the folder name.
   - `repo/`: the starting project. Keep it small and dependency-free, using
     Node ESM and `node:test` (`node --test`). Name a file `<name>.fixture` to
     have it copied as `<name>`. Do this for `AGENTS.md`, so this repo's own
     agents do not pick it up as a nested instruction file. Avoid folder names
     the root `.gitignore` drops (`dist/`, `out/`, `logs/`...).
   - `check.mjs`: scores the workspace with `_lib/check-lib.mjs`
     (`parseCheckArgs`, `createChecker`, `runNodeTest`, `runHiddenTests`,
     `changedFiles`, `withWorkspaceCopy`). It must never write inside the
     workspace.
   - `hidden/`: behaviour tests the agent never sees. They import workspace
     modules through `$EVAL_WORKSPACE`.
   - `solution/`: the reference fix. `repo/` is overlaid on the starting
     repo, `delete.json` lists paths to remove, `commands.json` lists Node
     argv lists to run (e.g. a build), and `answer.md` is the Ask answer.
2. Run `pnpm eval:coding --self-check --filter <id>`. The untouched repo must
   fail and the solution must pass.
3. Add a check for the shortcut a model would take instead of the real fix,
   such as editing the tests or the protected file. Then add a case for it to
   `tests/main/unit/codingEval/codingEvalFixtures.test.ts`.

## How it works

`loopSolver.ts` does the renderer's job through the loop's existing seams:
`registerApprovalSender`/`registerQuestionSender` answer cards, the
`AgentEvent` stream gives steps (`step_usage`, or one per assistant message
when the provider reports no usage), tokens, cost and the final answer, and
`cancelRun` enforces the caps. The loop itself has no eval-specific code.
`scripts/evals/ts-hooks.mjs` lets Node or Electron import the `src/main` graph
directly: it handles aliases, extensionless specifiers, TS transform,
`?asset` imports and an optional electron stub.
