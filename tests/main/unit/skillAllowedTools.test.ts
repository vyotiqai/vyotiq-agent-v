import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-skill-allowed-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn(async () => '') }
}))

import { parseAllowedTools, skillAllowedToolsTrusted, type SkillToolGrant } from '@main/agent/skills/allowedTools'
import { parseSkillFrontmatter } from '@main/agent/skills/parse'
import { createPermissionPolicy, type ActiveSkillAllows, type PermissionPolicyInput } from '@main/agent/permissions'
import { createApprovalGate } from '@main/agent/toolApproval'
import type { PermissionRule, ToolApprovalRequest } from '@shared/ipc'

/**
 * A skill's `allowed-tools` pre-approve, Claude Code style, while the skill is
 * active — as an allow rule, never past a deny, an ask, a protected path or the
 * command guard, and only for skills the user put there.
 */

function posix(overrides: Partial<PermissionPolicyInput> = {}) {
  return createPermissionPolicy({
    rules: [],
    workspaceRoot: '/home/u/proj',
    userDataDir: '/home/u/.config/vyotiq',
    homeDir: '/home/u',
    platform: 'linux',
    syntax: 'posix',
    resolveSymlinks: false,
    ...overrides
  })
}

function active(raw: string, skill = 'helper'): ActiveSkillAllows[] {
  return [{ skill, allows: parseAllowedTools(raw).allows }]
}

describe('allowed-tools — reading the field', () => {
  it('maps Claude Code names onto this app’s tools', () => {
    const { allows, ignored } = parseAllowedTools('Read, Grep Glob, Edit, Bash(git status:*), WebSearch, mcp__github')
    const byEntry = Object.fromEntries(allows.map((a) => [a.entry, a.tools]))
    expect(byEntry['Read']).toEqual(['read'])
    expect(byEntry['Grep']).toEqual(['grep', 'search'])
    expect(byEntry['Glob']).toEqual(['glob'])
    expect(byEntry['Edit']).toEqual(['edit', 'str_replace'])
    expect(byEntry['Bash(git status:*)']).toEqual(['terminal', 'run_tests'])
    expect(byEntry['WebSearch']).toEqual(['browser_search'])
    expect(byEntry['mcp__github']).toEqual(['mcp__github__*'])
    expect(ignored).toEqual([])
    expect(allows.find((a) => a.entry === 'Bash(git status:*)')?.command).toEqual({ words: ['git', 'status'], exact: false })
  })

  it('ignores what it cannot read narrowly instead of widening it', () => {
    const { allows, ignored } = parseAllowedTools('Frobnicate, Bash(git * main), mcp__*, TodoWrite(x), WebFetch(domain:)')
    expect(allows).toEqual([])
    expect(ignored).toEqual(['Frobnicate', 'Bash(git * main)', 'mcp__*', 'TodoWrite(x)', 'WebFetch(domain:)'])
  })

  it('reads a block list, a flow list, and treats an empty field as none', () => {
    const block = parseSkillFrontmatter('---\nname: x\ndescription: d\nallowed-tools:\n  - Read\n  - Bash(git log:*)\n---\nbody\n')
    expect(block['allowed-tools']).toBe('Read, Bash(git log:*)')
    const flow = parseSkillFrontmatter('---\nname: x\ndescription: d\nallowed-tools: [Read, Grep]\n---\nbody\n')
    expect(flow['allowed-tools']).toBe('Read, Grep')
    // An empty field used to fail the schema and drop the whole skill.
    const empty = parseSkillFrontmatter('---\nname: x\ndescription: d\nallowed-tools:\n---\nbody\n')
    expect(empty['allowed-tools']).toBeUndefined()
    expect(empty.name).toBe('x')
  })

  it('trusts personal skills and bundled packages, never a workspace’s own', () => {
    expect(skillAllowedToolsTrusted({ source: 'personal' })).toBe(true)
    expect(skillAllowedToolsTrusted({ source: 'skill', installSource: 'bundled' })).toBe(true)
    expect(skillAllowedToolsTrusted({ source: 'plugin', installSource: 'bundled' })).toBe(true)
    expect(skillAllowedToolsTrusted({ source: 'skill', installSource: 'git' })).toBe(false)
    expect(skillAllowedToolsTrusted({ source: 'project' })).toBe(false)
  })
})

describe('allowed-tools — as an allow in the permission policy', () => {
  const evalWith = (policy: ReturnType<typeof posix>, raw: string, tool: string, args: Record<string, unknown>) =>
    policy.evaluate(tool, args, { skills: active(raw) })

  it('allows a command prefix, and only a simple command starting with it', () => {
    const policy = posix()
    const ok = evalWith(policy, 'Bash(git status:*)', 'terminal', { command: 'git status -s' })
    expect(ok).toMatchObject({ effect: 'allow', source: 'skill', skill: 'helper', rule: 'skill helper: Bash(git status:*)' })
    expect(evalWith(policy, 'Bash(git status:*)', 'terminal', { command: 'git push' })).toBeNull()
    expect(evalWith(policy, 'Bash(git status:*)', 'terminal', { command: 'git status && rm -rf src' })).toBeNull()
    // An env assignment changes what runs; the skill named only the words.
    expect(evalWith(policy, 'Bash(git status:*)', 'terminal', { command: 'GIT_EXTERNAL_DIFF=x git status' })).toBeNull()
    expect(evalWith(policy, 'Bash(git status:*)', 'run_tests', { command: 'git status' })?.effect).toBe('allow')
  })

  it('reads a spec without :* as the exact command', () => {
    const policy = posix()
    expect(evalWith(policy, 'Bash(npm test)', 'terminal', { command: 'npm test' })?.effect).toBe('allow')
    expect(evalWith(policy, 'Bash(npm test)', 'terminal', { command: 'npm test -- --watch' })).toBeNull()
  })

  it('limits a file tool to its path spec', () => {
    const policy = posix()
    expect(evalWith(policy, 'Read(src/**)', 'read', { path: 'src/a.ts' })?.effect).toBe('allow')
    expect(evalWith(policy, 'Read(src/**)', 'read', { path: 'lib/a.ts' })).toBeNull()
    // `/x` is from the workspace root, as in Claude Code.
    expect(evalWith(policy, 'Edit(/docs)', 'str_replace', { path: 'docs/a.md' })?.effect).toBe('allow')
    expect(evalWith(policy, 'Edit(/docs)', 'str_replace', { path: 'pkg/docs/a.md' })).toBeNull()
  })

  it('holds a fetch to its domain and an MCP grant to its server', () => {
    const policy = posix()
    const raw = 'WebFetch(domain:example.com), mcp__github'
    expect(evalWith(policy, raw, 'browser_navigate', { url: 'https://docs.example.com/x' })?.effect).toBe('allow')
    expect(evalWith(policy, raw, 'browser_navigate', { url: 'https://example.com.evil.io/' })).toBeNull()
    expect(evalWith(policy, raw, 'browser_navigate', { url: 'file:///etc/passwd' })).toBeNull()
    expect(evalWith(policy, raw, 'mcp__github__create_issue', {})?.effect).toBe('allow')
    expect(evalWith(policy, raw, 'mcp__gitlab__create_issue', {})).toBeNull()
  })

  it('never answers past a deny, an ask, a protected path or a built-in secret ask', () => {
    const rules = (...list: PermissionRule[]) => list.map((r) => ({ ...r, source: 'settings' as const }))
    const denied = posix({ rules: rules({ effect: 'deny', command: 'git status' }) })
    expect(evalWith(denied, 'Bash', 'terminal', { command: 'git status' })?.effect).toBe('deny')
    const asked = posix({ rules: rules({ effect: 'ask', path: 'src/**' }) })
    expect(evalWith(asked, 'Edit', 'edit', { path: 'src/a.ts' })?.effect).toBe('ask')
    expect(evalWith(posix(), 'Read', 'read', { path: '.env' })?.effect).toBe('ask')
    expect(evalWith(posix(), 'Read', 'read', { path: '/home/u/.config/vyotiq/secrets.json' })?.effect).toBe('deny')
    // Your own allow speaks first.
    const own = posix({ rules: rules({ effect: 'allow', command: 'git status' }) })
    expect(evalWith(own, 'Bash', 'terminal', { command: 'git status' })?.source).toBe('settings')
  })

  it('asks before anything changes a personal skill, whatever is allowed', () => {
    const rules = [{ effect: 'allow' as const, tool: 'terminal', source: 'settings' as const }]
    const policy = posix({ rules })
    const v = evalWith(policy, 'Bash', 'terminal', { command: 'cp evil.md ~/.vyotiq/skills/x/SKILL.md' })
    expect(v).toMatchObject({ effect: 'ask', rule: 'protected: personal skills' })
    expect(policy.evaluate('read', { path: '/home/u/.vyotiq/skills/x/SKILL.md' })).toBeNull()
  })
})

describe('allowed-tools — the approval gate', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, arguments: JSON.stringify(args) })

  function gate(grant: Partial<SkillToolGrant> & { raw?: string }, rules: PermissionRule[] = []) {
    const asked: ToolApprovalRequest[] = []
    const parsed = parseAllowedTools(grant.raw ?? 'Bash, Edit')
    const g = createApprovalGate({
      runId: 'run-skill',
      mode: 'all',
      workspaceAllowlist: [],
      signal: new AbortController().signal,
      commandGuard: { workspaceRoot: '/home/u/proj', homeDir: '/home/u', platform: 'linux', syntax: 'posix' },
      permissions: posix({ rules: rules.map((r) => ({ ...r, source: 'settings' as const })) }),
      skillGrants: (name) =>
        name.toLowerCase() === 'helper'
          ? { skill: 'helper', trusted: grant.trusted ?? true, source: grant.source ?? 'personal', allows: parsed.allows, ignored: parsed.ignored }
          : null,
      ask: async (request) => {
        asked.push(request)
        return 'once'
      }
    })
    return { g, asked }
  }

  it('asks until the skill is active, then lets its tools through and says which skill', async () => {
    const { g, asked } = gate({})
    await g.authorize(call('terminal', { command: 'pnpm build' }))
    expect(asked).toHaveLength(1)
    g.activateSkill?.('Helper')
    const verdict = await g.authorize(call('terminal', { command: 'pnpm build' }))
    expect(verdict).toEqual({ allowed: true, grant: { by: 'skill', scope: 'once', allow: 'helper' } })
    expect(asked).toHaveLength(1)
    // A tool the skill did not list still asks.
    await g.authorize(call('delete', { path: 'a.ts' }))
    expect(asked).toHaveLength(2)
  })

  it('still holds a command the guard stops, and an ask rule', async () => {
    const { g, asked } = gate({}, [{ effect: 'ask', path: 'src/**' }])
    g.activateSkill?.('helper')
    await g.authorize(call('terminal', { command: 'git push --force origin main' }))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.danger).toMatch(/Force-pushes/)
    await g.authorize(call('edit', { path: 'src/a.ts', contents: 'x' }))
    expect(asked).toHaveLength(2)
  })

  it('honours nothing from a skill the workspace brought', async () => {
    const { g, asked } = gate({ trusted: false, source: 'project' })
    g.activateSkill?.('helper')
    await g.authorize(call('terminal', { command: 'pnpm build' }))
    expect(asked).toHaveLength(1)
  })

  it('ignores an unknown skill name', async () => {
    const { g, asked } = gate({})
    g.activateSkill?.('nope')
    await g.authorize(call('terminal', { command: 'pnpm build' }))
    expect(asked).toHaveLength(1)
  })
})

describe('allowed-tools — resolved as the Skill tool resolves the name', () => {
  let workspace: string
  let personal: string

  function writeSkill(dir: string, name: string, allowed: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\nallowed-tools: ${allowed}\n---\n\nBody.\n`)
  }

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-skill-allowed-ws-'))
    personal = mkdtempSync(join(tmpdir(), 'vyotiq-skill-allowed-home-'))
    const { setPersonalSkillsRootForTests, clearLocalSkillsCache } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(personal)
    clearLocalSkillsCache()
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
  })

  afterEach(async () => {
    const { setPersonalSkillsRootForTests, clearLocalSkillsCache } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(null)
    clearLocalSkillsCache()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(personal, { recursive: true, force: true })
  })

  it('trusts a personal skill, and not a workspace skill that shadows it', async () => {
    const { resolveSkillToolGrant } = await import('@main/agent/skills/allowedTools')
    writeSkill(join(personal, 'gitty'), 'gitty', 'Bash(git status:*), Read')
    const mine = resolveSkillToolGrant('gitty', null, workspace)
    expect(mine).toMatchObject({ skill: 'gitty', trusted: true, source: 'personal' })
    expect(mine?.allows.map((a) => a.entry)).toEqual(['Bash(git status:*)', 'Read'])

    writeSkill(join(workspace, '.vyotiq', 'skills', 'gitty'), 'gitty', 'Bash')
    const { clearLocalSkillsCache } = await import('@main/agent/skills/local')
    clearLocalSkillsCache()
    expect(resolveSkillToolGrant('gitty', null, workspace)).toMatchObject({ trusted: false, source: 'project' })
  })
})
