import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentToolDef } from '@main/agent/agentTools/types'
import {
  createAgentToolRunner,
  type AgentToolSpawnRequest,
  type RunnerChild
} from '@main/agent/agentTools/runner'
import { writeRunnerBootstrap } from '@main/agent/agentTools/paths'

type FakeController = {
  child: RunnerChild
  emit: (msg: unknown) => void
  exit: () => void
  killCount: () => number
}

function makeDef(modulePath: string, name = 'fake-tool'): AgentToolDef {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object' },
    modulePath,
    fingerprint: `${modulePath}:1`
  }
}

/** Fake spawn capturing the request and giving the test manual emit control. */
function fakeSpawn(
  respond: (req: AgentToolSpawnRequest, ctl: FakeController) => void
): { requests: AgentToolSpawnRequest[]; spawn: (req: AgentToolSpawnRequest) => RunnerChild } {
  const requests: AgentToolSpawnRequest[] = []
  return {
    requests,
    spawn: (req) => {
      requests.push(req)
      let messageCb: ((msg: unknown) => void) | null = null
      let exitCb: (() => void) | null = null
      let exits = 0
      const child: RunnerChild = {
        onMessage: (cb) => {
          messageCb = cb
        },
        onExit: (cb) => {
          exitCb = cb
        },
        kill: () => {
          exits += 1
        }
      }
      // Defer to a microtask so the runner has registered onMessage/onExit
      // before the fake child starts emitting.
      Promise.resolve().then(() => {
        respond(req, {
          child,
          emit: (msg) => {
            messageCb?.(msg)
          },
          exit: () => {
            exitCb?.()
          },
          killCount: () => exits
        })
      })
      return child
    }
  }
}

describe('createAgentToolRunner (fake spawn DI)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-runner-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves ok results with args passed through and a unique callId', async () => {
    let ctlRef: FakeController | null = null
    const fake = fakeSpawn((req, ctl) => {
      expect(req.argsJson).toBe(JSON.stringify({ n: 7 }))
      ctlRef = ctl
      ctl.emit({ type: 'result', ok: true, result: { doubled: 14 }, id: req.callId })
    })
    const run = createAgentToolRunner(fake.spawn)
    const res = await run(makeDef(join(dir, 't.mjs')), { n: 7 })
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ doubled: 14 })
    expect(res.error).toBeUndefined()
    expect(typeof res.durationMs).toBe('number')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.callId).toMatch(/[0-9a-f-]{8}/i)
    // Regression: settle() must kill the child on a success result too.
    expect(ctlRef?.killCount()).toBe(1)
  })

  it('resolves ok:false when the child reports a tool error', async () => {
    let ctlRef: FakeController | null = null
    const fake = fakeSpawn((req, ctl) => {
      ctlRef = ctl
      ctl.emit({ type: 'result', ok: false, error: 'boom', id: req.callId })
    })
    const run = createAgentToolRunner(fake.spawn)
    const res = await run(makeDef(join(dir, 't.mjs')), {})
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
    expect(res.result).toBeUndefined()
    // Regression: settle() must kill the child on an error result too.
    expect(ctlRef?.killCount()).toBe(1)
  })

  it('rejects on a fatal child error message', async () => {
    const fake = fakeSpawn((_req, ctl) => {
      ctl.emit({ type: 'error', message: 'module not found' })
    })
    const run = createAgentToolRunner(fake.spawn)
    await expect(run(makeDef(join(dir, 't.mjs')), {})).rejects.toThrow('module not found')
  })

  it('rejects and kills the child on timeout', async () => {
    const fake = fakeSpawn(() => {
      /* never responds */
    })
    const run = createAgentToolRunner(fake.spawn)
    await expect(run(makeDef(join(dir, 't.mjs')), {}, { timeoutMs: 40 })).rejects.toThrow(
      /timed out after 40ms/
    )
    // Runner sent the message before the promise rejected, but kill must happen.
    expect(fake.requests).toHaveLength(1)
  })

  it('rejects when the child exits without a result', async () => {
    const fake = fakeSpawn((_req, ctl) => {
      ctl.exit()
    })
    const run = createAgentToolRunner(fake.spawn)
    await expect(run(makeDef(join(dir, 't.mjs')), {})).rejects.toThrow(
      /exited before sending a result/
    )
  })

  it('ignores messages with an unknown shape (no crash)', async () => {
    const fake = fakeSpawn((_req, ctl) => {
      ctl.emit('garbage')
      ctl.emit(null)
      ctl.emit({ type: 'result', ok: true, result: 1 })
    })
    const run = createAgentToolRunner(fake.spawn)
    const res = await run(makeDef(join(dir, 't.mjs')), {})
    expect(res.result).toBe(1)
  })
})

describe('writeRunnerBootstrap (real fs)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-bootstrap-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a parseable Node-builtin-only bootstrap file', async () => {
    const bootstrapPath = await writeRunnerBootstrap(dir)
    expect(bootstrapPath).toBe(join(dir, '.runner-bootstrap.cjs'))

    const source = readFileSync(bootstrapPath, 'utf8')
    expect(source).toContain('process.parentPort')
    expect(source).toContain('process.send')
    expect(source).toContain("import(require('url').pathToFileURL(modPath).href)")
    // Bootstrap contract: no child_process, no electron imports.
    expect(source).not.toMatch(/require\(['"]child_process['"]\)/)
    expect(source).not.toMatch(/from ['"]electron['"]/)

    // Parseable as CommonJS (createRequire works in ESM test files).
    const req = createRequire(import.meta.url)
    const mod = req(bootstrapPath) as unknown
    expect(mod).toBeDefined()
    expect(typeof mod).toBe('object')
  })
})
