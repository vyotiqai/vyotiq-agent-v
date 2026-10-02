import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { toolTerminal } from '@main/agent/tools/terminal'
import { resetTerminalSessionsForTests, startBackgroundTerminal } from '@main/agent/tools/terminalSessions'
import { runSafeCommand } from '@main/agent/tools/diagnostics'
import type { SandboxLaunch } from '@main/agent/sandbox/wrap'
import { parseTerminalOutput } from '@shared/utils/terminalFormat'

/**
 * A stand-in sandbox: records what it was asked to wrap and runs a node
 * script in its place, so the test proves the spawn went through `wrap`
 * without needing sandbox-exec or bwrap on the machine running it.
 */
function fakeSandbox(script: string, network: 'allow' | 'deny' = 'allow') {
  const wrap = vi.fn((_bin: string, _args: string[]) => ({ bin: process.execPath, args: ['-e', script] }))
  const launch: SandboxLaunch = { label: `workspace-write via test, network ${network === 'deny' ? 'denied' : 'allowed'}`, network, wrap }
  return { launch, wrap }
}

const shell = process.platform === 'win32' ? 'cmd' : 'auto'
let dir = ''

afterEach(() => {
  resetTerminalSessionsForTests()
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows may hold the cwd briefly */
  }
  dir = ''
})

describe('toolTerminal sandbox wrapping', () => {
  it('spawns the shell directly and adds no sandbox line when no sandbox is passed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sbx-off-'))
    const out = await toolTerminal(dir, 'echo plain-run', new AbortController().signal, { shell })
    expect(out).toMatch(/plain-run/)
    expect(out).not.toMatch(/^sandbox:/m)
  }, 20_000)

  it('wraps the shell spawn and records the sandbox in the result', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sbx-on-'))
    const { launch, wrap } = fakeSandbox("process.stdout.write('ran-inside\\n')")
    const out = await toolTerminal(dir, 'echo never-runs-directly', new AbortController().signal, {
      shell,
      sandbox: launch
    })
    expect(wrap).toHaveBeenCalledTimes(1)
    const [bin, args] = wrap.mock.calls[0]!
    expect(bin).toBeTruthy()
    expect(args.join(' ')).toContain('echo never-runs-directly')
    expect(out).toMatch(/^sandbox: workspace-write via test, network allowed$/m)
    expect(out).toMatch(/ran-inside/)
    expect(out).not.toMatch(/\[sandbox\]/)
    // The header line is metadata, not stdout.
    const parsed = parseTerminalOutput(out)
    expect(parsed.stdout).toBe('ran-inside')
    expect(parsed.exitCode).toBe(0)
  }, 20_000)

  it('appends the sandbox hint when a sandboxed command fails with a denial', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sbx-deny-'))
    const { launch } = fakeSandbox(
      "process.stderr.write('touch: /etc/blocked: Operation not permitted\\n'); process.exit(1)"
    )
    const out = await toolTerminal(dir, 'touch /etc/blocked', new AbortController().signal, { shell, sandbox: launch })
    expect(out).toMatch(/exit_code: 1/)
    expect(out).toMatch(/\[sandbox\] The OS sandbox likely blocked a write outside the workspace/)
  }, 20_000)

  it('wraps background sessions and every frame names the sandbox', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sbx-bg-'))
    const { launch, wrap } = fakeSandbox("process.stdout.write('bg-inside\\n')", 'deny')
    const out = await startBackgroundTerminal({
      runId: 'run-sbx',
      invokeId: 1,
      workspaceRoot: dir,
      command: 'echo bg',
      signal: new AbortController().signal,
      shell,
      blockUntilMs: 10_000,
      sandbox: launch
    })
    expect(wrap).toHaveBeenCalledTimes(1)
    expect(out).toMatch(/bg-inside/)
    expect(out).toMatch(/^sandbox: workspace-write via test, network denied$/m)
  }, 20_000)
})

describe('runSafeCommand sandbox wrapping', () => {
  it('runs bin/argv through the sandbox only when one is passed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-sbx-safe-'))
    const { launch, wrap } = fakeSandbox("process.stdout.write('tests-inside')")
    const wrapped = await runSafeCommand('pnpm', ['run', 'test'], { cwd: dir, env: process.env, sandbox: launch })
    expect(wrap).toHaveBeenCalledWith('pnpm', ['run', 'test'])
    expect(wrapped.stdout).toBe('tests-inside')

    const plain = await runSafeCommand(process.execPath, ['-e', "process.stdout.write('direct')"], {
      cwd: dir,
      env: process.env
    })
    expect(plain.stdout).toBe('direct')
  }, 20_000)
})
