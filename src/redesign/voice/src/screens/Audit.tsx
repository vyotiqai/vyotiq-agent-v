import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Badge, Button, IconButton, Segmented, cn, selectTriggerClass } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
// The shipped components, imported as they are — the left column is today's UI, not a drawing of it.
import { DictationErrorBanner, DictationSession } from '@renderer/features/chat/components/composer/DictationSessionStrip'
import { speechEnvelope } from '../voice/Meter'
import { OptionsToken } from '../voice/Surfaces'

/*
  The audit, on one page: today's dictation surfaces on the left (the real
  DictationSession and DictationErrorBanner, fed static props), numbered; the
  findings on the right, in the same numbers.
*/

type Finding = { n: number; area: 'Flow' | 'Errors' | 'Settings' | 'Code'; title: string; body: string }

const FINDINGS: Finding[] = [
  { n: 1, area: 'Flow', title: 'The field disappears', body: 'On the instruction line the waveform takes the input’s place, so you dictate into text you cannot see. The brief puts it above; edit-and-rerun, above again. Three surfaces, three layouts.' },
  { n: 2, area: 'Flow', title: 'Blind until the end', body: 'No words appear until you stop. A take may run an hour (MAX_DICTATION_MS), and a misheard word is found only afterwards.' },
  { n: 3, area: 'Flow', title: '■ and × side by side', body: '■ inserts; × throws the take away — no confirm, no undo. Esc, the most habitual key, also discards.' },
  { n: 4, area: 'Flow', title: 'A frozen “Transcribing”', body: 'The timer stops, the bars freeze grey, the mic spins. No progress, even for a long local take that reports it.' },
  { n: 5, area: 'Flow', title: 'Checked after the press', body: 'Each press reads settings and model status over IPC before opening the mic; “Starting…” eats the first words.' },
  { n: 6, area: 'Errors', title: 'Errors are guessed', body: 'The Settings link is picked by regex over the message (/Voice/, /API key/). Raw provider text reaches the user.' },
  { n: 7, area: 'Errors', title: 'A failed take is lost', body: 'The audio is not kept, so a network blip costs the whole dictation. There is no Retry.' },
  { n: 8, area: 'Errors', title: 'Blocked mic, dead end', body: '“Microphone permission denied” — with no route to the Windows switch that caused it.' },
  { n: 9, area: 'Errors', title: 'Silence is recorded', body: 'A muted or wrong device records nothing until you stop, then reports “empty transcript”.' },
  { n: 10, area: 'Flow', title: 'The wrong fact, repeated', body: '“OpenAI ·” rides every take, but where the audio goes — off this machine — is never said at the mic.' },
  { n: 11, area: 'Settings', title: 'Local is disabled, the fix is below', body: 'Local can’t be chosen until a model is installed from rows further down. “In use” shows on a local model while OpenAI is selected.' },
  { n: 12, area: 'Settings', title: 'The default fails', body: 'Engine defaults to OpenAI, so the first press fails for anyone without an OpenAI key.' },
  { n: 13, area: 'Settings', title: 'Missing the basics', body: 'No microphone choice, level test, language or hold-to-talk — but four waveform styles.' },
  { n: 14, area: 'Code', title: 'One control, written three times', body: 'The mic/cancel block is repeated in Composer.tsx for brief, line and edit-and-rerun, and has drifted.' }
]

function Pin({ n }: { n: number }) {
  return (
    <span className="inline-grid size-[18px] shrink-0 place-items-center rounded-full bg-accent font-mono text-2xs font-semibold text-accent-fg tnum" aria-label={`Finding ${n}`}>
      {n}
    </span>
  )
}

function Specimen({ label, pins, children }: { label: string; pins: number[]; children: ReactNode }) {
  return (
    <figure className="m-0">
      <figcaption className={cn('mb-2 flex items-center gap-2', SECTION_LABEL)}>
        {label}
        <span className="flex gap-1 normal-case tracking-normal">
          {pins.map((n) => (
            <Pin key={n} n={n} />
          ))}
        </span>
      </figcaption>
      <div className="overflow-hidden rounded-lg border border-border bg-bg">{children}</div>
    </figure>
  )
}

const wave = speechEnvelope(4, 96)

/** Today's instruction line mid-take: the field is gone, × and ■ side by side. */
function TodayLine({ phase }: { phase: 'recording' | 'transcribing' }) {
  return (
    <div className="flex min-h-11 items-start gap-2.5 px-4 py-2">
      <span aria-hidden="true" className="flex h-7 shrink-0 items-center font-mono text-md font-semibold text-accent">
        ›
      </span>
      <DictationSession phase={phase} elapsedMs={phase === 'recording' ? 14000 : 19000} waveform={wave} style="bars" engineHint="OpenAI" className="min-w-0 flex-1" />
      <IconButton icon="close" label="Cancel dictation" size="md" tone="muted" />
      <IconButton
        icon={phase === 'recording' ? 'stop' : 'loader'}
        label="Stop dictation"
        size="md"
        tone="muted"
        active={phase === 'recording'}
        disabled={phase === 'transcribing'}
        className={phase === 'transcribing' ? '[&_svg]:motion-safe:animate-spin' : undefined}
      />
      <OptionsToken />
    </div>
  )
}

function TodaySettings() {
  return (
    <div className="divide-y divide-border/60 px-4">
      <div className="flex items-start gap-6 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg">Engine</div>
          <div className="mt-0.5 text-xs text-muted">Transcribes with your OpenAI key.</div>
        </div>
        <Segmented
          value="openai"
          label="Dictation engine"
          items={[
            { id: 'openai', label: 'OpenAI' },
            { id: 'openrouter', label: 'OpenRouter' },
            { id: 'local', label: 'Local', disabled: true }
          ]}
        />
      </div>
      {[
        { name: 'Whisper Tiny', hint: '~41 MB download', right: <Button size="sm" variant="secondary">Install</Button> },
        {
          name: 'Whisper Small',
          hint: '249 MB on disk · recommended for this PC',
          right: (
            <span className="flex items-center gap-3">
              <span className="text-caption font-medium text-accent">In use</span>
              <span className="text-xs text-muted">Ready · on disk</span>
              <IconButton icon="more" label="More" size="sm" tone="muted" />
            </span>
          )
        }
      ].map((m) => (
        <div key={m.name} className="flex items-center gap-6 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-fg">{m.name}</div>
            <div className="mt-0.5 text-xs text-muted">{m.hint}</div>
          </div>
          {m.right}
        </div>
      ))}
      <div className="flex items-center gap-6 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg">Waveform</div>
          <div className="mt-0.5 text-xs text-muted">The listening visualiser in the composer.</div>
        </div>
        <span className={cn(selectTriggerClass(), 'w-[140px]')}>
          <span className="flex-1">Bars</span>
          <Icon name="chevron" size={11} className="text-tertiary" />
        </span>
      </div>
    </div>
  )
}

export function AuditScreen() {
  const columns = [['Flow'], ['Errors', 'Settings', 'Code']] as const
  return (
    <div className="flex h-full flex-col bg-bg font-sans text-fg">
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2">
        <h1 className="m-0 text-sm font-semibold text-fg-strong">Dictation today</h1>
        <p className="m-0 min-w-0 truncate text-xs text-tertiary">
          Composer.tsx · useComposerDictation.ts · DictationSessionStrip.tsx · VoiceSection.tsx · main/dictation
        </p>
        <span className="flex-1" />
        <Badge tone="outline">
          <span className="font-mono tnum">{FINDINGS.length}</span> findings
        </Badge>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden">
        <div className="flex min-h-0 flex-col gap-6 overflow-hidden border-r border-border p-6">
          <Specimen label="Instruction line · listening" pins={[1, 3, 10]}>
            <TodayLine phase="recording" />
          </Specimen>
          <Specimen label="Instruction line · transcribing" pins={[2, 4]}>
            <TodayLine phase="transcribing" />
          </Specimen>
          <Specimen label="Error banner" pins={[6, 7]}>
            <div className="px-4">
              <DictationErrorBanner
                message="Dictation failed (401): Incorrect API key provided: sk-proj-****…"
                settingsSection="providers"
                onDismiss={() => undefined}
                onOpenSettings={() => undefined}
              />
            </div>
          </Specimen>
          <Specimen label="Settings → Voice" pins={[11, 12, 13]}>
            <TodaySettings />
          </Specimen>
        </div>
        <div className="grid min-h-0 grid-cols-2 content-start gap-x-6 overflow-hidden p-6">
          {columns.map((col) => (
            <div key={col.join()} className="flex min-w-0 flex-col gap-5">
              {col.map((a) => (
            <section key={a}>
              <h2 className={cn('mb-1', SECTION_LABEL)}>{a}</h2>
              <ol className="m-0 list-none divide-y divide-border/60 border-y border-border p-0">
                {FINDINGS.filter((f) => f.area === a).map((f) => (
                  <li key={f.n} className="flex items-start gap-3 py-2">
                    <Pin n={f.n} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-fg-strong">{f.title}</div>
                      <div className="mt-0.5 text-xs leading-[18px] text-muted">{f.body}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
