import { describe, expect, it } from 'vitest'
import { lineDiffStat } from '@shared/utils/lineDiffStat'
import { formatUnifiedDiff, lineDiff, type DiffHunk } from '@shared/utils/unifiedDiff'

const text = (...lines: string[]): string => (lines.length > 0 ? `${lines.join('\n')}\n` : '')

/** Rebuild the new text from the old one and the hunks; asserts every context and removed line. */
function apply(before: string[], hunks: DiffHunk[]): string[] {
  const out: string[] = []
  let at = 0
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    while (at < start) out.push(before[at++]!)
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        out.push(line.text)
        continue
      }
      expect(before[at]).toBe(line.text)
      if (line.kind === ' ') out.push(before[at]!)
      at += 1
    }
  }
  while (at < before.length) out.push(before[at++]!)
  return out
}

describe('lineDiff', () => {
  it('prints an added function the way git does, headed by the function above it', () => {
    const before = text("import { a } from './a'", '', 'export function one() {', '  return 1', '}', '', 'export function two() {', '  return 2', '}')
    const after = text(
      "import { a } from './a'",
      '',
      'export function one() {',
      '  return 1',
      '}',
      '',
      'export function mid() {',
      '  return 1.5',
      '}',
      '',
      'export function two() {',
      '  return 2',
      '}'
    )
    const diff = lineDiff(before, after)
    // Byte for byte what `git diff --no-index` printed for these two files.
    expect(formatUnifiedDiff('src/f.ts', diff)).toBe(
      [
        '--- a/src/f.ts',
        '+++ b/src/f.ts',
        '@@ -4,6 +4,10 @@ export function one() {',
        '   return 1',
        ' }',
        ' ',
        '+export function mid() {',
        '+  return 1.5',
        '+}',
        '+',
        ' export function two() {',
        '   return 2',
        ' }',
        ''
      ].join('\n')
    )
    expect(diff).toMatchObject({ add: 4, del: 0, full: false })
  })

  it('numbers a new file from 0,0 and a deleted one to 0,0', () => {
    const created = lineDiff('', text('a', 'b'))
    expect(formatUnifiedDiff('n.ts', created, 'created')).toBe('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n')
    const deleted = lineDiff(text('a'), '')
    expect(formatUnifiedDiff('n.ts', deleted, 'deleted')).toBe('--- a/n.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n')
  })

  it('has no hunks for the same text, whatever the line endings', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n').hunks).toEqual([])
  })

  it('keeps nearby changes in one hunk and far ones apart', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const near = [...base]
    near[4] = 'five'
    near[10] = 'eleven'
    expect(lineDiff(text(...base), text(...near)).hunks).toHaveLength(1)
    const far = [...base]
    far[2] = 'three'
    far[25] = 'twenty-six'
    const hunks = lineDiff(text(...base), text(...far)).hunks
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 6, 1, 6],
      [23, 7, 23, 7]
    ])
  })

  it('falls back to a full replacement past the edit budget, and says so', () => {
    const diff = lineDiff(text('a', 'b', 'c'), text('x', 'y', 'z'), { maxEdits: 2 })
    expect(diff.full).toBe(true)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]!.lines.map((l) => l.kind).join('')).toBe('---+++')
  })

  it('agrees with lineDiffStat and rebuilds the new text, on random edits', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const words = ['{', '}', '', 'return x', 'const a = 1', 'export function f() {', '  if (y) {', '// note']
    for (let round = 0; round < 200; round += 1) {
      const a = Array.from({ length: 3 + Math.floor(rand() * 30) }, () => words[Math.floor(rand() * words.length)]!)
      const b = [...a]
      for (let e = 1 + Math.floor(rand() * 5); e > 0; e -= 1) {
        const at = Math.floor(rand() * (b.length + 1))
        if (rand() < 0.5 && b.length > 0) b.splice(Math.min(at, b.length - 1), 1)
        else b.splice(at, 0, words[Math.floor(rand() * words.length)]!)
      }
      const diff = lineDiff(text(...a), text(...b))
      expect(lineDiffStat(text(...a), text(...b))).toEqual({ add: diff.add, del: diff.del })
      expect(apply(a, diff.hunks)).toEqual(b)
    }
  })
})
