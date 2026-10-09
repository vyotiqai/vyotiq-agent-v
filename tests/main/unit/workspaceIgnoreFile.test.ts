import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRunPermissionPolicy, readWorkspaceIgnoreRules } from '@main/agent/permissions'

let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function workspace(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-ignore-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  return root
}

describe('workspace ignore files', () => {
  it('reads .vyotiqignore, .aiignore and .cursorignore as deny rules', () => {
    const ws = workspace({
      '.vyotiqignore': '# secrets\n.env\n/fixtures/\n\n!keep.txt\n',
      '.aiignore': 'data/**\n.env\n',
      '.cursorignore': '*.pem\n'
    })
    expect(readWorkspaceIgnoreRules(ws)).toEqual([
      { effect: 'deny', path: '.env', source: 'ignore' },
      { effect: 'deny', path: 'fixtures', source: 'ignore' },
      { effect: 'deny', path: 'data/**', source: 'ignore' },
      { effect: 'deny', path: '*.pem', source: 'ignore' }
    ])
  })

  it('keeps the agent out of ignored paths and says why', () => {
    const ws = workspace({ '.vyotiqignore': 'secrets\n*.pem\n' })
    const policy = loadRunPermissionPolicy({ settingsRules: [], workspace: ws, toolWorkspace: ws, userDataDir: null })
    const verdict = policy.evaluate('read', { path: 'config/secrets/prod.json' })
    expect(verdict?.effect).toBe('deny')
    expect(verdict?.reason).toMatch(/ignore file/)
    expect(policy.evaluate('read', { path: 'certs/server.pem' })?.effect).toBe('deny')
    expect(policy.evaluate('read', { path: 'src/a.ts' })).toBeNull()
    expect(policy.hidesFromSearch('grep', 'config/secrets/prod.json')).toBe(true)
    expect(policy.hidesFromSearch('grep', 'src/a.ts')).toBe(false)
  })

  it('does not let the agent change an ignore file', () => {
    const ws = workspace({ '.vyotiqignore': 'secrets\n' })
    const policy = loadRunPermissionPolicy({ settingsRules: [], workspace: ws, toolWorkspace: ws, userDataDir: null })
    expect(policy.evaluate('edit', { path: '.vyotiqignore', contents: '' })?.effect).toBe('deny')
    expect(policy.evaluate('edit', { path: '.aiignore', contents: '' })?.effect).toBe('deny')
    expect(policy.evaluate('read', { path: '.vyotiqignore' })).toBeNull()
  })
})
