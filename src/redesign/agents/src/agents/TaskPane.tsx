import { useEffect, useRef } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, Tooltip, cn } from '@renderer/lib/ui'
import { Composer } from './Composer'
import { PlanLine, PopMenu } from './parts'
import { Record } from './Record'
import { recordOf, statusOf, taskOf } from './runtime'
import { InstancePane } from './SideViews'
import { useActions, useAgents } from './store'
import { useTaskMenu } from './TaskList'

/*
  The task pane. A 40px header with the title in ink and one word on where it
  stands; its bottom edge is the plan, so progress costs no row of its own.
  Stop sits here while it works, never in the box. Then the record, then the
  box. An open instance takes the record's place, with its own way back.
*/

const TONE = { quiet: 'text-tertiary', accent: 'text-accent', danger: 'text-danger', success: 'text-success' } as const

export function TaskPane() {
  const { s } = useAgents()
  return s.instance ? <InstancePane id={s.instance} /> : <TaskRecordPane />
}

function TaskRecordPane() {
  const { s, d } = useAgents()
  const act = useActions()
  const t = taskOf(s, s.agent)
  const data = recordOf(s, t.id)
  const status = statusOf(s, t.id)
  const live = t.state === 'running' || t.state === 'needs'
  // Stop is its own button in the header while it works, so the menu doesn't repeat it.
  const menu = useTaskMenu(t).filter((m) => m.id !== 'stop')
  const scroller = useRef<HTMLDivElement>(null)
  const steps = data.steps.map((st) => ({ title: st.title, state: st.state }))

  // A followed task stays on its latest line; opening another starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [t.id])
  const tail = (s.followUps[t.id]?.length ?? 0) + (s.steers[t.id]?.length ?? 0) + (s.answers[t.id]?.length ?? 0)
  useEffect(() => {
    if (tail) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [tail])

  const question = t.state === 'needs' && t.ask?.kind === 'question'
  const placeholder = question
    ? 'Answer in your own words, or pick one above…'
    : t.state === 'running' || t.state === 'needs'
      ? 'Steer it, or queue what comes next…'
      : t.state === 'failed'
        ? 'Tell it what to do differently, or Retry above…'
        : t.state === 'stopped'
          ? 'Say what to change before it resumes…'
          : 'Ask for a change, or a follow-up…'

  return (
    <section aria-label={t.title} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg-strong">{t.title}</h1>
        {t.worktree ? (
          <Tooltip content="Runs in its own worktree: your checkout is untouched until you merge">
            <span className="inline-flex min-w-[40px] shrink-[4] items-center gap-1 truncate font-mono text-caption text-tertiary">
              <Icon name="fork" size={12} />
              {t.branch}
            </span>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        <span className={cn('shrink-0 text-caption', TONE[status.tone])}>
          {status.step ? (
            <>
              {status.text === 'Step' ? 'Step' : `${status.text} · step`} <span className="font-mono tnum">{status.step[0]}</span> of{' '}
              <span className="font-mono tnum">{status.step[1]}</span>
            </>
          ) : (
            status.text
          )}
        </span>
        {live ? (
          <Tooltip content="Stop (Ctrl+.)">
            <Button size="xs" variant="ghost" icon="stop" onClick={() => act.stop(t.id)}>
              Stop
            </Button>
          </Tooltip>
        ) : null}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <IconButton
          icon="inspector"
          label={s.wsOpen ? 'Hide the side pane (Ctrl+I)' : 'Show the side pane (Ctrl+I)'}
          size="sm"
          tone="muted"
          active={s.wsOpen}
          onClick={() => d({ type: 'ws', open: !s.wsOpen })}
        />
        <PopMenu
          label="Task actions"
          items={menu}
          align="end"
          trigger={(tr, open) => (
            <IconButton
              ref={tr.ref}
              icon="more"
              label="More"
              size="sm"
              tone="muted"
              active={open}
              aria-expanded={tr['aria-expanded']}
              aria-controls={tr['aria-controls']}
              aria-haspopup={tr['aria-haspopup']}
              onClick={tr.onClick}
            />
          )}
        />
        <PlanLine steps={steps} className="absolute inset-x-0 -bottom-px z-sticky" />
      </header>

      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-4">
          <Record key={t.id} id={t.id} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[720px] shrink-0 px-4 pb-4">
        <Composer kind="line" agent={t.id} placeholder={placeholder} />
      </div>
    </section>
  )
}
