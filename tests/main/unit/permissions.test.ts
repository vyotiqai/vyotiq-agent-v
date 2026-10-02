import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPermissionPolicy,
  loadRunPermissionPolicy,
  readWorkspacePermissions,
  type PermissionPolicyInput,
  type SourcedPermissionRule
} from '@main/agent/permissions'
import { createApprovalGate } from '@main/agent/toolApproval'
import { toolGrep } from '@main/agent/tools/grep'
import { toolSearch } from '@main/agent/tools/search'
import { DEFAULT_SETTINGS, DEFAULT_TOOL_APPROVAL, SettingsSchema, ToolApprovalSettingsSchema, type PermissionRule, type ToolApprovalRequest } from '@shared/ipc'

const POSIX_HOME = '/home/u'
const POSIX_USER_DATA = '/home/u/.config/vyotiq'

function rules(...list: PermissionRule[]): SourcedPermissionRule[] {
  return list.map((rule) => ({ ...rule, source: 'settings' as const }))
}

function posix(overrides: Partial<PermissionPolicyInput> = {}) {
  return createPermissionPolicy({
    rules: [],
    workspaceRoot: '/home/u/proj',
    userDataDir: POSIX_USER_DATA,
    homeDir: POSIX_HOME,
    platform: 'linux',
    syntax: 'posix',
    resolveSymlinks: false,
    ...overrides
  })
}

function win(overrides: Partial<PermissionPolicyInput> = {}) {
  return createPermissionPolicy({
    rules: [],
    workspaceRoot: 'C:\\Repo',
    userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\vyotiq',
    homeDir: 'C:\\Users\\u',
    platform: 'win32',
    syntax: 'windows',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    resolveSymlinks: false,
    ...overrides
  })
}

const effect = (
  policy: ReturnType<typeof posix>,
  tool: string,
  args: Record<string, unknown>
): string | null => policy.evaluate(tool, args)?.effect ?? null

describe('permission rules — precedence', () => {
  const policy = posix({
    rules: rules(
      { effect: 'allow', path: 'src/**' },
      { effect: 'ask', path: 'src/secret/**' },
      { effect: 'deny', path: 'src/secret/key.txt' }
    )
  })

  it('deny beats ask beats allow', () => {
    expect(effect(policy, 'read', { path: 'src/secret/key.txt' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'src/secret/other.txt' })).toBe('ask')
    expect(effect(policy, 'read', { path: 'src/a.ts' })).toBe('allow')
    expect(effect(policy, 'read', { path: 'lib/a.ts' })).toBeNull()
  })

  it('tells the model a deny will not change on retry', () => {
    const verdict = policy.evaluate('edit', { path: 'src/secret/key.txt', contents: 'x' })
    expect(verdict?.effect).toBe('deny')
    expect(verdict?.reason).toMatch(/permission rule "deny path src\/secret\/key\.txt"/)
    expect(verdict?.reason).toMatch(/will not change on retry/)
  })

  it('reads every file-touching tool', () => {
    const deny = posix({ rules: rules({ effect: 'deny', path: 'locked/**' }) })
    expect(effect(deny, 'read', { path: 'locked/a' })).toBe('deny')
    expect(effect(deny, 'edit', { path: 'locked/a', contents: '' })).toBe('deny')
    expect(effect(deny, 'str_replace', { path: 'locked/a', old_string: 'a', new_string: 'b' })).toBe('deny')
    expect(effect(deny, 'delete', { path: 'locked' })).toBe('deny')
    expect(effect(deny, 'edit_notebook', { target_notebook: 'locked/n.ipynb', cell_idx: 0, new_string: '' })).toBe('deny')
    expect(effect(deny, 'list_dir', { path: 'locked' })).toBe('deny')
    expect(effect(deny, 'lsp', { path: 'locked/a.ts', action: 'hover' })).toBe('deny')
    const patch = ['--- a/locked/a', '+++ b/locked/a', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    expect(effect(deny, 'git_apply', { patch })).toBe('deny')
    expect(effect(deny, 'glob', { pattern: '**/*' })).toBeNull()
  })

  it('needs every matcher a rule sets', () => {
    const policy = posix({ rules: rules({ effect: 'deny', tool: 'edit', path: 'docs/**' }) })
    expect(effect(policy, 'edit', { path: 'docs/a.md', contents: '' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'docs/a.md' })).toBeNull()
    expect(effect(policy, 'edit', { path: 'src/a.md', contents: '' })).toBeNull()
  })

  it('matches tool names with a wildcard', () => {
    const policy = posix({ rules: rules({ effect: 'deny', tool: 'mcp__github__*' }) })
    expect(effect(policy, 'mcp__github__create_issue', {})).toBe('deny')
    expect(effect(policy, 'mcp__slack__post', {})).toBeNull()
  })

  it('an allow needs every path the call touches to match', () => {
    const policy = posix({ rules: rules({ effect: 'allow', path: 'src/**' }) })
    const patch = ['--- a/src/a', '+++ b/src/a', '@@ -1 +1 @@', '-x', '+y', '--- a/lib/b', '+++ b/lib/b', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    expect(effect(policy, 'git_apply', { patch })).toBeNull()
  })
})

describe('permission rules — path globs', () => {
  it('matches a name with no slash at any depth, and a folder covers its contents', () => {
    const policy = posix({ rules: rules({ effect: 'deny', path: 'build' }, { effect: 'deny', path: '*.key' }) })
    expect(effect(policy, 'read', { path: 'build/a/b.js' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'pkg/build/x' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'a/b/server.key' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'builds/x' })).toBeNull()
  })

  it('supports **, ?, and {a,b}', () => {
    const policy = posix({ rules: rules({ effect: 'deny', path: 'src/**/gen-?.{ts,js}' }) })
    expect(effect(policy, 'read', { path: 'src/gen-1.ts' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'src/a/b/gen-2.js' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'src/gen-10.ts' })).toBeNull()
    expect(effect(policy, 'read', { path: 'src/gen-1.css' })).toBeNull()
  })

  it('reads absolute and ~/ patterns against the absolute path', () => {
    const policy = posix({ workspaceRoot: POSIX_HOME, rules: rules({ effect: 'deny', path: '~/private/**' }, { effect: 'ask', path: '/home/u/notes' }) })
    expect(effect(policy, 'read', { path: 'private/x.txt' })).toBe('deny')
    expect(effect(policy, 'read', { path: '/home/u/notes/today.md' })).toBe('ask')
  })

  it('is case-insensitive with either separator on Windows', () => {
    const policy = win({ rules: rules({ effect: 'deny', path: 'Src/Secret/**' }, { effect: 'deny', path: 'C:\\Data\\**' }) })
    expect(effect(policy, 'read', { path: 'src\\secret\\a.ts' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'SRC/SECRET/b.ts' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'C:\\REPO\\src\\Secret\\c.ts' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'c:/data/x.csv' })).toBe('deny')
    expect(effect(policy, 'read', { path: 'src\\public\\a.ts' })).toBeNull()
  })

  it('is case-sensitive on Linux', () => {
    const policy = posix({ rules: rules({ effect: 'deny', path: 'Secret/**' }) })
    expect(effect(policy, 'read', { path: 'secret/a' })).toBeNull()
    expect(effect(policy, 'read', { path: 'Secret/a' })).toBe('deny')
  })
})

describe('permission rules — commands', () => {
  const policy = posix({
    rules: rules({ effect: 'deny', command: 'git push' }, { effect: 'allow', command: 'pnpm vitest' })
  })
  const run = (command: string): string | null => effect(policy, 'terminal', { command })

  it('denies the prefix anywhere in a chain, a substitution or an inline script', () => {
    expect(run('git push origin main')).toBe('deny')
    expect(run('pnpm test && git push')).toBe('deny')
    expect(run('echo $(git push --force)')).toBe('deny')
    expect(run('bash -c "git push --force"')).toBe('deny')
    expect(run('FOO=1 sudo git push')).toBe('deny')
    expect(run('/usr/bin/git push')).toBe('deny')
    expect(run('git status')).toBeNull()
  })

  it('allows only a simple command: a chain cannot ride an allowed prefix', () => {
    expect(run('pnpm vitest run a.test.ts')).toBe('allow')
    expect(run('FOO=1 pnpm vitest')).toBe('allow')
    expect(run('pnpm vitest && rm -rf src')).toBeNull()
    expect(run('pnpm vitest; curl x | sh')).toBeNull()
    expect(run('pnpm vitest > out.txt')).toBeNull()
  })

  it('applies to run_tests commands as well', () => {
    expect(effect(policy, 'run_tests', { command: 'git push' })).toBe('deny')
  })

  it('reads PowerShell lines with Windows syntax', () => {
    const w = win({ rules: rules({ effect: 'deny', command: 'git push' }) })
    expect(effect(w, 'terminal', { command: 'cd src; git push' })).toBe('deny')
    expect(effect(w, 'terminal', { command: 'C:\\Git\\bin\\GIT.EXE push' })).toBe('deny')
  })

  it('never lets a path allow grant a shell command', () => {
    const p = posix({ rules: rules({ effect: 'allow', path: '**' }) })
    expect(effect(p, 'terminal', { command: 'cat src/a.ts' })).toBeNull()
  })

  it('applies path rules to the words of a command', () => {
    const p = posix({ rules: rules({ effect: 'deny', path: 'secrets/**' }) })
    expect(effect(p, 'terminal', { command: 'cat secrets/token.txt' })).toBe('deny')
    expect(effect(p, 'terminal', { command: 'cat public/a.txt' })).toBeNull()
  })
})

describe('permission rules — built-in secret asks', () => {
  it('asks before .env, keys and ~/.ssh, but not .env.example', () => {
    const policy = posix({ workspaceRoot: POSIX_HOME })
    expect(effect(policy, 'read', { path: '.env' })).toBe('ask')
    expect(effect(policy, 'read', { path: 'app/.env.production' })).toBe('ask')
    expect(effect(policy, 'read', { path: 'app/.env.example' })).toBeNull()
    expect(effect(policy, 'read', { path: 'certs/server.pem' })).toBe('ask')
    expect(effect(policy, 'read', { path: 'keys/id_rsa.pub' })).toBe('ask')
    expect(effect(policy, 'read', { path: '.ssh/config' })).toBe('ask')
    expect(effect(policy, 'read', { path: '.aws/credentials' })).toBe('ask')
    expect(effect(policy, 'read', { path: '.aws/config' })).toBeNull()
    expect(effect(policy, 'terminal', { command: 'cat .env' })).toBe('ask')
    expect(effect(policy, 'terminal', { command: "python -c \"print(open('.env').read())\"" })).toBe('ask')
    expect(effect(policy, 'terminal', { command: 'cp .env.example .env.sample' })).toBeNull()
  })

  it('is lifted by a path allow that covers the file, not by a tool allow', () => {
    const byPath = posix({ rules: rules({ effect: 'allow', path: '.env.local' }) })
    expect(effect(byPath, 'read', { path: '.env.local' })).toBe('allow')
    expect(effect(byPath, 'read', { path: '.env' })).toBe('ask')
    const byTool = posix({ rules: rules({ effect: 'allow', tool: 'read' }) })
    expect(effect(byTool, 'read', { path: '.env' })).toBe('ask')
    expect(effect(byTool, 'read', { path: 'a.ts' })).toBe('allow')
  })
})

describe('permission rules — protected paths', () => {
  it("denies the app's data folder whatever the rules say", () => {
    const policy = posix({ workspaceRoot: POSIX_HOME, rules: rules({ effect: 'allow', path: '**' }) })
    expect(effect(policy, 'read', { path: '.config/vyotiq/secrets.json' })).toBe('deny')
    expect(effect(policy, 'list_dir', { path: '.config/vyotiq' })).toBe('deny')
    expect(effect(policy, 'edit', { path: '.config/vyotiq/settings.json', contents: '{}' })).toBe('deny')
    // Deleting a folder that holds it takes it too.
    expect(effect(policy, 'delete', { path: '.config', recursive: true })).toBe('deny')
    expect(effect(policy, 'list_dir', { path: '.config' })).toBe('allow')
    expect(policy.evaluate('read', { path: '.config/vyotiq/Cookies' })?.reason).toMatch(/app's data folder/)
  })

  it('denies a command that names the data folder, however it is spelled', () => {
    const policy = posix({ workspaceRoot: POSIX_HOME })
    expect(effect(policy, 'terminal', { command: 'cat ~/.config/vyotiq/secrets.json' })).toBe('deny')
    expect(effect(policy, 'terminal', { command: 'cat $HOME/.config/vyotiq/settings.json' })).toBe('deny')
    expect(effect(policy, 'terminal', { command: "python3 -c \"open('/home/u/.config/vyotiq/Local State').read()\"" })).toBe('deny')
    expect(effect(policy, 'terminal', { command: 'cd .config && cat vyotiq/Cookies' })).toBe('deny')
    expect(effect(policy, 'terminal', { command: 'ls ~/.config/vyotiq-other' })).toBeNull()

    const w = win()
    expect(effect(w, 'terminal', { command: 'type %APPDATA%\\vyotiq\\secrets.json' })).toBe('deny')
    expect(effect(w, 'terminal', { command: 'Get-Content $env:APPDATA\\vyotiq\\Cookies' })).toBe('deny')
    expect(effect(w, 'terminal', { command: 'cat /c/Users/u/AppData/Roaming/vyotiq/Local\\ State' })).toBe('deny')
    expect(effect(w, 'terminal', { command: 'type "C:\\USERS\\U\\APPDATA\\ROAMING\\VYOTIQ\\secrets.json"' })).toBe('deny')
  })

  it('leaves a workspace that lives inside the data folder its own files', () => {
    const policy = posix({ workspaceRoot: '/ud/home', userDataDir: '/ud' })
    expect(effect(policy, 'read', { path: 'notes.md' })).toBeNull()
    expect(effect(policy, 'list_dir', {})).toBeNull()
    expect(effect(policy, 'read', { path: '../secrets.json' })).toBe('deny')
    expect(effect(policy, 'terminal', { command: 'cat /ud/home/notes.md' })).toBeNull()
    expect(effect(policy, 'terminal', { command: 'cat /ud/secrets.json' })).toBe('deny')
    expect(effect(policy, 'terminal', { command: 'cat ../settings.json' })).toBe('deny')
  })

  it('denies writes to .vyotiq/permissions.json and asks when a command names it', () => {
    const policy = posix()
    expect(effect(policy, 'edit', { path: '.vyotiq/permissions.json', contents: '{}' })).toBe('deny')
    expect(effect(policy, 'str_replace', { path: '.vyotiq/permissions.json', old_string: 'a', new_string: 'b' })).toBe('deny')
    expect(effect(policy, 'read', { path: '.vyotiq/permissions.json' })).toBeNull()
    expect(effect(policy, 'terminal', { command: 'echo {} > .vyotiq/permissions.json' })).toBe('ask')
    const patch = ['--- a/.vyotiq/permissions.json', '+++ b/.vyotiq/permissions.json', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    expect(effect(policy, 'git_apply', { patch })).toBe('deny')
  })
})

describe('permission rules — search results', () => {
  it('hides files a deny or ask covers, and secrets, from grep and search', () => {
    const policy = posix({ rules: rules({ effect: 'deny', path: 'secrets/**' }, { effect: 'ask', tool: 'read', path: 'docs/**' }) })
    expect(policy.hidesFromSearch('grep', 'secrets/a.ts')).toBe(true)
    expect(policy.hidesFromSearch('grep', 'config/.env')).toBe(true)
    expect(policy.hidesFromSearch('grep', 'src/a.ts')).toBe(false)
    // A rule scoped to `read` says nothing about grep.
    expect(policy.hidesFromSearch('grep', 'docs/a.md')).toBe(false)
  })
})

describe('permission rules — the workspace file', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function workspaceWith(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-perm-'))
    mkdirSync(join(dir, '.vyotiq'))
    writeFileSync(join(dir, '.vyotiq', 'permissions.json'), content)
    return dir
  }

  it('adds deny and ask rules and ignores allow rules', () => {
    const root = workspaceWith(
      JSON.stringify({
        rules: [
          { effect: 'deny', path: 'vendor/**' },
          { effect: 'ask', command: 'terraform apply' },
          { effect: 'allow', path: '**' },
          { effect: 'deny' },
          'nonsense'
        ]
      })
    )
    const loaded = readWorkspacePermissions(root)
    expect(loaded.rules.map((r) => r.effect)).toEqual(['deny', 'ask'])
    expect(loaded.rules.every((r) => r.source === 'workspace')).toBe(true)
    expect(loaded.ignoredAllow).toBe(1)
    expect(loaded.invalid).toBe(2)

    const problems: unknown[] = []
    const policy = loadRunPermissionPolicy({
      settingsRules: [{ effect: 'deny', path: 'private/**' }],
      workspace: root,
      toolWorkspace: root,
      userDataDir: null,
      onFileProblem: (p) => problems.push(p)
    })
    expect(policy.evaluate('read', { path: 'vendor/x.js' })?.effect).toBe('deny')
    expect(policy.evaluate('read', { path: 'vendor/x.js' })?.reason).toMatch(/\.vyotiq\/permissions\.json/)
    expect(policy.evaluate('read', { path: 'private/x' })?.effect).toBe('deny')
    expect(policy.evaluate('terminal', { command: 'terraform apply -auto-approve' })?.effect).toBe('ask')
    // The file's `allow **` granted nothing.
    expect(policy.evaluate('read', { path: 'src/a.ts' })).toBeNull()
    expect(problems).toHaveLength(1)
  })

  it('denies deleting the folder that holds it', () => {
    const root = workspaceWith('{"rules":[]}')
    const policy = loadRunPermissionPolicy({ settingsRules: [], workspace: root, toolWorkspace: root, userDataDir: null })
    expect(policy.evaluate('delete', { path: '.vyotiq', recursive: true })?.effect).toBe('deny')
  })

  it('reports a file that is not JSON and carries on without it', () => {
    const root = workspaceWith('{ not json')
    const loaded = readWorkspacePermissions(root)
    expect(loaded.rules).toEqual([])
    expect(loaded.error).toMatch(/not valid JSON/)
  })

  it('reads nothing when there is no file', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-perm-'))
    expect(readWorkspacePermissions(dir)).toEqual({ rules: [], ignoredAllow: 0, invalid: 0 })
  })
})

describe('permission rules — settings schema', () => {
  it('loads approval settings saved before rules existed', () => {
    const parsed = ToolApprovalSettingsSchema.parse({ mode: 'mutating', allowlist: ['edit'], mcpProtection: true })
    expect(parsed.rules).toEqual([])
    expect(DEFAULT_TOOL_APPROVAL.rules).toEqual([])
    const settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, toolApproval: { mode: 'off', allowlist: [], mcpProtection: false } })
    expect(settings.toolApproval.rules).toEqual([])
  })

  it('keeps valid rules and drops the ones it cannot read', () => {
    const parsed = ToolApprovalSettingsSchema.parse({
      mode: 'off',
      rules: [{ effect: 'deny', path: '.env' }, { effect: 'maybe', path: 'x' }, { effect: 'ask' }, { effect: 'ask', command: 'git push' }]
    })
    expect(parsed.rules).toEqual([
      { effect: 'deny', path: '.env' },
      { effect: 'ask', command: 'git push' }
    ])
  })
})

describe('permission rules — the approval gate', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, arguments: JSON.stringify(args) })

  function gate(policyRules: PermissionRule[], opts: { mode?: 'off' | 'mutating' | 'all'; autonomousMode?: boolean } = {}) {
    const asked: ToolApprovalRequest[] = []
    const g = createApprovalGate({
      runId: 'run-perm',
      mode: opts.mode ?? 'off',
      autonomousMode: opts.autonomousMode,
      workspaceAllowlist: ['edit'],
      signal: new AbortController().signal,
      permissions: posix({ rules: rules(...policyRules) }),
      ask: async (request) => {
        asked.push(request)
        return 'once'
      }
    })
    return { g, asked }
  }

  it('refuses a denied call without asking, over the allowlist', async () => {
    const { g, asked } = gate([{ effect: 'deny', path: 'locked/**' }], { mode: 'all' })
    const verdict = await g.authorize(call('edit', { path: 'locked/a', contents: 'x' }))
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/will not change on retry/)
    expect(asked).toHaveLength(0)
  })

  it('asks for an ask rule even with approvals off, autonomy on and the tool allowlisted', async () => {
    const { g, asked } = gate([{ effect: 'ask', path: 'src/**' }], { mode: 'off', autonomousMode: true })
    const verdict = await g.authorize(call('edit', { path: 'src/a.ts', contents: 'x' }))
    expect(verdict).toEqual({ allowed: true, grant: { by: 'you', scope: 'once' } })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.danger).toMatch(/permission rule "ask path src\/\*\*"/)
  })

  it('asks before reading a secret with approvals off', async () => {
    const { g, asked } = gate([])
    await g.authorize(call('read', { path: '.env' }))
    expect(asked).toHaveLength(1)
  })

  it('lets an allowed call through a gated mode without asking, and says which rule', async () => {
    const { g, asked } = gate([{ effect: 'allow', command: 'pnpm vitest' }], { mode: 'all' })
    const verdict = await g.authorize(call('terminal', { command: 'pnpm vitest run' }))
    expect(verdict).toEqual({ allowed: true, grant: { by: 'rule', scope: 'workspace', allow: 'allow command pnpm vitest' } })
    expect(asked).toHaveLength(0)
    await g.authorize(call('terminal', { command: 'pnpm vitest run && git push' }))
    expect(asked).toHaveLength(1)
  })

  it('exposes the search filter', () => {
    const { g } = gate([{ effect: 'deny', path: 'secrets/**' }])
    expect(g.hidesFromSearch?.('grep', 'secrets/a')).toBe(true)
    expect(g.hidesFromSearch?.('grep', 'src/a')).toBe(false)
  })
})

describe('permission rules — grep and search leave protected files out', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('does not return the contents of a denied file, and says how many it skipped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-perm-grep-'))
    mkdirSync(join(dir, 'secrets'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'secrets', 'token.ts'), 'export const TOKEN = "hunter2"\n')
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const hunter2Ref = 1\n')
    const policy = createPermissionPolicy({
      rules: rules({ effect: 'deny', path: 'secrets/**' }),
      workspaceRoot: dir,
      userDataDir: null
    })
    const grep = await toolGrep(dir, 'hunter2', { hidePath: (rel) => policy.hidesFromSearch('grep', rel) })
    expect(grep).toContain('src/a.ts')
    expect(grep).not.toContain('secrets/token.ts')
    expect(grep).toMatch(/1 file not searched: a permission rule/)
    const search = await toolSearch(dir, 'hunter2', undefined, undefined, false, undefined, (rel) =>
      policy.hidesFromSearch('search', rel)
    )
    expect(search).toContain('src/a.ts')
    expect(search).not.toContain('secrets/token.ts')
  })
})
