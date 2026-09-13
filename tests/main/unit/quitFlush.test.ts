import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushBeforeQuit,
  QUIT_FLUSH_HARD_MS,
  QUIT_FLUSH_SOFT_MS,
  type QuitFlushDeps
} from '@main/quitFlush'

function createDeps(overrides: Partial<QuitFlushDeps> = {}): QuitFlushDeps {
  return {
    flushMessageAppends: vi.fn(async () => {}),
    flushEventAppends: vi.fn(async () => {}),
    flushStatusWrites: vi.fn(async () => {}),
    showQuitAnywayDialog: vi.fn(async () => 'wait' as const),
    logger: { warn: vi.fn() },
    ...overrides
  }
}

describe('flushBeforeQuit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('awaits flush completion without dialog when flushes finish quickly', async () => {
    const deps = createDeps()
    const promise = flushBeforeQuit(deps)
    await vi.runAllTimersAsync()
    await promise
    expect(deps.showQuitAnywayDialog).not.toHaveBeenCalled()
    expect(deps.logger.warn).not.toHaveBeenCalled()
    expect(await promise).toEqual({ flushTimedOut: false })
  })

  it('includes editor state in the coordinated quit flush', async () => {
    const flushEditorState = vi.fn(async () => {})
    const deps = createDeps({ flushEditorState })
    const promise = flushBeforeQuit(deps)
    await vi.runAllTimersAsync()
    await promise
    expect(flushEditorState).toHaveBeenCalledTimes(1)
  })

  it('preserves an explicit renderer editor-flush failure', async () => {
    const deps = createDeps({
      flushEditorState: vi.fn(async () => 'failed' as const)
    })
    const resultPromise = flushBeforeQuit(deps)
    await vi.runAllTimersAsync()
    await expect(resultPromise).resolves.toEqual({
      flushTimedOut: false,
      flushFailed: true
    })
  })

  it('shows dialog after soft timeout and quits immediately when user chooses quit', async () => {
    let resolveFlush!: () => void
    const flushPromise = new Promise<void>((resolve) => {
      resolveFlush = resolve
    })
    const deps = createDeps({
      flushMessageAppends: vi.fn(() => flushPromise),
      showQuitAnywayDialog: vi.fn(async () => 'quit' as const)
    })

    const resultPromise = flushBeforeQuit(deps)
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_SOFT_MS)
    await resultPromise

    expect(deps.showQuitAnywayDialog).toHaveBeenCalledTimes(1)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Quit before flush completed; data may be lost',
      { scope: 'main' }
    )
    expect(await resultPromise).toEqual({ flushTimedOut: true })
    resolveFlush()
  })

  it('keeps waiting after user chooses wait until flush completes', async () => {
    let resolveFlush!: () => void
    const flushPromise = new Promise<void>((resolve) => {
      resolveFlush = resolve
    })
    const deps = createDeps({
      flushMessageAppends: vi.fn(() => flushPromise),
      showQuitAnywayDialog: vi.fn(async () => 'wait' as const)
    })

    const resultPromise = flushBeforeQuit(deps)
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_SOFT_MS)
    expect(deps.showQuitAnywayDialog).toHaveBeenCalledTimes(1)

    resolveFlush()
    await vi.runAllTimersAsync()
    await resultPromise

    expect(deps.logger.warn).not.toHaveBeenCalled()
    expect(await resultPromise).toEqual({ flushTimedOut: false })
  })

  it('times out after hard wait when flush never completes', async () => {
    const deps = createDeps({
      flushMessageAppends: vi.fn(() => new Promise<void>(() => {})),
      showQuitAnywayDialog: vi.fn(async () => 'wait' as const)
    })

    const resultPromise = flushBeforeQuit(deps)
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_SOFT_MS + QUIT_FLUSH_HARD_MS)
    await resultPromise

    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Timed out flushing pending run writes before quit; data may be lost',
      { scope: 'main', timeoutMs: QUIT_FLUSH_HARD_MS }
    )
    expect(await resultPromise).toEqual({ flushTimedOut: true })
  })

  it('treats flush rejection as a failed flush and shows the wait/quit dialog', async () => {
    const deps = createDeps({
      flushMessageAppends: vi.fn(async () => {
        throw new Error('disk full')
      }),
      showQuitAnywayDialog: vi.fn(async () => 'quit' as const)
    })

    const resultPromise = flushBeforeQuit(deps)
    await vi.runAllTimersAsync()
    await expect(resultPromise).resolves.toEqual({ flushTimedOut: true })
    expect(deps.showQuitAnywayDialog).toHaveBeenCalledTimes(1)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Quit flush rejected; treating as failed flush',
      expect.objectContaining({ scope: 'main' })
    )
  })

  it('retries the flush when the user waits after a rejection', async () => {
    let attempts = 0
    const deps = createDeps({
      flushMessageAppends: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('disk full')
      }),
      showQuitAnywayDialog: vi.fn(async () => 'wait' as const)
    })

    const resultPromise = flushBeforeQuit(deps)
    await vi.runAllTimersAsync()
    await expect(resultPromise).resolves.toEqual({ flushTimedOut: false })
    expect(deps.showQuitAnywayDialog).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
  })
})
