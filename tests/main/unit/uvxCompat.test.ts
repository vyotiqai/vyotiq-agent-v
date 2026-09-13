import { describe, expect, it } from 'vitest'
import {
  gitMcpNotARepoMessage,
  hasUvxMcpWithConstraint,
  isGitMcpNotARepoError,
  isGitMcpServer,
  withCompatibleUvxArgs,
  withWorkspaceRepositoryArgs
} from '@main/agent/mcp/uvxCompat'

describe('withCompatibleUvxArgs', () => {
  it('pins mcp<2 for mcp-server-fetch', () => {
    expect(withCompatibleUvxArgs('uvx', ['mcp-server-fetch'])).toEqual([
      '--with',
      'mcp<2',
      'mcp-server-fetch'
    ])
  })

  it('pins mcp<2 for mcp-server-time', () => {
    expect(withCompatibleUvxArgs('uvx', ['mcp-server-time'])).toEqual([
      '--with',
      'mcp<2',
      'mcp-server-time'
    ])
  })

  it('does not double-pin when --with mcp is already present', () => {
    expect(withCompatibleUvxArgs('uvx', ['--with', 'mcp==1.9.4', 'mcp-server-fetch'])).toEqual([
      '--with',
      'mcp==1.9.4',
      'mcp-server-fetch'
    ])
  })

  it('leaves unrelated uvx packages alone', () => {
    expect(withCompatibleUvxArgs('uvx', ['mcp-server-git', '--repository', '.'])).toEqual([
      'mcp-server-git',
      '--repository',
      '.'
    ])
  })

  it('leaves non-uvx commands alone', () => {
    expect(withCompatibleUvxArgs('npx', ['mcp-server-fetch'])).toEqual(['mcp-server-fetch'])
  })
})

describe('withWorkspaceRepositoryArgs', () => {
  it('rewrites --repository . to an absolute workspace path', () => {
    expect(
      withWorkspaceRepositoryArgs(
        ['--with', 'mcp<2', 'mcp-server-git', '--repository', '.'],
        'C:\\Users\\admin\\Documents\\new-project'
      )
    ).toEqual([
      '--with',
      'mcp<2',
      'mcp-server-git',
      '--repository',
      'C:\\Users\\admin\\Documents\\new-project'
    ])
  })

  it('leaves absolute repository paths unchanged', () => {
    expect(
      withWorkspaceRepositoryArgs(
        ['mcp-server-git', '--repository', '/tmp/repo'],
        '/workspace'
      )
    ).toEqual(['mcp-server-git', '--repository', '/tmp/repo'])
  })

  it('no-ops without a workspace path', () => {
    expect(withWorkspaceRepositoryArgs(['mcp-server-git', '--repository', '.'], null)).toEqual([
      'mcp-server-git',
      '--repository',
      '.'
    ])
  })
})

describe('hasUvxMcpWithConstraint', () => {
  it('detects --with mcp constraints', () => {
    expect(hasUvxMcpWithConstraint(['--with', 'mcp<2', 'mcp-server-fetch'])).toBe(true)
    expect(hasUvxMcpWithConstraint(['mcp-server-fetch'])).toBe(false)
  })
})

describe('isGitMcpServer', () => {
  it('matches marketplace id git', () => {
    expect(isGitMcpServer({ id: 'git', args: [] })).toBe(true)
    expect(isGitMcpServer({ id: 'Git', args: ['something'] })).toBe(true)
  })

  it('matches mcp-server-git in args regardless of id', () => {
    expect(
      isGitMcpServer({
        id: 'custom-git',
        args: ['--with', 'mcp<2', 'mcp-server-git', '--repository', '.']
      })
    ).toBe(true)
  })

  it('does not match unrelated servers', () => {
    expect(isGitMcpServer({ id: 'fetch', args: ['mcp-server-fetch'] })).toBe(false)
    expect(isGitMcpServer({ id: 'github', args: ['@modelcontextprotocol/server-github'] })).toBe(
      false
    )
  })
})

describe('isGitMcpNotARepoError', () => {
  it('matches preflight and native mcp-server-git messages', () => {
    expect(isGitMcpNotARepoError(gitMcpNotARepoMessage('C:\\tmp\\proj'))).toBe(true)
    expect(isGitMcpNotARepoError('/tmp/proj is not a valid Git repository')).toBe(true)
    expect(isGitMcpNotARepoError('fatal: not a git repository')).toBe(true)
    expect(isGitMcpNotARepoError('spawn uvx ENOENT')).toBe(false)
  })
})
