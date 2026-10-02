/**
 * Shared helpers for coding-eval checkers (scripts/evals/coding/<task>/check.mjs).
 *
 * A checker scores a finished workspace deterministically. It is run as
 *   node check.mjs --workspace <dir> --fixture <taskDir> [--answer <file>]
 * and reports through `createChecker().finish()`: one marker line
 *   EVAL_CHECK_RESULT {"pass":bool,"checks":[{"name","ok","detail"?}]}
 * on stdout, exit 0 when every check passed and 1 otherwise. Any other exit
 * (a crash) is scored as a checker error by the runner, never as a pass.
 *
 * Checkers never write inside the workspace. Anything they need to execute in
 * a modified copy goes to their own fresh mkdtemp dir, removed afterwards.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

export const RESULT_MARKER = 'EVAL_CHECK_RESULT '

/** Folders the harness or tooling may create in a workspace; never scored. */
const IGNORED_DIRS = new Set(['.vyotiq', '.git', 'node_modules'])

/** Parse the checker CLI contract. The answer is read eagerly ('' when absent). */
export function parseCheckArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      fixture: { type: 'string' },
      answer: { type: 'string' }
    },
    strict: false
  })
  if (typeof values.workspace !== 'string' || typeof values.fixture !== 'string') {
    throw new Error('usage: check.mjs --workspace <dir> --fixture <taskDir> [--answer <file>]')
  }
  const answerPath = typeof values.answer === 'string' ? values.answer : null
  return {
    workspace: resolve(values.workspace),
    fixture: resolve(values.fixture),
    repo: join(resolve(values.fixture), 'repo'),
    answer: answerPath && existsSync(answerPath) ? readFileSync(answerPath, 'utf8') : ''
  }
}

/** Collects named checks and prints the single result line. */
export function createChecker() {
  const checks = []
  return {
    check(name, ok, detail) {
      const entry = { name, ok: Boolean(ok) }
      if (!ok && detail) entry.detail = String(detail).slice(0, 2000)
      checks.push(entry)
      return Boolean(ok)
    },
    finish() {
      const pass = checks.length > 0 && checks.every((c) => c.ok)
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ pass, checks })}\n`)
      process.exit(pass ? 0 : 1)
    }
  }
}

/** Text with CRLF folded to LF, or null when the file is missing. */
export function readText(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Fixture source files may carry a `.fixture` suffix so instruction files
 * (AGENTS.md) do not apply to this repo itself; the runner strips it on copy.
 */
function fixtureName(rel) {
  return rel.endsWith('.fixture') ? rel.slice(0, -'.fixture'.length) : rel
}

/** Workspace-relative POSIX paths of every file under `dir`, ignoring tool folders. */
export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      out.push(...listFiles(join(dir, entry.name), base))
    } else if (entry.isFile()) {
      out.push(relative(base, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return out.sort()
}

/**
 * Files under `subdir` of the fixture repo that are missing or differ in the
 * workspace (line endings ignored). Empty array means untouched. Pass '' for
 * the whole repo; `allowAdded` false also reports files the workspace added.
 */
export function changedFiles(workspace, repo, subdir = '', { allowAdded = true } = {}) {
  const problems = []
  const fixtureFiles = listFiles(join(repo, subdir)).map((rel) => (subdir ? `${subdir}/${rel}` : rel))
  const expected = new Set()
  for (const rel of fixtureFiles) {
    const target = fixtureName(rel)
    expected.add(target)
    const want = readText(join(repo, rel))
    const got = readText(join(workspace, target))
    if (got === null) problems.push(`${target} (deleted)`)
    else if (got !== want) problems.push(`${target} (modified)`)
  }
  if (!allowAdded) {
    for (const rel of listFiles(join(workspace, subdir))) {
      const target = subdir ? `${subdir}/${rel}` : rel
      if (!expected.has(target)) problems.push(`${target} (added)`)
    }
  }
  return problems
}

/** Bounded tail of process output for check details. */
function tail(text, max = 1500) {
  const s = String(text ?? '')
  return s.length > max ? `...${s.slice(-max)}` : s
}

/** Environment for child Node processes: no inherited test-runner or loader flags. */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_OPTIONS
  delete env.NODE_TEST_CONTEXT
  return env
}

/**
 * `node --test` in `cwd` (default discovery when `files` is empty).
 * Returns { ok, output }.
 */
export function runNodeTest(cwd, files = [], extraEnv = {}) {
  const res = spawnSync(process.execPath, ['--test', ...files], {
    cwd,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.error) return { ok: false, output: `${res.error.message}\n${tail(output)}` }
  return { ok: res.status === 0, output: tail(output) }
}

/** Run a Node script (args after the script) in `cwd`. Returns { ok, status, output }. */
export function runNode(cwd, args, extraEnv = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.error) return { ok: false, status: null, output: `${res.error.message}\n${tail(output)}` }
  return { ok: res.status === 0, status: res.status, output: tail(output) }
}

/**
 * Run the task's hidden behaviour tests (fixture `hidden/<file>`) against the
 * workspace. Hidden tests import workspace modules via $EVAL_WORKSPACE.
 */
export function runHiddenTests(fixture, workspace, file = 'behavior.mjs') {
  const path = join(fixture, 'hidden', file)
  return runNodeTest(join(fixture, 'hidden'), [path], { EVAL_WORKSPACE: workspace })
}

/**
 * Copy the workspace to a private temp dir, let `mutate(dir)` change it, run
 * `fn(dir)`, and always remove the copy. Only the dir this call created is
 * removed — the OS temp dir is shared.
 */
export function withWorkspaceCopy(workspace, mutate, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-eval-check-'))
  try {
    cpSync(workspace, dir, {
      recursive: true,
      filter: (src) => !relative(workspace, src).split(sep).some((part) => IGNORED_DIRS.has(part))
    })
    mutate(dir)
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** True when `path` exists and is a regular file. */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
