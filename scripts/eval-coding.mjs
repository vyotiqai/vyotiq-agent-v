#!/usr/bin/env node
/**
 * Coding regression eval for VYOTIQ's agent harness (docs/evals.md).
 *
 * Runs every task fixture under scripts/evals/coding/ through the REAL agent
 * loop (src/main/agent/loop.ts runAgent, driven headless by
 * src/main/agent/codingEval/loopSolver.ts), scores each finished workspace
 * with the task's check.mjs, and writes report.json + report.md.
 *
 *   pnpm eval:coding --self-check                 # no model: prove every checker
 *   pnpm eval:coding                              # all tasks, configured provider/model
 *   pnpm eval:coding --filter fix- --repeat 3     # flakiness
 *   pnpm eval:coding --compare test-results/eval-coding/<run>/report.json
 *
 * Flags:
 *   --self-check          untouched repo must FAIL, solution/ must PASS; no model, no cost
 *   --filter a,b          only tasks whose id contains any entry
 *   --repeat N            attempts per task (default 1)
 *   --provider ID         provider override (default: the app's settings)
 *   --model ID            model override (default: the app's settings)
 *   --max-steps N         step cap per attempt (default: task.json maxSteps)
 *   --timeout-sec N       wall-clock cap per attempt (default: task.json timeoutSec)
 *   --max-cost USD        spend cap per attempt (default: task.json maxCostUsd, else none)
 *   --approve safe|all    headless approvals: safe denies danger-held commands (default safe)
 *   --done-when           also pass task.json done_when to the run as brief checks
 *   --keep never|failed|always   keep attempt workspaces (default failed)
 *   --out DIR             report dir (default test-results/eval-coding/<timestamp>)
 *   --compare FILE|DIR    an earlier report.json: regressions are listed and exit code is 2
 *   --label TEXT          name for this run in reports and comparisons
 *   --runtime electron|node   electron (default) can read saved API keys; node runs
 *                         without Electron for providers that need no key (e.g. ollama)
 *   --user-data DIR       app data to copy settings/keys from (default: <appData>/vyotiq)
 *   --keep-mcp            keep the configured MCP servers (default: removed for the eval)
 *   --verbose             print each tool call as it starts
 *
 * Isolation: each run gets its own temp userData (a copy of settings.json,
 * secrets.json, Local State and the model catalog cache — never the real
 * one, so eval sessions never land in the app's history) and its own temp
 * scratch root for workspaces. Only those two directories are ever removed.
 *
 * Exit: 0 report written (failing tasks are a result, not an error);
 * 1 setup/runtime error or a bad fixture in --self-check; 2 --compare found
 * regressions.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { registerEvalHooks, workspaceRoot } from './evals/ts-hooks.mjs'

const TASKS_ROOT = join(workspaceRoot, 'scripts', 'evals', 'coding')
const USER_DATA_ENV = 'VYOTIQ_EVAL_USER_DATA'
const COPIED_USER_DATA = ['settings.json', 'secrets.json', 'Local State', 'model-catalog-cache.json']

function userArgv() {
  // Under Electron, argv is [exe, ...switches, script, ...flags]; anchor on this file.
  const self = import.meta.filename.replaceAll('\\', '/').toLowerCase()
  const at = process.argv.findIndex((a) => a.replaceAll('\\', '/').toLowerCase() === self)
  return at >= 0 ? process.argv.slice(at + 1) : process.argv.slice(2)
}

function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'self-check': { type: 'boolean' },
      filter: { type: 'string' },
      repeat: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'max-steps': { type: 'string' },
      'timeout-sec': { type: 'string' },
      'max-cost': { type: 'string' },
      approve: { type: 'string' },
      'done-when': { type: 'boolean' },
      keep: { type: 'string' },
      out: { type: 'string' },
      compare: { type: 'string' },
      label: { type: 'string' },
      runtime: { type: 'string' },
      'user-data': { type: 'string' },
      'keep-mcp': { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  return values
}

function positiveInt(value, flag) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got ${value}`)
  return n
}

function positiveNumber(value, flag) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!(n > 0)) throw new Error(`${flag} must be a positive number, got ${value}`)
  return n
}

function oneOf(value, allowed, flag, fallback) {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) throw new Error(`${flag} must be one of ${allowed.join('|')}, got ${value}`)
  return value
}

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

function realAppName() {
  return JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).name
}

/** A fresh userData holding copies of the app's settings and keys; MCP servers dropped unless asked. */
function prepareUserData(flags) {
  const source = resolve(flags['user-data'] ?? join(appDataDir(), realAppName()))
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-eval-userdata-'))
  const copied = []
  for (const name of COPIED_USER_DATA) {
    const from = join(source, name)
    if (existsSync(from) && statSync(from).isFile()) {
      copyFileSync(from, join(dir, name))
      copied.push(name)
    }
  }
  const settingsFile = join(dir, 'settings.json')
  if (!flags['keep-mcp'] && existsSync(settingsFile)) {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
    if (Array.isArray(settings.mcpServers) && settings.mcpServers.length) {
      settings.mcpServers = []
      writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
    }
  }
  console.log(`[eval] userData copy: ${dir} (from ${source}: ${copied.join(', ') || 'nothing — app defaults'})`)
  return dir
}

function removeOwnDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    console.warn(`[eval] could not remove ${dir}: ${err?.message ?? err}`)
  }
}

function gitSha() {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true })
  return res.status === 0 ? res.stdout.trim() : undefined
}

async function importSrc(rel) {
  return import(pathToFileURL(join(workspaceRoot, rel)).href)
}

async function selfCheck(flags) {
  if (!registerEvalHooks()) throw new Error('this Node lacks module.registerHooks/stripTypeScriptTypes (need Node >= 22.18)')
  const { loadCodingTasks } = await importSrc('src/main/agent/codingEval/tasks.ts')
  const { selfCheckFixtures } = await importSrc('src/main/agent/codingEval/runner.ts')
  const tasks = loadCodingTasks(TASKS_ROOT, flags.filter)
  console.log(`[self-check] ${tasks.length} task(s) from ${TASKS_ROOT}`)
  const results = await selfCheckFixtures(tasks, { concurrency: 4, onProgress: (l) => console.log(l) })
  const bad = results.filter((r) => !r.ok)
  console.log(`[self-check] ${results.length - bad.length}/${results.length} checkers proven (baseline fails, solution passes)`)
  return bad.length ? 1 : 0
}

/** The eval itself; runs in the process that hosts the loop (Electron main or plain Node). */
async function runEval(flags, userData) {
  const keep = oneOf(flags.keep, ['never', 'failed', 'always'], '--keep', 'failed')
  const approve = oneOf(flags.approve, ['safe', 'all'], '--approve', 'safe')
  const repeat = positiveInt(flags.repeat, '--repeat') ?? 1
  const caps = {
    ...(flags['max-steps'] ? { maxSteps: positiveInt(flags['max-steps'], '--max-steps') } : {}),
    ...(flags['timeout-sec'] ? { timeoutSec: positiveInt(flags['timeout-sec'], '--timeout-sec') } : {}),
    ...(flags['max-cost'] ? { maxCostUsd: positiveNumber(flags['max-cost'], '--max-cost') } : {})
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = resolve(flags.out ?? join(workspaceRoot, 'test-results', 'eval-coding', flags.label ? `${stamp}-${flags.label.replace(/[^\w.-]+/g, '_')}` : stamp))

  const { loadCodingTasks } = await importSrc('src/main/agent/codingEval/tasks.ts')
  const { runCodingEval } = await importSrc('src/main/agent/codingEval/runner.ts')
  const report = await importSrc('src/main/agent/codingEval/report.ts')
  const { createLoopSolver } = await importSrc('src/main/agent/codingEval/loopSolver.ts')
  const { getSettings } = await importSrc('src/main/settings/settings.ts')

  const tasks = loadCodingTasks(TASKS_ROOT, flags.filter)
  if (tasks.length === 0) throw new Error(`no task matches --filter ${flags.filter}`)
  const settings = getSettings()
  const provider = flags.provider ?? settings.provider
  const model = flags.model ?? settings.model
  if (!model) throw new Error('no model configured: pass --model or pick one in the app first')
  let previous
  if (flags.compare) {
    const path = existsSync(flags.compare) && statSync(flags.compare).isDirectory() ? join(flags.compare, 'report.json') : flags.compare
    previous = report.readCodingEvalReport(resolve(path))
  }
  console.log(`[eval] ${tasks.length} task(s) x ${repeat} on ${provider} / ${model}; approvals ${approve}; userData ${userData}`)

  const solver = createLoopSolver({
    provider,
    model,
    approve,
    passDoneWhen: Boolean(flags['done-when']),
    ...(flags.verbose
      ? {
          onEvent: (ev) => {
            if (ev.type === 'tool_start') console.log(`         - ${ev.name}: ${String(ev.summary).slice(0, 140)}`)
          }
        }
      : {})
  })
  const result = await runCodingEval({
    tasks,
    solver,
    outDir,
    repeat,
    caps,
    keep,
    provider,
    model,
    ...(flags.label ? { label: flags.label } : {}),
    ...(gitSha() ? { gitSha: gitSha() } : {}),
    onProgress: (l) => console.log(l)
  })
  const comparison = previous ? report.compareReports(previous, result) : undefined
  const written = report.writeCodingEvalReport(outDir, result, comparison)
  console.log(`\n${report.renderCodingEvalMarkdown(result, comparison)}`)
  console.log(`[eval] report: ${written.json}\n[eval]         ${written.markdown}`)
  return comparison && comparison.regressions.length > 0 ? 2 : 0
}

/** Electron main entry: point userData/appPath at the eval's, wait for ready, run. */
async function electronMain(flags) {
  const { app } = await import('electron')
  const userData = process.env[USER_DATA_ENV]
  if (!userData) throw new Error(`${USER_DATA_ENV} is not set; launch through node scripts/eval-coding.mjs`)
  app.setPath('userData', userData)
  // Launched as `electron <script>`, the app path is the script's folder; the
  // loop reads the bundled harness from <appPath>/resources/harness.
  if (typeof app.setAppPath === 'function') app.setAppPath(workspaceRoot)
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})
  if (!registerEvalHooks()) throw new Error('this Electron lacks module.registerHooks/stripTypeScriptTypes')
  await app.whenReady()
  const harness = join(app.getAppPath(), 'resources', 'harness', 'default.md')
  if (!existsSync(harness)) throw new Error(`bundled harness not found at ${harness} — the eval would run on the fallback prompt`)
  console.log(`[eval] electron ${process.versions.electron} / node ${process.versions.node}`)
  return runEval(flags, userData)
}

/** Plain-Node entry with the electron stub (no saved API keys). */
async function nodeMain(flags, userData) {
  globalThis.__VYOTIQ_EVAL_ELECTRON__ = { userData, appPath: workspaceRoot }
  // Some dependencies branch on process.versions.electron at import time.
  if (!process.versions.electron) {
    Object.defineProperty(process.versions, 'electron', { value: '0.0.0-stub', enumerable: true })
  }
  if (!registerEvalHooks({ electronStub: true })) {
    throw new Error('this Node lacks module.registerHooks/stripTypeScriptTypes (need Node >= 22.18)')
  }
  return runEval(flags, userData)
}

/** Launcher: prepare userData, run Electron with this script, clean up after it exits. */
async function launchElectron(flags, argv) {
  const electronPath = createRequire(import.meta.url)('electron')
  if (typeof electronPath !== 'string') throw new Error('could not resolve the electron binary')
  const userData = prepareUserData(flags)
  const env = { ...process.env, [USER_DATA_ENV]: userData }
  // If set, the binary silently runs as plain Node and 'electron' cannot be imported.
  delete env.ELECTRON_RUN_AS_NODE
  try {
    return await new Promise((resolveExit) => {
      const child = spawn(electronPath, [import.meta.filename, ...argv], { stdio: 'inherit', env, windowsHide: true })
      child.on('error', (err) => {
        console.error(`[eval] could not start Electron: ${err.message}`)
        resolveExit(1)
      })
      child.on('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
    })
  } finally {
    removeOwnDir(userData)
  }
}

async function main() {
  const argv = userArgv()
  const flags = parseFlags(argv)
  if (flags.help) {
    const doc = readFileSync(import.meta.filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? ''
    console.log(doc.replace(/^ \* ?/gm, ''))
    return 0
  }
  if (flags['self-check']) return selfCheck(flags)
  if (process.versions.electron) return electronMain(flags)
  const runtime = oneOf(flags.runtime, ['electron', 'node'], '--runtime', 'electron')
  if (runtime === 'electron') return launchElectron(flags, argv)
  const userData = prepareUserData(flags)
  try {
    return await nodeMain(flags, userData)
  } finally {
    removeOwnDir(userData)
  }
}

const inElectron = Boolean(process.versions.electron)
main().then(
  async (code) => {
    if (inElectron) (await import('electron')).app.exit(code)
    else process.exit(code)
  },
  async (err) => {
    console.error(`[eval] FATAL: ${err?.stack ?? err}`)
    if (inElectron) (await import('electron')).app.exit(1)
    else process.exit(1)
  }
)
