export type LspDiagnosticItem = {
  line: number
  character: number
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
}

export type CmLintDiagnostic = {
  from: number
  to: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

export function lspSeverityToCm(
  severity: LspDiagnosticItem['severity']
): CmLintDiagnostic['severity'] {
  switch (severity) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case 'hint':
    case 'info':
      return 'info'
    default: {
      const _exhaustive: never = severity
      return _exhaustive
    }
  }
}

export function lineCharToOffset(doc: string, line: number, character: number): number {
  if (line < 0) return 0
  let offset = 0
  let lineIndex = 0
  while (lineIndex < line) {
    const nextBreak = doc.indexOf('\n', offset)
    if (nextBreak < 0) return doc.length
    offset = nextBreak + 1
    lineIndex += 1
  }
  const nextBreak = doc.indexOf('\n', offset)
  const lineEnd = nextBreak < 0 ? doc.length : nextBreak
  const lineLength = lineEnd - offset
  return offset + Math.min(Math.max(0, character), lineLength)
}

export function mapLspDiagnosticsToCm(
  doc: string,
  items: readonly LspDiagnosticItem[]
): CmLintDiagnostic[] {
  const output: CmLintDiagnostic[] = []
  for (const item of items) {
    const from = lineCharToOffset(doc, item.line, item.character)
    const lineEnd = doc.indexOf('\n', from)
    const to = lineEnd < 0 ? doc.length : Math.max(from + 1, lineEnd)
    output.push({
      from,
      to,
      severity: lspSeverityToCm(item.severity),
      message: item.message
    })
  }
  return output
}
