/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AskQuestionPanel } from '@renderer/features/chat/components/AskQuestionPanel'
import type { UiAgentQuestion } from '@shared/transcript'

afterEach(() => {
  cleanup()
})

function baseQuestion(partial: Partial<UiAgentQuestion> & Pick<UiAgentQuestion, 'questions'>): UiAgentQuestion {
  return {
    requestId: 'q1',
    toolCallId: 't1',
    ...partial
  }
}

describe('AskQuestionPanel', () => {
  it('quick-submits a single-choice selection without a second click', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'q1', prompt: 'Which path?', type: 'single', options: ['A', 'B'] }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    expect(screen.queryByRole('button', { name: 'Submit answer' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('q1', [{ questionId: 'q1', values: ['A'] }])
    expect(await screen.findByText('Answered')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
  })

  it('still needs Submit for a single choice with an Other… field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'q1', prompt: 'Which path?', type: 'single', options: ['A', 'B'], allowCustom: true }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
    expect(onSubmit).toHaveBeenCalledWith('q1', [{ questionId: 'q1', values: ['A'] }])
  })

  it('skips the form with empty answers', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Which path?', type: 'single', options: ['A', 'B'] }]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('q1', [])
    expect(await screen.findByText('Skipped — agent continues with a reasonable default.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
  })

  it('moves focus and selection with arrow keys in non-quick forms', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          title: 'Two questions',
          questions: [
            { id: 'a', prompt: 'First?', type: 'single', options: ['A', 'B'] },
            { id: 'b', prompt: 'Second?', type: 'single', options: ['C', 'D'] }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    const optionA = screen.getByRole('radio', { name: 'A' })
    optionA.focus()
    fireEvent.keyDown(optionA.parentElement!, { key: 'ArrowDown' })
    const optionB = screen.getByRole('radio', { name: 'B' })
    expect(document.activeElement).toBe(optionB)
    expect(optionB.getAttribute('aria-checked')).toBe('true')
  })

  it('does not select on arrow keys in quick-submit forms', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Pick', type: 'single', options: ['A', 'B'] }]
        })}
        onSubmit={onSubmit}
      />
    )

    const optionA = screen.getByRole('radio', { name: 'A' })
    optionA.focus()
    fireEvent.keyDown(optionA.parentElement!, { key: 'ArrowDown' })
    const optionB = screen.getByRole('radio', { name: 'B' })
    expect(document.activeElement).toBe(optionB)
    expect(optionB.getAttribute('aria-checked')).toBe('false')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits multi-select values', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            {
              id: 'q1',
              prompt: 'Pick features',
              type: 'multi',
              options: ['A', 'B', 'C']
            }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))

    expect(onSubmit).toHaveBeenCalledWith('q1', [{ questionId: 'q1', values: ['A', 'C'] }])
  })

  it('quick-submits a boolean Yes/No answer', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Continue?', type: 'boolean' }]
        })}
        onSubmit={onSubmit}
      />
    )

    expect(screen.queryByRole('button', { name: 'Submit answer' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('q1', [{ questionId: 'q1', values: ['Yes'] }])
  })

  it('requires every question in a multi-question form', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          title: 'Setup',
          questions: [
            { id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
            { id: 'b', prompt: 'Notes', type: 'text' }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByText('Setup')).toBeTruthy()
    expect(screen.getByText('2 questions')).toBeTruthy()
    expect(screen.getByText('Waiting for your answer — agent continues if skipped.')).toBeTruthy()
    expect(screen.getByText('0 of 2 answered')).toBeTruthy()
    expect(screen.getAllByText('Unanswered')).toHaveLength(2)
    // The why-not reason renders as a styled tooltip — native titles never
    // show on disabled controls.
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(submit.getAttribute('title')).toBeNull()
    fireEvent.pointerEnter(submit.parentElement!)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Still need: Mode?; Notes')
    fireEvent.click(screen.getByRole('radio', { name: 'Ask' }))
    expect(screen.getByRole('button', { name: 'Submit answers' }).hasAttribute('disabled')).toBe(
      true
    )
    expect(screen.getByText('1 of 2 answered')).toBeTruthy()
    expect(screen.getByText('Unanswered')).toBeTruthy()
    // Tip follows the updated why-not reason for the remaining question
    fireEvent.pointerLeave(submit.parentElement!)
    fireEvent.pointerEnter(submit.parentElement!)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Still need: Notes')

    fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
      target: { value: 'ship it' }
    })
    expect(screen.queryByText(/of 2 answered/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(onSubmit).toHaveBeenCalledWith('q1', [
      { questionId: 'a', values: ['Ask'] },
      { questionId: 'b', values: ['ship it'] }
    ])
  })

  it('uses a single header label when multi-question form has no title', () => {
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'a', prompt: 'First?', type: 'single', options: ['A', 'B'] },
            { id: 'b', prompt: 'Second?', type: 'single', options: ['C', 'D'] }
          ]
        })}
      />
    )
    expect(screen.getByText('2 questions')).toBeTruthy()
    expect(screen.queryByText('Questions')).toBeNull()
  })

  it('marks selected options with inset ring classes distinct from hover', () => {
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'a', prompt: 'First?', type: 'single', options: ['A', 'B'] },
            { id: 'b', prompt: 'Second?', type: 'single', options: ['C', 'D'] }
          ]
        })}
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    const selected = screen.getByRole('radio', { name: 'A' })
    expect(selected.className).toMatch(/ring-inset/)
    expect(selected.className).toMatch(/bg-surface-2/)
    expect(selected.getAttribute('aria-checked')).toBe('true')
  })

  it('disables submit when onSubmit is missing', () => {
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'No handler?', type: 'text' }]
        })}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
      target: { value: 'hello' }
    })

    expect(screen.getByRole('button', { name: 'Submit answer' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('shows Submit after quick-submit failure so the user can retry', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Retry?', type: 'single', options: ['A', 'B'] }]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'A' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit answer' }).hasAttribute('disabled')).toBe(
      false
    )
  })

  it('restores idle after submit failure', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'))
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Retry?', type: 'text' }]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
      target: { value: 'yes' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('boom')
    expect(screen.getByRole('button', { name: 'Submit answer' }).hasAttribute('disabled')).toBe(
      false
    )
  })

  it('hides custom text unless allowCustom is set', () => {
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'q1', prompt: 'Pick', type: 'single', options: ['A', 'B'] }
          ]
        })}
      />
    )
    expect(screen.queryByPlaceholderText('Other…')).toBeNull()
  })

  it('uses quiet question-gate chrome instead of a tool card', () => {
    const { container } = render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Pick', type: 'single', options: ['A'] }]
        })}
      />
    )
    const form = container.querySelector('form')
    expect(form?.className).toMatch(/border-l-2/)
    expect(form?.className).toMatch(/bg-surface\/60/)
    expect(form?.className).not.toMatch(/border-border(?!\/)/)
  })

  it('resets field selections when the question shape changes for the same requestId', () => {
    const { rerender } = render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'q1', prompt: 'Which path?', type: 'single', options: ['A', 'B'] }
          ]
        })}
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('true')

    rerender(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [
            { id: 'q1', prompt: 'Which path now?', type: 'single', options: ['A', 'B', 'C'] }
          ]
        })}
      />
    )
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'C' })).toBeTruthy()
  })

  it('shows a settled confirmation after answer and a waiting hint while idle', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          questions: [{ id: 'q1', prompt: 'Continue?', type: 'boolean' }]
        })}
        onSubmit={onSubmit}
      />
    )
    expect(screen.getByText('Waiting for your answer — agent continues if skipped.')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(await screen.findByText('Answered')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.queryByText('Waiting for your answer — agent continues if skipped.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
  })

  it('dims unanswered prompts and shows labeled settled summary for multi-question forms', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AskQuestionPanel
        question={baseQuestion({
          title: 'Setup',
          questions: [
            { id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
            { id: 'b', prompt: 'Notes', type: 'text' }
          ]
        })}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Ask' }))
    const modePrompt = document.getElementById('ask-q-prompt-q1-a')
    const notesPrompt = document.getElementById('ask-q-prompt-q1-b')
    expect(modePrompt?.className).not.toMatch(/opacity-90/)
    expect(notesPrompt?.className).toMatch(/opacity-90/)

    fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
      target: { value: 'ship it' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }))

    expect(await screen.findByText('Answered')).toBeTruthy()
    expect(screen.getByText('Mode?: Ask · Notes: ship it')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
  })
})
