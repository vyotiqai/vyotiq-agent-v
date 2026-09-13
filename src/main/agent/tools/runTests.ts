import {
  packageScripts,
  preferPnpm,
  parseSafeCommand,
  resolveDiagnosticsBin,
  runSafeCommand
} from './diagnostics'
import { sanitizedTerminalEnv } from './terminal'
import { abortError } from '../../../shared/errors'

const TEST_TIMEOUT_MS = 300_000

export type RunTestsResult = { ok: boolean; command: string; content: string }

const PASSED_RE = /(\d+)\s+passed/gi
const FAILED_RE = /(\d+)\s+failed/gi

/** Last regex capture — runners print earlier per-file totals before the final summary. */
function lastCount(re: RegExp, text: string): number | null {
  let out: number | null = null
  for (const match of text.matchAll(re)) {
    out = Number(match[1] ?? 0)
  }
  return out
}

/**
 * Parse the runner's final pass/fail summary (vitest `Tests  2 failed | 18 passed`,
 * jest `Tests: 2 failed, 18 passed`). Informational only — ok/fail still comes
 * from the exit code. Returns null when no summary line is present.
 */
export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const tail = output.slice(-4000)
  const passed = lastCount(PASSED_RE, tail)
  const failed = lastCount(FAILED_RE, tail)
  if (passed == null && failed == null) return null
  return { passed: passed ?? 0, failed: failed ?? 0 }
}

/** Parse the `Tests: N passed, M failed (exit E)` header this tool writes. */
export function parseTestResultHeader(content: string): { passed: number; failed: number } | null {
  const match = /^Tests: (\d+) passed, (\d+) failed/m.exec(content)
  if (!match) return null
  return { passed: Number(match[1]), failed: Number(match[2]) }
}

function summaryHeader(
  output: string,
  exitCode: number | null
): string | null {
  const summary = parseTestSummary(output)
  return summary
    ? `Tests: ${summary.passed} passed, ${summary.failed} failed (exit ${exitCode ?? 'error'})`
    : null
}

/**
 * Resolve what command to run: an explicit (sandboxed) command, a named package
 * script, or the workspace test script. Mirrors how `diagnostics` resolves its
 * command but defaults to the project's test runner. Returns null when no
 * explicit command/script was given and the workspace declares no test script.
 */
function resolveTestCommand(workspace: string, command?: string, script?: string): string | null {
  const override = (command ?? '').trim()
  if (override) return override
  const scripts = packageScripts(workspace)
  const pm = preferPnpm(workspace) ? 'pnpm' : 'npm'
  const named = (script ?? '').trim()
  if (named) return `${pm} run ${named}`
  if (scripts.test) return `${pm} run test`
  return null
}

export async function toolRunTestsAsync(
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<RunTestsResult> {
  const resolved = resolveTestCommand(
    workspace,
    typeof args.command === 'string' ? args.command : undefined,
    typeof args.script === 'string' ? args.script : undefined
  )
  if (!resolved) {
    return {
      ok: true,
      command: '',
      content:
        'No test runner detected (no package.json test script); tests skipped. Pass an explicit sandboxed `command` to run project tests.'
    }
  }
  const command = resolved
  if (signal.aborted) throw abortError()

  let bin: string
  let argv: string[]
  try {
    ;({ bin, args: argv } = parseSafeCommand(command))
    bin = resolveDiagnosticsBin(workspace, bin)
  } catch (err) {
    return {
      ok: false,
      command,
      content: [`command: ${command}`, (err as Error).message].join('\n')
    }
  }

  try {
    const { stdout, stderr, exitCode, killed } = await runSafeCommand(bin, argv, {
      cwd: workspace,
      env: sanitizedTerminalEnv(),
      signal,
      timeoutMs: TEST_TIMEOUT_MS
    })
    if (signal.aborted) throw abortError()
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
    const header = summaryHeader(output, exitCode)
    if (exitCode !== 0 && !killed) {
      return {
        ok: false,
        command,
        content: [`command: ${command}`, `exit: ${exitCode ?? 'error'}`, ...(header ? [header] : []), output]
          .filter(Boolean)
          .join('\n')
      }
    }
    if (killed) {
      return {
        ok: false,
        command,
        content: [
          `command: ${command}`,
          'Test command was killed (timeout)',
          output
        ]
          .filter(Boolean)
          .join('\n')
      }
    }
    return {
      ok: true,
      command,
      content: [`command: ${command}`, ...(header ? [header] : []), '', output].join('\n')
    }
  } catch (err) {
    if (signal.aborted) throw err
    return {
      ok: false,
      command,
      content: [`command: ${command}`, (err as Error).message ?? 'Test command failed'].join('\n')
    }
  }
}
