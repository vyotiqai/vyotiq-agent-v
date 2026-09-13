import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type DiagnosticIssue = {
  file: string
  line: number
  col: number
  severity: string
  message: string
}

export type DiagnosticsParsed = {
  kind: string
  command: string
  exit: string
  count: number
  truncated: boolean
  issues: DiagnosticIssue[]
  /** Unparsed leftover output lines when no structured issues. */
  rawLines: string[]
  message: string
}

const ISSUE_RE = /^(.+?):(\d+):(\d+):\s*(error|warning|info):\s*(.+)$/i

/** Parse diagnostics tool content from toolDiagnosticsAsync. */
export function parseDiagnosticsData(tool: UiToolRow): DiagnosticsParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const kind = typeof args?.kind === 'string' ? args.kind : ''
  const content = tool.content ?? ''
  const lines = content.split(/\r?\n/)

  let command = ''
  let exit = ''
  let count = 0
  let truncated = false
  const issues: DiagnosticIssue[] = []
  const rawLines: string[] = []
  let pastHeader = false

  for (const line of lines) {
    const cmd = /^command:\s*(.+)$/i.exec(line)
    if (cmd) {
      command = cmd[1]!.trim()
      continue
    }
    const ex = /^exit:\s*(.+)$/i.exec(line)
    if (ex) {
      exit = ex[1]!.trim()
      continue
    }
    const diag = /^diagnostics:\s*(\d+)(\+)?$/i.exec(line.trim())
    if (diag) {
      count = Number(diag[1])
      truncated = Boolean(diag[2])
      pastHeader = true
      continue
    }
    if (!line.trim()) {
      pastHeader = true
      continue
    }
    const issue = ISSUE_RE.exec(line.trim())
    if (issue) {
      issues.push({
        file: issue[1]!,
        line: Number(issue[2]),
        col: Number(issue[3]),
        severity: (issue[4] || 'error').toLowerCase(),
        message: issue[5]!.trim()
      })
      pastHeader = true
      continue
    }
    if (pastHeader || !command) {
      rawLines.push(line)
    }
  }

  if (count === 0) count = issues.length

  return {
    kind,
    command,
    exit,
    count,
    truncated,
    issues,
    rawLines: issues.length > 0 ? [] : rawLines.filter((l) => l.trim()),
    message: issues.length === 0 && rawLines.length === 0 ? content.trim() : ''
  }
}
