import { describe, expect, it } from 'vitest'
import {
  resolveNewCommandBlockUntilMs,
  resolveSessionPollBlockUntilMs,
  TERMINAL_DEFAULT_TIMEOUT_MS,
  TERMINAL_MAX_TIMEOUT_MS
} from '@main/agent/tools/terminal'
import { validateToolArgs } from '@main/agent/schemas/tools'

describe('resolveNewCommandBlockUntilMs', () => {
  it('uses timeoutMs when block_until_ms is omitted', () => {
    expect(resolveNewCommandBlockUntilMs({ timeoutMs: 120_000 })).toBe(120_000)
  })

  it('uses block_until_ms when timeoutMs is omitted', () => {
    expect(resolveNewCommandBlockUntilMs({ block_until_ms: 1_000 })).toBe(1_000)
  })

  it('waits the larger when both are set', () => {
    expect(
      resolveNewCommandBlockUntilMs({ block_until_ms: 1_000, timeoutMs: 120_000 })
    ).toBe(120_000)
    expect(
      resolveNewCommandBlockUntilMs({ block_until_ms: 180_000, timeoutMs: 120_000 })
    ).toBe(180_000)
  })

  it('backgrounds immediately when block_until_ms is 0 even if timeoutMs is set', () => {
    expect(resolveNewCommandBlockUntilMs({ block_until_ms: 0, timeoutMs: 120_000 })).toBe(0)
  })

  it('defaults when both are omitted', () => {
    expect(resolveNewCommandBlockUntilMs({})).toBe(TERMINAL_DEFAULT_TIMEOUT_MS)
  })
})

describe('resolveSessionPollBlockUntilMs', () => {
  it('uses block_until_ms when set', () => {
    expect(resolveSessionPollBlockUntilMs({ block_until_ms: 10_000 })).toBe(10_000)
  })

  it('defaults to 30s when omitted', () => {
    expect(resolveSessionPollBlockUntilMs({})).toBe(30_000)
  })

  it('does not use timeoutMs', () => {
    expect(resolveSessionPollBlockUntilMs({ block_until_ms: 50, timeoutMs: 120_000 } as { block_until_ms?: number })).toBe(50)
  })
})

describe('terminal wait schema max', () => {
  it('accepts timeoutMs and block_until_ms at the 1_800_000 bound', () => {
    expect(
      validateToolArgs(
        'terminal',
        JSON.stringify({ command: 'echo hi', timeoutMs: TERMINAL_MAX_TIMEOUT_MS })
      ).ok
    ).toBe(true)
    expect(
      validateToolArgs(
        'terminal',
        JSON.stringify({ command: 'echo hi', block_until_ms: TERMINAL_MAX_TIMEOUT_MS })
      ).ok
    ).toBe(true)
  })

  it('rejects timeoutMs and block_until_ms above 1_800_000 at Zod', () => {
    const timeout = validateToolArgs(
      'terminal',
      JSON.stringify({ command: 'echo hi', timeoutMs: TERMINAL_MAX_TIMEOUT_MS + 1 })
    )
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) expect(timeout.error).toMatch(/timeoutMs/)

    const block = validateToolArgs(
      'terminal',
      JSON.stringify({ command: 'echo hi', block_until_ms: TERMINAL_MAX_TIMEOUT_MS + 1 })
    )
    expect(block.ok).toBe(false)
    if (!block.ok) expect(block.error).toMatch(/block_until_ms/)
  })
})
