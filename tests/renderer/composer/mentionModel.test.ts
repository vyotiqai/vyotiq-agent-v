/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildFileMentionItems,
  buildRootMentionItems,
  decodeMentionPayload,
  extractMentions,
  findActiveMentionToken,
  findSlashChipSubmit,
  insertMentionAtToken,
  isSafeWorkspaceRelPath,
  isAutoInjectedWorkspaceRule,
  mentionMarker,
  parseComposerDocument,
  serializeComposerDocument,
  composerDocumentPlainText,
  hasComposerContent
} from '@renderer/features/chat/components/composer/mentionModel'

describe('mentionModel', () => {
  it('round-trips file/branch/browser/chat markers', () => {
    const segments = [
      { type: 'text' as const, value: 'See ' },
      { type: 'mention' as const, mention: { kind: 'file' as const, path: 'src/a.ts' } },
      { type: 'text' as const, value: ' and ' },
      { type: 'mention' as const, mention: { kind: 'branch' as const, branch: 'main' } },
      { type: 'text' as const, value: ' ' },
      { type: 'mention' as const, mention: { kind: 'browser' as const } },
      { type: 'text' as const, value: ' ' },
      {
        type: 'mention' as const,
        mention: { kind: 'chat' as const, runId: 'r1', title: 'Prior work' }
      }
    ]
    const raw = serializeComposerDocument(segments)
    expect(parseComposerDocument(raw)).toEqual(segments)
    expect(extractMentions(raw)).toHaveLength(4)
    expect(composerDocumentPlainText(raw)).toContain('@a.ts')
    expect(hasComposerContent(raw)).toBe(true)
  })

  it('round-trips slash markers (skills/mcp/commands) and strips them for slash submit', () => {
    const marker = mentionMarker({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'code-review',
      commandId: 'skill:code-review'
    })
    expect(decodeMentionPayload(marker.slice(1, -1))).toEqual({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'code-review',
      commandId: 'skill:code-review'
    })
    expect(composerDocumentPlainText(`Run ${marker} please`)).toBe('Run /code-review please')
    expect(findSlashChipSubmit(`${marker} review the diff`)).toEqual({
      trigger: 'code-review',
      commandId: 'skill:code-review',
      slashKind: 'skill',
      trailingRaw: ' review the diff'
    })

    const mcp = mentionMarker({
      kind: 'slash',
      slashKind: 'mcp',
      trigger: 'server-tool',
      commandId: 'mcp:mcp__server__tool'
    })
    expect(decodeMentionPayload(mcp.slice(1, -1))?.kind).toBe('slash')
    expect(findSlashChipSubmit(`${mcp} args`)?.slashKind).toBe('mcp')

    // Legacy skill: payloads still decode.
    expect(
      decodeMentionPayload(`skill:${encodeURIComponent('legacy')}|${encodeURIComponent('skill:legacy')}`)
    ).toEqual({
      kind: 'slash',
      slashKind: 'skill',
      trigger: 'legacy',
      commandId: 'skill:legacy'
    })
  })

  it('decodes chat titles with encoding', () => {
    const marker = mentionMarker({ kind: 'chat', runId: 'abc', title: 'Hello & world' })
    const payload = marker.slice(1, -1)
    expect(decodeMentionPayload(payload)).toEqual({
      kind: 'chat',
      runId: 'abc',
      title: 'Hello & world'
    })
  })

  it('finds @ token and ignores caret inside markers', () => {
    const file = mentionMarker({ kind: 'file', path: 'x.ts' })
    const text = `${file} @foo`
    const token = findActiveMentionToken(text, text.length)
    expect(token).toEqual({ start: file.length + 1, end: text.length, query: 'foo' })
    expect(findActiveMentionToken(file, 2)).toBeNull()
  })

  it('inserts mention replacing @token', () => {
    const { nextText, nextCursor } = insertMentionAtToken('hi @ab', 3, 6, {
      kind: 'file',
      path: 'src/ab.ts'
    })
    expect(nextText.startsWith('hi ')).toBe(true)
    expect(extractMentions(nextText)[0]).toEqual({ kind: 'file', path: 'src/ab.ts' })
    expect(nextCursor).toBe(nextText.length)
  })

  it('builds root menu with categories and files', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: ['src/main/tools.ts'],
      matchingFiles: ['src/other.ts'],
      includeCodebase: true,
      branchName: 'feat/x'
    })
    expect(items.some((i) => i.kind === 'branch' && i.subtitle.includes('feat/x'))).toBe(true)
    expect(items.some((i) => i.kind === 'browser')).toBe(true)
    expect(items.some((i) => i.id === 'lints-typecheck' && i.kind === 'lints')).toBe(true)
    expect(items.some((i) => i.id === 'lints-lint' && i.kind === 'lints')).toBe(true)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'files')).toBe(true)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'docs')).toBe(true)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'rules')).toBe(true)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'chats')).toBe(true)
    expect(items.filter((i) => i.kind === 'file').length).toBeGreaterThan(0)
  })

  it('omits codebase rows when includeCodebase is false', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: ['src/a.ts'],
      matchingFiles: ['src/b.ts'],
      includeCodebase: false
    })
    expect(items.some((i) => i.kind === 'file')).toBe(false)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'files')).toBe(false)
    expect(items.some((i) => i.kind === 'nav' && i.view === 'docs')).toBe(false)
    expect(items.some((i) => i.kind === 'lints')).toBe(false)
    expect(items.some((i) => i.kind === 'branch')).toBe(true)
  })

  it('round-trips docs/rule/lints markers', () => {
    const segments = [
      { type: 'mention' as const, mention: { kind: 'docs' as const, path: 'docs/a.md' } },
      { type: 'text' as const, value: ' ' },
      { type: 'mention' as const, mention: { kind: 'rule' as const, path: '.cursor/rules/x.mdc' } },
      { type: 'text' as const, value: ' ' },
      {
        type: 'mention' as const,
        mention: { kind: 'lints' as const, diagnosticsKind: 'typecheck' as const }
      }
    ]
    const raw = serializeComposerDocument(segments)
    expect(parseComposerDocument(raw)).toEqual(segments)
    expect(decodeMentionPayload('lints:lint')).toEqual({
      kind: 'lints',
      diagnosticsKind: 'lint'
    })
  })

  it('rejects absolute and escape paths for file mentions', () => {
    expect(isSafeWorkspaceRelPath('src/a.ts')).toBe(true)
    expect(isSafeWorkspaceRelPath('../secret')).toBe(false)
    expect(isSafeWorkspaceRelPath('/etc/passwd')).toBe(false)
    expect(isSafeWorkspaceRelPath('C:\\Windows\\system.ini')).toBe(false)
    expect(decodeMentionPayload('file:../x')).toBeNull()
    expect(decodeMentionPayload('file:C:/Windows/x')).toBeNull()
    expect(buildFileMentionItems(['ok.ts', '../bad.ts', 'C:/x.ts'], 3, 3)).toEqual([
      {
        id: 'file:ok.ts',
        kind: 'file',
        path: 'ok.ts',
        label: 'ok.ts',
        subtitle: 'Workspace root'
      }
    ])
  })

  it('orders root as Context then Files then Browse', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: ['src/a.ts'],
      matchingFiles: [],
      includeCodebase: true,
      branchName: 'main'
    })
    const kinds = items.map((i) => i.kind)
    const firstFile = kinds.indexOf('file')
    const firstNav = kinds.indexOf('nav')
    expect(kinds[0]).toBe('branch')
    expect(firstFile).toBeGreaterThan(0)
    expect(firstNav).toBeGreaterThan(firstFile)
    expect(items.find((i) => i.kind === 'browser')?.subtitle).toBe(
      'Prefer browser tools this turn'
    )
    expect(items.find((i) => i.kind === 'nav' && i.view === 'files')?.subtitle).toBe(
      'Browse the workspace'
    )
  })

  it('filters root by query', () => {
    const items = buildRootMentionItems({
      query: 'branch',
      recentFiles: [],
      matchingFiles: []
    })
    expect(items.map((i) => i.kind)).toEqual(['branch'])
  })

  it('builds file items with show more', () => {
    const items = buildFileMentionItems(['a.ts', 'b.ts'], 50, 2)
    expect(items).toHaveLength(3)
    expect(items[2]).toMatchObject({ kind: 'show-more', remaining: 48 })
  })

  it('detects auto-injected vs requestable workspace rules', () => {
    expect(isAutoInjectedWorkspaceRule('AGENTS.md', '# hi')).toBe(true)
    expect(isAutoInjectedWorkspaceRule('.cursor/rules/x.mdc', 'plain body')).toBe(true)
    expect(
      isAutoInjectedWorkspaceRule(
        '.cursor/rules/x.mdc',
        '---\nalwaysApply: false\n---\nbody'
      )
    ).toBe(false)
    expect(
      isAutoInjectedWorkspaceRule(
        '.cursor/rules/y.mdc',
        '---\nalwaysApply: true\n---\nbody'
      )
    ).toBe(true)
  })
})
