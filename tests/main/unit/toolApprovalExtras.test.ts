import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approvalTimeoutMs,
  createApprovalGate,
  editAllowFolder,
  folderAllowRules,
  registerApprovalSender,
  resetToolApprovalForTests,
  resolveToolApproval,
  setApprovalTimeoutSource
} from '@main/agent/toolApproval'
import type { PermissionRule, ToolApprovalRequest } from '@shared/ipc'

const WRITE = { id: 'c2', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' }
const TERMINAL = { id: 'c9', name: 'terminal', arguments: '{"command":"pnpm test --all","timeoutMs":60000}' }

function gate() {
  return createApprovalGate({
    runId: 'run-1',
    mode: 'mutating',
    workspaceAllowlist: [],
    signal: new AbortController().signal
  })
}

function listen(): ToolApprovalRequest[] {
  const seen: ToolApprovalRequest[] = []
  registerApprovalSender('run-1', (request) => {
    seen.push(request)
  })
  return seen
}

beforeEach(() => resetToolApprovalForTests())
afterEach(() => {
  resetToolApprovalForTests()
  vi.useRealTimers()
})

describe('deny with a note', () => {
  it('hands the note to the agent with the refusal', async () => {
    const seen = listen()
    const verdict = gate().authorize(WRITE)
    await Promise.resolve()
    resolveToolApproval({
      requestId: seen[0]!.requestId,
      runId: 'run-1',
      decision: 'deny',
      note: 'Edit b.ts instead; a.ts is generated'
    })
    const result = await verdict
    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('They said: "Edit b.ts instead; a.ts is generated". Do what they asked instead.')
    expect(result.reason).toContain('Do not retry the denied call.')
  })

  it('keeps the old wording for a plain deny, and ignores a note on an allow', async () => {
    const seen = listen()
    const g = gate()
    const denied = g.authorize(WRITE)
    await Promise.resolve()
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'deny' })
    const r = await denied
    expect(!r.allowed && r.reason).toBe(
      'The user denied permission to run edit. Do not retry it; ask what to do instead or continue without it.'
    )
    const allowed = g.authorize({ ...WRITE, id: 'c3' })
    await Promise.resolve()
    resolveToolApproval({ requestId: seen[1]!.requestId, runId: 'run-1', decision: 'once', note: 'ignored' })
    expect(await allowed).toEqual({ allowed: true, grant: { by: 'you', scope: 'once' } })
  })
})

describe('edit the command, then allow it', () => {
  it('runs the edited command once and says so', async () => {
    const seen = listen()
    const verdict = gate().authorize(TERMINAL)
    await Promise.resolve()
    resolveToolApproval({
      requestId: seen[0]!.requestId,
      runId: 'run-1',
      decision: 'once',
      editedCommand: 'pnpm test src/a.test.ts'
    })
    const result = await verdict
    expect(result).toMatchObject({ allowed: true, grant: { by: 'you', scope: 'once' } })
    if (!result.allowed) return
    expect(JSON.parse(result.arguments!)).toEqual({ command: 'pnpm test src/a.test.ts', timeoutMs: 60000 })
    expect(result.editNote).toBe('[The user edited this command before allowing it. It ran as: "pnpm test src/a.test.ts"]')
  })

  it('takes no edit on anything but a command, and none on Always', async () => {
    const seen = listen()
    const g = gate()
    const edit = g.authorize(WRITE)
    await Promise.resolve()
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'once', editedCommand: 'rm -rf /' })
    expect(await edit).toEqual({ allowed: true, grant: { by: 'you', scope: 'once' } })
    const always = g.authorize({ ...TERMINAL, id: 'c10' })
    await Promise.resolve()
    resolveToolApproval({ requestId: seen[1]!.requestId, runId: 'run-1', decision: 'always', editedCommand: 'echo hi' })
    const r = await always
    expect(r.allowed && r.arguments).toBeFalsy()
  })
})

describe('approval timeout setting', () => {
  it('reads minutes, and 0 as no limit', () => {
    expect(approvalTimeoutMs()).toBe(15 * 60_000)
    setApprovalTimeoutSource(() => 5)
    expect(approvalTimeoutMs()).toBe(5 * 60_000)
    setApprovalTimeoutSource(() => 0)
    expect(approvalTimeoutMs()).toBeNull()
  })

  it('sends the wait with the request and denies when it runs out', async () => {
    vi.useFakeTimers()
    setApprovalTimeoutSource(() => 1)
    const seen = listen()
    const verdict = gate().authorize(WRITE)
    await Promise.resolve()
    expect(seen[0]!.timeoutMs).toBe(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    const r = await verdict
    expect(!r.allowed && r.reason).toContain('timed out and was auto-denied')
  })

  it('waits with no timer when the setting is 0', async () => {
    vi.useFakeTimers()
    setApprovalTimeoutSource(() => 0)
    const seen = listen()
    const verdict = gate().authorize(WRITE)
    await Promise.resolve()
    expect(seen[0]!.timeoutMs).toBeNull()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'once' })
    expect((await verdict).allowed).toBe(true)
  })
})

describe('always allow edits under a folder', () => {
  const SRC_EDIT = { id: 'c4', name: 'str_replace', arguments: '{"path":"src/lib/a.ts","old":"a","new":"b"}' }

  it('names the top folder, and none for a root file, a .git path or outside the workspace', () => {
    expect(editAllowFolder('str_replace', SRC_EDIT.arguments, undefined)).toBe('src')
    expect(editAllowFolder('edit', '{"path":"./docs/x.md"}', undefined)).toBe('docs')
    expect(editAllowFolder('edit', '{"path":"README.md"}', undefined)).toBeNull()
    expect(editAllowFolder('edit', '{"path":".git/config"}', undefined)).toBeNull()
    expect(editAllowFolder('edit', '{"path":"../other/a.ts"}', undefined)).toBeNull()
    expect(editAllowFolder('terminal', '{"path":"src/a.ts"}', undefined)).toBeNull()
  })

  it('allows later edits under that folder only, and saves it as rules', async () => {
    const seen = listen()
    const saved: PermissionRule[][] = []
    const always: string[] = []
    const g = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      persistAlways: (name) => always.push(name),
      persistRules: (rules) => saved.push(rules)
    })
    const first = g.authorize(SRC_EDIT)
    await Promise.resolve()
    expect(seen[0]!.alwaysAllowFolder).toBe('src')
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'always', allowFolder: true })
    expect((await first).allowed).toBe(true)
    expect(always).toEqual([])
    expect(saved).toEqual([folderAllowRules('src')])
    expect(folderAllowRules('src')).toEqual([
      { effect: 'allow', tool: 'edit', path: 'src/**' },
      { effect: 'allow', tool: 'str_replace', path: 'src/**' }
    ])

    // Same folder, other tool: no prompt.
    const second = await g.authorize({ id: 'c5', name: 'edit', arguments: '{"path":"src/b.ts","contents":"x"}' })
    expect(second.allowed).toBe(true)
    expect(seen).toHaveLength(1)

    // Another folder still asks.
    void g.authorize({ id: 'c6', name: 'edit', arguments: '{"path":"scripts/b.ts","contents":"x"}' })
    await Promise.resolve()
    expect(seen).toHaveLength(2)
  })

  it('ignores allowFolder on a request that offered no folder', async () => {
    const seen = listen()
    const always: string[] = []
    const g = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      persistAlways: (name) => always.push(name),
      persistRules: () => {
        throw new Error('no rules expected')
      }
    })
    const verdict = g.authorize({ id: 'c7', name: 'edit', arguments: '{"path":"README.md","contents":"x"}' })
    await Promise.resolve()
    expect(seen[0]!.alwaysAllowFolder).toBeUndefined()
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'always', allowFolder: true })
    expect((await verdict).allowed).toBe(true)
    expect(always).toEqual(['edit'])
  })
})

describe('always allow a whole program', () => {
  it('offers the program beside its subcommand, and remembers it when chosen', async () => {
    const seen = listen()
    const always: string[] = []
    const g = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      persistAlways: (name) => always.push(name)
    })
    const first = g.authorize({ id: 'p1', name: 'terminal', arguments: '{"command":"npm test -- --watch=false"}' })
    await Promise.resolve()
    expect(seen[0]!.alwaysAllowCommand).toBe('npm test')
    expect(seen[0]!.alwaysAllowProgram).toBe('npm')
    resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'always', allowProgram: true })
    expect(await first).toEqual({ allowed: true, grant: { by: 'you', scope: 'workspace', allow: 'npm' } })
    expect(always).toEqual(['terminal:npm'])
    // Another npm command no longer asks.
    expect((await g.authorize({ id: 'p2', name: 'terminal', arguments: '{"command":"npm run lint"}' })).allowed).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('never offers it for a shell, git or a deleter', async () => {
    const seen = listen()
    const g = gate()
    for (const [i, command] of ['git status', 'rm build.log', 'npx vitest'].entries()) {
      void g.authorize({ id: `q${i}`, name: 'terminal', arguments: JSON.stringify({ command }) })
      await Promise.resolve()
      expect(seen[i]!.alwaysAllowProgram).toBeUndefined()
    }
  })
})
