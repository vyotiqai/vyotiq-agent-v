#!/usr/bin/env node
/**
 * ARC-AGI eval CLI (Wave 2b; Wave 4 refactor: resolve shim lives in
 * resolve-shim.mjs, task loading + stub solver in eval-lib.mjs).
 *
 * Loads ARC tasks, fans out N solver candidates per task through the
 * orchestrator, majority-votes, scores, prints the console report, and
 * writes the JSON report to --out.
 *
 * Flags:
 *   --tasks N         max tasks to run          (default 10)
 *   --candidates N    candidates per task       (default 1)
 *   --subset S        training|evaluation split (default train)
 *   --out FILE        report path               (default test-results/arc-eval/report.json)
 *   --solver S        stub|harness|zero-shot    (default harness)
 *   --model LABEL     model label               (default 'stub' for stub, '<unset>' otherwise)
 *   --concurrency N   tasks in flight at once   (default 4)
 *
 * Dataset resolution: $VYOTIQ_ARC_DATA_DIR/<split>/*.json or
 * test-results/arc-agi/<subset>/*.json. If missing, the real fetcher
 * (scripts/arc-agi/fetch-dataset.mjs) is invoked; any network failure exits
 * non-zero with the real error — no fixtures are ever fabricated.
 *
 * IMPORTANT: --solver harness and --solver zero-shot import src/main modules
 * that transitively import 'electron', so they only work inside a real
 * Electron main process — run them via scripts/arc-agi/electron-eval-main.mjs
 * (see docs/arc-eval.md). Under plain Node they fail on the 'electron'
 * import; that failure is the signal to use the Electron runner.
 *
 * Node >= 22 only; no new dependencies.
 */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerResolveShim } from './resolve-shim.mjs'
import {
  SUBSETS,
  workspaceRoot,
  parseArgs,
  usage,
  resolveDataDir,
  ensureDataset,
  loadTasks,
  makeStubSolver
} from './eval-lib.mjs'

/**
 * registerHooks (in resolve-shim.mjs) must be active before the TS modules'
 * extensionless relative imports are resolved — dynamic imports below, never
 * static ones.
 */
registerResolveShim()

async function loadAdapterSolver(solverName) {
  // harnessAdapter.ts may not exist yet — dynamic import, never a static one,
  // so stub mode works before it lands. No fake scores here.
  try {
    const adapterUrl = pathToFileURL(join(workspaceRoot, 'src/main/agent/arcEval/harnessAdapter.ts')).href
    const mod = await import(adapterUrl)
    const fn = solverName === 'zero-shot' ? mod.solveTaskZeroShot : mod.solveTask
    if (typeof fn !== 'function') {
      throw new Error(`harnessAdapter.ts has no ${solverName === 'zero-shot' ? 'solveTaskZeroShot' : 'solveTask'} export`)
    }
    return (task, candidateIndex) => fn(task, { index: candidateIndex })
  } catch (err) {
    console.error('[arc-agi] harness adapter not available yet:', err?.message ?? err)
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err?.message ?? '').includes("'electron'")) {
      console.error('[arc-agi] harness/zero-shot solvers need a real Electron main process — run scripts/arc-agi/electron-eval-main.mjs instead (docs/arc-eval.md).')
    }
    console.error('[arc-agi] Use --solver stub meanwhile.')
    process.exit(1)
  }
}

async function main() {
  // Dynamic imports: the resolve shim (above) must be active before the TS
  // modules' extensionless relative imports are resolved (see doc block).
  const [{ runEvalTasks }, { buildReport, formatConsole, writeJsonReport }] = await Promise.all([
    import('../../src/main/agent/arcEval/orchestrator.ts'),
    import('../../src/main/agent/arcEval/report.ts')
  ])

  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) {
    usage()
    return
  }

  const maxTasks = Number.parseInt(flags.tasks ?? '10', 10)
  const candidateCount = Number.parseInt(flags.candidates ?? '1', 10)
  const concurrency = Number.parseInt(flags.concurrency ?? '4', 10)
  const subset = flags.subset ?? 'train'
  const solverName = flags.solver ?? 'harness'
  const outPath = flags.out ? resolve(String(flags.out)) : resolve(workspaceRoot, 'test-results/arc-eval/report.json')

  if (!Number.isFinite(maxTasks) || maxTasks < 1) throw new Error(`--tasks must be a positive integer, got: ${flags.tasks}`)
  if (!Number.isFinite(candidateCount) || candidateCount < 1) throw new Error(`--candidates must be a positive integer, got: ${flags.candidates}`)
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive integer, got: ${flags.concurrency}`)
  if (!(subset in SUBSETS)) throw new Error(`--subset must be train|evaluation, got: ${subset}`)
  if (solverName !== 'stub' && solverName !== 'harness' && solverName !== 'zero-shot') {
    throw new Error(`--solver must be stub|harness|zero-shot, got: ${solverName}`)
  }

  const dataDir = resolveDataDir()
  const splitDir = join(dataDir, SUBSETS[subset])
  await ensureDataset(dataDir, splitDir)

  const tasks = loadTasks(dataDir, subset, maxTasks)
  console.log(`[arc-agi] loaded ${tasks.length} task(s) from ${splitDir}`)

  let solver
  if (solverName === 'stub') {
    solver = makeStubSolver()
  } else {
    solver = await loadAdapterSolver(solverName)
  }

  const model = flags.model ? String(flags.model) : solverName === 'stub' ? 'stub' : '<unset>'
  const startedAt = new Date().toISOString()
  const t0 = performance.now()
  const results = await runEvalTasks(tasks, solver, { candidateCount, concurrency, model })
  const wallMs = Math.round(performance.now() - t0)

  const report = buildReport(results, { model, candidateCount, startedAt })
  await writeJsonReport(report, outPath)
  console.log(formatConsole(report))
  console.log(`\n[arc-agi] wall time: ${wallMs} ms — report written to ${outPath}`)
}

main().catch((err) => {
  console.error(`[arc-agi] FATAL: ${err?.stack ?? err}`)
  process.exit(1)
})
