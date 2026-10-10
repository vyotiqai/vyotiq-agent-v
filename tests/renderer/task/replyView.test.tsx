/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { ReplyMarkdown } from '@renderer/features/task/record/reply/ReplyMarkdown'
import { ViewFence } from '@renderer/features/task/record/reply/view/ViewFence'
import { answerHeadline } from '@renderer/features/task/record/plainText'

afterEach(cleanup)

const spec = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'tests',
    title: 'Failing tests',
    blocks: [
      { type: 'stats', items: [{ label: 'Failed', value: '3' }] },
      { type: 'rows', title: 'Failures', items: [{ title: 'retry.test.ts', lead: 'src/payments/', state: 'failed', path: 'src/payments/retry.test.ts' }] },
      { type: 'actions', actions: [{ label: 'Retry with a mock', say: 'Retry it with a mock Redis', primary: true }] }
    ],
    ...over
  })

const fence = (body: string): string => `Here is what failed.\n\n\`\`\`view\n${body}\n\`\`\`\n`

function withSession(node: React.ReactNode, extra: { onSay?: (t: string) => void; onOpen?: (p: string) => void } = {}) {
  return (
    <RunSessionProvider value={{ workspacePath: 'C:/w', runId: 'r1', onSay: extra.onSay, onOpenWorkspaceFile: extra.onOpen }}>
      <div data-chat-pane="">{node}</div>
    </RunSessionProvider>
  )
}

describe('a ```view fence in a reply', () => {
  it('draws the view with its title, blocks and rows', () => {
    render(withSession(<ReplyMarkdown text={fence(spec())} />))
    const card = document.querySelector('[data-kind="view"]')!
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Failing tests')
    expect(card.textContent).toContain('src/payments/retry.test.ts')
    expect(screen.getByRole('img', { name: 'Failed' })).toBeTruthy()
  })

  it('sends an action’s text as your next message, and opens a row’s file', () => {
    const onSay = vi.fn()
    const onOpen = vi.fn()
    render(withSession(<ReplyMarkdown text={fence(spec())} />, { onSay, onOpen }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry with a mock' }))
    expect(onSay).toHaveBeenCalledWith('Retry it with a mock Redis')
    fireEvent.click(screen.getByRole('button', { name: /retry\.test\.ts/ }))
    expect(onOpen).toHaveBeenCalledWith('src/payments/retry.test.ts')
  })

  it('cannot act where the record takes no message', () => {
    render(withSession(<ReplyMarkdown text={fence(spec())} />))
    expect((screen.getByRole('button', { name: 'Retry with a mock' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('fills a form’s answer into what it sends', () => {
    const onSay = vi.fn()
    const body = spec({
      blocks: [
        {
          type: 'form',
          fields: [{ kind: 'choice', id: 'lib', label: 'Library', options: [{ id: 'a', label: 'date-fns' }, { id: 'b', label: 'dayjs' }] }],
          submit: { label: 'Answer', say: 'Use {lib}' }
        }
      ]
    })
    render(withSession(<ReplyMarkdown text={fence(body)} />, { onSay }))
    fireEvent.click(screen.getByRole('radio', { name: /dayjs/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onSay).toHaveBeenCalledWith('Use dayjs')
  })

  it('says a check’s state in words, and keeps the reply’s list styles out', () => {
    const body = spec({ blocks: [{ type: 'checks', items: [{ label: 'On main', state: 'passed' }, { label: 'Clean tree', state: 'failed' }] }] })
    render(withSession(<ReplyMarkdown text={fence(body)} />))
    const card = document.querySelector('[data-kind="view"]')!
    expect(card.textContent).toContain('Passed: On main')
    expect(card.textContent).toContain('Failed: Clean tree')
    expect(card.textContent).not.toContain('Ready for review')
    expect(card.querySelector('ul, li')).toBeNull()
  })

  it('right-aligns a column of numbers the model left unaligned, and only that', () => {
    const body = spec({ blocks: [{ type: 'table', columns: ['Commit', 'Files'], rows: [['409086f3', 48], ['abbe63db', '1']] }] })
    render(withSession(<ReplyMarkdown text={fence(body)} />))
    const [commit, files] = [...document.querySelectorAll('[data-kind="view"] th')]
    expect(commit!.className).toContain('text-left')
    expect(files!.className).toContain('text-right')
  })

  it('is plain code when the spec is not a view', () => {
    render(withSession(<ReplyMarkdown text={fence('{"title": "no id"}')} />))
    expect(document.querySelector('[data-kind="view"]')).toBeNull()
    expect(document.body.textContent).toContain('no id')
  })

  it('folds an earlier copy when a later reply sends the same id', async () => {
    render(
      withSession(
        <>
          <ReplyMarkdown text={fence(spec())} />
          <ReplyMarkdown text={fence(spec({ title: 'Failing tests, after the retry' }))} />
        </>
      )
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Updated below/ })).toBeTruthy())
    const cards = document.querySelectorAll('[data-kind="view"]')
    expect(cards).toHaveLength(2)
    // The earlier copy is its head only; the newer one is whole.
    expect(cards[0]!.textContent).not.toContain('retry.test.ts')
    expect(cards[1]!.textContent).toContain('retry.test.ts')
    fireEvent.click(screen.getByRole('button', { name: /Updated below/ }))
    expect(cards[0]!.textContent).toContain('retry.test.ts')
  })

  it('sends one message for a double click', () => {
    const onSay = vi.fn()
    render(withSession(<ReplyMarkdown text={fence(spec())} />, { onSay }))
    const button = screen.getByRole('button', { name: 'Retry with a mock' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onSay).toHaveBeenCalledTimes(1)
  })

  it('reaches a table row that sends by keyboard, through its first cell', () => {
    const onSay = vi.fn()
    const body = spec({ blocks: [{ type: 'table', columns: ['Commit', 'Files'], rows: [{ cells: { Commit: '409086f3', Files: '48' }, say: 'Show 409086f3' }] }] })
    render(withSession(<ReplyMarkdown text={fence(body)} />, { onSay }))
    const cellButton = screen.getByRole('button', { name: '409086f3' })
    expect(cellButton.closest('td')).not.toBeNull()
    fireEvent.click(cellButton)
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('Show 409086f3')
  })

  it('draws a stat that would send as a plain stat where the record takes no message', () => {
    const body = spec({ blocks: [{ type: 'stats', items: [{ label: 'Failed', value: '3', say: 'Show the failures' }] }] })
    render(withSession(<ReplyMarkdown text={fence(body)} />))
    expect(document.querySelector('[data-kind="view"] > div button')).toBeNull()
    expect(document.querySelector('[data-kind="view"]')!.textContent).toContain('Failed3')
  })

  it('gives a form field that arrives later its own starting value', () => {
    const onSay = vi.fn()
    const choice = { kind: 'choice', id: 'lib', label: 'Library', options: [{ id: 'a', label: 'date-fns' }, { id: 'b', label: 'dayjs' }] }
    const form = (fields: unknown[]) => spec({ blocks: [{ type: 'form', fields, submit: { label: 'Answer', say: 'Use {lib}, tests {tests}' } }] })
    const { rerender } = render(withSession(<ViewFence text={form([choice])} streaming={false} onPlain={() => null} />, { onSay }))
    rerender(withSession(<ViewFence text={form([choice, { kind: 'switch', id: 'tests', label: 'Add tests', value: true }])} streaming={false} onPlain={() => null} />, { onSay }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onSay).toHaveBeenCalledWith('Use date-fns, tests yes')
  })

  it('shows what a stopped reply finished of a view, and says the rest is missing', () => {
    const full = spec()
    const cut = full.slice(0, full.indexOf('"type":"actions"'))
    render(withSession(<ViewFence text={cut} streaming={false} onPlain={() => <p>plain</p>} />))
    const card = document.querySelector('[data-kind="view"]')!
    expect(card.textContent).toContain('retry.test.ts')
    expect(card.textContent).toContain('The rest of this view didn’t come through')
    expect(document.body.textContent).not.toContain('plain')
  })

  it('never starts from another task’s copy of the same view', () => {
    const other = spec({ blocks: [{ type: 'rows', items: [{ title: 'only-in-the-other-task.ts' }] }] })
    const mine = spec({ blocks: [{ type: 'rows', items: [{ title: 'mine.ts' }] }] })
    const inTask = (runId: string, node: React.ReactNode) => (
      <RunSessionProvider value={{ workspacePath: 'C:/w', runId }}>
        <div data-chat-pane="">{node}</div>
      </RunSessionProvider>
    )
    const a = render(inTask('task-a', <ViewFence text={other} streaming={false} onPlain={() => null} />))
    a.unmount()
    const { rerender } = render(inTask('task-b', <ViewFence text={mine.slice(0, -10)} streaming onPlain={() => null} />))
    rerender(inTask('task-b', <ViewFence text={mine} streaming={false} onPlain={() => null} />))
    // A copy from task A as the starting point would fold its row away here.
    expect(document.body.textContent).not.toContain('only-in-the-other-task.ts')
    expect(document.querySelector('.vy-view-leave')).toBeNull()
  })

  it('draws what has arrived while it streams, then settles', () => {
    // Its own id: an earlier test's settled copy of `tests` would hold its rows in place.
    const full = spec({ id: 'fresh-stream' })
    const cut = full.slice(0, full.indexOf('"type":"rows"'))
    const { rerender } = render(withSession(<ViewFence text={cut} streaming onPlain={() => null} />))
    const card = document.querySelector('[data-kind="view"]')!
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.textContent).toContain('Failing tests')
    expect(card.textContent).toContain('Failed')
    expect(card.textContent).not.toContain('retry.test.ts')
    rerender(withSession(<ViewFence text={full} streaming={false} onPlain={() => null} />))
    expect(card.getAttribute('aria-busy')).toBeNull()
    expect(card.textContent).toContain('retry.test.ts')
  })
})

describe('a view updated in place', () => {
  const files = ['format.ts', 'parse.ts', 'range.ts', 'index.ts']
  const progress = (done: number, rows: number): string =>
    JSON.stringify({ id: 'migration', title: 'Migrating', subtitle: `${done} of 4 done`, blocks: [{ type: 'rows', title: 'Files', items: files.slice(0, rows).map((f, i) => ({ id: f, title: f, state: i < done ? 'done' : 'queued' })) }] })
  const titles = (card: Element): string[] => [...card.querySelectorAll('button, span.text-fg')].map((e) => e.textContent ?? '').filter((t) => files.includes(t))

  it('keeps the earlier copy’s rows in place while the update is still writing them, then drops what it left out', async () => {
    const first = render(withSession(<ViewFence text={progress(0, 4)} streaming={false} onPlain={() => null} />))
    first.unmount()
    // The update has written its first row only: the cut is right after it.
    const partial = progress(2, 4).replace(/,\{"id":"parse\.ts".*$/, '')
    const { rerender } = render(withSession(<ViewFence text={partial} streaming onPlain={() => null} />))
    const card = document.querySelector('[data-kind="view"]')!
    await waitFor(() => expect(card.textContent).toContain('2 of 4 done'))
    expect(titles(card)).toEqual(files)
    expect(card.textContent).toContain('Files4')
    // Finished with two rows: the other two fold away rather than stay.
    rerender(withSession(<ViewFence text={progress(2, 2)} streaming={false} onPlain={() => null} />))
    await waitFor(() => expect(titles(document.querySelector('[data-kind="view"]')!)).toEqual(['format.ts', 'parse.ts']))
  })
})

describe('the line History names an answer by', () => {
  it('is its first line of words, past any code block', () => {
    expect(answerHeadline('```ts\nconst a = 1\n```\n\nRenamed the helper.')).toBe('Renamed the helper.')
    expect(answerHeadline('\n\nThree tests fail.\n```view\n{}\n```')).toBe('Three tests fail.')
  })

  it('is a view’s title when the view comes first', () => {
    expect(answerHeadline(fence(spec()).replace('Here is what failed.\n\n', ''))).toBe('Failing tests')
  })

  it('is nothing when there are no words to show', () => {
    expect(answerHeadline('```sh\nls\n```')).toBeUndefined()
  })
})
