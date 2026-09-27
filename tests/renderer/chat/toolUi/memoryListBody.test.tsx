/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryListBody } from '@renderer/features/chat/toolUi/bodies/MemoryBodies'
import type { UiToolRow } from '@shared/transcript'

function tool(content: string): UiToolRow {
  return { id: 't1', name: 'memory_list', summary: '', status: 'done', content }
}

const bodyProps = { expanded: true, loading: false, loadFailed: false }

/** The exact text toolMemoryList emits — see memoryListParser.test.ts. */
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

describe('MemoryListBody', () => {
  it('lists only note filenames — no index section, no stray non-note lines', () => {
    const { container } = render(<MemoryListBody {...bodyProps} tool={tool(TWO_NOTES_OUTPUT)} />)

    const items = [...container.querySelectorAll('li')].map((li) => li.textContent)
    expect(items).toEqual(['arch.md', 'prefs.md'])
    // The retired excerpt section is gone rather than rendered as "(empty)".
    expect(container.textContent).not.toContain('(empty)')
    expect(container.textContent).not.toContain('pre-injected into the system prompt')
  })

  it('reports index coverage and state.md on one meta line', () => {
    render(<MemoryListBody {...bodyProps} tool={tool(TWO_NOTES_OUTPUT)} />)

    expect(screen.getByText('index.md 2/2 notes · state.md: present')).toBeTruthy()
  })

  it('surfaces index drift instead of hiding it', () => {
    render(
      <MemoryListBody
        {...bodyProps}
        tool={tool(
          [
            '## notes/',
            '- arch.md',
            '- stash.md',
            '',
            'index.md coverage: 1/2 notes (not in index.md: stash.md)',
            'state.md: absent',
            '',
            'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
          ].join('\n')
        )}
      />
    )

    expect(
      screen.getByText('index.md 1/2 notes · not in index.md: stash.md · state.md: absent')
    ).toBeTruthy()
  })

  it('shows (none) for an empty workspace and no coverage line is invented', () => {
    render(<MemoryListBody {...bodyProps} tool={tool('')} />)

    expect(screen.getByText('(none)')).toBeTruthy()
    expect(screen.getByText('state.md: absent')).toBeTruthy()
  })
})
