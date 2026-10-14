import { useEffect, useMemo, useRef } from 'react'
import { cn } from '@renderer/lib/ui'
import { mergeTurns, type Scene } from './data'
import { fakeLevel } from './Orb'
import { LiveOrb } from './LiveOrb'
import { Controls, HEADLINE, HandOff, Header, Line, Problem, WHO, subline } from './parts'

/*
  A · Conversation. The conversation is the page; the orb docks in the bar
  under it with what's happening in a word, so nothing scrolls under it. A
  hand-off is one line that owns the task's live steps, and they turn into
  its result where you asked for it. An empty session starts on the big orb.
*/

export function DirectionA({ scene }: { scene: Scene }) {
  const entries = useMemo(() => mergeTurns(scene.entries), [scene.entries])
  const level = useMemo(() => fakeLevel(), [])
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, scene.partial])

  const empty = entries.length === 0 && !scene.partial

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-bg" aria-label="Voice mode" data-vv-direction="a">
      <Header scene={scene} />

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 pb-10">
          <LiveOrb state={scene.state} size={200} level={level} />
          <div className="flex flex-col items-center gap-1">
            <p className="m-0 text-title text-fg-strong">{HEADLINE[scene.state]}</p>
            <p className="m-0 max-w-[420px] text-center text-sm text-muted">{subline(scene)}</p>
          </div>
        </div>
      ) : (
        <div ref={list} className="scroll-thin vv-fade-top min-h-0 flex-1 overflow-y-auto">
          <ol className="m-0 mx-auto flex w-full max-w-[720px] list-none flex-col px-6 pb-4 pt-6" aria-label="Conversation">
            {entries.map((e, i) =>
              e.who === 'work' ? (
                <HandOff key={e.id} work={e.work} />
              ) : (
                <Line key={e.id} who={e.who} label={i === 0 || entries[i - 1]!.who !== e.who}>
                  {e.text}
                </Line>
              )
            )}
            {scene.partial ? (
              <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-vv-line="partial">
                <span className="pt-px text-caption text-tertiary">{entries.at(-1)?.who === 'you' ? '' : WHO.you}</span>
                <span className="text-sm leading-relaxed text-muted">
                  {scene.partial}
                  <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 bg-muted motion-safe:animate-live" />
                </span>
              </li>
            ) : null}
          </ol>
        </div>
      )}

      <div className={cn('flex shrink-0 items-center gap-3 border-t border-border px-4', empty ? 'h-12' : 'h-16')} data-vv-dock>
        {empty ? (
          <span className="min-w-0 flex-1 truncate text-caption text-tertiary">M mutes · Esc twice ends</span>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <LiveOrb state={scene.state} size={48} level={level} />
            {scene.problem ? (
              <Problem scene={scene} />
            ) : (
              <div className="min-w-0">
                <p className="m-0 text-sm font-medium text-fg-strong">{HEADLINE[scene.state]}</p>
                <p className="m-0 truncate text-xs text-muted">{subline(scene)}</p>
              </div>
            )}
          </div>
        )}
        <Controls scene={scene} />
      </div>
    </section>
  )
}
