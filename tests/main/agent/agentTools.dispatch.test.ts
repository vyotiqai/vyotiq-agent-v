import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * build_tool, wired end to end.
 *
 * The subsystem that scans and runs agent-authored `.mjs` modules was complete
 * and fully tested but unreachable: `build_tool` was absent from TOOL_REGISTRY
 * and nothing imported the loader or the runner. These cover the three seams
 * that connect it — write, catalog, dispatch — plus the mode and scope rules
 * a tool made of arbitrary Node has to obey.
 */

const tempRoot = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-dispatch-'))
vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  BrowserWindow: class {}
}))

const runAgentToolMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, result: { sum: 3 }, durationMs: 1 }))
)
vi.mock('@main/agent/agentTools/runner', () => ({
  runAgentTool: runAgentToolMock,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS: 30_000
}))

import { executeTool } from '@main/agent/tools'
import { agentBuiltToolDefinitions } from '@main/agent/agentTools/loader'
import { handler as buildTool } from '@main/agent/tools/buildTool'

const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-ws-'))

const ADDER = {
  name: 'adder',
  description: 'Adds two numbers',
  schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  code: 'export async function handler(args) {\n  return { sum: args.a + args.b }\n}\n'
}

function call(name: string, args: Record<string, unknown>, context = {}) {
  return executeTool(name, JSON.stringify(args), workspace, new AbortController().signal, context)
}

beforeEach(() => {
  rmSync(join(tempRoot, 'agent-tools'), { recursive: true, force: true })
  runAgentToolMock.mockClear()
})

afterEach(() => {
  rmSync(join(tempRoot, 'agent-tools'), { recursive: true, force: true })
})

describe('build_tool is reachable from a run', () => {
  it('writes a tool through executeTool, not just through its handler', async () => {
    const result = await call('build_tool', ADDER)

    expect(result.ok).toBe(true)
    expect(result.content).toContain('adder.mjs')
    expect(result.content).toContain('next step')
  })

  it("puts the written tool in the next step's catalog", async () => {
    expect(await agentBuiltToolDefinitions()).toEqual([])

    await call('build_tool', ADDER)

    // mtime-cached, so this is a directory sweep rather than a rescan — and a
    // tool written this step is callable on the next one with no restart.
    expect(await agentBuiltToolDefinitions()).toEqual([
      { name: 'adder', description: 'Adds two numbers', parameters: ADDER.schema }
    ])
  })

  it('finds a tool an EARLIER session wrote, without build_tool running first', async () => {
    // The read paths used to call the synchronous `agentToolsDir()`, which
    // answers with a tmpdir fallback until something resolves userData — and
    // only `build_tool` did. So on a fresh launch every tool written by a
    // previous session was invisible until the agent happened to write another.
    const dir = join(tempRoot, 'agent-tools')
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify(
      { name: 'leftover', description: 'From a previous session', inputSchema: { type: 'object' } },
      null,
      2
    )
    writeFileSync(
      join(dir, 'leftover.mjs'),
      `/* @agent-tool ${header} */\n\nexport async function handler() {\n  return { ok: true }\n}\n`,
      'utf8'
    )

    expect((await agentBuiltToolDefinitions()).map((d) => d.name)).toEqual(['leftover'])

    const result = await call('leftover', {})
    expect(result.ok).toBe(true)
    expect(runAgentToolMock).toHaveBeenCalledTimes(1)
  })

  it('dispatches a call to the written module and returns what it produced', async () => {
    await call('build_tool', ADDER)

    const result = await call('adder', { a: 1, b: 2 })

    expect(result.ok).toBe(true)
    expect(runAgentToolMock).toHaveBeenCalledTimes(1)
    const [def, args] = runAgentToolMock.mock.calls[0] as unknown as [
      { name: string; modulePath: string },
      Record<string, unknown>
    ]
    expect(def.name).toBe('adder')
    expect(def.modulePath).toContain('adder.mjs')
    expect(args).toEqual({ a: 1, b: 2 })
    expect(result.content).toContain('"sum": 3')
  })

  it('reports a module failure as a tool failure rather than a crash', async () => {
    await call('build_tool', ADDER)
    runAgentToolMock.mockResolvedValueOnce({
      ok: false,
      error: 'ReferenceError: fetch is not defined',
      durationMs: 2
    } as never)

    const result = await call('adder', { a: 1, b: 2 })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('ReferenceError')
  })

  it('reports a timeout instead of throwing out of the step', async () => {
    await call('build_tool', ADDER)
    runAgentToolMock.mockRejectedValueOnce(new Error('Agent tool "adder" timed out after 30000ms'))

    const result = await call('adder', { a: 1, b: 2 })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('timed out')
  })

  it('is Agent-mode only, like every other tool that can change the machine', async () => {
    await call('build_tool', ADDER)

    const asked = await call('adder', { a: 1, b: 2 }, { agentMode: 'ask' })

    expect(asked.ok).toBe(false)
    expect(asked.content).toContain('Agent mode')
    expect(runAgentToolMock).toHaveBeenCalledTimes(0)
  })

  it('still refuses a name nothing on disk claims', async () => {
    const result = await call('not-a-tool', {})
    expect(result.ok).toBe(false)
    expect(runAgentToolMock).not.toHaveBeenCalled()
  })
})
