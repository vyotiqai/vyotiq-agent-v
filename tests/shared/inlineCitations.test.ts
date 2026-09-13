import { describe, expect, it } from 'vitest'
import { VY_FILE_HREF_PREFIX } from '@shared/utils/linkableWorkspacePath'
import {
  collectCitationCatalog,
  formatCitationsForCopy,
  resolveInlineCitations
} from '@shared/utils/inlineCitations'

const FILE = 'src/main/agent/loop.ts'

describe('collectCitationCatalog', () => {
  it('collects read paths from args even without content', () => {
    const catalog = collectCitationCatalog([
      { name: 'read', argsPreview: JSON.stringify({ path: FILE }) }
    ])
    expect(catalog).toEqual([{ kind: 'file', path: FILE }])
  })

  it('collects grep, search, and codebase_search paths from result text', () => {
    const catalog = collectCitationCatalog([
      { name: 'grep', content: `${FILE}:42: return early\n> 41| prev` },
      { name: 'search', content: 'file: src/foo.ts\nsrc/bar.ts:9: hit\nindex=trigram' },
      {
        name: 'codebase_search',
        content: '1. src/main/agent/harness.ts:10-20 [function loadHarness] score=0.9\nsnippet'
      }
    ])
    const paths = catalog.filter((e) => e.kind === 'file').map((e) => e.path)
    expect(paths).toEqual([FILE, 'src/foo.ts', 'src/bar.ts', 'src/main/agent/harness.ts'])
  })

  it('collects grep context headers without a third colon', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'grep',
        content: `${FILE}:42\n> 42| return early\n  41| src/leaked.ts:3: not a header\n`
      }
    ])
    expect(catalog).toEqual([{ kind: 'file', path: FILE }])
  })

  it('does not ingest paths from a read file body', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'read',
        argsPreview: JSON.stringify({ path: FILE }),
        content: 'src/leaked.ts:12: should not be citable\nfile: src/also-leaked.ts'
      }
    ])
    expect(catalog).toEqual([{ kind: 'file', path: FILE }])
  })

  it('ignores failed tools even when args still have a path', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'read',
        status: 'fail',
        argsPreview: JSON.stringify({ path: FILE }),
        content: 'File not found'
      }
    ])
    expect(catalog).toEqual([])
  })

  it('does not ingest snippet lines from codebase_search', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'codebase_search',
        content:
          '1. src/main/agent/harness.ts:10-20 [function loadHarness] score=0.9\nsrc/leaked.ts:3: not a hit header'
      }
    ])
    expect(catalog).toEqual([{ kind: 'file', path: 'src/main/agent/harness.ts' }])
  })

  it('ignores glob and list_dir', () => {
    const catalog = collectCitationCatalog([
      { name: 'glob', content: `${FILE}\nsrc/foo.ts` },
      { name: 'list_dir', argsPreview: JSON.stringify({ path: 'src' }), content: 'loop.ts' }
    ])
    expect(catalog).toEqual([])
  })

  it('collects http(s) URLs from navigate args and snapshot headers', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'browser_navigate',
        argsPreview: JSON.stringify({ url: 'https://example.com/docs/' })
      },
      {
        name: 'browser_snapshot',
        content: 'URL: https://example.com/docs#section\nTitle: Docs'
      },
      {
        name: 'browser_search',
        content: 'Navigated to https://search.example/q\nURL: https://search.example/q'
      }
    ])
    const urls = catalog.filter((e) => e.kind === 'url')
    expect(urls).toHaveLength(2)
    expect(urls[0]?.key).toBe('https://example.com/docs')
    expect(urls[1]?.key).toBe('https://search.example/q')
  })

  it('rejects URLs with userinfo', () => {
    const catalog = collectCitationCatalog([
      {
        name: 'browser_navigate',
        argsPreview: JSON.stringify({ url: 'https://user:pass@example.com/a' })
      }
    ])
    expect(catalog).toEqual([])
  })
})

describe('resolveInlineCitations', () => {
  const catalog = collectCitationCatalog([
    { name: 'read', argsPreview: JSON.stringify({ path: FILE }) },
    {
      name: 'browser_navigate',
      argsPreview: JSON.stringify({ url: 'https://example.com/a' })
    }
  ])

  it('rewrites resolved file markers to vy-file links and strips unknown ones', () => {
    const { markdown } = resolveInlineCitations(
      `Early return [[${FILE}:42]]. See also [[https://example.com/a]] and [[src/secret.ts]].`,
      catalog
    )
    expect(markdown).toBe(
      `Early return [${FILE}:42](${VY_FILE_HREF_PREFIX}${FILE}:42). See also [example.com/a](https://example.com/a) and .`
    )
    expect(markdown).not.toContain('[[')
    expect(markdown).not.toContain('#vy-cite:')
  })

  it('strips redundant file markers when the path is already shown on the line', () => {
    const { markdown } = resolveInlineCitations(
      `* ` + '`AGENTS.md` explicitly defines rules [[AGENTS.md]]',
      collectCitationCatalog([
        { name: 'read', argsPreview: JSON.stringify({ path: 'AGENTS.md' }) }
      ])
    )
    expect(markdown).toBe('* `AGENTS.md` explicitly defines rules ')
    expect(markdown).not.toContain('#vy-file:')
  })

  it('emits one vy-file link per distinct path when markers are not redundant', () => {
    const { markdown } = resolveInlineCitations(
      `A [[${FILE}:10]] then B [[${FILE}:80]].`,
      catalog
    )
    expect(markdown).toBe(
      `A [${FILE}:10](${VY_FILE_HREF_PREFIX}${FILE}:10) then B [${FILE}:80](${VY_FILE_HREF_PREFIX}${FILE}:80).`
    )
  })

  it('leaves markers inside fences and inline code', () => {
    const fenced = `Prose [[${FILE}:1]]\n\n\`\`\`\n[[${FILE}:1]]\n\`\`\`\n\nAnd \`[[${FILE}:1]]\`.`
    const { markdown } = resolveInlineCitations(fenced, catalog)
    expect(markdown).toContain(`[${FILE}:1](${VY_FILE_HREF_PREFIX}${FILE}:1)`)
    expect(markdown).toContain('```\n[[src/main/agent/loop.ts:1]]\n```')
    expect(markdown).toContain('`[[src/main/agent/loop.ts:1]]`')
  })

  it('strips an unclosed marker at the end of prose', () => {
    const { markdown } = resolveInlineCitations(`Checking [[${FILE}`, catalog)
    expect(markdown).toBe('Checking ')
    expect(markdown).not.toContain('[[')
  })

  it('matches URLs ignoring trailing slash and hash', () => {
    const { markdown } = resolveInlineCitations('Docs [[https://example.com/a/]]', catalog)
    expect(markdown).toBe('Docs [example.com/a](https://example.com/a)')
  })

  it('strips http URL markers', () => {
    const { markdown } = resolveInlineCitations('See [[http://example.com/a]].', [
      {
        name: 'browser_navigate',
        argsPreview: JSON.stringify({ url: 'http://example.com/a' })
      }
    ])
    expect(markdown).toBe('See .')
  })
})

describe('formatCitationsForCopy', () => {
  it('uses plain paths and URLs without a Sources footer', () => {
    const catalog = collectCitationCatalog([
      { name: 'read', argsPreview: JSON.stringify({ path: FILE }) }
    ])
    const copied = formatCitationsForCopy(`Returns early [[${FILE}:42]].`, catalog)
    expect(copied).toBe(`Returns early ${FILE}:42.`)
    expect(copied).not.toContain('[[')
    expect(copied).not.toContain('Sources:')
  })

  it('returns prose unchanged when nothing resolved', () => {
    expect(formatCitationsForCopy('No cites here.', [])).toBe('No cites here.')
  })
})
