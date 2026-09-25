import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-await-timeout-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/agent/startAgentRun', () => ({
  startAgentRunInBackground: vi.fn()
}))

import { resetAgentInstancesForTests, waitForChildTerminal } from '@main/agent/agentInstances'
import { createRun } from '@main/agent/state'
import { clearRunAbort, resetActiveRunsForTests, tryRegisterRunAbort } from '@main/agent/runRegistry'
import { AGENT_TOOLS, AWAIT_AGENT_INSTANCE_MAX_MS } from '@main/agent/schemas/tools'

describe('await_agent_instance timeout contract', () => {
  let workspacePath: string
  const root = join(tmpdir(), `vyotiq-await-timeout-root-${process.pid}`)

  beforeEach(() => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    workspacePath = join(root, `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(workspacePath, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('timeout error names the wait cap and never advises a longer timeout_ms', async () => {
    const childRunId = 'child-await-timeout'
    createRun(workspacePath, childRunId, 'long-running child', {
      mode: 'agent',
      parentRunId: 'parent-await-timeout',
      inlineInstance: true
    })
    // Keep the child "active" so waitForChildTerminal does not short-circuit to
    // "is not running" and instead waits until the bound fires.
    const reg = tryRegisterRunAbort(childRunId, workspacePath)
    if (!reg.ok) throw new Error(reg.error)

    const err = await waitForChildTerminal(childRunId, workspacePath, 50).then(
      () => null,
      (e: unknown) => e as Error
    )
    clearRunAbort(childRunId)

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('Timed out waiting for')
    expect(msg).toContain('after 50 ms')
    expect(msg).toContain(String(AWAIT_AGENT_INSTANCE_MAX_MS))
    // Regression (w6-instances): the old message advised "await again with a
    // longer timeout_ms", but the handler silently clamps timeout_ms to
    // AWAIT_AGENT_INSTANCE_MAX_MS (src/main/agent/tools/instanceTools.ts), so
    // the advertised remedy could never extend a single wait — parents burned
    // repeated 15-minute windows passing 1.2M–1.8M ms that were clamped back.
    expect(msg).not.toContain('await again with a longer timeout_ms')
  })

  it('tool catalog does not advertise the impossible longer-timeout remedy', () => {
    const def = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(def).toBeDefined()
    expect(def!.description).not.toContain('a longer timeout_ms')
    expect(def!.description).toContain('capped')
  })
})
