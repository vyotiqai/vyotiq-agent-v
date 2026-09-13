import { describe, expect, it } from 'vitest'
import { parseReadData } from '@renderer/features/chat/toolUi/parsers/read'
import type { UiToolRow } from '@shared/transcript'

function readTool(content: string, argsPreview?: string): UiToolRow {
  return {
    id: 'r1',
    name: 'read',
    summary: 'src/game.js',
    status: 'done',
    content,
    argsPreview
  }
}

describe('parseReadData', () => {
  it('strips --- lines --- header and uses its start line for gutters', () => {
    const parsed = parseReadData(
      readTool('--- lines 120-122 of 400 ---\nconst a = 1\nconst b = 2\nconst c = 3\n')
    )
    expect(parsed.startLine).toBe(120)
    expect(parsed.lines).toEqual(['const a = 1', 'const b = 2', 'const c = 3'])
    expect(parsed.lineRange).toBe('L120-122')
    expect(parsed.lines[0]).not.toContain('--- lines')
  })

  it('prefers startLine from args when present', () => {
    const parsed = parseReadData(
      readTool('--- lines 10-12 of 50 ---\none\ntwo\n', JSON.stringify({ path: 'a.ts', startLine: 10 }))
    )
    expect(parsed.startLine).toBe(10)
    expect(parsed.lineRange).toBe('L10+')
  })

  it('does not treat a failed read error as a line slice', () => {
    const parsed = parseReadData({
      id: 'r1',
      name: 'read',
      summary: 'package.json',
      status: 'fail',
      argsPreview: JSON.stringify({
        path: 'package.json',
        startLine: 1,
        endLine: 240,
        offset: 1
      }),
      content: 'offset: offset/limit cannot be combined with startLine/endLine'
    })
    expect(parsed.path).toBe('package.json')
    expect(parsed.lineRange).toBe('')
    expect(parsed.lines).toEqual([])
    expect(parsed.isDirectory).toBe(false)
  })
})
