import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vyotiq-agent-profiles-'))

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  BrowserWindow: class {}
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import {
  clearAgentProfilesCacheForTests,
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  readWorkspaceProfileOverride,
  removeProfileOverridesForWorkspaces,
  resolveAgentProfile,
  updateAgentProfile
} from '@main/settings/agentProfiles'
import {
  assertSafeMemoryNamespace,
  memoryRoot,
  writeMemoryFile,
  readMemoryFile
} from '@main/agent/context/memory'

const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-ws-'))

beforeEach(() => {
  clearAgentProfilesCacheForTests()
  rmSync(join(tmpRoot, 'agents.json'), { force: true })
})

afterEach(() => {
  rmSync(join(workspace, '.vyotiq', 'agents'), { recursive: true, force: true })
})

function baseCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Scout', scope: 'global', ...overrides }
}

describe('agent profile roster store', () => {
  it('creates, lists, updates, and deletes profiles', () => {
    const created = createAgentProfile(baseCreate())
    expect(created.id).toBe('scout')
    expect(getAgentProfile(created.id)?.name).toBe('Scout')

    const updated = updateAgentProfile({
      id: created.id,
      patch: { persona: 'Terse senior engineer.' }
    })
    expect(updated.persona).toBe('Terse senior engineer.')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(listAgentProfiles()).toHaveLength(1)

    expect(deleteAgentProfile({ id: created.id })).toBe(true)
    expect(listAgentProfiles()).toHaveLength(0)
  })

  it('assigns unique ids when two teammates share a name', () => {
    const a = createAgentProfile(baseCreate())
    const b = createAgentProfile(baseCreate())
    expect(a.id).toBe('scout')
    expect(b.id).toBe('scout-2')
  })

  it('rejects workspace-scoped profiles without a workspacePath', () => {
    expect(() => createAgentProfile({ name: 'Bad', scope: 'workspace' })).toThrow()
  })

  it('round-trips the roster through agents.json', () => {
    const created = createAgentProfile(baseCreate({ persona: 'Keeper of docs.' }))
    // Cache reset: simulate a fresh process by reading the file-backed store.
    const onDisk = JSON.parse(readFileSync(join(tmpRoot, 'agents.json'), 'utf8')) as {
      profiles: Array<{ id: string; persona?: string }>
    }
    expect(onDisk.profiles[0]!.id).toBe(created.id)
    expect(onDisk.profiles[0]!.persona).toBe('Keeper of docs.')
  })

  it('moves a corrupt agents.json aside instead of letting the next write wipe it', () => {
    writeFileSync(join(tmpRoot, 'agents.json'), '{corrupt roster', 'utf8')
    expect(listAgentProfiles()).toHaveLength(0)
    // The unreadable roster is preserved for recovery, then the store works.
    const backups = readdirSync(tmpRoot).filter((name) => name.startsWith('agents.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(tmpRoot, backups[0]!), 'utf8')).toBe('{corrupt roster')
    const created = createAgentProfile(baseCreate())
    expect(listAgentProfiles().map((p) => p.id)).toEqual([created.id])
  })

  it('removes a deleted profile workspace override files so the slug cannot inherit them', () => {
    const created = createAgentProfile(baseCreate())
    const overrideDir = join(workspace, '.vyotiq', 'agents')
    mkdirSync(overrideDir, { recursive: true })
    const overridePath = join(overrideDir, `${created.id}.profile.json`)
    writeFileSync(overridePath, JSON.stringify({ persona: 'Dead identity persona.' }), 'utf8')

    removeProfileOverridesForWorkspaces(created.id, [workspace])
    expect(existsSync(overridePath)).toBe(false)
    // The override is gone; the global base is what resolves now.
    const resolved = resolveAgentProfile(workspace, created.id)
    expect(resolved?.id).toBe(created.id)
    expect(resolved?.persona).toBeUndefined()
  })
})

describe('workspace profile overrides', () => {
  it('merges per-workspace field overrides over the global profile', () => {
    const created = createAgentProfile(baseCreate({ persona: 'Global persona.' }))
    const overrideDir = join(workspace, '.vyotiq', 'agents')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(
      join(overrideDir, `${created.id}.profile.json`),
      JSON.stringify({ persona: 'Workspace persona.', tone: 'Terse.' }),
      'utf8'
    )

    const resolved = resolveAgentProfile(workspace, created.id)
    expect(resolved?.persona).toBe('Workspace persona.')
    expect(resolved?.tone).toBe('Terse.')
    expect(resolved?.name).toBe('Scout')

    // Another workspace sees the global profile untouched.
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-other-'))
    expect(resolveAgentProfile(other, created.id)?.persona).toBe('Global persona.')
    rmSync(other, { recursive: true, force: true })
  })

  it('never lets an override change identity fields', () => {
    const created = createAgentProfile(baseCreate())
    const overrideDir = join(workspace, '.vyotiq', 'agents')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(
      join(overrideDir, `${created.id}.profile.json`),
      JSON.stringify({ id: 'hijacked', name: 'Hijacked', createdAt: '2000-01-01' }),
      'utf8'
    )
    const resolved = resolveAgentProfile(workspace, created.id)
    expect(resolved?.id).toBe(created.id)
    expect(resolved?.name).toBe('Scout')
    expect(resolved?.createdAt).toBe(created.createdAt)
  })

  it('ignores malformed override files', () => {
    const created = createAgentProfile(baseCreate())
    const overrideDir = join(workspace, '.vyotiq', 'agents')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, `${created.id}.profile.json`), '{not json', 'utf8')
    expect(readWorkspaceProfileOverride(workspace, created.id)).toBeNull()
    expect(resolveAgentProfile(workspace, created.id)?.name).toBe('Scout')
  })
})

describe('profile memory namespaces', () => {
  it('routes memory writes into .vyotiq/agents/<id>/memory/', () => {
    const written = writeMemoryFile(workspace, 'state.md', '# Scout state', 'scout')
    expect(written).toBe('state.md')
    const root = join(workspace, '.vyotiq', 'agents', 'scout', 'memory')
    expect(readFileSync(join(root, 'state.md'), 'utf8')).toBe('# Scout state')
    // Shared memory stays untouched.
    expect(readMemoryFile(workspace, 'state.md')).toContain('not created yet')
  })

  it('keeps namespaces isolated from each other', () => {
    writeMemoryFile(workspace, 'state.md', 'alpha brain', 'alpha')
    writeMemoryFile(workspace, 'state.md', 'beta brain', 'beta')
    expect(readMemoryFile(workspace, 'state.md', 'alpha')).toBe('alpha brain')
    expect(readMemoryFile(workspace, 'state.md', 'beta')).toBe('beta brain')
  })

  it('rejects traversal namespaces and keeps the default root', () => {
    expect(() => writeMemoryFile(workspace, 'state.md', 'x', '../escape')).toThrow(
      'Invalid memory namespace'
    )
    expect(memoryRoot(workspace)).toBe(join(workspace, '.vyotiq', 'memory'))
    expect(memoryRoot(workspace, 'scout')).toBe(
      join(workspace, '.vyotiq', 'agents', 'scout', 'memory')
    )
    expect(assertSafeMemoryNamespace('a'.repeat(48))).toBe('a'.repeat(48))
    expect(() => assertSafeMemoryNamespace('a'.repeat(49))).toThrow()
  })

  it('blocks a symlinked .vyotiq ancestor even when the memory dir does not exist yet', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-link-ws-'))
    const junction = join(ws, '.vyotiq')
    try {
      // A junction (no admin rights needed on Windows) pointing OUTSIDE the
      // workspace must not let the first memory write escape through it.
      symlinkSync(tmpRoot, junction, 'junction')
      expect(() => writeMemoryFile(ws, 'state.md', 'escape attempt', 'scout')).toThrow(
        'Memory directory escapes workspace'
      )
      // Nothing was written through the link.
      expect(existsSync(join(tmpRoot, 'agents', 'scout', 'memory', 'state.md'))).toBe(false)
    } finally {
      rmSync(junction, { force: true, recursive: false })
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
