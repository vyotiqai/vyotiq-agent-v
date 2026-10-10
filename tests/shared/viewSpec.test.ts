import { describe, expect, it } from 'vitest'
import { OPEN_MARK, parsePartialJson, parseViewSpec, parseViewSpecStreaming, VIEW_SPEC_MAX_CHARS } from '@shared/viewSpec'

const VIEW = {
  id: 'failing-tests',
  title: 'Failing tests',
  subtitle: 'pnpm test · 3 of 412',
  blocks: [
    { type: 'stats', items: [{ label: 'Failed', value: '3', tone: 'danger' }, { label: 'Passed', value: '409' }] },
    {
      type: 'rows',
      title: 'Failures',
      items: [
        { title: 'retry.test.ts', lead: 'src/payments/', meta: 'ECONNREFUSED 127.0.0.1:6379', state: 'failed', path: 'src/payments/retry.test.ts' },
        { title: 'session.test.ts', lead: 'src/auth/', state: 'failed', say: 'Why does session.test.ts fail?' }
      ]
    },
    { type: 'actions', actions: [{ label: 'Retry with a mock', say: 'Retry it with a mock Redis', primary: true }] }
  ]
}

describe('parseViewSpec', () => {
  it('parses a closed fence with every block it knows', () => {
    const spec = parseViewSpec(JSON.stringify(VIEW))
    expect(spec?.id).toBe('failing-tests')
    expect(spec?.blocks.map((b) => b.type)).toEqual(['stats', 'rows', 'actions'])
  })

  it('drops a block it does not know and keeps the rest', () => {
    const spec = parseViewSpec(JSON.stringify({ ...VIEW, blocks: [{ type: 'iframe', src: 'x' }, ...VIEW.blocks] }))
    expect(spec?.blocks.map((b) => b.type)).toEqual(['stats', 'rows', 'actions'])
  })

  it('is plain code when there is no title, no valid block, bad JSON, or too much of it', () => {
    expect(parseViewSpec(JSON.stringify({ ...VIEW, title: '' }))).toBeNull()
    expect(parseViewSpec(JSON.stringify({ ...VIEW, blocks: [{ type: 'iframe' }] }))).toBeNull()
    expect(parseViewSpec('{"id":"a","title":"b",')).toBeNull()
    expect(parseViewSpec(' '.repeat(10) + 'x'.repeat(VIEW_SPEC_MAX_CHARS + 1))).toBeNull()
  })

  it('caps what a model may put in it', () => {
    const long = parseViewSpec(JSON.stringify({ ...VIEW, blocks: [{ type: 'note', text: 'x'.repeat(5000) }] }))
    expect(long?.blocks[0]?.type === 'note' ? long.blocks[0].text.length : 0).toBe(400)
    const many = parseViewSpec(JSON.stringify({ ...VIEW, blocks: [{ type: 'rows', items: Array.from({ length: 90 }, (_, i) => ({ title: `r${i}` })) }] }))
    expect(many?.blocks[0]?.type === 'rows' ? many.blocks[0].items.length : 0).toBe(40)
  })
})

describe('what real models send instead of the documented shape', () => {
  const one = (block: unknown, head: Record<string, unknown> = { id: 'v', title: 'T' }) => parseViewSpec(JSON.stringify({ ...head, blocks: [block] }))?.blocks[0]

  it('takes numbers for text, and cuts an overlong string instead of refusing it', () => {
    expect(one({ type: 'stats', items: [{ label: 'Files', value: 395 }] })).toEqual({ type: 'stats', items: [{ label: 'Files', value: '395' }] })
    const spec = parseViewSpec(JSON.stringify({ id: 'v', title: 'x'.repeat(200), blocks: [{ type: 'note', text: 'ok' }] }))
    expect(spec?.title).toHaveLength(80)
    expect(spec?.title.endsWith('…')).toBe(true)
  })

  it('maps the usual synonyms onto the vocabulary', () => {
    const checks = one({ type: 'checks', items: [{ label: 'a', state: 'passed' }, { label: 'b', state: 'Error' }, { label: 'c', state: 'in progress' }] })
    expect(checks?.type === 'checks' ? checks.items.map((c) => c.state) : null).toEqual(['pass', 'fail', 'running'])
    const rows = one({ type: 'rows', items: [{ title: 'r', state: 'success', share: 71, diff: { add: '+559', del: '−42' } }] })
    expect(rows?.type === 'rows' ? rows.items[0] : null).toEqual({ title: 'r', state: 'done', share: 0.71, diff: { add: 559, del: 42 } })
  })

  it('drops a bad optional field, and a bad row, and keeps the rest', () => {
    const rows = one({ type: 'rows', items: [{ title: 'kept', state: 'sideways' }, { meta: 'no title' }, { title: 'also kept' }] })
    expect(rows?.type === 'rows' ? rows.items : null).toEqual([{ title: 'kept' }, { title: 'also kept' }])
  })

  it('reads table rows as arrays or plain objects, and bare column labels', () => {
    const arrays = one({ type: 'table', columns: ['Model', 'Runs'], rows: [['Opus', 14], ['Sonnet', 38]] })
    expect(arrays?.type === 'table' ? arrays.rows.map((r) => r.cells) : null).toEqual([
      { Model: 'Opus', Runs: '14' },
      { Model: 'Sonnet', Runs: '38' }
    ])
    const objects = one({ type: 'table', columns: [{ id: 'm', label: 'Model' }], rows: [{ m: 'Haiku', lead: true }] })
    expect(objects?.type === 'table' ? objects.rows[0] : null).toEqual({ cells: { m: 'Haiku' }, lead: true })
  })

  it('reads a check state written as true or false', () => {
    const checks = one({ type: 'checks', items: [{ label: 'a', state: true }, { label: 'b', state: false }] })
    expect(checks?.type === 'checks' ? checks.items.map((c) => c.state) : null).toEqual(['pass', 'fail'])
  })

  it('keeps a table row with an empty or yes/no cell, and cells keyed by a column’s label', () => {
    const t = one({ type: 'table', columns: [{ id: 'm', label: 'Model' }, { id: 'ok', label: 'Cached' }], rows: [{ Model: 'Opus', Cached: true }, { m: 'Haiku', ok: null }] })
    expect(t?.type === 'table' ? t.rows.map((r) => r.cells) : null).toEqual([
      { m: 'Opus', ok: 'yes' },
      { m: 'Haiku', ok: '' }
    ])
  })

  it('names a table’s columns from its rows when it gives none, or from a label alone', () => {
    const bare = one({ type: 'table', rows: [{ file: 'git.ts', lines: 559, say: 'Open it' }] })
    expect(bare?.type === 'table' ? [bare.columns, bare.rows[0]] : null).toEqual([
      [
        { id: 'file', label: 'file' },
        { id: 'lines', label: 'lines' }
      ],
      { cells: { file: 'git.ts', lines: '559' }, say: 'Open it' }
    ])
    const labelled = one({ type: 'table', columns: [{ label: 'Files' }], rows: [['48']] })
    expect(labelled?.type === 'table' ? [labelled.columns, labelled.rows[0]!.cells] : null).toEqual([[{ id: 'Files', label: 'Files' }], { Files: '48' }])
  })

  it('reads a chart written flat on its block, bare-string actions, and a list called rows', () => {
    expect(one({ type: 'chart', chartType: 'line', labels: ['a', 'b'], values: [1, 2] })).toEqual({ type: 'chart', spec: { type: 'line', labels: ['a', 'b'], values: [1, 2] } })
    expect(one({ type: 'actions', actions: ['Retry'] })).toEqual({ type: 'actions', actions: [{ label: 'Retry', say: 'Retry' }] })
    expect(one({ type: 'rows', rows: [{ title: 'x' }] })).toEqual({ type: 'rows', items: [{ title: 'x' }] })
  })

  it('forgives trailing commas and a missing id, and still refuses what it cannot read', () => {
    expect(parseViewSpec('{"id":"v","title":"T","blocks":[{"type":"note","text":"a",},],}')?.blocks).toEqual([{ type: 'note', text: 'a' }])
    expect(parseViewSpec('{"title":"Failing tests","blocks":[{"type":"note","text":"a"}]}')?.id).toBe('failing-tests')
    expect(parseViewSpec('{"title":"T","blocks":[{"type":"iframe"}]}')).toBeNull()
  })
})

describe('parseViewSpecStreaming', () => {
  const full = JSON.stringify(VIEW, null, 2)
  const at = (needle: string): string => full.slice(0, full.indexOf(needle) + needle.length)

  it('waits for the id and the whole title', () => {
    expect(parseViewSpecStreaming('{"id": "failing-te')).toBeNull()
    expect(parseViewSpecStreaming(at('"title": "Fail'))).toBeNull()
    expect(parseViewSpecStreaming(at('"title": "Failing tests"'))?.title).toBe('Failing tests')
  })

  it('never draws a value that is still being written', () => {
    // "409" may be the start of "4090": the item is open, so only the first stat shows.
    expect(parseViewSpecStreaming(at('"value": "409"'))?.blocks).toEqual([{ type: 'stats', items: [{ label: 'Failed', value: '3', tone: 'danger' }] }])
    expect(parseViewSpecStreaming(at('"value": "4'))?.blocks).toEqual([{ type: 'stats', items: [{ label: 'Failed', value: '3', tone: 'danger' }] }])
  })

  it('adds a list block row by row, each once its object closes', () => {
    const one = parseViewSpecStreaming(at('"lead": "src/auth/"'))
    expect(one?.blocks.map((b) => b.type)).toEqual(['stats', 'rows'])
    expect(one?.blocks[1]?.type === 'rows' ? one.blocks[1].items.map((r) => r.title) : null).toEqual(['retry.test.ts'])
    // No row has closed yet: the block waits rather than showing a bare title.
    expect(parseViewSpecStreaming(at('"meta": "ECONN'))?.blocks.map((b) => b.type)).toEqual(['stats'])
  })

  it('reads the whole thing the same way once it has all arrived', () => {
    expect(parseViewSpecStreaming(full)).toEqual(parseViewSpec(full))
  })
})

describe('parsePartialJson', () => {
  const O = OPEN_MARK
  it.each([
    ['a number may be unfinished', '{"a": [1, 2', { a: [1], [O]: 1 }],
    ['a string may be unfinished', '{"a": "he', { [O]: 1 }],
    ['a key without its value', '{"a": 1, "b"', { a: 1, [O]: 1 }],
    ['a literal may be unfinished', '{"a": tr', { [O]: 1 }],
    ['nested open objects are each marked', '{"a": {"b": [ {"c": 1}, {"d"', { a: { b: [{ c: 1 }, { [O]: 1 }], [O]: 1 }, [O]: 1 }],
    ['an escape at the very end', '{"a": "x\\', { [O]: 1 }],
    ['finished JSON is untouched', '{"a": [1, 2]}', { a: [1, 2] }]
  ])('%s', (_name, text, want) => {
    expect(parsePartialJson(text)).toEqual(want)
  })
})
