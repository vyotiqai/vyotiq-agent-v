import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  cancelPendingApprovals,
  createApprovalGate,
  isAutonomousHighRiskTool,
  isToolGated,
  listPendingToolApprovals,
  registerApprovalSender,
  resetToolApprovalForTests,
  resolveToolApproval,
  TOOL_APPROVAL_TIMEOUT_MS
} from '@main/agent/toolApproval'
import type { ToolApprovalRequest } from '@shared/ipc'

const READ = { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
const WRITE = { id: 'c2', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' }

describe('isToolGated', () => {
  const none = new Set<string>()

  it('never gates builtin tools when approval is off', () => {
    expect(isToolGated('edit', 'off', none, [])).toBe(false)
  })

  it('gates only mutating tools in mutating mode', () => {
    expect(isToolGated('edit', 'mutating', none, [])).toBe(true)
    expect(isToolGated('read', 'mutating', none, [])).toBe(false)
  })

  it('gates reads too in all mode', () => {
    expect(isToolGated('read', 'all', none, [])).toBe(true)
  })

  it('skips tools on either allowlist', () => {
    expect(isToolGated('edit', 'all', new Set(['edit']), [])).toBe(false)
    expect(isToolGated('edit', 'all', none, ['edit'])).toBe(false)
  })

  it('gates MCP server tools when mode is off and protection is on', () => {
    expect(isToolGated('mcp__gmail__send', 'off', none, [])).toBe(true)
    expect(
      isToolGated('mcp__gmail__send', 'off', none, [], undefined, { mcpProtection: true })
    ).toBe(true)
  })

  it('does not gate builtin MCP meta tools when mode is off', () => {
    for (const name of ['mcp_list_tools', 'request_mcp_tools', 'release_mcp_tools']) {
      expect(isToolGated(name, 'off', none, [])).toBe(false)
    }
  })

  it('lets MCP server tools follow global mode when protection is off', () => {
    expect(
      isToolGated('mcp__gmail__send', 'off', none, [], undefined, { mcpProtection: false })
    ).toBe(false)
    expect(
      isToolGated('mcp__gmail__send', 'mutating', none, [], undefined, { mcpProtection: false })
    ).toBe(true)
    expect(isToolGated('read', 'mutating', none, [], undefined, { mcpProtection: false })).toBe(
      false
    )
  })

  it('skips allowlisted MCP tools even when protection is on', () => {
    expect(isToolGated('mcp__gmail__send', 'off', new Set(['mcp__gmail__send']), [])).toBe(false)
    expect(isToolGated('mcp__gmail__send', 'off', none, ['mcp__gmail__send'])).toBe(false)
  })
})

describe('createApprovalGate', () => {
  beforeEach(() => {
    resetToolApprovalForTests()
  })

  it('allows ungated tools without asking', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })

    expect(await gate.authorize(READ)).toEqual({ allowed: true })
    expect(asked).toBe(0)
  })

  it('returns a denial the model can read back', async () => {
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask: async () => 'deny'
    })

    const verdict = await gate.authorize(WRITE)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/denied permission to run edit/)
  })

  it('asks once per tool after "allow for session"', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'all',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'session'
      }
    })

    await gate.authorize(WRITE)
    await gate.authorize(WRITE)
    expect(asked).toBe(1)
  })

  it('persists "always allow" for the next run', async () => {
    const persisted: string[] = []
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      persistAlways: (name) => persisted.push(name),
      ask: async () => 'always'
    })

    await gate.authorize(WRITE)
    expect(persisted).toEqual(['edit'])
  })

  it('rides the renderer round trip', async () => {
    const seen: ToolApprovalRequest[] = []
    registerApprovalSender('run-1', (request) => {
      seen.push(request)
    })
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })

    const verdict = gate.authorize(WRITE)
    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.name).toBe('edit')
    expect(seen[0]!.mutating).toBe(true)

    expect(resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'once' })).toBe(true)
    expect(await verdict).toEqual({ allowed: true })
  })

  it('denies when no window is listening rather than hanging', async () => {
    const gate = createApprovalGate({
      runId: 'run-nobody',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })
    const verdict = await gate.authorize(WRITE)
    expect(verdict.allowed).toBe(false)
  })

  it('releases a waiting prompt when the run is cancelled', async () => {
    registerApprovalSender('run-1', () => {})
    const controller = new AbortController()
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: controller.signal
    })

    const verdict = gate.authorize(WRITE)
    await Promise.resolve()
    controller.abort()
    await expect(verdict).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('releases prompts left over when a run ends', async () => {
    registerApprovalSender('run-1', () => {})
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })

    const verdict = gate.authorize(WRITE)
    await Promise.resolve()
    cancelPendingApprovals('run-1')
    await expect(verdict).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not deny a later invoke when cancelling an earlier invoke', async () => {
    const requests: ToolApprovalRequest[] = []
    registerApprovalSender('run-1', (request) => {
      requests.push(request)
    })

    const gateOld = createApprovalGate({
      runId: 'run-1',
      invokeId: 1,
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })
    const gateNew = createApprovalGate({
      runId: 'run-1',
      invokeId: 2,
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })

    const oldVerdict = gateOld.authorize(WRITE)
    const newVerdict = gateNew.authorize({ id: 'c3', name: 'edit', arguments: '{"path":"b.ts","contents":"y"}' })
    await Promise.resolve()
    expect(requests).toHaveLength(2)

    cancelPendingApprovals('run-1', 1)
    await expect(oldVerdict).rejects.toMatchObject({ name: 'AbortError' })

    resolveToolApproval({ requestId: requests[1]!.requestId, runId: 'run-1', decision: 'once' })
    expect((await newVerdict).allowed).toBe(true)
  })



  it('lists pending approvals for remount restore', async () => {
    const seen: ToolApprovalRequest[] = []
    registerApprovalSender('run-1', (request) => {
      seen.push(request)
    })
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })

    const verdict = gate.authorize(WRITE)
    await Promise.resolve()
    expect(listPendingToolApprovals('run-1')).toHaveLength(1)
    expect(listPendingToolApprovals('run-1')[0]!.name).toBe('edit')
    expect(listPendingToolApprovals('other')).toEqual([])

    // Re-registering re-pushes still-pending approvals.
    registerApprovalSender('run-1', (request) => {
      seen.push(request)
    })
    expect(seen).toHaveLength(2)

    expect(resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'once' })).toBe(true)
    await expect(verdict).resolves.toEqual({ allowed: true })
    expect(listPendingToolApprovals('run-1')).toEqual([])
  })

  it('rejects resolve when runId does not match pending entry', async () => {
    const requests: ToolApprovalRequest[] = []
    registerApprovalSender('run-1', (request) => {
      requests.push(request)
    })
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })
    const verdict = gate.authorize(WRITE)
    await Promise.resolve()
    expect(
      resolveToolApproval({
        requestId: requests[0]!.requestId,
        runId: 'other-run',
        decision: 'once'
      })
    ).toBe(false)
    expect(resolveToolApproval({ requestId: requests[0]!.requestId, runId: 'run-1', decision: 'once' })).toBe(
      true
    )
    expect(await verdict).toEqual({ allowed: true })
  })

  it('auto-denies after the approval timeout', async () => {
    vi.useFakeTimers()
    try {
      registerApprovalSender('run-1', () => {})
      const gate = createApprovalGate({
        runId: 'run-1',
        mode: 'mutating',
        workspaceAllowlist: [],
        signal: new AbortController().signal
      })
      const verdict = gate.authorize(WRITE)
      await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_TIMEOUT_MS)
      const result = await verdict
      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toMatch(/timed out/i)
        expect(result.reason).not.toMatch(/user denied/i)
      }
    } finally {
      vi.useRealTimers()
      resetToolApprovalForTests()
    }
  })

  it('auto-approves gated tools in autonomous mode except high-risk', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-auto',
      mode: 'all',
      workspaceAllowlist: [],
      autonomousMode: true,
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })
    expect(await gate.authorize(READ)).toEqual({ allowed: true })
    expect(asked).toBe(0)
    const deleteCall = { id: 'c-del', name: 'delete', arguments: '{"path":"a.ts"}' }
    const pending = gate.authorize(deleteCall)
    await Promise.resolve()
    expect(asked).toBe(1)
    expect(await pending).toEqual({ allowed: true })
  })

  it('flags high-risk tools for autonomous gating', () => {
    expect(isAutonomousHighRiskTool('delete')).toBe(true)
    expect(isAutonomousHighRiskTool('Delete')).toBe(true)
    expect(isAutonomousHighRiskTool('terminal')).toBe(true)
    expect(isAutonomousHighRiskTool('bash')).toBe(true)
    expect(isAutonomousHighRiskTool('Write')).toBe(true)
    expect(isAutonomousHighRiskTool('git_commit')).toBe(true)
    expect(isAutonomousHighRiskTool('github_pr_create')).toBe(true)
    expect(isAutonomousHighRiskTool('github_pr_review')).toBe(true)
    expect(isAutonomousHighRiskTool('github_issue')).toBe(true)
    expect(isAutonomousHighRiskTool('merge_agent_instance')).toBe(true)
    expect(isAutonomousHighRiskTool('edit_notebook')).toBe(true)
    expect(isAutonomousHighRiskTool('lsp', JSON.stringify({ action: 'rename' }))).toBe(true)
    expect(isAutonomousHighRiskTool('lsp', JSON.stringify({ action: 'hover' }))).toBe(false)
    expect(isAutonomousHighRiskTool('read')).toBe(false)
    expect(isAutonomousHighRiskTool('mcp__server__run_command')).toBe(true)
  })

  it('does not auto-approve aliased high-risk tools in autonomous mode', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-auto-alias',
      mode: 'mutating',
      workspaceAllowlist: [],
      autonomousMode: true,
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })
    const pending = gate.authorize({
      id: 'c-write',
      name: 'Write',
      arguments: '{"path":"a.ts","contents":"x"}'
    })
    await Promise.resolve()
    expect(asked).toBe(1)
    expect(await pending).toEqual({ allowed: true })
  })

  it('asks for MCP server tools when mode is off and mcpProtection is on', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-mcp-prot',
      mode: 'off',
      mcpProtection: true,
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })
    expect(await gate.authorize(READ)).toEqual({ allowed: true })
    expect(asked).toBe(0)
    expect(
      await gate.authorize({ id: 'c-mcp', name: 'mcp__gmail__send', arguments: '{}' })
    ).toEqual({ allowed: true })
    expect(asked).toBe(1)
    expect(
      await gate.authorize({ id: 'c-meta', name: 'mcp_list_tools', arguments: '{}' })
    ).toEqual({ allowed: true })
    expect(asked).toBe(1)
  })

  it('lets MCP server tools through when mode is off and mcpProtection is off', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-mcp-off',
      mode: 'off',
      mcpProtection: false,
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })
    expect(
      await gate.authorize({ id: 'c-mcp', name: 'mcp__gmail__send', arguments: '{}' })
    ).toEqual({ allowed: true })
    expect(asked).toBe(0)
  })

  it('does not auto-approve gated MCP tools in autonomous mode', async () => {
    let asked = 0
    const gate = createApprovalGate({
      runId: 'run-auto-mcp',
      mode: 'all',
      workspaceAllowlist: [],
      autonomousMode: true,
      signal: new AbortController().signal,
      ask: async () => {
        asked += 1
        return 'once'
      }
    })
    const mcpCall = {
      id: 'c-mcp',
      name: 'mcp__server__mutate',
      arguments: '{"path":"a.ts"}'
    }
    const pending = gate.authorize(mcpCall)
    await Promise.resolve()
    expect(asked).toBe(1)
    expect(await pending).toEqual({ allowed: true })
  })
})
