import { useMemo, useState } from 'react'
import { Button, cn } from '@renderer/lib/ui'
import { currentWork, mergeTurns, type Scene } from './data'
import { fakeLevel } from './Orb'
import { LiveOrb } from './LiveOrb'
import { Ask, Controls, HEADLINE, HandOff, Header, Line, Problem, Result, Steps, subline } from './parts'

/*
  B · Orb. Talking is the point, so the orb and what's happening now fill
  the pane: your words while you speak, its words while it speaks, the task's
  live steps while it works, the result when it's done. The whole
  conversation is one click away, beside it, never under it.
*/

/** The one thing worth reading now, under the orb. */
function Now({ scene }: { scene: Scene }) {
  const work = currentWork(scene)
  if (scene.state === 'hearing' && scene.partial) {
    return <p className="m-0 text-center text-md leading-relaxed text-fg-strong">{scene.partial}</p>
  }
  if (scene.state === 'speaking' && scene.saying) {
    return <p className="m-0 text-center text-md leading-relaxed text-fg">{scene.saying}</p>
  }
  if (scene.state === 'thinking') {
    const said = mergeTurns(scene.entries).findLast((e) => e.who === 'you')
    return said && said.who === 'you' ? <p className="m-0 text-center text-md leading-relaxed text-muted">“{said.text}”</p> : null
  }
  if (work && (scene.state === 'working' || scene.state === 'waiting_on_you' || scene.state === 'paused')) {
    return (
      <div className="w-full">
        <p className="m-0 mb-2 truncate text-sm text-muted">{work.brief}</p>
        <Steps work={work} keep={4} />
        <Ask work={work} />
      </div>
    )
  }
  if (work?.result && scene.state === 'listening') {
    return (
      <div className="w-full">
        <Result work={work} />
      </div>
    )
  }
  return null
}

export function DirectionB({ scene }: { scene: Scene }) {
  const [open, setOpen] = useState(scene.entries.length > 8)
  const entries = useMemo(() => mergeTurns(scene.entries), [scene.entries])
  const level = useMemo(() => fakeLevel(), [])

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-bg" aria-label="Voice mode" data-vv-direction="b">
      <Header scene={scene}>
        <Button size="xs" variant="ghost" icon="chat" aria-pressed={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide conversation' : `Conversation${entries.length ? ` · ${entries.length}` : ''}`}
        </Button>
      </Header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-6 px-8 pb-6">
          <LiveOrb state={scene.state} size={260} level={level} />
          <div className="flex flex-col items-center gap-1">
            <p className="m-0 text-title text-fg-strong">{HEADLINE[scene.state]}</p>
            {scene.problem ? null : <p className="m-0 max-w-[480px] truncate text-sm text-muted">{subline(scene)}</p>}
          </div>
          <div className={cn('flex min-h-[120px] w-full max-w-[520px] flex-col items-center', scene.problem ? 'justify-start' : null)}>
            {scene.problem ? <Problem scene={scene} /> : <Now scene={scene} />}
          </div>
        </div>

        {open ? (
          <aside className="vy-panel flex w-[380px] shrink-0 flex-col" aria-label="Conversation">
            <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2 text-sm text-fg-strong">Conversation</div>
            <ol className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto px-4 py-3">
              {entries.map((e, i) =>
                e.who === 'work' ? (
                  <HandOff key={e.id} work={e.work} steps={2} />
                ) : (
                  <Line key={e.id} who={e.who} label={i === 0 || entries[i - 1]!.who !== e.who}>
                    {e.text}
                  </Line>
                )
              )}
            </ol>
          </aside>
        ) : null}
      </div>

      <div className="flex h-14 shrink-0 items-center justify-center border-t border-border/60 px-4" data-vv-dock>
        <Controls scene={scene} />
      </div>
    </section>
  )
}
