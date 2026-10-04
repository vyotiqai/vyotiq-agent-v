/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { mockServiceInstruction } from '@shared/utils/unreachableService'
import type { TaskState } from '@renderer/lib/ui'
import { MarkdownContent, headingSections } from '@renderer/lib/ui/MarkdownContent'
import { buildRecordModel, type RecordRun, type WorkItem } from '@renderer/features/task/recordModel'
import { foldsToOpen, briefOpenKey, runOpenKey } from '@renderer/features/task/recordFind'
import { REPEAT_FOLD_AT, foldRepeats } from '@renderer/features/task/record/repeats'
import { WorkList } from '@renderer/features/task/record/WorkItems'
import { Brief } from '@renderer/features/task/record/Brief'
import { PlanLine } from '@renderer/features/task/record/RecordLayout'
import { coverCheckInstruction, followUpOrigin, prCheckInstruction } from '@renderer/features/task/followUps'
import { TaskPane, type TaskPaneProps } from '@renderer/features/task/TaskPane'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

/**
 * The second round of record polish (2026-10-01): a call repeated unchanged
 * folds to one line, Find in record matches what the page shows, a follow-up
 * the app wrote reads as what it asked, the plan line goes to its step, a long
 * Result copies by section, and reasoning can be hidden from the task menu.
 */

beforeEach(() => {
  window.vyotiq = {
    readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: { exists: false, content: '' } })
  } as unknown as typeof window.vyotiq
})
afterEach(cleanup)

type ToolItem = Extract<UiItem, { kind: 'tool' }>

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

let seq = 0
function poll(content: string, s: number, command = 'if (Test-Path c14-exit.txt) { "DONE" } else { "running" }'): ToolItem {
  seq += 1
  return {
    kind: 'tool',
    id: `poll-${seq}`,
    at: at(s),
    endedAt: at(s + 2),
    tool: {
      id: `poll-${seq}`,
      name: 'terminal',
      summary: command,
      status: 'done',
      content,
      argsPreview: JSON.stringify({ command })
    }
  }
}

const card = (t: ToolItem): WorkItem => ({ kind: 'card', id: t.id, tool: t })
const line = (t: ToolItem): WorkItem => ({ kind: 'explore', id: `explore:${t.id}`, tools: [t] })
function thought(id: string, text: string): WorkItem {
  return {
    kind: 'thought',
    id: `${id}:thought`,
    item: { kind: 'message', id, role: 'assistant', content: '', thinking: text, at: at(0) },
    text,
    streaming: false
  }
}

function renderWork(work: WorkItem[]): HTMLElement {
  return render(
    <RunSessionProvider value={{ workspacePath: 'C:\\ws', runId: 'r1' }}>
      <WorkList items={work} />
    </RunSessionProvider>
  ).container
}

describe('a call repeated unchanged', () => {
  it(`folds from the ${REPEAT_FOLD_AT}rd in a row, keeping the last call and the thought that led to it`, () => {
    const calls = [1, 2, 3, 4].map((i) => poll('running\nexit_code: 0', i * 10))
    const work: WorkItem[] = [
      thought('m1', 'Let me poll it.'),
      line(calls[0]!),
      thought('m2', 'Still running.'),
      line(calls[1]!),
      thought('m3', 'The log grew to 252 bytes.'),
      line(calls[2]!),
      thought('m4', 'One more look before I give up waiting.'),
      line(calls[3]!)
    ]
    const rows = foldRepeats(work)
    // The thought before the first call is not part of the run.
    expect(rows[0]).toBe(work[0])
    const fold = rows[1]
    expect(fold?.kind).toBe('repeats')
    if (fold?.kind !== 'repeats') return
    expect(fold.calls.map((c) => c.id)).toEqual([calls[0]!.id, calls[1]!.id, calls[2]!.id])
    expect(fold.command).toBe(true)
    // What led to the last call, and the call itself, stay as they were.
    expect(rows.slice(2)).toEqual([work[6], work[7]])
  })

  it('leaves two in a row, a changed argument, or other work between them alone', () => {
    const [a, b, c] = [poll('x', 1), poll('x', 2), poll('x', 3, 'git status')]
    expect(foldRepeats([card(a), card(b)]).every((r) => r.kind !== 'repeats')).toBe(true)
    expect(foldRepeats([card(a), card(b), card(c)]).every((r) => r.kind !== 'repeats')).toBe(true)
    const note: WorkItem = {
      kind: 'note',
      id: 'n1',
      item: { kind: 'message', id: 'n1', role: 'assistant', content: 'Halfway.', at: at(0) },
      text: 'Halfway.'
    }
    const d = poll('x', 4)
    expect(foldRepeats([card(a), card(b), note, card(d)]).every((r) => r.kind !== 'repeats')).toBe(true)
  })

  it('reads as one line that says how many and how many failed, and opens onto them', () => {
    const calls = [poll('exit_code: 1', 10), poll('exit_code: 1', 20), poll('exit_code: 0', 30), poll('exit_code: 0', 40)]
    const container = renderWork(calls.map(card))
    const fold = container.querySelector('[data-record-repeats]')!
    expect(fold.getAttribute('data-record-repeats')).toBe('3')
    expect(fold.textContent).toContain('3 earlier runs')
    expect(fold.textContent).toContain('of the same command')
    // Word and colour: "2 failed", not only red.
    expect(fold.textContent).toContain('2 failed')
    // Only the last command's card is drawn until the line opens.
    expect(container.querySelectorAll('[data-record-command]')).toHaveLength(1)
    fireEvent.click(fold.querySelector('button[aria-expanded="false"]')!)
    expect(container.querySelectorAll('[data-record-command]')).toHaveLength(4)
    // Opened, the earlier calls are listed as they were, not folded again.
    expect(fold.querySelectorAll('[data-record-repeats]')).toHaveLength(0)
  })
})

/** One run of a model with a step titled in markdown and an earlier run. */
function runs(): RecordRun[] {
  const items: UiItem[] = [
    { kind: 'message', id: 'user-0', role: 'user', content: 'Speed up `parseArgs`', at: at(0) },
    {
      kind: 'tool',
      id: 'plan-1',
      at: at(1),
      endedAt: at(2),
      tool: {
        id: 'plan-1',
        name: 'todo_write',
        summary: '',
        status: 'done',
        content: '1/1 complete\n[x] (s1) Bound **maxFor** in `inputs`',
        argsPreview: '{}'
      }
    },
    { kind: 'message', id: 'a-1', role: 'assistant', content: 'Bound it in `inputs` — **done**.', at: at(3) },
    { kind: 'message', id: 'user-4', role: 'user', content: 'Now the docs', at: at(10) },
    { kind: 'message', id: 'a-2', role: 'assistant', content: 'Docs updated.', at: at(11) }
  ]
  return buildRecordModel(items, { running: false }).runs
}

describe('Find in record', () => {
  it('matches a title and an answer as the page shows them, without their marks', () => {
    const model = runs()
    // The step reads "Bound maxFor in inputs"; its markdown never reaches the page.
    expect(foldsToOpen(model, 'maxFor in inputs').has(runOpenKey(1))).toBe(true)
    expect(foldsToOpen(model, 'inputs — done').has(runOpenKey(1))).toBe(true)
    // A query with the marks matches nothing the page has, so nothing opens.
    expect(foldsToOpen(model, '**maxFor**').size).toBe(0)
    expect(foldsToOpen(model, '`inputs`').size).toBe(0)
  })

  it('opens a brief whose words hold the match', () => {
    const model = runs()
    expect(foldsToOpen(model, 'parseArgs').has(briefOpenKey(1))).toBe(true)
  })

  it('opens the line a repeated call folded to when an earlier one matches', () => {
    const calls = [1, 2, 3].map((i) => poll(`tick ${i}`, i * 10))
    calls[0]!.tool.summary = 'Get-Content c14-run.log'
    const run = runs()[1]!
    // A thought between two of the folded calls is folded with them.
    const work: WorkItem[] = [card(calls[0]!), thought('m1', 'The log stopped at 252 bytes.'), card(calls[1]!), card(calls[2]!)]
    const model: RecordRun[] = [{ ...run, steps: [], setup: [], after: work }]
    const fold = foldRepeats(work).find((r) => r.kind === 'repeats')!
    expect(foldsToOpen(model, '252 bytes').has(fold.id)).toBe(true)
    expect(foldsToOpen(model, 'c14-run.log').has(fold.id)).toBe(true)
  })
})

describe('a follow-up the app wrote', () => {
  const check = { id: 'c14', text: 'The suite exits 0 with `--reporter=dot`', verdict: 'not_met' as const, evidence: 'exit 1 in c14-verify.log' }

  it('is read back from each instruction the app sends, and not once you edit it', () => {
    expect(followUpOrigin(coverCheckInstruction(check))).toEqual({
      kind: 'check',
      icon: 'checklist',
      ask: 'Make check c14 pass',
      about: check.text
    })
    expect(followUpOrigin(coverCheckInstruction({ ...check, verdict: null, evidence: undefined }))?.ask).toBe('Check c14')
    expect(followUpOrigin(mockServiceInstruction('Redis'))?.ask).toBe('Mock Redis instead of connecting to it')
    expect(
      followUpOrigin(prCheckInstruction({ name: 'build', description: 'Lint failed', url: 'https://ci.example/1' }, 12))
    ).toEqual({ kind: 'prCheck', icon: 'pullRequest', ask: 'Fix the failing “build” check on #12', about: 'Lint failed' })
    expect(followUpOrigin(`${coverCheckInstruction(check)} Also tidy the imports.`)).toBeNull()
    expect(followUpOrigin('Make it faster')).toBeNull()
  })

  it('shows what it asked over the check, the sent words a click away', () => {
    const [run] = buildRecordModel(
      [{ kind: 'message', id: 'user-0', role: 'user', content: coverCheckInstruction(check), at: at(0) }],
      { running: false }
    ).runs
    const { container } = render(<Brief run={run!} />)
    const brief = container.querySelector('[data-brief-origin="check"]')!
    expect(brief.textContent).toContain('Make check c14 pass')
    // The check's own words, its `code` set as code.
    expect(brief.querySelector('[data-ticked-code]')?.textContent).toBe('--reporter=dot')
    expect(container.querySelector('[data-brief-sent]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show as sent' }))
    expect(container.querySelector('[data-brief-sent]')!.textContent).toContain('It saw: exit 1 in c14-verify.log')
  })
})

const plan = (...states: TaskState[]) => states.map((state, i) => ({ title: `Bound **step** \`${i + 1}\``, state }))

describe('the plan line, given somewhere to go', () => {
  it('is one stop in the tab order, named in words, that goes to a step', () => {
    const onStep = vi.fn()
    const { container } = render(<PlanLine steps={plan('done', 'running', 'queued')} onStep={onStep} />)
    const bar = screen.getByRole('toolbar', { name: 'Plan · Step 2 of 3' })
    const segments = [...bar.querySelectorAll<HTMLButtonElement>('button[data-plan-step]')]
    expect(segments.map((s) => s.tabIndex)).toEqual([-1, 0, -1])
    expect(segments[0]!.getAttribute('aria-label')).toBe('Go to step 1. Bound step 1, done')
    fireEvent.click(segments[2]!)
    expect(onStep).toHaveBeenCalledWith(2)
    // Arrows walk it, and the stop moves with focus.
    segments[1]!.focus()
    fireEvent.keyDown(bar, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(segments[2])
    fireEvent.keyDown(bar, { key: 'Home' })
    expect(document.activeElement).toBe(segments[0])
    expect(container.querySelectorAll('button[data-plan-step][tabindex="0"]')).toHaveLength(1)
  })
})

describe('a Result of several parts', () => {
  const answer = '# Summary\nAll green.\n\n## Changes\n- `a.ts`\n\n```md\n# not a heading\n```\n\n## Checks\nc14 met.'

  it('knows each heading’s section, fences aside', () => {
    const sections = headingSections(answer)
    expect([...sections.keys()]).toEqual([0, 3, 10])
    expect(sections.get(3)).toBe('## Changes\n- `a.ts`\n\n```md\n# not a heading\n```')
    expect(sections.get(0)).toBe(answer)
  })

  it('offers a copy on each heading, and none on a one-part answer or while it streams', () => {
    const { container, rerender } = render(<MarkdownContent content={answer} sectionCopy />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Copy this section' })).toHaveLength(3)
    rerender(<MarkdownContent content={answer} sectionCopy streaming />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(0)
    rerender(<MarkdownContent content={'## Only\nOne part.'} sectionCopy />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(0)
    rerender(<MarkdownContent content={answer} />)
    expect(container.querySelectorAll('[data-section-copy]')).toHaveLength(0)
  })

  it('says its tone, so its inline code sits a step down from it', () => {
    const { container } = render(<MarkdownContent content="Run `pnpm test`." tone="strong" />)
    expect(container.querySelector('.markdown-body')!.getAttribute('data-tone')).toBe('strong')
  })
})

describe('reasoning, from the task menu', () => {
  const items: UiItem[] = [
    { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the parser', at: at(0) },
    { kind: 'message', id: 'a-1', role: 'assistant', content: '', thinking: 'The parser drops the last token.', at: at(1) },
    {
      kind: 'tool',
      id: 't-1',
      at: at(2),
      endedAt: at(3),
      tool: { id: 'c-1', name: 'read', summary: 'src/parse.ts', status: 'done', content: 'x', argsPreview: '{"path":"src/parse.ts"}' }
    },
    { kind: 'message', id: 'a-2', role: 'assistant', content: 'Fixed.', at: at(4) }
  ]

  function pane(showThinking: boolean): HTMLElement {
    const props: TaskPaneProps = {
      workspacePath: '/ws',
      runId: 'r1',
      items,
      running: false,
      pendingRun: false,
      turnFailed: false,
      turnStatus: 'done',
      compacting: false,
      showThinking,
      run: null,
      onStop: vi.fn(),
      actions: {},
      messageCount: 4,
      composer: null
    }
    return render(<TaskPane {...props} />).container
  }

  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^More — / }))

  it('hides the thought lines in this pane without changing the setting, and brings them back', () => {
    const container = pane(true)
    expect(container.querySelectorAll('[data-record-thought]').length).toBeGreaterThan(0)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide reasoning' }))
    expect(container.querySelectorAll('[data-record-thought]')).toHaveLength(0)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show reasoning' }))
    expect(container.querySelectorAll('[data-record-thought]').length).toBeGreaterThan(0)
  })

  it('answers the palette’s "Show or hide reasoning" in the focused pane', () => {
    const container = pane(true)
    act(() => {
      window.dispatchEvent(new CustomEvent('vyotiq:command', { detail: { id: 'toggleReasoning' } }))
    })
    expect(container.querySelectorAll('[data-record-thought]')).toHaveLength(0)
  })

  it('shows them on request where the setting has them off', () => {
    const container = pane(false)
    expect(container.querySelectorAll('[data-record-thought]')).toHaveLength(0)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show reasoning' }))
    expect(container.querySelectorAll('[data-record-thought]').length).toBeGreaterThan(0)
  })
})
