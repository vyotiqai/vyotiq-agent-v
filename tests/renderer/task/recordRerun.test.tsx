/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ChatMessage } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RewindDialog, rerunNeedsConfirm, rewindSummary } from '@renderer/features/task/RewindDialog'
import { useComposerEditState } from '@renderer/features/chat/hooks/composerShared'

/**
 * "Run this again": the latest finished answer can be asked for again. It
 * goes back to before its instruction and sends that instruction as it was,
 * asking first when that would put files back.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-07T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Regroup Settings', at: at(0) },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'Settings regrouped.', at: at(30) },
  { kind: 'message', id: 'user-2', role: 'user', content: 'Also move Shortcuts under App', at: at(60) },
  { kind: 'message', id: 'a3', role: 'assistant', content: 'Moved.', at: at(90) }
]

function show(options: BuildOptions, onRerun = vi.fn()) {
  render(<TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={4} onRerun={onRerun} />)
  return onRerun
}

describe('Run this again, in the record', () => {
  it('sits on the latest answer’s receipt and hands over its brief and run', () => {
    const onRerun = show({ running: false })
    const buttons = screen.getAllByRole('button', { name: 'Run this again' })
    // Only the latest run: an earlier one has been moved past.
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    // Nothing was said into it while it worked.
    expect(onRerun).toHaveBeenCalledWith(2, 2, 0)
  })

  it('finds the instruction of a run a queued follow-up started, by its turn', () => {
    // Applied from the queue, the follow-up keeps the id it was queued under.
    const queued = items.map((it) => (it.id === 'user-2' ? { ...it, id: 'followup-q1' } : it))
    const onRerun = vi.fn()
    const options = { running: false }
    render(
      <TaskRecord
        model={buildRecordModel(queued, options)}
        options={options}
        messageCount={4}
        userMessageIndexes={[0, 2]}
        onRerun={onRerun}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run this again' }))
    expect(onRerun).toHaveBeenCalledWith(2, 2, 0)
  })

  it('says how many messages were said into the run, which a rerun does not send again', () => {
    const steered: UiItem[] = [
      ...items.slice(0, 3),
      { kind: 'message', id: 'user-3', role: 'user', content: 'Keep App first', at: at(70), midTurn: true },
      { kind: 'message', id: 'a4', role: 'assistant', content: 'Moved, App first.', at: at(90) }
    ]
    const onRerun = vi.fn()
    const options = { running: false }
    render(<TaskRecord model={buildRecordModel(steered, options)} options={options} messageCount={5} onRerun={onRerun} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run this again' }))
    expect(onRerun).toHaveBeenCalledWith(2, 2, 1)
  })

  it('is not offered while the run works, or on a run that failed or stopped', () => {
    show({ running: true })
    expect(screen.queryByRole('button', { name: 'Run this again' })).toBeNull()
    cleanup()
    show({ running: false, failed: true })
    expect(screen.queryByRole('button', { name: 'Run this again' })).toBeNull()
  })
})

describe('the rerun confirmation', () => {
  const file = { path: 'src/a.ts', action: 'modified' as const, undoable: true, edited: false, partway: false }

  it('says the run runs again and which files go back first', () => {
    expect(rewindSummary({ runN: 2, files: [file], rerun: true })).toBe(
      'This run’s work and answer leave the record and the same instruction runs again. First, this file goes back to how it was.'
    )
    expect(rewindSummary({ runN: 2, files: null, rerun: true })).toContain('the files it changed go back')
  })

  it('asks only when files would go back, when the preview could not say, or when something said would be lost', () => {
    expect(rerunNeedsConfirm([])).toBe(false)
    expect(rerunNeedsConfirm([file])).toBe(true)
    expect(rerunNeedsConfirm(null)).toBe(true)
    expect(rerunNeedsConfirm([], 1)).toBe(true)
  })

  it('says what was said into the run is not sent again', () => {
    expect(rewindSummary({ runN: 2, files: [], rerun: true, said: 1 })).toBe(
      'This run’s work and answer leave the record and the same instruction runs again. What you said while it worked is not sent again.'
    )
    expect(rewindSummary({ runN: 2, files: [file], rerun: true, said: 2 })).toBe(
      'This run’s work and answer leave the record and the same instruction runs again. First, this file goes back to how it was. The 2 messages you sent while it worked are not sent again.'
    )
  })

  it('names its action Run again, not Rewind', () => {
    render(<RewindDialog ask={{ runN: 2, files: [file], rerun: true }} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Run this again?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Rewind/ })).toBeNull()
  })
})

describe('rerunPrompt', () => {
  it('sends the instruction as stored, attachments and all', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarise the notes' },
          { type: 'file', name: 'notes.md', mime: 'text/markdown', text: '# Notes' }
        ],
        at: at(0)
      },
      { role: 'assistant', content: 'Done.', at: at(5) }
    ]
    const onEditAndResend = vi.fn(async () => true)
    const { result } = renderHook(() =>
      useComposerEditState({ surfaceKey: 'k', messages, onSend: vi.fn(), onEditAndResend })
    )
    let ok = false
    await act(async () => {
      ok = await result.current.rerunPrompt(0)
    })
    expect(ok).toBe(true)
    expect(onEditAndResend).toHaveBeenCalledWith(
      0,
      'Summarise the notes',
      undefined,
      [{ type: 'file', name: 'notes.md', mime: 'text/markdown', text: '# Notes' }],
      undefined
    )
  })

  it('does nothing for a message that is not yours', async () => {
    const onEditAndResend = vi.fn(async () => true)
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'Hi', at: at(0) }]
    const { result } = renderHook(() =>
      useComposerEditState({ surfaceKey: 'k', messages, onSend: vi.fn(), onEditAndResend })
    )
    await act(async () => {
      expect(await result.current.rerunPrompt(0)).toBe(false)
    })
    expect(onEditAndResend).not.toHaveBeenCalled()
  })
})

describe('the work line across a rerun', () => {
  it('folds the new answer’s work even when the last one’s was left open', () => {
    // A rerun keeps the brief's id, so the same record view carries on.
    const worked: UiItem[] = [
      ...items.slice(0, 3),
      {
        kind: 'tool',
        id: 't1',
        at: at(61),
        endedAt: at(62),
        tool: { id: 'c1', name: 'read', summary: 'src/app.ts', status: 'done', content: 'x', argsPreview: '{"path":"src/app.ts"}' }
      },
      items[3]!
    ]
    const done = { running: false }
    const view = render(<TaskRecord model={buildRecordModel(worked, done)} options={done} messageCount={4} />)
    const line = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-work-fold] > div > button')!
    expect(line().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(line())
    expect(line().getAttribute('aria-expanded')).toBe('true')
    // Run again: the run works, then answers again.
    const live = { running: true }
    view.rerender(<TaskRecord model={buildRecordModel(worked.slice(0, 3), live)} options={live} messageCount={3} />)
    view.rerender(<TaskRecord model={buildRecordModel(worked, done)} options={done} messageCount={4} />)
    expect(line().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the brief', () => {
  it('reads as your side of the conversation: a bubble on the right edge, as wide as its words', () => {
    const { container } = render(
      <TaskRecord model={buildRecordModel(items.slice(0, 2), { running: false })} options={{ running: false }} messageCount={2} />
    )
    const brief = container.querySelector<HTMLElement>('[data-brief="1"]')!
    expect(brief.classList.contains('ml-auto')).toBe(true)
    expect(brief.classList.contains('w-fit')).toBe(true)
    expect(brief.classList.contains('max-w-[85%]')).toBe(true)
    // The skin's radius: `rounded-xl` is not mapped to a token and would be a fixed 12px in every skin.
    expect(brief.classList.contains('rounded-lg')).toBe(true)
  })
})
