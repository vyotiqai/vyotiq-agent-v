import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, Button, IconButton, Pie, Segmented, Tooltip } from '@renderer/lib/ui'
import { EFFORT, MODELS } from '../data'
import type { SendOptions } from '../store'

/*
  The box you type into. One anatomy everywhere: the field, any attached
  files, then one control row — mode, model · effort, context, attach, and
  the labelled action.

  While the thread works, Enter queues (it goes out when the run finishes)
  and Shift Enter sends now, straight into the run. Otherwise Enter sends and
  Shift Enter is a new line. Stop is not here: it sits in the thread header,
  beside what it stops.

  What you type is kept per thread, so switching away and back — or opening
  a new thread — never throws a half-written message away.
*/

type Draft = { text: string; files: string[]; mode: 'agent' | 'ask'; model: string }
const drafts = new Map<string, Draft>()
const EMPTY: Draft = { text: '', files: [], mode: 'agent', model: MODELS[0] }

export function Composer({
  draftKey,
  live,
  placeholder,
  onSend,
  onSteer,
  rows = 1,
  focusOnMount = false
}: {
  /** Whose draft this is: a thread id, or "new". */
  draftKey: string
  live: boolean
  placeholder: string
  onSend: (text: string, mode: 'agent' | 'ask', opts: SendOptions) => void
  /** Present only while the run works: Shift Enter / Send now. */
  onSteer?: (text: string, attachments: string[]) => void
  rows?: number
  focusOnMount?: boolean
}) {
  const [draft, setDraft] = useState<Draft>(() => drafts.get(draftKey) ?? EMPTY)
  const [menu, setMenu] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { text, files, mode, model } = draft
  const update = (patch: Partial<Draft>): void =>
    setDraft((d) => {
      const next = { ...d, ...patch }
      drafts.set(draftKey, next)
      return next
    })

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => {
    if (focusOnMount) field.current?.focus()
  }, [focusOnMount])

  const has = text.trim().length > 0
  const send = (): void => {
    if (!has) return
    onSend(text, mode, { attachments: files, model })
    update({ text: '', files: [] })
  }
  const steer = (): void => {
    if (!has || !onSteer) return
    onSteer(text, files)
    update({ text: '', files: [] })
  }

  return (
    <div className="rounded-xl border border-border bg-bg transition-colors focus-within:border-border-strong" data-composer>
      {files.length ? (
        <ul className="flex flex-wrap gap-1 px-2.5 pt-2.5" aria-label="Attached files">
          {files.map((f) => (
            <li key={f} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface pl-1.5 pr-0.5 text-caption text-fg">
              <Icon name="file" size={12} className="text-tertiary" />
              <span className="max-w-[180px] truncate">{f}</span>
              <IconButton icon="close" label={`Remove ${f}`} size="xs" tone="onSurface" onClick={() => update({ files: files.filter((x) => x !== f) })} />
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={field}
        value={text}
        rows={rows}
        onChange={(e) => update({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            if (e.shiftKey && onSteer) {
              e.preventDefault()
              steer()
            } else if (!e.shiftKey) {
              e.preventDefault()
              send()
            }
          }
          if (e.key === 'Tab' && e.shiftKey && !text) {
            e.preventDefault()
            update({ mode: mode === 'agent' ? 'ask' : 'agent' })
          }
          if (e.key === 'Escape') field.current?.blur()
        }}
        placeholder={placeholder}
        aria-label="Message"
        className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-[22px] text-fg-strong outline-none placeholder:text-tertiary"
      />
      <div className="@container flex items-center gap-1 px-2 pb-2 pt-1">
        <Segmented
          size="xs"
          label="Mode"
          value={mode}
          onChange={(m) => update({ mode: m })}
          items={[
            { id: 'agent', label: 'Agent', title: 'Agent — reads and changes the code (Shift Tab)' },
            { id: 'ask', label: 'Ask', title: 'Ask — reads, changes nothing (Shift Tab)' }
          ]}
        />
        <ActionMenu
          open={menu}
          onOpenChange={setMenu}
          placement="up"
          aria-label="Model"
          items={MODELS.map((m, i) => ({ id: m, label: m, checked: m === model, heading: i === 0 ? 'Model' : undefined, onSelect: () => update({ model: m }) }))}
          trigger={(t) => (
            <button
              {...t}
              type="button"
              className="ml-1 inline-flex h-6 min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-caption text-secondary hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring"
            >
              {model} <span className="text-tertiary">· {EFFORT}</span>
              <Icon name="chevron" size={10} className="text-tertiary" />
            </button>
          )}
        />
        <span className="flex-1" />
        <Tooltip content="18% of the context window used">
          <span className="inline-grid size-6 place-items-center" role="img" aria-label="Context 18% used">
            <Pie value={0.18} size={14} />
          </span>
        </Tooltip>
        <IconButton icon="paperclip" label="Attach files" size="sm" tone="muted" onClick={() => picker.current?.click()} />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const names = [...(e.target.files ?? [])].map((f) => f.name)
            update({ files: [...new Set([...files, ...names])] })
            e.target.value = ''
          }}
        />
        {onSteer && has ? (
          <span className="hidden @[380px]:inline-flex">
            <Button size="xs" variant="ghost" onClick={steer} kbd={['⇧', '↵']}>
              Send now
            </Button>
          </span>
        ) : null}
        <Button size="xs" variant={has ? 'primary' : 'secondary'} disabled={!has} onClick={send} className="ml-1">
          {live ? 'Queue' : 'Send'} <span className="opacity-70">↵</span>
        </Button>
      </div>
    </div>
  )
}
