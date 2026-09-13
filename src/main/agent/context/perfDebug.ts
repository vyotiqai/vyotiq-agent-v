/**
 * Opt-in main-process timing for assemble / token estimation baselines.
 * Enable with VYOTIQ_PERF=1 (Electron: measure before optimizing).
 */

export function perfNow(): number {
  return performance.now()
}

export function perfLog(label: string, startedAt: number, extra?: Record<string, unknown>): void {
  if (!isPerfDebugEnabled()) return
  const ms = performance.now() - startedAt
  const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
  console.info(`[vyotiq-perf] ${label}: ${ms.toFixed(2)}ms${suffix}`)
}

export function isPerfDebugEnabled(): boolean {
  return process.env.VYOTIQ_PERF === '1'
}
