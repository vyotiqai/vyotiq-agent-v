import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, Keys, Pie, Segmented, Tooltip, cn, pushToast } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_SELECTED, MENU_ROW_TEXT, MENU_SEPARATOR, MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { EFFORTS, MODELS, REPO_FILES, SLASH, type Effort } from './data'
import { Pill, PopMenu, useDismiss } from './parts'
import { diffsOf, hasPage, taskOf } from './runtime'
import { useAgents } from './store'

/*
  The app's composer anatomy: the field, then one control row — mode and
  model · effort on the left; context, attach, voice and the action on the
  right. The action is a word you can read: Send ↵, or Queue ↵ while the task
  works, with Send now ⇧↵ beside it once there is something to send. Stop is
  in the task header, never here. On New task the action is Start task, with
  how it asks before commands said once beside it. `@` mentions a file, `/`
  runs a skill.
*/

export function Composer({
  kind,
  agent,
  placeholder,
  extra,
  footer,
  onStart
}: {
  kind: 'line' | 'brief'
  agent?: string
  placeholder: string
  /** A row under the field, inside the box (done-when checks on a brief). */
  extra?: ReactNode
  /** Below the box, outside it. */
  footer?: ReactNode
  onStart?: (text: string) => void
}) {
  const { s, d } = useAgents()
  const field = useRef<HTMLTextAreaElement>(null)
  const t = agent ? taskOf(s, agent) : null
  const running = !!t && (t.state === 'running' || t.state === 'needs')
  const hasText = s.draft.trim().length > 0
  const queued = agent ? (s.queued[agent] ?? []) : []

  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, kind === 'brief' ? 280 : 200)}px`
  }, [s.draft, kind])

  // Ctrl+L (in the app) puts the caret here; the mockup focuses on first paint of a new task.
  useEffect(() => {
    if (kind === 'brief') field.current?.focus()
  }, [kind])

  const send = (steer: boolean): void => {
    const text = s.draft.trim()
    if (!text) return
    if (kind === 'brief') return onStart?.(text)
    if (!agent) return
    d({ type: 'send', agent, text, steer })
    if (running && !steer && t?.ask?.kind !== 'question') pushToast('Queued for when this step ends', { icon: 'clock', durationMs: 3000 })
  }

  // `/` at the start, or `@word` at the caret, opens its picker.
  const slash = /^\/\S*$/.test(s.draft) ? s.draft.slice(1).toLowerCase() : null
  const mention = s.draft.match(/(?:^|\s)@([\w./-]*)$/)?.[1] ?? null
  const [dismissed, setDismissed] = useState<string | null>(null)
  const pickerKey = slash != null ? `/${slash}` : mention != null ? `@${mention}` : null
  const picker = pickerKey && pickerKey !== dismissed ? pickerKey : null
  const [at, setAt] = useState(0)
  useEffect(() => setAt(0), [picker])

  const files = useMemo(() => {
    const ws = t?.workspace ?? 'acme'
    const all = Array.from(new Set([...(agent ? diffsOf(s, agent).map((f) => f.path) : []), ...(REPO_FILES[ws] ?? [])]))
    return all.filter((f) => f.toLowerCase().includes((mention ?? '').toLowerCase())).slice(0, 6)
  }, [mention, agent, t?.workspace, s])
  const commands = SLASH.filter((c) => c.cmd.slice(1).startsWith(slash ?? ''))
  const options = picker?.startsWith('/') ? commands.length : picker?.startsWith('@') ? files.length : 0

  const choose = (i: number): void => {
    if (picker?.startsWith('/')) {
      const c = commands[i]
      if (c) d({ type: 'draft', text: `${c.cmd} ` })
    } else if (picker?.startsWith('@')) {
      const f = files[i]
      if (!f) return
      d({ type: 'context', add: { kind: 'file', label: f } })
      d({ type: 'draft', text: s.draft.replace(/@[\w./-]*$/, '') })
    }
    field.current?.focus()
  }

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (picker && options) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setAt((x) => (x + 1) % options))
      if (e.key === 'ArrowUp') return (e.preventDefault(), setAt((x) => (x - 1 + options) % options))
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), choose(at))
      if (e.key === 'Escape') return (e.preventDefault(), setDismissed(picker))
    }
    if (e.key === 'Tab' && e.shiftKey) return (e.preventDefault(), d({ type: 'mode', mode: s.mode === 'Agent' ? 'Ask' : 'Agent' }))
    if (kind === 'brief') {
      if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), send(false))
      return
    }
    if (e.key === 'Enter' && !e.ctrlKey) {
      if (e.shiftKey && !running) return
      e.preventDefault()
      send(e.shiftKey)
    }
  }

  return (
    <div className="relative">
      {queued.length ? (
        <ul aria-label="Queued" className="mb-1.5 flex flex-col gap-0.5 px-1">
          {queued.map((q) => (
            <li key={q} className="group flex h-7 items-center gap-2 rounded-md px-2 text-xs vy-transition hover:bg-surface">
              <Icon name="clock" size={13} className="text-tertiary" />
              <span className="shrink-0 text-tertiary">Queued</span>
              <span className="min-w-0 flex-1 truncate text-fg">{q}</span>
              <span className="flex opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
                <IconButton icon="arrowUp" label="Steer now instead" size="xs" tone="muted" onClick={() => agent && d({ type: 'unqueue', agent, text: q, steer: true })} />
                <IconButton icon="close" label="Take it out of the queue" size="xs" tone="muted" onClick={() => agent && d({ type: 'unqueue', agent, text: q, steer: false })} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <div data-composer-shell className="rounded-[var(--vy-radius-xl)] border border-border bg-card vy-transition focus-within:border-border-strong">
          {s.context.length ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {s.context.map((c) => (
                <span key={c.label} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border bg-bg pl-1.5 pr-0.5 font-mono text-caption text-fg">
                  <Icon name={c.kind === 'element' ? 'target' : 'file'} size={12} className={c.kind === 'element' ? 'text-accent' : 'text-tertiary'} />
                  <span className="truncate">{c.kind === 'element' ? `<${c.label}>` : c.label.split('/').pop()}</span>
                  <IconButton icon="close" label={`Remove ${c.label}`} size="xs" tone="muted" onClick={() => d({ type: 'context', remove: c.label })} />
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={field}
            aria-label={kind === 'brief' ? 'Brief' : 'Instruction'}
            data-composer-input
            value={s.draft}
            rows={1}
            placeholder={s.mode === 'Ask' ? 'Ask about the code — it reads, and changes nothing' : placeholder}
            onChange={(e) => d({ type: 'draft', text: e.target.value })}
            onKeyDown={onKey}
            className={cn(
              'scroll-thin block w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-[22px] text-fg-strong outline-none placeholder:text-tertiary',
              kind === 'brief' ? 'min-h-[88px]' : 'min-h-[44px]'
            )}
          />
          {extra}
          {s.listening ? (
            <Listening onDone={(text) => d({ type: 'draft', text: (s.draft ? `${s.draft} ` : '') + text })} />
          ) : (
            <div className="@container flex h-10 items-center gap-0.5 px-1.5">
              <ModeMenu />
              <ModelButton />
              <span className="flex-1" />
              {kind === 'line' ? (
                <Tooltip content="34% of the context window used">
                  <span className="mr-1 inline-flex items-center gap-1 px-1 font-mono text-caption tnum text-tertiary">
                    <Pie value={0.34} size={14} />
                    34%
                  </span>
                </Tooltip>
              ) : null}
              <AttachMenu hasBrowser={!!agent && hasPage(agent)} />
              <IconButton icon="mic" label="Dictate (Ctrl+Shift+Space)" size="md" tone="muted" onClick={() => d({ type: 'listen', on: true })} />
              {kind === 'brief' ? (
                <>
                  <span className="ml-1 mr-1.5 hidden text-caption text-tertiary @[560px]:inline">Asks before risky commands</span>
                  <Tooltip content="Start task (Ctrl+Enter)">
                    <Button size="sm" variant="primary" disabled={!hasText} onClick={() => send(false)}>
                      Start task
                    </Button>
                  </Tooltip>
                </>
              ) : (
                <>
                  {running && hasText ? (
                    <Button size="sm" variant="ghost" kbd={['⇧', '↵']} className="@max-[480px]:hidden" title="Send it into the live run now, instead of when this step ends" onClick={() => send(true)}>
                      Send now
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    kbd={['↵']}
                    disabled={!hasText}
                    title={running ? 'Queue it — it starts when this step ends' : 'Send'}
                    onClick={() => send(false)}
                  >
                    {running ? 'Queue' : 'Send'}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {picker && options ? (
          <div role="listbox" aria-label={picker.startsWith('/') ? 'Commands' : 'Files'} className={cn(MENU_SURFACE, 'absolute bottom-[calc(100%+6px)] left-0 w-[360px] p-1')}>
            <div className={MENU_LABEL}>{picker.startsWith('/') ? 'Skills' : 'Files'}</div>
            {picker.startsWith('/')
              ? commands.map((c, i) => (
                  <button
                    key={c.cmd}
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    onMouseEnter={() => setAt(i)}
                    onMouseDown={(e) => (e.preventDefault(), choose(i))}
                    className={cn(MENU_ROW, i === at ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                  >
                    <span className="w-24 shrink-0 font-mono text-xs text-accent">{c.cmd}</span>
                    <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{c.what}</span>
                  </button>
                ))
              : files.map((f, i) => (
                  <button
                    key={f}
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    onMouseEnter={() => setAt(i)}
                    onMouseDown={(e) => (e.preventDefault(), choose(i))}
                    className={cn(MENU_ROW, i === at ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                  >
                    <Icon name="file" size={14} className="shrink-0 text-tertiary" />
                    <span className="shrink-0">{f.split('/').pop()}</span>
                    <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{f.split('/').slice(0, -1).join('/')}</span>
                  </button>
                ))}
          </div>
        ) : null}

        {s.models ? <ModelMenu /> : null}
      </div>
      {footer}
    </div>
  )
}

function ModeMenu() {
  const { s, d } = useAgents()
  return (
    <PopMenu
      label="Mode"
      placement="up"
      items={[
        { id: 'agent', label: 'Agent — plans, edits and runs', checked: s.mode === 'Agent', onSelect: () => d({ type: 'mode', mode: 'Agent' }) },
        { id: 'ask', label: 'Ask — reads and answers, changes nothing', checked: s.mode === 'Ask', onSelect: () => d({ type: 'mode', mode: 'Ask' }) }
      ]}
      trigger={(t, open) => (
        <Pill
          ref={t.ref}
          tone={s.mode === 'Ask' ? 'accent' : 'filled'}
          active={open}
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
          label={`Mode: ${s.mode} (Shift+Tab switches)`}
        >
          {s.mode}
        </Pill>
      )}
    />
  )
}

function AttachMenu({ hasBrowser }: { hasBrowser: boolean }) {
  const { d } = useAgents()
  return (
    <PopMenu
      label="Attach"
      placement="up"
      align="end"
      items={[
        { id: 'files', label: 'Files…', icon: 'file', onSelect: () => d({ type: 'context', add: { kind: 'file', label: 'src/server.ts' } }) },
        { id: 'image', label: 'Image…', icon: 'image', onSelect: () => undefined },
        {
          id: 'shot',
          label: 'Screenshot of the Browser tab',
          icon: 'browser',
          disabled: !hasBrowser,
          disabledReason: 'Open the Browser tab first',
          onSelect: () => d({ type: 'context', add: { kind: 'element', label: 'screenshot' } })
        },
        { id: 'mention', label: 'Mention a file  @', icon: 'at', separatorBefore: true, onSelect: () => d({ type: 'draft', text: '@' }) }
      ]}
      trigger={(t, open) => (
        <IconButton
          ref={t.ref}
          icon="paperclip"
          label="Attach"
          size="md"
          tone="muted"
          active={open}
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
        />
      )}
    />
  )
}

/** Dictation: the row becomes the take while it listens; Done drops the words in the field. */
function Listening({ onDone }: { onDone: (text: string) => void }) {
  const { d } = useAgents()
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSecs((x) => x + 1), 1000)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') d({ type: 'listen', on: false })
    }
    window.addEventListener('keydown', onKey)
    return () => (clearInterval(t), window.removeEventListener('keydown', onKey))
  }, [d])
  const finish = (): void => {
    onDone('and check the 429 body says when to retry')
    d({ type: 'listen', on: false })
  }
  return (
    <div className="flex h-10 items-center gap-2.5 px-3" role="status" aria-label="Listening">
      <span className="size-2 animate-live rounded-full bg-danger" />
      <span className="text-xs text-fg">Listening</span>
      <span className="flex h-4 items-center gap-[3px]" aria-hidden>
        {[5, 9, 14, 8, 12, 6, 10, 15, 7, 11, 5, 9].map((h, i) => (
          <span key={i} className="ag-seg-live w-[2px] rounded-full bg-muted" style={{ height: h, animationDelay: `${i * 90}ms` }} />
        ))}
      </span>
      <span className="font-mono text-caption tnum text-tertiary">0:{String(secs).padStart(2, '0')}</span>
      <span className="flex-1" />
      <span className="text-caption text-tertiary">Esc cancels</span>
      <button type="button" onClick={finish} className="inline-flex h-7 items-center rounded-full bg-fg-strong px-3 text-xs font-medium text-bg vy-transition hover:opacity-90 focus-visible:vy-focus-ring">
        Done
      </button>
    </div>
  )
}

function ModelButton() {
  const { s, d } = useAgents()
  return (
    <span data-popover-trigger className="inline-flex min-w-0">
      <Pill label="Model and effort" active={s.models} aria-haspopup="dialog" aria-expanded={s.models} onClick={() => d({ type: 'models', open: !s.models })}>
        {s.model}
        <span className="text-tertiary"> · {s.effort}</span>
      </Pill>
    </span>
  )
}

const EFFORT_NOTE: Record<Effort, string> = {
  Low: 'Answers fast · about ½ of Medium’s tokens',
  Medium: 'The default for most steps',
  High: 'Thinks longer on hard steps · about 2× Medium',
  Max: 'Every step at full depth · about 4× Medium'
}

/** Model and effort in one popover. Effort says what it costs before you pick it. */
function ModelMenu() {
  const { s, d } = useAgents()
  const ref = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  useEffect(() => search.current?.focus(), [])
  const [hover, setHover] = useState<string | null>(null)
  const close = useCallback(() => d({ type: 'models', open: false }), [d])
  useDismiss(ref, true, close)
  const shown = MODELS.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div ref={ref} role="dialog" aria-label="Model and effort" className={cn(MENU_SURFACE, 'absolute bottom-11 left-16 w-[300px]')}>
      <div className="flex h-10 items-center gap-2 border-b border-border pl-3 pr-2">
        <Icon name="search" size={14} className="text-tertiary" />
        <input
          ref={search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg-strong outline-none placeholder:text-tertiary"
        />
        <Keys keys={['Esc']} />
      </div>
      <div className="p-1">
        <div className={MENU_LABEL}>Models</div>
        {shown.map((m, i) => {
          const on = s.model === m.name
          return (
            <div key={m.id}>
              {i === 1 && shown[0].id === 'auto' ? <div className={MENU_SEPARATOR} /> : null}
              <button
                type="button"
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => (d({ type: 'model', model: m.name }), close())}
                className={cn(MENU_ROW, hover === m.id ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, on ? MENU_ROW_SELECTED : MENU_ROW_TEXT)}
              >
                <span className="inline-grid size-4 place-items-center">{on ? <Icon name="check" size={13} /> : null}</span>
                <span className="shrink-0">{m.name}</span>
                <span className="min-w-0 flex-1 truncate text-right text-caption text-tertiary">{m.note}</span>
              </button>
            </div>
          )
        })}
        {!shown.length ? <div className="px-2 py-3 text-caption text-tertiary">No model matches “{q}”</div> : null}
      </div>
      <div className="border-t border-border p-1">
        <div className={MENU_LABEL}>Effort</div>
        <div className="px-2 pb-2">
        <Segmented
          label="Effort"
          value={s.effort}
          onChange={(e) => d({ type: 'effort', effort: e })}
          items={EFFORTS.map((e) => ({ id: e, label: e }))}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
        <p className="mt-2 text-caption text-tertiary">{EFFORT_NOTE[s.effort]}</p>
        </div>
      </div>
    </div>
  )
}
