import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, Segmented, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { Navigator, Panel, Window } from '../shell/Window'
import { BriefBox, type Draft } from '../voice/Surfaces'
import type { Take } from '../voice/Take'

/*
  New task. Dictating a brief is where long takes happen — a minute or two of
  talking a problem through — so this is where live words and a kept take
  matter most.
*/

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className={cn(SECTION_LABEL, 'shrink-0 whitespace-nowrap')}>{label}</h2>
        {hint ? <span className="min-w-0 truncate text-xs text-tertiary">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Sees() {
  const rows: Array<[string, string, string?]> = [
    ['Branch', 'main', 'clean · 2 ahead'],
    ['Rules', 'AGENTS.md', '1.2k tokens'],
    ['Index', 'Ready', '4,812 files'],
    ['Tools', '14 on', '2 ask first']
  ]
  return (
    <aside className="min-w-0 pt-1" aria-label="What the agent will see">
      <h2 className={SECTION_LABEL}>What the agent will see</h2>
      <dl className="m-0 mt-3 space-y-3">
        {rows.map(([k, v, d]) => (
          <div key={k}>
            <dt className="text-caption text-tertiary">{k}</dt>
            <dd className="m-0 flex min-h-5 items-center gap-1.5 text-sm text-fg">{v}</dd>
            {d ? <dd className="m-0 truncate text-xs text-muted">{d}</dd> : null}
          </div>
        ))}
      </dl>
    </aside>
  )
}

function NewTaskFrame({ draft, take, popover }: { draft: Draft; take?: Take; popover?: ReactNode }) {
  return (
    <Window navigator={<Navigator selectNone />}>
      <Panel>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2 text-xs text-muted">
          <h1 className="m-0 mr-2 text-sm font-semibold text-fg-strong">New task</h1>
          <span>in</span>
          <span className="px-1.5 text-xs text-fg">uploader-service</span>
          <span className="flex-1" />
          <IconButton icon="inspector" label="Show inspector" size="sm" tone="muted" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto grid w-full max-w-[1040px] grid-cols-[minmax(0,1fr)_260px] gap-12 px-8 pb-12 pt-6">
            <div className="min-w-0">
              <BriefBox draft={draft} take={take} popover={popover} />
              <Section label="Done when" hint="Checks the run is judged against">
                <ul className="m-0 list-none divide-y divide-border/60 border-y border-border p-0" aria-label="Done when">
                  {['Uploads resume after the network drops', 'The retry banner names the failing chunk'].map((t) => (
                    <li key={t} className="flex h-9 items-center gap-2.5">
                      <Icon name="checklist" size={14} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{t}</span>
                    </li>
                  ))}
                </ul>
              </Section>
              <Section label="How it runs">
                <dl className="m-0 grid grid-cols-[88px_1fr] items-center gap-y-2.5 text-sm">
                  <dt className="text-muted">Mode</dt>
                  <dd className="m-0 flex min-w-0 items-center gap-3">
                    <Segmented value="agent" label="Mode" items={[{ id: 'agent', label: 'Agent' }, { id: 'ask', label: 'Ask' }]} />
                    <span className="min-w-0 truncate text-xs text-tertiary">Plans, edits files and runs commands in the workspace</span>
                  </dd>
                  <dt className="text-muted">Model</dt>
                  <dd className="m-0 text-xs text-secondary">v4.1-flash · High</dd>
                </dl>
              </Section>
              <div className="mt-8 flex items-center gap-2">
                <Button size="sm" variant="primary" disabled={Boolean(take && take.kind !== 'inserted')}>
                  Start task
                </Button>
                <Button size="sm" variant="ghost">
                  Save as draft
                </Button>
              </div>
            </div>
            <Sees />
          </div>
        </div>
      </Panel>
    </Window>
  )
}

const TALKED =
  'So uploads over hotel Wi-Fi keep failing halfway and the whole file starts again. I want failed chunks retried with backoff, whatever already made it kept, and'

export function BriefListening() {
  return (
    <NewTaskFrame
      draft={{ before: '', live: { mode: 'words', settled: TALKED, partial: 'a banner that says which' } }}
      take={{ kind: 'listening', engine: 'local', elapsed: '0:38', seed: 17 }}
    />
  )
}

export function BriefFailed() {
  return (
    <NewTaskFrame
      draft={{ before: '', live: { mode: 'pending' } }}
      take={{ kind: 'failed', engine: 'openai', audio: '2:12', reason: 'No connection — OpenAI could not be reached', fallback: 'local' }}
    />
  )
}
