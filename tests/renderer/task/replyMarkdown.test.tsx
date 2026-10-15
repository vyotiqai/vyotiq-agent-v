/**
 * @vitest-environment jsdom
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { closeEnd, completeTail, splitBlocks } from '@renderer/features/task/record/reply/blocks'
import { parsePath } from '@renderer/features/task/record/reply/refs'
import { ReplyMarkdown } from '@renderer/features/task/record/reply/ReplyMarkdown'
import { useSmoothText } from '@renderer/features/task/record/reply/smooth'
import { findRanges, paintMatches } from '@renderer/features/task/recordFind'

const copied: string[] = []
vi.mock('@renderer/lib/markdown/copyText', () => ({
  copyText: async (text: string) => {
    copied.push(text)
    return true
  }
}))

beforeEach(() => {
  copied.length = 0
})
afterEach(cleanup)

const BS = '\\'

describe('splitting a reply into blocks', () => {
  it('keeps a loose list, its fenced code and its continuation in one block', () => {
    const doc = '1. one\n\n   more of one\n\n2. two\n\n   ```ts\n   const a = 1\n   ```\n\n3. three\n\nAfter.'
    expect(splitBlocks(doc).map((b) => b.source.trim().split('\n')[0])).toEqual(['1. one', 'After.'])
  })

  it('keeps indented code, a 2-space fence and an HTML comment whole across blank lines', () => {
    expect(splitBlocks('para\n\n    code 1\n\n    code 2\n\nafter')).toHaveLength(3)
    expect(splitBlocks('Intro\n\n  ```py\n  def f():\n\n      return 1\n  ```\n\nafter')).toHaveLength(3)
    expect(splitBlocks('Before\n\n<!--\n\nhidden\n\n-->\n\nAfter')).toHaveLength(3)
  })

  it('joins from the first block that names a defined reference, and ignores look-alikes in code', () => {
    expect(splitBlocks('intro\n\nmid[^1]\n\nmore\n\n[^1]: n').map((b) => b.start)).toEqual([0, 7])
    expect(splitBlocks('```ini\n[core]: x\n```\n\npara one\n\npara two')).toHaveLength(3)
    expect(splitBlocks('Use `<details>` tag\n\nnext\n\nthird')).toHaveLength(3)
  })
})

describe('the block still being written', () => {
  it.each([
    ['half a closer is finished, not doubled', 'then **more bold*', 'then **more bold**'],
    ['a closer never lands after a space', 'Some **bold** then **more ', 'Some **bold** then **more**'],
    ['half a strikethrough closer', 'a ~~gone~', 'a ~~gone~~'],
    ['a glob opens nothing', 'glob src/**/*.ts and more', 'glob src/**/*.ts and more'],
    ['multiplication opens nothing', 'multiply a*b and', 'multiply a*b and'],
    ['a spaced ~~ opens nothing', 'x ~~ y', 'x ~~ y'],
    ['a single ~ is "about", not strikethrough', 'took ~2.5 hours and', 'took ~2.5 hours and'],
    ['intraword underscores open nothing', 'call snake_case_na', 'call snake_case_na'],
    ['an open code span is left as code and closed', 'Use `arr[0', 'Use `arr[0`'],
    ['a bare opener waits', 'are **', 'are '],
    ['a comparison is not a tag', 'for i<n we loop', 'for i<n we loop'],
    ['half a tag waits', 'Press <kb', 'Press '],
    ['a link cut short shows its words', 'see [the docs](https://e.com/a_(b', 'see the docs'],
    ['an earlier list item is never balanced against', '- **a\n- b and c', '- **a\n- b and c'],
    ['a fence is only closed', '```elixir\nlist\n|> Enum.map(f)', '```elixir\nlist\n|> Enum.map(f)\n```']
  ])('%s', (_name, input, expected) => {
    expect(completeTail(input)).toBe(expected)
  })

  it('holds a table back until its delimiter row, and the row being typed until its last pipe', () => {
    expect(completeTail('| a | b | c |\n| --- | -')).toBe('')
    expect(completeTail('Name | Time\n:-')).toBe('')
    expect(completeTail(`| a ${BS}| b | c |\n| --- | --- |\n| 1 | 2`)).toBe(`| a ${BS}| b | c |\n| --- | --- |`)
  })

  it('leaves a finished table, a list after it and prose with pipes alone', () => {
    const listAfter = '1. a\n\n   | x | y |\n   |---|---|\n   | 1 | 2 |\n\n2. Now I am typing'
    expect(completeTail(listAfter)).toBe(listAfter)
    expect(completeTail('x | y\n- item one')).toBe('x | y\n- item one')
  })
})

describe('paths', () => {
  it('reads the forms an answer writes, and only workspace paths', () => {
    expect(parsePath('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(parsePath('./src/a.ts')).toEqual({ path: 'src/a.ts', line: undefined })
    expect(parsePath('src/a.ts#L9')).toEqual({ path: 'src/a.ts', line: 9 })
    expect(parsePath('src/a.ts:40-52')).toEqual({ path: 'src/a.ts', line: 40 })
    expect(parsePath('1.5')).toBeNull()
    expect(parsePath('../outside.ts')).toBeNull()
  })

  it('reads a bare name as a file only when it is a known file type, never a property', () => {
    expect(parsePath('session.ts:12')).toEqual({ path: 'session.ts', line: 12 })
    expect(parsePath('package.json')).toEqual({ path: 'package.json', line: undefined })
    expect(parsePath('req.apiKey')).toBeNull()
    expect(parsePath('os.path')).toBeNull()
    expect(parsePath('user.name')).toBeNull()
  })
})

describe('revealing a reply', () => {
  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query }) as MediaQueryList) as typeof window.matchMedia
  })

  it('shows a replaced or unstreamed text at once, in the same render', () => {
    const { result, rerender } = renderHook(({ text, streaming }) => useSmoothText(text, streaming), {
      initialProps: { text: 'First answer.', streaming: false }
    })
    rerender({ text: 'A retried answer, longer than the first.', streaming: false })
    expect(result.current).toEqual({ shown: 'A retried answer, longer than the first.', live: false })
    rerender({ text: 'A retried answer, longer than the first. And more.', streaming: false })
    expect(result.current.shown).toBe('A retried answer, longer than the first. And more.')
  })

  it('reveals a stream’s growth, its last burst included, and stays live until caught up', async () => {
    const { result, rerender } = renderHook(({ text, streaming }) => useSmoothText(text, streaming), {
      initialProps: { text: 'Start', streaming: true }
    })
    const full = `Start ${'word '.repeat(80)}end.`
    rerender({ text: full, streaming: false })
    expect(result.current.shown.length).toBeLessThan(full.length)
    expect(result.current.live).toBe(true)
    await waitFor(() => expect(result.current).toEqual({ shown: full, live: false }), { timeout: 5_000 })
  })
})

describe('ReplyMarkdown', () => {
  it('opens a path written as a link to a file, at its line', () => {
    const open = vi.fn()
    render(<ReplyMarkdown text="See [the check](src/auth/session.ts#L58)." onOpenWorkspaceFile={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'the check' }))
    expect(open).toHaveBeenCalledWith('src/auth/session.ts', { line: 58 })
  })

  it('reads a single ~ as "about" and strikes through only ~~', () => {
    const { container } = render(<ReplyMarkdown text="hold ~2.5 hours of CPU and ~30 runs, ~~not this~~" />)
    const struck = Array.from(container.querySelectorAll('del')).map((d) => d.textContent)
    expect(struck).toEqual(['not this'])
    expect(container.textContent).toContain('~2.5 hours of CPU and ~30 runs')
  })

  it('never nests a path chip inside a link', () => {
    const { container } = render(<ReplyMarkdown text="[code `src/a.ts`](https://e.com)" onOpenWorkspaceFile={vi.fn()} />)
    expect(container.querySelector('a button')).toBeNull()
  })

  it('names a code card by its file and numbers it from the line given', () => {
    const { container } = render(<ReplyMarkdown text={'```ts src/auth/session.ts:58-60\na\nb\nc\n```'} />)
    expect(container.querySelector('figcaption')!.textContent).toContain('session.ts')
    const gutter = Array.from(container.querySelectorAll('pre code > span > span[aria-hidden]')).map((n) => n.textContent)
    expect(gutter).toEqual(['58', '59', '60'])
  })

  it('copies only the commands of a shell block, never npm’s "> pkg" output', async () => {
    const text = '```sh\n$ pnpm build\n> vyotiq@1.1.0 build\n> electron-vite build\n$ echo ok\nok\n```'
    render(<ReplyMarkdown text={text} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy commands' }))
    await waitFor(() => expect(copied).toEqual(['pnpm build\necho ok']))
  })

  it('reads a removed "-- comment" inside a hunk as a removed line, not a file header', () => {
    const { container } = render(<ReplyMarkdown text={'```diff\n@@ -1,3 +1,3 @@\n--- old comment\n+-- new comment\n same\n```'} />)
    const head = container.querySelector('figcaption')!.textContent!
    expect(head).not.toContain('old comment')
    expect(container.textContent).toContain('-- old comment')
  })

  it('right-aligns a numeric column, a dash or N/A notwithstanding, and copies the table as written', async () => {
    const table = '| Step | Time |\n| --- | ---: |\n| `build` | 12 s |\n| test | N/A |\n| lint | 1,204 ms |'
    const { container } = render(<ReplyMarkdown text={`Timings:\n\n${table}`} />)
    expect(container.querySelectorAll('td[data-num]')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy as Markdown' }))
    await waitFor(() => expect(copied).toEqual([table]))
  })

  it('says what an alert is in words, and what a task’s state is', () => {
    render(<ReplyMarkdown text={'> [!WARNING]\n> Careful.\n\n- [x] done\n- [ ] todo'} />)
    expect(screen.getByRole('note', { name: 'Warning' }).textContent).toContain('Careful.')
    expect(document.body.textContent).toContain('Done: done')
    expect(document.body.textContent).toContain('Not done: todo')
  })

  it('renders folds and keys, including a fold written on one line', () => {
    const { container } = render(<ReplyMarkdown text={'<details><summary>Why</summary>Because.</details>\n\nPress <kbd>F5</kbd>.'} />)
    expect(container.querySelector('details > summary')!.textContent).toBe('Why')
    expect(container.querySelector('kbd')!.textContent).toBe('F5')
  })

  it('loads only images the app made, and never links javascript:', () => {
    const { container } = render(
      <ReplyMarkdown text={'![dot](data:image/png;base64,iVBORw0KGgo=) ![far](https://e.com/a.png) [x](javascript:alert(1))'} />
    )
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png/)
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('keeps a footnote’s id, so its back-link has somewhere to go', () => {
    const { container } = render(<ReplyMarkdown text={'Claim[^1].\n\n[^1]: Source.'} />)
    const ref = container.querySelector('sup a')!
    expect(ref.id).not.toBe('')
    expect(container.querySelector(`a[href="#${ref.id.replace(/^user-content-/, '')}"]`)).not.toBeNull()
  })

  it('finishes a half-typed closer while streaming instead of showing stars', () => {
    const { container } = render(<ReplyMarkdown text="Some **more bold*" streaming />)
    expect(container.querySelector('strong')!.textContent).toBe('more bold')
    expect(container.textContent).not.toContain('*')
  })

  it('closes what a stopped run left open once the reply is finished, and nothing else', () => {
    const { container, rerender } = render(<ReplyMarkdown text={'Done.\n\nStopped in **the middle'} />)
    expect(container.querySelector('strong')!.textContent).toBe('the middle')
    rerender(<ReplyMarkdown text={'Done, `a` and *b* closed.'} />)
    expect(container.querySelector('em')!.textContent).toBe('b')
    // What a finished reply wrote as text is never "closed" into emphasis.
    for (const done of ['Multiply a*b and c.', 'Glob src/**/*.ts here.', '2 * 3 = 6', 'Use `**` for bold.']) {
      expect(closeEnd(done)).toBe(done)
    }
  })

  it('waits for a footnote’s note while streaming rather than showing "[^1]"', () => {
    const { container } = render(<ReplyMarkdown text="Claim[^1] here." streaming />)
    expect(container.textContent).toBe('Claim here.')
  })

  it('offers a copy per section of a long reply, and none while it streams', () => {
    const answer = '## Summary\nDone.\n\n## Changes\n- a\n\n## Risks\nNone.'
    const { container, rerender } = render(<ReplyMarkdown text={answer} sectionCopy />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(3)
    rerender(<ReplyMarkdown text={answer} sectionCopy streaming />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(0)
  })

  it('keeps heading ids stable across StrictMode double renders', () => {
    const { container } = render(
      <StrictMode>
        <ReplyMarkdown text={'## Risks\n\n## Risks'} headingIds />
      </StrictMode>
    )
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.id)).toEqual(['risks', 'risks-1'])
  })

  it('opens a folded code card or a closed fold when find’s current match is inside it', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const text = `\`\`\`txt\n${lines}\nNEEDLE_CODE\n\`\`\`\n\n<details><summary>Why NEEDLE_SUMMARY</summary>\n\nNEEDLE_FOLD\n\n</details>`
    const { container } = render(<ReplyMarkdown text={text} />)
    const details = container.querySelector('details')!
    expect(screen.getByRole('button', { name: 'Show all 31 lines' })).toBeTruthy()

    paintMatches('t', findRanges(container, 'needle_summary'), 0)
    expect(details.open).toBe(false)
    paintMatches('t', findRanges(container, 'needle_fold'), 0)
    expect(details.open).toBe(true)

    paintMatches('t', findRanges(container, 'needle_code'), 0)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy())
  })

  it('puts its size and tone on the root, for reply.css to read', () => {
    const { container } = render(<ReplyMarkdown text="Done." size="md" tone="strong" />)
    const root = container.querySelector('[data-reply]')!
    expect(root.getAttribute('data-size')).toBe('md')
    expect(root.getAttribute('data-tone')).toBe('strong')
  })
})
