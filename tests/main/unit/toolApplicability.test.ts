import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { dropInapplicableTools, mayHaveGitRemote } from '@main/agent/toolApplicability'

const names = (tools: Array<{ name: string }>): string[] => tools.map((t) => t.name)
const TOOLS = [
  'read',
  'mcp_list_tools',
  'request_mcp_tools',
  'mcp_get_prompt',
  'github_pr_create',
  'github_pr_checks',
  'github_issue',
  'edit_notebook'
].map((name) => ({ name }))

describe('tools that cannot work in this workspace', () => {
  it('keeps everything when each may apply', () => {
    expect(names(dropInapplicableTools(TOOLS, { mcpServers: true, gitRemote: true, notebooks: true }))).toEqual(names(TOOLS))
  })

  it('leaves off MCP server tools with no server, but keeps the loader the built-ins also use', () => {
    const kept = names(dropInapplicableTools(TOOLS, { mcpServers: false, gitRemote: true, notebooks: true }))
    expect(kept).not.toContain('mcp_list_tools')
    expect(kept).not.toContain('mcp_get_prompt')
    expect(kept).toContain('request_mcp_tools')
  })

  it('leaves off the GitHub read tools with no remote, but keeps PR create, which sets one up', () => {
    const kept = names(dropInapplicableTools(TOOLS, { mcpServers: true, gitRemote: false, notebooks: true }))
    expect(kept).not.toContain('github_pr_checks')
    expect(kept).not.toContain('github_issue')
    expect(kept).toContain('github_pr_create')
  })

  it('leaves off edit_notebook with no notebook', () => {
    expect(names(dropInapplicableTools(TOOLS, { mcpServers: true, gitRemote: true, notebooks: false }))).not.toContain('edit_notebook')
  })
})

describe('mayHaveGitRemote', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-tool-applies-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads remotes from the git config, without a git process', () => {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]\n\tbare = false\n', 'utf8')
    expect(mayHaveGitRemote(root)).toBe(false)
    writeFileSync(join(root, '.git', 'config'), '[core]\n[remote "origin"]\n\turl = git@ghe.example.com:a/b.git\n', 'utf8')
    expect(mayHaveGitRemote(root)).toBe(true)
  })

  it('follows a worktree to the common git dir', () => {
    const main = join(root, 'main')
    const gitDir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/a/b\n', 'utf8')
    writeFileSync(join(gitDir, 'commondir'), '../..\n', 'utf8')
    const wt = join(root, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
    expect(mayHaveGitRemote(wt)).toBe(true)
  })

  it('has no remote outside a repository', () => {
    expect(mayHaveGitRemote(root)).toBe(false)
  })
})
