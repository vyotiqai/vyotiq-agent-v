/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { lineLabel, parseReviewDiff, splitRows, unifiedRows } from '@renderer/features/inspector/reviewDiff'
import { reviewSignature, useReviewViewed } from '@renderer/features/inspector/reviewViewed'

const DIFF = [
  'diff --git a/src/nav.tsx b/src/nav.tsx',
  '--- a/src/nav.tsx',
  '+++ b/src/nav.tsx',
  '@@ -14,5 +14,6 @@ export function SettingsNav() {',
  '   return (',
  '-    {ORDER.map((id) => (',
  '+    {GROUPS.map((group) => (',
  '+      <section key={group.id}>',
  '       <NavItem',
  '@@ -41,3 +42,2 @@ function NavItem() {',
  '   const tone = active',
  '-  // Legacy flat order',
  '-  const order = ORDER.indexOf(id)',
  '\\ No newline at end of file'
].join('\n')

describe('parseReviewDiff', () => {
  it('keeps the hunk headers and numbers every line on both sides', () => {
    const parsed = parseReviewDiff(DIFF)
    expect(parsed.hunks.map((h) => h.header)).toEqual([
      '@@ -14,5 +14,6 @@ export function SettingsNav() {',
      '@@ -41,3 +42,2 @@ function NavItem() {'
    ])
    expect(parsed.hunks[0]!.lines.map((l) => [l.kind, l.oldN, l.newN])).toEqual([
      ['ctx', 14, 14],
      ['del', 15, null],
      ['add', null, 15],
      ['add', null, 16],
      ['ctx', 16, 17]
    ])
    expect(parsed.flat).toHaveLength(8)
    expect(parsed.truncated).toBe(false)
  })

  it('sets removed lines against the lines that replaced them, padding the short side', () => {
    const rows = splitRows(parseReviewDiff(DIFF))
    const lines = rows.filter((r) => r.type === 'line')
    const shape = lines.map((r) => (r.type === 'line' ? [r.left?.text ?? null, r.right?.text ?? null] : null))
    expect(shape).toEqual([
      ['  return (', '  return ('],
      ['    {ORDER.map((id) => (', '    {GROUPS.map((group) => ('],
      [null, '      <section key={group.id}>'],
      ['      <NavItem', '      <NavItem'],
      ['  const tone = active', '  const tone = active'],
      ['  // Legacy flat order', null],
      ['  const order = ORDER.indexOf(id)', null]
    ])
    expect(unifiedRows(parseReviewDiff(DIFF)).filter((r) => r.type === 'hunk')).toHaveLength(2)
  })

  it('names a line by its new number, or its old one once it is gone', () => {
    const [hunk] = parseReviewDiff(DIFF).hunks
    expect(hunk!.lines.map(lineLabel)).toEqual([14, 15, 15, 16, 17])
  })

  it('stops at the cap and says so', () => {
    const parsed = parseReviewDiff(DIFF, 3)
    expect(parsed.flat).toHaveLength(3)
    expect(parsed.truncated).toBe(true)
  })
})

describe('useReviewViewed', () => {
  afterEach(() => localStorage.clear())

  it('remembers a mark per review, and only against the change it was made on', () => {
    const file = { status: 'M', added: 3, removed: 1 }
    const { result, rerender } = renderHook(({ key }) => useReviewViewed(key), { initialProps: { key: 'ws::run-1::agent' } })
    act(() => result.current.setViewed('src/a.ts', reviewSignature(file), true))
    expect(result.current.isViewed('src/a.ts', reviewSignature(file))).toBe(true)
    // The agent edits it again: the mark does not carry over.
    expect(result.current.isViewed('src/a.ts', reviewSignature({ ...file, added: 4 }))).toBe(false)

    rerender({ key: 'ws::run-2::agent' })
    expect(result.current.isViewed('src/a.ts', reviewSignature(file))).toBe(false)
    rerender({ key: 'ws::run-1::agent' })
    expect(result.current.isViewed('src/a.ts', reviewSignature(file))).toBe(true)

    act(() => result.current.setViewed('src/a.ts', reviewSignature(file), false))
    expect(result.current.isViewed('src/a.ts', reviewSignature(file))).toBe(false)
  })

  it('forgets the oldest reviews past fifty', () => {
    const { result, rerender } = renderHook(({ key }) => useReviewViewed(key), { initialProps: { key: 'k0' } })
    act(() => result.current.setViewed('a', 's', true))
    for (let i = 1; i <= 50; i += 1) {
      rerender({ key: `k${i}` })
      act(() => result.current.setViewed('a', 's', true))
    }
    rerender({ key: 'k0' })
    expect(result.current.isViewed('a', 's')).toBe(false)
    rerender({ key: 'k50' })
    expect(result.current.isViewed('a', 's')).toBe(true)
  })
})
