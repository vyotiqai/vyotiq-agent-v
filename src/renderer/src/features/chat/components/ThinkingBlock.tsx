import { useEffect, useRef, useState, type UIEvent } from 'react'
import { Icon } from '@renderer/lib/icons'
import { MarkdownContent, cn } from '@renderer/lib/ui'
import { DISCLOSURE_CHEVRON, DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { ExpandPanel } from '../toolUi/ExpandPanel'
import { firstLinePreview } from '../utils/firstLinePreview'
import { TextShimmer } from './TextShimmer'

/**
 * Cap the open thought body so long reasoning cannot dominate the transcript.
 * Scales with the viewport, clamped for short and tall windows. `pr-2.5`
 * reserves the 10px Windows overlay-scrollbar gutter so wrapped text never
 * sits under the thumb (overlay scrollbars float above content here).
 */
const THINKING_BODY_MAX =
  'max-h-[min(12rem,28vh)] sm:max-h-[min(14rem,32vh)] overflow-y-auto overscroll-contain pr-2.5'

/** Dimmer than answer text-fg; same size so expanded thought stays readable. */
const THINKING_INK =
  '!text-sm !leading-relaxed !text-secondary [&_a]:!underline [&_a]:!decoration-secondary'

const THINKING_PREVIEW_MAX = 120

/** Same pin slack as TerminalBody so streaming follow never fights the reader. */
const BODY_PIN_PX = 24

export function ThinkingBlock({
  content,
  streaming,
  expanded,
  onToggle
}: {
  content: string
  streaming?: boolean
  expanded?: boolean
  onToggle?: (next: boolean) => void
}) {
  // Cursor-style: open only while streaming so tools and the answer stay front
  // and center. Finished thought is a quiet one-line disclosure.
  const [override, setOverride] = useState<boolean | null>(null)
  const isExpanded = expanded ?? override ?? streaming === true
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const preview = firstLinePreview(content, THINKING_PREVIEW_MAX)
  const label = streaming ? 'Thinking' : 'Thought'

  useEffect(() => {
    if (streaming) pinnedRef.current = true
  }, [streaming])

  useEffect(() => {
    if (!isExpanded || !streaming) return
    const el = bodyRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [content, isExpanded, streaming])

  const onBodyScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BODY_PIN_PX
  }

  const toggle = (): void => {
    const next = !isExpanded
    setOverride(next)
    onToggle?.(next)
  }

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        className={cn(DISCLOSURE_ROW, 'group w-full text-left text-secondary')}
        aria-expanded={isExpanded}
        aria-label={
          streaming
            ? 'Thinking'
            : preview && !isExpanded
              ? `${label}: ${preview}`
              : label
        }
        title={!streaming && !isExpanded && preview ? preview : undefined}
        onClick={toggle}
      >
        {streaming ? (
          <TextShimmer className="font-medium text-secondary">{label}</TextShimmer>
        ) : (
          <span className="font-medium text-secondary">{label}</span>
        )}
        <Icon
          name="chevronRight"
          size={14}
          className={cn(DISCLOSURE_CHEVRON, 'text-secondary/80', isExpanded && 'rotate-90')}
        />
      </button>
      <ExpandPanel open={isExpanded}>
        <div
          ref={bodyRef}
          className={cn('mt-0.5 border-l border-border pl-3', THINKING_BODY_MAX)}
          data-testid="thinking-body"
          onScroll={onBodyScroll}
        >
          {streaming ? (
            <MarkdownContent content={content} streaming className={THINKING_INK} />
          ) : (
            <MarkdownContent content={content} streaming={false} className={THINKING_INK} />
          )}
        </div>
      </ExpandPanel>
    </div>
  )
}
