# ARC-AGI eval harness

Headless ARC-AGI benchmark that runs the app's real completion layer (real settings, real provider credentials) against the semi-private grid task set. No new dependencies — everything runs on the existing Electron/Node toolchain. The dataset and all reports live under git-ignored `test-results/`.

## Layout

- `scripts/arc-agi/fetch-dataset.mjs` — fetches the semi-private grid task set: 400 training + 400 evaluation JSON files into `test-results/arc-agi/`. `$VYOTIQ_ARC_DATA_DIR` overrides the target directory. Network failures exit non-zero.
- `scripts/arc-agi/resolve-shim.mjs` — the one `node:module` `registerHooks` resolve shim: appends `.ts` to extensionless relative imports (with `<dir>/index.ts` fallback) and maps `@main/…` / `@shared/…` aliases.
- `scripts/arc-agi/eval-lib.mjs` — shared runner helpers: flag parsing, dataset resolution, task loading, deterministic stub solver.
- `scripts/arc-agi/run-eval.mjs` — plain-Node CLI, stub solver only.
- `scripts/arc-agi/electron-eval-main.mjs` — Electron main-process entry for harness / zero-shot runs (the only path that exercises the real completion layer).
- `src/main/agent/arcEval/` — `types.ts` (contract), `arcScorer.ts`, `harnessAdapter.ts` (`solveTask` multi-round with repair; `solveTaskZeroShot` single-shot baseline), `orchestrator.ts` (`runEvalTasks` bounded-concurrency worker pool with majority vote), `report.ts`.
- `tests/main/unit/arcEval/` — unit tests.

## CLI

Electron entry (`scripts/arc-agi/electron-eval-main.mjs`):

| Flag | Default | Meaning |
|---|---|---|
| `--tasks N` | 3 | Number of tasks |
| `--candidates N` | 1 | Candidates per task |
| `--subset train\|evaluation` | `train` | Dataset split |
| `--out FILE` | `test-results/arc-eval/electron-smoke-report.json` | Report path |
| `--solver harness\|zero-shot` | `harness` | Solver mode |
| `--model LABEL` | `<settings>` | Model label (default reads real app settings) |
| `--concurrency N` | 2 | Parallel candidates |
| `--max-tokens N` | adapter's (16,384) | Per-completion output token cap |
| `--timeout-ms N` | adapter's (300,000) | Per-candidate overall deadline in ms |
| `--reasoning-effort minimal\|low\|medium\|high\|xhigh\|max` | off | Sends an explicit reasoning effort instead of disabled thinking |

The plain-Node CLI (`scripts/arc-agi/run-eval.mjs`) runs the stub solver only — harness and zero-shot modes need the Electron entry, because `harnessAdapter` transitively imports electron for app/safeStorage.

## Running under Electron

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\.bin\electron.cmd scripts\arc-agi\electron-eval-main.mjs --tasks 20 --candidates 3 --concurrency 4 --solver harness --out test-results\arc-eval\benchmark-harness.json
```

Gotchas, learned the hard way:

- `ELECTRON_RUN_AS_NODE` silently degrades electron to plain Node — unset it first, or the run dies on the first electron import.
- userData: launched with a bare script path, Electron has no package.json app name, so the entrypoint sets `app.setPath('userData', <appData>/<package.json name>)` to read the real `settings.json` and safeStorage secrets.
- Runtime Electron 43.2.0 / Node 24.18.0: `registerHooks` is available.

## Defaults and root-cause findings

Adapter defaults (`src/main/agent/arcEval/harnessAdapter.ts`):

- `DEFAULT_TIMEOUT_MS = 300_000` — 300 s per candidate, overall.
- `DEFAULT_MAX_OUTPUT_TOKENS = 16_384`.
- Harness solver = initial attempt + parse-validated repair rounds (default 1 extra round). Zero-shot = single bare completion, no repair, no tools.

Dominant failure mode — reasoning exhaustion. On the custom host, the model burns the entire 16,384-token output budget on ~30k chars of reasoning deltas with zero text output, then dies with:

```
round 1 reply was empty (stopReason: length, 29,564–38,689 reasoning chars, 16384 output tokens, maxOutputTokens 16384)
```

The repair round then hits the 300 s per-candidate deadline and aborts (`AbortError: Aborted`, durationMs ≈ 300,003–300,007). This — not grid-parsing — is the dominant harness failure mode: it wiped out all 3 candidates on 6 of 20 tasks in the benchmark run below.

Related root cause: `thinking: false` is a no-op on custom hosts (the custom OpenAI-compat path ignores the disabled-thinking flag). That is why `--reasoning-effort` exists — it sends an explicit effort value instead of trying to disable thinking.

## Results (2026-09-08)

Run: 20 training tasks (first 20 of the sorted training split), 3 candidates per task, majority-vote aggregation, concurrency 4 — 60 real completions. Settings: provider `custom`, model `@cf/zai-org/glm-5.3` (label `<settings>`). Wall time 2,733,368 ms (~45.6 min); summed per-candidate time 9,804,094 ms. startedAt 2026-09-08T10:35:22.487Z.

| Metric | Score |
|---|---|
| Zero-shot baseline (same 20 tasks, same settings) | 45.0% (9/20) |
| Harness pass@1 (first candidate correct) | 55.0% (11/20) |
| Harness pass@vote (majority vote correct) | 65.0% (13/20) |

Per-task (pass1 / passVote / errored candidates):

| Task | pass@1 | pass@vote | Errored |
|---|---|---|---|
| 007bbfb7 | yes | yes | 0 |
| 00d62c1b | no | no | 3 |
| 017c7c7b | yes | yes | 0 |
| 025d127b | yes | yes | 2 |
| 045e512c | no | no | 3 |
| 0520fde7 | yes | yes | 0 |
| 05269061 | yes | yes | 1 |
| 05f2a901 | yes | yes | 0 |
| 06df4c85 | no | no | 3 |
| 08ed6ac7 | yes | yes | 0 |
| 09629e4f | no | no | 3 |
| 0962bcdd | yes | yes | 0 |
| 0a938d79 | yes | yes | 0 |
| 0b148d64 | yes | yes | 0 |
| 0ca9ddb6 | no | yes | 0 |
| 0d3d703e | yes | yes | 0 |
| 0dfd9992 | no | yes | 1 |
| 0e206a2e | no | no | 3 |
| 10fcaaa3 | no | no | 3 |
| 11852cab | no | no | 0 |

Vote flips (pass1 fail → vote pass): 0ca9ddb6, 0dfd9992. Fan-out + majority vote added +10 points over pass@1 on this run.

Error diagnostics:

- 6 tasks lost all 3 candidates to reasoning exhaustion: 00d62c1b, 045e512c, 06df4c85, 09629e4f, 0e206a2e, 10fcaaa3.
- Partial: 025d127b (2/3 errored but candidate 0 passed), 05269061 (1/3), 0dfd9992 (1/3, vote still passed).
- 11852cab: 3 clean candidates, all wrong — genuine reasoning failure, no errors.

The run exited with code 1 even though the report was fully written: the "report written" line prints immediately before `app.exit(0)` in `scripts/arc-agi/electron-eval-main.mjs`, no FATAL was printed — a teardown-time non-zero exit. The on-disk JSON is complete and valid.

Report: `test-results/arc-eval/benchmark-harness.json` (git-ignored). Fields: `startedAt`, `model`, `taskCount`, `candidateCount`, `results[]` (per-task: `taskId`, `candidates[]` with `prediction` or `error` + `durationMs`, `voted`, `pass1`, `passVote`), `pass1Rate` 0.55, `passVoteRate` 0.65, `totalDurationMs`.

## Reading the result

pass@vote (65%) > pass@1 (55%) > zero-shot (45%): multi-candidate voting lifts accuracy on this stack. The residual headroom is dominated by reasoning exhaustion, not voting disagreement.
