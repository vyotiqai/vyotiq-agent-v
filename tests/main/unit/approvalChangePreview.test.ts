import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { APPROVAL_PREVIEW_MAX_LINES, buildApprovalChangePreview } from '@main/agent/approvalChangePreview'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-approval-preview-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const json = (value: unknown): string => JSON.stringify(value)

describe('edit approval preview', () => {
  it('shows a str_replace as the lines it removes and the lines it adds', () => {
    const preview = buildApprovalChangePreview(
      'str_replace',
      json({ path: 'src/math.js', old_string: 'return a - b\n', new_string: 'return a + b\n' }),
      root
    )
    expect(preview).toMatchObject({
      path: 'src/math.js',
      action: 'modify',
      add: 1,
      del: 1,
      hiddenLines: 0,
      lines: [
        { kind: '-', text: 'return a - b' },
        { kind: '+', text: 'return a + b' }
      ]
    })
    expect(
      buildApprovalChangePreview('str_replace', json({ path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true }), root)
        ?.everyMatch
    ).toBe(true)
  })

  it('reads a unified diff the model wrote, hunk headers as breaks', () => {
    const diff = ['--- a/src/math.js', '+++ b/src/math.js', '@@ -1,3 +1,3 @@', ' function add(a, b) {', '-  return a - b', '+  return a + b', ' }'].join('\n')
    const preview = buildApprovalChangePreview('edit', json({ path: 'src/math.js', diff }), root)
    expect(preview?.lines.map((l) => l.kind)).toEqual(['@', ' ', '-', '+', ' '])
    expect(preview).toMatchObject({ add: 1, del: 1, action: 'modify' })
  })

  it('diffs a whole-file write against the file on disk', () => {
    writeFileSync(join(root, 'math.js'), 'function add(a, b) {\n  return a - b\n}\n', 'utf8')
    const preview = buildApprovalChangePreview(
      'edit',
      json({ path: 'math.js', contents: 'function add(a, b) {\n  return a + b\n}\n' }),
      root
    )
    expect(preview).toMatchObject({ action: 'modify', add: 1, del: 1 })
    expect(preview?.lines[0]?.kind).toBe('@')
    expect(preview?.lines.filter((l) => l.kind !== '@' && l.kind !== ' ')).toEqual([
      { kind: '-', text: '  return a - b' },
      { kind: '+', text: '  return a + b' }
    ])
  })

  it('calls a write to a missing file a new file, and with no workspace a rewrite', () => {
    const args = json({ path: 'new.txt', contents: 'one\ntwo\n' })
    expect(buildApprovalChangePreview('edit', args, root)).toMatchObject({ action: 'create', add: 2, del: 0 })
    expect(buildApprovalChangePreview('edit', args, undefined)).toMatchObject({ action: 'rewrite', add: 2 })
  })

  it('caps the rows it sends and counts the rest', () => {
    const contents = Array.from({ length: APPROVAL_PREVIEW_MAX_LINES + 25 }, (_, i) => `line ${i}`).join('\n')
    const preview = buildApprovalChangePreview('edit', json({ path: 'big.txt', contents }), root)
    expect(preview?.lines).toHaveLength(APPROVAL_PREVIEW_MAX_LINES)
    expect(preview?.hiddenLines).toBe(25)
    expect(preview?.add).toBe(APPROVAL_PREVIEW_MAX_LINES + 25)
  })

  it('scrubs secrets from the rows, as the raw request is', () => {
    const preview = buildApprovalChangePreview(
      'str_replace',
      json({ path: '.env', old_string: 'KEY=', new_string: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' }),
      root
    )
    expect(preview?.lines[1]?.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  })

  it('builds nothing for other tools or arguments that do not parse', () => {
    expect(buildApprovalChangePreview('terminal', json({ command: 'ls' }), root)).toBeNull()
    expect(buildApprovalChangePreview('edit', '{"path": "a.ts", "contents": "trunc', root)).toBeNull()
    expect(buildApprovalChangePreview('edit', json({ path: '../outside.txt', contents: 'x' }), root)).toMatchObject({ action: 'rewrite' })
  })
})
