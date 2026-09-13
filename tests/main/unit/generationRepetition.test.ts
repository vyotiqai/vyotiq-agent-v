import { describe, expect, it } from 'vitest'
import {
  countOverlappingOccurrences,
  GenerationRepetitionMonitor
} from '../../../src/main/agent/generationRepetition'

/** Stream `full` into deltas of `size` chars, feeding each to the monitor. */
function streamInDeltas(
  monitor: GenerationRepetitionMonitor,
  full: string,
  size: number
): boolean {
  let detected = false
  for (let i = 0; i < full.length; i += size) {
    if (monitor.append(full.slice(i, i + size))) detected = true
  }
  return detected
}

describe('countOverlappingOccurrences', () => {
  it('counts overlapping occurrences', () => {
    expect(countOverlappingOccurrences('aaaa', 'aa')).toBe(3)
    expect(countOverlappingOccurrences('abcabcabc', 'abcabc')).toBe(2)
    expect(countOverlappingOccurrences('abc', 'xyz')).toBe(0)
    expect(countOverlappingOccurrences('abc', '')).toBe(0)
    expect(countOverlappingOccurrences('a', 'abc')).toBe(0)
  })
})

describe('GenerationRepetitionMonitor', () => {
  it('REGRESSION: 1500-char block repeated 192x (unaligned unit) fires', () => {
    // Unit length shares gcd 4 with 256 (the old chunk size) and is not a
    // multiple of 256 or of tailLength 1024 — exactly the audited run be413e92
    // shape. Chunk-phase aliasing must not suppress detection.
    const sentence =
      'Runtime failure trace: scheduler drifted from nominal orbit and the ' +
      'recovery loop re-entered with stale offsets, so each retry replanned ' +
      'against a snapshot that had already been invalidated by the last write; '
    const unit = sentence.repeat(32).slice(0, 1500)
    const block = unit
    expect(block.length).toBe(1500)
    expect(1500 % 256).not.toBe(0)
    expect(1500 % 1024).not.toBe(0)
    const full = block.repeat(192)
    const monitor = new GenerationRepetitionMonitor()
    expect(streamInDeltas(monitor, full, 4096)).toBe(true)
    expect(monitor.detected).toBe(true)
  })

  it('fires on a small repeated unit (120-char block x500)', () => {
    const unit =
      'Retry 0x1f: slot reservation failed, waiting for the lease to expire. '
    const padded = unit.padEnd(120, '#')
    expect(padded.length).toBe(120)
    const monitor = new GenerationRepetitionMonitor()
    expect(streamInDeltas(monitor, padded.repeat(500), 4096)).toBe(true)
    expect(monitor.detected).toBe(true)
  })

  it('does NOT fire on normal varied prose well past minLength', () => {
    const words =
      'the scheduler rebalanced quotas across tenants while the cache warmed ' +
      'and reviewers left notes about naming, retries, backoff, and telemetry ' +
      'coverage; later the manifest was regenerated and the diff looked clean. '
    let full = ''
    let n = 0
    while (full.length < 40_000) {
      full += `${n} — ${words}${(n * 7919) % 997}`
      n++
    }
    const monitor = new GenerationRepetitionMonitor()
    expect(streamInDeltas(monitor, full, 4096)).toBe(false)
    expect(monitor.detected).toBe(false)
  })

  it('does NOT fire on repeated short tokens under minLength', () => {
    const full = 'ok '.repeat(2000) // 6000 chars < minLength 8192
    expect(full.length).toBeLessThan(8192)
    const monitor = new GenerationRepetitionMonitor()
    expect(streamInDeltas(monitor, full, 512)).toBe(false)
    expect(monitor.detected).toBe(false)
  })

  it('latches: detected stays true once fired', () => {
    const monitor = new GenerationRepetitionMonitor()
    monitor.append('a'.repeat(20_000))
    expect(monitor.detected).toBe(true)
    monitor.append('totally different content')
    expect(monitor.detected).toBe(true)
    expect(monitor.append('more')).toBe(true)
  })

  it('is safe with empty deltas and default constructor', () => {
    const monitor = new GenerationRepetitionMonitor()
    expect(monitor.append('')).toBe(false)
    expect(monitor.append('' )).toBe(false)
    expect(monitor.detected).toBe(false)
    expect(monitor.append('x')).toBe(false)
    expect(monitor.detected).toBe(false)
  })

  it('fires when repetition starts after a long non-repeating prefix', () => {
    let prefix = ''
    let n = 0
    while (prefix.length < 20_000) {
      prefix += `prefix segment ${n++} — varied transient prose, no unit repeats here. `
    }
    const unit = 'loop body: emit the same audit line over and over again. '
    const padded = unit.padEnd(300, '~')
    expect(padded.length).toBe(300)
    const monitor = new GenerationRepetitionMonitor()
    const full = prefix + padded.repeat(500)
    expect(streamInDeltas(monitor, full, 4096)).toBe(true)
    expect(monitor.detected).toBe(true)
  })

  it('accepts overridable options and fires early with a small threshold', () => {
    const unit = 'u'.repeat(64)
    const monitor = new GenerationRepetitionMonitor({
      minLength: 256,
      tailLength: 32,
      threshold: 3,
      checkInterval: 64
    })
    monitor.append(unit.repeat(20)) // 1280 chars, tail 64 repeats ~19x
    expect(monitor.detected).toBe(true)
  })
})
