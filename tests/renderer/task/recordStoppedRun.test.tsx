/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { formatSkillInvocation, SKILL_BODY_STUB } from '@shared/slashCommands'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { buildRecordModel, runStateOf, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { balanceIncompleteMarkdown } from '@renderer/lib/ui/MarkdownContent'
import { parseStatusMessageData } from '@renderer/features/chat/toolUi/parsers/status'
import { thoughtLine } from '@renderer/features/task/record/WorkItems'
import { foldsToOpen, thoughtOpenKey } from '@renderer/features/task/recordFind'
import { Pie } from '@renderer/lib/ui'

/**
 * The shape of a real task (27 Sep): "Hi", then `/design-level-up` sent with
 * nothing after it, a few lookups, a skill load, a note, then a question the
 * user stopped the run on. Each assertion is one thing that screen got wrong.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-09-27T16:01:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number, index: number): UiItem => ({
  kind: 'message',
  id: `user-${index}`,
  role: 'user',
  content: text,
  at: at(s)
})
const said = (text: string, s: number): UiItem => ({ kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s) })
function tool(
  name: string,
  args: Record<string, unknown>,
  content: string,
  s: number,
  extra: { status?: 'done' | 'fail'; summary?: string; took?: number } = {}
): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + (extra.took ?? 0.2)),
    tool: {
      id: id('c'),
      name,
      summary: extra.summary ?? '',
      status: extra.status ?? 'done',
      content,
      argsPreview: JSON.stringify(args)
    }
  }
}

const NOTE =
  'This repo already has a mature design foundation: semantic `--vy-*` tokens, and 35 shared primitives. ' +
  'So the skill applies as a *polish pass over an existing system*, not a ground-up build.'
const QUESTION = { title: 'Design level-up on an existing design system', questions: [{ id: 'level', prompt: 'How far?', type: 'single', options: ['Auto', 'Easy'] }] }

function session(): UiItem[] {
  return [
    user('Hi', 2, 0),
    said('I’m ready when you are. What would you like to work on?', 9),
    user(formatSkillInvocation('design-level-up', SKILL_BODY_STUB), 36, 2),
    tool('list_dir', { path: 'docs' }, 'docs (2 entries)', 44),
    tool('Skill', { name: 'design-level-up' }, '# Skill: design-level-up', 49, { summary: 'design-level-up' }),
    tool('read', { path: 'src/renderer/src/styles.css' }, 'contents', 58),
    said(NOTE, 86),
    // Stopped while the question waited: main settles it as `Cancelled`, summary "cancelled".
    tool('ask_question', QUESTION, 'Cancelled', 86, { status: 'fail', summary: 'cancelled', took: 32 })
  ]
}

const usage: StepUsageTotals[] = []
function show(items: UiItem[], options: BuildOptions) {
  const model = buildRecordModel(items, options)
  const view = render(
    <TaskRecord model={model} options={options} messageCount={items.length} turnUsage={usage} />
  )
  return { model, ...view }
}

describe('a slash command in the record', () => {
  it('reads as the command, not the prompt it expanded to', () => {
    const { model, container } = show(session(), { running: false, stopped: true })
    const run2 = model.runs[1]!
    expect(run2.command).toBe('design-level-up')
    expect(run2.text).toBe('')
    const brief = container.querySelector('[data-brief="2"]')!
    expect(brief.querySelector('[data-brief-command]')?.textContent).toBe('/design-level-up')
    expect(brief.textContent).not.toContain('<skill instructions>')
    expect(brief.textContent).not.toContain('no additional instructions')
  })

  it('keeps what was asked with the command as the brief', () => {
    const items = [user(formatSkillInvocation('design-level-up', SKILL_BODY_STUB, 'Polish Settings'), 0, 0)]
    const [run] = buildRecordModel(items, { running: false }).runs
    expect(run!.command).toBe('design-level-up')
    expect(run!.text).toBe('Polish Settings')
  })
})

describe('a run stopped while a question waited', () => {
  it('says Cancelled once, not as a failure or bad arguments', () => {
    const { container } = show(session(), { running: false, stopped: true })
    const row = container.querySelector('[data-record-tool="ask_question"]') as HTMLElement
    expect(row).not.toBeNull()
    const text = row.textContent ?? ''
    expect(text).not.toContain('Invalid arguments')
    expect(text.match(/Cancelled/g)).toHaveLength(1)
    // The detail is what it asked, not the word "cancelled" again.
    expect(text).toContain('Design level-up on an existing design system')
    // Not drawn as a failure: no danger tone anywhere on the row.
    expect(row.querySelector('.text-danger')).toBeNull()
  })

  it('ends the run as stopped even with no plan, in History and on its receipt', () => {
    const items = session()
    const { model, container } = show(items, { running: false, stopped: true })
    const run2 = model.runs[1]!
    expect(run2.endedStopped).toBe(true)
    expect(runStateOf(run2, true, { running: false })).toBe('stopped')
    expect(container.querySelector('[data-receipt-outcome="stopped"]')?.textContent).toContain('Stopped')

    // Seen from a later run, the same run still reads as stopped — from its items alone.
    const later = [...items, user('Go on', 200, items.length)]
    const again = buildRecordModel(later, { running: false }).runs[1]!
    expect(runStateOf(again, false, { running: false })).toBe('stopped')
  })

  it('does not call a finished run stopped', () => {
    const { model, container } = show(session().slice(0, 2), { running: false })
    expect(runStateOf(model.runs[0]!, true, { running: false })).toBe('done')
    expect(container.querySelector('[data-receipt-outcome]')).toBeNull()
  })
})

describe('the question chip', () => {
  const ask = (content: string, status: 'done' | 'fail', summary = 'Pick one') =>
    parseStatusMessageData({ id: 'c', name: 'ask_question', summary, status, content, argsPreview: '{}' })

  it('names how a stopped question ended', () => {
    expect(ask('Cancelled', 'fail').chip).toBe('Cancelled')
    expect(ask('Interrupted', 'fail').chip).toBe('Interrupted')
  })

  it('keeps Invalid arguments for argument errors only', () => {
    expect(ask('questions must contain at least 1 item', 'fail').chip).toBe('Invalid arguments')
    expect(ask('bad', 'fail', 'Invalid arguments').chip).toBe('Invalid arguments')
    expect(ask('ask_question requires an active run', 'fail').chip).toBe('Failed')
  })
})

describe('a skill load', () => {
  it('has a line of its own, not a lookup in the explore group', () => {
    const { model } = show(session(), { running: false, stopped: true })
    const work = model.runs[1]!.after
    expect(work.map((w) => w.kind)).toEqual(['explore', 'tool', 'explore', 'note', 'tool'])
    const skill = work[1]!
    expect(skill.kind === 'tool' && skill.tool.tool.name).toBe('Skill')
  })
})

describe('closing markdown a finished message left open', () => {
  it('does not count a star inside a code span', () => {
    expect(balanceIncompleteMarkdown(NOTE)).toBe(NOTE)
  })

  it('does not count bullets or a spaced star', () => {
    const list = '* one\n* two\n* three'
    expect(balanceIncompleteMarkdown(list)).toBe(list)
    expect(balanceIncompleteMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  it('still closes emphasis and code a stream left open', () => {
    expect(balanceIncompleteMarkdown('Partial *italic')).toBe('Partial *italic*')
    expect(balanceIncompleteMarkdown('Partial **bold')).toBe('Partial **bold**')
    // The code span closes first, so the star does not land inside it.
    expect(balanceIncompleteMarkdown('a *b `c')).toBe('a *b `c`*')
  })
})

describe('an opened history run', () => {
  it('hangs off its row instead of reading as the current run', () => {
    const { container } = show(session(), { running: false, stopped: true })
    const history = container.querySelector('[data-history-run="1"]') as HTMLElement
    const row = within(history).getByRole('button')
    // No run reports a cost, so no empty cost column pushes the duration off the right edge.
    expect(row.querySelectorAll('span.w-12')).toHaveLength(0)
    expect(row.textContent).toContain('What would you like to work on?')
    fireEvent.click(row)
    // Opened, the row says when the run was, and the answer shows once — in its Result.
    expect(row.textContent).not.toContain('What would you like to work on?')
    expect(row.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(history.textContent!.match(/What would you like to work on\?/g)).toHaveLength(1)
    const body = history.querySelector('[data-history-body="1"]')!
    expect(body.className).toContain('border-l')
    expect(body.querySelector('[data-brief="1"]')?.textContent).toContain('Hi')
  })
})

describe('a settled thought', () => {
  it('shows where it ended up, not the restated request', () => {
    const text = ['The user sent `/design-level-up` with no instructions.', 'I will read styles.css, then offer the menu.'].join(
      String.fromCharCode(10)
    )
    expect(thoughtLine(text)).toBe('I will read styles.css, then offer the menu.')
  })

  it('takes the last sentence of a long last paragraph', () => {
    const long = `${'The workspace is VYOTIQ and it has a mature design system with tokens. '.repeat(3)}So I will ask once.`
    expect(thoughtLine(long)).toBe('So I will ask once.')
  })

  it('cuts at a word and never leaves a stop before the ellipsis', () => {
    // One sentence, so the cut is ours; it lands just after "ask,".
    const sentence = `${'word '.repeat(29)}ask, ${'more '.repeat(30)}`.trim()
    const line = thoughtLine(sentence, 150)
    expect(line).toBe(`${'word '.repeat(29)}ask…`)
  })

  it('is opened by find in record when it holds a match', () => {
    const items: UiItem[] = [
      user('Go', 0, 0),
      { kind: 'message', id: 'a-think', role: 'assistant', content: '', thinking: 'Needle in the middle.\nThen the end.', at: at(1) },
      said('Done.', 2)
    ]
    const model = buildRecordModel(items, { running: false, showThinking: true })
    expect([...foldsToOpen(model.runs, 'needle')]).toContain(thoughtOpenKey('a-think:thought'))
  })
})

describe('the context meter glyph', () => {
  it('is a pie, not a ring with an arc', () => {
    const { container } = render(<Pie value={0.25} size={12} />)
    const svg = container.querySelector('svg')!
    expect(svg.querySelector('[stroke-linecap="round"]')).toBeNull()
    expect(svg.querySelector('[data-pie-fill]')?.tagName.toLowerCase()).toBe('path')
    cleanup()
    // 3% is an outline only: a wedge that thin is a line, and read as a clock hand.
    expect(render(<Pie value={0.03} size={12} />).container.querySelector('[data-pie-fill]')).toBeNull()
    cleanup()
    const full = render(<Pie value={1} size={12} />).container.querySelector('[data-pie-fill]')!
    expect(full.tagName.toLowerCase()).toBe('circle')
    cleanup()
    expect(render(<Pie value={0} size={12} />).container.querySelector('[data-pie-fill]')).toBeNull()
  })
})
