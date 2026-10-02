import { spawn } from 'child_process'
import { join } from 'path'
import type { CheckItem, CheckResult, CodingEvalTask } from './types'

/** Must match RESULT_MARKER in scripts/evals/coding/_lib/check-lib.mjs. */
export const CHECK_RESULT_MARKER = 'EVAL_CHECK_RESULT '

const CHECK_TIMEOUT_MS = 300_000
const MAX_OUTPUT_CHARS = 200_000

/**
 * The Node binary checkers and solution commands run on. Inside Electron,
 * `process.execPath` is the Electron binary, so use `node` from PATH there;
 * VYOTIQ_EVAL_NODE overrides both.
 */
export function nodeBinary(): string {
  const override = process.env.VYOTIQ_EVAL_NODE?.trim()
  if (override) return override
  return process.versions.electron ? 'node' : process.execPath
}

/** Child env without loader/test-runner flags inherited from this process. */
export function nodeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.NODE_OPTIONS
  delete env.NODE_TEST_CONTEXT
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Parse the checker's marker line; null when absent or malformed. */
export function parseCheckOutput(stdout: string): { pass: boolean; checks: CheckItem[] } | null {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(CHECK_RESULT_MARKER))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice(CHECK_RESULT_MARKER.length)) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { pass, checks } = parsed as { pass?: unknown; checks?: unknown }
    if (typeof pass !== 'boolean' || !Array.isArray(checks)) return null
    const items: CheckItem[] = checks
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
      .map((c) => ({
        name: String(c.name ?? ''),
        ok: c.ok === true,
        ...(typeof c.detail === 'string' ? { detail: c.detail } : {})
      }))
    return { pass, checks: items }
  } catch {
    return null
  }
}

/**
 * Run `<task>/check.mjs` against a finished workspace. A pass needs the marker
 * line to say pass, every check ok, AND exit code 0 — a crash is never a pass.
 */
export function runCheck(task: CodingEvalTask, workspace: string, answerFile?: string): Promise<CheckResult> {
  const started = Date.now()
  const args = [join(task.dir, 'check.mjs'), '--workspace', workspace, '--fixture', task.dir]
  if (answerFile) args.push('--answer', answerFile)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: Omit<CheckResult, 'durationMs'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, durationMs: Date.now() - started })
    }
    const child = spawn(nodeBinary(), args, {
      cwd: task.dir,
      env: nodeChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({ pass: false, checks: [], error: `checker timed out after ${CHECK_TIMEOUT_MS} ms` })
    }, CHECK_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString('utf8')
    })
    child.on('error', (err) => finish({ pass: false, checks: [], error: `checker failed to start: ${err.message}` }))
    child.on('close', (code) => {
      const parsed = parseCheckOutput(stdout)
      if (!parsed) {
        finish({
          pass: false,
          checks: [],
          error: `checker exited ${code} without a result line: ${(stderr || stdout).trim().slice(-1500)}`
        })
        return
      }
      const allOk = parsed.checks.length > 0 && parsed.checks.every((c) => c.ok)
      const pass = parsed.pass && allOk && code === 0
      finish({
        pass,
        checks: parsed.checks,
        ...(parsed.pass && !pass ? { error: `checker reported pass but exited ${code}` } : {})
      })
    })
  })
}
