import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { sanitizeCommandForDisplay, truncateMiddle } from '@shared/utils/displayPath'
import { parseTerminalOutput } from '@shared/utils/terminalFormat'

const NEWLINE_SPLIT = new RegExp('\\r?\\n')

export type TerminalCardData = {
  command: string
  exitCode: number | null
  cwd: string
  shell: string
  output: string
  stderr: string
  sessionStatus: string | null
}

export function parseTerminalCardData(tool: UiToolRow): TerminalCardData {
  const args = parseArgsRecord(tool.argsPreview)
  const content = tool.content ?? ''
  const parsed = parseTerminalOutput(content)
  const command =
    typeof args?.command === 'string'
      ? args.command
      : typeof args?.cmd === 'string'
        ? args.cmd
        : parsed.command || tool.summary || ''

  const { cwd, stdout, stderr, exitCode, sessionStatus } = parsed
  // Prefer the header `shell:` that sits under `cwd:` (toolTerminal format).
  const shellMatch =
    content.match(/^cwd:[^\n]*\nshell:\s*(.+)$/m) ??
    content.match(/\ncwd:[^\n]*\nshell:\s*(.+)$/m) ??
    content.match(/^shell:\s*(.+)$/m)
  const shell = shellMatch?.[1]?.trim() ?? ''

  return { command, exitCode, cwd, shell, output: stdout, stderr, sessionStatus }
}

/**
 * Header secondary for terminal cards: first command line + `, N+` when multi-line.
 * Uses real command/shell data only — never invents free-form titles.
 *
 * Truncating mid-token is what makes two unrelated pipeline stages read as one
 * invented command (`…AddM…t.log`). Prefer a real separator so the header stays
 * honest about what actually ran.
 */
export function formatTerminalHeaderTarget(
  data: Pick<TerminalCardData, 'command' | 'shell'>,
  fallback = '',
  maxLen = 56
): string {
  const lines = data.command
    .split(NEWLINE_SPLIT)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length > 0) {
    const first = commandHeaderLabel(sanitizeCommandForDisplay(lines[0]!), maxLen)
    const extra = lines.length - 1
    return extra > 0 ? `${first}, ${extra}+` : first
  }
  if (data.shell) return data.shell
  return fallback
}

/** Truncate a command for a one-line header without fusing two stages. */
function commandHeaderLabel(command: string, maxLen: number): string {
  if (command.length <= maxLen) return command
  // Cut at a stage separator when one sits inside the budget, so the header
  // ends where a real command ends instead of mid-identifier.
  const sep = command.search(/[|;&]/)
  if (sep > 0 && sep <= maxLen) {
    return `${command.slice(0, sep + 1)} …`
  }
  return truncateMiddle(command, maxLen)
}
