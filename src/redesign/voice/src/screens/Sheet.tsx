import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Keys, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { MicButton, type MicState } from '../voice/Surfaces'
import { TakeStrip, type Take } from '../voice/Take'

/*
  The parts on one sheet: a take's life as a diagram, every strip state at
  1:1, the mic's four faces, and the keys. What a porter builds from.
*/

const STATES: Array<{ id: string; note: string; take: Take }> = [
  { id: 'starting', note: 'Mic opening. The engine was checked before the press.', take: { kind: 'starting', engine: 'local' } },
  { id: 'listening', note: 'Words land in the field as they settle.', take: { kind: 'listening', engine: 'local', elapsed: '0:14' } },
  { id: 'listening · near the cap', note: 'Time left appears only in the last minute.', take: { kind: 'listening', engine: 'openai', elapsed: '9:02', left: '0:58', seed: 9 } },
  { id: 'hold', note: 'Push-to-talk. Letting go inserts.', take: { kind: 'hold', engine: 'local', elapsed: '0:03' } },
  { id: 'silent', note: 'After 4 s of nothing: name the device, offer another.', take: { kind: 'silent', engine: 'local', elapsed: '0:06', device: 'Microphone Array (Realtek)' } },
  { id: 'finishing', note: 'Settling the last words. Local reports progress.', take: { kind: 'finishing', engine: 'local', audio: '0:19', progress: 0.72 } },
  { id: 'inserted', note: 'Stays 5 s so Undo can be found; the words stay tinted as long.', take: { kind: 'inserted', words: 17 } },
  { id: 'discarded', note: 'Stays 8 s. Restore puts the take back where it was.', take: { kind: 'discarded', audio: '0:19' } },
  {
    id: 'failed',
    note: 'The audio is kept. Retry, or send it to the other engine.',
    take: { kind: 'failed', engine: 'openai', audio: '1:24', reason: 'OpenAI turned the key down (401)', fix: { label: 'Providers', icon: 'key' }, fallback: 'local' }
  }
]

const MICS: Array<{ state: MicState; label: string; note: string }> = [
  { state: 'idle', label: 'Ready', note: 'Tooltip: Dictate · Ctrl M · where audio goes' },
  { state: 'live', label: 'Take open', note: 'Pressed look; pressing inserts' },
  { state: 'setup', label: 'Not set up', note: 'The one accent dot; opens setup' },
  { state: 'blocked', label: 'Blocked', note: 'Windows refused; opens the fix' }
]

function Node({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'live' | 'end' | 'bad' }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs',
        tone === 'live' ? 'border-accent bg-accent-soft text-accent' : tone === 'bad' ? 'border-danger text-danger' : tone === 'end' ? 'border-border bg-surface text-fg' : 'border-border text-secondary'
      )}
    >
      {children}
    </span>
  )
}

function Edge({ label }: { label?: ReactNode }) {
  return (
    <span className="flex shrink-0 flex-col items-center px-1 text-caption text-tertiary">
      <span className="h-4 leading-4">{label}</span>
      <Icon name="arrowRight" size={14} />
    </span>
  )
}

/** A take's life. Every exit is either Insert or a way back to the words. */
function Flow() {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg p-4">
      <div className="flex flex-wrap items-end gap-y-3">
        <Node>
          <Icon name="mic" size={13} />
          Idle
        </Node>
        <Edge label={<Keys keys={['Ctrl', 'M']} />} />
        <Node>Opening</Node>
        <Edge />
        <Node tone="live">
          <span className="size-1.5 animate-live rounded-full bg-accent" />
          Listening
        </Node>
        <Edge label={<Keys keys={['↵']} />} />
        <Node>Finishing</Node>
        <Edge />
        <Node tone="end">
          <Icon name="check" size={13} className="text-success" />
          Inserted
        </Node>
      </div>
      <div className="flex flex-wrap items-end gap-y-3 pl-[152px]">
        <span className="text-caption text-tertiary">from Listening</span>
        <Edge label={<Keys keys={['Esc']} />} />
        <Node tone="end">
          <Icon name="trash" size={13} className="text-muted" />
          Discarded
        </Node>
        <Edge label="Restore" />
        <Node tone="live">Listening</Node>
      </div>
      <div className="flex flex-wrap items-end gap-y-3 pl-[152px]">
        <span className="text-caption text-tertiary">from Finishing</span>
        <Edge label="error" />
        <Node tone="bad">
          <Icon name="xCircle" size={13} />
          Failed · audio kept
        </Node>
        <Edge label="Retry" />
        <Node>Finishing</Node>
      </div>
      <div className="flex flex-wrap items-end gap-y-3 pl-[152px]">
        <span className="text-caption text-tertiary">while Listening</span>
        <Edge label="4 s quiet" />
        <Node>
          <Icon name="warningCircle" size={13} className="text-warning" />
          Silent
        </Node>
        <Edge label="sound" />
        <Node tone="live">Listening</Node>
      </div>
    </div>
  )
}

const KEYS: Array<[string[], string]> = [
  [['Ctrl', 'M'], 'Start a take · tap again to insert · hold to talk'],
  [['↵'], 'Insert (setting: or send)'],
  [['Ctrl', '↵'], 'Insert and send — queues while a run is live'],
  [['Esc'], 'Discard — Restore brings it back'],
  [['Ctrl', 'Z'], 'Undo the insert']
]

export function SheetScreen() {
  return (
    <div className="h-full overflow-hidden bg-bg font-sans text-fg">
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2">
        <h1 className="m-0 text-sm font-semibold text-fg-strong">Take · parts sheet</h1>
        <p className="m-0 text-xs text-tertiary">One strip, nine states, one place</p>
      </header>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-8 p-6">
        <div className="min-w-0">
          <h2 className={cn('mb-2', SECTION_LABEL)}>States</h2>
          <ul className="m-0 list-none divide-y divide-border/60 border-y border-border p-0">
            {STATES.map((s) => (
              <li key={s.id} className="py-2">
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span className="font-mono text-caption text-secondary">{s.id}</span>
                  <span className="text-caption text-tertiary">{s.note}</span>
                </div>
                <TakeStrip take={s.take} sendLabel="Send" />
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className={cn('mb-2', SECTION_LABEL)}>A take’s life</h2>
            <Flow />
          </section>
          <section>
            <h2 className={cn('mb-2', SECTION_LABEL)}>The mic</h2>
            <ul className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 p-0">
              {MICS.map((m) => (
                <li key={m.state} className="flex items-center gap-3">
                  <MicButton state={m.state} />
                  <div className="min-w-0">
                    <div className="text-sm text-fg">{m.label}</div>
                    <div className="truncate text-xs text-muted">{m.note}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className={cn('mb-2', SECTION_LABEL)}>Keys</h2>
            <dl className="m-0 grid grid-cols-[96px_1fr] items-center gap-y-2 text-sm">
              {KEYS.map(([k, v]) => (
                <div key={v} className="contents">
                  <dt>
                    <Keys keys={k} />
                  </dt>
                  <dd className="m-0 text-xs text-secondary">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}
