/**
 * Shared eval-runner helpers (Wave 4): CLI flag parsing, dataset resolution,
 * ARC task loading, and the deterministic stub solver. Used by both
 * run-eval.mjs (plain Node CLI) and electron-eval-main.mjs (Electron main
 * entry) so there is ONE task-loading path.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(scriptDir, '..', '..')

const SUBSETS = { train: 'training', evaluation: 'evaluation' }

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'help' || key === 'h') {
      flags.help = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

function usage() {
  console.log(`Usage: node scripts/arc-agi/run-eval.mjs [flags]
  --tasks N         max tasks to run          (default 10)
  --candidates N    candidates per task       (default 1)
  --subset S        train|evaluation          (default train)
  --out FILE        report path               (default test-results/arc-eval/report.json)
  --solver S        stub|harness|zero-shot    (default harness)
  --model LABEL     model label               (default 'stub' for stub)
  --concurrency N   tasks in flight at once   (default 4)`)
}

function resolveDataDir() {
  if (process.env.VYOTIQ_ARC_DATA_DIR) {
    return resolve(process.env.VYOTIQ_ARC_DATA_DIR)
  }
  return resolve(workspaceRoot, 'test-results/arc-agi')
}

async function ensureDataset(dataDir, splitDir) {
  if (existsSync(splitDir)) {
    const files = readdirSync(splitDir).filter((f) => f.endsWith('.json'))
    if (files.length > 0) return
  }
  console.log(`[arc-agi] dataset missing at ${splitDir} — running fetch-dataset.mjs ...`)
  const result = await new Promise((resolveSpawn) => {
    const child = spawn(
      process.execPath,
      [join(scriptDir, 'fetch-dataset.mjs')],
      { stdio: 'inherit', cwd: workspaceRoot }
    )
    child.on('exit', (code) => resolveSpawn(code))
    child.on('error', (err) => {
      console.error(`[arc-agi] FATAL: could not spawn fetch-dataset.mjs — ${err?.message ?? err}`)
      resolveSpawn(1)
    })
  })
  if (result !== 0) {
    console.error(`[arc-agi] FATAL: dataset fetch failed with exit code ${result} — see output above for the real error`)
    process.exit(1)
  }
}

function loadTasks(dataDir, subset, maxTasks) {
  const splitDir = join(dataDir, SUBSETS[subset])
  if (!existsSync(splitDir)) {
    console.error(`[arc-agi] FATAL: split directory not found: ${splitDir}`)
    process.exit(1)
  }
  const files = readdirSync(splitDir).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    console.error(`[arc-agi] FATAL: no JSON task files in ${splitDir}`)
    process.exit(1)
  }
  const selected = files.slice(0, maxTasks)
  return selected.map((name) => {
    const raw = JSON.parse(readFileSync(join(splitDir, name), 'utf8'))
    return {
      id: name.replace(/\.json$/, ''),
      train: raw.train,
      test: raw.test
    }
  })
}

/** Deterministic PRNG (mulberry32) so stub votes are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Stub solver: deterministic pseudo-random grids seeded from
 * `<taskId>:<candidateIndex>` (mulberry32), so vote math is reproducible.
 *
 * Expected math (documented and asserted in orchestrator.test.ts):
 *   - candidate 0 always replays the expected output grid exactly
 *     -> pass1 = true for every task, so pass1Rate = 1.0
 *   - candidates >= 1 emit seeded random grids over the same shape; the
 *     chance of any of them equaling each other or the expected grid is
 *     negligible and fixed by the seeds
 *   - majorityVote over [correct, w1, w2, ...] is an all-ones tie, which
 *     resolves by first-to-count -> candidate 0's correct grid wins
 *     -> passVote = true for every task, so passVoteRate = 1.0
 */
function makeStubSolver() {
  return async (task, candidateIndex) => {
    const started = performance.now()
    const expected = task.test[0]?.output ?? null
    let prediction = null
    if (expected) {
      if (candidateIndex === 0) {
        prediction = expected.map((row) => [...row])
      } else {
        const rand = mulberry32(hashString(`${task.id}:${candidateIndex}`))
        prediction = expected.map((row) => row.map(() => Math.floor(rand() * 10)))
      }
    }
    return {
      index: candidateIndex,
      prediction,
      durationMs: Math.round(performance.now() - started)
    }
  }
}

export {
  SUBSETS,
  workspaceRoot,
  parseArgs,
  usage,
  resolveDataDir,
  ensureDataset,
  loadTasks,
  makeStubSolver
}
