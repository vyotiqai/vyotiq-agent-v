export type ParsedTerminalOutput = {
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  /** Background/poll session status when present (`running`, `timeout`, …). */
  sessionStatus: string | null
  sessionId: string | null
  /** `command:` header from a session poll (omitted on new-command results). */
  command: string | null
}

/**
 * Background-session statuses where the process is still alive (or still
 * pollable). Their frames carry the placeholder `exit_code: -1`, which is not
 * a failure — mirrors the main-process terminalResultOk rule.
 */
export function isTerminalSessionInProgress(status: string | null | undefined): boolean {
  return status === 'running' || status === 'timeout' || status === 'pattern_matched'
}

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const ANSI_OTHER_RE = new RegExp(`${ESC}[PX^_][^${ESC}]*`, 'g')

/**
 * Strip ANSI/OSC sequences and apply per-line CR overwrite so PowerShell progress
 * bars and Format-Table color codes render as plain readable text in `<pre>`.
 *
 * Normalize CRLF before CR overwrite so Windows `line\r\n` is not wiped to empty.
 * Call on the full accumulated buffer (not per chunk) so `\r` progress across
 * stream pieces can overwrite the prior progress line.
 */
export function sanitizeTerminalDisplayText(text: string): string {
  if (!text) return ''
  const stripped = text
    .replace(/\r\n/g, '\n')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_OTHER_RE, '')
  return stripped
    .split('\n')
    .map((line) => {
      const cr = line.lastIndexOf('\r')
      return cr >= 0 ? line.slice(cr + 1) : line
    })
    .join('\n')
}

/** Strip cwd/shell headers injected by toolTerminal before parsing exit metadata. */
export function stripTerminalCwdHeader(content: string): string {
  return content.replace(/^cwd:.*\n(?:shell:.*\n)?\n?/m, '')
}

/**
 * Strip session poll headers (`session_id` / `status` / leading `command:`) so they
 * are not shown as stdout in TerminalBody.
 */
export function stripTerminalSessionHeader(content: string): {
  body: string
  sessionId: string | null
  sessionStatus: string | null
  command: string | null
} {
  let body = content
  let sessionId: string | null = null
  let sessionStatus: string | null = null
  let command: string | null = null
  const idMatch = body.match(/^session_id:\s*(.+)\n?/)
  if (idMatch) {
    sessionId = idMatch[1]!.trim()
    body = body.slice(idMatch[0].length)
  }
  const statusMatch = body.match(/^status:\s*(.+)\n?/)
  if (statusMatch) {
    sessionStatus = statusMatch[1]!.trim()
    body = body.slice(statusMatch[0].length)
  }
  const commandMatch = body.match(/^command:\s*(.+)\n?/)
  if (commandMatch) {
    command = commandMatch[1]!.trim()
    body = body.slice(commandMatch[0].length)
  }
  return { body, sessionId, sessionStatus, command }
}

/**
 * Parse only a trailing `exit_code: N` line (not literal output that happens to
 * contain the same text earlier in stdout/stderr).
 */
function takeTrailingExitCode(text: string): { body: string; exitCode: number | null } {
  const match = text.match(/\nexit_code:\s*(-?\d+)\s*$/) ?? text.match(/^exit_code:\s*(-?\d+)\s*$/)
  if (!match || match.index == null) return { body: text, exitCode: null }
  return {
    body: text.slice(0, match.index).replace(/\s+$/, ''),
    exitCode: Number(match[1])
  }
}

/**
 * Parse terminal tool result text into cwd, streams, and exit code.
 *
 * Format: optional session headers, `cwd: …`, optional stdout, optional `stderr:\n…`,
 * trailing `exit_code: N`.
 */
export function parseTerminalOutput(content: string): ParsedTerminalOutput {
  const { body: withoutSession, sessionId, sessionStatus, command } =
    stripTerminalSessionHeader(content)
  const cwdMatch = withoutSession.match(/^cwd:\s*(.+)$/m)
  const cwd = cwdMatch?.[1]?.trim() ?? ''

  const body = stripTerminalCwdHeader(withoutSession)
  const { body: withoutExit, exitCode } = takeTrailingExitCode(body)

  let stderr = ''
  let stdout = withoutExit
  if (withoutExit.startsWith('stderr:\n')) {
    stdout = ''
    stderr = withoutExit.slice('stderr:\n'.length).replace(/\s+$/, '')
  } else {
    const marker = '\nstderr:\n'
    const stderrIdx = withoutExit.indexOf(marker)
    if (stderrIdx >= 0) {
      stdout = withoutExit.slice(0, stderrIdx).replace(/\s+$/, '')
      stderr = withoutExit.slice(stderrIdx + marker.length).replace(/\s+$/, '')
    }
  }

  return { cwd, stdout, stderr, exitCode, sessionStatus, sessionId, command }
}
