import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentToolsFingerprint,
  loadAgentToolsSnapshot,
  scanAgentTools
} from '@main/agent/agentTools/loader'

const readFileCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readFileCalls.count += 1
      return actual.readFile(...args)
    },
  }
})

function toolFile(
  dir: string,
  name: string,
  header: Record<string, unknown>,
  body = 'export async function handler() { return null }\n'
): string {
  const p = join(dir, `${name}.mjs`)
  writeFileSync(p, `/* @agent-tool ${JSON.stringify(header)} */\n\n${body}`)
  return p
}

describe('scanAgentTools', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-loader-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses valid headers into defs sorted by name', async () => {
    toolFile(dir, 'zeta', {
      name: 'zeta-tool',
      description: 'Z last',
      inputSchema: { type: 'object' }
    })
    toolFile(dir, 'alpha', {
      name: 'alpha-tool',
      description: 'A first',
      inputSchema: { type: 'object', properties: {} }
    })

    const defs = await scanAgentTools(dir)
    expect(defs.map((d) => d.name)).toEqual(['alpha-tool', 'zeta-tool'])
    expect(defs[0]!.description).toBe('A first')
    expect(defs[0]!.modulePath).toBe(join(dir, 'alpha.mjs'))
    expect(defs[0]!.fingerprint).toContain(join(dir, 'alpha.mjs') + ':')
  })

  it('rejects invalid headers and bad names without crashing', async () => {
    toolFile(dir, 'noname', { description: 'missing name', inputSchema: {} })
    toolFile(dir, 'noschema', { name: 'no-schema', description: 'no inputSchema' })
    toolFile(dir, 'badname', { name: 'Has Space!', description: 'x', inputSchema: {} })
    toolFile(dir, 'longname', { name: 'a'.repeat(33), description: 'x', inputSchema: {} })
    writeFileSync(join(dir, 'broken.mjs'), '/* @agent-tool {not json} */\n')
    writeFileSync(join(dir, 'noheader.txt'), 'not even an mjs')

    const defs = await scanAgentTools(dir)
    expect(defs).toEqual([])
  })

  it('resolves duplicate names with later file winning, no crash', async () => {
    toolFile(dir, 'first', { name: 'dup-tool', description: 'first', inputSchema: {} })
    toolFile(dir, 'second', { name: 'dup-tool', description: 'second', inputSchema: {} })

    const defs = await scanAgentTools(dir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.description).toBe('second')
  })

  it('never executes or imports tool code at scan time', async () => {
    toolFile(dir, 'boobytrap', { name: 'trap', description: 'x', inputSchema: {} }, 'throw new Error("executed!")')
    mkdirSync(dir, { recursive: true })

    const defs = await scanAgentTools(dir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe('trap')
  })

  it('returns [] for a missing directory', async () => {
    expect(await scanAgentTools(join(dir, 'does-not-exist'))).toEqual([])
  })
})

describe('agentToolsFingerprint / loadAgentToolsSnapshot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-snap-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    // Module-level cache would leak between tests; re-point via a fresh scan.
  })

  it('fingerprint changes when a file is added or removed', async () => {
    const p = toolFile(dir, 'a', { name: 'tool-a', description: 'x', inputSchema: {} })
    const before = agentToolsFingerprint(await scanAgentTools(dir))

    const b = toolFile(dir, 'b', { name: 'tool-b', description: 'x', inputSchema: {} })
    const withTwo = agentToolsFingerprint(await scanAgentTools(dir))
    expect(withTwo).not.toBe(before)

    rmSync(b)
    expect(agentToolsFingerprint(await scanAgentTools(dir))).toBe(before)

    // Same set, touched mtime -> different fingerprint.
    rmSync(p)
    toolFile(dir, 'a', { name: 'tool-a', description: 'x', inputSchema: {} })
    expect(agentToolsFingerprint(await scanAgentTools(dir))).not.toBe(before)
  })

  it('snapshot caches defs and only rescans when mtimes change', async () => {
    // Pin mtimes to an exact ms value: Date->mtimeMs roundtrips exactly, so
    // restoring the same mtime must not register as a directory change.
    const fixed = new Date(1_700_000_000_000)
    const modulePath = join(dir, 'a.mjs')
    writeFileSync(modulePath, '/* @agent-tool {"name":"tool-a","description":"v1","inputSchema":{}} */\n')
    utimesSync(modulePath, fixed, fixed)

    const first = await loadAgentToolsSnapshot(dir)
    expect(first.map((d) => d.name)).toEqual(['tool-a'])

    // Rewrite content but restore the old mtime: snapshot must return cache.
    writeFileSync(modulePath, '/* @agent-tool {"name":"tool-a","description":"v2","inputSchema":{}} */\n')
    utimesSync(modulePath, fixed, fixed)
    expect((await loadAgentToolsSnapshot(dir))[0]!.description).toBe('v1')

    // Real mtime change -> rescan picks up the new content.
    const bumped = new Date(fixed.getTime() + 5000)
    utimesSync(modulePath, bumped, bumped)
    expect((await loadAgentToolsSnapshot(dir))[0]!.description).toBe('v2')

    // New file -> rescan.
    toolFile(dir, 'b', { name: 'tool-b', description: 'x', inputSchema: {} })
    expect((await loadAgentToolsSnapshot(dir)).map((d) => d.name)).toEqual(['tool-a', 'tool-b'])
  })

  it('does not rescan when a header-less .mjs sits in the dir', async () => {
    readFileCalls.count = 0
    const modulePath = toolFile(dir, 'valid', { name: 'tool-valid', description: 'v1', inputSchema: {} })
    writeFileSync(join(dir, 'invalid.mjs'), 'no header here\n')

    // (a) Valid tool loads; header-less file yields no def.
    const first = await loadAgentToolsSnapshot(dir)
    expect(first).toHaveLength(1)
    expect(first[0]!.name).toBe('tool-valid')
    const readsAfterFirst = readFileCalls.count
    expect(readsAfterFirst).toBeGreaterThan(0)

    // (b) Nothing changed -> cached defs served with ZERO extra readFile calls.
    // (Fails before the dirListing-keyed snapshot: invalid .mjs forced a rescan.)
    expect(await loadAgentToolsSnapshot(dir)).toHaveLength(1)
    expect(readFileCalls.count).toBe(readsAfterFirst)

    // (c) Real change to the valid tool (bumped mtime) is still picked up.
    writeFileSync(modulePath, '/* @agent-tool {"name":"tool-valid","description":"v2","inputSchema":{}} */\n')
    const bumped = new Date(Date.now() + 10_000)
    utimesSync(modulePath, bumped, bumped)
    const second = await loadAgentToolsSnapshot(dir)
    expect(second).toHaveLength(1)
    expect(second[0]!.description).toBe('v2')
    expect(readFileCalls.count).toBeGreaterThan(readsAfterFirst)
  })
})
