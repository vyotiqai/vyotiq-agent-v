import { existsSync, readFileSync, readdirSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import spawn from 'cross-spawn'
import { getSettings } from '@main/settings/settings'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import { scrubPath } from '../../../shared/utils/scrub'
import { abortError } from '../../../shared/errors'
import { killProcessTree, sanitizedTerminalEnv } from './terminal'

const DIAG_TIMEOUT_MS = 120_000
/**
 * After a timeout or abort kill, how long to wait for the pipes to close
 * before settling anyway. A descendant that outlives the kill (or holds an
 * inherited handle) would otherwise keep `close` from ever firing.
 */
const KILL_SETTLE_MS = 5_000
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
    let settled = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    function kill(reason: 'aborted' | 'timeout'): void {
      if (killed) return
      killed = true
      // The whole tree, not just the child: on Windows cross-spawn runs
      // npm/pnpm/.cmd shims through cmd.exe, and killing that wrapper left
      // the real runner alive holding the pipes — the timeout never resolved
      // and a watch-mode runner outlived the run.
      if (child.pid) killProcessTree(child.pid, `diagnostics ${reason}`)
      else child.kill('SIGTERM')
      settleTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null)
      }, KILL_SETTLE_MS)
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
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (settleTimer) clearTimeout(settleTimer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    function finish(exitCode: number | null): void {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (settleTimer) clearTimeout(settleTimer)
      options.signal?.removeEventListener('abort', onAbort)
      const TRIM_MARK = '…[earlier output truncated — kept last 256KB]…'
      resolve({
        stdout: (stdoutTrimmed ? `${TRIM_MARK}\n` : '') + Buffer.concat(stdout).toString('utf8'),
        stderr: (stderrTrimmed ? `${TRIM_MARK}\n` : '') + Buffer.concat(stderr).toString('utf8'),
        exitCode,
        killed
      })
    }

    child.on('close', (exitCode) => finish(exitCode ?? null))
  })
}

/**
 * npm swallows package flags unless `--` is present; pnpm exec does not.
 * `--no` stops npm installing a package it cannot find locally: with no TTY
 * it answers its own install prompt yes, and the registry's `tsc` is not
 * TypeScript. pnpm exec never downloads.
 */
export function execPackageCommand(pm: 'npm' | 'pnpm', pkg: string, pkgArgs: string): string {
  return pm === 'npm' ? `npm exec --no -- ${pkg} ${pkgArgs}` : `pnpm exec ${pkg} ${pkgArgs}`
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
    // Bare `run lint`: pnpm forwards `--if-present` to the script instead of
    // consuming it, so `eslint . --if-present` exits 2 — and `scripts.lint`
    // already sends a workspace with no lint script to the exec fallback.
    if (scripts.lint) return `${pm} run lint`
    // Prefer JSON: ESLint 10 removed the built-in `unix` formatter.
    return execPackageCommand(pm, 'eslint', '. --format json')
  }

  if (scripts.typecheck) return `${pm} run typecheck`
  if (scripts['type-check']) return `${pm} run type-check`
  return execPackageCommand(
    pm,
    'tsc',
    isSolutionStyleTsconfig(workspace) ? '-b --noEmit --pretty false' : '--noEmit --pretty false'
  )
}

/**
 * A root tsconfig.json that only lists project references (`"files": []`),
 * as Vite's `-ts` templates ship. `tsc --noEmit` on it checks zero files and
 * exits 0 — a type error in `src/` read as a clean typecheck. `tsc -b
 * --noEmit` follows the references (checked on TypeScript 5.9 and 7.0).
 * A key match, not a JSONC parse: a false positive still type-checks,
 * since `-b` also builds an ordinary config that has references.
 */
export function isSolutionStyleTsconfig(workspace: string): boolean {
  let text: string
  try {
    text = readFileSync(join(workspace, 'tsconfig.json'), 'utf8')
  } catch {
    return false
  }
  return /"references"\s*:\s*\[\s*\{/.test(text) && /"files"\s*:\s*\[\s*\]/.test(text) && !/"include"\s*:/.test(text)
}

/**
 * The JSON array ESLint printed. It prints one line to stdout, but stdout and
 * stderr arrive joined, so a `[deprecated]` warning on stderr made the old
 * first-`[`-to-last-`]` slice unparseable and hid every lint error. Look for
 * the line first; fall back to the slice for pretty-printed output.
 */
function eslintJsonArray(text: string): unknown[] | null {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('[') || !t.endsWith(']')) continue
    try {
      const parsed: unknown = JSON.parse(t)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // not the JSON line
    }
  }
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parse ESLint `--format json` output (array of file results). */
export function parseEslintJsonDiagnostics(text: string): DiagnosticItem[] | null {
  const parsed = eslintJsonArray(text)
  if (!parsed) return null
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

/** tsc: `file(line,col): error TS1234: message`. */
const PAREN_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s*(?:(error|warning|info)\b:?\s*)?(?:TS\d+:\s*)?(.+)$/i
/** gcc/go/eslint-unix and this tool's own output: `file:line:col: error: message`. */
const COLON_DIAG_RE = /^(.+?):(\d+):(\d+):\s*(?:(error|warning|info|note)\b:?\s*)?(.+)$/i
/** mypy / pyright-style without a column: `file:line: error: message`. */
const COLON_NO_COL_DIAG_RE = /^(.+?):(\d+):\s*(error|warning|note):\s*(.+)$/i
/** ESLint's default `stylish` row, under a file header: `  1:7  error  message  rule`. */
const STYLISH_ROW_RE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/
/** rustc / cargo: `error[E0308]: message`, located by a later ` --> file:line:col`. */
const RUST_HEAD_RE = /^(error|warning)(?:\[\w+\])?:\s*(.+)$/
const RUST_ARROW_RE = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/
/** Python (py_compile, tracebacks): `File "x.py", line 3` … `SyntaxError: message`. */
const PY_FILE_RE = /^\s*File "(.+)", line (\d+)/
const PY_ERROR_RE = /^(\w*(?:Error|Exception)):\s*(.*)$/

/**
 * A diagnostic's file part must look like a path — a separator or an
 * extension. Without this, `build finished at 12:34:56: ok` parsed as an
 * error in file "build finished at 12" and turned a clean run into a failure.
 */
function looksLikeSourcePath(file: string): boolean {
  return /[\\/]/.test(file) || /\.[A-Za-z0-9]{1,6}$/.test(file)
}

function normalizeSeverity(raw: string | undefined): string {
  const s = (raw || 'error').toLowerCase()
  return s === 'note' ? 'info' : s
}

/**
 * Parse checker output into diagnostics: ESLint JSON, tsc, `file:line:col`,
 * mypy, ESLint stylish, rustc and Python errors. An unrecognised format
 * yields nothing, and the tool then falls back to the exit code.
 */
export function parseDiagnosticLines(text: string): DiagnosticItem[] {
  const fromJson = parseEslintJsonDiagnostics(text)
  if (fromJson && fromJson.length > 0) return fromJson

  const items: DiagnosticItem[] = []
  let stylishFile: string | null = null
  let rustPending: { severity: string; message: string } | null = null
  let pyPending: { file: string; line: number } | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      stylishFile = null
      continue
    }

    const stylish = stylishFile ? STYLISH_ROW_RE.exec(line) : null
    if (stylish && stylishFile) {
      const rule = stylish[5] ? ` (${stylish[5]})` : ''
      items.push({
        file: stylishFile,
        line: Number(stylish[1]),
        col: Number(stylish[2]),
        severity: normalizeSeverity(stylish[3]),
        message: `${stylish[4]!.trim()}${rule}`
      })
      continue
    }

    const arrow = RUST_ARROW_RE.exec(line)
    if (arrow) {
      if (rustPending) {
        items.push({
          file: arrow[1]!,
          line: Number(arrow[2]),
          col: Number(arrow[3]),
          severity: rustPending.severity,
          message: rustPending.message
        })
      }
      rustPending = null
      continue
    }
    const rustHead = RUST_HEAD_RE.exec(trimmed)
    if (rustHead && line === trimmed) {
      rustPending = { severity: normalizeSeverity(rustHead[1]), message: rustHead[2]!.trim() }
      continue
    }

    const pyFile = PY_FILE_RE.exec(line)
    if (pyFile) {
      pyPending = { file: pyFile[1]!, line: Number(pyFile[2]) }
      continue
    }
    const pyError = pyPending ? PY_ERROR_RE.exec(trimmed) : null
    if (pyError && pyPending) {
      items.push({
        file: pyPending.file,
        line: pyPending.line,
        col: 1,
        severity: 'error',
        message: `${pyError[1]}: ${pyError[2]!.trim()}`.replace(/:\s*$/, '')
      })
      pyPending = null
      continue
    }

    const m = PAREN_DIAG_RE.exec(trimmed) ?? COLON_DIAG_RE.exec(trimmed)
    if (m && looksLikeSourcePath(m[1]!)) {
      items.push({
        file: m[1]!,
        line: Number(m[2]),
        col: Number(m[3]),
        severity: normalizeSeverity(m[4]),
        message: m[5]!.trim()
      })
      continue
    }
    const noCol = COLON_NO_COL_DIAG_RE.exec(trimmed)
    if (noCol && looksLikeSourcePath(noCol[1]!)) {
      items.push({
        file: noCol[1]!,
        line: Number(noCol[2]),
        col: 1,
        severity: normalizeSeverity(noCol[3]),
        message: noCol[4]!.trim()
      })
      continue
    }

    // A non-indented path on its own line heads an ESLint stylish block.
    stylishFile = line === trimmed && looksLikeSourcePath(trimmed) && !/\s{2,}/.test(trimmed) ? trimmed : null
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

    // A killed run is a timeout even when it printed some diagnostics first:
    // the lines it got through are not the project's verdict.
    if (killed) {
      return {
        ok: false,
        content: [
          `command: ${command}`,
          'Diagnostics command was killed (timeout)',
          ...(parsed.length > 0 ? [`diagnostics before the timeout: ${parsed.length}`] : []),
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

    return { ok: true, content: [`command: ${command}`, '', output].join('\n') }
  } catch (err) {
    if (signal.aborted) throw err
    return {
      ok: false,
      content: [`command: ${command}`, (err as Error).message ?? 'Diagnostics command failed'].join('\n')
    }
  }
}
