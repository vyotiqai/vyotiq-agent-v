import { useEffect, useRef } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { IconButton } from './IconButton'

export function ImageLightbox({
  url,
  label,
  onClose,
  position,
  onPrev,
  onNext
}: {
  url: string
  label: string
  onClose: () => void
  /** 1-based place in a sequence (a burst of frames), shown with the arrows. */
  position?: { index: number; count: number }
  /** Step through the sequence; each is omitted at its end. */
  onPrev?: () => void
  onNext?: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!onPrev && !onNext) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft' && onPrev) {
        event.preventDefault()
        onPrev()
      } else if (event.key === 'ArrowRight' && onNext) {
        event.preventDefault()
        onNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, onNext])

  // Dialog draws the one scrim; the panel is just the image.
  return (
    <Dialog
      open
      onClose={onClose}
      label={label}
      padded={false}
      useNativeDialog={false}
      className="flex items-center justify-center"
      initialFocusRef={closeRef}
    >
      {/* A solid chip under the button so it reads on any image; the button's
          own hover fill sits on top of it. */}
      <span className="absolute right-4 top-4 rounded-md bg-bg">
        <IconButton ref={closeRef} icon="close" label="Close image preview" size="lg" onClick={onClose} />
      </span>
      {url ? (
        <img
          src={url}
          alt={label}
          className="max-h-[min(90vh,900px)] max-w-[min(92vw,1200px)] rounded-md object-contain"
        />
      ) : (
        <span className="h-40 w-64 animate-pulse rounded-md bg-surface" aria-hidden />
      )}
      {position && position.count > 1 ? (
        <span className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md bg-bg p-1">
          <IconButton
            icon="chevronLeft"
            label="Previous frame"
            size="sm"
            onClick={onPrev}
            disabled={!onPrev}
          />
          <span className="px-1 font-mono text-caption tnum text-muted" aria-live="polite">
            {position.index}/{position.count}
          </span>
          <IconButton
            icon="chevronRight"
            label="Next frame"
            size="sm"
            onClick={onNext}
            disabled={!onNext}
          />
        </span>
      ) : null}
    </Dialog>
  )
}
