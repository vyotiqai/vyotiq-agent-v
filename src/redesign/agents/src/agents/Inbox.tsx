import { useCallback, useRef, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, StatusGlyph, cn, pushToast } from '@renderer/lib/ui'
import { MENU_LABEL } from '@renderer/lib/ui/menuStyles'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { diffsOf } from './runtime'
import { useDismiss } from './parts'
import { useActions, useAgents, type State } from './store'

/*
  The Inbox: what changed while you were away. Asks first, answered in place;
  then finished work; then everything else. As in the list, a group says its
  state once on its heading; only Earlier, where kinds mix, marks each row,
  in the same right-hand column. Never a second copy of a control the row
  already has — Allow here is the same Allow as in the list and the record.
*/

export function inboxCount(s: State): number {
  return s.tasks.filter((t) => !t.archived && ((t.state === 'needs' && !s.allowed[t.id]) || (t.state === 'review' && t.unread))).length
}

export function Inbox({ anchor }: { anchor: 'list' | 'compact' }) {
  const { s, d } = useAgents()
  const act = useActions()
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => d({ type: 'inbox', open: false }), [d])
  useDismiss(ref, true, close)

  const asks = s.tasks.filter((t) => !t.archived && t.state === 'needs' && !s.allowed[t.id])
  const ready = s.tasks.filter((t) => !t.archived && t.state === 'review')
  const failed = s.tasks.filter((t) => !t.archived && t.state === 'failed')

  const open = (id: string): void => {
    d({ type: 'open', agent: id })
    close()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Inbox"
      className={cn('vy-menu absolute z-dropdown flex max-h-[560px] w-[380px] animate-menu-in flex-col', anchor === 'list' ? 'bottom-11 left-2' : 'bottom-0 left-[60px]')}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="flex-1 text-sm font-medium text-fg-strong">Inbox</span>
        <Button size="xs" variant="ghost" onClick={() => d({ type: 'readAll' })}>
          Mark all read
        </Button>
        <IconButton icon="close" label="Close" size="sm" tone="muted" onClick={close} />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {asks.length ? <Heading label="Needs you" glyph={<StatusGlyph state="needs" size={14} />} /> : null}
        {asks.map((t) => (
          <Event key={t.id} title={t.title} onOpen={() => open(t.id)} unread>
            {t.ask?.kind === 'command' ? (
              <>
                <div className="mt-0.5 truncate font-mono text-caption text-fg">
                  <span className="text-tertiary">$ </span>
                  {t.ask.text}
                </div>
                <div className="mt-1.5 flex gap-1">
                  <Button size="xs" variant="primary" onClick={() => act.decide(t.id, 'allowed')}>
                    Allow
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => act.decide(t.id, 'denied')}>
                    Deny
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="mt-0.5 truncate text-xs text-accent">{t.line}</div>
                <div className="mt-1.5">
                  <Button size="xs" variant="primary" onClick={() => open(t.id)}>
                    Answer
                  </Button>
                </div>
              </>
            )}
          </Event>
        ))}

        {ready.length ? <Heading label="Ready for review" glyph={<StatusGlyph state="review" size={14} />} /> : null}
        {ready.map((t) => (
          <Event key={t.id} title={t.title} onOpen={() => open(t.id)} unread={t.unread} meta={t.age}>
            <div className="mt-0.5 truncate text-xs text-muted">
              {diffsOf(s, t.id).length} files · {t.checks ? `${t.checks[0]}/${t.checks[1]} checks met` : 'no checks'}
            </div>
          </Event>
        ))}

        <Heading label="Earlier" />
        {failed.map((t) => (
          <Event key={t.id} glyph={<StatusGlyph state="failed" size={14} />} title={t.title} onOpen={() => open(t.id)} meta={t.age}>
            <div className="mt-0.5 truncate text-xs text-muted">{t.line}</div>
            <div className="mt-1.5">
              <Button size="xs" variant="secondary" icon="retry" onClick={() => d({ type: 'resume', agent: t.id })}>
                Retry
              </Button>
            </div>
          </Event>
        ))}
        <Event glyph={<Icon name="download" size={14} className="text-tertiary" />} title="Agent V 1.0.1 is ready" meta="2h">
          <div className="mt-0.5 text-xs text-muted">Installs when you restart. Running tasks wait for it.</div>
          <div className="mt-1.5">
            <Button size="xs" variant="secondary" onClick={() => pushToast('Restarts when the 3 running tasks finish', { icon: 'refresh' })}>
              Restart to update
            </Button>
          </div>
        </Event>
      </div>
    </div>
  )
}

/** A group heading: the label on the text edge, the group's glyph in the rows' glyph column. */
function Heading({ label, glyph }: { label: string; glyph?: ReactNode }) {
  return (
    <div className={MENU_LABEL}>
      <span>{label}</span>
      {glyph ? (
        <span className="flex items-center gap-2">
          <span className="inline-grid size-4 place-items-center">{glyph}</span>
          <span className="min-w-[3ch] font-mono" />
        </span>
      ) : null}
    </div>
  )
}

function Event({ glyph, title, meta, unread = false, onOpen, children }: { glyph?: ReactNode; title: string; meta?: string; unread?: boolean; onOpen?: () => void; children?: ReactNode }) {
  return (
    <div className={cn('group relative flex rounded-md px-2 py-2', ROW_HOVER)}>
      {onOpen ? <button type="button" aria-label={`Open ${title}`} onClick={onOpen} className="absolute inset-0 rounded-md focus-visible:vy-focus-ring" /> : null}
      <div className="relative min-w-0 flex-1 [&>*]:pointer-events-none [&_button]:pointer-events-auto">
        <div className="flex items-center gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'text-fg-strong' : 'text-fg')}>{title}</span>
          {unread ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
          {glyph ? <span className="inline-grid size-4 shrink-0 place-items-center">{glyph}</span> : null}
          <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption tnum text-tertiary">{meta}</span>
        </div>
        {children}
      </div>
    </div>
  )
}
