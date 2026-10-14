import { useEffect, useMemo, useRef } from 'react'
import { Icon } from '@renderer/lib/icons'
import { StatusGlyph, cn } from '@renderer/lib/ui'
import { currentWork, mergeTurns, type Scene, type Work } from './data'
import { fakeLevel } from './Orb'
import { LiveOrb } from './LiveOrb'
import { Ask, Controls, HEADLINE, Header, Line, Problem, Result, Steps, WHO, subline } from './parts'

/*
  C · Split. Two things happen at once in a voice session, so they get two
  columns: what you and Agent V say on the left, under the orb; what its
  task is doing on the right, every step, the question it's stuck on, and
  its result in full. A hand-off in the conversation is one line pointing
  across.
*/

const GLYPH = { running: 'running', needs: 'needs', done: 'done', failed: 'failed' } as const

function WorkPane({ scene }: { scene: Scene }) {
  const work = currentWork(scene)
  const earlier = scene.entries.filter((e): e is Extract<typeof e, { who: 'work' }> => e.who === 'work').map((e) => e.work)
  earlier.pop()
  if (!work) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <Icon name="tasks" size={20} className="text-tertiary" />
        <p className="m-0 text-sm text-muted">Nothing handed over yet.</p>
        <p className="m-0 max-w-[300px] text-xs text-tertiary">Ask it to do something, and its steps show here as it works.</p>
      </div>
    )
  }
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {earlier.length ? (
        <ol className="m-0 mb-4 list-none border-b border-border/60 p-0 pb-3" aria-label="Earlier">
          {earlier.map((w) => (
            <li key={w.brief} className="flex h-7 min-w-0 items-center gap-2 text-xs">
              <StatusGlyph state={GLYPH[w.state]} size={13} />
              <span className="min-w-0 flex-1 truncate text-muted">{w.brief}</span>
              <span className="shrink-0 font-mono text-caption text-tertiary tnum">{w.elapsed}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="m-0 text-sm leading-relaxed text-secondary">{work.brief}</p>
      <div className="mt-3">
        <Steps work={work} keep={work.state === 'done' ? 0 : 12} />
      </div>
      <Ask work={work} />
      <Result work={work} clamp={false} />
    </div>
  )
}

function workTitle(work: Work | undefined): string {
  if (!work) return 'Its task'
  if (work.state === 'done') return `Done · ${work.elapsed}`
  if (work.state === 'needs') return 'Waiting for you'
  if (work.state === 'failed') return 'Stopped'
  return `Working · ${work.elapsed}`
}

export function DirectionC({ scene }: { scene: Scene }) {
  const entries = useMemo(() => mergeTurns(scene.entries), [scene.entries])
  const level = useMemo(() => fakeLevel(), [])
  const work = currentWork(scene)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, scene.partial])

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-bg" aria-label="Voice mode" data-vv-direction="c">
      <Header scene={scene} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-4 border-b border-border/60 px-6 py-5">
            <LiveOrb state={scene.state} size={88} level={level} />
            <div className="min-w-0">
              <p className="m-0 text-heading text-fg-strong">{HEADLINE[scene.state]}</p>
              {scene.problem ? null : <p className="m-0 truncate text-sm text-muted">{subline(scene)}</p>}
            </div>
          </div>
          <div ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <ol className="m-0 flex list-none flex-col px-6 py-4" aria-label="Conversation">
              {entries.map((e, i) =>
                e.who === 'work' ? (
                  <li key={e.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-vv-work={e.work.state}>
                    <span className="flex items-center gap-1.5 pt-px text-caption text-tertiary">
                      <StatusGlyph state={GLYPH[e.work.state]} size={12} />
                      {WHO.work}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
                      <span className="truncate">{e.work.brief}</span>
                      <Icon name="arrowRight" size={12} className="shrink-0 text-tertiary" />
                    </span>
                  </li>
                ) : (
                  <Line key={e.id} who={e.who} label={i === 0 || entries[i - 1]!.who !== e.who}>
                    {e.text}
                  </Line>
                )
              )}
              {scene.partial ? (
                <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5">
                  <span className="pt-px text-caption text-tertiary">{entries.at(-1)?.who === 'you' ? '' : WHO.you}</span>
                  <span className="text-sm text-muted">{scene.partial}</span>
                </li>
              ) : null}
              {entries.length === 0 && !scene.partial ? (
                <li className="py-1.5 text-sm text-tertiary">What you say, and what it says back, shows here.</li>
              ) : null}
            </ol>
          </div>
        </div>

        <aside className="vy-panel flex w-[44%] max-w-[560px] shrink-0 flex-col" aria-label="Its task">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <StatusGlyph state={work ? GLYPH[work.state] : 'queued'} size={13} />
            <span className={cn('text-sm', work ? 'text-fg-strong' : 'text-muted')}>{workTitle(work)}</span>
            {work ? <span className="ml-auto text-caption text-tertiary">{work.steps.length} steps</span> : null}
          </div>
          <WorkPane scene={scene} />
        </aside>
      </div>

      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border px-4" data-vv-dock>
        <div className="min-w-0 flex-1">
          {scene.problem ? <Problem scene={scene} /> : <span className="text-caption text-tertiary">M mutes · Esc twice ends</span>}
        </div>
        <Controls scene={scene} />
      </div>
    </section>
  )
}
