import { describe, expect, it } from 'vitest'
import { parseMemoryListData } from '@renderer/features/chat/toolUi/parsers/memory'
import type { UiToolRow } from '@shared/transcript'

function tool(content: string): UiToolRow {
  return { id: 't1', name: 'memory_list', summary: '', status: 'done', content }
}

/**
 * The exact strings `toolMemoryList` (src/main/agent/tools/memory.ts) builds,
 * one per case it can emit. Any change to the producer has to land here too.
 */
const EMPTY_OUTPUT = [
  '## notes/',
  '(none)',
  '',
  'index.md coverage: 0/0 notes — full',
  'state.md: absent',
  '',
  'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
].join('\n')

const TWO_NOTES_OUTPUT = [
  '## notes/',
  '- arch.md',
  '- prefs.md',
  '',
  'index.md coverage: 2/2 notes — full',
  'state.md: present',
  '',
  'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
].join('\n')

const DRIFT_OUTPUT = [
  '## notes/',
  '- arch.md',
  '- prefs.md',
  '- stash.md',
  '',
  'index.md coverage: 2/3 notes (not in index.md: stash.md)',
  'state.md: absent',
  '',
  'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
].join('\n')

const BROKEN_POINTER_OUTPUT = [
  '## notes/',
  '- arch.md',
  '',
  'index.md coverage: 2/1 notes (indexed but missing on disk: ghost.md)',
  'state.md: present',
  '',
  'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
].join('\n')

describe('memory_list parser (real producer output)', () => {
  it('parses an empty workspace: no notes, full coverage, state absent', () => {
    const data = parseMemoryListData(tool(EMPTY_OUTPUT))

    expect(data.notes).toEqual([])
    expect(data.coverage).toEqual({ indexed: 0, total: 0, drift: '' })
    expect(data.hasState).toBe(false)
  })

  it('parses notes as filenames only — no coverage, state or trailer lines', () => {
    const data = parseMemoryListData(tool(TWO_NOTES_OUTPUT))

    expect(data.notes).toEqual(['arch.md', 'prefs.md'])
    expect(data.coverage).toEqual({ indexed: 2, total: 2, drift: '' })
    expect(data.hasState).toBe(true)
  })

  it('keeps every note when the index is missing one, and parses the drift line', () => {
    const data = parseMemoryListData(tool(DRIFT_OUTPUT))

    expect(data.notes).toEqual(['arch.md', 'prefs.md', 'stash.md'])
    expect(data.coverage).toEqual({
      indexed: 2,
      total: 3,
      drift: 'not in index.md: stash.md'
    })
    expect(data.hasState).toBe(false)
  })

  it('parses a broken index pointer without inventing a note for it', () => {
    const data = parseMemoryListData(tool(BROKEN_POINTER_OUTPUT))

    expect(data.notes).toEqual(['arch.md'])
    expect(data.coverage).toEqual({
      indexed: 2,
      total: 1,
      drift: 'indexed but missing on disk: ghost.md'
    })
    expect(data.hasState).toBe(true)
  })

  it('parses both drift kinds on one line', () => {
    const data = parseMemoryListData(
      tool(
        [
          '## notes/',
          '- arch.md',
          '',
          'index.md coverage: 1/1 notes (not in index.md: stash.md; indexed but missing on disk: ghost.md)',
          'state.md: absent',
          '',
          'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
        ].join('\n')
      )
    )

    expect(data.notes).toEqual(['arch.md'])
    expect(data.coverage).toEqual({
      indexed: 1,
      total: 1,
      drift: 'not in index.md: stash.md; indexed but missing on disk: ghost.md'
    })
  })

  it('reports no coverage for content that carries no coverage line', () => {
    const data = parseMemoryListData(tool('## notes/\n- arch.md\n\nstate.md: present'))

    expect(data.notes).toEqual(['arch.md'])
    expect(data.coverage).toBeNull()
    expect(data.hasState).toBe(true)
  })

  it('ignores the retired index excerpt but still lists notes from an old transcript', () => {
    // Transcripts recorded before the producer dropped the excerpt replay
    // through this parser: the excerpt is not rendered, the notes still are.
    const data = parseMemoryListData(
      tool(
        [
          '## index.md (excerpt)',
          'Saved context',
          '',
          '## notes/',
          '- Keep the release note',
          '',
          'state.md: present'
        ].join('\n')
      )
    )

    expect(data.notes).toEqual(['Keep the release note'])
    expect(data.coverage).toBeNull()
    expect(data.hasState).toBe(true)
  })

  it('survives blank and missing content', () => {
    expect(parseMemoryListData(tool(''))).toEqual({ notes: [], coverage: null, hasState: false })
    expect(parseMemoryListData({ id: 't2', name: 'memory_list', summary: '', status: 'running' })).toEqual({
      notes: [],
      coverage: null,
      hasState: false
    })
  })
})
