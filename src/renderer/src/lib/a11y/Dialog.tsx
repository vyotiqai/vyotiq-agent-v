import { useEffect, useId, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { cn } from '@renderer/lib/ui'
import { useFocusTrap } from './useFocusTrap'

export type DialogSize = 'sm' | 'md' | 'lg'

/**
 * Panel width.
 *
 * Definite rather than shrink-to-fit, so a dialog is the same width whatever
 * is inside it and no call site has to prop one open with `min-w-*` — a
 * minimum width is how a dialog ends up wider than a narrow window, with its
 * buttons off the screen edge. Clamped to the viewport for the same reason.
 *
 * Full literal strings: Tailwind cannot see a width built by interpolation.
 */
const SIZE_WIDTH: Record<DialogSize, string> = {
  sm: 'w-[min(22rem,calc(100vw_-_2rem))]',
  md: 'w-[min(28rem,calc(100vw_-_2rem))]',
  lg: 'w-[min(36rem,calc(100vw_-_2rem))]'
}

/** Inset shared by the header and the body so they line up on both edges. */
const PAD_X = 'px-5'

export function Dialog({
  open,
  onClose,
  title,
  description,
  label,
  labelledBy,
  describedBy,
  children,
  className,
  overlayClassName,
  size = 'md',
  padded = true,
  initialFocusRef,
  returnFocusRef,
  useNativeDialog = true
}: {
  open: boolean
  onClose: () => void
  /** Visible heading, and the accessible name unless `labelledBy` is given. */
  title?: string
  /** Visible sub-heading under {@link title}, and the accessible description. */
  description?: string
  /** Accessible name for a dialog that shows no heading of its own. */
  label?: string
  labelledBy?: string
  describedBy?: string
  children: ReactNode
  className?: string
  overlayClassName?: string
  /** Panel width — see {@link SIZE_WIDTH}. Native dialogs only. */
  size?: DialogSize
  /**
   * Wrap `children` in the standard padded, scrolling body.
   *
   * Pass `false` only when the content owns the whole panel (a lightbox, a
   * form that draws its own header); that content is then responsible for its
   * own padding and for staying scrollable.
   */
  padded?: boolean
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
    ...(!titleId && (label ?? title) ? { 'aria-label': label ?? title } : {})
  }

  // A dialog that names itself draws that name. This used to be `sr-only`,
  // which left every caller a choice between an unlabelled panel and hand
  // rolling a header — so most of them shipped the unlabelled panel.
  const header =
    title || description ? (
      <div className={cn('flex shrink-0 flex-col gap-1', padded && `${PAD_X} pt-5 pb-3`)}>
        {title ? (
          <h2
            id={autoTitleId}
            className="m-0 text-md font-semibold tracking-[var(--vy-tracking)] text-fg-strong"
          >
            {title}
          </h2>
        ) : null}
        {description ? (
          <p id={autoDescId} className="m-0 text-sm leading-snug text-secondary">
            {description}
          </p>
        ) : null}
      </div>
    ) : null

  // The body scrolls, not the panel, so the heading stays put while long
  // content moves under it.
  const body = (
    <>
      {header}
      {padded ? (
        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain',
            header ? `${PAD_X} pb-5` : 'p-5'
          )}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </>
  )

  if (useNativeDialog) {
    return createPortal(
      <dialog
        ref={dialogRef}
        className={cn(
          'fixed inset-0 m-auto max-h-[min(90vh,900px)] rounded-xl border border-border bg-surface p-0 text-fg shadow-menu animate-dialog-in backdrop:bg-overlay',
          SIZE_WIDTH[size],
          padded ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
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
          padded ? 'flex flex-col overflow-hidden' : undefined,
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
