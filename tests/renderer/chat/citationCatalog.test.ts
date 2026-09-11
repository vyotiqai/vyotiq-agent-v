/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { collectTurnCitationCatalogs } from '@renderer/features/chat/utils/citationCatalog'
import type { ToolItem, TranscriptRow } from '@renderer/features/chat/utils/transcriptRows'

function tool(
  id: string,
  name: string,
  fields: { content?: string; argsPreview?: string; status?: 'running' | 'done' | 'fail' } = {}
): ToolItem {
  return {
    kind: 'tool',
    id,
    tool: {
      name,
      summary: name,
      status: fields.status ?? 'done',
      content: fields.content,
      argsPreview: fields.argsPreview
    }
  } as unknown as ToolItem
}

function card(turnIndex: number, item: ToolItem): TranscriptRow {
  return { kind: 'card', id: item.id, turnIndex, item } as unknown as TranscriptRow
}

function activity(turnIndex: number, tools: ToolItem[]): TranscriptRow {
  return { kind: 'activity', id: `activity-${turnIndex}`, turnIndex, tools } as unknown as TranscriptRow
}

describe('collectTurnCitationCatalogs caching', () => {
  it('reuses the catalog array when citable evidence is unchanged', () => {
    const rows = [card(1, tool('r1', 'read', { argsPreview: '{"path":"src/a.ts"}' }))]
    const first = collectTurnCitationCatalogs(rows)
    const second = collectTurnCitationCatalogs(rows, first.cache)

    expect(second.catalogs.get(1)).toBe(first.catalogs.get(1))
    expect(second.catalogs.get(1)).toEqual([{ kind: 'file', path: 'src/a.ts' }])
  })

  it('ignores content churn on non-citing tools and read content', () => {
    const read = tool('r1', 'read', { argsPreview: '{"path":"src/a.ts"}' })
    const terminal = tool('t1', 'terminal', { content: 'line 1' })
    const first = collectTurnCitationCatalogs([activity(1, [read, terminal])])

    const read2 = tool('r1', 'read', {
      argsPreview: '{"path":"src/a.ts"}',
      content: 'unrelated streamed body'
    })
    const terminal2 = tool('t1', 'terminal', { content: 'line 2 — grew while streaming' })
    const second = collectTurnCitationCatalogs([activity(1, [read2, terminal2])], first.cache)

    expect(second.catalogs.get(1)).toBe(first.catalogs.get(1))
  })

  it('rebuilds a turn when a citing tool changes', () => {
    const first = collectTurnCitationCatalogs([
      card(1, tool('r1', 'read', { argsPreview: '{"path":"src/a.ts"}' }))
    ])
    const second = collectTurnCitationCatalogs(
      [card(1, tool('r1', 'read', { argsPreview: '{"path":"src/b.ts"}' }))],
      first.cache
    )

    expect(second.catalogs.get(1)).not.toBe(first.catalogs.get(1))
    expect(second.catalogs.get(1)).toEqual([{ kind: 'file', path: 'src/b.ts' }])
  })

  it('keeps other turns stable when one turn changes', () => {
    const row1 = card(1, tool('r1', 'read', { argsPreview: '{"path":"src/a.ts"}' }))
    const row2 = card(2, tool('r2', 'read', { argsPreview: '{"path":"src/b.ts"}' }))
    const first = collectTurnCitationCatalogs([row1, row2])
    const second = collectTurnCitationCatalogs(
      [row1, card(2, tool('r2', 'read', { argsPreview: '{"path":"src/c.ts"}' }))],
      first.cache
    )

    expect(second.catalogs.get(1)).toBe(first.catalogs.get(1))
    expect(second.catalogs.get(2)).not.toBe(first.catalogs.get(2))
  })
})
