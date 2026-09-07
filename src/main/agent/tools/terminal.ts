import { spawn, spawnSync } from 'child_process'
import { basename } from 'path'
import kill from 'tree-kill'
import { assertInsideWorkspace } from '../../../shared/workspacePath'
import type { TerminalShell } from '../../../shared/ipc'
import { parseTerminalOutput } from '../../../shared/utils/terminalFormat'
import { logger } from '../../../shared/logger'
import { lowerProcessPriority } from '../processPriority'

const KILL_TREE_WAIT_MS = 5_000

/** Kill a process tree; log when taskkill/tree-kill reports failure. */
export function killProcessTree(pid: number, reason: string): void {
  void killProcessTreeAndWait(pid, reason)
}

/** Await tree-kill (Windows taskkill) so worktree teardown does not rm while node still holds files. */
export function killProcessTreeAndWait(
  pid: number,
  reason: string,
  timeoutMs: number = KILL_TREE_WAIT_MS
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    kill(pid, (err) => {
      clearTimeout(timer)
      if (err) {
        logger.warn('Failed to kill terminal process tree', {
          scope: 'terminal',
          pid,
          reason,
          err: err instanceof Error ? err.message : String(err)
        })
      }
      finish()
    })
  })
}

/**
 * Per-stream capture cap (restored pre-a067d81 behavior). A runaway command
 * (huge file dump, chatty build log) must not balloon main-process memory;
 * capture stops buffering past this mark while the child keeps draining.
 * Context-side trimming (toolTrim) is separate and happens later.
 */
export const TERMINAL_MAX_OUTPUT = 64 * 1024
/**
 * Former upper bound for model-requested wait. Timeouts may exceed this;
 * omitted waits still default to TERMINAL_DEFAULT_TIMEOUT_MS.
 */
export const TERMINAL_MAX_TIMEOUT_MS = 1_800_000
/** Default wait for a new command when timeoutMs / block_until_ms are omitted. */
export const TERMINAL_DEFAULT_TIMEOUT_MS = 300_000
const SESSION_POLL_DEFAULT_MS = 30_000

/** New-command wait: timeoutMs wins over block_until_ms unless background-now (0). */
export function resolveNewCommandBlockUntilMs(args: {
  block_until_ms?: unknown
  timeoutMs?: unknown
}): number {
  const hasBlock =
    typeof args.block_until_ms === 'number' && Number.isFinite(args.block_until_ms)
  const block = hasBlock ? Math.max(0, args.block_until_ms as number) : undefined
  if (block === 0) return 0
  const hasTimeout = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
  const timeout = hasTimeout ? Math.max(1, args.timeoutMs as number) : undefined
  if (timeout != null && block != null) return Math.max(block, timeout)
  if (timeout != null) return timeout
  if (block != null) return block
  return TERMINAL_DEFAULT_TIMEOUT_MS
}

/** Session poll wait. timeoutMs is ignored; omitted block_until_ms defaults to 30s. */
export function resolveSessionPollBlockUntilMs(args: { block_until_ms?: unknown }): number {
  if (typeof args.block_until_ms === 'number' && Number.isFinite(args.block_until_ms)) {
    return Math.max(0, args.block_until_ms)
  }
  return SESSION_POLL_DEFAULT_MS
}

/** Resolved shell used for spawn (never `auto`). */
export type ResolvedTerminalShell = 'cmd' | 'powershell' | 'bash' | 'unix'

/** Unix tools that typically fail or mislead under Windows cmd.exe. */
const UNIX_PRIMARY_ON_WINDOWS = new Set([
  'ls',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
  'find',
  'cat',
  'which',
  'pwd',
  'rm',
  'cp',
  'mv',
  'chmod',
  'chown',
  'touch',
  'ln',
  'wc',
  'awk',
  'sed',
  'xargs',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'uname',
  'tee',
  'tr',
  'cut',
  'uniq',
  'export',
  'source',
  'bash',
  'sh',
  'zsh'
])

/** Shown when Unix file-inspect commands hit Windows cmd — steer to built-ins, not findstr/type. */
const WORKSPACE_FILE_OPS_REDIRECT =
  'For workspace file search or read, use the grep, read, glob, and list_dir tools — not findstr or type.'

const FILE_OP_UNIX_TOKENS = new Set([
  'ls',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
  'find',
  'cat'
])

const UNIX_CMD_HINTS: Record<string, string> = {
  ls: 'the list_dir tool',
  grep: 'the grep tool',
  egrep: 'the grep tool',
  fgrep: 'the grep tool',
  head: 'the read tool',
  tail: 'the read tool',
  find: 'the glob tool',
  cat: 'the read tool',
  which: 'where',
  pwd: 'echo %CD%',
  rm: 'del',
  cp: 'copy',
  mv: 'move',
  touch: 'type nul > file',
  wc: 'find /c /v ""',
  bash: 'cmd.exe builtins',
  sh: 'cmd.exe builtins',
  zsh: 'cmd.exe builtins'
}

/** PATH lookups are stable for the process lifetime; each miss is a blocking spawn. */
const commandOnPathCache = new Map<string, boolean>()

export function commandOnPath(bin: string): boolean {
  const cached = commandOnPathCache.get(bin)
  if (cached !== undefined) return cached
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [bin], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
  const found = result.status === 0 && Boolean(result.stdout?.trim())
  commandOnPathCache.set(bin, found)
  return found
}

/** Clear cached PATH lookups after installing a binary mid-session. */
export function invalidateCommandOnPathCache(bin?: string): void {
  if (bin) commandOnPathCache.delete(bin)
  else commandOnPathCache.clear()
}

export function resetCommandOnPathCacheForTests(): void {
  invalidateCommandOnPathCache()
}

function unixShellInvocation(command: string): { bin: string; args: string[] } {
  const shell = process.env.SHELL?.trim()
  if (shell) return { bin: shell, args: ['-lc', command] }
  return { bin: '/bin/sh', args: ['-c', command] }
}

/**
 * Windows PowerShell 5.1 fabricates exit codes for redirected native stderr:
 * inside `… 2>&1`, every native stderr line becomes a NativeCommandError
 * record and the outer powershell.exe exits 1 even when the native command
 * succeeded (exit 0). Measured on this machine: `ssh -V 2>&1` → exit 1 with a
 * fully successful run; run 1de9344a burned 32+ failure-budget entries on
 * ssh polls whose stdout carried MOUNT_OK / BUILD_RUNNING while `exit_code: 1`
 * was invented by the shell, not the workload. An unguarded `; exit
 * $LASTEXITCODE` suffix is NOT a fix: after a cmdlet failure $LASTEXITCODE is
 * a string, so it would flip real failures to 0 (measured). The epilogue
 * restores the true verdict at spawn time:
 *  - native command actually failed → forward its real exit code;
 *  - any non-NativeCommandError PowerShell error (cmdlet failure, parse
 *    error, Write-Error) → exit 1, as PS itself would have reported;
 *  - only NativeCommandError records remain (benign native stderr under a
 *    successful native run) → exit 0. Errors tolerated via try/catch /
 *    -ErrorAction Continue are not in $Error at this point, so they stay 0.
 * A user-supplied trailing `exit …` statement runs first and wins, preserving
 * deliberate verdicts; pwsh 7+ is unaffected by the inflation but gets the
 * same consistent verdict contract.
 */
export const POWERSHELL_EXIT_EPILOGUE =
  `if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } ` +
  `elseif (@($Error | Where-Object { $_.FullyQualifiedErrorId -notlike 'NativeCommandError*' }).Count -gt 0) { exit 1 } ` +
  `else { exit 0 }`

function powershellInvocation(command: string): { bin: string; args: string[] } {
  const bin = commandOnPath('pwsh') ? 'pwsh' : 'powershell'
  return {
    bin,
    args: ['-NoProfile', '-NonInteractive', '-Command', `${command}\n; ${POWERSHELL_EXIT_EPILOGUE}`]
  }
}

function bashInvocation(command: string): { bin: string; args: string[] } {
  return { bin: 'bash', args: ['-lc', command] }
}

/**
 * Resolve settings preference to a concrete shell for this platform.
 * Exported for tests.
 */
export function resolveTerminalShell(
  preference: TerminalShell = 'auto',
  platform: NodeJS.Platform = process.platform
): ResolvedTerminalShell {
  if (preference === 'cmd') return platform === 'win32' ? 'cmd' : 'unix'
  if (preference === 'powershell') return 'powershell'
  if (preference === 'bash') return 'bash'
  // auto
  if (platform !== 'win32') return 'unix'
  if (commandOnPath('pwsh') || commandOnPath('powershell')) return 'powershell'
  return 'cmd'
}

export type TerminalSpawnSpec = {
  resolved: ResolvedTerminalShell
  bin: string
  args: string[]
}

/** Build spawn bin/args for a resolved shell. Exported for tests. */
export function terminalSpawnSpec(
  command: string,
  resolved: ResolvedTerminalShell
): TerminalSpawnSpec {
  if (resolved === 'cmd') {
    return { resolved, bin: 'cmd.exe', args: ['/c', command] }
  }
  if (resolved === 'powershell') {
    const inv = powershellInvocation(command)
    return { resolved, bin: inv.bin, args: inv.args }
  }
  if (resolved === 'bash') {
    const inv = bashInvocation(command)
    return { resolved, bin: inv.bin, args: inv.args }
  }
  const inv = unixShellInvocation(command)
  return { resolved, bin: inv.bin, args: inv.args }
}

/** First executable token of a command (cmd-safe parsing). Exported for tests. */
export function primaryCommandToken(command: string): string | null {
  let s = command.trim()
  if (!s) return null
  s = s.replace(/^(?:cmd(?:\.exe)?\s+\/c\s+)/i, '')
  const first = s.split(/\s*(?:&&|\|\||[|;&])\s*/)[0]?.trim() ?? ''
  if (!first) return null
  const m = first.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/)
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
  if (!raw) return null
  const base = raw.replace(/^.*[/\\]/, '').replace(/\.(?:exe|cmd|bat)$/i, '')
  return base.toLowerCase() || null
}

/** Last pipeline stage token (e.g. `dir | findstr x` → findstr). Exported for tests. */
export function lastPipelineCommandToken(command: string): string | null {
  const stages = command.split('|')
  const last = stages[stages.length - 1] ?? command
  return primaryCommandToken(last)
}

/**
 * On Windows cmd shell, if any pipeline stage's primary command is a common Unix builtin,
 * return a helpful failure message (no spawn). Otherwise null.
 */
export function unsupportedUnixOnWindowsMessage(command: string): string | null {
  const stages = command
    .split('|')
    .map((s) => primaryCommandToken(s.trim()))
    .filter((t): t is string => Boolean(t))
  const unixStages = stages.filter((t) => UNIX_PRIMARY_ON_WINDOWS.has(t))
  if (!unixStages.length) return null
  const token = unixStages[0]
  const equiv = UNIX_CMD_HINTS[token] ?? 'a cmd.exe-compatible command'
  const stageNote =
    unixStages.length > 1
      ? ` Also blocked in pipeline: ${unixStages.slice(1).join(', ')}.`
      : ''
  const fileOpUnix = FILE_OP_UNIX_TOKENS
  return [
    `Unsupported Unix command on Windows: "${token}".`,
    'The terminal tool is using cmd.exe (Settings → Tools → Terminal shell).',
    `Use ${equiv} instead of "${token}".${stageNote}`,
    fileOpUnix.has(token) ? WORKSPACE_FILE_OPS_REDIRECT : null,
    'Switch the shell to PowerShell or bash for other shell-only commands.',
    'exit_code: 1'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Bash `for … in …; do … done` is not valid PowerShell (T1: Missing opening '(' after 'for').
 * Detect before spawn so the model gets a clear shell-mismatch hint.
 */
export function bashForLoopOnPowerShellMessage(command: string): string | null {
  if (!/\bfor\s+\S+\s+in\s+[^;]+;\s*do\b/i.test(command)) return null
  if (!/\bdone\b/i.test(command)) return null
  return [
    'This command uses bash for-loop syntax (for … in …; do … done), but the terminal shell is PowerShell.',
    'Rewrite with PowerShell foreach, or set Terminal shell to bash (Git Bash).',
    'exit_code: 1'
  ].join('\n')
}

/**
 * AGENTS.md unzip recipe (ZipFile + word/document.xml) fails under nested
 * quoting. `read` extracts .docx text — fail before spawn.
 */
export function docxUnzipViaShellMessage(command: string): string | null {
  if (!/\.docx\b/i.test(command)) return null
  if (!/ZipFile|Compression\.FileSystem|word\/document\.xml/i.test(command)) return null
  return [
    'Do not unzip Word .docx in the terminal.',
    'Call read on the .docx path — it returns extracted document text.',
    'Do not write a helper script for this.',
    'exit_code: 1'
  ].join('\n')
}

export function terminalDocxUnzipPreflight(
  command: string,
  resolved: ResolvedTerminalShell,
  cwd: string
): string | null {
  const body = docxUnzipViaShellMessage(command)
  return body ? formatShellPreflight(cwd, resolved, body) : null
}

/**
 * Nested `powershell -Command` inside an already-PowerShell session expands
 * `$variables` twice and breaks quoting.
 */
export function nestedPowerShellCommandMessage(
  command: string,
  resolved: ResolvedTerminalShell
): string | null {
  if (resolved !== 'powershell') return null
  const token = primaryCommandToken(command)
  if (token !== 'powershell' && token !== 'pwsh') return null
  if (!/(?:^|\s)-(?:Command|c)\b/i.test(command)) return null
  return [
    'This terminal session is already PowerShell. Do not wrap the body in powershell -NoProfile -Command or pwsh -Command — the outer shell expands $variables and breaks quoting.',
    'Pass the PowerShell statements as the terminal command directly.',
    'exit_code: 1'
  ].join('\n')
}

function formatShellPreflight(cwd: string, resolved: ResolvedTerminalShell, body: string): string {
  return [`cwd: ${cwd}`, `shell: ${resolved}`, '', body].join('\n')
}

export function terminalNestedPowerShellPreflight(
  command: string,
  resolved: ResolvedTerminalShell,
  cwd: string
): string | null {
  const nested = nestedPowerShellCommandMessage(command, resolved)
  return nested ? formatShellPreflight(cwd, resolved, nested) : null
}

/**
 * Image names that terminate this app when killed: the dev Electron binary
 * (`electron`) and the packaged app binary (e.g. `Vyotiq`). An agent cleanup
 * sweep that kills by image name takes the host — and the running agent —
 * down with the orphans (TerminateProcess exit code -1, nothing saved).
 */
export function hostProcessImageNames(): string[] {
  const names = new Set<string>(['electron'])
  try {
    const base = basename(process.execPath).replace(/\.exe$/i, '').toLowerCase()
    if (base) names.add(base)
  } catch {
    /* ignore */
  }
  return [...names]
}

/**
 * Name-based kills of the host image are refused outright; the agent must kill
 * verified orphan PIDs instead. PID-targeted kills stay allowed.
 */
export function selfKillCommandMessage(
  command: string,
  hostImageNames: readonly string[]
): string | null {
  const killPrimitive =
    /Stop-Process|\btaskkill\b|\btskill\b|\bpkill\b|\bTerminateProcess\b|\bkill\b/i
  if (!killPrimitive.test(command)) return null
  const escaped = hostImageNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return null
  // The lookahead excludes a word char or dash right after the image name so
  // `electron` does not match electron-builder / electron-vite.
  const hostToken = new RegExp(
    "(?:^|[\\\\/\"'\\s=;,|(&])(" + escaped.join('|') + ')(?![\\w-])',
    'i'
  )
  if (!hostToken.test(command)) return null
  return [
    `Refused: this command would kill the Vyotiq app itself. The agent host runs as ${hostImageNames.join(' / ')}; a name-based kill (Stop-Process / taskkill /IM / kill) terminates the host, ends this run, and loses all in-flight work.`,
    'Kill verified orphan PIDs instead — never by image name:',
    `  Get-CimInstance Win32_Process -Filter "Name = '<image>.exe'" | Select-Object ProcessId, ExecutablePath, CommandLine`,
    `  Stop-Process -Id <pid> -Force   # per verified orphan only; never PID ${process.pid} (this app) or its process tree`,
    'exit_code: 1'
  ].join('\n')
}

export function terminalSelfKillPreflight(
  command: string,
  resolved: ResolvedTerminalShell,
  cwd: string
): string | null {
  const body = selfKillCommandMessage(command, hostProcessImageNames())
  return body ? formatShellPreflight(cwd, resolved, body) : null
}

/** Append Windows cmd hints when a pipeline stage used a Unix-only tool. */
function appendWindowsCompatHint(
  command: string,
  content: string,
  exitCode: number | null,
  resolved: ResolvedTerminalShell
): string {
  if (resolved !== 'cmd') return content
  if (exitCode === 0 || exitCode === null) return content
  const stages = command
    .split('|')
    .map((s) => primaryCommandToken(s.trim()))
    .filter((t): t is string => Boolean(t))
  const unixStages = stages.filter((t) => UNIX_PRIMARY_ON_WINDOWS.has(t))
  if (!unixStages.length) return content
  const fileOpUnix = FILE_OP_UNIX_TOKENS
  const hints = unixStages.map((t) => {
    const equiv = UNIX_CMD_HINTS[t] ?? 'cmd.exe-compatible commands'
    return `"${t}" → use ${equiv}`
  })
  const redirect = unixStages.some((t) => fileOpUnix.has(t)) ? ` ${WORKSPACE_FILE_OPS_REDIRECT}` : ''
  return `${content}\n\n[Windows hint] cmd.exe does not support: ${hints.join('; ')}.${redirect} Switch Terminal shell to PowerShell for other shell-only commands.`
}

/**
 * `cmd | Select-Object -Last 8; "shard-B exit: $LASTEXITCODE"` and friends:
 * the trailing statement is a string literal, so the shell exits 0 no matter
 * what the real command did. The agent then reads a green `exit 0` while the
 * echoed text says a test failed. Detect the shape so the failure is preserved.
 */
export function isMaskedExitCommand(command: string): boolean {
  return /;\s*(?:"[^"]*"|'[^']*')\s*$/.test(command.trim())
}

/**
 * Recover the real exit code from a self-reported footer line such as
 * `shard-B exit: 1`. Returns null when no code is stated.
 */
export function parseEchoedExitCode(text: string): number | null {
  const matches = text.match(/(?:^|\n)[^\n]*?\b(?:exit|code|rc)[:\s]\s*(-?\d+)\s*$/gim)
  if (!matches?.length) return null
  const last = matches[matches.length - 1]!
  const parsed = last.match(/(-?\d+)\s*$/)
  if (!parsed?.[1]) return null
  const code = Number(parsed[1])
  return Number.isFinite(code) ? code : null
}

/** Append PowerShell hints for common Windows footguns seen in agent runs. */
export function appendPowerShellCompatHint(
  content: string,
  exitCode: number | null,
  stderr: string,
  resolved: ResolvedTerminalShell,
  command = ''
): string {
  if (resolved !== 'powershell' || exitCode === null) return content
  // Masking is a failure even though the shell reported 0 — it must not be
  // gated behind `exitCode !== 0`, or every masked failure is silently lost.
  if (isMaskedExitCommand(command)) {
    return `${content}\n\n[Exit code masked] This command ends with a trailing string literal (e.g. \u2026; "shard exit: $LASTEXITCODE"), so the shell exits 0 regardless of the real result. Run the command alone, or end with \`exit $LASTEXITCODE\`, so failures are reported.`
  }
  if (exitCode === 0) return content
  if (/running scripts is disabled|npm\.ps1 cannot be loaded/i.test(stderr)) {
    return `${content}\n\n[Windows hint] npm is blocked by PowerShell execution policy. Use npm.cmd instead of npm (e.g. npm.cmd test), or run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned.`
  }
  if (/invalid statement separator.*&&|token '&&'/i.test(stderr)) {
    return `${content}\n\n[Windows hint] && is not valid in Windows PowerShell 5.x. Use ; between statements, separate terminal calls, or pwsh 7+.`
  }
  if (
    /string is missing the terminator|expression was expected after '\('|The term '=' is not recognized/i.test(
      stderr
    )
  ) {
    return `${content}\n\n[Windows hint] PowerShell parse error. If this session is already PowerShell, do not wrap the body in powershell -Command — $variables are expanded twice. Pass the statements directly.`
  }
  // 75135925: `($_ .Line` and `$log -split` on a path string.
  if (/Unexpected token '\.[A-Za-z_]/i.test(stderr)) {
    let hint =
      'PowerShell member access cannot have a space before the dot. Write $_.Line not $_ .Line.'
    if (/-split/i.test(command) || /-split/i.test(content)) {
      hint +=
        ' To scan a log file, Get-Content $path first — do not -split the path string.'
    }
    return `${content}\n\n[Windows hint] ${hint}`
  }
  return content
}

/**
 * Command missing from PATH (92c049d6: `swift --version` / `dotnet --list-sdks`).
 * Exclude `The term '='` — that is a parse error, already hinted above.
 */
export function appendMissingCommandHint(
  content: string,
  exitCode: number | null,
  stderr: string
): string {
  if (exitCode === 0 || exitCode === null) return content
  if (/The term '=' is not recognized/i.test(stderr)) return content
  if (
    !/is not recognized as the name of a cmdlet|is not recognized as an internal or external command|command not found/i.test(
      stderr
    )
  ) {
    return content
  }
  return `${content}\n\n[hint] That command is not on PATH. Do not retry the same invocation. Locate the executable or state the missing toolchain.`
}

/**
 * findstr exit 1 = no matches (soft success). Exit 2 = error.
 * Reject catastrophic stderr (command missing / path errors).
 */
export function isFindstrNoMatch(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (exitCode !== 1) return false
  if (lastPipelineCommandToken(command) !== 'findstr') return false
  if (/not recognized|cannot find the (?:path|file)|The system cannot find/i.test(stderr)) {
    return false
  }
  // No matches → empty/minimal stdout
  return stdout.trim().length === 0
}

/**
 * Decode child-process output that may arrive as UTF-16LE. Windows system
 * binaries (wsl.exe, reg.exe, some .NET CLIs) write UTF-16 to piped stdout/
 * stderr; decoded as UTF-8 it becomes NUL-mojibake (`T\u0000h\u0000e\u0000…`)
 * that is unreadable to the model and defeats every failure-pattern match.
 *
 * Ground truth (2026-08-30 raw capture of `wsl --status 2>&1` under
 * PowerShell) shows three real shapes:
 *  1. plain UTF-8/ASCII — keep as-is;
 *  2. pure UTF-16LE — re-decode as UTF-16LE (BOM tolerated);
 *  3. MIXED: an ASCII prefix (PowerShell error-record chrome) followed by
 *     UTF-16LE payload. Whole-chunk UTF-16 decoding absorbs the padding NULs
 *     as pair high-bytes and turns the ASCII prefix into CJK garbage, so for
 *     mixed chunks the least-lossy repair is stripping the padding NULs from
 *     the UTF-8 decode: the ASCII prefix and ASCII-under-UTF-16 body both read
 *     cleanly (PowerShell's `At line:`/CategoryInfo chrome is ASCII and is
 *     filtered later by stripPowerShellPatternNoise).
 * Shape 2 vs 3 discriminator: strip the NULs from the UTF-8 decode — a mixed
 * stream reads ~100% printable ASCII, while pure UTF-16 with chars ≥ U+0100
 * leaves replacement-character garbage (→ prefer the true UTF-16 decode).
 * Scope limit: without a BOM or a NUL signature, UTF-16 text (e.g. CJK-only
 * output) is byte-identical to valid UTF-8 and is deliberately left as UTF-8 —
 * guessing there would corrupt genuine UTF-8 output.
 * Chunk-level: mixed streams keep each side in its own encoding.
 */
export function decodeConsoleText(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  // A UTF-16LE BOM is an explicit encoding declaration — trust it immediately.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const withBom = buf.toString('utf16le')
    return withBom.charCodeAt(0) === 0xfeff ? withBom.slice(1) : withBom
  }
  // Repair candidate: UTF-8 decode with padding NULs removed. UTF-16-encoded
  // ASCII — pure (`T\0h\0e\0…`), mixed with an ASCII chrome prefix, or short
  // whitespace chunks (`0A 00` = one UTF-16 newline) — reads ~100% printable
  // ASCII after the strip. Legitimate UTF-8 output has no NULs and is
  // returned untouched; binary noise does not reach the 0.95 printable ratio
  // and keeps the original decode (never worse than the pre-fix behavior).
  // eslint-disable-next-line no-control-regex -- removing NUL padding IS the purpose
  const stripped = utf8.replace(/\u0000/g, '')
  if (stripped.length === utf8.length) return utf8 // no NULs: nothing to repair
  let printable = 0
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped.charCodeAt(i)
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) printable++
  }
  if (printable / Math.max(stripped.length, 1) >= 0.95) return stripped
  // NUL-bearing but not ASCII-dominant: plausibly UTF-16 with non-ASCII text —
  // but only when the UTF-16 decode is itself clean. Binary noise must never
  // be transmuted; fall through to the status-quo UTF-8 decode otherwise.
  const utf16Raw = buf.toString('utf16le')
  const utf16 = utf16Raw.charCodeAt(0) === 0xfeff ? utf16Raw.slice(1) : utf16Raw
  if (!utf16.includes('\u0000')) {
    let printable16 = 0
    for (let i = 0; i < utf16.length; i++) {
      const c = utf16.charCodeAt(i)
      if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) printable16++
    }
    if (printable16 / Math.max(utf16.length, 1) >= 0.95) return utf16
  }
  // Unrecoverable: keep the original UTF-8 decode.
  return utf8
}

/**
 * Windows environment probes that exit non-zero when the target is absent —
 * `podman --version 2>&1` on a machine without podman fails with
 * CommandNotFoundException even though the probe was answered ("not
 * installed"). `--status`/`--list` probes answer with "<X> is not installed".
 * Informative outcome, not a tool fault (run 1de9344a burned its failure
 * budget on exactly these). Parse errors (`The term '='`) are never probes.
 */
export function isCommandProbeNoTarget(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (exitCode == null || exitCode === 0) return false
  if (!/(?:--version|--status|--list|\s-v\b)/.test(command)) return false
  const combined = `${stdout}\n${stderr}`
  if (/The term '=' is not recognized/i.test(combined)) return false
  if (/(?:--status|--list)/.test(command)) {
    return /\bis not installed\b|\bis not recognized as (?:the name of a cmdlet|an internal or external command)|command not found/i.test(
      combined
    )
  }
  return /is not recognized as (?:the name of a cmdlet|an internal or external command)|command not found/i.test(
    combined
  )
}

/**
 * Parse a terminal result frame for classification. `parseTerminalOutput`
 * requires `exit_code` to be the trailing line, but appendMissingCommandHint /
 * appendWindowsCompatHint append hint text after it — fall back to a multiline
 * match so classified frames keep their exit code (exit_code appears exactly
 * once; the masked-exit correction rewrites it in place).
 */
function parseTerminalFrame(content: string): {
  stdout: string
  stderr: string
  exitCode: number | null
  command: string
} {
  const parsed = parseTerminalOutput(content)
  let exitCode = parsed.exitCode
  if (exitCode == null) {
    const match = /^exit_code:\s*(-?\d+)\s*$/m.exec(content)
    if (match) exitCode = Number(match[1])
  }
  return { stdout: parsed.stdout, stderr: parsed.stderr, exitCode, command: parsed.command ?? '' }
}

/** Parse terminal tool content for the probe no-target soft success. Exported for tests. */
export function isCommandProbeNoTargetContent(command: string, content: string): boolean {
  const parsed = parseTerminalFrame(content)
  if (parsed.exitCode == null) return false
  // Session-poll frames carry the real command in their header; prefer it when
  // the caller passed the session id placeholder instead.
  return isCommandProbeNoTarget(parsed.command || command, parsed.exitCode, parsed.stdout, parsed.stderr)
}

/**
 * Remote grep no-match over SSH (run 1de9344a invoke 2): `ssh … grep -q …`
 * exiting 1 with empty stdout/stderr means "pattern not found (yet)" — a
 * polling answer, not a tool fault, exactly like cmd's findstr no-match.
 * Guards: exit 1 only (2 = usage/grep error stays a failure), last pipeline
 * stage is ssh, the remote command actually invokes grep (bare-ssh failures
 * stay real), empty stdout AND stderr (connection/auth errors print to
 * stderr and stay real), and not a ssh -V/-G version probe.
 * Retry-once quirks in the harness / a flaky tunnel produce the same shape;
 * the stamp text keeps the model informed and the tool is already
 * rate-neutral, so a bounded informative outcome is correct here.
 */
export function isRemoteGrepNoMatch(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (exitCode !== 1) return false
  if (primaryCommandToken(command) !== 'ssh') return false
  if (stdout.trim().length > 0 || stderr.trim().length > 0) return false
  if (/ssh\s+(-[A-Za-z]*[VG]\b|\s--[a-z-]*version)/i.test(command)) return false
  // Remote command = the ssh argument following the destination; require grep.
  // Preceding char includes ( and ` — real invocations are $(grep …) / `grep …`.
  return /(?:^|[\s"'`(])grep(?:\s|["')]|$)/.test(command)
}

/** Parse terminal tool content for the remote grep no-match soft success. Exported for tests. */
export function isRemoteGrepNoMatchContent(command: string, content: string): boolean {
  const parsed = parseTerminalFrame(content)
  if (parsed.exitCode == null) return false
  return isRemoteGrepNoMatch(parsed.command || command, parsed.exitCode, parsed.stdout, parsed.stderr)
}

/**
 * Windows elevation denials (run 1de9344a): the request was refused before any
 * system state changed — winget `0x80073d28` ("administrator privileges are
 * required"), a declined/dismissed UAC dialog (`Start-Process -Verb RunAs` →
 * "The operation was canceled by the user"). The answer is "needs one admin
 * action", not a retryable tool fault. Deliberately excludes bare
 * "access is denied" — that also fires for real auth/permission failures
 * (git push, file ACLs) which must stay failures.
 */
export function isElevationDenied(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  void command
  if (exitCode == null || exitCode === 0) return false
  const combined = `${stdout}\n${stderr}`
  return (
    /administrator privileges are required/i.test(combined) ||
    /0x80073d28/.test(combined) ||
    /The operation was canceled by the user/i.test(combined)
  )
}

/** Parse terminal tool content for the elevation-denied soft success. Exported for tests. */
export function isElevationDeniedContent(command: string, content: string): boolean {
  const parsed = parseTerminalFrame(content)
  if (parsed.exitCode == null) return false
  return isElevationDenied(parsed.command || command, parsed.exitCode, parsed.stdout, parsed.stderr)
}

/**
 * A process-kill sweep (Get-CimInstance/Get-Process enumeration piping PIDs
 * into `taskkill /PID … /T /F`) that confirms kills in stdout is an
 * informative sweep, not a tool fault: taskkill exits 128 ("process not
 * found") when a PID from the enumerated list already exited mid-sweep, even
 * though the sweep did its job (run 82889e99: killed both vitest PIDs,
 * follow-up probe reported no survivors, frame still carried exit_code 128 —
 * rendered as a red "failed (128)" row and fed the tool-failure streak).
 * Access denials (exit 1), sweeps with no kill confirmations, and plain
 * `taskkill` invocations stay real failures.
 */
export function isProcessKillSweep(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (exitCode !== 128) return false
  if (!/\btaskkill\b/i.test(command)) return false
  if (!/Get-(CimInstance|WmiObject|Process)\b/i.test(command)) return false
  if (/Access is denied/i.test(`${stdout}\n${stderr}`)) return false
  return /(?:^|\n)\s*killed \d+/i.test(stdout)
}

/** Parse terminal tool content for the kill-sweep soft success. Exported for tests. */
export function isProcessKillSweepContent(command: string, content: string): boolean {
  const parsed = parseTerminalFrame(content)
  if (parsed.exitCode == null) return false
  return isProcessKillSweep(parsed.command || command, parsed.exitCode, parsed.stdout, parsed.stderr)
}

/**
 * Strip PowerShell error-record chrome before terminal pattern matching.
 * Native stderr redirection adds CategoryInfo / FullyQualifiedErrorId lines that
 * contain "Error" even when the underlying command output does not.
 */
export function stripPowerShellPatternNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*\+\s*(CategoryInfo|FullyQualifiedErrorId)\s*:/.test(line)) return false
      if (/^At line:\d+ char:\d+/.test(line)) return false
      if (/^\s*\+\s*~+\s*$/.test(line)) return false
      return true
    })
    .join('\n')
}

/** Parse terminal tool content for findstr no-match soft success. Exported for tests. */
export function isFindstrNoMatchContent(command: string, content: string): boolean {
  const { stdout, stderr, exitCode } = parseTerminalOutput(content)
  if (exitCode == null) return false
  let cleanedStdout = stdout.replace(/^findstr: no matches\n?/m, '')
  return isFindstrNoMatch(command, exitCode, cleanedStdout, stderr)
}

/**
 * Windows `dir` exit 1 when the target path does not exist — informative, not a tool fault.
 */
export function isDirMissingPath(
  command: string,
  exitCode: number | null | undefined,
  stdout: string,
  stderr: string
): boolean {
  if (process.platform !== 'win32') return false
  if (exitCode !== 1) return false
  if (primaryCommandToken(command) !== 'dir') return false
  const combined = `${stdout}\n${stderr}`
  if (/not recognized|cannot find the (?:path|file)|The system cannot find/i.test(combined)) {
    return true
  }
  if (/File Not Found/i.test(combined)) return true
  return false
}

/** Parse terminal tool content for dir missing-path soft success. Exported for tests. */
export function isDirMissingPathContent(command: string, content: string): boolean {
  const { stdout, stderr, exitCode } = parseTerminalOutput(content)
  if (exitCode == null) return false
  const cleanedStdout = stdout.replace(/^dir: path not found\n?/m, '')
  return isDirMissingPath(command, exitCode, cleanedStdout, stderr)
}

function formatTerminalOutput(
  cwd: string,
  command: string,
  stdout: string,
  stderr: string,
  code: number | null,
  annotations: string[],
  resolved: ResolvedTerminalShell
): string {
  const cmdSoft = resolved === 'cmd'
  const dirMissing = cmdSoft && isDirMissingPath(command, code, stdout, stderr)
  // Informative non-zero exits answer the question asked ("is podman
  // installed?" → no; "install WSL" → needs one admin click). Stamped in the
  // result so the model reads the verdict even though exit_code stays
  // non-zero; terminalResultOk classifies these as ok.
  const probeNoTarget = isCommandProbeNoTarget(command, code, stdout, stderr)
  const remoteGrepNoMatch =
    !probeNoTarget && isRemoteGrepNoMatch(command, code, stdout, stderr)
  const elevationDenied =
    !probeNoTarget && !remoteGrepNoMatch && isElevationDenied(command, code, stdout, stderr)
  let out = [
    `cwd: ${cwd}`,
    `shell: ${resolved}`,
    '',
    ...annotations,
    stdout,
    dirMissing ? 'dir: path not found' : '',
    stderr ? `stderr:\n${stderr}` : '',
    probeNoTarget
      ? 'probe: target not found (informative — the answer is "not installed", do not retry the same probe)'
      : '',
    elevationDenied
      ? 'elevation: denied (informative — one admin/UAC action is required; ask the user or use a non-elevated fallback, do not retry the same command)'
      : '',
    remoteGrepNoMatch
      ? 'remote-grep: no match (informative — the remote grep found nothing yet, not a failure; poll later or change the search)'
      : '',
    `exit_code: ${code ?? -1}`
  ]
    .filter(Boolean)
    .join('\n')
  // A masked command reports the shell's code (0) while the real result is
  // whatever the command echoed. Correct the verdict BEFORE the hints append
  // their own trailing text — after that, it is no longer the last line.
  if (isMaskedExitCommand(command)) {
    const echoed = parseEchoedExitCode(`${stdout}\n${stderr}`)
    if (echoed != null && echoed !== 0 && echoed !== code) {
      out = out.replace(/\nexit_code:\s*-?\d+\s*$/, `\nexit_code: ${echoed}`)
    }
  }
  out = appendWindowsCompatHint(command, out, code, resolved)
  out = appendPowerShellCompatHint(out, code, stderr, resolved, command)
  out = appendMissingCommandHint(out, code, stderr)
  return out
}

/** Format background/poll terminal session output for the model + TerminalBody parser. */
export function formatTerminalSessionOutput(input: {
  cwd: string
  command: string
  shell: ResolvedTerminalShell
  stdout: string
  stderr: string
  exitCode: number | null
  sessionId: string
  status: string
}): string {
  const base = formatTerminalOutput(
    input.cwd,
    input.command,
    input.stdout,
    input.stderr,
    input.exitCode,
    [],
    input.shell
  )
  return [`session_id: ${input.sessionId}`, `status: ${input.status}`, `command: ${input.command}`, base].join(
    '\n'
  )
}

/**
 * Minimal env for child shells — omit parent secrets (API keys, tokens) that
 * live on process.env in the Electron main process.
 */
export function sanitizedTerminalEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const keys = [
    'PATH',
    'Path',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'USERNAME',
    'USER',
    'LOGNAME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'ComSpec',
    'COMSPEC',
    'SystemRoot',
    'SYSTEMROOT',
    'SystemDrive',
    'SYSTEMDRIVE',
    'windir',
    'WINDIR',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'SHELL',
    'PWD',
    'OLDPWD',
    'HOMEBREW_PREFIX',
    'HOMEBREW_CELLAR',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'PROGRAMDATA',
    'ALLUSERSPROFILE',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'CommonProgramW6432',
    'PUBLIC',
    'HOMEDRIVE',
    'HOMEPATH',
    'GH_CONFIG_DIR',
    'XDG_CONFIG_HOME'
  ]

  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  // Ensure PATH exists even if the parent somehow lacks it.
  if (!env.PATH && !env.Path) {
    env.PATH = source.PATH ?? source.Path ?? ''
  }
  applyWindowsFolderDefaults(env, source)
  return env
}

/**
 * NuGet/MSBuild (92c049d6) call Path.Combine(CommonApplicationData, …) and
 * crash with `path1` null when ProgramData is stripped from the child env.
 */
function applyWindowsFolderDefaults(
  env: Record<string, string>,
  source: NodeJS.ProcessEnv
): void {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || source.SystemRoot || source.SYSTEMROOT
  if (!systemRoot) return
  const drive = (
    env.SystemDrive ||
    env.SYSTEMDRIVE ||
    source.SystemDrive ||
    source.SYSTEMDRIVE ||
    'C:'
  ).replace(/\\$/, '')
  const defaults: Record<string, string> = {
    ProgramData: `${drive}\\ProgramData`,
    ALLUSERSPROFILE: `${drive}\\ProgramData`,
    ProgramFiles: `${drive}\\Program Files`,
    'ProgramFiles(x86)': `${drive}\\Program Files (x86)`,
    ProgramW6432: `${drive}\\Program Files`,
    CommonProgramFiles: `${drive}\\Program Files\\Common Files`,
    'CommonProgramFiles(x86)': `${drive}\\Program Files (x86)\\Common Files`,
    PUBLIC: `${drive}\\Users\\Public`
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!env[key]) env[key] = fallback
  }
}

export type ToolTerminalOptions = {
  timeoutMs?: number
  /** Settings preference; resolved at spawn time. */
  shell?: TerminalShell
  /** Absolute cwd already resolved inside the workspace (defaults to workspace root). */
  cwd?: string
  /** Live stdout/stderr chunks for UI streaming (capped with the buffers). */
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
}

export async function toolTerminal(
  workspaceRoot: string,
  command: string,
  signal: AbortSignal,
  timeoutMsOrOpts: number | ToolTerminalOptions = TERMINAL_DEFAULT_TIMEOUT_MS
): Promise<string> {
  assertInsideWorkspace(workspaceRoot, '.')

  const opts: ToolTerminalOptions =
    typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts
  const timeoutMs = Math.max(1, opts.timeoutMs ?? TERMINAL_DEFAULT_TIMEOUT_MS)
  const cwd = opts.cwd ?? workspaceRoot
  const resolved = resolveTerminalShell(opts.shell ?? 'auto')
  const spec = terminalSpawnSpec(command, resolved)

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const docxUnzip = terminalDocxUnzipPreflight(command, resolved, cwd)
    if (docxUnzip) {
      resolve(docxUnzip)
      return
    }

    const nested = terminalNestedPowerShellPreflight(command, resolved, cwd)
    if (nested) {
      resolve(nested)
      return
    }

    const selfKill = terminalSelfKillPreflight(command, resolved, cwd)
    if (selfKill) {
      resolve(selfKill)
      return
    }

    if (resolved === 'bash' && !commandOnPath('bash')) {
      resolve(
        [
          `cwd: ${cwd}`,
          'shell: bash',
          '',
          'bash was not found on PATH. Install Git Bash or set Terminal shell to auto/PowerShell/cmd.',
          'exit_code: 1'
        ].join('\n')
      )
      return
    }

    if (resolved === 'powershell' && !commandOnPath('pwsh') && !commandOnPath('powershell')) {
      resolve(
        [
          `cwd: ${cwd}`,
          'shell: powershell',
          '',
          'PowerShell was not found on PATH. Set Terminal shell to cmd or install PowerShell.',
          'exit_code: 1'
        ].join('\n')
      )
      return
    }

    const child = spawn(spec.bin, spec.args, {
      cwd,
      env: sanitizedTerminalEnv(),
      windowsHide: true
    })
    if (child.pid) lowerProcessPriority(child.pid)

    let stdout = ''
    let stderr = ''
    let settled = false
    let outputCapped = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const onAbort = (): void => {
      if (child.pid) killProcessTree(child.pid, 'abort')
      finish(() => reject(new DOMException('Aborted', 'AbortError')))
    }

    const timer = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid, 'timeout')
      finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    signal.addEventListener('abort', onAbort)

    child.stdout.on('data', (buf: Buffer) => {
      const text = decodeConsoleText(buf)
      // Capture cap: stop appending once at TERMINAL_MAX_OUTPUT but keep the
      // stream draining so the child never blocks on a full pipe.
      if (stdout.length < TERMINAL_MAX_OUTPUT) {
        const room = TERMINAL_MAX_OUTPUT - stdout.length
        stdout += text.length > room ? text.slice(0, room) : text
        if (text.length > room) outputCapped = true
      } else {
        outputCapped = true
      }
      if (text) opts.onOutput?.({ text, stream: 'stdout' })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = decodeConsoleText(buf)
      if (stderr.length < TERMINAL_MAX_OUTPUT) {
        const room = TERMINAL_MAX_OUTPUT - stderr.length
        stderr += text.length > room ? text.slice(0, room) : text
        if (text.length > room) outputCapped = true
      } else {
        outputCapped = true
      }
      if (text) opts.onOutput?.({ text, stream: 'stderr' })
    })

    child.on('error', (err) => {
      finish(() => reject(err))
    })

    child.on('close', (code) => {
      const findstrNoMatch =
        resolved === 'cmd' && isFindstrNoMatch(command, code, stdout, stderr)
      const out = formatTerminalOutput(
        cwd,
        command,
        stdout,
        stderr,
        code,
        [
          findstrNoMatch ? 'findstr: no matches' : '',
          outputCapped
            ? `[truncated] output exceeded ${TERMINAL_MAX_OUTPUT} chars per stream; narrow the command (head/tail/grep) for the rest`
            : ''
        ],
        resolved
      )
      finish(() => resolve(out))
    })
  })
}

/** Exported for unit tests. */
export { unixShellInvocation }
