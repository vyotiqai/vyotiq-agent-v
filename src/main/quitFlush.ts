/** Soft wait before offering to quit without finishing disk flushes. */
export const QUIT_FLUSH_SOFT_MS = 5000
/** Hard cap after the user chooses to keep waiting. */
export const QUIT_FLUSH_HARD_MS = 60_000

export type QuitFlushChoice = 'wait' | 'quit'
export type EditorFlushStatus = 'acknowledged' | 'failed' | 'timeout'

export type QuitFlushDeps = {
  flushMessageAppends: () => Promise<void>
  flushEventAppends: () => Promise<void>
  flushStatusWrites: () => Promise<void>
  flushEditorState?: () => Promise<void | EditorFlushStatus>
  showQuitAnywayDialog: () => Promise<QuitFlushChoice>
  logger: { warn: (message: string, meta: Record<string, unknown>) => void }
}

export type QuitFlushResult = {
  flushTimedOut: boolean
  flushFailed?: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FlushSettle =
  | { kind: 'ok'; status: EditorFlushStatus }
  | { kind: 'rejected' }

function beginFlush(deps: QuitFlushDeps): Promise<FlushSettle> {
  const editorFlush = deps.flushEditorState
    ? deps.flushEditorState().then((status) => status ?? ('acknowledged' as const))
    : Promise.resolve<EditorFlushStatus>('acknowledged')
  return Promise.all([
    deps.flushMessageAppends(),
    deps.flushEventAppends(),
    deps.flushStatusWrites(),
    editorFlush
  ]).then(
    ([, , , status]): FlushSettle => ({ kind: 'ok', status }),
    (err): FlushSettle => {
      deps.logger.warn('Quit flush rejected; treating as failed flush', { scope: 'main', err })
      return { kind: 'rejected' }
    }
  )
}

function resultFromSettle(settle: FlushSettle, deps: QuitFlushDeps): QuitFlushResult {
  switch (settle.kind) {
    case 'rejected':
      return { flushTimedOut: false, flushFailed: true }
    case 'ok':
      if (settle.status === 'failed') {
        deps.logger.warn('Renderer editor flush reported failure before quit', { scope: 'main' })
        return { flushTimedOut: false, flushFailed: true }
      }
      return { flushTimedOut: settle.status === 'timeout' }
    default: {
      const _exhaustive: never = settle
      return _exhaustive
    }
  }
}

/**
 * Await pending run write queues before quit. Shows one dialog if the soft
 * timeout elapses; only proceeds without a completed flush when the user
 * chooses Quit anyway or the hard wait cap is reached.
 *
 * Promise.all rejection is a failed flush (same Wait / Quit dialog as timeout),
 * not an unhandled throw that skips the dialog.
 */
export async function flushBeforeQuit(deps: QuitFlushDeps): Promise<QuitFlushResult> {
  let lastSettle: FlushSettle | undefined
  let flushPromise = beginFlush(deps).then((settle) => {
    lastSettle = settle
    return settle
  })

  const softResult = await Promise.race([
    flushPromise.then((settle) =>
      settle.kind === 'ok' && settle.status !== 'timeout' ? ('done' as const) : ('soft' as const)
    ),
    delay(QUIT_FLUSH_SOFT_MS).then(() => 'soft' as const)
  ])

  if (softResult === 'done') {
    return resultFromSettle(await flushPromise, deps)
  }

  const choice = await deps.showQuitAnywayDialog()
  if (choice === 'quit') {
    deps.logger.warn('Quit before flush completed; data may be lost', { scope: 'main' })
    return { flushTimedOut: true }
  }

  if (lastSettle?.kind === 'rejected') {
    lastSettle = undefined
    flushPromise = beginFlush(deps).then((settle) => {
      lastSettle = settle
      return settle
    })
  }

  const hardResult = await Promise.race([
    flushPromise.then((settle) =>
      settle.kind === 'ok' && settle.status !== 'timeout' ? ('done' as const) : ('failed' as const)
    ),
    delay(QUIT_FLUSH_HARD_MS).then(() => 'hard' as const)
  ])

  if (hardResult === 'hard') {
    deps.logger.warn('Timed out flushing pending run writes before quit; data may be lost', {
      scope: 'main',
      timeoutMs: QUIT_FLUSH_HARD_MS
    })
    return { flushTimedOut: true }
  }

  return resultFromSettle(await flushPromise, deps)
}
