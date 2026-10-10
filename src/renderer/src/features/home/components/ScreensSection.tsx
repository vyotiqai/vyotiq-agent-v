import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, IconButton, Input, cn } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { parseViewSpec, type ViewBlock, type ViewBlockOf } from '@shared/viewSpec'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { moveScreen, renameScreen, unpinScreen, usePinnedScreens, type PinnedScreen } from '@renderer/features/screens/screensStore'
import { useLiveSource } from '@renderer/features/task/record/reply/view/live'
import { HomeRow, HomeSection } from './HomeBlocks'

/**
 * Views pinned from a task's answer. Each opens on its saved layout and reads
 * its figures fresh, with no model call; its row says the one thing it shows
 * first ("3 uncommitted", "2 failing"), read live. Nothing shows until one is
 * pinned: questions go to the composer, never a second field here. A pin from
 * a workspace that is closed is not listed, but still takes one of Home's
 * places, so a line says how many wait and can show them to unpin.
 */
export function ScreensSection({
  openWorkspaces,
  onOpenScreen
}: {
  openWorkspaces: readonly string[]
  onOpenScreen: (pinned: PinnedScreen) => void
}) {
  const all = usePinnedScreens()
  const isOpen = (p: PinnedScreen): boolean => openWorkspaces.some((path) => workspacePathsEqual(path, p.workspacePath))
  const pinned = all.filter(isOpen)
  const waiting = all.filter((p) => !isOpen(p))
  const [showWaiting, setShowWaiting] = useState(false)
  if (all.length === 0) return null
  const many = new Set(pinned.map((p) => p.workspacePath)).size > 1
  const ids = pinned.map((p) => p.id)
  return (
    <HomeSection id="home-screens" label="Screens" className="mt-10">
      {pinned.map((p, i) => (
        <PinRow key={p.id} pin={p} showWorkspace={many} first={i === 0} last={i === pinned.length - 1} order={ids} onOpen={() => onOpenScreen(p)} />
      ))}
      {waiting.length > 0 ? (
        <HomeRow className="min-h-9 py-1">
          <button
            type="button"
            onClick={() => setShowWaiting(!showWaiting)}
            aria-expanded={showWaiting}
            className="-ml-2 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
          >
            <Icon name={showWaiting ? 'chevronUp' : 'chevron'} size={11} />
            {waiting.length} pinned from {waiting.length === 1 ? 'a workspace' : 'workspaces'} not open
          </button>
        </HomeRow>
      ) : null}
      {showWaiting
        ? waiting.map((p) => (
            <HomeRow key={p.id} className="group/screen gap-1 py-0">
              <span className="flex min-h-12 min-w-0 flex-1 items-center gap-3 py-2">
                <Icon name="grid" size={14} className="shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-muted">{p.title}</span>
                  <span className="block truncate text-caption text-tertiary">{formatWorkspaceName(p.workspacePath)} · open it to see this</span>
                </span>
              </span>
              <IconButton size="xs" icon="close" label={`Unpin ${p.title}`} onClick={() => unpinScreen(p.id)} />
            </HomeRow>
          ))
        : null}
    </HomeSection>
  )
}

function PinRow({
  pin,
  showWorkspace,
  first,
  last,
  order,
  onOpen
}: {
  pin: PinnedScreen
  showWorkspace: boolean
  first: boolean
  last: boolean
  /** The ids Home lists, in order: what Move up and Move down step through. */
  order: readonly string[]
  onOpen: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [naming, setNaming] = useState(false)
  const spec = useMemo(() => parseViewSpec(pin.spec), [pin.spec])
  const lead = spec?.blocks.find((b): b is ViewBlockOf<'live'> => b.type === 'live') ?? null
  // Enter or Escape ends the edit; the blur that follows must not save it again (or undo the cancel).
  const ended = useRef(false)
  const field = useRef<HTMLInputElement>(null)
  // The field you asked for takes the keyboard, its name selected to type over.
  useEffect(() => {
    if (!naming) return
    field.current?.focus()
    field.current?.select()
  }, [naming])
  const startNaming = (): void => {
    ended.current = false
    // After the menu closes and hands focus back to its trigger; a field shown
    // before that would lose focus at once, and its blur would end the edit.
    window.setTimeout(() => setNaming(true), 0)
  }
  const end = (value: string | null): void => {
    if (ended.current) return
    ended.current = true
    if (value != null) renameScreen(pin.id, value, spec?.title)
    setNaming(false)
  }
  return (
    <HomeRow className="group/screen gap-1 py-0">
      {naming ? (
        <span className="flex min-h-12 min-w-0 flex-1 items-center gap-3 py-2">
          <Icon name="grid" size={14} className="shrink-0 text-tertiary" />
          <Input
            ref={field}
            aria-label="Name"
            defaultValue={pin.title}
            maxLength={80}
            className="min-w-0 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') end(e.currentTarget.value)
              if (e.key === 'Escape') end(null)
            }}
            onBlur={(e) => end(e.currentTarget.value)}
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={cn('-ml-2 flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
        >
          <Icon name="grid" size={14} className="shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg">{pin.title}</span>
            <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-tertiary">
              {lead ? <Glance live={lead} workspacePath={pin.workspacePath} /> : null}
              {showWorkspace ? <span className="shrink-0 truncate">{lead ? '· ' : ''}{formatWorkspaceName(pin.workspacePath)}</span> : null}
            </span>
          </span>
        </button>
      )}
      <ActionMenu
        open={menu}
        onOpenChange={setMenu}
        placement="down"
        align="end"
        aria-label={`${pin.title}: rename, move, unpin`}
        items={[
          { id: 'rename', icon: 'edit', label: 'Rename', onSelect: startNaming },
          { id: 'up', icon: 'arrowUp', label: 'Move up', disabled: first, onSelect: () => moveScreen(pin.id, -1, order) },
          { id: 'down', icon: 'arrowDown', label: 'Move down', disabled: last, onSelect: () => moveScreen(pin.id, 1, order) },
          { id: 'unpin', icon: 'pin', label: 'Unpin', separatorBefore: true, onSelect: () => unpinScreen(pin.id) }
        ]}
        trigger={(t) => (
          <IconButton
            ref={t.ref}
            size="xs"
            icon="more"
            tone="muted"
            label={`${pin.title}: rename, move, unpin`}
            aria-expanded={t['aria-expanded']}
            aria-controls={t['aria-controls']}
            aria-haspopup={t['aria-haspopup']}
            onClick={t.onClick}
            className={menu ? undefined : 'opacity-0 group-hover/screen:opacity-100 focus-visible:opacity-100'}
          />
        )}
      />
    </HomeRow>
  )
}

/** The pin's first live block, read now and said in a few words. */
function Glance({ live, workspacePath }: { live: ViewBlockOf<'live'>; workspacePath: string }) {
  const { state } = useLiveSource(live, workspacePath, null)
  if (state.status !== 'ready') return null
  const words = glanceOf(state.block)
  if (!words) return null
  return <span className={cn('min-w-0 truncate', words.alarm ? 'text-danger' : undefined)}>{words.text}</span>
}

/** What a live read shows first, in a few words; `alarm` when it is something to act on. */
export function glanceOf(block: ViewBlock): { text: string; alarm?: boolean } | null {
  switch (block.type) {
    case 'rows': {
      const n = Math.max(block.total ?? 0, block.items.length)
      return { text: block.title ? `${n} ${block.title.toLowerCase()}` : String(n) }
    }
    case 'table':
      return block.rows[0] ? { text: Object.values(block.rows[0].cells).slice(0, 2).join(' · ') } : null
    case 'checks': {
      const failing = block.items.filter((c) => c.state === 'fail').length
      const running = block.items.filter((c) => c.state === 'running' || c.state === 'pending').length
      const total = Math.max(block.total ?? 0, block.items.length)
      if (failing > 0) return { text: `${failing} failing`, alarm: true }
      if (running > 0) return { text: `${running} running` }
      return { text: `All ${total} passed` }
    }
    case 'stats':
      return { text: block.items.slice(0, 2).map((s) => `${s.label} ${s.value}`).join(' · ') }
    case 'note':
      return { text: block.text }
    case 'chart':
      return block.spec.title ? { text: block.spec.title } : null
    default:
      return null
  }
}
