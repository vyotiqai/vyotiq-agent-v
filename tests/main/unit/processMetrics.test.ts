import { describe, expect, it } from 'vitest'
import {
  shouldLogProcessMetrics,
  summarizeProcessMetrics,
  PROCESS_METRICS_LOG_INTERVAL_MS
} from '@main/perf/processMetrics'

describe('processMetrics summarizer', () => {
  it('rolls Chromium rows up by type and converts KiB working set to MB', () => {
    const snap = summarizeProcessMetrics(
      [
        { type: 'Browser', cpuPercent: 2.4, workingSetKb: 400 * 1024 },
        { type: 'GPU', cpuPercent: 8.1, workingSetKb: 300 * 1024 },
        { type: 'Tab', cpuPercent: 12.2, workingSetKb: 800 * 1024 },
        { type: 'Tab', cpuPercent: 4, workingSetKb: 200 * 1024 },
        { type: 'Utility', cpuPercent: 18, workingSetKb: 700 * 1024 }
      ],
      '2026-08-23T00:00:00.000Z'
    )
    expect(snap.totalWorkingSetMb).toBe(2400)
    expect(snap.maxCpuPercent).toBe(18)
    expect(snap.byType.find((row) => row.type === 'Tab')).toMatchObject({
      count: 2,
      workingSetMb: 1000
    })
  })

  it('logs when combined RSS or CPU is high, rate-limited to 30s', () => {
    const hot = summarizeProcessMetrics(
      [{ type: 'Browser', cpuPercent: 40, workingSetKb: 1200 * 1024 }],
      '2026-08-23T00:00:00.000Z'
    )
    expect(shouldLogProcessMetrics(hot, 1_000, 0)).toBe(true)
    expect(shouldLogProcessMetrics(hot, 1_000 + PROCESS_METRICS_LOG_INTERVAL_MS - 1, 1_000)).toBe(
      false
    )
    expect(shouldLogProcessMetrics(hot, 1_000 + PROCESS_METRICS_LOG_INTERVAL_MS, 1_000)).toBe(true)

    const cool = summarizeProcessMetrics(
      [{ type: 'Browser', cpuPercent: 1, workingSetKb: 200 * 1024 }],
      '2026-08-23T00:00:00.000Z'
    )
    expect(shouldLogProcessMetrics(cool, 5_000, 0)).toBe(false)
  })
})
