/**
 * Integration test for the agent-tool bootstrap protocol.
 *
 * Proves the real round-trip under vitest: build_tool writes a real .mjs →
 * the real .runner-bootstrap.cjs (written by writeRunnerBootstrap) is forked
 * with Node child_process → the handler result comes back over IPC through
 * the real runner (runAgentTool). The production spawn is Electron
 * utilityProcess.fork, which cannot run under vitest — child_process.fork
 * provides the same IPC semantics (process.send in the child) and exercises
 * the identical bootstrap script and protocol.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fork } from 'child_process'
import type { ChildProcess } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { RUNNER_BOOTSTRAP_FILENAME, setAgentToolsDirOverrideForTests } from '@main/agent/agentTools/paths'
import { scanAgentTools } from '@main/agent/agentTools/loader'
import { runAgentTool } from '@main/agent/agentTools/runner'
import type { AgentToolSpawn } from '@main/agent/agentTools/runner'
import { handler as buildToolHandler } from '@main/agent/tools/buildTool'

/** Node child_process fork of the real bootstrap; IPC is automatic for fork(). */
const liveChildren = new Set<ChildProcess>()

const forkSpawn: AgentToolSpawn = (req) => {
  const child = fork(req.bootstrapPath, [req.toolModulePath, req.argsJson, req.callId])
  liveChildren.add(child)
  child.on('exit', () => {
    liveChildren.delete(child)
  })
  return {
    onMessage: (cb) => {
      child.on('message', cb)
    },
    onExit: (cb) => {
      child.on('exit', () => {
        cb()
      })
    },
    kill: () => {
      child.kill()
    }
  }
}

const madeDirs: string[] = []

async function makeToolsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vyotiq-agent-tools-it-'))
  madeDirs.push(dir)
  setAgentToolsDirOverrideForTests(dir)
  return dir
}

afterEach(async () => {
  for (const child of liveChildren) child.kill()
  liveChildren.clear()
  setAgentToolsDirOverrideForTests(null)
  while (madeDirs.length) await rm(madeDirs.pop()!, { recursive: true, force: true })
})

describe('agent tool bootstrap round-trip (real Node fork)', () => {
  it('runs a real build_tool module through the real bootstrap script', async () => {
    const dir = await makeToolsDir()
    await buildToolHandler({
      name: 'double',
      description: 'Doubles a number',
      schema: { type: 'object', properties: { n: { type: 'number' } } },
      code: 'export async function handler(args) { return { doubled: args.n * 2 } }'
    })
    const defs = await scanAgentTools(dir)
    expect(defs.map((d) => d.name)).toEqual(['double'])
    const def = defs[0]
    expect(def).toBeDefined()
    if (!def) return

    const result = await runAgentTool(def, { n: 21 }, { spawn: forkSpawn })
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ doubled: 42 })

    const bootstrap = await readFile(join(dir, RUNNER_BOOTSTRAP_FILENAME), 'utf8')
    expect(bootstrap).toContain('process.parentPort')
  }, 20_000)

  it('reports a handler error back to the parent', async () => {
    const dir = await makeToolsDir()
    await buildToolHandler({
      name: 'boom',
      description: 'Always throws',
      schema: { type: 'object' },
      code: "export async function handler() { throw new Error('boom-42') }"
    })
    const defs = await scanAgentTools(dir)
    const def = defs[0]
    expect(def).toBeDefined()
    if (!def) return

    const result = await runAgentTool(def, {}, { spawn: forkSpawn })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom-42')
  }, 20_000)

  it('reports a missing handler export back to the parent', async () => {
    const dir = await makeToolsDir()
    const header =
      '{ "name": "nohandler", "description": "Missing handler", "inputSchema": { "type": "object" } }'
    await writeFile(join(dir, 'nohandler.mjs'), `/* @agent-tool ${header} */\nexport const notHandler = 1\n`, 'utf8')
    const defs = await scanAgentTools(dir)
    const def = defs[0]
    expect(def).toBeDefined()
    if (!def) return

    const result = await runAgentTool(def, {}, { spawn: forkSpawn })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('must export async function handler')
  }, 20_000)
})
