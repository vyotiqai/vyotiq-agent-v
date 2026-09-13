import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeWorkspacePath } from '@shared/workspacePath'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-ws-${process.pid}-${Date.now()}`)
const homeRoot = join(tmpdir(), `vyotiq-profile-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      if (name === 'home') return homeRoot
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => homeRoot
  }
})

import {
  addWorkspace,
  defaultWorkspacesState,
  enqueueWorkspaceMutation,
  getHomeWorkspacePath,
  interruptOrphanRunsForWorkspaces,
  isHomeWorkspacePath,
  readWorkspacesState,
  clearWorkspacesCacheForTests,
  removeWorkspace,
  resetWorkspacesForTests,
  saveWorkspacesState,
  setActiveWorkspace,
  setWorkspaceSettingsOverride,
  updateWorkspaceUiState
} from '@main/workspace/workspaces'
import { createRun } from '@main/agent/state'
import { resolveRunDir, workspaceSessionsRoot } from '@main/storage/paths'

describe('workspaces registry', () => {
  let workspaceA: string
  let workspaceB: string
  let homePath: string

  beforeEach(() => {
    workspaceA = join(tmpdir(), `vyotiq-wsa-${process.pid}-${Date.now()}`)
    workspaceB = join(tmpdir(), `vyotiq-wsb-${process.pid}-${Date.now()}`)
    mkdirSync(workspaceA, { recursive: true })
    mkdirSync(workspaceB, { recursive: true })
    mkdirSync(homeRoot, { recursive: true })
    resetWorkspacesForTests()
    homePath = getHomeWorkspacePath()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(homeRoot)) rmSync(homeRoot, { recursive: true, force: true })
    resetWorkspacesForTests()
  })

  it('writes workspaces.json atomically and opens app userData home on first read', () => {
    const state = readWorkspacesState()
    expect(state.version).toBe(2)
    expect(existsSync(join(userData, 'workspaces.json'))).toBe(true)
    expect(readFileSync(join(userData, 'workspaces.json'), 'utf8')).not.toContain('.tmp')
    expect(homePath).toBe(canonicalizeWorkspacePath(join(userData, 'home')))
    expect(state.openPaths).toEqual([homePath])
    expect(state.activePath).toBe(homePath)
    expect(existsSync(homePath)).toBe(true)
    expect(isHomeWorkspacePath(homePath)).toBe(true)
    expect(state.activePath).not.toBe(canonicalizeWorkspacePath(homeRoot))
  })

  it('migrates bare OS profile root to the app home workspace', () => {
    const profile = canonicalizeWorkspacePath(homeRoot)
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'workspaces.json'),
      JSON.stringify({
        ...defaultWorkspacesState(),
        openPaths: [profile],
        activePath: profile,
        recentPaths: [profile],
        uiStateByPath: {
          [profile]: {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            composerDraft: 'keep'
          }
        }
      }),
      'utf8'
    )

    const state = readWorkspacesState()
    expect(state.openPaths).toEqual([homePath])
    expect(state.activePath).toBe(homePath)
    expect(state.uiStateByPath[homePath]?.composerDraft).toBe('keep')
    expect(existsSync(homePath)).toBe(true)
  })

  it('migrates legacy ~/Vyotiq profile home to app userData home', () => {
    const legacy = canonicalizeWorkspacePath(join(homeRoot, 'Vyotiq'))
    mkdirSync(legacy, { recursive: true })
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'workspaces.json'),
      JSON.stringify({
        ...defaultWorkspacesState(),
        openPaths: [legacy],
        activePath: legacy,
        recentPaths: [legacy]
      }),
      'utf8'
    )

    const state = readWorkspacesState()
    expect(state.openPaths).toEqual([homePath])
    expect(state.activePath).toBe(homePath)
    expect(state.recentPaths[0]).toBe(homePath)
  })

  it('migrates legacy settings.workspacePath on first read', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        provider: 'ollama',
        model: 'qwen2.5',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        theme: 'system',
        workspacePath: workspaceA
      }),
      'utf8'
    )
    const state = readWorkspacesState()
    expect(state.openPaths).toContain(workspaceA)
    expect(state.activePath).toBe(workspaceA)
    expect(state.recentPaths[0]).toBe(workspaceA)
  })

  it('adds workspace paths and updates recents', async () => {
    // addWorkspace stores the canonicalized realpath: on macOS tmpdir sits
    // under the /var → /private/var symlink, so the stored form differs from
    // the raw mkdtemp path.
    const storedA = canonicalizeWorkspacePath(realpathSync(workspaceA))
    const storedB = canonicalizeWorkspacePath(realpathSync(workspaceB))
    const first = await addWorkspace(null, workspaceA)
    expect(first.openPaths).toContain(storedA)
    expect(first.activePath).toBe(storedA)
    expect(first.recentPaths[0]).toBe(storedA)
    expect(existsSync(workspaceSessionsRoot(storedA))).toBe(true)

    const second = await addWorkspace(null, workspaceB)
    expect(second.openPaths).toEqual(expect.arrayContaining([storedA, storedB]))
    expect(second.activePath).toBe(storedB)
    expect(second.recentPaths[0]).toBe(storedB)
  })

  it('removes from openPaths but keeps ui state for restore', () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA, workspaceB],
      activePath: workspaceB,
      uiStateByPath: {
        [workspaceA]: {
          activeRunId: 'run-a',
          openRunIds: ['run-a'],
          scrollTop: 12,
          composerDraft: 'draft'
        }
      }
    })
    const next = removeWorkspace(workspaceA)
    expect(next.openPaths).toEqual([workspaceB])
    expect(next.uiStateByPath[workspaceA]?.composerDraft).toBe('draft')
  })

  it('queues remove after UI update so stale openPaths cannot resurrect a closed workspace', async () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA, workspaceB],
      activePath: workspaceA,
      uiStateByPath: {
        [workspaceA]: {
          activeRunId: null,
          openRunIds: [],
          scrollTop: 0,
          composerDraft: ''
        }
      }
    })

    // Mimic flushPersistUiState → removeWorkspace IPC ordering through the shared queue.
    const uiWrite = enqueueWorkspaceMutation(() =>
      updateWorkspaceUiState(workspaceA, {
        activeRunId: 'run-a',
        openRunIds: ['run-a'],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: 'closing',
        agentMode: 'agent',
        writeGeneration: 1
      })
    )
    const removeWrite = enqueueWorkspaceMutation(() => removeWorkspace(workspaceA))
    await Promise.all([uiWrite, removeWrite])

    const next = readWorkspacesState()
    expect(next.openPaths).toEqual([workspaceB])
    expect(next.activePath).toBe(workspaceB)
    expect(next.uiStateByPath[workspaceA]?.composerDraft).toBe('closing')
  })

  it('reopens home when the last open workspace is closed', () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA],
      activePath: workspaceA
    })
    const next = removeWorkspace(workspaceA)
    expect(next.openPaths).toEqual([homePath])
    expect(next.activePath).toBe(homePath)
    expect(existsSync(homePath)).toBe(true)
  })

  it('prunes missing open workspace paths and falls back to home', () => {
    const ghost = join(tmpdir(), `vyotiq-ghost-${process.pid}-${Date.now()}`)
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [ghost],
      activePath: ghost,
      recentPaths: [ghost],
      uiStateByPath: {
        [ghost]: {
          activeRunId: null,
          openRunIds: [],
          scrollTop: 0,
          composerDraft: 'keep-draft'
        }
      }
    })
    clearWorkspacesCacheForTests()
    const next = readWorkspacesState()
    expect(next.openPaths).toEqual([homePath])
    expect(next.activePath).toBe(homePath)
    expect(next.recentPaths).toContain(ghost)
    expect(next.uiStateByPath[ghost]?.composerDraft).toBe('keep-draft')
  })

  it('sets active workspace and settings overrides', () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA, workspaceB],
      activePath: workspaceA
    })
    const active = setActiveWorkspace(workspaceB)
    expect(active.activePath).toBe(workspaceB)
    expect(active.recentPaths[0]).toBe(workspaceB)

    const withOverride = setWorkspaceSettingsOverride(workspaceB, {
      useOverride: true,
      provider: 'openai',
      model: 'gpt-4.1'
    })
    expect(withOverride.settingsOverridesByPath[workspaceB]).toEqual({
      useOverride: true,
      provider: 'openai',
      model: 'gpt-4.1'
    })
  })

  it('round-trips persona/tone/style fields in workspace settings overrides', () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA],
      activePath: workspaceA
    })
    const withStyle = setWorkspaceSettingsOverride(workspaceA, {
      useOverride: true,
      provider: 'openai',
      model: 'gpt-4.1',
      agentPersona: 'Nova',
      agentTone: 'friendly, blunt',
      responseLanguage: 'Spanish',
      responseVerbosity: 'detailed'
    })
    expect(withStyle.settingsOverridesByPath[workspaceA]).toMatchObject({
      useOverride: true,
      agentPersona: 'Nova',
      agentTone: 'friendly, blunt',
      responseLanguage: 'Spanish',
      responseVerbosity: 'detailed'
    })
    const reread = readWorkspacesState()
    expect(reread.settingsOverridesByPath[workspaceA]?.agentPersona).toBe('Nova')
    expect(reread.settingsOverridesByPath[workspaceA]?.agentTone).toBe('friendly, blunt')

    const cleared = setWorkspaceSettingsOverride(workspaceA, null)
    expect(cleared.settingsOverridesByPath[workspaceA]).toBeUndefined()
  })

  it('strips deprecated ollamaBaseUrl from workspace settings overrides on read', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'workspaces.json'),
      JSON.stringify({
        ...defaultWorkspacesState(),
        openPaths: [workspaceA],
        activePath: workspaceA,
        recentPaths: [workspaceA],
        settingsOverridesByPath: {
          [workspaceA]: {
            useOverride: true,
            provider: 'openai',
            model: 'gpt-4.1',
            ollamaBaseUrl: 'http://127.0.0.1:11434'
          }
        }
      }),
      'utf8'
    )

    const state = readWorkspacesState()
    const override = state.settingsOverridesByPath[workspaceA]
    expect(override).toEqual({
      useOverride: true,
      provider: 'openai',
      model: 'gpt-4.1'
    })
    expect(override).not.toHaveProperty('ollamaBaseUrl')
  })

  it('recovers partial workspaces.json and opens home when openPaths empty', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'workspaces.json'),
      JSON.stringify({
        version: 2,
        workspaceIdsByPath: {},
        legacySessionsMigrated: true,
        openPaths: 'invalid',
        activePath: workspaceA,
        recentPaths: [workspaceA],
        uiStateByPath: {
          [workspaceA]: {
            activeRunId: 'run-a',
            openRunIds: ['run-a'],
            scrollTop: 0,
            composerDraft: 'keep-me'
          }
        },
        settingsOverridesByPath: {}
      }),
      'utf8'
    )

    const state = readWorkspacesState()
    expect(state.openPaths).toEqual([homePath])
    expect(state.recentPaths[0]).toBe(homePath)
    expect(state.recentPaths).toContain(workspaceA)
    expect(state.activePath).toBe(homePath)
    expect(state.uiStateByPath[workspaceA]?.composerDraft).toBe('keep-me')
    expect(state.legacySessionsMigrated).toBe(true)
  })

  it('canonicalizes workspace path on add', async () => {
    const nested = join(workspaceA, 'nested', '..')
    const added = await addWorkspace(null, nested)
    const storedA = canonicalizeWorkspacePath(realpathSync(workspaceA))
    expect(added.openPaths).toContain(storedA)
    expect(added.activePath).toBe(storedA)
  })

  it('interruptOrphanRunsForWorkspaces scans open and recent paths', async () => {
    const runId = 'recent-orphan'
    createRun(workspaceB, runId, 'orphan')
    const runsDir = join(resolveRunDir(workspaceB, runId), 'status.json')
    writeFileSync(
      runsDir,
      JSON.stringify({
        status: 'running',
        step: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        goal: 'stuck'
      }),
      'utf8'
    )

    const state = saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA],
      activePath: workspaceA,
      recentPaths: [workspaceB]
    })

    const count = await interruptOrphanRunsForWorkspaces(state)
    expect(count).toBe(1)

    const status = JSON.parse(readFileSync(runsDir, 'utf8')) as { status: string }
    expect(status.status).toBe('cancelled')
  })

  it('retries legacy session migration when adding a workspace', async () => {
    const sessionsDir = join(userData, 'sessions', 'blocked-on-add')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, 'status.json'),
      JSON.stringify({
        status: 'done',
        updatedAt: '2026-01-01T00:00:00.000Z',
        goal: 'legacy'
      }),
      'utf8'
    )
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspaceA],
      activePath: workspaceA,
      legacySessionsMigrated: false,
      needsWorkspaceForMigration: true,
      pendingMigrationCount: 1
    })

    const next = await addWorkspace(null, workspaceA)
    expect(next.legacySessionsMigrated).toBe(true)
    expect(next.needsWorkspaceForMigration).toBe(false)
    expect(existsSync(resolveRunDir(workspaceA, 'blocked-on-add'))).toBe(true)
    expect(existsSync(sessionsDir)).toBe(false)
  })
})
