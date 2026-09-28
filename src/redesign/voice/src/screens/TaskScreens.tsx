import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, StepMarker, cn, type TaskState } from '@renderer/lib/ui'
import { RecordBody, RecordRow, TaskHeader } from '@renderer/features/task/record/RecordLayout'
import { Inspector, Navigator, Panel, Window } from '../shell/Window'
import { BlockedPopover, MicTip, SetupPopover } from '../voice/Popovers'
import { InstructionLine, type Draft, type MicState } from '../voice/Surfaces'
import type { Take } from '../voice/Take'

/*
  The task view with the instruction line in each dictation state. The record
  and inspector are context: a running task, step 3 of 5 live.
*/

const STEPS: Array<{ n: number; title: string; state: TaskState; time?: string; summary?: string }> = [
  { n: 1, title: 'Read the upload client and its tests', state: 'done', time: '0:41', summary: '6 files read' },
  { n: 2, title: 'Add exponential backoff with jitter', state: 'done', time: '2:05', summary: '+88 −12' },
  { n: 3, title: 'Cap retries and surface the last error', state: 'running', time: '1:12' },
  { n: 4, title: 'Cover the retry paths in tests', state: 'queued' },
  { n: 5, title: 'Run the suite and typecheck', state: 'queued' }
]

function Record() {
  return (
    <RecordBody>
      <RecordRow className="pt-5">
        <p className="m-0 whitespace-pre-wrap text-md leading-[22px] text-fg-strong">
          Uploads fail on flaky hotel Wi-Fi and the user has to start again. Retry failed chunks with backoff, keep what
          already made it, and tell the user what is happening instead of a spinner that never ends.
        </p>
      </RecordRow>
      <RecordRow>
        <ol className="-mx-2 m-0 list-none p-0" aria-label="Steps">
          {STEPS.map((s) => {
            const live = s.state === 'running'
            return (
              <li key={s.n} className={cn('rounded-lg', live && 'bg-card')}>
                <div className="flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <StepMarker state={s.state} n={s.n} />
                  <span className={cn('min-w-0 flex-1 truncate text-sm', live ? 'font-medium text-fg-strong' : s.state === 'queued' ? 'text-muted' : 'text-secondary')}>
                    {s.title}
                  </span>
                  {s.summary ? <span className="shrink-0 text-xs text-tertiary">{s.summary}</span> : null}
                  <span className="w-14 shrink-0 text-right font-mono text-caption text-tertiary tnum">{s.time ?? ''}</span>
                  <span className="w-3 shrink-0" />
                </div>
                {live ? (
                  <div className="space-y-1.5 pb-3 pl-[36px] pr-2 text-xs">
                    <div className="flex items-center gap-2 text-secondary">
                      <Icon name="edit" size={13} className="text-muted" />
                      <span className="font-mono">src/upload/retry.ts</span>
                      <span className="font-mono text-caption text-success tnum">+31</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted">
                      <span className="size-1.5 animate-live rounded-full bg-accent" aria-hidden="true" />
                      Now: wiring the retry cap into the chunk scheduler
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      </RecordRow>
    </RecordBody>
  )
}

export function TaskFrame({ line }: { line: ReactNode }) {
  return (
    <Window navigator={<Navigator />}>
      <Panel>
        <TaskHeader
          state="running"
          title="Retry uploads on flaky networks"
          facts={[{ text: 'retry-uploads', mono: true }]}
          actions={
            <>
              <IconButton icon="stop" label="Stop run" size="sm" tone="muted" />
              <IconButton icon="more" label="More" size="sm" tone="muted" />
            </>
          }
        />
        <Record />
        {line}
      </Panel>
      <Inspector />
    </Window>
  )
}

const BEFORE = 'Keep the retry cap at five, but '

function lineScreen(
  draft: Draft,
  opts: { take?: Take; mic?: MicState; popover?: ReactNode; popoverAlign?: 'end' | 'center'; sendLabel?: string | null } = {}
) {
  return function Screen() {
    return <TaskFrame line={<InstructionLine draft={draft} {...opts} />} />
  }
}

export const LineIdle = lineScreen({ before: '' }, { popover: <MicTip />, popoverAlign: 'center' })

export const LineListening = lineScreen(
  {
    before: BEFORE,
    live: { mode: 'words', settled: 'make the last error say which chunk failed and how many', partial: 'bytes are left to' }
  },
  { take: { kind: 'listening', engine: 'local', elapsed: '0:14' }, sendLabel: 'Queue' }
)

export const LinePending = lineScreen(
  { before: BEFORE, live: { mode: 'pending' } },
  { take: { kind: 'listening', engine: 'openai', elapsed: '0:14', seed: 11 }, sendLabel: 'Queue' }
)

export const LineHold = lineScreen(
  { before: '', live: { mode: 'words', settled: 'also log the retry count', partial: 'at debug' } },
  { take: { kind: 'hold', engine: 'local', elapsed: '0:03' } }
)

export const LineSilent = lineScreen(
  { before: BEFORE, live: { mode: 'words', settled: '' } },
  { take: { kind: 'silent', engine: 'local', elapsed: '0:06', device: 'Microphone Array (Realtek)' } }
)

export const LineFinishing = lineScreen(
  { before: BEFORE, live: { mode: 'words', settled: 'make the last error say which chunk failed and how many bytes are left to send' } },
  { take: { kind: 'finishing', engine: 'local', audio: '0:19', progress: 0.72 } }
)

export const LineInserted = lineScreen(
  { before: BEFORE, live: { mode: 'inserted', text: 'make the last error say which chunk failed and how many bytes are left to send.' } },
  { take: { kind: 'inserted', words: 17 } }
)

export const LineDiscarded = lineScreen({ before: BEFORE }, { take: { kind: 'discarded', audio: '0:19' } })

export const LineFailed = lineScreen(
  { before: BEFORE, live: { mode: 'pending' } },
  {
    take: {
      kind: 'failed',
      engine: 'openai',
      audio: '1:24',
      reason: 'OpenAI turned the key down (401)',
      fix: { label: 'Providers', icon: 'key' },
      fallback: 'local'
    }
  }
)

export const LineLimit = lineScreen(
  {
    before: '',
    live: {
      mode: 'words',
      settled:
        'Okay so the second thing is the progress copy, it should say how many chunks are done out of the total and the time remaining should only show once we have',
      partial: 'at least three samples'
    }
  },
  { take: { kind: 'listening', engine: 'openai', elapsed: '9:02', left: '0:58', seed: 21 }, sendLabel: 'Queue' }
)

export const LineSetup = lineScreen({ before: 'Also ' }, { mic: 'setup', popover: <SetupPopover /> })

export const LineSetupInstalling = lineScreen(
  { before: 'Also make the retry banner dismissable' },
  { mic: 'setup', popover: <SetupPopover installing={0.62} /> }
)

export const LineBlocked = lineScreen({ before: '' }, { mic: 'blocked', popover: <BlockedPopover /> })
