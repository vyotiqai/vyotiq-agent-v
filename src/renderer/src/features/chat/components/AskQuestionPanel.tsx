import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Tooltip, cn, MarkdownContent } from '@renderer/lib/ui'
import {
  QUESTION_GATE_BODY,
  QUESTION_GATE_FOOTER,
  QUESTION_GATE_HEADER,
  QUESTION_GATE_SURFACE
} from '@renderer/lib/utils/layout'
import { questionTypeHint } from '@shared/utils/agentQuestionForm'
import type { UiAgentQuestion, UiAgentQuestionAnswer } from '@shared/transcript'
import { QuestionField } from './askQuestion/QuestionFields'

type FieldState = { values: string[]; customText: string }

function emptyFields(question: UiAgentQuestion): Record<string, FieldState> {
  const out: Record<string, FieldState> = {}
  for (const item of question.questions) {
    out[item.id] = { values: [], customText: '' }
  }
  return out
}

function fieldIsAnswered(item: UiAgentQuestion['questions'][number], state: FieldState): boolean {
  const values = state.values.map((v) => v.trim()).filter(Boolean)
  if (item.type === 'multi') return values.length > 0
  if (item.type === 'text') return values.length === 1 && values[0]!.length > 0
  return values.length === 1
}

function collectAnswers(
  question: UiAgentQuestion,
  fields: Record<string, FieldState>
): UiAgentQuestionAnswer[] {
  return question.questions.map((item) => {
    const state = fields[item.id] ?? { values: [], customText: '' }
    const values = state.values.map((v) => v.trim()).filter(Boolean)
    return { questionId: item.id, values }
  })
}

function formatSettledAnswers(
  question: UiAgentQuestion,
  fields: Record<string, FieldState>
): string {
  const parts: string[] = []
  for (const item of question.questions) {
    const state = fields[item.id] ?? { values: [], customText: '' }
    const values = state.values.map((v) => v.trim()).filter(Boolean)
    if (values.length === 0) continue
    const joined = values.join(', ')
    if (question.questions.length === 1) {
      parts.push(joined)
    } else {
      parts.push(`${item.prompt}: ${joined}`)
    }
  }
  return parts.join(' · ')
}

/** Single-question forms with fixed choices submit on selection — no extra click. */
function isQuickSubmitForm(question: UiAgentQuestion): boolean {
  if (question.questions.length !== 1) return false
  const item = question.questions[0]!
  if (item.type === 'boolean') return true
  return item.type === 'single' && item.allowCustom !== true
}

export const AskQuestionPanel = memo(function AskQuestionPanel({
  question,
  onSubmit
}: {
  question: UiAgentQuestion
  onSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'answered' | 'skipped'>('idle')
  const [localError, setLocalError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, FieldState>>(() => emptyFields(question))
  const rootRef = useRef<HTMLFormElement | null>(null)
  const mountedRef = useRef(true)

  // Same requestId can be replaced in place with new prompts/options; remount does not run.
  const questionShapeKey = useMemo(
    () =>
      [
        question.requestId,
        question.title ?? '',
        ...question.questions.map(
          (item) =>
            `${item.id}\u0000${item.prompt}\u0000${item.type}\u0000${item.allowCustom ? 1 : 0}\u0000${(item.options ?? []).join('\u001f')}`
        )
      ].join('\n'),
    [question]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setFields(emptyFields(question))
    setPhase('idle')
    setLocalError(null)
    // Only when shape changes — same requestId with a new object must not wipe in-progress answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by questionShapeKey
  }, [questionShapeKey])

  // Focus first control; scroll after MessageList's pin-to-bottom rAF so the gate header stays visible.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const first = root.querySelector<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled])'
    )
    first?.focus({ preventScroll: true })
  }, [questionShapeKey])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const transcript = root.closest('[data-transcript-scroll]')
    if (!(transcript instanceof HTMLElement)) return
    let cancelled = false
    let outerRaf = 0
    let innerRaf = 0
    outerRaf = window.requestAnimationFrame(() => {
      innerRaf = window.requestAnimationFrame(() => {
        if (cancelled) return
        const rootRect = root.getBoundingClientRect()
        const transcriptRect = transcript.getBoundingClientRect()
        const targetTop = transcript.scrollTop + (rootRect.top - transcriptRect.top)
        transcript.scrollTop = Math.max(0, targetTop)
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(outerRaf)
      window.cancelAnimationFrame(innerRaf)
    }
  }, [questionShapeKey])

  // After a failed send, return focus to Submit (or first control) so retry is keyboard-reachable.
  useEffect(() => {
    if (!localError || phase !== 'idle') return
    const root = rootRef.current
    if (!root) return
    const submit = root.querySelector<HTMLElement>('button[type="submit"]:not([disabled])')
    const first = root.querySelector<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled])'
    )
    ;(submit ?? first)?.focus({ preventScroll: true })
  }, [localError, phase])

  const multi = question.questions.length > 1
  const quickSubmit = isQuickSubmitForm(question)
  const titled = Boolean(question.title?.trim())
  // Untitled multi: one label ("4 questions") — avoid "Questions" + "4 questions".
  const headerTitle = titled
    ? question.title!.trim()
    : multi
      ? `${question.questions.length} questions`
      : 'Question'
  const singleHint =
    !multi && question.questions[0] ? questionTypeHint(question.questions[0].type) : null

  const answeredCount = useMemo(
    () =>
      question.questions.filter((item) =>
        fieldIsAnswered(item, fields[item.id] ?? { values: [], customText: '' })
      ).length,
    [fields, question.questions]
  )

  const allAnswered = answeredCount === question.questions.length
  const settled = phase === 'answered' || phase === 'skipped'
  const settledSummary =
    phase === 'answered' ? formatSettledAnswers(question, fields) : ''

  const submitAnswers = (
    answers: UiAgentQuestionAnswer[],
    outcome: 'answered' | 'skipped'
  ): void => {
    if (phase !== 'idle' || !onSubmit) return
    setPhase('pending')
    setLocalError(null)
    void Promise.resolve(onSubmit(question.requestId, answers))
      .then(() => {
        if (!mountedRef.current) return
        setPhase(outcome)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setPhase('idle')
        setLocalError(err instanceof Error ? err.message : 'Could not send answer')
      })
  }

  const setField = (id: string, values: string[], customText: string): void => {
    if (phase !== 'idle') return
    setFields((prev) => ({ ...prev, [id]: { values, customText } }))
    if (quickSubmit) {
      const item = question.questions[0]!
      if (item.id === id && values.length === 1 && values[0]!.trim()) {
        submitAnswers([{ questionId: id, values: [values[0]!.trim()] }], 'answered')
      }
    }
  }

  const submit = (): void => {
    if (phase !== 'idle' || !allAnswered || !onSubmit) return
    submitAnswers(collectAnswers(question, fields), 'answered')
  }

  const skip = (): void => {
    if (phase !== 'idle' || !onSubmit) return
    // Empty answers is the skip/dismiss signal — the tool resumes with
    // proceed-default guidance (ok:true).
    submitAnswers([], 'skipped')
  }

  const onFormSubmit = (e: FormEvent): void => {
    e.preventDefault()
    submit()
  }

  const busy = phase !== 'idle'
  const canSubmit = Boolean(onSubmit) && allAnswered && !busy
  const canSkip = Boolean(onSubmit) && !busy
  const idleSubmitLabel = multi ? 'Submit answers' : 'Submit answer'
  const submitLabel =
    phase === 'pending'
      ? 'Sending…'
      : phase === 'answered'
        ? 'Answered'
        : phase === 'skipped'
          ? 'Skipped'
          : idleSubmitLabel
  const progressId = `ask-q-progress-${question.requestId}`
  const showProgress = multi && phase === 'idle' && !allAnswered
  const unansweredPrompts = showProgress
    ? question.questions
        .filter((item) => !fieldIsAnswered(item, fields[item.id] ?? { values: [], customText: '' }))
        .map((item) => item.prompt)
    : []
  const submitTitle =
    !canSubmit && phase === 'idle'
      ? multi
        ? unansweredPrompts.length > 0
          ? `Still need: ${unansweredPrompts.join('; ')}`
          : 'Answer all questions to submit'
        : 'Choose an answer to submit'
      : undefined
  // Quick-submit: picking an option sends immediately — hide the inert Submit control.
  // After a failed send, show Submit so the user can retry explicitly.
  const showSubmit = !settled && (!quickSubmit || phase !== 'idle' || Boolean(localError))

  return (
    <form
      ref={rootRef}
      className={cn(QUESTION_GATE_SURFACE, 'w-full')}
      aria-labelledby={`ask-q-title-${question.requestId}`}
      aria-busy={phase === 'pending' ? true : undefined}
      onSubmit={onFormSubmit}
    >
      <div className={QUESTION_GATE_HEADER}>
        <span
          id={`ask-q-title-${question.requestId}`}
          className="shrink-0 font-medium text-fg"
        >
          {headerTitle}
        </span>
        {settled ? (
          <span className="min-w-0 truncate text-tertiary">
            {phase === 'answered' ? 'Answered' : 'Skipped'}
          </span>
        ) : singleHint ? (
          <span className="min-w-0 truncate text-tertiary">{singleHint}</span>
        ) : multi && titled ? (
          <span className="min-w-0 truncate text-tertiary">
            {question.questions.length} questions
          </span>
        ) : null}
      </div>

      {settled ? (
        <div className={cn(QUESTION_GATE_BODY, 'flex flex-col gap-1')}>
          <p className="m-0 text-sm text-fg/80 [overflow-wrap:anywhere]">
            {phase === 'skipped'
              ? 'Skipped — agent continues with a reasonable default.'
              : settledSummary || 'Answered.'}
          </p>
        </div>
      ) : (
        <>
          <div className={cn(QUESTION_GATE_BODY, 'flex flex-col gap-3')}>
            <p className="m-0 text-caption text-tertiary">
              Waiting for your answer — agent continues if skipped.
            </p>
            {question.questions.map((item) => {
              const promptId = `ask-q-prompt-${question.requestId}-${item.id}`
              const state = fields[item.id] ?? { values: [], customText: '' }
              const answered = fieldIsAnswered(item, state)
              return (
                <div key={item.id} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <div
                      id={promptId}
                      className={cn(
                        'text-sm font-medium text-fg',
                        multi && !answered && 'opacity-90'
                      )}
                    >
                      <MarkdownContent content={item.prompt} />
                    </div>
                    {multi ? (
                      <span className="text-caption text-tertiary">
                        {answered ? questionTypeHint(item.type) : 'Unanswered'}
                      </span>
                    ) : null}
                  </div>
                  <QuestionField
                    item={item}
                    values={state.values}
                    customText={state.customText}
                    disabled={busy}
                    promptId={promptId}
                    selectOnArrow={!quickSubmit}
                    onChange={(values, customText) => setField(item.id, values, customText)}
                  />
                </div>
              )
            })}

            {localError ? (
              <p className="text-xs text-danger" role="alert">
                {localError}
              </p>
            ) : null}
          </div>

          <div
            className={cn(
              QUESTION_GATE_FOOTER,
              'flex flex-wrap items-center gap-2 border-t border-border/40'
            )}
          >
            {showSubmit ? (
              // Disabled submit ignores pointer events — wrap so the why-not
              // tip (e.g. "Still need: …") actually shows.
              submitTitle ? (
                <Tooltip content={submitTitle}>
                  <span className="inline-flex cursor-not-allowed">
                    <button
                      type="submit"
                      disabled
                      aria-describedby={showProgress ? progressId : undefined}
                      aria-busy={phase === 'pending' ? true : undefined}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-tertiary disabled:opacity-[var(--vy-disabled-opacity)]"
                    >
                      {submitLabel}
                    </button>
                  </span>
                </Tooltip>
              ) : (
                <button
                  type="submit"
                  aria-describedby={showProgress ? progressId : undefined}
                  aria-busy={phase === 'pending' ? true : undefined}
                  className="rounded-md border border-accent bg-accent px-2.5 py-1 text-xs text-accent-fg hover:opacity-90"
                >
                  {submitLabel}
                </button>
              )
            ) : null}
            <Tooltip content="Skip — the agent continues with a reasonable default">
              <button
                type="button"
                disabled={!canSkip}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs text-tertiary vy-transition',
                  'hover:text-fg disabled:opacity-[var(--vy-disabled-opacity)]'
                )}
                onClick={skip}
              >
                Skip
              </button>
            </Tooltip>
            {showProgress ? (
              <span id={progressId} className="min-w-0 truncate text-caption text-tertiary">
                {answeredCount} of {question.questions.length} answered
              </span>
            ) : null}
          </div>
        </>
      )}
    </form>
  )
})
