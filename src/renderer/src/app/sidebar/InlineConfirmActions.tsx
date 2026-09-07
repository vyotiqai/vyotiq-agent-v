import { useEffect, useRef, type Ref } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'

function ConfirmActionButton({
  label,
  icon,
  size,
  className,
  buttonRef,
  onClick
}: {
  label: string
  icon: 'check' | 'close'
  size: 'sm' | 'md'
  className?: string
  buttonRef?: Ref<HTMLButtonElement>
  onClick: () => void
}) {
  return (
    <Tooltip content={label}>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'app-region-no-drag relative inline-grid place-items-center rounded-md text-muted vy-transition hover:bg-surface/60 hover:text-fg',
          size === 'sm' ? 'size-6' : 'size-7',
          className
        )}
        aria-label={label}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
      >
        <Icon name={icon} size={size === 'sm' ? 12 : 14} />
      </button>
    </Tooltip>
  )
}

export function InlineConfirmActions({
  confirmLabel,
  cancelLabel,
  size = 'md',
  onConfirm,
  onCancel
}: {
  confirmLabel: string
  cancelLabel: string
  size?: 'sm' | 'md'
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const settledRef = useRef(false)
  const onConfirmRef = useRef(onConfirm)
  const onCancelRef = useRef(onCancel)
  onConfirmRef.current = onConfirm
  onCancelRef.current = onCancel

  const settle = (action: () => void): void => {
    if (settledRef.current) return
    settledRef.current = true
    action()
  }

  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (settledRef.current) return
      settledRef.current = true
      onCancelRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      role="group"
      data-inline-confirm=""
      className="flex items-center gap-0.5"
      aria-label={`${confirmLabel}; ${cancelLabel}`}
    >
      <ConfirmActionButton
        label={confirmLabel}
        icon="check"
        size={size}
        className="hover:text-danger"
        onClick={() => settle(() => onConfirmRef.current())}
      />
      <ConfirmActionButton
        label={cancelLabel}
        icon="close"
        size={size}
        buttonRef={cancelRef}
        onClick={() => settle(() => onCancelRef.current())}
      />
    </div>
  )
}
