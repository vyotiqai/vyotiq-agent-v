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
  listWorkspaceProfileOverrides,
  writeWorkspaceProfileOverride,
  removeProfileArtifactsForWorkspaces,
  listRetiredAgentProfileIds,
  resolveAgentProfile,
  updateAgentProfile
} from '@main/settings/agentProfiles'
import {
  assertSafeMemoryNamespace,
  memoryRoot,
  writeMemoryFile,
  readMemoryFile
} from '@main/agent/context/memory'
import { AgentProfileOverrideSetRequestSchema } from '@shared/ipc'

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

  it('resolves workspace profiles only in their owning workspace', () => {
    const created = createAgentProfile(
      baseCreate({ scope: 'workspace', workspacePath: workspace })
    )
    expect(resolveAgentProfile(workspace, created.id)?.id).toBe(created.id)
    expect(resolveAgentProfile(undefined, created.id)).toBeNull()
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-scope-other-'))
    expect(resolveAgentProfile(other, created.id)).toBeNull()
    rmSync(other, { recursive: true, force: true })
    expect(listAgentProfiles().map((profile) => profile.id)).toContain(created.id)
  })

  it('rejects future agents.json versions without moving or overwriting the file', () => {
    const path = join(tmpRoot, 'agents.json')
    const future = JSON.stringify({ version: 3, profiles: [] })
    writeFileSync(path, future, 'utf8')
    expect(() => listAgentProfiles()).toThrow('Unsupported agents.json version: 3')
    expect(readFileSync(path, 'utf8')).toBe(future)
    expect(readdirSync(tmpRoot).filter((name) => name.startsWith('agents.json.corrupt-'))).toHaveLength(0)
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

    removeProfileArtifactsForWorkspaces(created.id, [workspace])
    expect(existsSync(overridePath)).toBe(false)
    // The override is gone; the global base is what resolves now.
    const resolved = resolveAgentProfile(workspace, created.id)
    expect(resolved?.id).toBe(created.id)
    expect(resolved?.persona).toBeUndefined()
  })

  it('preserves the deleted profile memory namespace by default', () => {
    const created = createAgentProfile(baseCreate())
    writeMemoryFile(workspace, 'state.md', 'dead identity notes', created.id)
    writeMemoryFile(workspace, 'state.md', 'other teammate notes', 'bystander')

    removeProfileArtifactsForWorkspaces(created.id, [workspace])

    // Deleting a teammate ends its work; it does not erase what it wrote.
    // Historical runs still resolve the namespace keyed by this id.
    expect(readFileSync(join(memoryRoot(workspace, created.id), 'state.md'), 'utf8')).toBe(
      'dead identity notes'
    )
    expect(readFileSync(join(memoryRoot(workspace, 'bystander'), 'state.md'), 'utf8')).toBe(
      'other teammate notes'
    )
  })

  it('purges the memory namespace only when asked, and not its siblings', () => {
    const created = createAgentProfile(baseCreate())
    writeMemoryFile(workspace, 'state.md', 'dead identity notes', created.id)
    writeMemoryFile(workspace, 'state.md', 'other teammate notes', 'bystander')

    removeProfileArtifactsForWorkspaces(created.id, [workspace], { purgeMemory: true })

    expect(existsSync(memoryRoot(workspace, created.id))).toBe(false)
    // The delete is scoped to one namespace dir, not the agents/ tree above it.
    expect(readFileSync(join(memoryRoot(workspace, 'bystander'), 'state.md'), 'utf8')).toBe(
      'other teammate notes'
    )
  })

  it('retires a deleted id so a recreated teammate cannot inherit it', () => {
    const first = createAgentProfile(baseCreate())
    writeMemoryFile(workspace, 'state.md', 'dead identity notes', first.id)

    deleteAgentProfile({ id: first.id })
    removeProfileArtifactsForWorkspaces(first.id, [workspace])

    // The dead identity's notes survive, so its slug must never be handed out
    // again — the recreated teammate gets a fresh id and an empty namespace.
    const second = createAgentProfile(baseCreate())
    expect(second.id).not.toBe(first.id)
    expect(listRetiredAgentProfileIds()).toContain(first.id)
    expect(existsSync(memoryRoot(workspace, second.id))).toBe(false)
    expect(readFileSync(join(memoryRoot(workspace, first.id), 'state.md'), 'utf8')).toBe(
      'dead identity notes'
    )
  })

  it('migrates a version 1 roster forward without a retired-id ledger', () => {
    const path = join(tmpRoot, 'agents.json')
    const now = new Date().toISOString()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        profiles: [
          { id: 'legacy', name: 'Legacy', scope: 'global', createdAt: now, updatedAt: now }
        ]
      }),
      'utf8'
    )
    expect(listAgentProfiles().map((p) => p.id)).toEqual(['legacy'])
    expect(listRetiredAgentProfileIds()).toEqual([])
    // The first mutation rewrites the file at the current version.
    createAgentProfile(baseCreate({ name: 'Fresh' }))
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { version: number }
    expect(onDisk.version).toBe(2)
  })

  it('refuses to remove artifacts for an id that is not a safe path segment', () => {
    const sentinel = join(workspace, '.vyotiq', 'agents')
    mkdirSync(sentinel, { recursive: true })
    removeProfileArtifactsForWorkspaces('../..', [workspace])
    expect(existsSync(sentinel)).toBe(true)
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

describe('writing workspace profile overrides', () => {
  it('writes an override the resolver then applies', () => {
    const created = createAgentProfile(baseCreate({ persona: 'Global persona.' }))
    const written = writeWorkspaceProfileOverride(workspace, created.id, {
      persona: 'Workspace persona.'
    })

    expect(written).toEqual({ persona: 'Workspace persona.' })
    expect(resolveAgentProfile(workspace, created.id)?.persona).toBe('Workspace persona.')
    expect(getAgentProfile(created.id)?.persona).toBe('Global persona.')
  })

  it('replaces the override instead of merging into it', () => {
    // One form owns the whole override. A merge would make clearing a single
    // field impossible, because the cleared key would simply be absent from
    // the patch and the old value would survive.
    const created = createAgentProfile(baseCreate())
    writeWorkspaceProfileOverride(workspace, created.id, {
      persona: 'Workspace persona.',
      tone: 'Terse.'
    })
    writeWorkspaceProfileOverride(workspace, created.id, { persona: 'Workspace persona.' })

    expect(readWorkspaceProfileOverride(workspace, created.id)).toEqual({
      persona: 'Workspace persona.'
    })
  })

  it('clears the file on null without erasing the memory namespace', () => {
    // Resetting behaviour ends an override; it does not erase the notes the
    // teammate wrote. Those live in a sibling directory under the same parent.
    const created = createAgentProfile(baseCreate())
    writeMemoryFile(workspace, 'state.md', '# Scout state', created.id)
    writeWorkspaceProfileOverride(workspace, created.id, { tone: 'Terse.' })
    const path = join(workspace, '.vyotiq', 'agents', `${created.id}.profile.json`)
    expect(existsSync(path)).toBe(true)

    expect(writeWorkspaceProfileOverride(workspace, created.id, null)).toBeNull()

    expect(existsSync(path)).toBe(false)
    expect(existsSync(memoryRoot(workspace, created.id))).toBe(true)
    expect(readMemoryFile(workspace, 'state.md', created.id)).toContain('# Scout state')
    expect(resolveAgentProfile(workspace, created.id)?.tone).toBeUndefined()
  })

  it('treats an override with no fields as a clear', () => {
    const created = createAgentProfile(baseCreate())
    writeWorkspaceProfileOverride(workspace, created.id, { tone: 'Terse.' })
    expect(writeWorkspaceProfileOverride(workspace, created.id, {})).toBeNull()
    expect(readWorkspaceProfileOverride(workspace, created.id)).toBeNull()
  })

  it('creates the agents directory when the workspace has none', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-fresh-'))
    const created = createAgentProfile(baseCreate())
    writeWorkspaceProfileOverride(fresh, created.id, { tone: 'Terse.' })
    expect(readWorkspaceProfileOverride(fresh, created.id)).toEqual({ tone: 'Terse.' })
    rmSync(fresh, { recursive: true, force: true })
  })

  it('leaves no temp file beside the override it wrote', () => {
    // The write is temp+rename. A crash-shaped leftover would be picked up by
    // the directory scan as a profile named "<id>.profile.json.tmp".
    const created = createAgentProfile(baseCreate())
    writeWorkspaceProfileOverride(workspace, created.id, { tone: 'Terse.' })
    const entries = readdirSync(join(workspace, '.vyotiq', 'agents'))
    expect(entries).toEqual([`${created.id}.profile.json`])
  })

  it('refuses an unsafe profile id instead of writing through it', () => {
    expect(() => writeWorkspaceProfileOverride(workspace, '../../escape', { tone: 'x' })).toThrow()
    expect(existsSync(join(workspace, '..', 'escape.profile.json'))).toBe(false)
  })

  it('lists every override in a workspace, keyed by profile id', () => {
    const a = createAgentProfile(baseCreate({ name: 'Scout' }))
    const b = createAgentProfile(baseCreate({ name: 'Ace' }))
    writeWorkspaceProfileOverride(workspace, a.id, { tone: 'Terse.' })
    writeWorkspaceProfileOverride(workspace, b.id, { persona: 'Careful.' })

    expect(listWorkspaceProfileOverrides(workspace)).toEqual({
      [a.id]: { tone: 'Terse.' },
      [b.id]: { persona: 'Careful.' }
    })
  })

  it('skips files in the agents directory that are not overrides', () => {
    // The directory also holds each teammate's memory namespace, and a git
    // checkout can drop anything else in beside it.
    const created = createAgentProfile(baseCreate())
    writeWorkspaceProfileOverride(workspace, created.id, { tone: 'Terse.' })
    const dir = join(workspace, '.vyotiq', 'agents')
    writeFileSync(join(dir, 'README.md'), 'notes', 'utf8')
    writeFileSync(join(dir, '.profile.json'), '{}', 'utf8')
    mkdirSync(join(dir, created.id), { recursive: true })

    expect(Object.keys(listWorkspaceProfileOverrides(workspace))).toEqual([created.id])
  })

  it('returns no overrides for a workspace that has never had one', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'vyotiq-profiles-empty-'))
    expect(listWorkspaceProfileOverrides(fresh)).toEqual({})
    rmSync(fresh, { recursive: true, force: true })
  })

  it('rejects a request that tries to override an identity field', () => {
    // The reader strips these silently because it parses hand-authored files.
    // The write request is strict: a payload this app built carrying `name` is
    // our own bug, and stripping it would hide that.
    const parsed = AgentProfileOverrideSetRequestSchema.safeParse({
      workspacePath: workspace,
      profileId: 'scout',
      override: { name: 'Hijacked', tone: 'Terse.' }
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a request carrying only overridable fields', () => {
    const parsed = AgentProfileOverrideSetRequestSchema.safeParse({
      workspacePath: workspace,
      profileId: 'scout',
      override: { tone: 'Terse.', autoResumeOnLaunch: true }
    })
    expect(parsed.success).toBe(true)
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
