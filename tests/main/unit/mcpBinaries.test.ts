import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearLoginShellPathForTests,
  findMissingMcpBinary,
  isExecutableMcpBinary,
  mcpRequirementBinary,
  mcpRequirementInstallUrl,
  mcpSearchPath,
  missingMcpBinaryMessage,
  resolveMcpBinary
} from '@main/agent/mcp/binaries'

const isWindows = process.platform === 'win32'
let dir: string

/** Create a file that the resolver should accept as runnable. */
function makeBinary(name: string): string {
  const path = join(dir, name)
  writeFileSync(path, isWindows ? '@echo off\n' : '#!/bin/sh\n', 'utf8')
  if (!isWindows) chmodSync(path, 0o755)
  return path
}

function envWith(...dirs: string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(delimiter) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vyotiq-bin-'))
  clearLoginShellPathForTests()
})

afterEach(() => {
  clearLoginShellPathForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveMcpBinary', () => {
  it('finds a binary on the search path', () => {
    // Windows resolves through PATHEXT, so the on-disk name differs.
    const name = isWindows ? 'vyotiq-demo.cmd' : 'vyotiq-demo'
    makeBinary(name)
    const found = resolveMcpBinary('vyotiq-demo', envWith(dir))
    expect(found).toBeTruthy()
    expect(found).toContain('vyotiq-demo')
  })

  it('returns null when the binary is absent', () => {
    expect(resolveMcpBinary('vyotiq-definitely-missing', envWith(dir))).toBeNull()
  })

  it('ignores directories that merely share the name', () => {
    mkdirSync(join(dir, 'vyotiq-dir'))
    expect(resolveMcpBinary('vyotiq-dir', envWith(dir))).toBeNull()
  })

  it('checks an absolute command directly instead of searching', () => {
    const path = makeBinary(isWindows ? 'abs.cmd' : 'abs')
    expect(resolveMcpBinary(path, envWith())).toBe(path)
    expect(resolveMcpBinary(join(dir, 'nope'), envWith(dir))).toBeNull()
  })

  it.runIf(isWindows)('resolves a bare name through PATHEXT', () => {
    makeBinary('withext.cmd')
    // PATHEXT is conventionally uppercase (.CMD), and the filesystem is
    // case-insensitive, so only the extension itself is worth asserting.
    expect(resolveMcpBinary('withext', envWith(dir))?.toLowerCase()).toContain('withext.cmd')
  })

  it('resolves the real npx that ships with Node on this machine', () => {
    // Guards the cross-platform launcher lookup against the actual environment
    // rather than only synthetic fixtures.
    expect(resolveMcpBinary('npx')).toBeTruthy()
  })
})

describe('mcpSearchPath', () => {
  it('keeps the process PATH first and de-duplicates entries', () => {
    const path = mcpSearchPath(envWith(dir, dir))
    const entries = path.split(delimiter)
    expect(entries[0]).toBe(dir)
    expect(entries.filter((e) => e === dir)).toHaveLength(1)
  })

  it.runIf(!isWindows)('appends common install dirs a GUI PATH omits', () => {
    // The macOS Finder-launch failure: uv lands in ~/.local/bin, which is not
    // on the minimal PATH an app inherits from the Dock.
    expect(mcpSearchPath(envWith('/usr/bin'))).toContain('.local/bin')
  })
})

describe('findMissingMcpBinary', () => {
  it('names the declared requirement, not just the command', () => {
    const missing = findMissingMcpBinary(
      { command: 'uvx', requires: ['uv'], args: [] } as never,
      envWith(dir)
    )
    expect(missing).toMatchObject({ binary: 'uvx', requirement: 'uv' })
    expect(missing?.installUrl).toBe(mcpRequirementInstallUrl('uv'))
    expect(missingMcpBinaryMessage(missing!)).toContain('uvx (uv)')
  })

  it('passes when the requirement is installed', () => {
    makeBinary(isWindows ? 'uvx.cmd' : 'uvx')
    expect(findMissingMcpBinary({ command: 'uvx', requires: ['uv'] }, envWith(dir))).toBeNull()
  })

  it('accepts a user-located binary in place of a PATH lookup', () => {
    const located = makeBinary(isWindows ? 'uvx.cmd' : 'uvx')
    // PATH is empty on purpose: only binaryPath can satisfy this.
    expect(
      findMissingMcpBinary({ command: 'uvx', requires: ['uv'], binaryPath: located }, envWith())
    ).toBeNull()
  })

  it('does not let a located binary satisfy a different requirement', () => {
    const located = makeBinary(isWindows ? 'uvx.cmd' : 'uvx')
    const missing = findMissingMcpBinary(
      { command: 'npx', requires: ['node'], binaryPath: located },
      envWith(dir)
    )
    expect(missing).toMatchObject({ binary: 'npx', requirement: 'node' })
  })

  it('still checks the command when nothing is declared', () => {
    expect(findMissingMcpBinary({ command: 'vyotiq-missing' }, envWith(dir))).toMatchObject({
      binary: 'vyotiq-missing'
    })
    expect(findMissingMcpBinary({ command: 'vyotiq-missing' }, envWith(dir))?.requirement)
      .toBeUndefined()
  })

  it('has nothing to check for a remote server', () => {
    expect(findMissingMcpBinary({}, envWith(dir))).toBeNull()
  })

  it('validates what the Locate binary picker returns', () => {
    // The picker writes straight into `binaryPath`, so a directory or a stray
    // document must be rejected in main rather than persisted and failing at
    // spawn time with the same unhelpful message the user was trying to fix.
    const exe = makeBinary(isWindows ? 'picked.cmd' : 'picked')
    expect(isExecutableMcpBinary(exe)).toBe(true)
    expect(isExecutableMcpBinary(` ${exe} `)).toBe(true)

    mkdirSync(join(dir, 'a-folder'))
    expect(isExecutableMcpBinary(join(dir, 'a-folder'))).toBe(false)
    expect(isExecutableMcpBinary(join(dir, 'does-not-exist'))).toBe(false)
    expect(isExecutableMcpBinary('')).toBe(false)
  })

  it('maps every requirement to a binary and an install page', () => {
    for (const req of ['node', 'uv', 'git'] as const) {
      expect(mcpRequirementBinary(req)).toBeTruthy()
      expect(mcpRequirementInstallUrl(req)).toMatch(/^https:\/\//)
    }
  })
})
