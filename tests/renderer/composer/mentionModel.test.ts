/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildFileMentionItems,
  buildRootMentionItems,
  classifyWorkspacePath,
  decodeMentionPayload,
  extractMentions,
  findActiveMentionToken,
  findSlashChipSubmit,
  insertMentionAtToken,
  isFolderPathInSet,
  isSafeWorkspaceRelPath,
  isAutoInjectedWorkspaceRule,
  mentionLabel,
  mentionMarker,
  mergeSuggestedPaths,
  parseComposerDocument,
  serializeComposerDocument,
  composerDocumentPlainText,
  hasComposerContent
} from '@renderer/features/chat/components/composer/mentionModel'
import { RULE_APPLY_CASES } from '../../helpers/ruleFrontmatterCases'

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
  })

  it('says what each context row attaches, and when', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: [],
      matchingFiles: [],
      includeCodebase: true,
      branchName: 'feat/stream-backpressure'
    })
    expect(items.filter((i) => i.kind !== 'nav').map((i) => [i.label, 'subtitle' in i ? i.subtitle : null])).toEqual([
      ['Branch diff', 'what feat/stream-backpressure changed, uncommitted included'],
      ['Typecheck errors', 'checked when you send'],
      ['Lint problems', 'checked when you send'],
      ['Browser page', 'prefer browser tools this instruction']
    ])
    expect(items.filter((i) => i.kind === 'nav').map((i) => i.label)).toEqual([
      'Files and folders',
      'Docs',
      'Rules',
      'Past tasks'
    ])
    // A detached head has no branch to name.
    const detached = buildRootMentionItems({ query: '', recentFiles: [], matchingFiles: [], branchName: 'HEAD' })
    expect(detached.find((i) => i.kind === 'branch')).toMatchObject({ subtitle: 'uncommitted changes' })
  })

  it('lists search rows on a bare @ too, with recents before matches', () => {
    // A bare @ used to list no file rows at all: the search did not run for an
    // empty query, so a cold composer showed only Context and Browse. It now
    // shows what the search returned for the empty query.
    const idle = buildRootMentionItems({
      query: '',
      recentFiles: [],
      matchingFiles: ['.eslintrc.cjs', '.github/ci.yml'],
      includeCodebase: true
    })
    expect(idle.filter((i) => i.kind === 'file').map((i) => i.label)).toEqual([
      '.eslintrc.cjs',
      'ci.yml'
    ])

    const recentsFirst = buildRootMentionItems({
      query: 'sse',
      recentFiles: ['src/main/net/sseReader.ts', 'src/other.ts'],
      matchingFiles: ['src/main/net/sseReader.ts', 'tests/main/unit/sseBackpressure.test.ts'],
      includeCodebase: true
    })
    expect(recentsFirst.filter((i) => i.kind === 'file').map((i) => i.label)).toEqual([
      'sseReader.ts',
      'sseBackpressure.test.ts'
    ])
  })

  it('round-trips folder markers and rejects unsafe folder payloads', () => {
    const segments = [
      { type: 'text' as const, value: 'Fix ' },
      {
        type: 'mention' as const,
        mention: { kind: 'folder' as const, path: 'src/components/composer' }
      }
    ]
    const raw = serializeComposerDocument(segments)
    expect(parseComposerDocument(raw)).toEqual(segments)
    expect(extractMentions(raw)).toEqual([
      { kind: 'folder', path: 'src/components/composer' }
    ])
    expect(composerDocumentPlainText(raw)).toBe('Fix @composer')
    expect(mentionLabel({ kind: 'folder', path: 'src/components/composer' })).toBe('composer')
    expect(decodeMentionPayload('folder:../x')).toBeNull()
    expect(decodeMentionPayload('folder:/etc')).toBeNull()
    expect(decodeMentionPayload('folder:C:/Windows/x')).toBeNull()
  })

  it('classifies a path as a folder when another returned path lives under it', () => {
    const paths = ['src', 'src/a.ts', 'src/deep/b.ts', 'README.md']
    expect(isFolderPathInSet(paths, 'src')).toBe(true)
    expect(isFolderPathInSet(paths, 'src/deep')).toBe(true)
    expect(isFolderPathInSet(paths, 'src/a.ts')).toBe(false)
    expect(isFolderPathInSet(paths, 'README.md')).toBe(false)
    // A directory with nothing beneath it in the page reads as a file.
    expect(isFolderPathInSet(['src'], 'src')).toBe(false)
    expect(classifyWorkspacePath('src/deep', paths)).toBe('folder')
    expect(classifyWorkspacePath('README.md', paths)).toBe('file')
  })

  it('takes a folder from the list main sent even with nothing under it in the page', () => {
    // The inference above cannot see an empty page under a folder; main can.
    expect(classifyWorkspacePath('src', ['src'], new Set(['src']))).toBe('folder')
    const items = buildFileMentionItems(['README.md'], 1, 1, { paths: ['src'], query: '' })
    expect(items.map((i) => i.id)).toEqual(['file:README.md', 'folder:src'])
  })

  it('leads with a folder named like the query, then files, then other folders', () => {
    expect(
      mergeSuggestedPaths(['src/comp.ts', 'lib/a.ts'], ['src/composer', 'old/xcomp'], 'comp')
    ).toEqual(['src/composer', 'src/comp.ts', 'lib/a.ts', 'old/xcomp'])
    // With nothing typed there is no name to match: files keep the top.
    expect(mergeSuggestedPaths(['a.ts'], ['src'], '')).toEqual(['a.ts', 'src'])
  })

  it('builds a folder row for a directory in the files view', () => {
    const items = buildFileMentionItems(['src/components', 'src/components/composer/a.ts'], 2, 2)
    expect(items).toEqual([
      {
        id: 'folder:src/components',
        kind: 'folder',
        path: 'src/components',
        label: 'components',
        subtitle: 'src'
      },
      {
        id: 'file:src/components/composer/a.ts',
        kind: 'file',
        path: 'src/components/composer/a.ts',
        label: 'a.ts',
        subtitle: 'src/components/composer'
      }
    ])
  })

  it('lists a folder row at the root from a bare @ search', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: [],
      matchingFiles: ['src/components', 'src/components/composer/a.ts'],
      includeCodebase: true
    })
    const folderRow = items.find((i) => i.kind === 'folder')
    expect(folderRow).toMatchObject({
      id: 'folder:src/components',
      path: 'src/components',
      label: 'components',
      subtitle: 'src'
    })
  })

  it('lists recent matches before search results once something is typed', () => {
    const typed = buildRootMentionItems({
      query: 'sse',
      recentFiles: ['src/main/net/sseReader.ts', 'src/other.ts'],
      matchingFiles: ['src/main/net/sseReader.ts', 'tests/main/unit/sseBackpressure.test.ts'],
      includeCodebase: true
    })
    expect(typed.filter((i) => i.kind === 'file').map((i) => i.label)).toEqual([
      'sseReader.ts',
      'sseBackpressure.test.ts'
    ])
  })

  it('finds Past tasks by "tasks"', () => {
    const items = buildRootMentionItems({ query: 'tasks', recentFiles: [], matchingFiles: [] })
    expect(items.map((i) => i.label)).toEqual(['Past tasks'])
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

  it('agrees with the agent rule list on every frontmatter shape', () => {
    // Same table tests/shared/ruleFrontmatter.test.ts runs through
    // listWorkspaceRulesForMention; the two used to be hand-synced copies.
    for (const { file, raw, applies } of RULE_APPLY_CASES) {
      const path = `.vyotiq/rules/${file}`
      expect(isAutoInjectedWorkspaceRule(path, raw), path).toBe(applies)
    }
    // Root files are injected as-is, so an alwaysApply: false in one is ignored.
    expect(isAutoInjectedWorkspaceRule('AGENTS.md', '---\nalwaysApply: false\n---\nx')).toBe(true)
  })
})
