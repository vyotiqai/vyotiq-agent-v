/**
 * ARC-AGI Electron main entry (Wave 4).
 *
 * Runs the harness-mode eval in-process so `harnessAdapter.ts`'s import
 * chain (`@main/settings/secrets` -> `electron` safeStorage, real settings)
 * resolves against the real app data. No window; the app exits via
 * app.exit(code) when the eval finishes.
 *
 * Launch (PowerShell, from the worktree root):
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
 *   node_modules/.bin/electron.cmd scripts/arc-agi/electron-eval-main.mjs [flags]
 *
 * (The ELECTRON_RUN_AS_NODE unset is required: if the agent host exports it,
 * the electron binary silently degrades to plain Node and 'electron' cannot
 * be imported — see AGENTS.md.)
 *
 * Same flags as run-eval.mjs:
 *   --tasks N         max tasks to run          (default 3)
 *   --candidates N    candidates per task       (default 1)
 *   --subset S        train|evaluation          (default train)
 *   --out FILE        report path               (default test-results/arc-eval/electron-smoke-report.json)
 *   --solver S        harness|zero-shot         (default harness)
 *   --model LABEL     model label               (default '<settings>')
 *   --concurrency N   tasks in flight at once   (default 2)
 *   --max-tokens N    per-completion output token cap (default: adapter's)
 *   --timeout-ms N    per-candidate overall deadline ms (default: adapter's)
 *   --reasoning-effort S  minimal|low|medium|high|xhigh|max — sends an explicit
 *                        reasoning effort instead of disabled thinking (default: off)
 *
 * Exit code 0 = a report was produced (a 0% pass rate is a valid result);
 * 1 = runtime/provider/setup error before a report could be built.
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerResolveShim } from './resolve-shim.mjs'
import {
  SUBSETS,
  workspaceRoot,
  parseArgs,
  resolveDataDir,
  ensureDataset,
  loadTasks
} from './eval-lib.mjs'

/**
 * Launched as `electron scripts/arc-agi/electron-eval-main.mjs`, Electron gets
 * no package.json app name, so userData would default to %APPDATA%/Electron
 * (verified: the first run created an empty %APPDATA%/Electron and the adapter
 * fell back to default settings -> ollama -> ECONNREFUSED 127.0.0.1:11434).
 * Point it at the real app's userData (package.json "name") so the adapter
 * reads the real settings.json and safeStorage secrets.
 */
const realAppName = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).name
app.setPath('userData', join(app.getPath('appData'), String(realAppName)))

app.disableHardwareAcceleration()
// No windows are ever created; never quit (or linger) on window events —
// app.exit() below is the only exit path.
app.on('window-all-closed', () => {})

/**
 * process.argv in an Electron main started as `electron <script> [flags]` is
 * [exe, <script>, ...flags], but Electron may also inject its own switches
 * before the script path. Anchor on this file's own path, fall back to slice(2).
 */
function userArgv() {
  const self = import.meta.filename.replaceAll('\\', '/')
  const marker = process.argv.findIndex((a) => a.replaceAll('\\', '/') === self)
  return marker >= 0 ? process.argv.slice(marker + 1) : process.argv.slice(2)
}

async function run() {
  const flags = parseArgs(userArgv())
  const maxTasks = Number.parseInt(flags.tasks ?? '3', 10)
  const candidateCount = Number.parseInt(flags.candidates ?? '1', 10)
  const concurrency = Number.parseInt(flags.concurrency ?? '2', 10)
  const maxTokens =
    flags['max-tokens'] !== undefined ? Number.parseInt(String(flags['max-tokens']), 10) : undefined
  const timeoutMs =
    flags['timeout-ms'] !== undefined ? Number.parseInt(String(flags['timeout-ms']), 10) : undefined
  const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const reasoningEffort =
    flags['reasoning-effort'] !== undefined ? String(flags['reasoning-effort']) : undefined
  if (reasoningEffort !== undefined && !REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`--reasoning-effort must be one of ${REASONING_EFFORTS.join('|')}, got: ${reasoningEffort}`)
  }
  const responseFormat = flags['response-format'] === true
  const subset = flags.subset ?? 'train'
  const solverName = flags.solver ?? 'harness'
  const outPath = flags.out
    ? resolve(String(flags.out))
    : resolve(workspaceRoot, 'test-results/arc-eval/electron-smoke-report.json')

  if (!Number.isFinite(maxTasks) || maxTasks < 1) throw new Error(`--tasks must be a positive integer, got: ${flags.tasks}`)
  if (!Number.isFinite(candidateCount) || candidateCount < 1) throw new Error(`--candidates must be a positive integer, got: ${flags.candidates}`)
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive integer, got: ${flags.concurrency}`)
  if (!(subset in SUBSETS)) throw new Error(`--subset must be train|evaluation, got: ${subset}`)
  if (solverName !== 'harness' && solverName !== 'zero-shot') {
    throw new Error(`--solver must be harness|zero-shot, got: ${solverName}`)
  }

  if (!registerResolveShim()) {
    throw new Error('node:module registerHooks is unavailable in this runtime — cannot resolve the TS sources')
  }

  // Dynamic imports: the resolve shim must be registered before the TS
  // modules' extensionless relative imports are resolved.
  const adapterUrl = pathToFileURL(join(workspaceRoot, 'src/main/agent/arcEval/harnessAdapter.ts')).href
  const [{ solveTask, solveTaskZeroShot, arcGridResponseFormat }, { runEvalTasks }, { buildReport, formatConsole, writeJsonReport }] =
    await Promise.all([
      import(adapterUrl),
      import('../../src/main/agent/arcEval/orchestrator.ts'),
      import('../../src/main/agent/arcEval/report.ts')
    ])
  const solve = solverName === 'zero-shot' ? solveTaskZeroShot : solveTask
  if (typeof solve !== 'function') throw new Error(`harnessAdapter.ts has no ${solverName} export`)

  const dataDir = resolveDataDir()
  const splitDir = join(dataDir, SUBSETS[subset])
  await ensureDataset(dataDir, splitDir)
  const tasks = loadTasks(dataDir, subset, maxTasks)
  console.log(`[arc-agi] electron ${process.versions.electron} / node ${process.versions.node} — loaded ${tasks.length} task(s) from ${splitDir}`)
  console.log(`[arc-agi] userData: ${app.getPath('userData')} (settings + safeStorage secrets source)`)

  const solver = (task, candidateIndex) =>
    solve(task, {
      index: candidateIndex,
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(responseFormat ? { responseFormat: arcGridResponseFormat() } : {})
    })
  const model = flags.model ? String(flags.model) : '<settings>'
  const startedAt = new Date().toISOString()
  const t0 = performance.now()
  const results = await runEvalTasks(tasks, solver, { candidateCount, concurrency, model })
  const wallMs = Math.round(performance.now() - t0)

  const report = buildReport(results, { model, candidateCount, startedAt })
  await writeJsonReport(report, outPath)
  console.log(formatConsole(report))
  console.log(`\n[arc-agi] wall time: ${wallMs} ms — report written to ${outPath}`)
  app.exit(0)
}

app.whenReady().then(run).catch((err) => {
  console.error(`[arc-agi] FATAL: ${err?.stack ?? err}`)
  app.exit(1)
})
process.on('uncaughtException', (err) => {
  console.error(`[arc-agi] FATAL (uncaught): ${err?.stack ?? err}`)
  app.exit(1)
})
