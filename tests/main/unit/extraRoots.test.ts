import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-extraroots-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/agent/codeindex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex')>()
  return {
    ...actual,
    queryIndexCandidates: async () => null,
    queryIndexFileList: async () => null,
    resolveCandidateFullPaths: () => []
  }
})

import {
  extraRootsForCommand,
  formatExtraRootsSection,
  resolveInsideRoots,
  routeExtraRoot,
  routeExtraRootToolCall,
  validateExtraRoots
} from '@main/agent/extraRoots'
import { extraRootFor, extraRootLabel, isPathInsideRoot, relativeToExtraRoot } from '@shared/extraRoots'
import { createPermissionPolicy } from '@main/agent/permissions'
import type { ToolApprovalGate } from '@main/agent/toolApproval'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import { taskFileStats, taskFileDiff } from '@main/agent/taskFileDiff'
import { executeTool } from '@main/agent/tools'
import { prepareAgentSandbox } from '@main/agent/sandbox'
import type { SandboxFs } from '@main/agent/sandbox/policy'
import { createRun, loadStatus, listRuns, updateStatus } from '@main/agent/state'
import { updateRunExtraRoots } from '@main/agent/runExtraRootsEdit'
import { clearRunAbort, registerRunAbort } from '@main/agent/runRegistry'
import { finishWatches, setGitSnapshotEnabledForTests, startWatches } from '@main/agent/workspaceMutationWatch'
import { recordTerminalCommandPriors } from '@main/agent/tools/terminalCheckpoint'
import { execFileSync } from 'child_process'
import { forkRun } from '@main/agent/forkRun'
import { resolveRunDir } from '@main/storage/paths'
import { NestedInstructions } from '@main/agent/context/nestedInstructions'

let base: string
let workspace: string
let backend: string
let elsewhere: string

beforeEach(() => {
  base = realpathSync(tmpdir())
  base = join(base, `vyotiq-extraroots-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = join(base, 'frontend')
  backend = join(base, 'backend')
  elsewhere = join(base, 'elsewhere')
  for (const dir of [workspace, join(backend, 'src'), elsewhere, join(userData, 'sessions')]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(workspace, 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(backend, 'src', 'api.ts'), 'export const api = 1\n')
  writeFileSync(join(elsewhere, 'secret.txt'), 'nope\n')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(base, { recursive: true, force: true })
  if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
})

describe('validateExtraRoots', () => {
  it('keeps existing absolute folders as real paths and refuses the rest with a reason', () => {
    const { roots, refused } = validateExtraRoots(
      workspace,
      [backend, 'relative/dir', join(base, 'missing'), join(workspace, 'sub'), join(backend, 'src'), join(backend, 'src', 'api.ts')],
      { userDataDir: userData }
    )
    expect(roots).toEqual([realpathSync(backend)])
    const reasons = Object.fromEntries(refused.map((r) => [r.path, r.reason]))
    expect(reasons['relative/dir']).toBe('not an absolute path')
    expect(reasons[join(base, 'missing')]).toBe('does not exist')
    expect(reasons[join(backend, 'src')]).toMatch(/^overlaps backend/)
    expect(reasons[join(backend, 'src', 'api.ts')]).toBe('not a folder')
  })

  it('refuses the workspace itself, a whole drive, and the app data folder unless it is a worktree', () => {
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    const wt = join(userData, 'task-worktrees', 'abc', 'wt1')
    mkdirSync(wt, { recursive: true })
    mkdirSync(join(userData, 'workspaces'), { recursive: true })
    const { roots, refused } = validateExtraRoots(
      workspace,
      [join(workspace, 'sub'), join(userData, 'workspaces'), wt, userData.slice(0, userData.indexOf(':') + 2) || '/'],
      { userDataDir: userData }
    )
    expect(roots).toEqual([realpathSync(wt)])
    const reasons = refused.map((r) => r.reason)
    expect(reasons).toContain('already part of the workspace')
    expect(reasons).toContain("in the app's data folder")
    expect(reasons.some((r) => r === 'a whole drive is too broad to add' || r === "holds the app's data folder")).toBe(true)
  })

  it('caps the number of folders at five, refusing (not dropping) the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => {
      const dir = join(base, `extra-${i}`)
      mkdirSync(dir)
      return dir
    })
    const { roots, refused } = validateExtraRoots(workspace, many, { userDataDir: userData })
    expect(roots).toHaveLength(5)
    expect(refused).toEqual([{ path: many[5], reason: 'at most 5 folders' }])
  })
})

describe('path resolution across roots', () => {
  it('resolves relative paths against the workspace and absolute ones in an added folder', () => {
    const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
    expect(resolveInsideRoots(workspace, roots, 'app.ts')).toBe(join(realpathSync(workspace), 'app.ts'))
    expect(resolveInsideRoots(workspace, roots, join(backend, 'src', 'api.ts'))).toBe(
      join(realpathSync(backend), 'src', 'api.ts')
    )
    // A relative path never means the added folder.
    expect(resolveInsideRoots(workspace, roots, 'src/api.ts')).toBe(join(realpathSync(workspace), 'src', 'api.ts'))
  })

  it('refuses absolute paths outside every root, and relative escapes', () => {
    const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
    expect(() => resolveInsideRoots(workspace, roots, join(elsewhere, 'secret.txt'))).toThrow(/escapes workspace/)
    expect(() => resolveInsideRoots(workspace, roots, '../backend/src/api.ts')).toThrow(/escapes workspace/)
    expect(() => resolveInsideRoots(workspace, [], join(backend, 'src', 'api.ts'))).toThrow(/escapes workspace/)
  })

  it('refuses a symlink in an added folder that points outside it', () => {
    const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
    const link = join(backend, 'escape')
    try {
      symlinkSync(elsewhere, link, 'junction')
    } catch {
      return // no symlink rights here; the containment check is covered above
    }
    expect(() => resolveInsideRoots(workspace, roots, join(link, 'secret.txt'))).toThrow(/escapes workspace/)
  })

  it('matches Windows paths case-insensitively and by either slash', () => {
    expect(isPathInsideRoot('c:/work/Backend/src/a.ts', 'C:\\Work\\backend')).toBe(true)
    expect(extraRootFor('C:/WORK/BACKEND/x', ['C:\\Work\\backend'])).toBe('C:\\Work\\backend')
    expect(isPathInsideRoot('C:\\Work\\backend2\\a', 'C:\\Work\\backend')).toBe(false)
    // POSIX stays case-sensitive.
    expect(isPathInsideRoot('/Work/backend/a', '/work/backend')).toBe(false)
    expect(relativeToExtraRoot('C:/Work/backend/src/a.ts', 'C:\\Work\\backend')).toBe('src/a.ts')
    expect(extraRootLabel('C:\\Work\\backend\\')).toBe('backend')
    if (process.platform === 'win32') {
      const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
      const upper = join(backend, 'src', 'api.ts').toUpperCase()
      expect(routeExtraRoot(workspace, roots, upper)).toBe(roots[0])
      expect(readFileSync(resolveInsideRoots(workspace, roots, upper), 'utf8')).toContain('api')
    }
  })

  it('routes glob, grep and list_dir into the added folder by its absolute prefix', () => {
    const roots = [backend]
    const slash = backend.replace(/\\/g, '/')
    expect(routeExtraRootToolCall('glob', { pattern: `${slash}/src/**/*.ts` }, workspace, roots)).toEqual({
      root: backend,
      args: { pattern: 'src/**/*.ts' }
    })
    expect(routeExtraRootToolCall('grep', { pattern: 'api', include: `${slash}/**` }, workspace, roots)).toEqual({
      root: backend,
      args: { pattern: 'api', include: '**' }
    })
    expect(routeExtraRootToolCall('list_dir', { path: backend }, workspace, roots)).toEqual({
      root: backend,
      args: { path: '.' }
    })
    expect(routeExtraRootToolCall('read', { path: 'app.ts' }, workspace, roots)).toBeNull()
    expect(routeExtraRootToolCall('glob', { pattern: '**/*.ts' }, workspace, roots)).toBeNull()
    expect(routeExtraRootToolCall('search', { query: backend }, workspace, roots)).toBeNull()
  })

  it('tells the model about the folders in one per-task section', () => {
    expect(formatExtraRootsSection([])).toBe('')
    const section = formatExtraRootsSection([backend])
    expect(section).toContain('<added_folders>')
    expect(section).toContain(backend)
    expect(section).toMatch(/Relative paths still mean the workspace/)
    // search reaches an added folder by path; the index-backed tools do not.
    expect(section).toMatch(/search: pass the folder/)
    expect(section).toMatch(/^codebase_search, concept_search, lsp, git tools and memory cover the workspace only/m)
  })
})

describe('tools in an added folder', () => {
  it('reads, edits, globs and greps by absolute path; refuses a folder that was not added', async () => {
    const ctx = { extraRoots: validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots }
    const signal = new AbortController().signal
    const api = join(backend, 'src', 'api.ts')

    const read = await executeTool('read', JSON.stringify({ path: api }), workspace, signal, ctx)
    expect(read.ok).toBe(true)
    expect(read.content).toContain('export const api')

    const glob = await executeTool('glob', JSON.stringify({ pattern: `${backend.replace(/\\/g, '/')}/**/*.ts` }), workspace, signal, ctx)
    expect(glob.ok).toBe(true)
    expect(glob.content).toContain(`${realpathSync(backend).replace(/\\/g, '/')}/src/api.ts`)

    const grep = await executeTool(
      'grep',
      JSON.stringify({ pattern: 'const api', include: `${backend.replace(/\\/g, '/')}/**` }),
      workspace,
      signal,
      ctx
    )
    expect(grep.ok).toBe(true)
    expect(grep.content).toContain(`${realpathSync(backend).replace(/\\/g, '/')}/src/api.ts:1:`)

    const listed = await executeTool('list_dir', JSON.stringify({ path: backend }), workspace, signal, ctx)
    expect(listed.ok).toBe(true)
    expect(listed.content).toContain('src/')

    const edited = await executeTool(
      'str_replace',
      JSON.stringify({ path: api, old_string: 'api = 1', new_string: 'api = 2' }),
      workspace,
      signal,
      ctx
    )
    expect(edited.ok).toBe(true)
    expect(readFileSync(api, 'utf8')).toContain('api = 2')

    const refused = await executeTool('read', JSON.stringify({ path: join(elsewhere, 'secret.txt') }), workspace, signal, ctx)
    expect(refused.ok).toBe(false)
    expect(refused.content).toMatch(/escapes workspace/i)

    // Without the folder added, the same absolute path is refused.
    const bare = await executeTool('read', JSON.stringify({ path: api }), workspace, signal, {})
    expect(bare.ok).toBe(false)
  })

  it('searches an added folder by path, cites hits absolute, and hides a protected file there', async () => {
    mkdirSync(join(backend, 'secrets'), { recursive: true })
    writeFileSync(join(backend, 'secrets', 'k.ts'), 'export const apiKey = "hunter2"\n')
    const policy = createPermissionPolicy({
      rules: [{ effect: 'deny', path: 'secrets/**', source: 'settings' }],
      workspaceRoot: workspace,
      extraRoots: [backend],
      userDataDir: userData
    })
    const ctx = {
      extraRoots: validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots,
      approval: {
        authorize: async () => ({ allowed: true }),
        hidesFromSearch: (tool: string, rel: string) => policy.hidesFromSearch(tool, rel)
      } as unknown as ToolApprovalGate
    }
    const signal = new AbortController().signal
    const real = realpathSync(backend).replace(/\\/g, '/')

    expect(routeExtraRootToolCall('search', { query: 'api', path: backend }, workspace, ctx.extraRoots)).toEqual({
      root: ctx.extraRoots[0],
      args: { query: 'api', path: backend }
    })

    const found = await executeTool('search', JSON.stringify({ query: 'const api', path: backend }), workspace, signal, ctx)
    expect(found.ok).toBe(true)
    expect(found.content).toContain(`${real}/src/api.ts:1:`)
    // The denied file's contents stay out, and the result says a file was held back.
    expect(found.content).not.toContain('hunter2')
    expect(found.content).toMatch(/1 file not searched: a permission rule/)

    // A subfolder of the added folder narrows the walk; a filename hit is absolute too.
    const sub = await executeTool('search', JSON.stringify({ query: 'api.ts', path: join(backend, 'src') }), workspace, signal, ctx)
    expect(sub.ok).toBe(true)
    expect(sub.content).toContain(`file: ${real}/src/api.ts`)
    expect(sub.content).not.toContain('secrets')

    // Without path, search stays on the workspace.
    const local = await executeTool('search', JSON.stringify({ query: 'const' }), workspace, signal, ctx)
    expect(local.ok).toBe(true)
    expect(local.content).toContain('app.ts:1:')
    expect(local.content).not.toContain('api.ts')

    // A relative path is a workspace subfolder.
    mkdirSync(join(workspace, 'lib'), { recursive: true })
    writeFileSync(join(workspace, 'lib', 'util.ts'), 'export const util = 1\n')
    const narrowed = await executeTool('search', JSON.stringify({ query: 'const', path: 'lib' }), workspace, signal, ctx)
    expect(narrowed.ok).toBe(true)
    expect(narrowed.content).toContain('lib/util.ts:1:')
    expect(narrowed.content).not.toContain('app.ts')

    // A folder that was not added is refused.
    const refused = await executeTool('search', JSON.stringify({ query: 'nope', path: elsewhere }), workspace, signal, ctx)
    expect(refused.ok).toBe(false)
    expect(refused.content).toMatch(/escapes workspace/i)
  })
})

describe('permissions in an added folder', () => {
  it('applies path rules, protected files and built-in asks to the resolved absolute path', () => {
    const policy = createPermissionPolicy({
      rules: [{ effect: 'deny', path: 'secrets/**', source: 'settings' }],
      workspaceRoot: workspace,
      extraRoots: [backend],
      userDataDir: userData
    })
    // A workspace-relative rule also reads relative to the added folder.
    expect(policy.evaluate('read', { path: join(backend, 'secrets', 'k.txt') })?.effect).toBe('deny')
    expect(policy.evaluate('read', { path: join(backend, 'src', 'api.ts') })).toBeNull()
    // The folder's own permissions file is protected like the workspace's.
    expect(policy.evaluate('edit', { path: join(backend, '.vyotiq', 'permissions.json') })?.effect).toBe('deny')
    // Built-in secret asks follow the file there too.
    expect(policy.evaluate('read', { path: join(backend, '.env') })?.effect).toBe('ask')
    // Search hides an added folder's denied file by its absolute path.
    expect(policy.hidesFromSearch('grep', `${backend.replace(/\\/g, '/')}/secrets/k.txt`)).toBe(true)
    expect(policy.hidesFromSearch('grep', `${backend.replace(/\\/g, '/')}/src/api.ts`)).toBe(false)
  })
})

describe('checkpoints in an added folder', () => {
  it('records an edit and a new file under absolute keys, and Undo restores both', async () => {
    const runDir = join(base, 'run')
    mkdirSync(runDir, { recursive: true })
    const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
    const api = join(roots[0]!, 'src', 'api.ts')
    const created = join(roots[0]!, 'src', 'new.ts')

    beginWriteCheckpoint(runDir, workspace, 0, roots)
    const cp = getWriteCheckpoint(runDir)!
    await cp.recordPrior(api, 'write')
    writeFileSync(api, 'export const api = 99\n')
    await cp.recordPrior(created, 'write')
    writeFileSync(created, 'export const fresh = 1\n')
    const meta = finalizeWriteCheckpoint(runDir)!
    expect(meta.extraRoots).toEqual(roots)
    const keys = meta.files.map((f) => f.path).sort()
    expect(keys).toEqual([api, created].map((p) => p.replace(/\\/g, '/')).sort())

    // The Changes list and its diff read the same keys.
    const stats = await taskFileStats(runDir, workspace)
    expect(stats.find((s) => s.path === api.replace(/\\/g, '/'))).toMatchObject({ action: 'modified', add: 1, del: 1 })
    expect(stats.find((s) => s.path === created.replace(/\\/g, '/'))).toMatchObject({ action: 'created' })
    expect(taskFileDiff(runDir, workspace, api.replace(/\\/g, '/')).diff).toContain('+export const api = 99')

    const undone = resolveWrites(runDir, workspace, { action: 'discard' })
    expect(undone.discarded.sort()).toEqual(keys)
    expect(readFileSync(api, 'utf8')).toBe('export const api = 1\n')
    expect(existsSync(created)).toBe(false)
  })
})

describe('sandbox', () => {
  it('makes the added folders writable', () => {
    const fs: SandboxFs = {
      exists: (p) => ['/w', '/tmp', '/other'].includes(p),
      realpath: (p) => p,
      isFile: () => false,
      readText: () => null
    }
    const prepared = prepareAgentSandbox(
      { workspace: '/w', cwd: '/w', extraRoots: ['/other'], settings: { mode: 'workspace-write', network: 'deny' } },
      {
        capability: { available: true, mechanism: 'bubblewrap', reason: null, executable: '/usr/bin/bwrap' },
        platform: 'linux',
        fs,
        homeDir: '/home/ada',
        tmpDir: '/tmp',
        userDataDir: null
      }
    )
    expect(prepared.state).toBe('on')
    if (prepared.state !== 'on') return
    const args = prepared.launch.wrap('/bin/sh', ['-c', 'ls']).args
    const binds = args.flatMap((a, i) => (a === '--bind' ? [args[i + 1]] : []))
    expect(binds).toContain('/w')
    expect(binds).toContain('/other')
  })
})

describe('run meta', () => {
  it('persists the folders on the run, lists them, and a fork keeps them', async () => {
    createRun(workspace, 'run-x', 'two repos', { extraRoots: [backend] })
    expect(loadStatus(resolveRunDir(workspace, 'run-x'))?.extraRoots).toEqual([backend])
    const listed = await listRuns(workspace)
    expect(listed.runs.find((r) => r.runId === 'run-x')?.extraRoots).toEqual([backend])
    const forked = await forkRun(workspace, 'run-x')
    expect(loadStatus(resolveRunDir(workspace, forked))?.extraRoots).toEqual([backend])
  })
})

describe('instructions in an added folder', () => {
  it("attaches the folder's own AGENTS.md on the first file read there, once", async () => {
    writeFileSync(join(backend, 'AGENTS.md'), 'Backend: run make test.\n')
    const nested = new NestedInstructions(workspace, null, [], [backend])
    const first = await nested.forPaths([join(backend, 'src', 'api.ts')])
    expect(first.map((i) => i.content)).toEqual(['Backend: run make test.'])
    expect(first[0]!.source).toBe(`${backend.replace(/\\/g, '/')}/AGENTS.md`)
    expect(await nested.forPaths([join(backend, 'src', 'api.ts')])).toEqual([])
  })
})

describe('terminal writes in an added folder', () => {
  it('snapshots only the added folders a command runs in or names', () => {
    const roots = ['C:\\work\\backend', 'C:\\work\\infra', '/srv/api']
    // Its working directory.
    expect(extraRootsForCommand('pnpm install', 'C:\\work\\backend\\pkg', roots)).toEqual(['C:\\work\\backend'])
    // Named in the command, in either slash form, any case, or Git Bash's /c/ form.
    expect(extraRootsForCommand('pnpm -C c:/WORK/infra build', 'C:\\ws', roots)).toEqual(['C:\\work\\infra'])
    expect(extraRootsForCommand('cp x "C:\\work\\backend\\y.ts"', 'C:\\ws', roots)).toEqual(['C:\\work\\backend'])
    expect(extraRootsForCommand('make -C /c/work/infra', 'C:\\ws', roots)).toEqual(['C:\\work\\infra'])
    expect(extraRootsForCommand('npm run build --prefix /srv/api', '/w', roots)).toEqual(['/srv/api'])
    // A longer sibling is another folder; a POSIX path keeps its case; unnamed folders cost nothing.
    expect(extraRootsForCommand('pnpm -C C:/work/backend2 build', 'C:\\ws', roots)).toEqual([])
    expect(extraRootsForCommand('npm run build --prefix /SRV/api', '/w', roots)).toEqual([])
    expect(extraRootsForCommand('pnpm build', 'C:\\ws', roots)).toEqual([])
    expect(extraRootsForCommand('pnpm build', 'C:\\ws', undefined)).toEqual([])
  })

  for (const mode of ['walk', 'git'] as const) {
    it(`checkpoints an opaque command's writes there under absolute keys, and Undo restores them (${mode})`, async () => {
      if (mode === 'git') {
        const git = (...args: string[]): void => {
          execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: backend,
            stdio: 'ignore',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'T',
              GIT_AUTHOR_EMAIL: 't@example.com',
              GIT_COMMITTER_NAME: 'T',
              GIT_COMMITTER_EMAIL: 't@example.com'
            }
          })
        }
        git('init', '-q')
        git('config', 'core.autocrlf', 'false')
        git('add', '-A')
        git('commit', '-q', '-m', 'c')
      } else {
        setGitSnapshotEnabledForTests(false)
      }
      try {
        const runDir = join(base, 'run')
        mkdirSync(runDir, { recursive: true })
        const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
        const api = join(roots[0]!, 'src', 'api.ts')
        const made = join(roots[0]!, 'src', 'gen.ts')
        beginWriteCheckpoint(runDir, workspace, 0, roots)

        const snaps = await startWatches(workspace, extraRootsForCommand('pnpm build', join(roots[0]!, 'src'), roots))
        expect(snaps.map((s) => s.extraRoot ?? null)).toEqual([null, roots[0]])
        if (mode === 'git') expect(snaps[1]!.git).toBeTruthy()
        writeFileSync(api, 'export const api = 99\n')
        writeFileSync(made, 'export const gen = 1\n')
        writeFileSync(join(workspace, 'app.ts'), 'export const app = 2\n')
        await finishWatches(snaps, { runDir })

        const meta = finalizeWriteCheckpoint(runDir)!
        const keys = meta.files.map((f) => f.path).sort()
        expect(keys).toEqual(['app.ts', ...[api, made].map((p) => p.replace(/\\/g, '/'))].sort())
        expect(meta.files.find((f) => f.path === api.replace(/\\/g, '/'))).toMatchObject({
          action: 'modified',
          undoable: true
        })

        resolveWrites(runDir, workspace, { action: 'discard' })
        expect(readFileSync(api, 'utf8')).toBe('export const api = 1\n')
        expect(existsSync(made)).toBe(false)
        expect(readFileSync(join(workspace, 'app.ts'), 'utf8')).toBe('export const app = 1\n')
      } finally {
        setGitSnapshotEnabledForTests(null)
      }
    })
  }

  it('records a redirect run inside an added folder against that folder, not the workspace', async () => {
    const runDir = join(base, 'run')
    mkdirSync(runDir, { recursive: true })
    const roots = validateExtraRoots(workspace, [backend], { userDataDir: userData }).roots
    const cwd = join(roots[0]!, 'src')
    const absolute = join(roots[0]!, 'notes.md')
    beginWriteCheckpoint(runDir, workspace, 0, roots)
    await recordTerminalCommandPriors(workspace, 'echo hi > out.txt', { runDir }, { cwd, extraRoots: roots })
    await recordTerminalCommandPriors(workspace, `echo hi > "${absolute}"`, { runDir }, { cwd: workspace, extraRoots: roots })
    // A folder that was not added stays out.
    const outside = join(elsewhere, 'x.txt')
    await recordTerminalCommandPriors(workspace, `echo hi > "${outside}"`, { runDir }, { cwd: workspace, extraRoots: roots })
    writeFileSync(join(cwd, 'out.txt'), 'hi\n')
    writeFileSync(absolute, 'hi\n')
    const meta = finalizeWriteCheckpoint(runDir)!
    expect(meta.files.map((f) => f.path).sort()).toEqual(
      [join(cwd, 'out.txt'), absolute].map((p) => p.replace(/\\/g, '/')).sort()
    )
    resolveWrites(runDir, workspace, { action: 'discard' })
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false)
    expect(existsSync(absolute)).toBe(false)
  })
})

describe('folders on a started task', () => {
  it('adds a folder, refuses ones that do not fit, and removes it', async () => {
    createRun(workspace, 'run-y', 'two repos', {})
    const dir = resolveRunDir(workspace, 'run-y')
    const real = realpathSync(backend)
    const opts = { userDataDir: userData }

    const added = await updateRunExtraRoots(workspace, 'run-y', { add: backend }, opts)
    expect(added).toEqual({ extraRoots: [real], live: false, added: real })
    expect(loadStatus(dir)?.extraRoots).toEqual([real])
    expect((await listRuns(workspace)).runs.find((r) => r.runId === 'run-y')?.extraRoots).toEqual([real])

    const again = await updateRunExtraRoots(workspace, 'run-y', { add: backend }, opts)
    expect(again.refused).toContain('already added')
    const inside = await updateRunExtraRoots(workspace, 'run-y', { add: workspace }, opts)
    expect(inside.refused).toContain('already part of the workspace')
    const nested = await updateRunExtraRoots(workspace, 'run-y', { add: join(backend, 'src') }, opts)
    expect(nested.refused).toContain('overlaps backend')
    const relative = await updateRunExtraRoots(workspace, 'run-y', { add: 'backend' }, opts)
    expect(relative.refused).toContain('not an absolute path')
    expect(loadStatus(dir)?.extraRoots).toEqual([real])

    const removed = await updateRunExtraRoots(workspace, 'run-y', { remove: real }, opts)
    expect(removed).toEqual({ extraRoots: [], live: false, removed: real })
    expect(loadStatus(dir)?.extraRoots).toEqual([])
    expect((await listRuns(workspace)).runs.find((r) => r.runId === 'run-y')?.extraRoots).toBeUndefined()
    const gone = await updateRunExtraRoots(workspace, 'run-y', { remove: real }, opts)
    expect(gone.refused).toContain("not one of this task's folders")
  })

  it('says a running task takes the change up when it next starts', async () => {
    createRun(workspace, 'run-live', 'still going', {})
    registerRunAbort('run-live', workspace)
    try {
      const res = await updateRunExtraRoots(workspace, 'run-live', { add: backend }, { userDataDir: userData })
      expect(res).toMatchObject({ live: true, added: realpathSync(backend) })
      // Saved now: the next invoke reads it from the run's status.
      expect(loadStatus(resolveRunDir(workspace, 'run-live'))?.extraRoots).toEqual([realpathSync(backend)])
    } finally {
      clearRunAbort('run-live')
    }
  })

  it('leaves a helper on its parent’s folders, and refuses a task that does not exist', async () => {
    createRun(workspace, 'run-helper', 'helper', {})
    await updateStatus(resolveRunDir(workspace, 'run-helper'), { inlineInstance: true }, { sync: true })
    const res = await updateRunExtraRoots(workspace, 'run-helper', { add: backend }, { userDataDir: userData })
    expect(res.refused).toContain('parent task')
    expect(loadStatus(resolveRunDir(workspace, 'run-helper'))?.extraRoots).toBeUndefined()
    await expect(updateRunExtraRoots(workspace, 'run-nope', { add: backend })).rejects.toThrow('Run not found')
  })
})
