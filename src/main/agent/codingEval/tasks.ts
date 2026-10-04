import { spawnSync } from 'child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { nodeBinary, nodeChildEnv } from './check'
import type { CodingEvalMode, CodingEvalTask } from './types'

/**
 * Fixture loading and workspace preparation for the coding eval.
 *
 * A fixture is `<root>/<id>/` with task.json, check.mjs and repo/. Dirs whose
 * name starts with `_` (shared checker helpers) are not tasks.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Files stored as `<name>.fixture` are copied as `<name>`: an AGENTS.md that
 * lives in this repo as a plain AGENTS.md would be applied to the repo's own
 * agents as a nested instruction file.
 */
const FIXTURE_SUFFIX = '.fixture'

function asPositiveInt(value: unknown, field: string, file: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${file}: ${field} must be a positive integer`)
  }
  return value
}

/** Parse and validate one task.json. Throws with the file name on any problem. */
export function parseTaskFile(dir: string): CodingEvalTask {
  const file = join(dir, 'task.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: not an object`)
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) throw new Error(`${file}: id must match ${ID_RE}`)
  const folder = dir.split(sep).pop()
  if (t.id !== folder) throw new Error(`${file}: id "${t.id}" must equal its folder name "${folder}"`)
  if (typeof t.instruction !== 'string' || !t.instruction.trim()) throw new Error(`${file}: instruction is required`)
  if (!Array.isArray(t.done_when) || t.done_when.length === 0 || !t.done_when.every((d) => typeof d === 'string' && d.trim())) {
    throw new Error(`${file}: done_when must be a non-empty string array`)
  }
  const mode: CodingEvalMode = t.mode === undefined ? 'agent' : (t.mode as CodingEvalMode)
  if (mode !== 'agent' && mode !== 'ask') throw new Error(`${file}: mode must be "agent" or "ask"`)
  let maxCostUsd: number | undefined
  if (t.maxCostUsd !== undefined) {
    if (typeof t.maxCostUsd !== 'number' || !(t.maxCostUsd > 0)) throw new Error(`${file}: maxCostUsd must be a positive number`)
    maxCostUsd = t.maxCostUsd
  }
  if (!existsSync(join(dir, 'check.mjs'))) throw new Error(`${dir}: check.mjs is missing`)
  if (!existsSync(join(dir, 'repo'))) throw new Error(`${dir}: repo/ is missing`)
  return {
    id: t.id,
    dir,
    instruction: t.instruction.trim(),
    doneWhen: t.done_when as string[],
    timeoutSec: asPositiveInt(t.timeoutSec, 'timeoutSec', file),
    maxSteps: asPositiveInt(t.maxSteps, 'maxSteps', file),
    mode,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(typeof t.category === 'string' ? { category: t.category } : {})
  }
}

/**
 * `filter` is a comma-separated list; a task is kept when its id contains any
 * entry (case-insensitive). Empty or undefined keeps everything.
 */
export function matchesFilter(id: string, filter: string | undefined): boolean {
  const parts = (filter ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  return parts.length === 0 || parts.some((p) => id.toLowerCase().includes(p))
}

/** Every task under `root`, sorted by id, filtered. */
export function loadCodingTasks(root: string, filter?: string): CodingEvalTask[] {
  const tasks: CodingEvalTask[] = []
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    if (!matchesFilter(name, filter)) continue
    tasks.push(parseTaskFile(dir))
  }
  return tasks
}

/**
 * Fold CRLF to LF in the copied text files. A CRLF checkout (git
 * `core.autocrlf=true` on a Windows runner) would otherwise hand a solver a
 * workspace whose bytes differ from the fixture, so a correct fix that matches
 * the fixture text line for line fails for a reason no OS should have.
 */
function foldLineEndings(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      foldLineEndings(path)
      continue
    }
    if (!entry.isFile()) continue
    const bytes = readFileSync(path)
    if (!bytes.includes(0x0d) || bytes.includes(0)) continue
    writeFileSync(path, bytes.toString('utf8').replace(/\r\n/g, '\n'))
  }
}

/** Copy `from` into `to` (merging), then drop the `.fixture` suffix from copied names. */
function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, force: true })
  foldLineEndings(to)
  const strip = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) strip(path)
      else if (entry.name.endsWith(FIXTURE_SUFFIX)) {
        renameSync(path, path.slice(0, -FIXTURE_SUFFIX.length))
      }
    }
  }
  strip(to)
}

/**
 * A fresh workspace for one attempt: a new mkdtemp dir under `parentDir`
 * (the run's own scratch root) holding a copy of the fixture's repo/.
 */
export function prepareWorkspace(task: CodingEvalTask, parentDir: string): string {
  const workspace = mkdtempSync(join(parentDir, `${task.id}-`))
  copyTree(join(task.dir, 'repo'), workspace)
  return workspace
}

function insideWorkspace(workspace: string, rel: string): string {
  const target = resolve(workspace, rel)
  const back = relative(workspace, target)
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new Error(`solution path escapes the workspace: ${rel}`)
  return target
}

/** Whether the fixture ships a reference solution. */
export function hasSolution(task: CodingEvalTask): boolean {
  return existsSync(join(task.dir, 'solution'))
}

/**
 * Apply the fixture's reference solution to a prepared workspace: overlay
 * solution/repo/, remove solution/delete.json paths, run solution/commands.json
 * (Node argv lists, run in the workspace). Returns the reference answer
 * (solution/answer.md) or ''.
 */
export function applySolution(task: CodingEvalTask, workspace: string): string {
  const solution = join(task.dir, 'solution')
  const overlay = join(solution, 'repo')
  if (existsSync(overlay)) copyTree(overlay, workspace)
  const deletions = join(solution, 'delete.json')
  if (existsSync(deletions)) {
    const list = JSON.parse(readFileSync(deletions, 'utf8')) as unknown
    if (!Array.isArray(list)) throw new Error(`${deletions}: expected an array of paths`)
    for (const rel of list) rmSync(insideWorkspace(workspace, String(rel)), { recursive: true, force: true })
  }
  const commands = join(solution, 'commands.json')
  if (existsSync(commands)) {
    const list = JSON.parse(readFileSync(commands, 'utf8')) as unknown
    if (!Array.isArray(list)) throw new Error(`${commands}: expected an array of argv arrays`)
    for (const argv of list) {
      if (!Array.isArray(argv)) throw new Error(`${commands}: expected an array of argv arrays`)
      const res = spawnSync(nodeBinary(), argv.map(String), {
        cwd: workspace,
        env: nodeChildEnv(),
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
      })
      if (res.status !== 0) {
        throw new Error(`solution command node ${argv.join(' ')} failed: ${res.error?.message ?? ''}${res.stderr ?? ''}`)
      }
    }
  }
  const answer = join(solution, 'answer.md')
  return existsSync(answer) ? readFileSync(answer, 'utf8') : ''
}
