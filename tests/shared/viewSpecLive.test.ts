import { describe, expect, it } from 'vitest'
import { parseViewSpec, viewDrops, VIEW_SPEC_MAX_CHARS } from '@shared/viewSpec'
import { viewBlockLines } from '@shared/viewText'
import { VIEW_DO_ACTIONS, VIEW_SOURCE_IDS, describeViewDo, describeViewSources } from '@shared/viewSources'
import { normalizeAskQuestionArgs } from '@shared/utils/agentQuestionForm'

const view = (blocks: unknown[]): string => JSON.stringify({ id: 'v', title: 'View', blocks })
const blocksOf = (blocks: unknown[]) => parseViewSpec(view(blocks))?.blocks ?? []

describe('a live block', () => {
  it('names one of the app’s sources', () => {
    expect(blocksOf([{ type: 'live', source: 'git.changes', limit: '5', title: 'Uncommitted' }])).toEqual([
      { type: 'live', source: 'git.changes', limit: 5, title: 'Uncommitted' }
    ])
  })

  it('reads the names models use for a source', () => {
    const sources = blocksOf(['changes', 'git_log', 'CI', 'spend', 'usage-days', 'task files'].map((source) => ({ type: 'live', source }))).map((b) => (b.type === 'live' ? b.source : null))
    expect(sources).toEqual(['git.changes', 'git.commits', 'pr.checks', 'usage.spend', 'usage.days', 'task.changes'])
  })

  it('is what a block that names a source is, whatever type it was given', () => {
    expect(blocksOf([{ type: 'rows', source: 'git.changes' }])).toEqual([{ type: 'live', source: 'git.changes' }])
  })

  it('is dropped when its source is not one the app reads', () => {
    expect(blocksOf([{ type: 'live', source: 'jira.tickets' }, { type: 'note', text: 'kept' }])).toEqual([{ type: 'note', text: 'kept' }])
  })
})

describe('a click that the app carries out (do)', () => {
  const doOf = (d: unknown) => {
    const b = blocksOf([{ type: 'actions', actions: [{ label: 'Go', do: d }] }])[0]
    return b?.type === 'actions' ? b.actions[0]?.do : undefined
  }

  it('reads action, type or kind, and one path where paths are meant', () => {
    expect(doOf({ type: 'diff', path: 'src/a.ts' })).toEqual({ action: 'diff', path: 'src/a.ts' })
    expect(doOf({ kind: 'Stage', path: 'src/a.ts' })).toEqual({ action: 'stage', paths: ['src/a.ts'] })
    expect(doOf({ action: 'panel', tab: 'pr' })).toEqual({ action: 'panel', panel: 'pr' })
    expect(doOf({ action: 'run', cmd: 'pnpm test' })).toEqual({ action: 'run', command: 'pnpm test' })
  })

  it('opens only a web page, never another scheme', () => {
    expect(doOf({ action: 'link', url: 'https://github.com/o/r/actions' })).toEqual({ action: 'link', url: 'https://github.com/o/r/actions' })
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'http://plain.example', 'vyotiq://open']) expect(doOf({ action: 'link', url })).toBeUndefined()
  })

  it('is only one of the app’s actions, on a panel it has', () => {
    expect(doOf({ action: 'delete', path: 'x' })).toBeUndefined()
    expect(doOf({ action: 'panel', panel: 'settings' })).toBeUndefined()
  })

  it('makes a button on its own, without words for the agent; a button with neither is dropped', () => {
    const b = blocksOf([{ type: 'actions', actions: [{ label: 'Open diff', do: { action: 'diff', path: 'a.ts' } }, { label: 'Nothing' }] }])[0]
    expect(b?.type === 'actions' && b.actions.map((a) => a.label)).toEqual(['Open diff'])
  })

  it('rides on a row, a stat and a table row too', () => {
    const d = { action: 'open', path: 'a.ts' }
    const [rows, stats, table] = blocksOf([
      { type: 'rows', items: [{ title: 'a.ts', do: d }] },
      { type: 'stats', items: [{ label: 'A', value: '1', do: d }] },
      { type: 'table', columns: [{ id: 'f', label: 'File' }], rows: [{ cells: { f: 'a.ts' }, do: d }] }
    ])
    expect(rows?.type === 'rows' && rows.items[0]?.do).toEqual(d)
    expect(stats?.type === 'stats' && stats.items[0]?.do).toEqual(d)
    expect(table?.type === 'table' && table.rows[0]?.do).toEqual(d)
  })

  it('rides on a table row written as a plain object, not taken for a cell', () => {
    const d = { action: 'open', path: 'a.ts' }
    const [table] = blocksOf([{ type: 'table', columns: ['lib', 'size'], rows: [{ lib: 'x', size: '1', do: d }, { lib: 'y', size: '2' }] }])
    expect(table?.type === 'table' && table.rows.map((r) => [r.cells, r.do])).toEqual([
      [{ lib: 'x', size: '1' }, d],
      [{ lib: 'y', size: '2' }, undefined]
    ])
  })
})

describe('what the prompts say', () => {
  it('names every source and every action', () => {
    for (const id of VIEW_SOURCE_IDS) expect(describeViewSources()).toContain(id)
    for (const a of VIEW_DO_ACTIONS) expect(describeViewDo()).toContain(`"action":"${a}"`)
  })
})

describe('a question’s view', () => {
  const form = (view: unknown) => normalizeAskQuestionArgs({ questions: [{ id: 'q', prompt: 'Which?', options: ['A', 'B'] }], view })

  it('travels with the question as a parsed view', () => {
    const r = form({ id: 'opts', title: 'Options', blocks: [{ type: 'table', columns: ['Option', 'Size'], rows: [['A', '12 kB']] }] })
    expect(r.ok && JSON.parse(r.form.view!)).toMatchObject({ id: 'opts', title: 'Options', blocks: [{ type: 'table' }] })
  })

  it('is left out when it makes no view; the question is still asked', () => {
    const r = form({ title: 'x', blocks: [] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.form.view).toBeUndefined()
  })

  it('is left out when reading it back makes it longer than the bridge takes; the question is still asked', () => {
    // Array rows read back as {cells:{…}}: under the cap as written, over it once read.
    const rows = Array.from({ length: 40 }, (_, i) => Array.from({ length: 8 }, (_, j) => `${i}-${j}-`.padEnd(68, 'x')))
    const raw = { id: 'big', title: 'Big', blocks: [{ type: 'table', columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows }] }
    expect(JSON.stringify(raw).length).toBeLessThan(VIEW_SPEC_MAX_CHARS)
    expect(JSON.stringify(parseViewSpec(JSON.stringify(raw))).length).toBeGreaterThan(VIEW_SPEC_MAX_CHARS)
    const r = form(raw)
    expect(r.ok && r.form.questions).toHaveLength(1)
    expect(r.ok && r.form.view).toBeUndefined()
  })
})

describe('opening a commit from a view', () => {
  it('takes a sha, as models name it', () => {
    const spec = parseViewSpec(JSON.stringify({ id: 'c', title: 'C', blocks: [{ type: 'rows', items: [{ title: 'Fix', do: { type: 'commit', hash: 'ABC1234' } }] }] }))
    const row = spec?.blocks[0]?.type === 'rows' ? spec.blocks[0].items[0] : null
    expect(row?.do).toEqual({ action: 'commit', sha: 'ABC1234' })
  })

  it('refuses anything that is not a sha', () => {
    const spec = parseViewSpec(JSON.stringify({ id: 'c', title: 'C', blocks: [{ type: 'rows', items: [{ title: 'Fix', do: { action: 'commit', sha: 'HEAD; rm -rf /' } }] }] }))
    const row = spec?.blocks[0]?.type === 'rows' ? spec.blocks[0].items[0] : null
    expect(row?.do).toBeUndefined()
  })
})

describe('what a forgiving parse left out', () => {
  it('counts dropped blocks and the items dropped from blocks that stayed', () => {
    const raw = {
      id: 'v',
      title: 'V',
      blocks: [
        { type: 'nope' },
        { type: 'rows', items: [{ title: 'ok' }, { meta: 'no title' }, 'junk'] },
        { type: 'stats', items: [{ label: 'a', value: 1 }] }
      ]
    }
    expect(viewDrops(raw)).toEqual({ blocks: 1, items: 2 })
  })
})

describe('a block as text', () => {
  it('says checks with their count and a word for each state', () => {
    expect(viewBlockLines({ type: 'checks', items: [{ label: 'build', state: 'fail' }], total: 3, passed: 2, more: '2 more passed' })).toEqual([
      '**Checks** (2/3)',
      '- [ ] build — failed',
      '- 2 more passed'
    ])
  })

  it('escapes a pipe inside a table cell', () => {
    expect(viewBlockLines({ type: 'table', columns: [{ id: 'a', label: 'A' }], rows: [{ cells: { a: 'x|y' } }] })).toEqual(['| A |', '| --- |', String.raw`| x\|y |`])
  })
})
