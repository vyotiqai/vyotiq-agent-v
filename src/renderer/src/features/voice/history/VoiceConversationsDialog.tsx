import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VoiceConversation, VoiceConversationSummary } from '@shared/ipc/schemas/voiceConversations'
import { formatDisplayTime } from '@shared/utils/timeFormat'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { WHO, formatDuration } from '../view/parts'
import { conversationRows, notSentText, type ConversationQuiet, type ConversationRow } from './conversationRows'
import { useVoiceMode } from '../voiceMode'
import { AFTER_HAND_OFF_MS, loadVoiceConversations, reloadVoiceConversations } from './voiceConversationStore'
import { onVoiceConversationsRequest } from './voiceHistoryRequests'

/*
  Kept voice conversations (docs/voice-mode.md §24.8): a workspace's list,
  grouped by day, and one conversation read back — what you said, what the
  voice and the task said aloud, and what became of each hand-off. Opened
  from a brief that was said by voice (straight to its conversation) and from
  the navigator's View menu (the list).
*/

const DAY_MS = 24 * 60 * 60 * 1000

function dayKey(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Undated'
  const key = dayKey(iso)
  if (key === dayKey(new Date(now).toISOString())) return 'Today'
  if (key === dayKey(new Date(now - DAY_MS).toISOString())) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "12 turns · 4 min 10 s · 2 tasks": what a conversation came to. */
function facts(c: VoiceConversationSummary): string {
  const parts = [plural(c.turns, 'turn')]
  const start = Date.parse(c.startedAt)
  const end = c.endedAt ? Date.parse(c.endedAt) : NaN
  if (Number.isFinite(start) && Number.isFinite(end)) parts.push(formatDuration(end - start))
  if (c.runIds.length > 0) parts.push(plural(c.runIds.length, 'task'))
  if (c.notSent > 0) parts.push(`${c.notSent} not sent`)
  return parts.join(' · ')
}

function ConversationList({ list, onOpen }: { list: readonly VoiceConversationSummary[]; onOpen: (id: string) => void }) {
  const groups = useMemo(() => {
    const out: { label: string; items: VoiceConversationSummary[] }[] = []
    for (const c of list) {
      const label = dayLabel(c.startedAt)
      const last = out.at(-1)
      if (last && last.label === label) last.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [list])
  return (
    <div data-voice-history-list>
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label} className="pb-2">
          <h3 className={cn('m-0 flex h-8 items-end px-4 pb-1', SECTION_LABEL)}>{g.label}</h3>
          <ul className="m-0 list-none p-0">
            {g.items.map((c) => (
              <li key={c.id} className={cn('border-b last:border-b-0', BORDER_DIVIDER)}>
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  className={cn('grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-2 text-left focus-visible:vy-focus-ring', ROW_HOVER)}
                  data-voice-history-item={c.id}
                >
                  <span className={cn('truncate text-sm', c.firstWords ? 'text-fg' : 'text-muted')}>
                    {c.firstWords || 'Nothing said'}
                  </span>
                  <span className="font-mono text-caption tnum text-tertiary">{formatDisplayTime(c.startedAt)}</span>
                  <span className="col-span-2 truncate text-caption text-tertiary">{facts(c)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** One line of the exchange, on the live view's two edges: a 72px name column, then the words. */
function Line({ label, children, row }: { label: ReactNode; children: ReactNode; row: ConversationRow['kind'] }) {
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-voice-history-row={row}>
      <span className="pt-px text-caption text-tertiary">{label}</span>
      <div className="min-w-0 text-sm leading-relaxed">{children}</div>
    </li>
  )
}

function HandOffLine({
  row,
  label,
  onOpenTask
}: {
  row: Extract<ConversationRow, { kind: 'hand_off' }>
  label: boolean
  onOpenTask?: (runId: string) => void
}) {
  const { outcome } = row
  const glyph = outcome.kind === 'sent' ? 'done' : outcome.kind === 'not_sent' ? 'failed' : 'stopped'
  return (
    <Line
      row="hand_off"
      // The glyph is the hand-off's outcome, so it stays when the name doesn't.
      label={
        <span className="flex items-center gap-1.5">
          <StatusGlyph state={glyph} size={12} />
          {label ? WHO.work : null}
        </span>
      }
    >
      <p className="m-0 whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
        <span className="text-fg">Asked </span>
        {row.brief}
      </p>
      {outcome.kind === 'sent' ? (
        <div className="mt-1 flex items-center gap-2" data-voice-history-outcome="sent">
          <span className="text-caption text-tertiary">Sent to the task</span>
          {onOpenTask ? (
            <Button size="xs" variant="ghost" icon="arrowRight" onClick={() => onOpenTask(outcome.runId)}>
              Open task
            </Button>
          ) : null}
        </div>
      ) : outcome.kind === 'not_sent' ? (
        <div className="mt-1 flex items-center gap-1.5 text-caption text-danger" data-voice-history-outcome="not_sent">
          <Icon name="warningCircle" size={12} />
          {notSentText(outcome.reason)}
        </div>
      ) : (
        <div className="mt-1 text-caption text-tertiary" data-voice-history-outcome="unknown">
          The session ended before the task took it
        </div>
      )}
    </Line>
  )
}

const DECISION: Readonly<Record<string, string>> = {
  once: 'Allowed once',
  always: 'Always allowed',
  deny: 'Refused',
  'always refused: once only': 'Asked to always allow; only once was possible'
}

/** Whose line it is: a name shows when this changes. */
const SIDE: Readonly<Record<ConversationRow['kind'], string>> = {
  you: 'you',
  answered: 'you',
  voice: 'voice',
  agent: 'work',
  hand_off: 'work',
  followed: 'work',
  stop_agent: 'stop',
  app_action: 'stop',
  gap: 'gap'
}

function Rows({ rows, onOpenTask }: { rows: readonly ConversationRow[]; onOpenTask?: (runId: string) => void }) {
  return (
    <ul className="m-0 list-none px-4 py-2" data-voice-history-rows>
      {rows.map((row, i) => {
        const prev = rows[i - 1]
        // A name once per run of lines from the same side, as in the live view.
        const label = !prev || SIDE[prev.kind] !== SIDE[row.kind]
        switch (row.kind) {
          case 'gap':
            return (
              <li key={row.id} className="flex h-8 items-center gap-3" data-voice-history-row="gap">
                <span className="w-[72px] font-mono text-caption tnum text-tertiary">{formatDisplayTime(row.at)}</span>
                <span aria-hidden="true" className={cn('h-px flex-1 border-t', BORDER_DIVIDER)} />
              </li>
            )
          case 'you':
            return (
              <Line key={row.id} row="you" label={label ? WHO.you : ''}>
                <span className={cn(row.unanswered ? 'text-muted' : 'text-fg-strong', '[overflow-wrap:anywhere]')}>{row.text}</span>
                {row.stop ? <span className="ml-2 text-caption text-tertiary">stopped the work</span> : null}
                {row.unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
              </Line>
            )
          case 'voice':
            return (
              <Line key={row.id} row="voice" label={label ? WHO.voice : ''}>
                <span className="text-fg [overflow-wrap:anywhere]">{row.text}</span>
              </Line>
            )
          case 'agent':
            return (
              <Line key={row.id} row="agent" label={label ? WHO.work : ''}>
                <span className="text-fg [overflow-wrap:anywhere]">{row.text}</span>
              </Line>
            )
          case 'hand_off':
            return <HandOffLine key={row.id} row={row} label={label} onOpenTask={onOpenTask} />
          case 'followed':
            return (
              <Line key={row.id} row="followed" label="">
                <span className="flex items-center gap-2 text-caption text-tertiary">
                  Added to the running task
                  {onOpenTask ? (
                    <Button size="xs" variant="ghost" icon="arrowRight" onClick={() => onOpenTask(row.runId)}>
                      Open task
                    </Button>
                  ) : null}
                </span>
              </Line>
            )
          case 'answered':
            return (
              <Line key={row.id} row="answered" label={label ? WHO.you : ''}>
                <span className="text-fg-strong [overflow-wrap:anywhere]">{row.text}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-caption text-tertiary">
                  <Icon name={row.what === 'approval' ? 'shield' : 'chat'} size={12} />
                  {row.what === 'approval'
                    ? `Answered an approval${row.tool ? ` for ${row.tool}` : ''}${row.decision ? `: ${DECISION[row.decision] ?? row.decision}` : ''}`
                    : `Answered a question${row.decision ? `: ${row.decision}` : ''}`}
                </span>
              </Line>
            )
          case 'stop_agent':
            return (
              <Line key={row.id} row="stop_agent" label="">
                <span className="flex items-center gap-1.5 text-caption text-tertiary">
                  <Icon name="stop" size={12} />
                  {row.by === 'you' ? 'You stopped the work' : `${WHO.voice} stopped the work`}
                </span>
              </Line>
            )
          case 'app_action':
            return (
              <Line key={row.id} row="app_action" label="">
                <span className={cn('flex items-center gap-1.5 text-caption', row.ok ? 'text-tertiary' : 'text-danger')}>
                  <Icon name={row.ok ? 'check' : 'warningCircle'} size={12} />
                  <span className="[overflow-wrap:anywhere]">{row.message}</span>
                </span>
              </Line>
            )
        }
      })}
    </ul>
  )
}

function QuietLine({ quiet, skipped }: { quiet: ConversationQuiet; skipped: number }) {
  const parts: string[] = []
  if (quiet.dropped > 0) parts.push(`${plural(quiet.dropped, 'sound')} not taken as a turn`)
  if (quiet.errors.length > 0) {
    const codes = [...new Set(quiet.errors.map((e) => e.code))].join(', ')
    parts.push(`${plural(quiet.errors.length, 'error')} (${codes})`)
  }
  if (skipped > 0) parts.push(`${plural(skipped, 'line')} unreadable`)
  if (parts.length === 0) return null
  return (
    <p className="m-0 px-4 pb-3 text-caption text-tertiary" data-voice-history-quiet>
      {parts.join(' · ')}
    </p>
  )
}

function ConversationDetail({
  conversation,
  onOpenTask
}: {
  conversation: VoiceConversation
  onOpenTask?: (runId: string) => void
}) {
  const { rows, quiet } = useMemo(() => conversationRows(conversation.entries), [conversation])
  return (
    <div data-voice-history-detail={conversation.summary.id}>
      {rows.length === 0 ? <p className="m-0 px-4 py-4 text-xs text-tertiary">Nothing was said in this session.</p> : <Rows rows={rows} onOpenTask={onOpenTask} />}
      <QuietLine quiet={quiet} skipped={conversation.skipped} />
    </div>
  )
}

/**
 * While voice mode hands work to a run, read the kept lists again once that
 * hand-off is on disk, so the run's brief can say it was said by voice.
 */
function useReloadOnHandOff(): void {
  const runs = Object.keys(useVoiceMode().snapshot.works).sort().join('|')
  useEffect(() => {
    if (!runs) return
    const t = setTimeout(reloadVoiceConversations, AFTER_HAND_OFF_MS)
    return () => clearTimeout(t)
  }, [runs])
}

export function VoiceConversationsDialog({ onOpenTask }: { onOpenTask?: (workspacePath: string, runId: string) => void }) {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [list, setList] = useState<VoiceConversationSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<VoiceConversation | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Opened on one conversation from a brief: no list behind it until asked for. */
  const [fromList, setFromList] = useState(false)
  useReloadOnHandOff()

  const openOne = useCallback(async (path: string, id: string): Promise<void> => {
    setOpenId(id)
    setConversation(null)
    setError(null)
    const res = await window.vyotiq.voiceConversationRead({ workspacePath: path, id })
    if (res.ok) setConversation(res.data)
    else setError(res.error)
  }, [])

  const showList = useCallback(async (path: string): Promise<void> => {
    setOpenId(null)
    setConversation(null)
    setError(null)
    setList(await loadVoiceConversations(path))
  }, [])

  useEffect(
    () =>
      onVoiceConversationsRequest((path, id) => {
        setWorkspacePath(path)
        setList(null)
        setFromList(id == null)
        if (id) void openOne(path, id)
        else void showList(path)
      }),
    [openOne, showList]
  )

  const close = (): void => {
    setWorkspacePath(null)
    setOpenId(null)
    setConversation(null)
  }

  const summary = conversation?.summary
  const title = openId
    ? summary
      ? `Voice · ${dayLabel(summary.startedAt)} ${formatDisplayTime(summary.startedAt)}`
      : 'Voice conversation'
    : 'Voice conversations'

  return (
    <Dialog
      open={workspacePath != null}
      onClose={close}
      title={title}
      icon="mic"
      // The rows draw their own inset, so the facts row's hairline runs edge to edge.
      padded={false}
      className="vy-menu flex w-[min(40rem,calc(100vw_-_2rem))] flex-col"
    >
      {openId ? (
        <div className={cn('flex h-10 shrink-0 items-center gap-2 border-b px-2', BORDER_DIVIDER)}>
          <IconButton
            icon="arrowLeft"
            label={fromList ? 'All voice conversations' : 'All voice conversations in this workspace'}
            size="xs"
            tone="muted"
            onClick={() => {
              setFromList(true)
              if (workspacePath) void showList(workspacePath)
            }}
          />
          <span className="min-w-0 flex-1 truncate text-caption text-tertiary" data-voice-history-facts>
            {summary ? facts(summary) : ''}
          </span>
        </div>
      ) : null}
      <div className="scroll-thin max-h-[65vh] overflow-y-auto" data-voice-history>
        {error ? (
          <p role="alert" className="m-0 px-4 py-3 text-xs text-danger">
            {error}
          </p>
        ) : null}
        {openId ? (
          conversation ? (
            <ConversationDetail
              conversation={conversation}
              onOpenTask={
                onOpenTask && workspacePath
                  ? (runId) => {
                      const path = workspacePath
                      close()
                      onOpenTask(path, runId)
                    }
                  : undefined
              }
            />
          ) : error ? null : (
            <p className="m-0 px-4 py-4 text-xs text-tertiary">Reading…</p>
          )
        ) : list == null ? (
          <p className="m-0 px-4 py-4 text-xs text-tertiary">Reading…</p>
        ) : list.length === 0 ? (
          <p className="m-0 px-4 py-4 text-xs text-tertiary">
            No voice conversations kept in {workspacePath ? formatWorkspaceName(workspacePath) : 'this workspace'} yet.
          </p>
        ) : (
          <ConversationList list={list} onOpen={(id) => workspacePath && void openOne(workspacePath, id)} />
        )}
      </div>
    </Dialog>
  )
}
