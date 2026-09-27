import { describe, expect, it, vi } from 'vitest'
import { createApprovalGate, isAutonomousHighRiskTool, isToolGated } from '@main/agent/toolApproval'
import { stepToolBatchClass } from '@main/agent/tools/classify'
import { toolArgsFromCall } from '@main/agent/loopPolicy'

/**
 * Approval and step classification must gate the arguments execution runs
 * with (wire salvage + alias normalization), not the raw JSON.
 */
describe('approval sees the executed argument view', () => {
  it('gates terminal {cmd, session_id} as a command, not a session poll', async () => {
    const raw = JSON.stringify({ cmd: 'echo hi', session_id: 'x' })
    expect(isToolGated('terminal', 'mutating', new Set(), [], raw)).toBe(true)
    expect(isToolGated('terminal', 'all', new Set(), [], raw)).toBe(true)

    const ask = vi.fn(async () => 'deny' as const)
    const gate = createApprovalGate({
      runId: 'r',
      mode: 'all',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask
    })
    const verdict = await gate.authorize({ id: 'c1', name: 'terminal', arguments: raw })
    expect(verdict.allowed).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('still lets a real session poll through', () => {
    const raw = JSON.stringify({ session_id: '3f1c1d5e-6a0b-4c55-9d7e-1a2b3c4d5e6f' })
    expect(isToolGated('terminal', 'all', new Set(), [], raw)).toBe(false)
  })

  it('matches a per-command allow through the cmd alias', () => {
    const raw = JSON.stringify({ cmd: 'pnpm vitest run' })
    expect(isToolGated('terminal', 'mutating', new Set(), ['terminal:pnpm vitest'], raw)).toBe(false)
  })

  it('gates an unclosed lsp rename in mutating mode and treats it as high-risk', () => {
    const raw = '{"path":"a.ts","action":"rename","line":0,"character":0,"new_name":"y"'
    expect(isToolGated('lsp', 'mutating', new Set(), [], raw)).toBe(true)
    expect(isAutonomousHighRiskTool('lsp', raw)).toBe(true)
  })

  it('classifies an unclosed lsp rename as serial, not a parallel read', () => {
    const raw = '{"path":"a.ts","action":"rename","line":0,"character":0,"new_name":"y"'
    expect(stepToolBatchClass('lsp', toolArgsFromCall(raw))).toBe('serial')
    // Well-formed payloads parse exactly as before.
    expect(toolArgsFromCall('{"path":"a.ts","action":"hover"}')).toEqual({
      path: 'a.ts',
      action: 'hover'
    })
    expect(toolArgsFromCall('[1,2]')).toEqual({})
  })
})
