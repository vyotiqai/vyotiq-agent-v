import { existsSync, readFileSync, readdirSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import spawn from 'cross-spawn'
import { getSettings } from '@main/settings/settings'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { scrubPath } from '../../../shared/utils/scrub'
import { abortError } from '../../../shared/errors'
import { sanitizedTerminalEnv } from './terminal'

const DIAG_TIMEOUT_MS = 120_000
/** Per-stream capture cap (kept tail) so a chatty command cannot grow memory unboundedly. */
export const MAX_STREAM_BYTES = 262_144

export type DiagnosticsKind = 'typecheck' | 'lint'

export type DiagnosticItem = {
  file: string
  line: number
  col: number
  message: string
  severity?: string
}

export function packageScripts(workspace: string): Record<string, string> {
  const pkgPath = join(workspace, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
    return raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {}
  } catch {
    return {}
  }
}

export function preferPnpm(workspace: string): boolean {
  return existsSync(join(workspace, 'pnpm-lock.yaml'))
}

/**
 * True when the workspace has something for `tsc` / a typecheck script to run.
 * Empty folders (and npm packages with only typescript installed) are not projects —
 * `tsc --noEmit` otherwise prints help and exits 1 (verified live session 81cee96f).
 */
export function hasTypeScriptProject(workspace: string): boolean {
  const scripts = packageScripts(workspace)
  if (scripts.typecheck || scripts['type-check']) return true
  if (existsSync(join(workspace, 'tsconfig.json'))) return true
  try {
    for (const name of readdirSync(workspace)) {
      if (/^tsconfig.*\.json$/i.test(name)) return true
    }
  } catch {
    // unreadable workspace → treat as no project
  }
  return false
}

const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml'
]

/**
 * True when the workspace has a JS/Node lint surface (package.json, eslint config,
 * or a lint script). Python-only / empty folders should not default to `eslint`.
 */
export function hasJavaScriptProject(workspace: string): boolean {
  const scripts = packageScripts(workspace)
  if (scripts.lint) return true
  if (existsSync(join(workspace, 'package.json'))) return true
  for (const name of ESLINT_CONFIG_NAMES) {
    if (existsSync(join(workspace, name))) return true
  }
  return false
}

/**
 * Split a user-supplied diagnostics command into an executable and an argv array
 * without invoking a shell. Shell metacharacters outside of quotes are rejected,
 * so `;`, `|`, `&`, `$`, backticks, redirections, globs, etc. cannot execute
 * arbitrary commands. `cross-spawn` resolves `.cmd`/`.bat` shims on Windows.
 */
export function parseSafeCommand(command: string): { bin: string; args: string[] } {
  const trimmed = command.trim()
  if (!trimmed) throw new Error('Empty diagnostics command')

  const args: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let i = 0

  while (i < trimmed.length) {
    const ch = trimmed[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && quote === '"' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1]
        if (next === '"' || next === '\\') {
          current += next
          i += 2
          continue
        }
        current += ch
      } else {
        current += ch
      }
      i++
      continue
    }

    if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      i++
      continue
    }

    // Reject common shell metacharacters. cross-spawn runs without a shell so
    // there is no glob expansion; * and ? are passed literally and are safe.
    if (/[;|&$`()<>!~[\]{}#\n\r%^]/.test(ch)) {
      throw new Error(`Disallowed character in diagnostics command: ${ch}`)
    }

    current += ch
    i++
  }

  if (quote) throw new Error('Unclosed quote in diagnostics command')
  if (current) args.push(current)
  if (args.length === 0) throw new Error('Empty diagnostics command')

  return { bin: args[0]!, args: args.slice(1) }
}

export function resolveDiagnosticsBin(workspace: string, bin: string): string {
  if (bin.includes('..')) {
    throw new Error(`Diagnostics binary cannot contain '..' traversal`)
  }
  if (bin.includes('/') || bin.includes('\\') || isAbsolute(bin)) {
    const candidate = resolveInsideWorkspace(workspace, bin)
    if (!existsSync(candidate)) {
      throw new Error(`Diagnostics binary not found in workspace: ${bin}`)
    }
    assertInsideWorkspace(workspace, candidate)
    return candidate
  }
  return bin
}

export function runSafeCommand(
  bin: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutTotal = 0
    let stderrTotal = 0
    let stdoutTrimmed = false
    let stderrTrimmed = false
    let killed = false

    function kill(reason: 'aborted' | 'timeout'): void {
      if (killed) return
      killed = true
      child.kill('SIGTERM')
    }

    /** Keep only the last MAX_STREAM_BYTES per stream so a chatty command
     *  cannot grow memory unboundedly; the dropped prefix is marked. */
    function appendBuffer(
      chunks: Buffer[],
      total: number,
      chunk: Buffer
    ): { total: number; trimmed: boolean } {
      chunks.push(chunk)
      let next = total + chunk.length
      let trimmed = false
      let drop = next - MAX_STREAM_BYTES
      while (drop > 0 && chunks.length > 0) {
        trimmed = true
        const head = chunks[0]!
        if (head.length <= drop) {
          chunks.shift()
          drop -= head.length
        } else {
          chunks[0] = head.subarray(drop)
          drop = 0
        }
      }
      return { total: Math.min(next, MAX_STREAM_BYTES), trimmed }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const res = appendBuffer(stdout, stdoutTotal, chunk)
      stdoutTotal = res.total
      stdoutTrimmed = stdoutTrimmed || res.trimmed
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const res = appendBuffer(stderr, stderrTotal, chunk)
      stderrTotal = res.total
      stderrTrimmed = stderrTrimmed || res.trimmed
    })

    const onAbort = (): void => kill('aborted')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => kill('timeout'), options.timeoutMs)
        : null

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (exitCode) => {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      const TRIM_MARK = '…[earlier output truncated — kept last 256KB]…'
      resolve({
        stdout: (stdoutTrimmed ? `${TRIM_MARK}\n` : '') + Buffer.concat(stdout).toString('utf8'),
        stderr: (stderrTrimmed ? `${TRIM_MARK}\n` : '') + Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? null,
        killed
      })
    })
  })
}

/** npm swallows package flags unless `--` is present; pnpm exec does not. */
export function execPackageCommand(pm: 'npm' | 'pnpm', pkg: string, pkgArgs: string): string {
  return pm === 'npm' ? `npm exec -- ${pkg} ${pkgArgs}` : `pnpm exec ${pkg} ${pkgArgs}`
}

export function resolveDiagnosticsCommand(
  workspace: string,
  kind: DiagnosticsKind,
  diagnosticsCommand?: string | null
): string {
  const override =
    (diagnosticsCommand ?? getSettings().diagnosticsCommand)?.trim() || undefined
  if (override) return override

  const scripts = packageScripts(workspace)
  const pm = preferPnpm(workspace) ? 'pnpm' : 'npm'

  if (kind === 'lint') {
    if (scripts.lint) return `${pm} run lint --if-present`
    // Prefer JSON: ESLint 10 removed the built-in `unix` formatter.
    return execPackageCommand(pm, 'eslint', '. --format json')
  }

  if (scripts.typecheck) return `${pm} run typecheck`
  if (scripts['type-check']) return `${pm} run type-check`
  return execPackageCommand(pm, 'tsc', '--noEmit --pretty false')
}

/** Parse ESLint `--format json` output (array of file results). */
export function parseEslintJsonDiagnostics(text: string): DiagnosticItem[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const items: DiagnosticItem[] = []
  for (const file of parsed) {
    if (!file || typeof file !== 'object') continue
    const filePath = (file as { filePath?: unknown }).filePath
    const messages = (file as { messages?: unknown }).messages
    if (typeof filePath !== 'string' || !Array.isArray(messages)) continue
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const m = msg as {
        line?: unknown
        column?: unknown
        severity?: unknown
        message?: unknown
        ruleId?: unknown
      }
      if (typeof m.message !== 'string') continue
      const severity =
        m.severity === 1 ? 'warning' : m.severity === 2 ? 'error' : 'error'
      const rule = typeof m.ruleId === 'string' && m.ruleId ? ` (${m.ruleId})` : ''
      items.push({
        file: filePath,
        line: typeof m.line === 'number' ? m.line : 1,
        col: typeof m.column === 'number' ? m.column : 1,
        severity,
        message: `${m.message}${rule}`
      })
    }
  }
  return items
}

/** Parse common tsc / eslint-unix style "file(line,col): error TS…: message" lines. */
export function parseDiagnosticLines(text: string): DiagnosticItem[] {
  const fromJson = parseEslintJsonDiagnostics(text)
  if (fromJson && fromJson.length > 0) return fromJson

  const items: DiagnosticItem[] = []
  const re =
    /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)?\s*(?:TS\d+:\s*)?(.+)$/i
  const reColon = /^(.+?):(\d+):(\d+):\s*(error|warning|info)?\s*(.+)$/i
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let m = re.exec(trimmed)
    if (!m) m = reColon.exec(trimmed)
    if (!m) continue
    items.push({
      file: m[1]!,
      line: Number(m[2]),
      col: Number(m[3]),
      severity: (m[4] || 'error').toLowerCase(),
      message: m[5]!.trim()
    })
  }
  return items
}

/** Diagnostic paths reach the model; keep them workspace-relative (scrub outsiders). */
function relativizeDiagnosticFile(workspace: string, file: string): string {
  if (!isAbsolute(file)) return file
  const rel = relative(workspace, file)
  if (rel.startsWith('..') || isAbsolute(rel)) return scrubPath(file)
  return rel.replace(/\\/g, '/')
}

export async function toolDiagnosticsAsync(
  workspace: string,
  kind: DiagnosticsKind,
  signal: AbortSignal,
  diagnosticsCommand?: string | null
): Promise<{ ok: boolean; content: string }> {
  const override =
    (diagnosticsCommand ?? getSettings().diagnosticsCommand)?.trim() || undefined
  if (kind === 'typecheck' && !override && !hasTypeScriptProject(workspace)) {
    return {
      ok: true,
      content:
        'No TypeScript project (no tsconfig / typecheck script); typecheck skipped.'
    }
  }
  if (kind === 'lint' && !override && !hasJavaScriptProject(workspace)) {
    return {
      ok: true,
      content:
        'No JavaScript project (no package.json / eslint / lint script); lint skipped.'
    }
  }

  const command = resolveDiagnosticsCommand(workspace, kind, diagnosticsCommand)
  let bin: string
  let argv: string[]
  try {
    ;({ bin, args: argv } = parseSafeCommand(command))
    bin = resolveDiagnosticsBin(workspace, bin)
  } catch (err) {
    return {
      ok: false,
      content: [`command: ${command}`, (err as Error).message].join('\n')
    }
  }

  try {
    const { stdout, stderr, exitCode, killed } = await runSafeCommand(bin, argv, {
      cwd: workspace,
      env: sanitizedTerminalEnv(),
      signal,
      timeoutMs: DIAG_TIMEOUT_MS
    })
    if (signal.aborted) throw abortError()

    const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
    const output = combined || '(no output)'
    const parsed = parseDiagnosticLines(combined).map((d) => ({
      ...d,
      file: relativizeDiagnosticFile(workspace, d.file)
    }))

    if (exitCode !== 0 && !killed && parsed.length === 0) {
      return {
        ok: false,
        content: [
          `command: ${command}`,
          `exit: ${exitCode ?? 'error'}`,
          output
        ]
          .filter(Boolean)
          .join('\n')
      }
    }

    if (parsed.length > 0) {
      const lines = [
        `command: ${command}`,
        ...(exitCode !== 0 ? [`exit: ${exitCode ?? 'error'}`] : []),
        `diagnostics: ${parsed.length}`,
        '',
        ...parsed.map(
          (d) =>
            `${d.file}:${d.line}:${d.col}: ${d.severity ?? 'error'}: ${d.message}`
        )
      ]
      return { ok: true, content: lines.join('\n') }
    }

    if (killed) {
      return {
        ok: false,
        content: [`command: ${command}`, 'Diagnostics command was killed (timeout)', output]
          .filter(Boolean)
          .join('\n')
      }
    }

    return { ok: true, content: [`command: ${command}`, '', output].join('\n') }
  } catch (err) {
    if (signal.aborted) throw err
    return {
      ok: false,
      content: [`command: ${command}`, (err as Error).message ?? 'Diagnostics command failed'].join('\n')
    }
  }
}
