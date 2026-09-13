import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureChatUiPerfDump,
  getChatUiPerfStats,
  recordUiResume,
  recordUiSuspendSkip,
  resetChatUiPerfStats,
  stopChatUiPerfDumpForTests
} from '@renderer/lib/hooks/chatUiPerf'

describe('chatUiPerf', () => {
  beforeEach(() => {
    resetChatUiPerfStats()
    stopChatUiPerfDumpForTests()
  })

  it('counts suspend skips and resumes', () => {
    recordUiSuspendSkip()
    recordUiSuspendSkip()
    recordUiResume(true)
    recordUiResume(false)
    expect(getChatUiPerfStats()).toEqual({
      suspendSkips: 2,
      resumesWithCatchUp: 1,
      resumesNoop: 1
    })
  })

  it('dumps when sessionStorage vyotiq-perf=1', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => (key === 'vyotiq-perf' ? '1' : null)
    })
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    ensureChatUiPerfDump()
    recordUiSuspendSkip()
    vi.advanceTimersByTime(5_000)
    expect(spy).toHaveBeenCalledWith(
      '[vyotiq-perf] chatUi',
      JSON.stringify({ suspendSkips: 1, resumesWithCatchUp: 0, resumesNoop: 0 })
    )
    spy.mockRestore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not arm a dump interval when vyotiq-perf is unset', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null
    })
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    ensureChatUiPerfDump()
    recordUiSuspendSkip()
    vi.advanceTimersByTime(15_000)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
