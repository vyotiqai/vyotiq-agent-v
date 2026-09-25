/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createChatStreamController,
  type RunExpansions
} from '@renderer/lib/hooks/createChatStreamController'
import { RUN_DISMISSED_ERRORS_MAX, type ChatMessage, type PersistedEvent } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'

const RUN = 'r1'

function row(at: string, event: Record<string, unknown>): PersistedEvent {
  return { at, event: { runId: RUN, ...event } }
}

/** Transcript order as kinds, with prompts and boxes named so placement reads plainly. */
function shape(items: readonly UiItem[]): string[] {
  return items.map((item) => {
    if (item.kind === 'message') return `${item.role}:${item.content}`
    if (item.kind === 'run_error') return `error:${item.message}`
    return item.kind
  })
}

function hydrated(messages: ChatMessage[], events: PersistedEvent[]) {
  const controller = createChatStreamController({ workspacePath: '/ws', runId: RUN })
  controller.hydrateTranscript(messages, events)
  return controller
}

describe('run_error boxes rebuilt from disk', () => {
  it('keeps a failed turn’s box in that turn when a new prompt followed', () => {
    const controller = hydrated(
      [
        { role: 'user', content: 'first', at: '2026-09-23T10:00:00.000Z' },
        { role: 'user', content: 'second', at: '2026-09-23T10:05:00.000Z' },
        { role: 'assistant', content: 'answer' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:01.000Z', {
          type: 'error',
          message: 'Model not available',
          code: 'PROVIDER_REQUEST',
          invokeId: 1
        }),
        row('2026-09-23T10:00:01.000Z', { type: 'status', status: 'error', invokeId: 1 }),
        row('2026-09-23T10:05:00.100Z', { type: 'status', status: 'running', invokeId: 2 }),
        row('2026-09-23T10:05:09.000Z', { type: 'assistant_message', content: 'answer', invokeId: 2 }),
        row('2026-09-23T10:05:10.000Z', { type: 'status', status: 'done', invokeId: 2 })
      ]
    )

    // Not appended under the newest answer, which is where every reload used to put it.
    expect(shape(controller.items)).toEqual([
      'user:first',
      'error:Model not available',
      'user:second',
      'assistant:answer'
    ])
    expect(controller.error).toBeNull()
  })

  it('drops a box once its turn was run again without a new prompt', () => {
    // A resume or goal relaunch: the second invoke re-runs the same turn.
    const controller = hydrated(
      [
        { role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' },
        { role: 'assistant', content: 'built' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:30.000Z', {
          type: 'error',
          message: 'Connection lost',
          code: 'PROVIDER_NETWORK',
          invokeId: 1
        }),
        row('2026-09-23T10:00:30.000Z', { type: 'status', status: 'error', invokeId: 1 }),
        row('2026-09-23T10:01:00.000Z', { type: 'status', status: 'running', invokeId: 2 }),
        row('2026-09-23T10:01:20.000Z', { type: 'assistant_message', content: 'built', invokeId: 2 }),
        row('2026-09-23T10:01:21.000Z', { type: 'status', status: 'done', invokeId: 2 })
      ]
    )

    expect(shape(controller.items)).toEqual(['user:build it', 'assistant:built'])
  })

  it('drops the failure an edited-and-resent prompt left on disk', () => {
    // Shape of a real session: the rewind kept the failed attempt's rows,
    // re-stamped with the rewind time, ahead of the resent prompt's own invoke.
    const controller = hydrated(
      [
        { role: 'user', content: 'remove teammates', at: '2026-09-23T06:02:22.778Z' },
        { role: 'assistant', content: 'working on it' }
      ],
      [
        row('2026-09-23T06:02:23.004Z', { type: 'status', status: 'running', invokeId: 2 }),
        row('2026-09-23T06:02:23.004Z', {
          type: 'error',
          message: 'Upstream request failed: This Go model requires Global regions.',
          code: 'PROVIDER_REQUEST',
          invokeId: 2
        }),
        row('2026-09-23T06:02:23.004Z', { type: 'status', status: 'error', invokeId: 2 }),
        row('2026-09-23T06:02:23.054Z', { type: 'status', status: 'running', invokeId: 3 }),
        row('2026-09-23T06:03:00.000Z', {
          type: 'assistant_message',
          content: 'working on it',
          invokeId: 3
        })
      ]
    )

    expect(controller.items.some((item) => item.kind === 'run_error')).toBe(false)
    expect(controller.error).toBeNull()
  })

  it('ends the transcript with the box when the latest turn failed', () => {
    const controller = hydrated(
      [
        { role: 'user', content: 'first', at: '2026-09-23T10:00:00.000Z' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'second', at: '2026-09-23T10:05:00.000Z' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:05.000Z', { type: 'assistant_message', content: 'one', invokeId: 1 }),
        row('2026-09-23T10:00:05.100Z', { type: 'status', status: 'done', invokeId: 1 }),
        row('2026-09-23T10:05:00.100Z', { type: 'status', status: 'running', invokeId: 2 }),
        row('2026-09-23T10:05:02.000Z', {
          type: 'error',
          message: 'Connection lost',
          code: 'PROVIDER_NETWORK',
          invokeId: 2
        }),
        row('2026-09-23T10:05:02.000Z', { type: 'status', status: 'error', invokeId: 2 })
      ]
    )

    expect(shape(controller.items)).toEqual([
      'user:first',
      'assistant:one',
      'user:second',
      'error:Connection lost'
    ])
    expect(controller.error).toBe('Connection lost')
  })

  it('keeps one box per turn when a retry failed before reporting running', () => {
    // Some stops (a missing instance worktree) fail before `status: running`.
    const controller = hydrated(
      [{ role: 'user', content: 'fix it', at: '2026-09-23T10:00:00.000Z' }],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:05.000Z', { type: 'error', message: 'First failure', invokeId: 1 }),
        row('2026-09-23T10:00:05.000Z', { type: 'status', status: 'error', invokeId: 1 }),
        row('2026-09-23T10:01:00.000Z', { type: 'error', message: 'Second failure', invokeId: 2 }),
        row('2026-09-23T10:01:00.000Z', { type: 'status', status: 'error', invokeId: 2 })
      ]
    )

    expect(shape(controller.items)).toEqual(['user:fix it', 'error:Second failure'])
  })

  it('does not box a warning logged after the invoke already ended', () => {
    const controller = hydrated(
      [
        { role: 'user', content: 'first', at: '2026-09-23T10:00:00.000Z' },
        { role: 'assistant', content: 'one' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:05.000Z', { type: 'assistant_message', content: 'one', invokeId: 1 }),
        row('2026-09-23T10:00:05.100Z', { type: 'status', status: 'done', invokeId: 1 }),
        row('2026-09-23T10:00:05.200Z', {
          type: 'error',
          message: 'Persistence flush failed after run ended: EBUSY',
          code: 'PERSISTENCE',
          invokeId: 1
        })
      ]
    )

    expect(controller.items.some((item) => item.kind === 'run_error')).toBe(false)
  })

  it('skips a failure from a turn outside the loaded window', () => {
    const controller = hydrated(
      [
        // Earlier messages are still on disk (windowed hydration).
        { role: 'user', content: 'later', at: '2026-09-23T11:00:00.000Z' },
        { role: 'assistant', content: 'fine' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:01.000Z', { type: 'error', message: 'Old failure', invokeId: 1 }),
        row('2026-09-23T10:00:01.000Z', { type: 'status', status: 'error', invokeId: 1 }),
        row('2026-09-23T11:00:00.100Z', { type: 'status', status: 'running', invokeId: 2 }),
        row('2026-09-23T11:00:04.000Z', { type: 'status', status: 'done', invokeId: 2 })
      ]
    )

    expect(shape(controller.items)).toEqual(['user:later', 'assistant:fine'])
  })
})

describe('run_error boxes while live', () => {
  const failedLatestTurn = (): ReturnType<typeof hydrated> =>
    hydrated(
      [{ role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:30.000Z', {
          type: 'error',
          message: 'Connection lost',
          code: 'PROVIDER_NETWORK',
          invokeId: 1
        }),
        row('2026-09-23T10:00:30.000Z', { type: 'status', status: 'error', invokeId: 1 })
      ]
    )

  it('clears the latest turn’s box when a new invoke re-runs that turn', () => {
    const controller = failedLatestTurn()
    expect(shape(controller.items)).toEqual(['user:build it', 'error:Connection lost'])

    controller.handleEvent({ type: 'status', runId: RUN, status: 'running', invokeId: 2 })

    expect(shape(controller.items)).toEqual(['user:build it'])
  })

  it('replaces the latest turn’s box when another attempt at it fails', () => {
    const controller = failedLatestTurn()

    controller.handleEvent({ type: 'status', runId: RUN, status: 'error', invokeId: 2 })

    const boxes = controller.items.filter((item) => item.kind === 'run_error')
    expect(boxes).toHaveLength(1)
  })

  it('keeps an earlier turn’s box when the invoke answers a newer prompt', () => {
    const controller = hydrated(
      [
        { role: 'user', content: 'first', at: '2026-09-23T10:00:00.000Z' },
        { role: 'user', content: 'second', at: '2026-09-23T10:05:00.000Z' }
      ],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T10:00:01.000Z', { type: 'error', message: 'Model not available', invokeId: 1 }),
        row('2026-09-23T10:00:01.000Z', { type: 'status', status: 'error', invokeId: 1 })
      ]
    )
    expect(shape(controller.items)).toEqual([
      'user:first',
      'error:Model not available',
      'user:second'
    ])

    controller.handleEvent({ type: 'status', runId: RUN, status: 'running', invokeId: 2 })

    expect(shape(controller.items)).toEqual([
      'user:first',
      'error:Model not available',
      'user:second'
    ])
  })
})

describe('dismissing a run_error box', () => {
  /** A run whose latest turn failed with the given errorId. */
  const failedRun: [ChatMessage[], PersistedEvent[]] = [
    [{ role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }],
    [
      row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
      row('2026-09-23T10:00:30.000Z', {
        type: 'error',
        message: 'Connection lost',
        code: 'PROVIDER_NETWORK',
        errorId: 'e-1',
        invokeId: 1
      }),
      row('2026-09-23T10:00:30.000Z', { type: 'status', status: 'error', invokeId: 1 })
    ]
  ]

  function withReaderState(
    initialExpansions?: Partial<RunExpansions>
  ): { controller: ReturnType<typeof createChatStreamController>; saved: RunExpansions[] } {
    const saved: RunExpansions[] = []
    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: RUN,
      ...(initialExpansions ? { initialExpansions } : {}),
      onExpansionsChange: (next) => saved.push(next)
    })
    return { controller, saved }
  }

  it('removes the box, quiets the banner it stood for, and saves the dismissal', () => {
    const { controller, saved } = withReaderState()
    controller.hydrateTranscript(...failedRun)
    expect(controller.items.find((item) => item.kind === 'run_error')?.id).toBe('run-error:e-1')
    expect(controller.error).toBe('Connection lost')

    controller.dismissRunError('run-error:e-1')

    expect(shape(controller.items)).toEqual(['user:build it'])
    // Otherwise the banner would take over the message the box just dropped.
    expect(controller.error).toBeNull()
    expect(saved.at(-1)?.dismissedErrorIds).toEqual(['run-error:e-1'])
  })

  it('stays dismissed when the run is rebuilt from disk, banner included', () => {
    const { controller } = withReaderState({ dismissedErrorIds: ['run-error:e-1'] })
    controller.hydrateTranscript(...failedRun)

    expect(shape(controller.items)).toEqual(['user:build it'])
    expect(controller.error).toBeNull()
  })

  it('leaves the current error alone when an earlier turn’s box is dismissed', () => {
    const { controller } = withReaderState()
    controller.hydrateTranscript(
      [
        { role: 'user', content: 'first', at: '2026-09-23T09:00:00.000Z' },
        { role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }
      ],
      [
        row('2026-09-23T09:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
        row('2026-09-23T09:00:01.000Z', { type: 'error', message: 'Old failure', errorId: 'e-0' }),
        row('2026-09-23T09:00:01.000Z', { type: 'status', status: 'error', invokeId: 1 }),
        ...failedRun[1]
      ]
    )
    expect(shape(controller.items)).toEqual([
      'user:first',
      'error:Old failure',
      'user:build it',
      'error:Connection lost'
    ])

    controller.dismissRunError('run-error:e-0')

    expect(shape(controller.items)).toEqual(['user:first', 'user:build it', 'error:Connection lost'])
    expect(controller.error).toBe('Connection lost')
  })

  it('keeps an earlier turn’s identical failure when the latest one is dismissed', () => {
    const { controller } = withReaderState()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first', at: '2026-09-23T09:00:00.000Z' },
      { role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }
    ]
    const events = [
      row('2026-09-23T09:00:00.100Z', { type: 'status', status: 'running', invokeId: 1 }),
      row('2026-09-23T09:00:01.000Z', { type: 'error', message: 'Connection lost', errorId: 'e-0' }),
      row('2026-09-23T09:00:01.000Z', { type: 'status', status: 'error', invokeId: 1 }),
      ...failedRun[1]
    ]
    controller.hydrateTranscript(messages, events)

    controller.dismissRunError('run-error:e-1')
    // A rebuild (tab switch, catch-up) must match the dismissal by id, not text.
    controller.hydrateTranscript(messages, events)

    expect(shape(controller.items)).toEqual(['user:first', 'error:Connection lost', 'user:build it'])
    expect(controller.error).toBeNull()
  })

  it('gives a live failure the id its rebuilt box will have', () => {
    const { controller } = withReaderState()
    controller.hydrateTranscript([
      { role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }
    ])
    controller.handleEvent({ type: 'status', runId: RUN, status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'error',
      runId: RUN,
      message: 'Connection lost',
      code: 'PROVIDER_NETWORK',
      errorId: 'e-1',
      invokeId: 1
    })
    controller.handleEvent({ type: 'status', runId: RUN, status: 'error', invokeId: 1 })

    expect(controller.items.find((item) => item.kind === 'run_error')?.id).toBe('run-error:e-1')
  })

  it('keys a row written before errors carried an id by the row’s time', () => {
    const controller = hydrated(
      [{ role: 'user', content: 'build it', at: '2026-09-23T10:00:00.000Z' }],
      [
        row('2026-09-23T10:00:00.100Z', { type: 'status', status: 'running' }),
        row('2026-09-23T10:00:30.000Z', { type: 'error', message: 'Connection lost' }),
        row('2026-09-23T10:00:30.000Z', { type: 'status', status: 'error' })
      ]
    )

    expect(controller.items.find((item) => item.kind === 'run_error')?.id).toBe(
      'run-error:2026-09-23T10:00:30.000Z'
    )
  })

  it('remembers a bounded number of dismissals, dropping the oldest', () => {
    const older = Array.from({ length: RUN_DISMISSED_ERRORS_MAX }, (_, i) => `run-error:old-${i}`)
    const { controller, saved } = withReaderState({ dismissedErrorIds: older })
    controller.hydrateTranscript(...failedRun)

    controller.dismissRunError('run-error:e-1')

    const remembered = saved.at(-1)?.dismissedErrorIds ?? []
    expect(remembered).toHaveLength(RUN_DISMISSED_ERRORS_MAX)
    expect(remembered[0]).toBe('run-error:old-1')
    expect(remembered.at(-1)).toBe('run-error:e-1')
  })

  it('ignores an id that is not in the transcript', () => {
    const onExpansionsChange = vi.fn()
    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: RUN,
      onExpansionsChange
    })
    controller.hydrateTranscript(...failedRun)

    controller.dismissRunError('run-error:missing')

    expect(onExpansionsChange).not.toHaveBeenCalled()
    expect(controller.error).toBe('Connection lost')
  })
})
