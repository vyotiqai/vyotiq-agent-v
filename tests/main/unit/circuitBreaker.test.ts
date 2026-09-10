import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
  CircuitOpenError,
  MCP_CONNECT_CIRCUIT_POLICY,
  assertCircuitClosed,
  circuitKeyHttp,
  circuitKeyMcpConnect,
  circuitKeyProvider,
  inspectCircuit,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe,
  resetCircuit,
  setCircuitNowForTests
} from '@main/agent/circuitBreaker'

describe('circuitBreaker', () => {
  it('stays closed until consecutive failures reach the threshold', () => {
    const key = circuitKeyProvider('openai')
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      assertCircuitClosed(key)
      recordCircuitFailure(key)
      expect(inspectCircuit(key).state).toBe('closed')
    }
    recordCircuitFailure(key)
    expect(inspectCircuit(key).state).toBe('open')
    expect(() => assertCircuitClosed(key)).toThrow(CircuitOpenError)
  })

  it('closes again after a successful call', () => {
    const key = circuitKeyHttp('https://api.example.test/v1')
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    expect(inspectCircuit(key).state).toBe('open')
    resetCircuit(key)
    assertCircuitClosed(key)
    recordCircuitSuccess(key)
    expect(inspectCircuit(key).state).toBe('closed')
  })

  it('allows one half-open probe after the open window, then re-opens on failure', () => {
    const key = 'http:probe.test'
    let t = 1_000
    setCircuitNowForTests(() => t)
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    expect(() => assertCircuitClosed(key)).toThrow(CircuitOpenError)

    t += CIRCUIT_OPEN_MS
    assertCircuitClosed(key)
    expect(inspectCircuit(key).state).toBe('half_open')
    expect(() => assertCircuitClosed(key)).toThrow(CircuitOpenError)

    recordCircuitFailure(key)
    expect(inspectCircuit(key).state).toBe('open')
  })

  it('releases a half-open probe so a later call can probe again', () => {
    const key = 'http:abort-probe.test'
    let t = 1_000
    setCircuitNowForTests(() => t)
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    t += CIRCUIT_OPEN_MS
    assertCircuitClosed(key)
    expect(inspectCircuit(key).state).toBe('half_open')
    expect(() => assertCircuitClosed(key)).toThrow(CircuitOpenError)

    releaseCircuitProbe(key)
    assertCircuitClosed(key)
    expect(inspectCircuit(key).state).toBe('half_open')
    expect(() => assertCircuitClosed(key)).toThrow(CircuitOpenError)
  })

  it('half-open success returns to closed', () => {
    const key = 'provider:gemini'
    let t = 5_000
    setCircuitNowForTests(() => t)
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    t += CIRCUIT_OPEN_MS
    assertCircuitClosed(key)
    recordCircuitSuccess(key)
    expect(inspectCircuit(key).state).toBe('closed')
    assertCircuitClosed(key)
  })

  it('MCP connect policy opens after a single failure', () => {
    const key = circuitKeyMcpConnect('fs')
    assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)
    recordCircuitFailure(key, MCP_CONNECT_CIRCUIT_POLICY)
    expect(inspectCircuit(key).state).toBe('open')
    expect(() => assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)).toThrow(
      /Circuit open for mcp-connect:fs/
    )
  })

  it('isolates keys so one host does not trip another', () => {
    const down = circuitKeyHttp('https://down.test/a')
    const up = circuitKeyHttp('https://up.test/a')
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(down)
    assertCircuitClosed(up)
    expect(() => assertCircuitClosed(down)).toThrow(CircuitOpenError)
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
    assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)
    recordCircuitFailure(key, MCP_CONNECT_CIRCUIT_POLICY)
    expect(inspectCircuit(key).state).toBe('open')

    recordCircuitSuccess(key)
    // Closed → indistinguishable from never-seen, and the entry is gone.
    expect(inspectCircuit(key)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      retryAfterMs: 0
    })
    // Absent entry still asserts closed and re-creates on demand with the
    // caller-supplied policy — a fresh failure re-opens as before.
    assertCircuitClosed(key, MCP_CONNECT_CIRCUIT_POLICY)
    recordCircuitFailure(key, MCP_CONNECT_CIRCUIT_POLICY)
    expect(inspectCircuit(key).state).toBe('open')
  })
})
