import { useEffect, useRef, useState } from 'react'
import type { PromptStructureAnswer, PromptTaskType } from '@shared/ipc'
import type { UiAgentQuestionItem } from '@shared/transcript'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, cn } from '@renderer/lib/ui'
import { COMPOSER_BOX_BLEED } from '@renderer/lib/utils/layout'
import { QuestionField } from '../askQuestion/QuestionFields'
import type { StructureHandle, StructurePhase } from './useStructure'

/*
  What Structure is doing, just above the composer box: a slim row while it
  writes, after it wrote (Undo, Try again) or when it could not; a small panel
  when it needs to ask first. Rows sit on the follow-up queue's edges; the
  panel on the box's.
*/

const TYPE_LABEL: Record<PromptTaskType, string | null> = {
  bug: 'bug fix',
  feature: 'feature',
  change: 'change',
  refactor: 'refactor',
  audit: 'audit',
  review: 'review',
  question: 'question',
  research: 'research',
  docs: 'docs',
  test: 'tests',
  ops: 'ops',
  other: null
}

function modKey(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘' : 'Ctrl'
}

/** Buttons never take focus from the field on press: the keys do the same thing. */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

/** `line` sits over a box that bleeds into the gutter (the instruction line, Edit and rerun); `brief` over the New task box. */
export type StructureStripPlacement = 'line' | 'brief'

function Row({ children, placement }: { children: React.ReactNode; placement: StructureStripPlacement }) {
  return (
    <div
      className={cn(
        // A split pane (280px at the least) sheds the keycaps first, as the control row does.
        'flex h-8 min-w-0 items-center gap-2 pr-2 text-xs @max-[440px]:[&_span:has(>kbd)]:hidden',
        placement === 'brief' ? 'pl-4' : 'pl-3'
      )}
      role="status"
    >
      {children}
    </div>
  )
}

type FieldState = { values: string[]; customText: string }

function Questions({
  phase,
  structure,
  placement
}: {
  phase: Extract<StructurePhase, { kind: 'asking' }>
  structure: StructureHandle
  placement: StructureStripPlacement
}) {
  const [fields, setFields] = useState<Record<string, FieldState>>({})
  const rootRef = useRef<HTMLFormElement>(null)
  const items: UiAgentQuestionItem[] = phase.questions.map((q) => ({
    id: q.id,
    prompt: q.question,
    type: q.multi ? 'multi' : 'single',
    options: q.options,
    allowCustom: true
  }))

  // The first choice takes focus, so the questions can be answered from the keys.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('button[role="radio"], button[role="checkbox"], input')?.focus()
  }, [phase.questions])

  const submit = (): void => {
    const answers: PromptStructureAnswer[] = []
    for (const q of phase.questions) {
      const values = (fields[q.id]?.values ?? []).map((v) => v.trim()).filter(Boolean)
      if (values.length) answers.push({ question: q.question, answer: values.join(', ').slice(0, 1000) })
    }
    structure.answer(answers)
  }

  const count = phase.questions.length
  return (
    <form
      ref={rootRef}
      className={cn('rounded-lg border border-border bg-bg', placement === 'brief' ? 'mb-3' : cn('mb-1.5', COMPOSER_BOX_BLEED))}
      aria-label="Questions before the brief"
      data-structure-open
      data-structure-questions
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex h-8 min-w-0 items-center gap-2 pl-3 pr-2 text-xs">
        <Icon name="sparkles" size={13} className="shrink-0 text-muted" />
        <span className="font-medium text-fg">Before the brief</span>
        <span className="text-tertiary">{count === 1 ? 'one question' : `${count} questions`}</span>
        <span className="flex-1" />
        <Button type="button" size="xs" variant="ghost" onMouseDown={keepFocus} onClick={structure.skipQuestions}>
          Skip — write it now
        </Button>
        <IconButton icon="close" label="Cancel (Esc)" size="xs" tone="muted" onClick={structure.cancel} />
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
        {items.map((item, index) => {
          const promptId = `structure-q-${index}`
          const state = fields[item.id] ?? { values: [], customText: '' }
          return (
            <div key={item.id} className="flex flex-col gap-1.5">
              <div id={promptId} className="text-sm font-medium text-fg-strong [overflow-wrap:anywhere]">
                {item.prompt}
              </div>
              <QuestionField
                item={item}
                values={state.values}
                customText={state.customText}
                promptId={promptId}
                selectOnArrow
                onSubmitShortcut={submit}
                onChange={(values, customText) => setFields((prev) => ({ ...prev, [item.id]: { values, customText } }))}
              />
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="secondary" kbd={[modKey(), '↵']}>
            Write the brief
          </Button>
          <span className="text-caption text-tertiary">Anything left unanswered is listed as an assumption.</span>
        </div>
      </div>
    </form>
  )
}

/** Structure's state above the composer; nothing when it is idle. */
export function StructureStrip({
  structure,
  placement = 'line'
}: {
  structure: StructureHandle
  placement?: StructureStripPlacement
}) {
  const { phase } = structure
  switch (phase.kind) {
    case 'idle':
      return null
    case 'working':
      return (
        <div className="@container" data-structure-open data-structure-working>
          <Row placement={placement}>
            <Icon name="loader" size={13} className="shrink-0 text-muted motion-safe:animate-spin" />
            <span className="min-w-0 truncate text-muted">
              {phase.answering ? 'Writing the brief with your answers…' : 'Writing a brief from your instruction…'}
            </span>
            <span className="flex-1" />
            <Button size="xs" variant="ghost" kbd={['Esc']} onMouseDown={keepFocus} onClick={structure.cancel}>
              Cancel
            </Button>
          </Row>
        </div>
      )
    case 'asking':
      return <Questions phase={phase} structure={structure} placement={placement} />
    case 'done': {
      if (!phase.shown) return null
      const type = TYPE_LABEL[phase.taskType]
      const missing = phase.notFound.length
      const moved = phase.movedChecks?.length ?? 0
      const toMove = structure.checksToMove
      return (
        <div className="@container" data-structure-done>
          <Row placement={placement}>
            <Icon name="sparkles" size={13} className="shrink-0 text-muted" />
            <span className="shrink-0 text-fg">Structured</span>
            {type ? <span className="min-w-0 truncate text-muted">{type} brief</span> : null}
            {missing > 0 ? (
              <span
                className="flex shrink-0 items-center gap-1 text-warning"
                title={`Not in this workspace: ${phase.notFound.join(', ')}`}
              >
                <Icon name="warningCircle" size={12} />
                {missing === 1 ? '1 path not found' : `${missing} not found`}
              </span>
            ) : null}
            {moved > 0 ? (
              <span className="shrink-0 text-muted" data-structure-moved-checks>
                {moved === 1 ? '1 check added' : `${moved} checks added`}
              </span>
            ) : null}
            <span className="flex-1" />
            {toMove > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                title="Done when bullets become the checks the run is judged against"
                onMouseDown={keepFocus}
                onClick={structure.moveChecks}
                data-structure-move-checks
              >
                {`Move ${toMove} to checks`}
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" kbd={[modKey(), 'Z']} onMouseDown={keepFocus} onClick={structure.undo}>
              Undo
            </Button>
            <Button size="xs" variant="ghost" onMouseDown={keepFocus} onClick={structure.retry}>
              Try again
            </Button>
            <IconButton icon="close" label="Hide" size="xs" tone="muted" onClick={structure.dismiss} />
          </Row>
        </div>
      )
    }
    case 'error':
      return (
        <div className="@container" data-structure-error>
          <Row placement={placement}>
            <Icon name="warningCircle" size={13} className="shrink-0 text-warning" />
            <span className="min-w-0 truncate text-muted" title={phase.message}>
              Couldn’t structure it: {phase.message}
            </span>
            <span className="flex-1" />
            <Button size="xs" variant="ghost" onMouseDown={keepFocus} onClick={structure.retry}>
              Try again
            </Button>
            <IconButton icon="close" label="Dismiss" size="xs" tone="muted" onClick={structure.dismiss} />
          </Row>
        </div>
      )
  }
}
