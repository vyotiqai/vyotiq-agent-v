/**
 * Opt-in IPC invoke timing for startup freeze diagnosis.
 * Enable with VYOTIQ_PERF=1. Look for `ipc:start` without a matching `ipc:end`
 * when Windows shows Not Responding — that channel is blocking main.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isPerfDebugEnabled } from '../agent/context/perfDebug'

let installed = false
let seq = 0

type HandleListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** Wrap an invoke listener with start/end console timing (testable without Electron). */
export function wrapIpcInvokeListener(
  channel: string,
  listener: HandleListener,
  log: (line: string) => void = console.info
): HandleListener {
  return async (event, ...args) => {
    const id = ++seq
    const t0 = performance.now()
    log(`[vyotiq-perf] ipc:start ${channel} #${id}`)
    try {
      return await listener(event, ...args)
    } finally {
      const ms = performance.now() - t0
      log(`[vyotiq-perf] ipc:end ${channel} #${id} ${ms.toFixed(1)}ms`)
    }
  }
}

/** Time a sync `ipcMain.on` / fire-and-forget handler body. No-op unless VYOTIQ_PERF=1. */
export function timeSyncIpc(
  channel: string,
  fn: () => void,
  log: (line: string) => void = console.info
): void {
  if (!isPerfDebugEnabled()) {
    fn()
    return
  }
  const id = ++seq
  const t0 = performance.now()
  log(`[vyotiq-perf] ipc:start ${channel} #${id}`)
  try {
    fn()
  } finally {
    const ms = performance.now() - t0
    log(`[vyotiq-perf] ipc:end ${channel} #${id} ${ms.toFixed(1)}ms`)
  }
}

/**
 * Patch `ipcMain.handle` so every invoke is timed. Call once at the start of
 * `registerIpc()` before any handlers are registered. No-op unless VYOTIQ_PERF=1.
 */
export function installIpcTiming(): void {
  if (installed || !isPerfDebugEnabled()) return
  installed = true

  const originalHandle = ipcMain.handle.bind(ipcMain) as (
    channel: string,
    listener: HandleListener
  ) => void

  ipcMain.handle = ((channel: string, listener: HandleListener) => {
    originalHandle(channel, wrapIpcInvokeListener(channel, listener))
  }) as typeof ipcMain.handle

  console.info(
    '[vyotiq-perf] ipc timing enabled — if Not Responding, last ipc:start without ipc:end is the blocker'
  )
}

/** @internal */
export function resetIpcTimingForTests(): void {
  installed = false
  seq = 0
}
