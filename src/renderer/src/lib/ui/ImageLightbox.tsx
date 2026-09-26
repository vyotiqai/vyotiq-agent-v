import { useRef } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { IconButton } from './IconButton'

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
      <img
        src={url}
        alt={label}
        className="max-h-[min(90vh,900px)] max-w-[min(92vw,1200px)] rounded-md object-contain"
      />
    </Dialog>
  )
}
