import {
  useEffect,
  useId,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { cn } from '@renderer/lib/ui'
import { useFocusTrap } from './useFocusTrap'

export function Dialog({
  open,
  onClose,
  title,
  description,
  labelledBy,
  describedBy,
  children,
  className,
  overlayClassName,
  initialFocusRef,
  returnFocusRef,
  useNativeDialog = true
}: {
  open: boolean
  onClose: () => void
  /** Visible title — used for aria-labelledby when labelledBy is omitted. */
  title?: string
  description?: string
  labelledBy?: string
  describedBy?: string
  children: ReactNode
  className?: string
  overlayClassName?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Use native `<dialog>` with showModal for top-layer stacking. */
  useNativeDialog?: boolean
}): JSX.Element | null {
  const autoTitleId = useId()
  const autoDescId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = labelledBy ?? (title ? autoTitleId : undefined)
  const descId = describedBy ?? (description ? autoDescId : undefined)

  useEscapeToClose(onClose, open, { capture: true })

  useFocusTrap({
    active: open,
    containerRef: useNativeDialog ? dialogRef : panelRef,
    initialFocusRef,
    returnFocusRef
  })

  useEffect(() => {
    if (!useNativeDialog) return
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open, useNativeDialog])

  if (!open) return null

  const labelledProps = {
    ...(titleId ? { 'aria-labelledby': titleId } : {}),
    ...(descId ? { 'aria-describedby': descId } : {}),
    ...(!titleId && title ? { 'aria-label': title } : {})
  }

  const body = (
    <>
      {title ? (
        <h2 id={autoTitleId} className="sr-only">
          {title}
        </h2>
      ) : null}
      {description ? (
        <p id={autoDescId} className="sr-only">
          {description}
        </p>
      ) : null}
      {children}
    </>
  )

  if (useNativeDialog) {
    return createPortal(
      <dialog
        ref={dialogRef}
        className={cn(
          'fixed inset-0 m-auto max-h-[min(90vh,900px)] max-w-md rounded-xl border border-border bg-surface p-0 text-fg shadow-menu backdrop:bg-overlay',
          className
        )}
        aria-modal="true"
        {...labelledProps}
        onCancel={(e) => {
          e.preventDefault()
          onClose()
        }}
      >
        {body}
      </dialog>,
      document.body
    )
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-drawer flex items-center justify-center p-4 animate-fade-in',
        overlayClassName
      )}
      role="presentation"
    >
      <button
        type="button"
        className="absolute inset-0 bg-overlay"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 max-h-[min(90vh,900px)] max-w-[min(92vw,1200px)] animate-dialog-in',
          className
        )}
        tabIndex={-1}
        {...labelledProps}
      >
        {body}
      </div>
    </div>,
    document.body
  )
}
