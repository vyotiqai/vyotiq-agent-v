/**
 * Renderer counters for suspended-stream UI work (load verification).
 * Dump with: sessionStorage.setItem('vyotiq-perf','1') then watch DevTools console.
 */

type ChatUiPerfStats = {
  suspendSkips: number
  resumesWithCatchUp: number
  resumesNoop: number
}

let stats: ChatUiPerfStats = {
  suspendSkips: 0,
  resumesWithCatchUp: 0,
  resumesNoop: 0
}

let dumpTimer: ReturnType<typeof setInterval> | null = null

export function recordUiSuspendSkip(): void {
  stats.suspendSkips += 1
}

export function recordUiResume(didCatchUp: boolean): void {
  if (didCatchUp) stats.resumesWithCatchUp += 1
  else stats.resumesNoop += 1
}

export function getChatUiPerfStats(): ChatUiPerfStats {
  return { ...stats }
}

export function resetChatUiPerfStats(): void {
  stats = { suspendSkips: 0, resumesWithCatchUp: 0, resumesNoop: 0 }
}

function perfDumpEnabled(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('vyotiq-perf') === '1'
  } catch {
    return false
  }
}

/** Start optional 5s console dumps when sessionStorage vyotiq-perf=1. */
export function ensureChatUiPerfDump(): void {
  if (dumpTimer) return
  if (!perfDumpEnabled()) return
  dumpTimer = setInterval(() => {
    if (!perfDumpEnabled()) {
      stopChatUiPerfDumpForTests()
      return
    }
    console.info('[vyotiq-perf] chatUi', JSON.stringify(getChatUiPerfStats()))
  }, 5_000)
}

/** @internal */
export function stopChatUiPerfDumpForTests(): void {
  if (dumpTimer) {
    clearInterval(dumpTimer)
    dumpTimer = null
  }
}
