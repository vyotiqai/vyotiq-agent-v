import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn, IconButton, pushToast, Segmented } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import { PINNED_SCREENS_MAX, pinnableView, pinScreen, unpinScreen, usePinnedScreens } from '@renderer/features/screens/screensStore'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { parseViewSpec, parseViewSpecStreaming, type ViewBlock, type ViewSpec } from '@shared/viewSpec'
import { useCopyFeedback } from '@renderer/lib/ui/CodeBlockCopyButton'
import { useViewActions } from './act'
import { Block, BlockKeyContext, LiveReadsContext, type ViewActions } from './blocks'
import { viewData, viewMarkdown } from './copy'
import { keyed, MotionProvider, Presence, usePresence } from './motion'
import { rememberSettled, settledSpec, useLaterCopy, viewScope } from './registry'

/*
  A ```view fence: a screen the agent built for this answer, in the reply
  card family (a 32px head that names it, then the body).

  It is drawn while it streams — the head as soon as the title arrives, then
  each block, and each row inside a block, as it closes. A later reply that
  sends the same id reshapes it: that copy starts from this one, and this one
  folds to its head with "Updated below".
*/

const ACTION = 'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-caption text-tertiary hover:bg-surface hover:text-fg focus-visible:vy-focus-ring'

const HOVER_ONLY = 'opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100'

const blockKey = (b: ViewBlock, i: number): string => b.id ?? `${b.type}${i}`

/** Each block's key as Body draws it, so a live block's reported read is found again. */
const blockKeys = (spec: ViewSpec): string[] => keyed(spec.blocks, blockKey, 'b').map((k) => k.key)

/**
 * A closed fence: the whole spec, or — when the reply stopped mid-view, or the
 * JSON breaks partway — the blocks finished before that (`cut`), rather than
 * a dump of half a JSON.
 */
function readClosed(text: string): { spec: ViewSpec | null; cut: boolean } {
  const whole = parseViewSpec(text)
  if (whole) return { spec: whole, cut: false }
  const part = parseViewSpecStreaming(text)
  return part && part.blocks.length > 0 ? { spec: part, cut: true } : { spec: null, cut: false }
}

/** The spec in a view's text — a fence body or a show_view call's arguments — read as far as it has come. */
export function useViewText(text: string, streaming: boolean): { spec: ViewSpec | null; cut: boolean } {
  // Partial parses are cheap but not free: let typing-speed deltas coalesce.
  // A closed fence reads its final text at once, or it would flash as code for a frame.
  const deferred = useDeferredValue(text)
  const source = streaming ? deferred : text
  return useMemo(() => (streaming ? { spec: parseViewSpecStreaming(source), cut: false } : readClosed(source)), [source, streaming])
}

export const ViewFence = memo(function ViewFence({ text, streaming, onPlain }: { text: string; streaming: boolean; onPlain: () => ReactNode }) {
  const { spec, cut } = useViewText(text, streaming)
  // A closed fence that is not a view is shown as the code it is.
  if (!streaming && !spec) return <>{onPlain()}</>
  return <ViewCard spec={spec} streaming={streaming} cut={cut} />
})

/**
 * A view, drawn: its 32px head and its body. Every place a view appears — a
 * reply's fence, a show_view call in the work, a question, a pinned view — draws
 * it here, so it reads and acts the same in each.
 */
export function ViewCard({
  spec,
  streaming,
  cut = false,
  chrome = true,
  heading = false
}: {
  spec: ViewSpec | null
  streaming: boolean
  cut?: boolean
  /** False: the body alone, flush in its host (a question, a pinned view), which owns the frame. */
  chrome?: boolean
  /** Without chrome, name the view in one quiet line above it. */
  heading?: boolean
}) {
  const [live] = useState(streaming)

  const session = useRunSession()
  const scope = viewScope(session.workspacePath, session.runId)
  // What an earlier copy of this view showed, read once its id is known. A
  // model that writes the title before the id names it by the title first,
  // so a different id later starts over from that id's copy.
  const [baseline, setBaseline] = useState<{ id: string | null; spec: ViewSpec | null }>({ id: null, spec: null })
  if (spec && baseline.id !== spec.id) setBaseline({ id: spec.id, spec: live ? settledSpec(scope, spec.id) : null })

  const ref = useRef<HTMLElement>(null)
  const later = useLaterCopy(spec?.id, ref)
  const [show, setShow] = useState<'view' | 'data'>('view')
  const [unfold, setUnfold] = useState(false)
  // What each live block last read: Data and Copy give values, not a source's name.
  const reads = useRef(new Map<string, ViewBlock>())
  const [readsVersion, setReadsVersion] = useState(0)
  const report = useCallback((key: string, block: ViewBlock): void => {
    reads.current.set(key, block)
    setReadsVersion((n) => n + 1)
  }, [])
  const { copied, copyError, copy } = useCopyFeedback()

  useEffect(() => {
    if (!streaming && spec) rememberSettled(scope, spec)
  }, [streaming, spec, scope])

  const { act, dialog } = useViewActions(session)

  // A view with live parts can be kept on Home and read fresh there. The
  // question that made it was asked in the composer, like any other.
  const pins = usePinnedScreens()
  const keep = useMemo(() => (chrome && !streaming && spec && session.workspacePath ? pinnableView(spec) : null), [chrome, streaming, spec, session.workspacePath])
  // This task's own pin of it: another task's view may share the id.
  const pinned =
    spec && session.workspacePath
      ? (pins.find((p) => p.viewId === spec.id && (p.runId ?? null) === session.runId && workspacePathsEqual(p.workspacePath, session.workspacePath!)) ?? null)
      : null
  const togglePin = (): void => {
    if (pinned) unpinScreen(pinned.id)
    else if (keep && session.workspacePath) {
      const res = pinScreen({ workspacePath: session.workspacePath, ...(session.runId ? { runId: session.runId } : {}), viewId: keep.id, spec: JSON.stringify(keep), title: keep.title })
      if (!res.ok) pushToast(`Home holds ${PINNED_SCREENS_MAX} pinned views. Unpin one there to pin this.`, 'info')
    }
  }

  const folded = later && !unfold
  if (!chrome)
    return (
      <div ref={ref as RefObject<HTMLDivElement>} data-kind="view" data-view-id={spec?.id} aria-busy={streaming || undefined}>
        {dialog}
        {spec && heading ? (
          <p className="m-0 mb-2 flex min-w-0 items-baseline gap-2 text-xs">
            <span className="truncate font-medium text-secondary">{spec.title}</span>
            {spec.subtitle ? <span className="min-w-0 truncate text-tertiary">{spec.subtitle}</span> : null}
          </p>
        ) : null}
        {spec ? (
          <MotionProvider value={{ live, settled: !streaming }}>
            <LiveReadsContext.Provider value={report}>
              <Body key={baseline.id ?? ''} spec={spec} baseline={baseline.spec} streaming={streaming} cut={cut} act={act} flush />
            </LiveReadsContext.Provider>
          </MotionProvider>
        ) : null}
      </div>
    )
  return (
    <figure ref={ref} className="vy-reply-card group/code" data-kind="view" data-view-id={spec?.id} aria-busy={streaming || undefined}>
      {dialog}
      <figcaption className={cn('flex h-8 min-w-0 items-center gap-2 pl-3 pr-1 text-caption', spec && !folded && cn('border-b', BORDER_DIVIDER))}>
        <Icon name="grid" size={12} className="shrink-0 text-tertiary" />
        {spec ? (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-fg">{spec.title}</span>
            {spec.subtitle ? <span className="min-w-0 truncate text-tertiary">{spec.subtitle}</span> : null}
          </span>
        ) : (
          <span className="vy-text-live">Building a view</span>
        )}
        <span className="flex-1" />
        {later ? (
          <button type="button" className={ACTION} onClick={() => setUnfold(!unfold)} aria-expanded={!folded}>
            <Icon name="arrowDown" size={12} />
            {folded ? 'Updated below · show this version' : 'Hide this version'}
          </button>
        ) : spec && !streaming ? (
          <span className="flex shrink-0 items-center gap-1">
            {/* A pinned view says so at rest; an unpinned one offers it on hover, with View/Data. */}
            {keep || pinned ? (
              <IconButton
                size="xs"
                icon="pin"
                tone="muted"
                label={pinned ? 'Unpin from Home' : 'Pin to Home'}
                title={pinned ? 'Unpin from Home' : 'Pin to Home: its live parts, read fresh each time'}
                active={Boolean(pinned)}
                weight={pinned ? 'fill' : undefined}
                onClick={togglePin}
                className={pinned ? undefined : HOVER_ONLY}
              />
            ) : null}
            <IconButton
              size="xs"
              icon={copied ? 'check' : 'copy'}
              tone="muted"
              label={copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy as Markdown'}
              onClick={() => copy(viewMarkdown(spec, reads.current, blockKeys(spec)))}
              className={HOVER_ONLY}
            />
            <span className={HOVER_ONLY}>
              <Segmented
                size="xs"
                label="Show"
                value={show}
                onChange={setShow}
                items={[
                  { id: 'view', label: 'View' },
                  { id: 'data', label: 'Data' }
                ]}
              />
            </span>
          </span>
        ) : null}
      </figcaption>
      {/* Nothing to draw yet: the head's own line says it is coming. */}
      {folded || !spec ? null : show === 'data' && !streaming ? (
        <pre className="m-0 max-h-[min(24rem,50vh)] overflow-auto px-3 py-2 font-mono text-caption leading-relaxed text-secondary scroll-thin">{readsVersion >= 0 ? viewData(spec, reads.current, blockKeys(spec)) : null}</pre>
      ) : (
        <MotionProvider value={{ live, settled: !streaming }}>
          <LiveReadsContext.Provider value={report}>
            <Body key={baseline.id ?? ''} spec={spec} baseline={baseline.spec} streaming={streaming} cut={cut} act={act} />
          </LiveReadsContext.Provider>
        </MotionProvider>
      )}
    </figure>
  )
}

function Body({
  spec,
  baseline,
  streaming,
  cut,
  act,
  flush = false
}: {
  spec: ViewSpec
  baseline: ViewSpec | null
  streaming: boolean
  cut: boolean
  act: ViewActions
  /** On a page of its own (a pinned view), not in a card: no inset, no card fill. */
  flush?: boolean
}) {
  const list = keyed(spec.blocks, blockKey, 'b')
  const before = baseline ? keyed(baseline.blocks, blockKey, 'b') : null
  const blocks = usePresence(list, before)
  const was = new Map((before ?? []).map((b) => [b.key, b.item]))
  return (
    <div className={cn('flex flex-col gap-5', flush ? '' : 'bg-bg px-3 py-3')}>
      {blocks.map((p) => (
        <Presence key={p.key} p={p}>
          <BlockKeyContext.Provider value={p.key}>
            <Block block={p.item} was={was.get(p.key) ?? null} act={act} />
          </BlockKeyContext.Provider>
        </Presence>
      ))}
      {streaming ? (
        <p className="m-0 flex h-6 items-center gap-2 text-caption" role="status">
          <span className="vy-text-live">{blocks.length === 0 ? 'Gathering what to show' : 'Adding more'}</span>
        </p>
      ) : cut ? (
        <p className="m-0 flex h-6 items-center gap-2 text-caption text-tertiary">
          <Icon name="warningCircle" size={12} className="shrink-0" />
          The rest of this view didn’t come through
        </p>
      ) : null}
    </div>
  )
}
