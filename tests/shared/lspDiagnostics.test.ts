import { describe, expect, it } from 'vitest'
import {
  lineCharToOffset,
  lspSeverityToCm,
  mapLspDiagnosticsToCm
} from '@shared/utils/lspDiagnostics'

describe('lspSeverityToCm', () => {
  it('maps LSP severities to CodeMirror lint levels', () => {
    expect(lspSeverityToCm('error')).toBe('error')
    expect(lspSeverityToCm('warning')).toBe('warning')
    expect(lspSeverityToCm('info')).toBe('info')
    expect(lspSeverityToCm('hint')).toBe('info')
  })
})

describe('lineCharToOffset', () => {
  it('converts zero-based line/character to document offsets', () => {
    const doc = 'alpha\nbeta\ngamma'
    expect(lineCharToOffset(doc, 0, 0)).toBe(0)
    expect(lineCharToOffset(doc, 0, 3)).toBe(3)
    expect(lineCharToOffset(doc, 1, 2)).toBe(8)
    expect(lineCharToOffset(doc, 2, 0)).toBe(11)
  })
})

describe('mapLspDiagnosticsToCm', () => {
  it('maps LSP diagnostics to CodeMirror ranges', () => {
    const doc = 'const x = 1\nlet y = 2'
    const mapped = mapLspDiagnosticsToCm(doc, [
      {
        line: 1,
        character: 4,
        message: 'Unexpected token',
        severity: 'error'
      }
    ])
    expect(mapped).toEqual([
      {
        from: 16,
        to: 21,
        severity: 'error',
        message: 'Unexpected token'
      }
    ])
  })
})
