import { useEffect, useState } from 'react'
import type { ToolImageRef } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { ImageLightbox, cn } from '@renderer/lib/ui'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { useRunSession } from '../RunSessionContext'

/** Data URLs already read this session, newest last; screenshots never change. */
const loaded = new Map<string, string>()
const LOADED_MAX = 32

function cacheKey(workspacePath: string, runId: string, artifact: string): string {
  return `${workspacePath}\0${runId}\0${artifact}`
}

function remember(key: string, url: string): void {
  loaded.delete(key)
  loaded.set(key, url)
  while (loaded.size > LOADED_MAX) {
    const oldest = loaded.keys().next().value
    if (oldest === undefined) break
    loaded.delete(oldest)
  }
}

type LoadState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed' }

function useRunImage(artifact: string): LoadState {
  const { workspacePath, runId } = useRunSession()
  const key = workspacePath && runId ? cacheKey(workspacePath, runId, artifact) : ''
  const [state, setState] = useState<LoadState>(() => {
    const hit = key ? loaded.get(key) : undefined
    return hit ? { status: 'ready', url: hit } : { status: 'loading' }
  })

  useEffect(() => {
    if (!workspacePath || !runId) {
      setState({ status: 'failed' })
      return
    }
    const hit = loaded.get(key)
    if (hit) {
      setState({ status: 'ready', url: hit })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    // Exactly this call's file — never the `snapshot.jpg` "latest" alias, which
    // would show a newer page on every older row.
    void window.vyotiq
      .readRunArtifact({ workspacePath, runId, name: artifact })
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.data.exists && res.data.content?.startsWith('data:image/')) {
          remember(key, res.data.content)
          setState({ status: 'ready', url: res.data.content })
        } else {
          setState({ status: 'failed' })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [key, workspacePath, runId, artifact])

  return state
}

function describe(image: ToolImageRef): string {
  const what = image.label || 'screenshot'
  return image.width && image.height ? `${what}, ${image.width}×${image.height}` : what
}

function Thumbnail({ image, onOpen }: { image: ToolImageRef; onOpen: () => void }) {
  const state = useRunImage(image.artifact)
  const text = describe(image)
  const frame = 'h-20 w-32 shrink-0 overflow-hidden rounded-md border border-border bg-sunken'
  if (state.status === 'ready') {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={text}
        aria-label={`Open ${text}`}
        className={cn(frame, 'cursor-zoom-in hover:border-border-strong focus-visible:vy-focus-ring')}
        data-tool-image={image.artifact}
      >
        <img src={state.url} alt="" className="h-full w-full object-contain object-top" draggable={false} />
      </button>
    )
  }
  if (state.status === 'failed') {
    return (
      <span
        className={cn(frame, 'flex items-center justify-center text-tertiary')}
        title={`${text} — no longer on disk`}
        role="img"
        aria-label={`${text} unavailable`}
      >
        <Icon name="image" size={16} />
      </span>
    )
  }
  return <span className={cn(frame, 'animate-pulse')} aria-hidden />
}

/** One image full size, stepping through the strip's sequence (a burst's frames). */
function StripLightbox({
  images,
  index,
  onIndex,
  onClose
}: {
  images: readonly ToolImageRef[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const image = images[index]!
  const state = useRunImage(image.artifact)
  return (
    <ImageLightbox
      url={state.status === 'ready' ? state.url : ''}
      label={describe(image)}
      onClose={onClose}
      position={{ index: index + 1, count: images.length }}
      onPrev={index > 0 ? () => onIndex(index - 1) : undefined}
      onNext={index < images.length - 1 ? () => onIndex(index + 1) : undefined}
    />
  )
}

/**
 * The images a tool returned, as a row of thumbnails that open full size.
 * Shows the newest `max` — a whole burst by default — and the rest sit behind
 * a count that reveals them.
 */
export function ToolImageStrip({
  images,
  max = 6,
  className
}: {
  images: readonly ToolImageRef[]
  max?: number
  className?: string
}) {
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  if (images.length === 0) return null
  const hidden = all ? 0 : Math.max(0, images.length - max)
  const shown = hidden > 0 ? images.slice(-max) : images
  return (
    <div className={cn('flex flex-wrap items-start gap-1.5', className)} data-tool-images="">
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          aria-label={`Show ${hidden} earlier ${hidden === 1 ? 'image' : 'images'}`}
          className={cn(
            'flex h-20 w-10 shrink-0 items-center justify-center rounded-md border border-border font-mono text-caption text-muted tnum focus-visible:vy-focus-ring',
            CONTROL_HOVER
          )}
        >
          +{hidden}
        </button>
      ) : null}
      {shown.map((image, i) => (
        <Thumbnail key={image.artifact} image={image} onOpen={() => setOpen(hidden + i)} />
      ))}
      {open !== null && images[open] ? (
        <StripLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}
