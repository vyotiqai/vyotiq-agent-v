import { describe, expect, it, vi } from 'vitest'
import {
  BWRAP_MISSING_REASON,
  detectSandboxCapability,
  windowsUnavailableReason,
  type SandboxCapabilityDeps
} from '@main/agent/sandbox/capability'

function deps(overrides: Partial<SandboxCapabilityDeps>): SandboxCapabilityDeps {
  return {
    platform: 'linux',
    exists: () => false,
    pathEnv: '/usr/local/bin:/usr/bin',
    probe: () => ({ ok: true, detail: '' }),
    prepareWindows: () => ({ ok: false, detail: 'not under test' }),
    ...overrides
  }
}

describe('detectSandboxCapability', () => {
  it('runs at low integrity on Windows once the low copies start there, without the POSIX probes', () => {
    const probe = vi.fn()
    const shells = { cmd: 'C:\\ud\\sandbox\\cmd-low.exe', powershell: 'C:\\ud\\sandbox\\powershell-low.exe' }
    const res = detectSandboxCapability(deps({ platform: 'win32', probe, prepareWindows: () => ({ ok: true, shells }) }))
    expect(res).toEqual({ available: true, mechanism: 'low-integrity', reason: null, executable: shells.cmd, shells })
    expect(probe).not.toHaveBeenCalled()
  })

  it('says why on Windows when the low copies cannot be made', () => {
    const res = detectSandboxCapability(
      deps({ platform: 'win32', prepareWindows: () => ({ ok: false, detail: 'icacls could not label cmd-low.exe' }) })
    )
    expect(res).toEqual({
      available: false,
      mechanism: null,
      reason: windowsUnavailableReason('icacls could not label cmd-low.exe'),
      executable: null
    })
    expect(res.reason).toBe('Commands cannot be confined at low integrity here: icacls could not label cmd-low.exe.')
  })

  it('uses sandbox-exec on macOS when it exists and starts', () => {
    const probe = vi.fn(() => ({ ok: true, detail: '' }))
    const res = detectSandboxCapability(
      deps({ platform: 'darwin', exists: (p) => p === '/usr/bin/sandbox-exec', probe })
    )
    expect(res).toEqual({ available: true, mechanism: 'seatbelt', reason: null, executable: '/usr/bin/sandbox-exec' })
    expect(probe).toHaveBeenCalledWith('seatbelt', '/usr/bin/sandbox-exec')
  })

  it('reports a missing or broken sandbox-exec', () => {
    expect(detectSandboxCapability(deps({ platform: 'darwin' })).reason).toMatch(/sandbox-exec is missing/)
    const broken = detectSandboxCapability(
      deps({
        platform: 'darwin',
        exists: () => true,
        probe: () => ({ ok: false, detail: 'sandbox_apply: Operation not permitted' })
      })
    )
    expect(broken.available).toBe(false)
    expect(broken.reason).toContain('sandbox_apply: Operation not permitted')
  })

  it('finds bwrap on PATH on Linux and probes it', () => {
    const probe = vi.fn(() => ({ ok: true, detail: '' }))
    const res = detectSandboxCapability(deps({ exists: (p) => p === '/usr/bin/bwrap', probe }))
    expect(res).toEqual({ available: true, mechanism: 'bubblewrap', reason: null, executable: '/usr/bin/bwrap' })
    expect(probe).toHaveBeenCalledWith('bubblewrap', '/usr/bin/bwrap')
  })

  it('says to install bubblewrap when bwrap is missing', () => {
    const res = detectSandboxCapability(deps({}))
    expect(res.available).toBe(false)
    expect(res.reason).toBe(BWRAP_MISSING_REASON)
    expect(res.reason).toMatch(/apt install bubblewrap/)
  })

  it('reports bwrap that cannot create a namespace', () => {
    const res = detectSandboxCapability(
      deps({
        exists: (p) => p === '/usr/bin/bwrap',
        probe: () => ({ ok: false, detail: 'bwrap: setting up uid map: Permission denied' })
      })
    )
    expect(res.available).toBe(false)
    expect(res.reason).toContain('setting up uid map')
    expect(res.reason).toMatch(/user namespaces/)
  })

  it('has no sandbox on other platforms', () => {
    expect(detectSandboxCapability(deps({ platform: 'freebsd' })).reason).toMatch(/freebsd/)
  })
})
