import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readGitDiff } from '@main/git/git'
import {
  isCuratedDocPath,
  isSafeWorkspaceRelPath
} from '@shared/utils/workspacePath'
import { canGit } from '../../helpers/canGit'

describe('workspacePath mention safety', () => {
  it('accepts relative workspace paths and rejects escapes', () => {
    expect(isSafeWorkspaceRelPath('src/a.ts')).toBe(true)
    expect(isSafeWorkspaceRelPath('docs/guide.md')).toBe(true)
    expect(isSafeWorkspaceRelPath('../secret')).toBe(false)
    expect(isSafeWorkspaceRelPath('/etc/passwd')).toBe(false)
    expect(isSafeWorkspaceRelPath('')).toBe(false)
  })

  it('curates docs for @-Docs', () => {
    expect(isCuratedDocPath('README.md')).toBe(true)
    expect(isCuratedDocPath('docs/guide.md')).toBe(true)
    expect(isCuratedDocPath('AGENTS.md')).toBe(true)
    expect(isCuratedDocPath('src/main.ts')).toBe(false)
    expect(isCuratedDocPath('docs/binary.bin')).toBe(false)
  })
})

describe('readGitDiff for mention IPC', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-git-diff-'))
  })

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
  }

  it('fails clearly outside a git repo', async () => {
    const result = await readGitDiff(workspace)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Not a git repository')
  })

  it.skipIf(!canGit)('returns unified diff for a dirty tracked file', async () => {
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(workspace, 'kept.txt'), 'one\n', 'utf8')
    git('add', '-A')
    git('commit', '-m', 'init')
    writeFileSync(join(workspace, 'kept.txt'), 'one\ntwo\n', 'utf8')

    const result = await readGitDiff(workspace, { path: 'kept.txt' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.content).toMatch(/\+two|@@/)
  })
})
