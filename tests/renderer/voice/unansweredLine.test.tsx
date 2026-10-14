/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ConversationItems, buildEntries } from '@renderer/features/voice/view/parts'
import { markUnanswered, type VoiceLine } from '@renderer/features/voice/voiceSessionController'

afterEach(cleanup)

describe('words the voice left unanswered', () => {
  it('show muted and say so; answered ones do not', () => {
    let lines: readonly VoiceLine[] = [{ id: 't1', who: 'you', text: 'Run the tests.' }]
    lines = markUnanswered(lines, 'u1', 'Um.')
    const { container } = render(
      <ul>
        <ConversationItems entries={buildEntries(lines, {})} partial="" now={0} />
      </ul>
    )
    const marked = container.querySelectorAll('[data-voice-unanswered]')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Um.')
    expect(marked[0]!.textContent).toContain('Not answered')
    expect(marked[0]!.querySelector('.text-muted')).not.toBeNull()
    const answered = [...container.querySelectorAll('[data-voice-line="you"]')].find((li) => !li.hasAttribute('data-voice-unanswered'))
    expect(answered?.textContent).toBe('YouRun the tests.')
  })
})
