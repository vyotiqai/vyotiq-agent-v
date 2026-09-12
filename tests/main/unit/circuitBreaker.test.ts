import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_FAILURE_THRESHOLD,
  MCP_CONNECT_CIRCUIT_POLICY,
  assertCircuitClosed,
  circuitKeyHttp,
  circuitKeyMcpConnect,
  circuitKeyProvider,
  inspectCircuit,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe,
  resetCircuit
} from '@main/agent/circuitBreaker'

describe('circuitBreaker', () => {
  it('never opens, no matter how many consecutive failures are recorded', () => {
    const key = circuitKeyProvider('openai')
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD + 5; i++) {
      recordCircuitFailure(key)
      expect(inspectCircuit(key).state).toBe('closed')
      expect(() => assertCircuitClosed(key)).not.toThrow()
    }
    // Failures are still counted for diagnostics.
    expect(inspectCircuit(key).consecutiveFailures).toBe(CIRCUIT_FAILURE_THRESHOLD + 5)
  })

  it('MCP connect keys never open either (single-failure trip removed)', () => {
    const key = circuitKeyMcpConnect('fs')
    assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)
    recordCircuitFailure(key, MCP_CONNECT_CIRCUIT_POLICY)
    expect(inspectCircuit(key).state).toBe('closed')
    expect(() => assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)).not.toThrow()
  })

  it('resets the failure count on success', () => {
    const key = circuitKeyHttp('https://api.example.test/v1')
    recordCircuitFailure(key)
    recordCircuitFailure(key)
    recordCircuitSuccess(key)
    expect(inspectCircuit(key).consecutiveFailures).toBe(0)
    resetCircuit(key)
    expect(inspectCircuit(key).state).toBe('closed')
    assertCircuitClosed(key)
  })

  it('isolates keys so one host cannot affect another', () => {
    const down = circuitKeyHttp('https://down.test/a')
    const up = circuitKeyHttp('https://up.test/a')
    for (let i = 0; i < 10; i++) recordCircuitFailure(down)
    assertCircuitClosed(up)
    expect(inspectCircuit(up).consecutiveFailures).toBe(0)
    expect(inspectCircuit(down).consecutiveFailures).toBe(10)
  })

  it('isolates custom provider endpoints in the stream circuit key', () => {
    expect(circuitKeyProvider('custom', 'http://127.0.0.1:11434')).not.toBe(
      circuitKeyProvider('custom', 'http://127.0.0.1:8080')
    )
    expect(circuitKeyProvider('openai')).toBe('provider:openai:http:default')
  })

  it('evicts the breaker entry on success once closed and idle (per-session key bound)', () => {
    // Audit L-13: per-session keys (mcp-connect:<sessionKey>) accumulate when
    // every success leaves a fully-closed entry behind. A closed, zero-failure
    // breaker is identical to an absent one (inspectCircuit reports closed
    // either way), so success must not retain the entry.
    const key = circuitKeyMcpConnect('session-a')
    recordCircuitFailure(key, MCP_CONNECT_CIRCUIT_POLICY)
    recordCircuitSuccess(key)
    // Closed → indistinguishable from never-seen, and the entry is gone.
    expect(inspectCircuit(key)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      retryAfterMs: 0
    })
  })

  it('probe release is a safe no-op now that the breaker never opens', () => {
    const key = circuitKeyHttp('https://probe.test/a')
    releaseCircuitProbe(key)
    expect(() => assertCircuitClosed(key)).not.toThrow()
    expect(inspectCircuit(key).state).toBe('closed')
  })
})
