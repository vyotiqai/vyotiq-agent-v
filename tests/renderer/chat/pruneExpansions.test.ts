/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { pruneExpansionsByRunId } from '@renderer/lib/hooks/useWorkspaceManager'
import { EMPTY_RUN_EXPANSIONS } from '@renderer/lib/hooks/createChatStreamController'

describe('pruneExpansionsByRunId', () => {
  it('keeps an open run whole and only the dismissed error boxes of a closed one', () => {
    const open = { ...EMPTY_RUN_EXPANSIONS, toolIds: ['t1'], dismissedErrorIds: ['run-error:a'] }
    const closed = {
      ...EMPTY_RUN_EXPANSIONS,
      toolIds: ['t2'],
      collapsedTurns: [0],
      dismissedErrorIds: ['run-error:b']
    }
    const closedWithoutDismissals = { ...EMPTY_RUN_EXPANSIONS, toolIds: ['t3'] }

    const pruned = pruneExpansionsByRunId(
      { open, closed, closedWithoutDismissals },
      { openRunIds: ['open'], activeRunId: null }
    )

    // A dismissed box has to stay gone when its chat is reopened later.
    expect(pruned).toEqual({
      open,
      closed: { ...EMPTY_RUN_EXPANSIONS, dismissedErrorIds: ['run-error:b'] }
    })
  })

  it('bounds how many closed runs keep their dismissals, oldest first out', () => {
    const expansions = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [
        `run-${i}`,
        { ...EMPTY_RUN_EXPANSIONS, dismissedErrorIds: [`run-error:${i}`] }
      ])
    )

    const pruned = pruneExpansionsByRunId(expansions, { openRunIds: [], activeRunId: null })

    const kept = Object.keys(pruned)
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('run-5')
    expect(kept.at(-1)).toBe('run-204')
  })
})
