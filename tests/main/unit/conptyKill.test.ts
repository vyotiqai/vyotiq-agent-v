import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'

const log = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@shared/logger', () => ({
  logger: { ...log, info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { installForklessConptyKill } from '@main/app/conptyKill'

const requireCjs = createRequire(import.meta.url)

type AgentLike = Record<string, unknown>

/** node-pty's real Windows agent prototype; loads on every platform (natives are lazy). */
function realAgentPrototype(): AgentLike & { kill: (this: AgentLike) => void } {
  const mod = requireCjs('node-pty/lib/windowsPtyAgent') as {
    WindowsPtyAgent: { prototype: AgentLike & { kill: (this: AgentLike) => void } }
  }
  return mod.WindowsPtyAgent.prototype
}

afterEach(() => {
  vi.restoreAllMocks()
  log.warn.mockClear()
})

describe('installForklessConptyKill', () => {
  it('does nothing off Windows', () => {
    const proto: AgentLike = { _getConsoleProcessList: () => Promise.resolve([1]) }
    expect(installForklessConptyKill(proto, 'darwin')).toBe(false)
  })

  it('warns when node-pty no longer has the helper', () => {
    expect(installForklessConptyKill({}, 'win32')).toBe(false)
    expect(log.warn).toHaveBeenCalled()
  })

  it("makes node-pty's own ConPTY kill() finish without forking", async () => {
    // A stand-in agent on the real prototype: kill() is node-pty's code, the
    // helper is replaced on this object only, so other suites keep the original.
    const proto = realAgentPrototype()
    expect(typeof proto._getConsoleProcessList).toBe('function')
    const agent = Object.create(proto) as AgentLike
    agent._getConsoleProcessList = proto._getConsoleProcessList
    expect(installForklessConptyKill(agent, 'win32')).toBe(true)
    expect(installForklessConptyKill(agent, 'win32')).toBe(true)

    const childProcess = requireCjs('child_process') as typeof import('child_process')
    const fork = vi.spyOn(childProcess, 'fork').mockImplementation(() => {
      throw new Error('child_process.fork() is not supported when the runAsNode fuse is disabled')
    })
    const nativeKill = vi.fn()
    const dispose = vi.fn()
    Object.assign(agent, {
      _useConpty: true,
      _useConptyDll: false,
      _innerPid: 4242,
      _pty: 7,
      _inSocket: {},
      _outSocket: {},
      _ptyNative: { kill: nativeKill },
      _conoutSocketWorker: { dispose }
    })
    const killProcess = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      proto.kill.call(agent)
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(fork).not.toHaveBeenCalled()
    expect(rejections).toEqual([])
    expect(nativeKill).toHaveBeenCalledWith(7, false)
    expect(dispose).toHaveBeenCalled()
    // The empty list: node-pty kills nothing itself; killPty tree-kills the shell.
    expect(killProcess).not.toHaveBeenCalled()
  })
})
