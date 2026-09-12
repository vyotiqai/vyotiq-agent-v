/**
 * Chromium per-process RSS/CPU rollup (app.getAppMetrics).
 * Pure summarizers stay Electron-free so unit tests can feed fixtures.
 */

export const PROCESS_METRICS_RSS_WARN_MB = 1024
export const PROCESS_METRICS_CPU_WARN = 15
export const PROCESS_METRICS_LOG_INTERVAL_MS = 30_000

export type ProcessMetricInput = {
  type: string
  cpuPercent: number
  /** Working set in KiB (Electron ProcessMetric.memory.workingSetSize). */
  workingSetKb: number
  name?: string
}

export type ProcessMetricsByType = {
  type: string
  count: number
  cpuPercent: number
  workingSetMb: number
}

export type ProcessMetricsSnapshot = {
  at: string
  totalWorkingSetMb: number
  maxCpuPercent: number
  byType: ProcessMetricsByType[]
}

export function summarizeProcessMetrics(
  metrics: ProcessMetricInput[],
  at: string = new Date().toISOString()
): ProcessMetricsSnapshot {
  const byTypeMap = new Map<string, ProcessMetricsByType>()
  let totalKb = 0
  let maxCpuPercent = 0
  for (const row of metrics) {
    const type = row.type.trim() || 'Unknown'
    const cpu = Number.isFinite(row.cpuPercent) ? row.cpuPercent : 0
    const kb = Number.isFinite(row.workingSetKb) ? Math.max(0, row.workingSetKb) : 0
    totalKb += kb
    if (cpu > maxCpuPercent) maxCpuPercent = cpu
    const prev = byTypeMap.get(type)
    if (prev) {
      prev.count += 1
      prev.cpuPercent += cpu
      prev.workingSetMb += kb / 1024
    } else {
      byTypeMap.set(type, {
        type,
        count: 1,
        cpuPercent: cpu,
        workingSetMb: kb / 1024
      })
    }
  }
  const byType = [...byTypeMap.values()]
    .map((row) => ({
      ...row,
      cpuPercent: Math.round(row.cpuPercent * 10) / 10,
      workingSetMb: Math.round(row.workingSetMb)
    }))
    .sort((a, b) => b.workingSetMb - a.workingSetMb)
  return {
    at,
    totalWorkingSetMb: Math.round(totalKb / 1024),
    maxCpuPercent: Math.round(maxCpuPercent * 10) / 10,
    byType
  }
}

export function shouldLogProcessMetrics(
  snap: ProcessMetricsSnapshot,
  nowMs: number,
  lastLogAtMs: number
): boolean {
  const hot =
    snap.totalWorkingSetMb > PROCESS_METRICS_RSS_WARN_MB ||
    snap.maxCpuPercent > PROCESS_METRICS_CPU_WARN
  if (!hot) return false
  if (lastLogAtMs <= 0) return true
  return nowMs - lastLogAtMs >= PROCESS_METRICS_LOG_INTERVAL_MS
}

export function readAppProcessMetrics(): ProcessMetricInput[] {
  try {
    // Dynamic require keeps unit tests that import summarizers off Electron.
    const electron = require('electron') as {
      app?: {
        getAppMetrics?: () => Array<{
          type?: string
          cpu?: { percentCPUUsage?: number }
          memory?: { workingSetSize?: number }
          serviceName?: string
        }>
      }
    }
    const rows = electron.app?.getAppMetrics?.()
    if (!Array.isArray(rows)) return []
    return rows.map((row) => ({
      type: String(row.type ?? 'Unknown'),
      cpuPercent: row.cpu?.percentCPUUsage ?? 0,
      workingSetKb: row.memory?.workingSetSize ?? 0,
      name: row.serviceName
    }))
  } catch {
    return []
  }
}

export function collectProcessMetricsSnapshot(
  metrics: ProcessMetricInput[] = readAppProcessMetrics(),
  at?: string
): ProcessMetricsSnapshot {
  return summarizeProcessMetrics(metrics, at)
}
