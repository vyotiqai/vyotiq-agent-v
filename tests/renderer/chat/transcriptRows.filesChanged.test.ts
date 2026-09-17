import { describe, expect, it } from 'vitest'
import {
  buildTranscriptRows,
  isTurnWorkRow,
  rowLeadingGap,
  stabilizeTranscriptRows,
  transcriptRowFingerprint,
  turnHasVisibleToolWork,
  TURN_GAP_PX,
  type TranscriptRow
} from '@renderer/features/chat/utils/transcriptRows'
import type { UiItem } from '@shared/transcript'

function tool(id: string, name = 'read', expanded = false): UiItem {
  return {
    kind: 'tool',
    id,
    toolExpanded: expanded,
    tool: { id, name, summary: id, status: 'done' }
  }
}

describe('buildTranscriptRows', () => {
  it('rolls up a turn that edited several files', async () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'z\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit both' },
      first,
      second
    ]).find((row) => row.kind === 'changes')

    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([
        { path: 'src/a.ts', added: 2, removed: 0 },
        { path: 'src/b.ts', added: 1, removed: 0 }
      ])
    }
  })

  it('merges same file when change paths use mixed separators', () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src\\a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\nz\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      first,
      second
    ]).find((row) => row.kind === 'changes')

    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toHaveLength(1)
      expect(changes.files[0]?.path).toBe('src/a.ts')
    }
  })

  it('adds a Files Changed summary for a single edit (transcript receipt)', () => {
    const only = tool('e1', 'edit')
    only.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit it' },
      only
    ])
    const changes = rows.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('sorts Files Changed paths alphabetically to match the Changes panel', () => {
    const zebra = tool('e1', 'edit')
    zebra.tool.argsPreview = JSON.stringify({ path: 'zebra.ts', contents: 'z\n' })
    const alpha = tool('e2', 'edit')
    alpha.tool.argsPreview = JSON.stringify({ path: 'alpha.ts', contents: 'a\n' })
    const mid = tool('e3', 'edit')
    mid.tool.argsPreview = JSON.stringify({ path: 'mid.ts', contents: 'm\n' })
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      zebra,
      alpha,
      mid
    ])
    const changes = rows.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files.map((f) => f.path)).toEqual(['alpha.ts', 'mid.ts', 'zebra.ts'])
    }
  })

  it('defers the Files Changed card on the live turn until the run settles', () => {
    const edit = tool('e1', 'edit')
    edit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const sub: UiItem = {
      kind: 'tool',
      id: 's1',
      tool: { id: 's1', name: 'search', summary: 'Investigate', status: 'running' }
    }

    const live = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'edit then investigate' },
        edit,
        sub
      ],
      { running: true }
    )
    expect(live.some((row) => row.kind === 'changes')).toBe(false)
    expect(live.some((row) => row.kind === 'activity')).toBe(true)

    const settled = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'edit then investigate' },
        edit,
        {
          kind: 'tool',
          id: 's1',
          tool: { id: 's1', name: 'search', summary: 'Investigate', status: 'done' }
        }
      ],
      { running: false }
    )
    const changes = settled.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('still shows Files Changed for a prior turn while a later turn is live', () => {
    const firstEdit = tool('e1', 'edit')
    firstEdit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const secondEdit = tool('e2', 'edit')
    secondEdit.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'y\n' })

    const rows = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'first' },
        firstEdit,
        { kind: 'message', id: 'u2', role: 'user', content: 'second' },
        secondEdit,
        {
          kind: 'tool',
          id: 'r1',
          tool: { id: 'r1', name: 'read', summary: 'x', status: 'running' }
        }
      ],
      { running: true }
    )
    const changes = rows.filter((row) => row.kind === 'changes')
    expect(changes).toHaveLength(1)
    if (changes[0]?.kind === 'changes') {
      expect(changes[0].turnIndex).toBe(0)
      expect(changes[0].files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('adds up repeated edits to the same file', () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' })
    const other = tool('e3', 'edit')
    other.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'z\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      first,
      second,
      other
    ]).find((row) => row.kind === 'changes')

    if (changes?.kind === 'changes') {
      expect(changes.files[0]).toEqual({ path: 'src/a.ts', added: 3, removed: 1 })
    }
  })

  it('reserves extra lead-in for user prompts that open a later turn', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'first' },
      { kind: 'message', id: 'u2', role: 'user', content: 'second' }
    ]
    const [first, second] = buildTranscriptRows(items)
    expect(rowLeadingGap(first!)).toBe(0)
    expect(rowLeadingGap(second!)).toBe(TURN_GAP_PX)
  })
})
