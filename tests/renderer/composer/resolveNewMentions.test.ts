/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveComposerMentions } from '@renderer/features/chat/components/composer/resolveMentions'
import { mentionMarker, type ComposerMention } from '@renderer/features/chat/components/composer/mentionModel'
import { getPtyOutputBuffers } from '@renderer/features/chat/components/ptyOutputBuffers'

/** Uncommitted changes, terminal output, a commit, a URL, an issue or PR, and a symbol, expanded on send. */

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    onPtyData: vi.fn(() => () => {}),
    gitDiff: vi.fn(async (req: { sha?: string; vsHead?: boolean }) => ({
      ok: true,
      data: { content: req.sha ? `diff for ${req.sha}` : 'diff --git a/x b/x\n+new line' }
    })),
    composerFetchUrl: vi.fn(async () => ({ ok: true, data: { content: 'Fetched https://example.com/ … page text' } })),
    githubIssueView: vi.fn(async () => ({ ok: false, error: 'Could not resolve to an issue' })),
    prView: vi.fn(async () => ({
      ok: true,
      data: {
        number: 9,
        title: 'Add a thing',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'feat',
        baseRefName: 'main',
        additions: 3,
        deletions: 1,
        url: 'https://github.com/o/r/pull/9',
        body: 'Why it matters',
        files: [{ path: 'a.ts', additions: 3, deletions: 1 }]
      }
    })),
    workspaceGrep: vi.fn(async () => ({ ok: true, data: { hits: [{ path: 'src/row.tsx', line: 3, text: 'function ToolRow() {' }], truncated: false } })),
    workspaceReadText: vi.fn(async () => ({
      ok: true,
      data: { name: 'row.tsx', mime: 'text/plain', text: 'a\nb\nfunction ToolRow() {\n  return 1\n}\n', truncated: false }
    }))
  }
  window.vyotiq = api as unknown as typeof window.vyotiq
  getPtyOutputBuffers().clear()
})

async function send(mention: ComposerMention): Promise<{ text: string; error: string | null }> {
  return resolveComposerMentions({ workspacePath: '/ws', draft: `look ${mentionMarker(mention)}`, existingFiles: [] })
}

describe('new @-mentions', () => {
  it('attaches the uncommitted diff and a commit', async () => {
    expect((await send({ kind: 'changes' })).text).toContain('+new line')
    expect(api.gitDiff).toHaveBeenCalledWith({ workspacePath: '/ws', vsHead: true })
    const commit = await send({ kind: 'commit', sha: 'abc1234', subject: 'fix it' })
    expect(commit.text).toContain('## Referenced commit abc1234: fix it')
    expect(commit.text).toContain('diff for abc1234')
  })

  it('attaches the end of the terminal output without its escape codes', async () => {
    expect((await send({ kind: 'terminal' })).error).toMatch(/No terminal output/)
    getPtyOutputBuffers().set('s1', '\u001b[32mPS C:\\ws>\u001b[0m pnpm test\r\nError: boom\r\n')
    const res = await send({ kind: 'terminal' })
    expect(res.text).toContain('PS C:\\ws> pnpm test\nError: boom')
    expect(res.text).not.toContain('\u001b')
  })

  it('reads a page, and falls back from an issue to a pull request', async () => {
    expect((await send({ kind: 'url', url: 'https://example.com/' })).text).toContain('page text')
    const pr = await send({ kind: 'issue', number: 9 })
    expect(api.prView).toHaveBeenCalledWith('/ws', 9)
    expect(pr.text).toContain('## Referenced pull request #9: Add a thing')
    expect(pr.text).toContain('- a.ts (+3 −1)')
  })

  it('finds where a symbol is defined and quotes it', async () => {
    const res = await send({ kind: 'symbol', name: 'ToolRow' })
    expect(res.text).toContain('## Referenced symbol ToolRow — src/row.tsx:3')
    expect(res.text).toContain('function ToolRow() {')
    api.workspaceGrep!.mockResolvedValueOnce({ ok: true, data: { hits: [], truncated: false } })
    expect((await send({ kind: 'symbol', name: 'Missing_Thing' })).error).toMatch(/No definition of Missing_Thing/)
  })
})
