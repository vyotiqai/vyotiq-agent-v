import { mkdtemp, readdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTraceCapture,
  FLIGHT_RECORDER_CONFIG,
  TRACE_INCLUDED_CATEGORIES
} from '@main/perf/traceCapture'

function fakeContentTracing() {
  return {
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async (path?: string) => path ?? ''),
    getTraceBufferUsage: vi.fn(async () => ({ value: 4242, percentage: 42 }))
  }
}

const EXPECTED_CONFIG = {
  included_categories: [...TRACE_INCLUDED_CATEGORIES],
  recording_mode: FLIGHT_RECORDER_CONFIG.recording_mode,
  enable_argument_filter: true,
  trace_buffer_size_in_kb: FLIGHT_RECORDER_CONFIG.trace_buffer_size_in_kb
}

describe('traceCapture flight recorder', () => {
  it('ensureRecording starts a record-continuously TraceConfig with argument filter', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    const result = await capture.ensureRecording()
    expect(ct.startRecording).toHaveBeenCalledWith(EXPECTED_CONFIG)
    expect(result).toEqual({
      categoryFilter: TRACE_INCLUDED_CATEGORIES.join(','),
      traceOptions: 'record-continuously'
    })
  })

  it('ensureRecording is idempotent (no duplicate startRecording)', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    await capture.ensureRecording()
    await capture.ensureRecording()
    expect(ct.startRecording).toHaveBeenCalledTimes(1)
  })

  it('status reports recording state + buffer percentage while recording', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    expect(await capture.status()).toEqual({
      recording: false,
      startedAt: null,
      bufferPercent: null
    })
    await capture.ensureRecording()
    const status = await capture.status()
    expect(status.recording).toBe(true)
    expect(status.bufferPercent).toBe(42)
    expect(status.startedAt).toBeTruthy()
  })

  it('manual dumpNow always produces a file — even if the buffer was never started', async () => {
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => 'C:/traces')
    const result = await capture.dumpNow('manual')
    // Buffer was auto-restarted before the dump, then resumed after it.
    expect(ct.startRecording).toHaveBeenCalledTimes(2)
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(result.path.replace(/\\/g, '/').startsWith('C:/traces/trace-manual-')).toBe(true)
    expect(result.path.endsWith('.json')).toBe(true)
    // Real statSync fails on the fake path → falls back to 0 (documented).
    expect(result.bytes).toBe(0)
    expect((await capture.status()).recording).toBe(true)
  })

  it('dumps restart the buffer, write a reason-stamped file, and resume recording', async () => {
    const ct = fakeContentTracing()
    let clock = 1_000_000
    const capture = createTraceCapture(ct, () => 'C:/traces', () => clock)
    await capture.ensureRecording()
    clock += 5_000
    const result = await capture.dumpNow('manual')
    expect(ct.startRecording).toHaveBeenCalledTimes(2) // initial + resume
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    expect(result.durationMs).toBe(5_000)
    expect((await capture.status()).recording).toBe(true)
  })

  it('auto dumps inside the 30s cool-down are skipped without touching the buffer', async () => {
    const ct = fakeContentTracing()
    let clock = 1_000_000
    const capture = createTraceCapture(ct, () => 'C:/traces', () => clock)
    await capture.ensureRecording()
    clock += 5_000
    await capture.dumpNow('manual') // stamps the cool-down clock
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    clock += 1_000
    await expect(capture.dumpNow('renderer-crash')).rejects.toThrow('cool-down active')
    expect(ct.stopRecording).toHaveBeenCalledTimes(1)
    clock += 31_000
    const result = await capture.dumpNow('renderer-crash')
    expect(ct.stopRecording).toHaveBeenCalledTimes(2)
    expect(result.path.replace(/\\/g, '/')).toContain('/trace-renderer-crash-')
  })

  it('serializes concurrent dumps instead of racing stopRecording', async () => {
    const ct = fakeContentTracing()
    let clock = 1_000_000
    const capture = createTraceCapture(ct, () => 'C:/traces', () => clock)
    await capture.ensureRecording()
    clock += 1_000
    const first = capture.dumpNow('manual')
    clock += 1_000
    const second = capture.dumpNow('child-process-crash')
    clock += 5_000
    const dumped = await first
    await second // queued on the chain, not raced
    expect(ct.stopRecording).toHaveBeenCalledTimes(2)
    expect(dumped.path).toBeTruthy()
  })

  it('prunes oldest trace files past the retention cap in the real traces dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vyotiq-trace-test-'))
    for (let i = 0; i < 11; i++) {
      await writeFile(join(dir, `trace-old-${i}.json`), '{}')
    }
    const ct = fakeContentTracing()
    const capture = createTraceCapture(ct, () => dir)
    await capture.dumpNow('manual')
    // pruneRetention is fire-and-forget — give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 80))
    const remaining = (await readdir(dir)).filter((n) => /^trace-.*\.json$/.test(n))
    expect(remaining.length).toBe(10)
  })
})
