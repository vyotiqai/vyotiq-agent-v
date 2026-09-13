import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  globalTsserverSdkPath,
  tsserverInitOptionsFromPaths,
  workspaceTsserverSdkPath
} from '@main/workspace/lspService'

describe('tsserver SDK resolution for TS7 workspaces', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  function seedTsserverLib(root: string): string {
    const lib = join(root, 'node_modules', 'typescript', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'tsserver.js'), '// tsserver stub', 'utf8')
    return join(lib, 'tsserver.js')
  }

  it('returns no initializationOptions when the workspace SDK has tsserver.js', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-ws-'))
    const ws = seedTsserverLib(dir)
    expect(tsserverInitOptionsFromPaths(ws, null)).toBeUndefined()
    expect(tsserverInitOptionsFromPaths(ws, 'C:/elsewhere/tsserver.js')).toBeUndefined()
  })

  it('points initializationOptions.tsserver.path at the global SDK when the workspace lacks tsserver.js', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-global-'))
    const global = seedTsserverLib(dir)
    const opts = tsserverInitOptionsFromPaths(null, global)
    expect(opts).toEqual({ tsserver: { path: global } })
  })

  it('returns no initializationOptions when neither SDK exists (keep current behavior)', () => {
    expect(tsserverInitOptionsFromPaths(null, null)).toBeUndefined()
  })

  it('workspaceTsserverSdkPath finds node_modules/typescript/lib/tsserver.js', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-probe-ws-'))
    expect(workspaceTsserverSdkPath(dir)).toBeNull()
    const ws = seedTsserverLib(dir)
    expect(workspaceTsserverSdkPath(dir)).toBe(ws)
  })

  it('globalTsserverSdkPath probes next to the tls executable, then the npm appdata root', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-probe-global-'))
    const fakeTls = join(dir, 'npm', 'typescript-language-server.CMD')
    const fakeAppdataRoot = join(dir, 'appdata')
    mkdirSync(join(dir, 'npm'), { recursive: true })
    // Neither candidate exists.
    expect(globalTsserverSdkPath(fakeTls, fakeAppdataRoot)).toBeNull()
    // Sibling node_modules tree (global npm layout) wins first.
    const seeded = seedTsserverLib(join(dir, 'npm'))
    expect(globalTsserverSdkPath(fakeTls, fakeAppdataRoot)).toBe(seeded)
    // Falls back to <appdata>/npm/node_modules/typescript/lib when no sibling SDK exists.
    rmSync(join(dir, 'npm', 'node_modules'), { recursive: true, force: true })
    const appdataSeed = seedTsserverLib(join(fakeAppdataRoot, 'npm'))
    expect(globalTsserverSdkPath(fakeTls, fakeAppdataRoot)).toBe(appdataSeed)
  })
})
