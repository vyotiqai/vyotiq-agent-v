import { useRef } from 'react'
import { Dialog } from '@renderer/lib/a11y'
import { Icon } from '@renderer/lib/icons'

export function ImageLightbox({
  url,
  label,
  onClose
}: {
  url: string
  label: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open
      onClose={onClose}
      title={label}
      useNativeDialog={false}
      overlayClassName="bg-overlay"
      className="flex items-center justify-center"
      initialFocusRef={closeRef}
    >
      <button
        ref={closeRef}
        type="button"
        className="absolute right-4 top-4 inline-grid size-8 place-items-center rounded-full bg-surface/80 text-fg vy-transition hover:bg-surface"
        aria-label="Close image preview"
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
      <img
        src={url}
        alt={label}
        className="max-h-[min(90vh,900px)] max-w-[min(92vw,1200px)] rounded-md object-contain shadow-lg"
      />
    </Dialog>
  )
}
